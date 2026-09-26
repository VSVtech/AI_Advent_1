import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { afterEach, expect, test, vi } from 'vitest';

import { POST as chatPOST } from '@/app/api/chat/route';
import { GET, POST } from '@/app/api/weather/route';
import { createWeatherMcpHandler } from '@/scripts/mcp/handler.mjs';
import {
  createWeatherJob,
  readWeatherJob,
  runWeatherJobsTick,
} from '@/scripts/mcp/weather-jobs.mjs';
import { runWeatherTick } from '@/scripts/mcp/weather-tick.mjs';

const DEEPSEEK_URL = 'https://api.deepseek.com/responses';
const saved = {
  capsuleUrl: process.env.MCP_CAPSULE_URL,
  serverUrl: process.env.MCP_SERVER_URL,
  apiKey: process.env.DEEPSEEK_API_KEY,
};
const cleanups: Array<() => Promise<void>> = [];

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restore('MCP_CAPSULE_URL', saved.capsuleUrl);
  restore('MCP_SERVER_URL', saved.serverUrl);
  restore('DEEPSEEK_API_KEY', saved.apiKey);
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function weather(temperatureC: number, code = 3) {
  return {
    source: 'Open-Meteo',
    location: { name: 'Москва', country: 'Россия', timezone: 'Europe/Moscow' },
    units: { temperature_2m: '°C' },
    current: {
      time: '2026-09-26T16:00',
      temperature_2m: temperatureC,
      precipitation: 0,
      rain: 0,
      showers: 0,
      weather_code: code,
    },
  };
}

async function newDataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'weather-mcp-'));
  cleanups.push(() => rm(directory, { recursive: true }));
  return directory;
}

async function startWeatherMcp(dataDir: string) {
  const getWeather = vi.fn(async (_city: string) => weather(12));
  const nodeHandler = toNodeHandler(
    createWeatherMcpHandler({ dataDir, getWeather }),
  );
  const server: Server = createServer((request, response) => {
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
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, getWeather };
}

async function connect(url: string) {
  const client = new Client({ name: 'weather-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanups.push(() => client.close());
  return client;
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('');
  return { isError: result.isError === true, text };
}

// DeepSeek is stubbed; MCP traffic to the local test server stays real.
function stubDeepSeek(answer: (body: Record<string, unknown>) => unknown) {
  const nativeFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== DEEPSEEK_URL) return nativeFetch(input, init);
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      requests.push(body);
      return Response.json(answer(body));
    },
  );
  return requests;
}

function modelText(text: string) {
  return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  };
}

test('MCP-инструменты: задание по расписанию, агрегат и суточная сводка', async () => {
  const dataDir = await newDataDir();
  const { url, getWeather } = await startWeatherMcp(dataDir);
  const client = await connect(url);

  const outOfRange = await callJson(client, 'schedule_weather_collection', {
    intervalMinutes: 1,
    durationMinutes: 240,
  });
  expect(outOfRange.isError).toBe(true);

  const scheduled = await callJson(client, 'schedule_weather_collection', {
    intervalMinutes: 1,
    durationMinutes: 2,
  });
  expect(scheduled.isError).toBe(false);
  const { jobId } = JSON.parse(scheduled.text) as { jobId: string };
  expect(await readWeatherJob(jobId, dataDir)).toMatchObject({
    city: 'Москва',
    status: 'running',
  });
  const duplicate = await callJson(client, 'schedule_weather_collection', {
    city: 'Казань',
    intervalMinutes: 5,
    durationMinutes: 30,
  });
  expect(duplicate).toMatchObject({
    isError: true,
    text: expect.stringContaining('Уже идёт сбор'),
  });

  const running = JSON.parse(
    (await callJson(client, 'get_weather_summary', { jobId })).text,
  );
  expect(running).toMatchObject({
    kind: 'job',
    status: 'running',
    aggregate: { sampleCount: 0, expectedSampleCount: 2 },
  });

  // cron runs the tick; it collects through the same MCP get_weather tool.
  process.env.MCP_SERVER_URL = url;
  const startedAt = Date.parse(running.startedAt);
  for (const seconds of [30, 90, 150]) {
    await runWeatherTick({
      now: new Date(startedAt + seconds * 1_000),
      dataDir,
    });
  }
  expect(getWeather).toHaveBeenCalledWith('Москва');

  const completed = JSON.parse(
    (await callJson(client, 'get_weather_summary', { jobId })).text,
  );
  expect(completed).toMatchObject({
    status: 'completed',
    aggregate: {
      sampleCount: 2,
      expectedSampleCount: 2,
      minTemperatureC: 12,
      maxTemperatureC: 12,
      rainObserved: false,
    },
    failedAttempts: 0,
  });
  expect(completed.readings).toHaveLength(2);

  const daily = JSON.parse(
    (await callJson(client, 'get_weather_summary', {})).text,
  );
  expect(daily).toMatchObject({
    kind: 'daily',
    city: 'Москва',
    reportHour: 16,
    scheduler: { state: 'ok' },
  });
  expect(
    JSON.parse(
      (await callJson(client, 'get_weather_summary', { jobId: 'missing' }))
        .text,
    ),
  ).toEqual({ kind: 'job', jobId: 'missing', status: 'not_found' });
  expect(
    (await callJson(client, 'get_weather_summary', { jobId: '../x' })).isError,
  ).toBe(true);
  expect(
    await callJson(client, 'get_weather_summary', {
      jobId,
      date: '2026-09-26',
    }),
  ).toMatchObject({ isError: true });
});

test('/api/weather: суточная сводка и итог задания приходят через MCP', async () => {
  const dataDir = await newDataDir();
  const { url } = await startWeatherMcp(dataDir);
  process.env.MCP_CAPSULE_URL = url;
  process.env.DEEPSEEK_API_KEY = 'test-secret';
  const requests = stubDeepSeek(() =>
    modelText(
      'Температура держалась на 12 °C, дождя не было, все 2 замера получены.',
    ),
  );

  expect(
    await (await GET(new Request('http://localhost/api/weather'))).json(),
  ).toEqual({ status: 'pending', summary: null, scheduler: null });

  await runWeatherTick({
    now: new Date('2026-09-26T13:00:00.000Z'),
    dataDir,
    fetchWeather: async () => weather(14, 61),
  });
  const daily = await GET(new Request('http://localhost/api/weather'));
  expect(daily.status).toBe(200);
  await expect(daily.json()).resolves.toMatchObject({
    status: 'ready',
    summary: {
      date: '2026-09-26',
      minTemperatureC: 14,
      rainObserved: true,
      sampleCount: 1,
    },
    scheduler: { state: 'ok', lastSampleAt: '2026-09-26T13:00:00.000Z' },
  });

  const startedAt = new Date('2026-09-26T10:00:00.000Z');
  const job = await createWeatherJob(
    { intervalMinutes: 1, durationMinutes: 2 },
    { now: startedAt, dataDir },
  );
  const post = (jobIds: unknown) =>
    POST(
      new Request('http://localhost/api/weather', {
        method: 'POST',
        body: JSON.stringify({ jobIds, model: 'deepseek-v4-flash' }),
      }),
    );
  await expect((await post([job.id, 'missing'])).json()).resolves.toEqual({
    jobs: [
      { id: job.id, status: 'running' },
      {
        id: 'missing',
        status: 'not_found',
        content: expect.stringContaining('не найдено'),
      },
    ],
  });
  expect(requests).toHaveLength(0);

  for (const seconds of [0, 60, 120]) {
    await runWeatherJobsTick({
      now: new Date(startedAt.getTime() + seconds * 1_000),
      dataDir,
      fetchWeather: async () => weather(12),
    });
  }
  const finished = (await (await post([job.id])).json()) as {
    jobs: Array<{ status: string; content: string }>;
  };
  expect(finished.jobs[0].status).toBe('completed');
  expect(finished.jobs[0].content).toContain(
    '| Время замера (МСК) | Температура, °C | Осадки, мм |',
  );
  expect(finished.jobs[0].content).toMatch(/26\.09.*13:00:00 \| 12 \| 0 \|/u);
  expect(finished.jobs[0].content).toContain('все 2 замера получены');
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0].input)).toContain('expectedSampleCount');

  delete process.env.DEEPSEEK_API_KEY;
  const fallback = (await (await post([job.id])).json()) as {
    jobs: Array<{ content: string }>;
  };
  expect(fallback.jobs[0].content).toContain(
    'Итог: температура 12 °C, дождя не было; получено замеров: 2 из 2.',
  );
  expect((await post(['../etc'])).status).toBe(400);
});

test('/api/weather сообщает о недоступности MCP', async () => {
  process.env.MCP_CAPSULE_URL = 'http://127.0.0.1:9/mcp';
  const response = await GET(new Request('http://localhost/api/weather'));
  expect(response.status).toBe(503);
});

test('агент в чате сам планирует сбор через MCP и получает jobId', async () => {
  const dataDir = await newDataDir();
  const { url } = await startWeatherMcp(dataDir);
  process.env.MCP_CAPSULE_URL = url;
  process.env.DEEPSEEK_API_KEY = 'test-secret';
  const requests = stubDeepSeek((body) =>
    Array.isArray(body.input) && body.input.length === 1
      ? {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_schedule',
              name: 'schedule_weather_collection',
              arguments: '{"intervalMinutes":2,"durationMinutes":20}',
            },
          ],
        }
      : modelText('Запустила сбор: каждые 2 минуты в течение 20 минут.'),
  );

  const response = await chatPOST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: 'Собирай погоду каждые 2 минуты в течение 20 минут',
          },
        ],
        useMcpTools: true,
      }),
    }),
  );
  const events = await response.text();

  expect(response.status).toBe(200);
  expect(requests[0].tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'schedule_weather_collection' }),
      expect.objectContaining({ name: 'get_weather_summary' }),
    ]),
  );
  const jobId = events.match(/"weatherJobId":"([^"]+)"/u)?.[1];
  expect(jobId).toBeTruthy();
  expect(events).toContain(
    '"mcpTools":["ai-vps__schedule_weather_collection"]',
  );
  // The model is told that the chat delivers the result by itself.
  expect(JSON.stringify(requests[1].input)).toContain('chatNote');
  expect(await readWeatherJob(jobId, dataDir)).toMatchObject({
    intervalMinutes: 2,
    durationMinutes: 20,
    status: 'running',
  });
});
