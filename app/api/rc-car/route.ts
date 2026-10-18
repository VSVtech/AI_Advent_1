import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import type {
  RcCarSnapshot,
  RcCarTelemetry,
  ScopeCapture,
} from '@/lib/rc-car-types';
import { MCP_SERVERS } from '@/lib/server/mcp-config';

const TIMEOUT_MS = 8_000;
const CHANNELS = [1, 2, 3, 4];
const WINDOW_MS = 60;
const PLOT_POINTS = 240;

function parse<T>(result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): T {
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (result.isError || !text) throw new Error('Пустой ответ инструмента');
  return JSON.parse(text) as T;
}

// The desk reads the same MCP server and tools the assistant uses, so the
// plots and the diagnosis always come from one data source.
export async function GET(): Promise<Response> {
  const server = MCP_SERVERS.find((item) => item.id === 'rc-car');
  if (!server) {
    return Response.json({ error: 'Сервер машинки не настроен.' }, { status: 500 });
  }
  const client = new Client({ name: 'ai-challenge-rc-car-desk', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(server.url(), {
        requestInit: { signal: AbortSignal.timeout(TIMEOUT_MS) },
      }),
    );
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }, { timeout: TIMEOUT_MS });
    const telemetry = parse<RcCarTelemetry & { source: string }>(
      (await call('rc_get_telemetry')) as never,
    );
    const captures: ScopeCapture[] = [];
    for (const channel of CHANNELS) {
      captures.push(
        parse<ScopeCapture>(
          (await call('scope_capture', {
            channel,
            windowMs: WINDOW_MS,
            maxPoints: PLOT_POINTS,
          })) as never,
        ),
      );
    }
    return Response.json(
      { source: telemetry.source, telemetry, captures } satisfies RcCarSnapshot,
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: `Сервер машинки недоступен. ${server.hint}` },
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
