export const DEFAULT_MCP_CAPSULE_URL = 'http://127.0.0.1:18765/mcp';

export function mcpCapsuleUrl(): URL {
  return new URL(process.env.MCP_CAPSULE_URL ?? DEFAULT_MCP_CAPSULE_URL);
}
