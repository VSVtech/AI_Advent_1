import { afterEach, describe, expect, it, vi } from 'vitest';
import { expandQuery, LocalRewriter } from '@/scripts/rag/models.mjs';
import {
  deduplicateHits,
  evidencePassages,
  selectedEvidence,
  validateEvidence,
} from '@/scripts/rag/evidence.mjs';
import { retrieveCandidates } from '@/scripts/rag/retrieval.mjs';
import { DEFAULT_RAG_SEARCH } from '@/scripts/rag/relevance.mjs';
import { restoreRagRetrieval } from '@/lib/rag-context';
import { retrieveRagContext } from '@/lib/server/rag';

afterEach(() => vi.unstubAllGlobals());
const query = 'Какой метод снимает подписку удалённого агента?';
const quote = 'dispose() снимает подписку агента.';
const evidence = [{ quote, question_part: query }];
function fixture() {
  const texts = ['Импорт dispose не объясняет реализацию.', quote, quote];
  return {
    query,
    index: {
      manifest: { dimensions: 2 },
      chunks: texts.map((text, i) => ({
        chunk_id: `c${i}`,
        source: 'agent.ts',
        title: 'Agent',
        section: 'Cleanup',
        start_line: i + 1,
        end_line: i + 1,
        text,
        embedding: [1, 0],
      })),
    },
    options: {
      ...DEFAULT_RAG_SEARCH,
      rewrite: false,
      topKBefore: 3,
      topKAfter: 1,
    },
    provider: { embed: async () => [[1, 0]] },
    rewriter: { rewrite: vi.fn() },
    reranker: {
      score: async () => [0.99, 0.9, 0.8],
      describe: () => ({ model: 'cross', revision: 'v1' }),
    },
    verifier: {
      verify: vi.fn(
        async (_query: string, _hits: unknown[], _signal: AbortSignal) => ({
          evidence: [[], evidence, evidence],
          identity: { model: 'local', digest: 'v1' },
        }),
      ),
    },
    signal: new AbortController().signal,
  };
}

describe('Evidence selection', () => {
  it('preserves the full original query, language, negations and numbers', () => {
    const original = 'Не удаляй 42 агента: удалённый агент подписан на память?';
    expect(expandQuery(original, { phrases: ['удалённый агент'] })).toBe(
      `${original}\nудалённый агент`,
    );
    expect(() =>
      expandQuery(original, { phrases: ['remote agent'] }),
    ).toThrow();
    expect(expandQuery('x'.repeat(2000), { phrases: ['xxx'] })).toHaveLength(
      2000,
    );
  });
  it('falls back to the original on an invalid generated rewrite', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            models: [{ name: 'qwen2.5:1.5b', digest: crypto.randomUUID() }],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            message: { content: JSON.stringify({ phrases: ['remote agent'] }) },
          }),
        ),
    );
    expect(
      await new LocalRewriter().rewrite(query, new AbortController().signal),
    ).toMatchObject({ query, fallback: expect.any(String) });
  });
  it('selects literal paragraphs and rejects invented quotes or passage IDs', () => {
    const text = `Здесь только импорт.\n\n${quote}`;
    expect(
      selectedEvidence(query, evidencePassages(text), {
        evidence: [
          { passage_id: 2, question_part_id: 1 },
          { passage_id: 2, question_part_id: 1 },
        ],
      }),
    ).toEqual(evidence);
    expect(() =>
      selectedEvidence(query, [quote], {
        evidence: [{ passage_id: 2, question_part_id: 1 }],
      }),
    ).toThrow();
    expect(
      validateEvidence(query, text, {
        evidence: [
          { quote: 'dispose() удаляет все данные.', question_part: query },
        ],
      }),
    ).toEqual([]);
  });
  it('binds literal quotes to the specific part of a compound question', () => {
    const question = 'Где память? Как снять подписку?';
    expect(
      selectedEvidence(question, [quote], {
        evidence: [{ passage_id: 1, question_part_id: 2 }],
      }),
    ).toEqual([{ quote, question_part: 'Как снять подписку?' }]);
    expect(() =>
      selectedEvidence(question, [quote], {
        evidence: [{ passage_id: 1, question_part_id: 3 }],
      }),
    ).toThrow();
  });
  it('checks beyond top-K, removes duplicates, and does not backfill rejected chunks', async () => {
    const d = fixture();
    const result = await retrieveCandidates(d);
    expect(d.verifier.verify.mock.calls[0][1]).toHaveLength(3);
    expect(result.hits.map((h) => h.chunk_id)).toEqual(['c1']);
    expect(result.processing).toMatchObject({
      candidates: 3,
      passed: 3,
      verified: 2,
      unique: 1,
    });
  });
  it('preserves complementary evidence, different numeric values and negations', () => {
    const make = (text: string) => ({
      text,
      evidence: [{ quote: text, question_part: query }],
    });
    const hits = [
      make('Лимит равен 5 вызовам.'),
      make('Лимит равен 10 вызовам.'),
      make('Лимит не равен 5 вызовам.'),
      make('Лимит равен 5 вызовам.'),
    ];
    expect(deduplicateHits(hits)).toEqual(hits.slice(0, 3));
    expect(
      deduplicateHits([
        { text: 'first', evidence },
        { text: 'second', evidence },
      ]),
    ).toHaveLength(1);
  });
  it('round-trips evidence and counters, rejects forged quotes and inconsistent counts', async () => {
    const d = fixture();
    const result = await retrieveCandidates(d);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ build_id: 'b1', ...result })),
    );
    const restored = await retrieveRagContext(
      [{ role: 'user', content: query }],
      d.signal,
      'b1',
      d.options,
    );
    expect(restored.sources[0].evidence).toEqual(evidence);
    expect(restoreRagRetrieval(restored)).toEqual(restored);
    expect(
      restoreRagRetrieval({
        ...restored,
        sources: [
          {
            ...restored.sources[0],
            evidence: [
              { quote: 'Invented fact about dispose.', question_part: query },
            ],
          },
        ],
      }),
    ).toBeNull();
    expect(
      restoreRagRetrieval({
        ...restored,
        processing: { ...restored.processing, verified: 4 },
      }),
    ).toBeNull();
  });
  it('allows empty evidence even with similarity filtering off, and propagates verifier failure', async () => {
    const d = fixture();
    d.options.filter = false;
    d.verifier.verify.mockResolvedValueOnce({
      evidence: [[], [], []],
      identity: { model: 'local', digest: 'v1' },
    });
    const result = await retrieveCandidates(d);
    expect(
      restoreRagRetrieval({
        build_id: 'b1',
        strategy: 'overlap',
        query,
        sources: [],
        processing: result.processing,
      }),
    ).not.toBeNull();
    d.verifier.verify.mockRejectedValueOnce(new Error('offline'));
    await expect(retrieveCandidates(d)).rejects.toThrow('offline');
    d.verifier.verify.mockResolvedValueOnce({
      evidence: [],
      identity: { model: 'local', digest: 'v1' },
    });
    await expect(retrieveCandidates(d)).rejects.toThrow('число');
  });
  it('does not call verifier when disabled, and respects cancellation after verification', async () => {
    const d = fixture();
    await retrieveCandidates({
      ...d,
      options: { ...d.options, verifyEvidence: false },
    });
    expect(d.verifier.verify).not.toHaveBeenCalled();
    const controller = new AbortController();
    d.verifier.verify.mockImplementationOnce(async () => {
      controller.abort(new Error('stop'));
      return {
        evidence: [[], evidence, evidence],
        identity: { model: 'local', digest: 'v1' },
      };
    });
    await expect(
      retrieveCandidates({ ...d, signal: controller.signal }),
    ).rejects.toThrow('stop');
  });
});
