import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/benchmark/route';
import {
  BENCHMARK_MAX_OUTPUT_TOKENS,
  BENCHMARK_MAX_PROMPT_LENGTH,
  type BenchmarkResponsePayload,
} from '@/lib/benchmark';

function benchmarkRequest(body: unknown) {
  return new Request('http://localhost/api/benchmark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deepSeekResponse(
  content: string,
  usage: Record<string, unknown> = {
    output_tokens: 12,
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 5 },
  },
) {
  return Response.json({
    status: 'completed',
    usage,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: content }],
      },
    ],
  });
}

beforeEach(() => vi.stubEnv('DEEPSEEK_API_KEY', 'benchmark-test-secret'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/benchmark', () => {
  it('не запускается без серверного токена', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');

    const response = await POST(
      benchmarkRequest({ model: 'deepseek-v4-pro', prompt: 'Тест' }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration_error',
        message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
      },
    });
  });

  it.each(['', '   ', 'x'.repeat(201), 123, null, true, {}, []])(
    'отклоняет некорректную модель %j',
    async (model) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(benchmarkRequest({ model, prompt: 'Тест' }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_model',
          message: 'Некорректный идентификатор модели.',
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', 'x'.repeat(BENCHMARK_MAX_PROMPT_LENGTH + 1), 123, null])(
    'отклоняет некорректный промпт %j',
    async (prompt) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        benchmarkRequest({ model: 'deepseek-v4-pro', prompt }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_prompt' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('измеряет задержку и возвращает разбивку токенов без системного промпта', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        deepSeekResponse('Ответ модели', {
          output_tokens: 30,
          input_tokens: 50,
          input_tokens_details: { cached_tokens: 10 },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    const response = await POST(
      benchmarkRequest({ model: 'deepseek-v4-pro', prompt: '  Реши задачу  ' }),
    );
    const after = Date.now();

    expect(response.status).toBe(200);
    const payload = (await response.json()) as BenchmarkResponsePayload;
    expect(payload).toEqual({
      model: 'deepseek-v4-pro',
      latencyMs: payload.latencyMs,
      inputTokens: 50,
      cachedInputTokens: 10,
      outputTokens: 30,
      answer: 'Ответ модели',
    });
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
    expect(payload.latencyMs).toBeLessThanOrEqual(after - before + 1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/responses');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'deepseek-v4-pro',
      input: [{ role: 'user', content: 'Реши задачу' }],
      max_output_tokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      stream: false,
      reasoning: { effort: 'none' },
      text: { format: { type: 'text' } },
    });
    expect(body).not.toHaveProperty('instructions');
  });

  it('возвращает null для отсутствующих полей использования токенов', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(deepSeekResponse('Ответ', {})),
    );

    const response = await POST(
      benchmarkRequest({ model: 'deepseek-v4-pro', prompt: 'Тест' }),
    );

    const payload = (await response.json()) as BenchmarkResponsePayload;
    expect(payload.inputTokens).toBeNull();
    expect(payload.cachedInputTokens).toBeNull();
    expect(payload.outputTokens).toBeNull();
  });

  it('преобразует достижение лимита токенов в понятную ошибку', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      ),
    );

    const response = await POST(
      benchmarkRequest({ model: 'deepseek-v4-pro', prompt: 'Тест' }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'max_output_tokens' },
    });
  });

  it('маппит ошибку апстрима по статусу', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
    );

    const response = await POST(
      benchmarkRequest({ model: 'deepseek-v4-pro', prompt: 'Тест' }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'rate_limit' },
    });
  });

  it('не раскрывает токен в ответе', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'super-secret-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
    );

    const response = await POST(
      benchmarkRequest({ model: 'deepseek-v4-pro', prompt: 'Тест' }),
    );

    expect(await response.text()).not.toContain('super-secret-token');
  });
});
