import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RAG_SEARCH } from '@/scripts/rag/relevance.mjs';
import { emptyComparison, type ComparisonAnswer } from '@/lib/rag-comparison';
import {
  COMPARISON_MODES,
  emptyUnified,
  latestLegacyComparison,
  migrateComparison,
  restoreUnified,
  runUnifiedComparison,
} from '@/lib/rag-unified-comparison';
import type { ChatRequest } from '@/lib/chat-types';

describe('Unified RAG comparison', () => {
  it('runs exactly 30 isolated requests across three modes, with Day 22 search independent of enhanced limits and a pinned index', async () => {
    const options = { ...DEFAULT_RAG_SEARCH, topKBefore: 30, topKAfter: 2 };
    const requests: ChatRequest[] = [];
    const done: ComparisonAnswer[] = [];
    await runUnifiedComparison({
      buildId: 'b1',
      suite: 'test',
      options,
      signal: new AbortController().signal,
      fetcher: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const retrieval = {
          build_id: 'b1',
          strategy: 'overlap',
          query: body.messages[0].content,
          ...(body.ragSearch
            ? {
                processing: {
                  options: body.ragSearch,
                  search_query: body.messages[0].content,
                  search_queries: [body.messages[0].content],
                  candidates: 1,
                  passed: 1,
                  verified: 1,
                  unique: 1,
                  evidence_model: 'local',
                  evidence_revision: 'v1',
                  reranker_model: 'reranker',
                  reranker_revision: 'v1',
                },
              }
            : {}),
          sources: [
            {
              id: 'S1',
              chunk_id: 'c1',
              source: 'README.md',
              title: 'Project',
              section: 'Title',
              start_line: 1,
              end_line: 2,
              score: 0.9,
              ...(body.ragSearch
                ? { rerank_score: 0.9, retrieval_rank: 1 }
                : {}),
              text: 'Exact supporting fact.',
              ...(body.ragSearch?.verifyEvidence
                ? {
                    evidence: [
                      {
                        quote: 'Exact supporting fact.',
                        question_part: body.messages[0].content,
                      },
                    ],
                  }
                : {}),
            },
          ],
        };
        return new Response(
          (body.useRag
            ? `event: rag\ndata: ${JSON.stringify({ retrieval })}\n\n`
            : '') +
            'event: delta\ndata: {"content":"Ответ"}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n',
        );
      }),
      onAnswer: (_id, _mode, answer) => {
        if (answer.status === 'done') done.push(answer);
      },
    });
    expect(requests).toHaveLength(30);
    expect(done).toHaveLength(30);
    for (let i = 0; i < requests.length; i += 3) {
      const [plain, raw, enhanced] = requests.slice(i, i + 3);
      expect(plain).toMatchObject({
        useRag: false,
        useMcpTools: false,
        temperature: 0,
      });
      expect(plain.ragBuildId).toBeUndefined();
      expect(plain.ragSearch).toBeUndefined();
      expect(raw).toMatchObject({
        useRag: true,
        ragBuildId: 'b1',
      });
      expect(raw.ragSearch).toBeUndefined();
      expect(raw.ragGrounding).toBeUndefined();
      expect(enhanced.ragGrounding).toBe(true);
      expect(enhanced.ragSearch).toEqual(options);
      expect(plain.messages).toHaveLength(1);
      expect(raw.messages).toEqual(plain.messages);
      expect(enhanced.messages).toEqual(plain.messages);
    }
  });
  it('cancels all three modes without starting the next question', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw new Error('stop');
    });
    await runUnifiedComparison({
      buildId: 'b1',
      suite: 'legacy',
      options: DEFAULT_RAG_SEARCH,
      signal: controller.signal,
      fetcher,
      onAnswer: () => {},
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('migrates the correct historical columns without inventing the third response', () => {
    const old = emptyComparison();
    old.rows[0].baseline = { status: 'done', answer: 'Без RAG', rag: null };
    const migrated = migrateComparison(old)!;
    expect(migrated.rows[0].plain.answer).toBe('Без RAG');
    expect(migrated.rows[0].enhanced.status).toBe('idle');
    const filtered = {
      ...emptyComparison('test'),
      options: DEFAULT_RAG_SEARCH,
    };
    filtered.rows[0].baseline = {
      status: 'stopped',
      answer: 'Обычный RAG',
      rag: null,
    };
    filtered.rows[0].rag = {
      status: 'stopped',
      answer: 'Обработанный RAG',
      rag: null,
    };
    const result = migrateComparison(filtered)!;
    expect(result.rows[0].plain.status).toBe('idle');
    expect(result.rows[0].rag.answer).toBe('');
    expect(result.rows[0].rag.error).toContain('другим пайплайном');
    expect(result.rows[0].enhanced.answer).toBe('Обработанный RAG');
    expect(restoreUnified(result)).toEqual(result);
  });
  it('migrates old processed baselines without losing other columns or relabeling old answers', () => {
    const options = {
      ...DEFAULT_RAG_SEARCH,
      topKAfter: 6,
      rerank: false,
      filter: false,
      rewrite: false,
      verifyEvidence: false,
      deduplicate: false,
    };
    const run = emptyUnified('legacy', options);
    run.buildId = 'b1';
    run.rows[0].plain = { status: 'done', answer: 'Без источников', rag: null };
    const retrieval = {
      build_id: 'b1',
      strategy: 'overlap' as const,
      query: 'Вопрос',
      processing: { options, search_query: 'Вопрос', candidates: 6, passed: 6 },
      sources: Array.from({ length: 6 }, (_, i) => ({
        id: `S${i + 1}`,
        chunk_id: `c${i}`,
        source: 'README.md',
        title: 'Title',
        section: 'Section',
        start_line: 1,
        end_line: 2,
        score: 0.8,
        text: 'Fact',
      })),
    };
    run.rows[0].rag = {
      status: 'done',
      answer: 'Старая середина',
      rag: retrieval,
    };
    run.rows[0].enhanced = {
      status: 'done',
      answer: 'Обработанный',
      rag: retrieval,
    };
    const restored = restoreUnified({ ...run, version: 2 })!;
    expect(restored.version).toBe(3);
    expect(restored.rows[0].plain).toEqual(run.rows[0].plain);
    expect(restored.rows[0].enhanced).toEqual(run.rows[0].enhanced);
    expect(restored.rows[0].rag.status).toBe('idle');
    expect(restored.rows[0].rag.answer).toBe('');
    expect(restored.rows[0].rag.error).toContain('новый прогон');
    expect(restoreUnified(restored)).toEqual(restored);
    expect(run.rows[0].rag.answer).toBe('Старая середина');
    expect(restoreUnified(run)).toBeNull();

    const day22 = emptyComparison();
    day22.buildId = 'b1';
    day22.rows[0].rag = {
      status: 'done',
      answer: 'Настоящий день 22',
      rag: {
        build_id: 'b1',
        strategy: 'overlap',
        query: 'Вопрос',
        sources: retrieval.sources.slice(0, 5),
      },
    };
    expect(migrateComparison(day22)!.rows[0].rag).toEqual(day22.rows[0].rag);
  });
  it('selects one recent legacy run without mixing questions or snapshots', () => {
    const first = {
      ...emptyComparison(),
      startedAt: '2026-10-01',
      buildId: 'b1',
    };
    const last = {
      ...emptyComparison('test'),
      options: DEFAULT_RAG_SEARCH,
      startedAt: '2026-10-04',
      buildId: 'b2',
    };
    expect(latestLegacyComparison([first, null, last])).toMatchObject({
      suite: 'test',
      buildId: 'b2',
    });
  });
  it('restores all three columns but never restarts pending work or trusts incompatible data', () => {
    const run = emptyUnified();
    for (const mode of COMPARISON_MODES)
      run.rows[0][mode] = {
        status: 'running',
        answer: 'Частичный ответ',
        rag: null,
      };
    const restored = restoreUnified(run)!;
    expect(
      COMPARISON_MODES.every(
        (mode) => restored.rows[0][mode].status === 'stopped',
      ),
    ).toBe(true);
    expect(restoreUnified({ ...run, controls: 'wrong' })).toBeNull();
    expect(restoreUnified({ ...run, rows: [] })).toBeNull();
    run.rows[1].enhanced = {
      status: 'done',
      answer: 'Без подтверждения RAG',
      rag: null,
    };
    expect(restoreUnified(run)).toBeNull();
  });
});
