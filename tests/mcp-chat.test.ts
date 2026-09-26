import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import type { McpAgentConnection } from '@/lib/server/mcp-agent';
import { generateInvariantSafeOutput } from '@/lib/server/task-invariants';

const serverPath = fileURLToPath(
  new URL('../scripts/mcp/server.mjs', import.meta.url),
);
const originalUrl = process.env.MCP_CAPSULE_URL;
const originalApiKey = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.MCP_CAPSULE_URL;
  else process.env.MCP_CAPSULE_URL = originalUrl;
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  vi.unstubAllGlobals();
});

test('агент вызывает MCP-инструмент и передаёт результат модели', async () => {
  const server = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MCP_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('MCP-сервер не запустился')),
        10_000,
      );
      let output = '';
      server.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(
          /MCP server listening at (http:\/\/127\.0\.0\.1:\d+\/mcp)/,
        );
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      server.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      server.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`MCP-сервер завершился с кодом ${code}`));
      });
    });
    process.env.MCP_CAPSULE_URL = endpoint;
    process.env.DEEPSEEK_API_KEY = 'test-secret';

    const nativeFetch = globalThis.fetch;
    const modelRequests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== 'https://api.deepseek.com/responses') {
          return nativeFetch(input, init);
        }
        if (typeof init?.body !== 'string') {
          throw new Error('Ожидалось JSON-тело запроса к DeepSeek');
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        modelRequests.push(body);
        if (modelRequests.length === 1) {
          return Response.json({
            status: 'completed',
            usage: { input_tokens: 40, output_tokens: 8 },
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'ping',
                arguments: '{}',
              },
            ],
          });
        }
        return Response.json({
          status: 'completed',
          usage: { input_tokens: 52, output_tokens: 10 },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'MCP доступен: pong' }],
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
          messages: [{ role: 'user', content: 'Проверь MCP' }],
          useMcpTools: true,
        }),
      }),
    );
    const events = await response.text();

    expect(response.status).toBe(200);
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'ping' }),
        expect.objectContaining({ type: 'function', name: 'get_weather' }),
      ]),
    );
    expect(modelRequests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_1',
          name: 'ping',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_1',
          output: expect.stringContaining('pong'),
        }),
      ]),
    );
    expect(events).toContain('MCP доступен: pong');
    expect(events).toContain('"mcpTools":["ai-vps__ping"]');
    expect(events).toContain('"toolInputTokens":40');
  } finally {
    server.kill();
  }
}, 25_000);

test('ответ задачи после MCP-вызова проходит проверку этапа и инвариантов', async () => {
  const callTool = vi.fn().mockResolvedValue('{"ok":true,"content":["pong"]}');
  const connection: McpAgentConnection = {
    tools: [
      {
        type: 'function',
        name: 'ping',
        description: 'Проверить сервер',
        parameters: { type: 'object', properties: {} },
      },
    ],
    callTool,
    close: async () => {},
  };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Нет JSON-тела');
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      if (requests.length === 1) {
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'task_call_1',
              name: 'ping',
              arguments: '{}',
            },
          ],
        });
      }
      const content =
        requests.length === 2
          ? 'Проверила MCP: pong. Продолжаю выполнение задачи.'
          : '{"violated":false,"invariant_index":null,"reason":""}';
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: content }],
          },
        ],
      });
    },
  );

  const response = await generateInvariantSafeOutput({
    apiKey: 'test-secret',
    contextWindowTokens: 1_000_000,
    format: 'text',
    maxOutputTokens: 200,
    mcpConnection: connection,
    messages: [{ role: 'user', content: 'Проверь MCP' }],
    model: 'deepseek-v4-pro',
    signal: new AbortController().signal,
    state: {
      title: 'Проверка',
      goal: 'Проверить MCP',
      phase: 'execution',
      invariants: ['Не изменять сервер'],
      expectedAction: null,
      awaitingConfirmation: false,
      paused: false,
      updatedAt: 1,
    },
    systemPrompt: 'Соблюдай этап задачи.',
    temperature: 0,
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain('"mcpTools":["ping"]');
  expect(requests).toHaveLength(3);
  expect(requests[2].tools).toBeUndefined();
  expect(callTool).toHaveBeenCalledOnce();
});
