import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalGroundingVerifier } from '@/scripts/rag/grounding-model.mjs';
import {
  readGroundingConfig,
  validateGroundingConfig,
} from '@/scripts/rag/grounding-config.mjs';
import { EVIDENCE_MODEL } from '@/scripts/rag/evidence.mjs';

const model = 'qwen3.5:27b-q4_K_M';
const claim = {
  text: 'История хранится в браузере.',
  citations: [{ source_id: 'S1', quote: 'История хранится в браузере.' }],
};
const checked = {
  checks: [
    {
      index: 0,
      citation_subject: 'История',
      claim_subject: 'История',
      scope_matches: true,
      reason: 'Цитата подтверждает.',
      verdict: 'supported',
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());

describe('Local Qwen verifier profiles', () => {
  it.each([false, true])(
    'passes an explicit thinking flag (%s) and parses only final content',
    async (think) => {
      const calls: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          if (String(url).endsWith('/api/tags'))
            return Response.json({
              models: [{ name: model, digest: 'sha-model' }],
            });
          calls.push(JSON.parse(init.body));
          return Response.json({
            message: {
              content: JSON.stringify(checked),
              thinking: 'Not JSON; must not be parsed or published.',
            },
            done_reason: 'stop',
            eval_count: 42,
          });
        }),
      );
      const judge = new LocalGroundingVerifier(undefined, { model, think });
      const result = await judge.verify(
        'Где история?',
        [claim],
        new AbortController().signal,
      );
      expect(result.checks[0].verdict).toBe('supported');
      expect(result.identity).toMatchObject({
        model,
        think,
        digest: 'sha-model',
        guardrails: true,
      });
      expect(calls[0]).toMatchObject({
        model,
        think,
        stream: false,
        options: { num_ctx: 8192, num_predict: think ? 4096 : 1500 },
      });
      expect(judge.lastUsage?.output_tokens).toBe(42);
    },
  );
  it('refuses truncated reasoning output even when it contains a parseable draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).endsWith('/api/tags')
          ? Response.json({ models: [{ name: model, digest: 'x' }] })
          : Response.json({
              done_reason: 'length',
              message: { content: JSON.stringify(checked) },
            }),
      ),
    );
    await expect(
      new LocalGroundingVerifier(undefined, { model, think: true }).verify(
        'Где?',
        [claim],
        new AbortController().signal,
      ),
    ).rejects.toThrow('не завершена');
  });
  it('preserves the 7B fallback without changing the chunk evidence model', () => {
    expect(EVIDENCE_MODEL).toBe('qwen2.5:7b');
    expect(
      readGroundingConfig('/tmp/absent-rag-judge-config-test.json'),
    ).toEqual({ model: EVIDENCE_MODEL, think: false });
    expect(
      new LocalGroundingVerifier().generationOptions('verify'),
    ).toMatchObject({ temperature: 0, num_ctx: 16384, num_predict: 900 });
  });
  it.each([
    { model: 'qwen3.5:27b-cloud', think: false },
    { model: 'https://remote.example/model', think: false },
    { model, think: 'false' },
    { model, think: false, guardrails: false },
    { model: EVIDENCE_MODEL, think: true },
  ])(
    'rejects cloud names, invalid flags and attempts to disable runtime guards: %j',
    (value) => {
      expect(() => validateGroundingConfig(value)).toThrow();
    },
  );
  it('never bypasses numeric guards in the configured runtime', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ models: [{ name: model, digest: 'x' }] }),
    );
    vi.stubGlobal('fetch', fetcher);
    const judge = new LocalGroundingVerifier(
      undefined,
      validateGroundingConfig({ model, think: false }),
    );
    const result = await judge.verify(
      'Какой предел?',
      [
        {
          text: 'Предел равен 17.',
          citations: [
            {
              source_id: 'S1',
              quote: 'Предел указан в настройках приложения.',
            },
          ],
        },
      ],
      new AbortController().signal,
    );
    expect(result.checks[0].verdict).toBe('insufficient');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
