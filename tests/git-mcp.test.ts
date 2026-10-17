import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseHelpCommand, HELP_DEFAULT_QUESTION } from '@/lib/help-command';
import {
  changedFiles,
  currentBranch,
  gitDiff,
  gitStatus,
  listFiles,
} from '@/scripts/mcp-servers/git.mjs';

let repo: string;
const run = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-mcp-'));
  run('init', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-m', 'init');
  run('checkout', '-b', 'feature/x');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('git MCP server', () => {
  it('returns the current branch', async () => {
    expect(await currentBranch(repo)).toEqual({
      branch: 'feature/x',
      detached: false,
    });
  });

  it('reports status, changed files and diff', async () => {
    expect((await gitStatus(repo)).changes).toEqual([' M a.txt']);
    expect(await changedFiles(repo)).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect((await gitDiff(repo, { path: 'a.txt' })).text).toContain('+two');
  });

  it('lists tracked files', async () => {
    expect(await listFiles(repo)).toEqual({ total: 1, files: ['a.txt'] });
  });

  it('rejects option-like and escaping arguments', async () => {
    await expect(gitDiff(repo, { base: '--output=x' })).rejects.toThrow();
    await expect(gitDiff(repo, { path: '../secret' })).rejects.toThrow();
    await expect(listFiles(repo, '--help')).rejects.toThrow();
  });
});

describe('/help command', () => {
  it('extracts the question', () => {
    expect(parseHelpCommand('/help где лежит RAG?')).toBe('где лежит RAG?');
    expect(parseHelpCommand(' /HELP ')).toBe(HELP_DEFAULT_QUESTION);
    expect(parseHelpCommand('/helpme')).toBeNull();
    expect(parseHelpCommand('привет /help')).toBeNull();
  });
});
