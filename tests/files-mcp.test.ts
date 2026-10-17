import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import { FILES_DEFAULT_GOAL, parseFilesCommand } from '@/lib/files-command';
import {
  listFiles,
  readProjectFile,
  replaceInFile,
  resolveSafe,
  searchFiles,
  unifiedDiff,
  writeProjectFile,
} from '@/scripts/mcp-servers/files.mjs';

let root: string;
let outside: string;
const read = (path: string) => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'files-root-'));
  outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'lib/config.ts'), "export const servers = ['git', 'notes'];\nexport const port = 18805;\n");
  writeFileSync(join(root, 'lib/use.ts'), "import { servers } from './config';\nconsole.log(servers);\n");
  writeFileSync(join(root, 'README.md'), '# Проект\n\nСерверы: git.\n\n## Конец\n');
  writeFileSync(join(root, 'docs/guide.md'), 'Гайд\n');
  writeFileSync(join(root, '.env.local'), 'SECRET=1\n');
  writeFileSync(join(root, '.git/config'), 'secret\n');
  writeFileSync(join(root, 'node_modules/x.js'), 'servers\n');
  writeFileSync(join(outside, 'secret.md'), 'outside\n');
  symlinkSync(join(outside, 'secret.md'), join(root, 'docs/link.md'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
afterAll(() => vi.unstubAllEnvs());

describe('reading and searching', () => {
  it('lists text files and hides secrets, history and dependencies', async () => {
    const { files } = await listFiles(root);
    expect(files).toEqual(
      expect.arrayContaining(['README.md', 'docs/guide.md', 'lib/config.ts', 'lib/use.ts']),
    );
    expect(files.join()).not.toMatch(/\.env|\.git|node_modules|link\.md/u);
  });

  it('finds usages across several files with line numbers', async () => {
    const result = await searchFiles(root, 'servers');
    expect(
      result.matches.map((m: { file: string; line: number }) => `${m.file}:${m.line}`),
    ).toEqual(['lib/config.ts:1', 'lib/use.ts:1', 'lib/use.ts:2']);
    // «git» is in code and in documentation; the extension narrows the search.
    const files = (await searchFiles(root, 'git')).matches.map((m: { file: string }) => m.file);
    expect(new Set(files)).toEqual(new Set(['README.md', 'lib/config.ts']));
    expect(
      (await searchFiles(root, 'git', { extension: '.md' })).matches.map(
        (m: { file: string }) => m.file,
      ),
    ).toEqual(['README.md']);
  });

  it('reads a line range with numbers', async () => {
    const result = await readProjectFile(root, 'lib/config.ts', 2, 2);
    expect(result).toMatchObject({ from: 2, to: 2, totalLines: 2, content: '2: export const port = 18805;' });
  });

  it('blocks traversal, secrets, symlinks out of the root and non-text files', async () => {
    for (const path of ['../x.md', '/etc/passwd', '.env.local', '.git/config', 'node_modules/x.js']) {
      await expect(readProjectFile(root, path)).rejects.toThrow();
    }
    await expect(readProjectFile(root, 'docs/link.md')).rejects.toThrow('недоступен');
    await expect(resolveSafe(root, 'lib/../../x')).rejects.toThrow();
    await expect(readProjectFile(root, 'missing.md')).rejects.toThrow('не найден');
  });
});

describe('editing documentation', () => {
  it('replaces a unique fragment and returns the diff', async () => {
    const result = await replaceInFile(root, {
      path: 'README.md',
      search: 'Серверы: git.',
      replace: 'Серверы: git, notes.',
    });
    expect(result).toMatchObject({ applied: true, added: 1, removed: 1 });
    expect(result.diff).toContain('-Серверы: git.');
    expect(result.diff).toContain('+Серверы: git, notes.');
    expect(read('README.md')).toContain('Серверы: git, notes.');
  });

  it('dryRun shows the diff without touching the file', async () => {
    const before = read('README.md');
    const result = await replaceInFile(root, {
      path: 'README.md',
      search: '## Конец',
      replace: '## Конец\n\nНовое.',
      dryRun: true,
    });
    expect(result.applied).toBe(false);
    expect(result.diff).toContain('+Новое.');
    expect(read('README.md')).toBe(before);
  });

  it('refuses ambiguous or missing fragments', async () => {
    writeFileSync(join(root, 'docs/guide.md'), 'a\na\n');
    await expect(
      replaceInFile(root, { path: 'docs/guide.md', search: 'a', replace: 'b' }),
    ).rejects.toThrow('несколько раз');
    await expect(
      replaceInFile(root, { path: 'docs/guide.md', search: 'zzz', replace: 'b' }),
    ).rejects.toThrow('не найден');
  });

  it('creates a document, then needs overwrite to change it', async () => {
    const created = await writeProjectFile(root, {
      path: 'docs/adr/0001-lexical-search.md',
      content: '# ADR 0001\n\nСтатус: принято\n',
    });
    expect(created).toMatchObject({ created: true, applied: true, added: 3 });
    expect(read('docs/adr/0001-lexical-search.md')).toContain('Статус: принято');
    await expect(
      writeProjectFile(root, { path: 'docs/adr/0001-lexical-search.md', content: 'x' }),
    ).rejects.toThrow('overwrite');
    const changed = await writeProjectFile(root, {
      path: 'docs/adr/0001-lexical-search.md',
      content: '# ADR 0001\n\nСтатус: заменено\n',
      overwrite: true,
    });
    expect(changed).toMatchObject({ created: false, added: 1, removed: 1 });
  });

  it('writes only documentation, never code, config or secrets', async () => {
    for (const path of ['lib/config.ts', 'package.json', '.env.local', 'docs/../lib/use.ts', 'docs/x.ts', 'docs/link.md']) {
      await expect(writeProjectFile(root, { path, content: 'x', overwrite: true })).rejects.toThrow();
    }
    await expect(
      replaceInFile(root, { path: 'lib/config.ts', search: '18805', replace: '1' }),
    ).rejects.toThrow('Запись разрешена только');
    expect(read('lib/config.ts')).toContain('18805');
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('outside\n');
  });
});

describe('unified diff', () => {
  it('puts deletions before insertions and numbers hunks', () => {
    expect(unifiedDiff('a.md', 'a\nb\nc\n', 'a\nB\nc\nd\n')).toBe(
      ['--- a/a.md', '+++ b/a.md', '@@ -1,3 +1,4 @@', ' a', '-b', '+B', ' c', '+d'].join('\n'),
    );
    expect(unifiedDiff('a.md', 'same\n', 'same\n')).toBe('');
  });
});

describe('/files command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('turns the goal into a task for the assistant', () => {
    expect(parseFilesCommand('/files найди где используется get_weather')).toBe(
      'Цель: найди где используется get_weather',
    );
    expect(parseFilesCommand('/files')).toBe(`Цель: ${FILES_DEFAULT_GOAL}`);
    expect(parseFilesCommand('/filesystem')).toBeNull();
  });

  it('is not available to local Ollama agents', async () => {
    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '/files обнови README' }],
          model: 'ollama:qwen2.5:7b',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('local_tools_unsupported');
  });

  it('sends the goal with the file prompt and without RAG', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-secret');
    for (const name of ['CAPSULE', 'TRAVEL', 'NOTES', 'GIT', 'SUPPORT', 'FILES']) {
      vi.stubEnv(`MCP_${name}_URL`, 'not a url');
    }
    const sse =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1,"input_tokens":1}}}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '/files найди где используется get_weather' }],
          useRag: true,
          ragGrounding: true,
          useMcpTools: false,
          useSystemPrompt: false,
          targetOutputTokens: 500,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.instructions).toContain('Команда /files');
    // The default 500-token target would cut tool-driven answers short.
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(8000);
    expect(JSON.stringify(body.input)).toContain('Цель: найди где используется get_weather');
    expect(JSON.stringify(body.input)).not.toContain('RAG_CONTEXT');
  });
});
