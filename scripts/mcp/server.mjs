import { createServer } from 'node:http';

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from '@modelcontextprotocol/server';

import { getCurrentWeather } from './weather.mjs';

const port = Number(process.env.MCP_PORT ?? 8765);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('MCP_PORT must be a TCP port from 0 to 65535');
}

const handler = createMcpHandler(() => {
  const mcp = new McpServer({ name: 'ai-challenge-mcp', version: '1.0.0' });

  mcp.registerTool(
    'ping',
    { description: 'Проверить доступность MCP-сервера' },
    async () => ({ content: [{ type: 'text', text: 'pong' }] }),
  );
  mcp.registerTool(
    'server_time',
    { description: 'Получить текущее время сервера в ISO 8601' },
    async () => ({
      content: [{ type: 'text', text: new Date().toISOString() }],
    }),
  );
  mcp.registerTool(
    'get_weather',
    {
      description:
        'Получить текущую погоду в указанном городе через Open-Meteo',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          city: {
            type: 'string',
            minLength: 2,
            maxLength: 120,
            description:
              'Название города, при необходимости с указанием страны',
          },
        },
        required: ['city'],
        additionalProperties: false,
      }),
    },
    async ({ city }) => {
      try {
        const weather = await getCurrentWeather(city);
        return { content: [{ type: 'text', text: JSON.stringify(weather) }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof Error
                  ? error.message
                  : 'Не удалось получить погоду',
            },
          ],
        };
      }
    },
  );

  return mcp;
});

const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const server = createServer((request, response) => {
  if (request.url !== '/mcp') {
    response.writeHead(404).end();
    return;
  }
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }
  void nodeHandler(request, response);
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(`MCP server listening at http://127.0.0.1:${address.port}/mcp`);
  }
});
