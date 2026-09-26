import { createServer } from 'node:http';

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';

export function portFromEnv(variable, fallback) {
  const port = Number(process.env[variable] ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${variable} must be a TCP port from 0 to 65535`);
  }
  return port;
}

// Local MCP servers listen on loopback only, like the capsule server.
export function listenMcp(handler, { name, port }) {
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (
      !validateHost(request, response) ||
      !validateOrigin(request, response)
    ) {
      return;
    }
    void nodeHandler(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address && typeof address !== 'string') {
        console.log(
          `${name} MCP server listening at http://127.0.0.1:${address.port}/mcp`,
        );
      }
      resolve(server);
    });
  });
}

export function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function errorResult(error, fallback) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message.slice(0, 300) : fallback,
      },
    ],
  };
}
