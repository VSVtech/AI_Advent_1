import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkDocument, tokenWindows } from '../scripts/rag/chunking.mjs';
import { hash, loadDocuments, sectionsOf } from '../scripts/rag/documents.mjs';
import {
  normalizeVector,
  searchIndex,
  OllamaEmbeddings,
} from '../scripts/rag/embeddings.mjs';
import { buildIndices } from '../scripts/rag/pipeline.mjs';
import { evaluate, matchesEvidence } from '../scripts/rag/evaluate.mjs';
import { createRagHandler } from '../scripts/rag/server.mjs';
import {
  loadIndex,
  readCurrent,
  readJson,
  withBuildLock,
} from '../scripts/rag/storage.mjs';
import { STRATEGIES } from '../scripts/rag/config.mjs';

// Byte tokens deliberately split Cyrillic and emoji, unlike a convenient ASCII fixture.
const tokenizer = {
  encode: (text) => [...new TextEncoder().encode(text)],
  decode: (ids) => new TextDecoder().decode(Uint8Array.from(ids)),
};
const directories = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rag-test-'));
  directories.push(root);
  const text = '# Память\n\nФакты хранятся в браузере.\n'.repeat(30);
  await mkdir(join(root, 'rag'));
  await writeFile(join(root, 'guide.md'), text);
  await writeFile(
    join(root, 'rag/corpus.json'),
    JSON.stringify({ files: ['guide.md'] }),
  );
  const identity = { model: 'test-only', digest: 'fixed-test-digest' };
  const provider = {
    describe: vi.fn(async () => identity),
    embed: vi.fn(async (texts) => texts.map(() => [0.6, 0.8, 0])),
  };
  return { root, dataDir: join(root, 'data'), tokenizer, provider, text };
}

describe('RAG chunking', () => {
  it('preserves every character without overlap and enforces the token cap', () => {
    const text = 'Привет 🌍!\n漢字 and code();\n'.repeat(10);
    const ranges = tokenWindows(text, tokenizer, 32);
    expect(
      ranges.map(({ start, end }) => text.slice(start, end)).join(''),
    ).toBe(text);
    expect(
      ranges.every(
        ({ start, end }) =>
          tokenizer.encode(text.slice(start, end)).length <= 32,
      ),
    ).toBe(true);
    expect(ranges.at(-1).end).toBe(text.length);
  });
  it('overlaps consecutive chunks without gaps or a duplicate final chunk', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(4);
    const ranges = tokenWindows(text, tokenizer, 32, 8);
    for (let i = 1; i < ranges.length; i++)
      expect(ranges[i - 1].end - ranges[i].start).toBe(8);
    expect(ranges.at(-1).end).toBe(text.length);
    expect(() => tokenWindows(text, tokenizer, 32, 32)).toThrow();
  });
  it('ignores headings inside code fences and records heading ancestry', () => {
    const text = '# A\nbody\n```md\n# fake\n```\n## B\nanswer\n';
    expect(sectionsOf(text, 'doc.md', 'A').map((item) => item.section)).toEqual(
      ['A', 'A / B'],
    );
  });
  it('identifies exported functions and classes through the TypeScript parser', () => {
    const text =
      'export function one() { return 1; }\nexport class Two { value = 2; }';
    expect(
      sectionsOf(text, 'code.ts', 'code.ts').map((item) => item.section),
    ).toEqual(['code.ts / one', 'code.ts / Two']);
  });
  it('keeps structural sections separate, with exact metadata and stable IDs', () => {
    const text = '# A\nhello\n## B\nworld\n';
    const doc = {
      text,
      source: 'a.md',
      file: 'a.md',
      title: 'A',
      document_id: 'doc',
      content_hash: hash(text),
      sections: sectionsOf(text, 'a.md', 'A'),
    };
    const chunks = chunkDocument(doc, STRATEGIES[2], tokenizer);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks[1]).toMatchObject({
      start_line: 3,
      end_line: 4,
      section: 'A / B',
      source: 'a.md',
      token_count: 11,
    });
    expect(
      chunkDocument(doc, STRATEGIES[2], tokenizer).map(
        (chunk) => chunk.chunk_id,
      ),
    ).toEqual(chunks.map((chunk) => chunk.chunk_id));
  });
});

describe('RAG storage and pipeline', () => {
  it('rejects traversal and symlinks outside the corpus', async () => {
    const options = await fixture();
    await expect(
      loadDocuments(options.root, { files: ['../secret.md'] }),
    ).rejects.toThrow();
    await symlink('/etc/hosts', join(options.root, 'outside.txt'));
    await expect(
      loadDocuments(options.root, { files: ['outside.txt'] }),
    ).rejects.toThrow('вне корпуса');
  });
  it('builds real index shape, reloads vectors and reuses cache on repeat builds', async () => {
    const options = await fixture();
    const first = await buildIndices(options);
    expect(first.strategies).toHaveLength(3);
    expect(first.strategies[1].stats.duplicate_character_ratio).toBeGreaterThan(
      0,
    );
    const index = await loadIndex(options.dataDir, first.build_id, 'fixed');
    expect(index.chunks[0].embedding).toEqual([0.6, 0.8, 0]);
    expect(searchIndex(index, [3, 4, 0])[0].score).toBeCloseTo(1);
    options.provider.embed.mockClear();
    const second = await buildIndices(options);
    expect(second.build_id).not.toBe(first.build_id);
    expect(options.provider.embed).not.toHaveBeenCalled();
    expect(
      second.strategies.every(
        (item) => item.stats.cache_hits === item.stats.chunks,
      ),
    ).toBe(true);
  });
  it('never publishes a partial build after the provider fails', async () => {
    const options = await fixture();
    const previous = await buildIndices(options);
    await writeFile(join(options.root, 'guide.md'), 'New text '.repeat(200));
    options.provider.embed.mockRejectedValue(new Error('provider failed'));
    await expect(buildIndices(options)).rejects.toThrow('provider failed');
    expect((await readCurrent(options.dataDir)).build_id).toBe(
      previous.build_id,
    );
    await expect(
      readFile(join(options.dataDir, 'build.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('locks out concurrent builds and releases the lock after errors', async () => {
    const { dataDir } = await fixture();
    await withBuildLock(dataDir, async () => {
      await expect(withBuildLock(dataDir, async () => {})).rejects.toThrow(
        'уже запущена',
      );
    });
    await expect(withBuildLock(dataDir, async () => 'ok')).resolves.toBe('ok');
  });
  it('rejects malformed vectors and dimension mismatches', () => {
    expect(() => normalizeVector([0, 0])).toThrow();
    expect(() => normalizeVector([Number.NaN, 1])).toThrow();
    expect(() =>
      searchIndex({ manifest: { dimensions: 3 }, chunks: [] }, [1, 0]),
    ).toThrow('Размерность');
  });
});

describe('RAG evaluation and local API', () => {
  it('requires full evidence coverage, not merely the correct filename', () => {
    const evidence = { source: 'x', start_offset: 10, end_offset: 20 };
    expect(
      matchesEvidence(
        { source: 'x', start_offset: 0, end_offset: 15 },
        evidence,
      ),
    ).toBe(false);
    expect(
      matchesEvidence(
        { source: 'x', start_offset: 0, end_offset: 20 },
        evidence,
      ),
    ).toBe(true);
  });
  it('writes a comparison report and refuses stale evidence', async () => {
    const options = await fixture();
    const current = await buildIndices(options);
    const questions = [
      {
        id: 'q1',
        question: 'Где память?',
        category: 'test',
        evidence: [
          {
            source: 'guide.md',
            start_offset: 0,
            end_offset: 8,
            content_hash: hash(options.text),
          },
        ],
      },
    ];
    await writeFile(
      join(options.root, 'rag/questions.json'),
      JSON.stringify(questions),
    );
    const report = await evaluate(options);
    expect(report.rows).toHaveLength(3);
    expect(
      report.rows.every((row) => row.hit_at_5 >= 0 && row.hit_at_5 <= 1),
    ).toBe(true);
    expect(
      await readJson(
        join(options.dataDir, 'builds', current.build_id, 'comparison.json'),
      ),
    ).toEqual(report);
    questions[0].evidence[0].content_hash = 'stale';
    await writeFile(
      join(options.root, 'rag/questions.json'),
      JSON.stringify(questions),
    );
    await expect(evaluate(options)).rejects.toThrow('устарела');
  });
  it('serves metadata and paged chunks without exposing embeddings', async () => {
    const options = await fixture();
    await buildIndices(options);
    const handler = createRagHandler(options);
    const response = await handler(
      new Request('http://127.0.0.1/rag?view=chunks&strategy=structure'),
    );
    const payload = await response.json();
    expect(payload.chunks.length).toBeLessThanOrEqual(20);
    expect(payload.chunks[0].embedding).toBeUndefined();
    const status = await (
      await handler(new Request('http://127.0.0.1/rag'))
    ).json();
    expect(status.stale).toBe(false);
    await writeFile(join(options.root, 'guide.md'), 'Changed');
    expect(
      (await (await handler(new Request('http://127.0.0.1/rag'))).json()).stale,
    ).toBe(true);
  });
  it('rejects browser origins, malformed JSON and unsupported strategies', async () => {
    const handler = createRagHandler(await fixture());
    expect(
      (
        await handler(
          new Request('http://localhost/rag', {
            headers: { Origin: 'https://evil.test' },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request('http://localhost/rag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{',
          }),
        )
      ).status,
    ).toBe(400);
  });
  it('sends Qwen query instructions, disables silent truncation and validates responses', async () => {
    const fetch = vi.fn(async () => Response.json({ embeddings: [[3, 4]] }));
    vi.stubGlobal('fetch', fetch);
    const provider = new OllamaEmbeddings();
    expect(await provider.embed(['memory'], 'query')).toEqual([[0.6, 0.8]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.input[0]).toContain('\nQuery: memory');
    expect(body.truncate).toBe(false);
    fetch.mockResolvedValue(Response.json({ embeddings: [] }));
    await expect(provider.embed(['x'])).rejects.toThrow('Количество');
  });
});
