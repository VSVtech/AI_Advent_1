import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrieveCandidates } from '@/scripts/rag/retrieval.mjs';
import {
  DEFAULT_RAG_SEARCH,
  isRagSearchOptions,
} from '@/scripts/rag/relevance.mjs';
import { selectThreshold } from '@/scripts/rag/benchmark.mjs';
import { LocalRewriter } from '@/scripts/rag/models.mjs';
import { restoreRagRetrieval } from '@/lib/rag-context';
import { retrieveRagContext } from '@/lib/server/rag';
import {
  comparisonControl,
  importComparisonReport,
  emptyComparison,
  restoreComparison,
  runComparison,
} from '@/lib/rag-comparison';

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const options = {
  ...DEFAULT_RAG_SEARCH,
  verifyEvidence: false,
  deduplicate: false,
  topKBefore: 3,
  topKAfter: 2,
  minRerankScore: 0.5,
};
function fixture() {
  const chunks = [
    [1, 0],
    [0.8, 0.6],
    [0, 1],
  ].map((embedding, i) => ({
    chunk_id: `c${i}`,
    source: 'README.md',
    title: 'Project',
    section: 'Storage',
    start_line: 1,
    end_line: 3,
    text: `Fragment ${i}`,
    embedding,
  }));
  const provider = {
    embed: vi.fn(async (queries: string[]) =>
      queries.map((q) => (q === 'rewritten' ? [0, 1] : [1, 0])),
    ),
  };
  const rewriter = {
    rewrite: vi.fn(async () => ({
      query: 'rewritten',
      identity: { model: 'rewrite-test' },
      fallback: null,
    })),
  };
  const reranker = {
    score: vi.fn(async (_q: string, docs: string[]) =>
      docs.map((doc): number => (doc.includes('Fragment 2') ? 0.9 : 0.1)),
    ),
    describe: () => ({ model: 'test-reranker', revision: 'v1' }),
  };
  return {
    index: { manifest: { dimensions: 2 }, chunks },
    provider,
    rewriter,
    reranker,
    query: 'original',
    options,
    signal: signal(),
  };
}

describe('Two-stage retrieval', () => {
  it('keeps original query, deduplicates candidates and promotes low-similarity evidence', async () => {
    const dependencies = fixture();
    const result = await retrieveCandidates(dependencies);
    expect(dependencies.provider.embed).toHaveBeenCalledWith(
      ['original', 'rewritten'],
      'query',
    );
    expect(dependencies.reranker.score.mock.calls[0][0]).toBe('original');
    expect(new Set(result.ranked.map((h) => h.chunk_id)).size).toBe(3);
    expect(result.hits.map((h) => h.chunk_id)).toEqual(['c2']);
    expect(result.hits[0].rerank_score).toBe(0.9);
    expect(result.processing).toMatchObject({
      candidates: 3,
      passed: 1,
      search_queries: ['original', 'rewritten'],
      reranker_model: 'test-reranker',
    });
  });
  it('uses rerank threshold instead of cosine and applies top-K after it', async () => {
    const d = fixture();
    const result = await retrieveCandidates({
      ...d,
      options: {
        ...options,
        rewrite: false,
        minSimilarity: 0.99,
        topKAfter: 1,
      },
    });
    expect(result.hits[0]).toMatchObject({
      chunk_id: 'c2',
      score: 0,
      rerank_score: 0.9,
      retrieval_rank: 3,
    });
    expect(d.rewriter.rewrite).not.toHaveBeenCalled();
    const raw = await retrieveCandidates({
      ...d,
      options: { ...options, rerank: false, rewrite: false, filter: false },
    });
    expect(raw.hits.map((h) => h.chunk_id)).toEqual(['c0', 'c1']);
  });
  it('retains original retrieval and records rewrite failure', async () => {
    const d = fixture();
    const fallback = {
      rewrite: async (query: string) => ({
        query,
        identity: null,
        fallback: 'Model unavailable',
      }),
    };
    const result = await retrieveCandidates({ ...d, rewriter: fallback });
    expect(d.provider.embed).toHaveBeenCalledWith(['original'], 'query');
    expect(result.processing.rewrite_fallback).toBe('Model unavailable');
    const rewriter = new LocalRewriter();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await rewriter.rewrite('question', signal())).toMatchObject({
      query: 'question',
      fallback: 'offline',
    });
  });
  it('represents empty filtered results and never falls back after reranker failure', async () => {
    const d = fixture();
    const empty = await retrieveCandidates({
      ...d,
      options: { ...options, minRerankScore: 1 },
    });
    expect(empty.hits).toEqual([]);
    expect(empty.processing.passed).toBe(0);
    d.reranker.score.mockRejectedValueOnce(new Error('missing weights'));
    await expect(retrieveCandidates(d)).rejects.toThrow('missing weights');
  });
  it('rejects invalid scores and cancellation', async () => {
    const d = fixture();
    d.reranker.score.mockResolvedValueOnce([NaN, 0.3, 0.5]);
    await expect(retrieveCandidates(d)).rejects.toThrow('оценки');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      retrieveCandidates({ ...d, signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(isRagSearchOptions({ ...options, minRerankScore: undefined })).toBe(
      false,
    );
    expect(isRagSearchOptions({ ...options, minRerankScore: -0.1 })).toBe(
      false,
    );
  });
  it('round-trips advanced metadata through server and history, rejecting lost model identity', async () => {
    const result = await retrieveCandidates(fixture());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ build_id: 'b1', ...result })),
    );
    const retrieval = await retrieveRagContext(
      [{ role: 'user', content: 'original' }],
      signal(),
      'b1',
      options,
    );
    expect(restoreRagRetrieval(retrieval)).toEqual(retrieval);
    expect(retrieval.sources[0].rerank_score).toBe(0.9);
    expect(
      restoreRagRetrieval({
        ...retrieval,
        processing: { ...retrieval.processing, reranker_revision: null },
      }),
    ).toBeNull();
    expect(
      restoreRagRetrieval({
        ...retrieval,
        sources: [{ ...retrieval.sources[0], rerank_score: 0.1 }],
      }),
    ).toBeNull();
  });
});

describe('Evaluation split and baseline', () => {
  it('calibrates only dev and protects positive recall before rejecting negatives', () => {
    const rows = [
      {
        split: 'dev',
        answerable: true,
        evidence_count: 1,
        candidates: [{ rerank_score: 0.3, relevant: true, evidence: [0] }],
      },
      {
        split: 'dev',
        answerable: false,
        evidence_count: 0,
        candidates: [{ rerank_score: 0.01, relevant: false, evidence: [] }],
      },
    ];
    expect(selectThreshold(rows, 5).threshold).toBe(0.02);
    expect(() => selectThreshold([{ ...rows[0], split: 'test' }], 5)).toThrow(
      'только dev',
    );
  });
  it('keeps legacy questions and does not restore an answer under the wrong suite', () => {
    for (const suite of ['legacy', 'dev', 'test'] as const) {
      expect(comparisonControl(suite).questions).toHaveLength(10);
      expect(restoreComparison(emptyComparison(suite))).toEqual(
        emptyComparison(suite),
      );
    }
    expect(
      restoreComparison({ ...emptyComparison('dev'), suite: 'test' }),
    ).toBeNull();
  });
  it('imports both RAG modes from an enhanced CLI report with its actual settings', async () => {
    const result = await retrieveCandidates(fixture());
    const rag = {
      build_id: 'b1',
      strategy: 'overlap',
      query: 'original',
      processing: result.processing,
      sources: result.hits.map((h, i) => ({ ...h, id: `S${i + 1}` })),
    };
    const baseline = {
      ...rag,
      processing: {
        ...rag.processing,
        options: { ...options, filter: false, rewrite: false, rerank: false },
        passed: 3,
      },
    };
    const report = {
      suite: 'test',
      options,
      build_id: 'b1',
      created_at: '2026-10-04T00:00:00Z',
      rows: comparisonControl('test').questions.map((q) => ({
        ...q,
        baseline: { answer: 'Ответ', rag: baseline },
        rag: { answer: 'Ответ с обработкой', rag },
      })),
    };
    expect(importComparisonReport(report)).toMatchObject({
      suite: 'test',
      options,
    });
    expect(
      importComparisonReport({ ...report, options: undefined }),
    ).toBeNull();
  });
  it('uses the Day 22 search path in baseline for every test question', async () => {
    const requests: { ragSearch: typeof options; messages: unknown[] }[] = [];
    await runComparison({
      buildId: 'b1',
      suite: 'test',
      options,
      signal: signal(),
      onAnswer: () => {},
      fetcher: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init!.body)));
        return Response.json(
          { error: 'mock: skip generation' },
          { status: 503 },
        );
      }),
    });
    expect(requests).toHaveLength(20);
    requests.forEach((body, i) => {
      if (i % 2) expect(body.ragSearch).toEqual(options);
      else expect(body.ragSearch).toBeUndefined();
      expect(body.messages).toHaveLength(1);
    });
  });
});
