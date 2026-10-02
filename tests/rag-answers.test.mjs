import { describe, expect, it } from 'vitest';
import { attachReview, collectAnswer } from '../scripts/rag/answers.mjs';

describe('answer comparison evidence', () => {
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
