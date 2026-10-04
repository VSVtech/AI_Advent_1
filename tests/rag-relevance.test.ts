import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterCandidates,
  isRagSearchOptions,
  rewriteQuery,
} from '@/scripts/rag/relevance.mjs';
import { restoreRagRetrieval, withRagContext } from '@/lib/rag-context';
import { retrieveRagContext } from '@/lib/server/rag';
import type { ChatRequest } from '@/lib/chat-types';
import { POST } from '@/app/api/chat/route';
import {
  runComparison,
  emptyComparison,
  restoreComparison,
} from '@/lib/rag-comparison';

afterEach(() => vi.unstubAllGlobals());
const options = {
  rewrite: true,
  filter: true,
  topKBefore: 12,
  topKAfter: 5,
  minSimilarity: 0.55,
};
const hit = (score: number, id = 'c1') => ({
  score,
  chunk_id: id,
  source: 'README.md',
  title: 'Project',
  section: 'Memory',
  start_line: 1,
  end_line: 3,
  text: 'Storage details',
});
const query = 'Пожалуйста, подскажи, как MCP не вызывает tool_x?';
const messages = [{ role: 'user' as const, content: query }];
const signal = () => new AbortController().signal;

describe('Day 23 relevance', () => {
  it('rewrites locally while preserving negation and exact identifiers', () => {
    const rewritten = rewriteQuery(query);
    expect(rewritten).not.toContain('Пожалуйста');
    expect(rewritten).toContain('MCP не вызывает tool_x?');
    expect(rewritten).toContain('Model Context Protocol');
    const long = 'MCP ' + 'x'.repeat(1996);
    expect(rewriteQuery(long)).toBe(long);
    expect(rewriteQuery('Не используй PostgreSQL')).toBe(
      'Не используй PostgreSQL',
    );
  });
  it.each([
    { topKBefore: 0 },
    { topKAfter: 51 },
    { topKBefore: 2, topKAfter: 3 },
    { minSimilarity: NaN },
    { minSimilarity: 1.01 },
    { rewrite: 'true' },
  ])('rejects invalid bounds %j', (bad) => {
    expect(isRagSearchOptions({ ...options, ...bad })).toBe(false);
  });
  it('applies inclusive threshold then top-K without mutating candidates', () => {
    const hits = [hit(0.5, 'low'), hit(0.9, 'high'), hit(0.55, 'boundary')];
    expect(
      filterCandidates(hits, { ...options, topKBefore: 3, topKAfter: 1 }),
    ).toEqual({ hits: [hits[1]], candidates: 3, passed: 2 });
    expect(hits[0].chunk_id).toBe('low');
    expect(
      filterCandidates(hits, {
        ...options,
        filter: false,
        topKBefore: 3,
        topKAfter: 3,
      }).hits,
    ).toHaveLength(3);
  });
  it('searches rewritten text with candidate K, returns filtered metadata and preserves the original LLM question', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ build_id: 'b1', hits: [hit(0.9), hit(0.54, 'low')] }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await retrieveRagContext(messages, signal(), 'b1', options);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: rewriteQuery(query),
      top_k: 12,
      build_id: 'b1',
    });
    expect(result.processing).toMatchObject({ candidates: 2, passed: 1 });
    expect(result.sources.map((source) => source.chunk_id)).toEqual(['c1']);
    expect(withRagContext(messages, result).at(-1)).toEqual(messages[0]);
    expect(restoreRagRetrieval(result)).toEqual(result);
  });
  it('represents no relevant results explicitly and restores it without false sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ build_id: 'b1', hits: [hit(0.1)] })),
    );
    const result = await retrieveRagContext(messages, signal(), 'b1', options);
    expect(result.sources).toEqual([]);
    expect(result.processing?.passed).toBe(0);
    expect(restoreRagRetrieval(result)).toEqual(result);
    expect(
      restoreRagRetrieval({ ...result, processing: undefined }),
    ).toBeNull();
    expect(
      restoreRagRetrieval({
        ...result,
        processing: { ...result.processing, passed: 1 },
      }),
    ).toBeNull();
  });
  it('does not hide malformed low-score sources by dropping them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          build_id: 'b1',
          hits: [{ ...hit(0.1), text: null }],
        }),
      ),
    );
    await expect(
      retrieveRagContext(messages, signal(), 'b1', options),
    ).rejects.toThrow('Кандидаты');
  });
  it('rejects invalid options at the API boundary before searching or generating', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          useRag: true,
          ragSearch: { ...options, topKAfter: 99 },
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('compares Day 22 retrieval with configurable processing on a fixed snapshot', async () => {
    const bodies: ChatRequest[] = [];
    const done: string[] = [];
    await runComparison({
      buildId: 'b1',
      signal: signal(),
      options,
      fetcher: vi.fn(async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        bodies.push(body);
        const retrieval = {
          build_id: 'b1',
          strategy: 'overlap',
          query,
          sources: [{ ...hit(0.9), id: 'S1' }],
          ...(body.ragSearch
            ? {
                processing: {
                  options: body.ragSearch,
                  search_query: query,
                  candidates: 1,
                  passed: 1,
                },
              }
            : {}),
        };
        return new Response(
          `event: rag\ndata: ${JSON.stringify({ retrieval })}\n\nevent: delta\ndata: {"content":"Ответ"}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n`,
        );
      }),
      onAnswer: (id, mode, answer) => {
        if (answer.status === 'done') done.push(id + mode);
      },
    });
    expect(done).toHaveLength(20);
    expect(
      bodies.every((body) => body.useRag && body.ragBuildId === 'b1'),
    ).toBe(true);
    expect(bodies[0].ragSearch).toBeUndefined();
    expect(bodies[1].ragSearch).toEqual(options);
    const run = { ...emptyComparison(), options };
    expect(restoreComparison(run)?.options).toEqual(options);
  });
});
