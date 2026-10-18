// Local MCP server «RC-машинка»: telemetry, firmware settings and an
// oscilloscope for the diagnostics assistant. The device is a mock for now:
// the scope interface (identify/channels/capture) is what a real instrument
// driver (SCPI over USB-TMC or LAN) will implement.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { createMockScope, SCENARIOS } from '../rc-car/scope-mock.mjs';
import { analyzeWaveform, envelope } from '../rc-car/waveform.mjs';
import { errorResult, listenMcp, portFromEnv, textResult } from './listen.mjs';

export const DEFAULT_RC_DATA_DIR = fileURLToPath(
  new URL('../../data/rc-car', import.meta.url),
);
const DEFAULT_WINDOW_MS = 60;
const DEFAULT_POINTS = 40;
const MAX_POINTS = 400;

function checkChannel(channel) {
  if (!Number.isInteger(channel) || channel < 1 || channel > 4) {
    throw new Error('channel: целое от 1 до 4');
  }
  return channel;
}

/** @returns {any} */
export function measureChannel(scope, channel, windowMs, maxPoints) {
  checkChannel(channel);
  const capture = scope.capture(channel, windowMs ?? DEFAULT_WINDOW_MS);
  const info = scope.channels().find((item) => item.id === channel);
  const result = {
    source: 'mock',
    channel,
    label: info.label,
    probe: info.probe,
    trigger: capture.trigger,
    measurement: analyzeWaveform(capture.samples, capture.sampleRateHz),
  };
  if (maxPoints !== undefined) {
    if (!Number.isInteger(maxPoints) || maxPoints < 8 || maxPoints > MAX_POINTS) {
      throw new Error(`maxPoints: целое от 8 до ${MAX_POINTS}`);
    }
    result.points = envelope(capture.samples, capture.sampleRateHz, maxPoints);
    result.pointsNote = 'огибающая min/max по интервалам, tMs от начала окна';
  }
  return result;
}

export function createRcCarMcpHandler({
  scenario = process.env.RC_MOCK_SCENARIO ?? 'low_battery',
  dataDir = DEFAULT_RC_DATA_DIR,
} = {}) {
  if (!SCENARIOS[scenario]) throw new Error(`Неизвестный сценарий: ${scenario}`);
  const scope = createMockScope({ scenario });
  const tool = (mcp, name, description, properties, required, run) =>
    mcp.registerTool(
      name,
      {
        description,
        inputSchema: fromJsonSchema({
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        }),
      },
      async (args) => {
        try {
          return textResult(await run(args ?? {}));
        } catch (error) {
          return errorResult(error, 'Не удалось получить данные машинки');
        }
      },
    );
  const channel = {
    type: 'integer',
    minimum: 1,
    maximum: 4,
    description: 'Канал осциллографа 1..4 (список — scope_list_channels)',
  };
  const windowMs = {
    type: 'integer',
    minimum: 5,
    maximum: 200,
    description: `Длина окна захвата в мс, по умолчанию ${DEFAULT_WINDOW_MS}; захват стартует по запуску моторов`,
  };
  return createMcpHandler(() => {
    const mcp = new McpServer({ name: 'ai-challenge-rc-car', version: '1.0.0' });
    tool(
      mcp,
      'rc_get_telemetry',
      'Последняя телеметрия машинки TLM_<вперёд см>_<назад см>_<L>_<R>: дальность и фактическая скорость бортов. Напряжение питания и ток прошивка не измеряет',
      {},
      [],
      () => scope.telemetry(),
    );
    tool(
      mcp,
      'rc_get_firmware_config',
      'Настройки прошивки: пины, таймеры и частоты ШИМ, MIN_PWM, разгон, failsafe, зоны торможения, что измеряет телеметрия',
      {},
      [],
      async () => JSON.parse(await readFile(join(dataDir, 'firmware-config.json'), 'utf8')),
    );
    tool(
      mcp,
      'scope_list_channels',
      'Каналы осциллографа и что к ним подключено (питание драйвера, выход драйвера, линия 5 В, эхо сонара)',
      {},
      [],
      () => ({ device: scope.identify(), channels: scope.channels() }),
    );
    tool(
      mcp,
      'scope_measure',
      'Измерить сигнал на канале осциллографа: уровни, размах, просадка относительно уровня до старта, частота, скважность. Числа считает код, интерпретируй их',
      { channel, windowMs },
      ['channel'],
      (args) => measureChannel(scope, args.channel, args.windowMs),
    );
    tool(
      mcp,
      'scope_capture',
      'Те же измерения плюс огибающая сигнала (min/max по интервалам) для анализа формы. Запрашивай, когда одних чисел недостаточно: сложные неисправности питания, ШИМ, помехи',
      {
        channel,
        windowMs,
        maxPoints: {
          type: 'integer',
          minimum: 8,
          maximum: MAX_POINTS,
          description: `Сколько точек огибающей вернуть, по умолчанию ${DEFAULT_POINTS}`,
        },
      },
      ['channel'],
      (args) => measureChannel(scope, args.channel, args.windowMs, args.maxPoints ?? DEFAULT_POINTS),
    );
    return mcp;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await listenMcp(createRcCarMcpHandler(), {
    name: 'RC-car',
    port: portFromEnv('MCP_RC_CAR_PORT', 18808),
  });
}
