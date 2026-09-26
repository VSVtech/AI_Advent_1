import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const serverPath = fileURLToPath(
  new URL('../scripts/mcp/server.mjs', import.meta.url),
);
const clientPath = fileURLToPath(
  new URL('../scripts/mcp/list-tools.mjs', import.meta.url),
);

test('MCP-клиент подключается и получает инструменты сервера', async () => {
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

    const result = spawnSync(process.execPath, [clientPath], {
      env: { ...process.env, MCP_SERVER_URL: endpoint },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const tools = JSON.parse(result.stdout) as Array<{
      name: string;
      description: string;
      inputSchema: {
        type: string;
        required?: string[];
        properties?: Record<string, { type: string }>;
      };
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      'ping',
      'server_time',
      'get_weather',
      'find_concert',
      'schedule_weather_collection',
      'get_weather_summary',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(
      tools.find((tool) => tool.name === 'get_weather')?.inputSchema,
    ).toMatchObject({
      required: ['city'],
      properties: { city: { type: 'string' } },
    });
    expect(
      tools.find((tool) => tool.name === 'schedule_weather_collection')
        ?.inputSchema,
    ).toMatchObject({
      required: ['intervalMinutes', 'durationMinutes'],
      properties: {
        city: { type: 'string' },
        intervalMinutes: { type: 'integer' },
        durationMinutes: { type: 'integer' },
      },
    });
  } finally {
    server.kill();
  }
}, 25_000);
