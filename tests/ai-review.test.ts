import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildIndex,
  chunkText,
  search,
  tokenize,
} from '@/scripts/review/lexical-search.mjs';
import {
  REVIEW_MARKER,
  buildReviewInput,
  callDeepSeek,
  collectChange,
  formatComment,
  main,
  retrieveContext,
  trimPatch,
} from '@/scripts/review/review-pr.mjs';

let repo: string;
const run = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ai-review-'));
  run('init', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'rag'));
  mkdirSync(join(repo, 'lib'));
  writeFileSync(
    join(repo, 'README.md'),
    '# Проект\n\nАвторизация пользователей выполняется через модуль login.\n',
  );
  writeFileSync(join(repo, 'lib/login.ts'), 'export const login = () => 1;\n');
  writeFileSync(
    join(repo, 'rag/corpus.json'),
    JSON.stringify({ files: ['README.md', 'lib/login.ts'] }),
  );
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lock: 1\n');
  run('add', '.');
  run('commit', '-m', 'init');
  run('checkout', '-b', 'feature');
  writeFileSync(join(repo, 'lib/session.ts'), 'export const sessionLogin = 1;\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lock: 2\n');
  run('add', '.');
  run('commit', '-m', 'feature');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('lexical search', () => {
  it('splits identifiers and drops stop words', () => {
    expect(tokenize('getWeatherSummary для return')).toEqual([
      'get',
      'weather',
      'summary',
    ]);
  });

  it('chunks with line numbers and ranks by relevance', () => {
    const chunks = [
      ...chunkText('a.md', 'про погоду и прогноз\n'),
      ...chunkText('b.md', 'про git и ветки репозитория\n'),
    ];
    const hits = search(buildIndex(chunks), 'ветки git', { limit: 2 });
    expect(hits.map((hit) => hit.source)).toEqual(['b.md']);
    expect(hits[0]).toMatchObject({ startLine: 1, endLine: 1 });
  });

  it('can exclude sources', () => {
    const index = buildIndex(chunkText('a.md', 'git ветки\n'));
    expect(search(index, 'git', { exclude: ['a.md'] })).toEqual([]);
  });
});

describe('change collection', () => {
  it('returns changed files and skips lock files', async () => {
    const change = await collectChange('main', repo);
    expect(change.branch).toBe('feature');
    expect(change.files).toEqual([{ status: 'A', path: 'lib/session.ts' }]);
    expect(change.patch).toContain('+export const sessionLogin = 1;');
    expect(change.patch).not.toContain('pnpm-lock');
  });

  it('rejects option-like bases', async () => {
    await expect(collectChange('--output=x', repo)).rejects.toThrow();
  });

  it('trims long per-file diffs and omits what does not fit', () => {
    const patch = ['a', 'b', 'c']
      .map((name) => `diff --git a/${name} b/${name}\n${'x'.repeat(100)}\n`)
      .join('');
    const result = trimPatch(patch, { total: 230, perFile: 60 });
    expect(result.patch).toContain('обрезан');
    expect(result.omitted).toEqual(['c']);
  });
});

describe('review input and request', () => {
  it('retrieves docs for the change and builds the prompt', async () => {
    const change = await collectChange('main', repo);
    const context = await retrieveContext(change, repo);
    expect(context.map((hit: { source: string }) => hit.source)).toContain(
      'README.md',
    );
    const input = buildReviewInput(change, trimPatch(change.patch), context);
    expect(input).toContain('A\tlib/session.ts');
    expect(input).toContain('КОНТЕКСТ ПРОЕКТА');
    expect(input).toContain('[C1] README.md');
  });

  it('sends the key as a bearer token and parses the answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '## ок' }] },
        ],
      }),
    );
    await expect(
      callDeepSeek('diff', { apiKey: 'k', fetchImpl }),
    ).resolves.toBe('## ок');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.instructions).toContain('Потенциальные баги');
  });

  it('fails on upstream errors without leaking the key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    await expect(
      callDeepSeek('diff', { apiKey: 'secret', fetchImpl }),
    ).rejects.toThrow('HTTP 401');
  });

  it('marks the comment so that the workflow can update it', () => {
    const comment = formatComment('review', { files: [{}] }, [
      { source: 'README.md' },
    ]);
    expect(comment.startsWith(REVIEW_MARKER)).toBe(true);
    expect(comment).toContain('README.md');
  });

  it('requires an API key outside of dry-run', async () => {
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      await expect(main(['main'], {})).rejects.toThrow('DEEPSEEK_API_KEY');
    } finally {
      process.chdir(cwd);
    }
  });
});
