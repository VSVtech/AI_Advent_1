import { describe, expect, it } from 'vitest';
import {
  attachReview,
  collectAnswer,
  compareAnswers,
} from '../scripts/rag/answers.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../scripts/rag/documents.mjs';
import { DEFAULT_RAG_SEARCH } from '../scripts/rag/relevance.mjs';

describe('answer comparison evidence', () => {
  it('runs enhanced holdout with both modes pinned and no expected answers in requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rag-answer-test-'));
    try {
      await mkdir(join(root, 'rag'));
      await mkdir(join(root, 'data'));
      const dataset = JSON.parse(
        await readFile('rag/extended-questions.json', 'utf8'),
      );
      await writeFile(
        join(root, 'rag/extended-questions.json'),
        JSON.stringify(dataset),
      );
      await writeFile(
        join(root, 'rag/answer-questions.json'),
        await readFile('rag/answer-questions.json'),
      );
      await writeFile(
        join(root, 'data/current.json'),
        JSON.stringify({ build_id: 'b1', corpus_hash: 'corpus' }),
      );
      await writeFile(
        join(root, 'rag/rerank-calibration.json'),
        JSON.stringify({
          build_id: 'b1',
          questions_hash: hash(JSON.stringify(dataset)),
          options: DEFAULT_RAG_SEARCH,
        }),
      );
      const requests = [];
      const report = await compareAnswers({
        root,
        dataDir: join(root, 'data'),
        enhanced: true,
        fetcher: async (_url, init) => {
          const body = JSON.parse(init.body);
          requests.push(body);
          return new Response(
            `event: rag\ndata: ${JSON.stringify({ retrieval: { build_id: body.ragBuildId, sources: [], ...(body.ragSearch ? { processing: { options: body.ragSearch } } : {}) } })}\n\nevent: delta\ndata: {"content":"Ответ"}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n`,
          );
        },
      });
      expect(requests).toHaveLength(20);
      expect(
        requests.every(
          (r) =>
            r.useRag &&
            r.ragBuildId === 'b1' &&
            r.messages.length === 1 &&
            !JSON.stringify(r).includes('expected'),
        ),
      ).toBe(true);
      expect(requests.filter((r) => r.ragSearch?.rerank)).toHaveLength(10);
      expect(report.rows.every((r) => r.split === 'test')).toBe(true);
      expect(report.suite).toBe('test');
      expect(requests.filter((r) => !r.ragSearch)).toHaveLength(10);
      expect(report.rows.every((r) => !r.baseline.rag.processing)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('collects streamed answer, usage, sources and invalid citation IDs', async () => {
    const result = await collectAnswer(
      new Response(
        'event: rag\ndata: {"retrieval":{"build_id":"b1","sources":[{"id":"S1"}]}}\n\nevent: delta\ndata: {"content":"Fact [S1], invented [S9]"}\n\nevent: done\ndata: {"finishReason":"stop","inputTokens":100}\n\n',
      ),
    );
    expect(result.invalid_citations).toEqual(['S9']);
    expect(result.answer_hash).toHaveLength(64);
  });
  it('never grades truncated or failed responses as valid answers', async () => {
    await expect(
      collectAnswer(
        new Response('event: delta\ndata: {"content":"partial"}\n\n'),
      ),
    ).rejects.toThrow('не завершила');
    await expect(
      collectAnswer(
        new Response(
          'event: delta\ndata: {"content":"partial"}\n\nevent: done\ndata: {"finishReason":"length"}\n\n',
        ),
      ),
    ).rejects.toThrow('не завершила');
  });
  it('does not reuse a manual grade for a changed answer or different run', () => {
    const report = {
      run_id: 'r1',
      rows: [
        {
          id: 'q1',
          expected: ['fact'],
          baseline: { answer_hash: 'a' },
          rag: { answer_hash: 'b' },
        },
      ],
    };
    const review = {
      run_id: 'r1',
      rows: [
        {
          id: 'q1',
          baseline: {
            answer_hash: 'wrong',
            facts: [true],
            unsupported_claims: false,
            notes: 'old',
          },
          rag: {
            answer_hash: 'b',
            facts: [true],
            unsupported_claims: false,
            notes: 'checked',
          },
        },
      ],
    };
    const graded = attachReview(report, review);
    expect(graded.rows[0].review.baseline).toBeUndefined();
    expect(graded.rows[0].review.rag.facts).toEqual([true]);
    expect(attachReview(report, { ...review, run_id: 'r2' })).toBe(report);
  });
});
