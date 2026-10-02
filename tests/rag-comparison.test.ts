import { describe, expect, it, vi } from 'vitest';
import {
  emptyComparison,
  importComparisonReport,
  restoreComparison,
  runComparison,
  type ComparisonAnswer,
} from '@/lib/rag-comparison';
import control from '@/rag/answer-questions.json';

const retrieval = {
  build_id: 'snapshot-1',
  strategy: 'overlap',
  query: 'question',
  sources: [
    {
      id: 'S1',
      chunk_id: 'chunk-1',
      source: 'README.md',
      title: 'Readme',
      section: 'Sessions',
      start_line: 1,
      end_line: 3,
      score: 0.8,
      text: 'Session facts.',
    },
  ],
};
function response(
  rag: boolean,
  options: { build?: string; empty?: boolean; finish?: boolean } = {},
) {
  const event = (name: string, data: object) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    (rag
      ? event('rag', {
          retrieval: {
            ...retrieval,
            build_id: options.build ?? retrieval.build_id,
          },
        })
      : '') +
      event('delta', { content: options.empty ? '' : 'Проверенный ответ' }) +
      (options.finish === false ? '' : event('done', { finishReason: 'stop' })),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('RAG comparison table runner', () => {
  it('makes 20 isolated requests, pins RAG version and publishes each answer', async () => {
    const requests: Record<string, unknown>[] = [];
    const done: ComparisonAnswer[] = [];
    let active = 0;
    let peak = 0;
    await runComparison({
      buildId: 'snapshot-1',
      signal: new AbortController().signal,
      fetcher: vi.fn(async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return response(body.useRag);
      }),
      onAnswer: (_id, _mode, answer) => {
        if (answer.status === 'done') done.push(answer);
      },
    });
    expect(requests).toHaveLength(20);
    expect(done).toHaveLength(20);
    expect(peak).toBe(2);
    requests.forEach((body, index) => {
      expect(body.messages).toEqual([
        {
          role: 'user',
          content: control.questions[Math.floor(index / 2)].question,
        },
      ]);
      expect(body.ragBuildId).toBe(body.useRag ? 'snapshot-1' : undefined);
      expect(body.useMcpTools).toBe(false);
      expect(body.temperature).toBe(0);
      expect(body).not.toHaveProperty('expected');
    });
  });

  it('retains completed answers, continues after a failure and rejects mismatched provenance', async () => {
    const final = new Map<string, ComparisonAnswer>();
    let index = 0;
    await runComparison({
      buildId: 'snapshot-1',
      signal: new AbortController().signal,
      fetcher: vi.fn(async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        index++;
        if (index === 1)
          return Response.json(
            { error: { message: 'API offline' } },
            { status: 503 },
          );
        return response(body.useRag, {
          build: index === 2 ? 'wrong-version' : undefined,
        });
      }),
      onAnswer: (id, mode, answer) => final.set(`${id}-${mode}`, answer),
    });
    expect(final.get('q01-baseline')?.error).toBe('API offline');
    expect(final.get('q01-rag')?.status).toBe('error');
    expect(final.get('q10-rag')?.status).toBe('done');
    expect(
      [...final.values()].filter((answer) => answer.status === 'done'),
    ).toHaveLength(18);
  });

  it('cancels active requests without starting queued questions', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      return response(body.useRag);
    });
    await runComparison({
      buildId: 'snapshot-1',
      signal: controller.signal,
      fetcher,
      onAnswer: (_id, _mode, answer) => {
        if (answer.status === 'done') controller.abort();
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(
      true,
    );
  });

  it.each([{ empty: true }, { finish: false }])(
    'does not mark incomplete responses as complete: %j',
    async (options) => {
      const final = new Map<string, ComparisonAnswer>();
      await runComparison({
        buildId: 'snapshot-1',
        signal: new AbortController().signal,
        fetcher: vi.fn(async (_url, init) =>
          response(JSON.parse(init!.body as string).useRag, options),
        ),
        onAnswer: (id, mode, answer) => final.set(`${id}-${mode}`, answer),
      });
      expect(
        [...final.values()].every((answer) => answer.status === 'error'),
      ).toBe(true);
    },
  );

  it('restores notes and partial output but never resumes a pending request', () => {
    const run = emptyComparison();
    run.rows[0].baseline = {
      status: 'running',
      answer: 'Часть ответа',
      rag: null,
    };
    run.rows[0].comment = 'Проверить';
    const restored = restoreComparison(JSON.parse(JSON.stringify(run)))!;
    expect(restored.rows).toHaveLength(10);
    expect(restored.rows[0].baseline.status).toBe('stopped');
    expect(restored.rows[0].baseline.answer).toBe('Часть ответа');
    expect(restored.rows[0].comment).toBe('Проверить');
    expect(restoreComparison({ ...run, controls: 'old set' })).toBeNull();
    expect(restoreComparison({ ...run, rows: [] })).toBeNull();
    run.rows[1].rag = { status: 'done', answer: 'Нет источников', rag: null };
    expect(restoreComparison(run)).toBeNull();
  });

  it('imports CLI answers with reviews and refuses incompatible questions', () => {
    const report = {
      build_id: 'snapshot-1',
      created_at: new Date().toISOString(),
      rows: control.questions.map((question) => ({
        ...question,
        baseline: { answer: 'Обычный', rag: null },
        rag: { answer: 'Из базы [S1]', rag: retrieval },
        review: { rag: { notes: 'Подтверждено источником.' } },
      })),
    };
    const imported = importComparisonReport(report)!;
    expect(imported.rows.every((row) => row.rag.status === 'done')).toBe(true);
    expect(imported.rows[0].comment).toContain('Подтверждено источником.');
    report.rows[0].question = 'Другой вопрос';
    expect(importComparisonReport(report)).toBeNull();
  });
});
