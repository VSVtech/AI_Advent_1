import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { mcpCapsuleUrl } from '@/lib/server/mcp-config';

const ALLOWED_TOOLS = new Set([
  'ping',
  'server_time',
  'get_weather',
  'schedule_weather_collection',
  'get_weather_summary',
]);
const MAX_TOOL_RESULT_LENGTH = 16_000;
const WEATHER_JOB_ID = /^[a-zA-Z0-9_-]{1,100}$/u;
const MCP_TIMEOUT_MS = 10_000;

export type DeepSeekFunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type McpAgentConnection = {
  tools: DeepSeekFunctionTool[];
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
  close: () => Promise<void>;
  // Weather jobs created during this request; the chat delivers their result.
  scheduledWeatherJobIds?: readonly string[];
};

function isCityArgument(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length >= 2 &&
    value.trim().length <= 120
  );
}

function validArguments(name: string, args: Record<string, unknown>): boolean {
  if (name === 'ping' || name === 'server_time') {
    return Object.keys(args).length === 0;
  }
  if (name === 'get_weather') {
    return Object.keys(args).length === 1 && isCityArgument(args.city);
  }
  // Ranges are checked by the MCP server, whose message the model can relay.
  if (name === 'schedule_weather_collection') {
    return (
      Object.keys(args).every((key) =>
        ['city', 'intervalMinutes', 'durationMinutes'].includes(key),
      ) &&
      (args.city === undefined || isCityArgument(args.city)) &&
      Number.isInteger(args.intervalMinutes) &&
      Number.isInteger(args.durationMinutes)
    );
  }
  if (name === 'get_weather_summary') {
    const keys = Object.keys(args);
    return (
      keys.length <= 1 &&
      (args.jobId === undefined ||
        (typeof args.jobId === 'string' && WEATHER_JOB_ID.test(args.jobId))) &&
      (args.date === undefined ||
        (typeof args.date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/u.test(args.date))) &&
      keys.every((key) => key === 'jobId' || key === 'date')
    );
  }
  return false;
}

function scheduledJobId(text: string | undefined): string | null {
  try {
    const value = JSON.parse(text ?? '') as { jobId?: unknown };
    return typeof value.jobId === 'string' && WEATHER_JOB_ID.test(value.jobId)
      ? value.jobId
      : null;
  } catch {
    return null;
  }
}

function asToolOutput(value: unknown): string {
  const output = JSON.stringify(value);
  return output.length <= MAX_TOOL_RESULT_LENGTH
    ? output
    : `${output.slice(0, MAX_TOOL_RESULT_LENGTH)}…[результат сокращён]`;
}

export async function connectAgentMcp(
  signal: AbortSignal,
): Promise<McpAgentConnection | null> {
  if (signal.aborted) return null;
  const client = new Client({ name: 'ai-challenge-agent', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpCapsuleUrl()), {
      timeout: 5_000,
      signal,
    });
    const listed = await client.listTools(undefined, {
      timeout: 5_000,
      signal,
    });
    const tools = listed.tools
      .filter((tool) => ALLOWED_TOOLS.has(tool.name))
      .map(
        (tool): DeepSeekFunctionTool => ({
          type: 'function',
          name: tool.name,
          description: tool.description ?? `MCP-инструмент ${tool.name}`,
          parameters: tool.inputSchema as Record<string, unknown>,
        }),
      );
    if (tools.length === 0) {
      await client.close();
      return null;
    }
    const scheduledWeatherJobIds: string[] = [];

    return {
      tools,
      scheduledWeatherJobIds,
      async callTool(name, args, callSignal) {
        if (!tools.some((tool) => tool.name === name)) {
          return asToolOutput({ ok: false, error: 'Инструмент недоступен' });
        }
        if (!validArguments(name, args)) {
          return asToolOutput({ ok: false, error: 'Некорректные аргументы' });
        }
        try {
          const result = await client.callTool(
            { name, arguments: args },
            { timeout: MCP_TIMEOUT_MS, signal: callSignal },
          );
          const content = result.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text);
          const jobId =
            name === 'schedule_weather_collection' && result.isError !== true
              ? scheduledJobId(content[0])
              : null;
          if (jobId) scheduledWeatherJobIds.push(jobId);
          return asToolOutput({
            ok: result.isError !== true,
            content: content.length ? content : ['Пустой ответ инструмента'],
            ...(jobId
              ? {
                  chatNote:
                    'Итог этого задания чат добавит сюда сам после окончания сбора; пользователю ничего запрашивать не нужно.',
                }
              : {}),
          });
        } catch {
          if (callSignal.aborted)
            throw new DOMException('Aborted', 'AbortError');
          return asToolOutput({
            ok: false,
            error: 'MCP-инструмент временно недоступен',
          });
        }
      },
      close: () => client.close(),
    };
  } catch {
    try {
      await client.close();
    } catch {
      // A failed connection may not have an open transport to close.
    }
    return null;
  }
}
