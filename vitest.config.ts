import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    restoreMocks: true,
    // Tests never reach the real capsule or local MCP servers by accident.
    env: {
      MCP_CAPSULE_URL: 'http://127.0.0.1:9/mcp',
      MCP_TRAVEL_URL: 'http://127.0.0.1:9/mcp',
      MCP_NOTES_URL: 'http://127.0.0.1:9/mcp',
    },
  },
});
