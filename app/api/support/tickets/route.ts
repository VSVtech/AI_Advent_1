import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import type { SupportTicket } from '@/lib/support-tickets';
import { MCP_SERVERS } from '@/lib/server/mcp-config';

const TIMEOUT_MS = 5_000;

// The ticket queue comes from the «Поддержка» MCP server, like the tools the
// assistant itself uses: the app has no separate data access.
export async function GET(): Promise<Response> {
  const server = MCP_SERVERS.find((item) => item.id === 'support');
  if (!server) {
    return Response.json({ error: 'Сервер поддержки не настроен.' }, { status: 500 });
  }
  const client = new Client({ name: 'ai-challenge-support-desk', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(server.url(), {
        requestInit: { signal: AbortSignal.timeout(TIMEOUT_MS) },
      }),
    );
    const result = await client.callTool(
      { name: 'list_tickets', arguments: {} },
      { timeout: TIMEOUT_MS },
    );
    const text = result.content.find((item) => item.type === 'text');
    const parsed = JSON.parse(text && 'text' in text ? text.text : '{}') as {
      tickets?: SupportTicket[];
    };
    if (result.isError || !Array.isArray(parsed.tickets)) throw new Error();
    return Response.json(
      { tickets: parsed.tickets },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: `Сервер поддержки недоступен. ${server.hint}` },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  } finally {
    try {
      await client.close();
    } catch {
      // A failed connection may not have an open transport to close.
    }
  }
}
