import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vitest';

import { GET } from '@/app/api/mcp/route';
import type { McpDirectoryResponse } from '@/lib/mcp-directory';

const serverPath = fileURLToPath(
  new URL('../scripts/mcp/server.mjs', import.meta.url),
);
const originalUrl = process.env.MCP_CAPSULE_URL;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.MCP_CAPSULE_URL;
  else process.env.MCP_CAPSULE_URL = originalUrl;
});

test('каталог получает реальные инструменты MCP-сервера', async () => {
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
    const response = await GET();
    const payload = (await response.json()) as McpDirectoryResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload.servers[0]).toMatchObject({
      id: 'ai-vps',
      status: 'connected',
    });
    expect(payload.servers[0].tools.map((tool) => tool.name)).toEqual([
      'ping',
      'server_time',
      'get_weather',
    ]);
    expect(payload.servers[0].tools[2].inputSchema.required).toEqual(['city']);
  } finally {
    server.kill();
  }
}, 25_000);

test('каталог показывает недоступность, если соединение не установлено', async () => {
  process.env.MCP_CAPSULE_URL = 'not a url';
  const response = await GET();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    servers: [
      {
        id: 'ai-vps',
        name: 'MCP на капсуле',
        status: 'unavailable',
        tools: [],
      },
    ],
  });
});
