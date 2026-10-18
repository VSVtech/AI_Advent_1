import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import { MCP_SERVERS, type McpServerConfig } from '@/lib/server/mcp-config';

const MAX_TOOL_RESULT_LENGTH = 16_000;
const WEATHER_JOB_ID = /^[a-zA-Z0-9_-]{1,100}$/u;
// get_weather on the capsule may first wait out a blocked Open-Meteo host.
const MCP_TIMEOUT_MS = 25_000;

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
  // «server__tool» label of a call, for the call trace shown in the chat.
  traceName?: (name: string) => string;
};

function isCityArgument(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length >= 2 &&
    value.trim().length <= 120
  );
}

export function validArguments(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (name === 'ping' || name === 'server_time') {
    return Object.keys(args).length === 0;
  }
  if (name === 'get_weather') {
    return Object.keys(args).length === 1 && isCityArgument(args.city);
  }
  if (name === 'plan_trip') {
    return (
      Object.keys(args).every((key) => ['from', 'to', 'date'].includes(key)) &&
      isCityArgument(args.from) &&
      isCityArgument(args.to) &&
      (args.date === undefined ||
        (typeof args.date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/u.test(args.date)))
    );
  }
  if (name === 'save_note') {
    return (
      Object.keys(args).length === 2 &&
      typeof args.title === 'string' &&
      args.title.trim().length >= 1 &&
      args.title.length <= 120 &&
      typeof args.content === 'string' &&
      args.content.trim().length >= 1 &&
      args.content.length <= 20_000
    );
  }
  if (name === 'list_notes') return Object.keys(args).length === 0;
  if (name === 'read_note') {
    return (
      Object.keys(args).length === 1 &&
      typeof args.id === 'string' &&
      /^[a-z0-9-]{1,100}$/u.test(args.id)
    );
  }
  if (name === 'find_concert') {
    const keys = Object.keys(args);
    return (
      keys.every((key) => key === 'performer') &&
      (args.performer === undefined ||
        (typeof args.performer === 'string' &&
          args.performer.trim().length >= 2 &&
          args.performer.trim().length <= 60))
    );
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
  // RC car: read-only telemetry and oscilloscope measurements.
  if (
    name === 'rc_get_telemetry' ||
    name === 'rc_get_firmware_config' ||
    name === 'scope_list_channels'
  ) {
    return Object.keys(args).length === 0;
  }
  if (name === 'scope_measure' || name === 'scope_capture') {
    const allowed =
      name === 'scope_capture'
        ? ['channel', 'windowMs', 'maxPoints']
        : ['channel', 'windowMs'];
    const inRange = (value: unknown, min: number, max: number) =>
      value === undefined ||
      (Number.isInteger(value) &&
        (value as number) >= min &&
        (value as number) <= max);
    return (
      Object.keys(args).every((key) => allowed.includes(key)) &&
      Number.isInteger(args.channel) &&
      inRange(args.channel, 1, 4) &&
      inRange(args.windowMs, 5, 200) &&
      inRange(args.maxPoints, 8, 400)
    );
  }
  // File tools: paths and the writable set are enforced by the server.
  if (name === 'fs_list') {
    return Object.entries(args).every(
      ([key, value]) =>
        key === 'directory' && typeof value === 'string' && value.length <= 300,
    );
  }
  if (name === 'fs_read') {
    return (
      Object.keys(args).every((key) =>
        ['path', 'startLine', 'endLine'].includes(key),
      ) &&
      typeof args.path === 'string' &&
      args.path.length <= 300 &&
      ['startLine', 'endLine'].every(
        (key) =>
          args[key] === undefined ||
          (Number.isInteger(args[key]) && (args[key] as number) >= 1),
      )
    );
  }
  if (name === 'fs_search') {
    return (
      Object.keys(args).every((key) =>
        ['query', 'directory', 'extension'].includes(key),
      ) &&
      typeof args.query === 'string' &&
      args.query.length >= 2 &&
      args.query.length <= 200 &&
      ['directory', 'extension'].every(
        (key) =>
          args[key] === undefined ||
          (typeof args[key] === 'string' && (args[key] as string).length <= 300),
      )
    );
  }
  if (name === 'fs_replace') {
    return (
      Object.keys(args).every((key) =>
        ['path', 'search', 'replace', 'dryRun'].includes(key),
      ) &&
      typeof args.path === 'string' &&
      typeof args.search === 'string' &&
      args.search.length >= 1 &&
      typeof args.replace === 'string' &&
      (args.dryRun === undefined || typeof args.dryRun === 'boolean')
    );
  }
  if (name === 'fs_write') {
    return (
      Object.keys(args).every((key) =>
        ['path', 'content', 'overwrite', 'dryRun'].includes(key),
      ) &&
      typeof args.path === 'string' &&
      typeof args.content === 'string' &&
      args.content.length >= 1 &&
      ['overwrite', 'dryRun'].every(
        (key) => args[key] === undefined || typeof args[key] === 'boolean',
      )
    );
  }
  // Support tools are read-only; the server checks the id formats itself.
  if (name === 'get_ticket') {
    return (
      Object.keys(args).length === 1 &&
      typeof args.ticketId === 'string' &&
      /^TCK-\d{4,6}$/u.test(args.ticketId)
    );
  }
  if (name === 'get_user' || name === 'list_user_tickets') {
    return (
      Object.keys(args).length === 1 &&
      typeof args.userId === 'string' &&
      /^u-\d{3,6}$/u.test(args.userId)
    );
  }
  if (name === 'get_auth_events') {
    return (
      Object.keys(args).every((key) => key === 'userId' || key === 'limit') &&
      typeof args.userId === 'string' &&
      /^u-\d{3,6}$/u.test(args.userId) &&
      (args.limit === undefined ||
        (Number.isInteger(args.limit) &&
          (args.limit as number) >= 1 &&
          (args.limit as number) <= 20))
    );
  }
  // Git tools are read-only; the server validates refs and paths itself.
  if (name === 'git_current_branch' || name === 'git_status') {
    return Object.keys(args).length === 0;
  }
  if (name === 'git_changed_files' || name === 'git_diff') {
    return Object.entries(args).every(
      ([key, value]) =>
        (key === 'base' || (name === 'git_diff' && key === 'path')) &&
        typeof value === 'string' &&
        value.length <= 300,
    );
  }
  if (name === 'git_list_files') {
    return Object.entries(args).every(
      ([key, value]) =>
        key === 'directory' && typeof value === 'string' && value.length <= 300,
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

type ConnectedServer = {
  server: McpServerConfig;
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
};

type ToolRoute = { serverId: string; client: Client; toolName: string };

async function connectServer(
  server: McpServerConfig,
  signal: AbortSignal,
): Promise<ConnectedServer | null> {
  const client = new Client({ name: 'ai-challenge-agent', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(server.url()), {
      timeout: 5_000,
      signal,
    });
    const listed = await client.listTools(undefined, {
      timeout: 5_000,
      signal,
    });
    const tools = listed.tools.filter((tool) =>
      server.tools.includes(tool.name),
    );
    if (tools.length > 0) return { server, client, tools };
  } catch {
    // An unreachable server is skipped; the others keep working.
  }
  try {
    await client.close();
  } catch {
    // A failed connection may not have an open transport to close.
  }
  return null;
}

export async function connectAgentMcp(
  signal: AbortSignal,
  servers: readonly McpServerConfig[] = MCP_SERVERS,
): Promise<McpAgentConnection | null> {
  if (signal.aborted) return null;
  const connected = (
    await Promise.all(servers.map((server) => connectServer(server, signal)))
  ).filter((item): item is ConnectedServer => item !== null);
  if (connected.length === 0) return null;

  // A tool name offered by several servers is qualified with the server id.
  const owners = new Map<string, number>();
  for (const { tools } of connected) {
    for (const tool of tools) {
      owners.set(tool.name, (owners.get(tool.name) ?? 0) + 1);
    }
  }
  const routes = new Map<string, ToolRoute>();
  const tools: DeepSeekFunctionTool[] = [];
  for (const { server, client, tools: serverTools } of connected) {
    for (const tool of serverTools) {
      const name =
        (owners.get(tool.name) ?? 0) > 1
          ? `${server.id}__${tool.name}`
          : tool.name;
      routes.set(name, { serverId: server.id, client, toolName: tool.name });
      tools.push({
        type: 'function',
        name,
        description: `[${server.name}] ${tool.description ?? `MCP-инструмент ${tool.name}`}`,
        parameters: tool.inputSchema as Record<string, unknown>,
      });
    }
  }
  const scheduledWeatherJobIds: string[] = [];

  return {
    tools,
    scheduledWeatherJobIds,
    traceName(name) {
      const route = routes.get(name);
      return route ? `${route.serverId}__${route.toolName}` : name;
    },
    async callTool(name, args, callSignal) {
      const route = routes.get(name);
      if (!route) {
        return asToolOutput({ ok: false, error: 'Инструмент недоступен' });
      }
      if (!validArguments(route.toolName, args)) {
        return asToolOutput({ ok: false, error: 'Некорректные аргументы' });
      }
      try {
        const result = await route.client.callTool(
          { name: route.toolName, arguments: args },
          { timeout: MCP_TIMEOUT_MS, signal: callSignal },
        );
        const content = result.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text);
        const jobId =
          route.toolName === 'schedule_weather_collection' &&
          result.isError !== true
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
        if (callSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        return asToolOutput({
          ok: false,
          error: 'MCP-инструмент временно недоступен',
        });
      }
    },
    async close() {
      await Promise.allSettled(connected.map(({ client }) => client.close()));
    },
  };
}
