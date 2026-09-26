import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, test, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { connectAgentMcp } from '@/lib/server/mcp-agent';
import type { McpServerConfig } from '@/lib/server/mcp-config';
import { createWeatherMcpHandler } from '@/scripts/mcp/handler.mjs';
import { createNotesMcpHandler } from '@/scripts/mcp-servers/notes.mjs';
import { createTravelMcpHandler } from '@/scripts/mcp-servers/travel.mjs';
import { createGeocodingStub } from '@/tests/helpers/geocoding';

const DEEPSEEK_URL = 'https://api.deepseek.com/responses';
const ENV_NAMES = [
  'MCP_CAPSULE_URL',
  'MCP_TRAVEL_URL',
  'MCP_NOTES_URL',
  'DEEPSEEK_API_KEY',
] as const;
const savedEnv = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true }));
  return dir;
}

async function serve(handler: ReturnType<typeof createMcpHandler>) {
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    void nodeHandler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

// Three real MCP servers: the capsule, «Поездки» and «Заметки».
async function startServers() {
  const getWeather = vi.fn(async (city: string) => ({
    source: 'Open-Meteo',
    location: { name: city, country: 'Германия', timezone: 'Europe/Berlin' },
    current: {
      time: '2026-09-26T18:00',
      temperature_2m: 12.5,
      precipitation: 0.4,
      rain: 0.4,
      showers: 0,
      weather_code: 61,
    },
    units: { temperature_2m: '°C' },
  }));
  const geocoding = createGeocodingStub();
  const notesDir = await tempDir('orchestration-notes-');
  const capsule = await serve(
    createWeatherMcpHandler({
      dataDir: await tempDir('orchestration-capsule-'),
      getWeather,
    }),
  );
  const travel = await serve(createTravelMcpHandler({ fetchImpl: geocoding }));
  const notes = await serve(createNotesMcpHandler({ notesDir }));
  return { capsule, travel, notes, getWeather, geocoding, notesDir };
}

function config(
  id: string,
  name: string,
  url: string,
  tools: string[],
): McpServerConfig {
  return {
    id,
    name,
    location: 'test',
    hint: '',
    url: () => new URL(url),
    tools,
  };
}

function parseToolOutput(output: string) {
  return JSON.parse(output) as {
    ok: boolean;
    content?: string[];
    error?: string;
  };
}

test('маршрутизатор собирает инструменты серверов и отправляет вызов владельцу', async () => {
  const { capsule, travel, notes, notesDir } = await startServers();
  // A fourth server repeats the name «ping» and exposes a tool nobody allowed.
  const duplicate = await serve(
    createMcpHandler(() => {
      const mcp = new McpServer({ name: 'dup', version: '1.0.0' });
      mcp.registerTool('ping', { description: 'Дубль ping' }, async () => ({
        content: [{ type: 'text', text: 'pong from dup' }],
      }));
      mcp.registerTool(
        'secret_tool',
        { description: 'Не разрешён' },
        async () => ({
          content: [{ type: 'text', text: 'secret' }],
        }),
      );
      return mcp;
    }),
  );
  const signal = new AbortController().signal;
  const connection = await connectAgentMcp(signal, [
    config('ai-vps', 'MCP на капсуле', capsule, [
      'ping',
      'get_weather',
      'find_concert',
    ]),
    config('travel', 'Поездки', travel, ['plan_trip']),
    config('notes', 'Заметки', notes, ['save_note', 'list_notes', 'read_note']),
    config('dup', 'Дубль', duplicate, ['ping']),
    config('down', 'Выключенный', 'http://127.0.0.1:9/mcp', ['anything']),
  ]);
  if (!connection) throw new Error('Нет подключения к MCP');
  cleanups.push(() => connection.close());

  const names = connection.tools.map((tool) => tool.name);
  expect(names.sort()).toEqual(
    [
      'ai-vps__ping',
      'dup__ping',
      'find_concert',
      'get_weather',
      'list_notes',
      'plan_trip',
      'read_note',
      'save_note',
    ].sort(),
  );
  expect(
    connection.tools.find((tool) => tool.name === 'plan_trip')?.description,
  ).toMatch(/^\[Поездки\] /u);

  const saved = parseToolOutput(
    await connection.callTool(
      'save_note',
      { title: 'Маршрутизация', content: 'Вызов ушёл на сервер заметок' },
      signal,
    ),
  );
  expect(saved.ok).toBe(true);
  const { id } = JSON.parse(saved.content![0]) as { id: string };
  expect(await readdir(notesDir)).toEqual([`${id}.md`]);

  expect(
    parseToolOutput(await connection.callTool('dup__ping', {}, signal)),
  ).toMatchObject({ ok: true, content: ['pong from dup'] });
  expect(
    parseToolOutput(await connection.callTool('ai-vps__ping', {}, signal)),
  ).toMatchObject({ ok: true, content: ['pong'] });
  expect(
    parseToolOutput(await connection.callTool('secret_tool', {}, signal)),
  ).toEqual({ ok: false, error: 'Инструмент недоступен' });
  expect(connection.traceName?.('save_note')).toBe('notes__save_note');
  expect(connection.traceName?.('dup__ping')).toBe('dup__ping');
  expect(connection.traceName?.('find_concert')).toBe('ai-vps__find_concert');
});

test('длинный флоу: агент идёт через три сервера в правильном порядке', async () => {
  const { capsule, travel, notes, getWeather, geocoding, notesDir } =
    await startServers();
  process.env.MCP_CAPSULE_URL = capsule;
  process.env.MCP_TRAVEL_URL = travel;
  process.env.MCP_NOTES_URL = notes;
  process.env.DEEPSEEK_API_KEY = 'test-secret';

  const requests: Array<{
    instructions?: string;
    tools?: Array<{ name: string }>;
    input: Array<Record<string, unknown>>;
  }> = [];
  const outputOf = (name: string) => {
    const input = requests.at(-1)?.input ?? [];
    const call = input.find(
      (item) => item.type === 'function_call' && item.name === name,
    );
    const output = input.find(
      (item) =>
        item.type === 'function_call_output' && item.call_id === call?.call_id,
    );
    return JSON.parse(parseToolOutput(String(output?.output)).content![0]);
  };
  const calls = (...items: Array<[string, Record<string, unknown>]>) => ({
    status: 'completed',
    output: items.map(([name, args], index) => ({
      type: 'function_call',
      call_id: `call_${requests.length}_${index}`,
      name,
      arguments: JSON.stringify(args),
    })),
  });
  // A scripted model: every step uses only what the previous tools returned.
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : input.toString();
      if (target !== DEEPSEEK_URL) return nativeFetch(input, init);
      requests.push(JSON.parse(init?.body as string));
      if (requests.length === 1) {
        return Response.json(calls(['find_concert', { performer: 'Нюша' }]));
      }
      if (requests.length === 2) {
        const { concerts } = outputOf('find_concert');
        const [{ city, date }] = concerts as Array<{
          city: string;
          date: string;
        }>;
        return Response.json(
          calls(
            ['get_weather', { city }],
            ['plan_trip', { from: 'Берлин', to: city, date }],
          ),
        );
      }
      if (requests.length === 3) {
        const [{ city, date, venue }] = outputOf('find_concert').concerts;
        const weather = outputOf('get_weather');
        const trip = outputOf('plan_trip');
        return Response.json(
          calls([
            'save_note',
            {
              title: 'Поездка на концерт Нюша',
              content: [
                `Концерт: ${date}, ${city}, ${venue}`,
                `Погода: ${weather.current.temperature_2m} °C`,
                `Дорога: ${trip.distanceKm} км, лучше — ${trip.recommended}, через ${trip.daysUntil} дн.`,
              ].join('\n'),
            },
          ]),
        );
      }
      const saved = outputOf('save_note');
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: `План сохранён в заметку ${saved.id}.`,
              },
            ],
          },
        ],
      });
    },
  );

  const response = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content:
              'Спланируй поездку на концерт Нюши из Берлина и сохрани план в заметки',
          },
        ],
        useMcpTools: true,
      }),
    }),
  );
  const events = await response.text();

  expect(response.status).toBe(200);
  expect(requests).toHaveLength(4);
  expect(requests[0].tools?.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'find_concert',
      'get_weather',
      'plan_trip',
      'save_note',
    ]),
  );
  expect(requests[0].instructions).toContain(
    'Скилл «Поездка на концерт» (find_concert → get_weather → plan_trip → save_note)',
  );
  expect(events).toContain(
    '"mcpTools":["ai-vps__find_concert","ai-vps__get_weather","travel__plan_trip","notes__save_note"]',
  );
  expect(getWeather).toHaveBeenCalledExactlyOnceWith('Потсдам');
  expect(
    geocoding.mock.calls.map(([input]) =>
      new URL(input instanceof Request ? input.url : input).searchParams.get(
        'name',
      ),
    ),
  ).toEqual(['Берлин', 'Потсдам']);

  const [file] = await readdir(notesDir);
  const note = await readFile(join(notesDir, file), 'utf8');
  expect(note).toContain('# Поездка на концерт Нюша');
  expect(note).toContain(
    'Концерт: 2026-10-10, Потсдам, Дворцовый парк, летняя сцена',
  );
  expect(note).toContain('Погода: 12.5 °C');
  expect(note).toMatch(/Дорога: 27 км, лучше — car, через -?\d+ дн\./u);
  expect(events).toContain(
    `План сохранён в заметку ${file.replace(/\.md$/u, '')}.`,
  );
});
