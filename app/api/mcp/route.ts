import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import type { McpDirectoryResponse, McpToolInfo } from '@/lib/mcp-directory';

const CAPSULE_URL = 'http://127.0.0.1:18765/mcp';

export async function GET(): Promise<Response> {
  const client = new Client({
    name: 'ai-challenge-directory',
    version: '1.0.0',
  });
  let tools: McpToolInfo[] = [];
  let status: 'connected' | 'unavailable' = 'unavailable';

  try {
    const endpoint = new URL(process.env.MCP_CAPSULE_URL ?? CAPSULE_URL);
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
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
    // Keep the directory visible when the SSH tunnel or capsule is unavailable.
  } finally {
    try {
      await client.close();
    } catch {
      // A failed connection may not have an open transport to close.
    }
  }

  return Response.json(
    {
      servers: [
        {
          id: 'ai-vps',
          name: 'MCP на капсуле',
          status,
          tools,
        },
      ],
    } satisfies McpDirectoryResponse,
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
