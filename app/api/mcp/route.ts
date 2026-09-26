import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import type {
  McpDirectoryResponse,
  McpServerInfo,
  McpToolInfo,
} from '@/lib/mcp-directory';
import { MCP_SERVERS, type McpServerConfig } from '@/lib/server/mcp-config';

async function describeServer(server: McpServerConfig): Promise<McpServerInfo> {
  const client = new Client({
    name: 'ai-challenge-directory',
    version: '1.0.0',
  });
  let tools: McpToolInfo[] = [];
  let status: McpServerInfo['status'] = 'unavailable';

  try {
    await client.connect(
      new StreamableHTTPClientTransport(server.url(), {
        requestInit: { signal: AbortSignal.timeout(5_000) },
      }),
    );
    const result = await client.listTools(undefined, { timeout: 5_000 });
    tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as McpToolInfo['inputSchema'],
    }));
    status = 'connected';
  } catch {
    // Keep the directory visible when a server or the SSH tunnel is down.
  } finally {
    try {
      await client.close();
    } catch {
      // A failed connection may not have an open transport to close.
    }
  }

  return {
    id: server.id,
    name: server.name,
    location: server.location,
    hint: server.hint,
    status,
    tools,
  };
}

export async function GET(): Promise<Response> {
  return Response.json(
    {
      servers: await Promise.all(MCP_SERVERS.map(describeServer)),
    } satisfies McpDirectoryResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
