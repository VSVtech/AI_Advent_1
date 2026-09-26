import { createServer } from 'node:http';

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createWeatherMcpHandler } from './handler.mjs';

const port = Number(process.env.MCP_PORT ?? 8765);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('MCP_PORT must be a TCP port from 0 to 65535');
}

const handler = createWeatherMcpHandler();

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
