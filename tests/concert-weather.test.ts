import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { afterEach, expect, test, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { AGENT_SKILLS, buildSkillsPrompt } from '@/lib/agent-skills';
import { createWeatherMcpHandler } from '@/scripts/mcp/handler.mjs';

const DEEPSEEK_URL = 'https://api.deepseek.com/responses';
const saved = {
  capsuleUrl: process.env.MCP_CAPSULE_URL,
  apiKey: process.env.DEEPSEEK_API_KEY,
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const [name, value] of [
    ['MCP_CAPSULE_URL', saved.capsuleUrl],
    ['DEEPSEEK_API_KEY', saved.apiKey],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// get_weather is faked: the tests check what city it receives.
async function startMcp() {
  const dataDir = await mkdtemp(join(tmpdir(), 'concert-weather-'));
  cleanups.push(() => rm(dataDir, { recursive: true }));
  const getWeather = vi.fn(async (city: string) => ({
    source: 'Open-Meteo',
    location: { name: city, country: 'Германия', timezone: 'Europe/Berlin' },
    current: {
      time: '2026-09-26T18:00',
      temperature_2m: 12.5,
      weather_code: 61,
    },
    units: { temperature_2m: '°C' },
  }));
  const nodeHandler = toNodeHandler(
    createWeatherMcpHandler({ dataDir, getWeather }),
  );
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
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, getWeather };
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('');
}

test('скилл предлагается модели только при наличии всей цепочки инструментов', () => {
  expect(AGENT_SKILLS.map((skill) => skill.tools)).toEqual([
    ['find_concert', 'get_weather'],
  ]);
  expect(buildSkillsPrompt(['get_weather'])).toBeNull();
  const prompt = buildSkillsPrompt(['ping', 'find_concert', 'get_weather']);
  expect(prompt).toContain(
    'Скилл «Погода на концерте» (find_concert → get_weather)',
  );
  expect(prompt).toContain('вызови get_weather ровно с этим значением');
});

test('цепочка через MCP: город из find_concert уходит в get_weather без изменений', async () => {
  const { url, getWeather } = await startMcp();
  const client = new Client({ name: 'chain-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanups.push(() => client.close());

  const listing = JSON.parse(
    toolText(
      await client.callTool({
        name: 'find_concert',
        arguments: { performer: 'Нюши' },
      }),
    ),
  ) as { found: boolean; concerts: Array<{ city: string }> };
  expect(listing).toMatchObject({
    found: true,
    concerts: [{ performer: 'Нюша', city: 'Потсдам' }],
  });

  const weather = JSON.parse(
    toolText(
      await client.callTool({
        name: 'get_weather',
        arguments: { city: listing.concerts[0].city },
      }),
    ),
  ) as { location: { name: string } };
  expect(getWeather).toHaveBeenCalledExactlyOnceWith('Потсдам');
  expect(weather.location.name).toBe('Потсдам');
});

test('агент сам выполняет скилл: find_concert → get_weather → ответ', async () => {
  const { url, getWeather } = await startMcp();
  process.env.MCP_CAPSULE_URL = url;
  process.env.DEEPSEEK_API_KEY = 'test-secret';
  const nativeFetch = globalThis.fetch;
  const requests: Array<{
    instructions?: string;
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
    const wrapped = JSON.parse(String(output?.output)) as { content: string[] };
    return JSON.parse(wrapped.content[0]) as Record<string, unknown>;
  };
  // The fake model acts only on what the tools returned.
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : input.toString();
      if (target !== DEEPSEEK_URL) return nativeFetch(input, init);
      requests.push(JSON.parse(init?.body as string));
      if (requests.length === 1) {
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_concert',
              name: 'find_concert',
              arguments: '{"performer":"Нюша"}',
            },
          ],
        });
      }
      if (requests.length === 2) {
        const { concerts } = outputOf('find_concert') as {
          concerts: Array<{ city: string }>;
        };
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_weather',
              name: 'get_weather',
              arguments: JSON.stringify({ city: concerts[0].city }),
            },
          ],
        });
      }
      const weather = outputOf('get_weather') as {
        location: { name: string };
        current: { temperature_2m: number };
      };
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: `Нюша выступает в ${weather.location.name}, там ${weather.current.temperature_2m} °C.`,
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
          { role: 'user', content: 'Какая погода, где выступает Нюша?' },
        ],
        useMcpTools: true,
      }),
    }),
  );
  const events = await response.text();

  expect(response.status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(requests[0].instructions).toContain(
    'Скилл «Погода на концерте» (find_concert → get_weather)',
  );
  expect(getWeather).toHaveBeenCalledExactlyOnceWith('Потсдам');
  expect(events).toContain('"mcpTools":["find_concert","get_weather"]');
  expect(events).toContain('Нюша выступает в Потсдам, там 12.5 °C.');
});
