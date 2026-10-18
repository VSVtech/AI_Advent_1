import { describe, expect, it } from 'vitest';

import { MCP_SERVERS } from '@/lib/server/mcp-config';
import { validArguments } from '@/lib/server/mcp-agent';

// One valid call per tool. A new tool in mcp-config.ts without a rule in
// validArguments (or without a sample here) fails this file: the client would
// reject every call of such a tool as «Некорректные аргументы».
const VALID: Record<string, Record<string, unknown>> = {
  ping: {},
  server_time: {},
  get_weather: { city: 'Москва' },
  find_concert: { performer: 'Нюша' },
  schedule_weather_collection: { city: 'Москва', intervalMinutes: 5, durationMinutes: 30 },
  get_weather_summary: {},
  plan_trip: { from: 'Берлин', to: 'Потсдам' },
  save_note: { title: 'План', content: 'Текст' },
  list_notes: {},
  read_note: { id: '2026-10-17-plan-abc123' },
  git_current_branch: {},
  git_status: {},
  git_changed_files: { base: 'main' },
  git_diff: { base: 'main', path: 'README.md' },
  git_list_files: { directory: 'lib' },
  get_ticket: { ticketId: 'TCK-1001' },
  get_user: { userId: 'u-1001' },
  list_user_tickets: { userId: 'u-1001' },
  get_auth_events: { userId: 'u-1001', limit: 5 },
  fs_list: { directory: 'docs' },
  fs_read: { path: 'README.md', startLine: 1, endLine: 20 },
  fs_search: { query: 'get_weather', extension: '.ts' },
  fs_replace: { path: 'README.md', search: 'a', replace: 'b', dryRun: true },
  fs_write: { path: 'docs/adr/0002-x.md', content: '# ADR', overwrite: false },
  rc_get_telemetry: {},
  rc_get_firmware_config: {},
  scope_list_channels: {},
  scope_measure: { channel: 1, windowMs: 60 },
  scope_capture: { channel: 2, windowMs: 100, maxPoints: 40 },
};

describe('MCP client argument rules', () => {
  const tools = MCP_SERVERS.flatMap((server) => server.tools);

  it.each(tools)('%s accepts a valid call', (tool) => {
    expect(VALID[tool], `нет образца аргументов для ${tool}`).toBeDefined();
    expect(validArguments(tool, VALID[tool])).toBe(true);
  });

  it.each(tools.filter((tool) => tool.length > 0))('%s rejects unknown arguments', (tool) => {
    expect(validArguments(tool, { ...VALID[tool], unexpected: 1 })).toBe(false);
  });

  it('every sample belongs to a registered tool', () => {
    expect(Object.keys(VALID).sort()).toEqual([...new Set(tools)].sort());
  });

  it('rejects out-of-range scope and file arguments', () => {
    expect(validArguments('scope_measure', { channel: 5 })).toBe(false);
    expect(validArguments('scope_measure', { channel: 1, maxPoints: 40 })).toBe(false);
    expect(validArguments('scope_capture', { channel: 1, maxPoints: 5 })).toBe(false);
    expect(validArguments('scope_capture', { channel: '1' })).toBe(false);
    expect(validArguments('fs_read', { path: 'a.md', startLine: 0 })).toBe(false);
    expect(validArguments('fs_write', { path: 'docs/a.md', content: '' })).toBe(false);
    expect(validArguments('unknown_tool', {})).toBe(false);
  });
});
