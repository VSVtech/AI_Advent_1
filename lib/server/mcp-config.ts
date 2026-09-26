export const DEFAULT_MCP_CAPSULE_URL = 'http://127.0.0.1:18765/mcp';
export const DEFAULT_MCP_TRAVEL_URL = 'http://127.0.0.1:18801/mcp';
export const DEFAULT_MCP_NOTES_URL = 'http://127.0.0.1:18802/mcp';

export function mcpCapsuleUrl(): URL {
  return new URL(process.env.MCP_CAPSULE_URL ?? DEFAULT_MCP_CAPSULE_URL);
}

export type McpServerConfig = {
  id: string;
  name: string;
  location: string;
  hint: string;
  url: () => URL;
  // Only these tools are offered to the model; the catalog shows every tool.
  tools: readonly string[];
};

// Registered MCP servers: the remote capsule and two local servers started
// by start.sh. The agent routes each tool call to the server that owns it.
export const MCP_SERVERS: readonly McpServerConfig[] = [
  {
    id: 'ai-vps',
    name: 'MCP на капсуле',
    location: 'ai-vps · Streamable HTTP',
    hint: 'Проверьте SSH-туннель и нажмите «Обновить».',
    url: mcpCapsuleUrl,
    tools: [
      'ping',
      'server_time',
      'get_weather',
      'find_concert',
      'schedule_weather_collection',
      'get_weather_summary',
    ],
  },
  {
    id: 'travel',
    name: 'Поездки',
    location: 'локально · Streamable HTTP',
    hint: 'Запустите приложение через start.sh или выполните pnpm mcp:travel.',
    url: () => new URL(process.env.MCP_TRAVEL_URL ?? DEFAULT_MCP_TRAVEL_URL),
    tools: ['plan_trip'],
  },
  {
    id: 'notes',
    name: 'Заметки',
    location: 'локально · Streamable HTTP',
    hint: 'Запустите приложение через start.sh или выполните pnpm mcp:notes.',
    url: () => new URL(process.env.MCP_NOTES_URL ?? DEFAULT_MCP_NOTES_URL),
    tools: ['save_note', 'list_notes', 'read_note'],
  },
];
