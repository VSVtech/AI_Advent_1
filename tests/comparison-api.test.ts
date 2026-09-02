import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/comparison/route';
import {
  COMPARISON_MAX_OUTPUT_TOKENS,
  COMPARISON_VARIANTS,
  MAX_COMPARISON_PROMPT_LENGTH,
  PROMPT_CREATION_PREFIX,
  STEP_BY_STEP_SUFFIX,
} from '@/lib/comparison';

const prompt = 'Реши задачу о поездке.';
const history = [
  { role: 'user', content: 'Предыдущая задача' },
  { role: 'assistant', content: 'Предыдущее решение' },
];
const request = (body: unknown, signal?: AbortSignal) =>
  new Request('http://localhost/api/comparison', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
const solution = (content = 'Готовое решение') =>
  new Response(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}\n\n` +
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":14}}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
const preparation = (
  content: string,
  overrides: Record<string, unknown> = {},
) =>
  Response.json({
    status: 'completed',
    usage: { output_tokens: 27 },
    output: [
      { type: 'message', content: [{ type: 'output_text', text: content }] },
    ],
    ...overrides,
  });

beforeEach(() => vi.stubEnv('DEEPSEEK_API_KEY', 'comparison-test-secret'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/comparison', () => {
  it.each([1, 2, 3, 5])(
    'настраивает вариант %s точно, без скрытых инструкций',
    async (variant) => {
      const fetchMock = vi.fn().mockResolvedValue(solution());
      vi.stubGlobal('fetch', fetchMock);
      const response = await POST(
        request({
          variant,
          prompt,
          messages: history,
          instructions: 'Не добавлять',
          targetOutputTokens: 50,
        }),
      );
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).toContain('event: prepared');
      expect(stream).toContain('Готовое решение');
      expect(stream).toContain('"outputTokens":14');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      const payload = JSON.parse(options.body);
      expect(url).toBe('https://api.deepseek.com/responses');
      expect(payload.input).toEqual([
        ...history,
        {
          role: 'user',
          content: prompt + (variant === 3 ? STEP_BY_STEP_SUFFIX : ''),
        },
      ]);
      expect(payload.stream).toBe(true);
      expect(payload.max_output_tokens).toBe(COMPARISON_MAX_OUTPUT_TOKENS);
      expect(payload.reasoning).toEqual({ effort: 'none' });
      expect(payload.text).toEqual({ format: { type: 'text' } });
      const systemPrompt = COMPARISON_VARIANTS.find(
        (item) => item.id === variant,
      )?.systemPrompt;
      if (systemPrompt) expect(payload.instructions).toBe(systemPrompt);
      else expect(payload).not.toHaveProperty('instructions');
      expect(stream).not.toContain('comparison-test-secret');
    },
  );

  it('в варианте 4 создаёт промпт отдельно и передаёт только его в чат решения', async () => {
    const generatedPrompt =
      'Реши задачу: вычисли расстояние и объясни формулу.';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(preparation(generatedPrompt))
      .mockResolvedValueOnce(solution());
    vi.stubGlobal('fetch', fetchMock);
    const incoming = request({ variant: 4, prompt, messages: history });
    const response = await POST(incoming);
    const stream = await response.text();
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    expect(first.input).toEqual([
      { role: 'user', content: PROMPT_CREATION_PREFIX + prompt },
    ]);
    expect(first.stream).toBe(false);
    expect(second.input).toEqual([
      ...history,
      { role: 'user', content: generatedPrompt },
    ]);
    expect(second.stream).toBe(true);
    for (const payload of [first, second]) {
      expect(payload).not.toHaveProperty('instructions');
      expect(payload).not.toHaveProperty('previous_response_id');
      expect(payload.max_output_tokens).toBe(COMPARISON_MAX_OUTPUT_TOKENS);
    }
    for (const [, init] of fetchMock.mock.calls)
      expect(init.signal).toBe(incoming.signal);
    expect(stream).toContain(`"prompt":"${generatedPrompt}"`);
    expect(stream).toContain('"promptOutputTokens":27');
    expect(stream).toContain('"outputTokens":14');
    expect(stream).not.toContain(PROMPT_CREATION_PREFIX);
  });

  it('первый раунд из пяти вариантов делает ровно шесть запросов', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((_url, init) =>
        Promise.resolve(
          JSON.parse(init.body).stream
            ? solution()
            : preparation('Новый промпт'),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all(
      COMPARISON_VARIANTS.map(async (variant) => {
        const response = await POST(
          request({ variant: variant.id, prompt, messages: [] }),
        );
        await response.text();
        return response.status;
      }),
    );
    expect(results).toEqual([200, 200, 200, 200, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    { label: 'пустой', content: ' ', overrides: {} },
    {
      label: 'обрезанный',
      content: 'Незавершённый',
      overrides: { status: 'incomplete' },
    },
    { label: 'ошибка', content: 'Текст', overrides: { status: 'failed' } },
    { label: 'некорректный', content: 'Текст', overrides: { output: [null] } },
  ])(
    'не запускает решение, если сгенерированный промпт $label',
    async ({ content, overrides }) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(preparation(content, overrides));
      vi.stubGlobal('fetch', fetchMock);
      const response = await POST(
        request({ variant: 4, prompt, messages: [] }),
      );
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'prompt_generation_failed' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('не запускает решение после отмены создания промпта', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(preparation('Новый промпт'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(
      request({ variant: 4, prompt, messages: [] }, controller.signal),
    );
    expect(response.status).toBe(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('не запускает уже отменённый запрос', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      (await POST(request({ variant: 1, prompt }, controller.signal))).status,
    ).toBe(499);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', body: null, code: 'invalid_variant' },
    {
      label: 'неизвестный вариант',
      body: { variant: 6, prompt },
      code: 'invalid_variant',
    },
    {
      label: 'строковый вариант',
      body: { variant: '1', prompt },
      code: 'invalid_variant',
    },
    {
      label: 'пустая задача',
      body: { variant: 1, prompt: ' ' },
      code: 'invalid_prompt',
    },
    {
      label: 'длинная задача',
      body: {
        variant: 1,
        prompt: 'a'.repeat(MAX_COMPARISON_PROMPT_LENGTH + 1),
      },
      code: 'invalid_prompt',
    },
    {
      label: 'не массив',
      body: { variant: 1, prompt, messages: {} },
      code: 'invalid_messages',
    },
    {
      label: 'system в истории',
      body: {
        variant: 1,
        prompt,
        messages: [{ role: 'system', content: 'Нет' }, history[1]],
      },
      code: 'invalid_messages',
    },
    {
      label: 'незаконченная история',
      body: { variant: 1, prompt, messages: [history[0]] },
      code: 'invalid_messages',
    },
    {
      label: 'длинная история',
      body: {
        variant: 1,
        prompt,
        messages: Array.from({ length: 50 }, () => history).flat(),
      },
      code: 'invalid_messages',
    },
  ])('отклоняет неверный запрос: $label', async ({ body, code }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('не запускается без API-ключа', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request({ variant: 1, prompt }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'configuration_error' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('возвращает безопасную ошибку без утечки тела upstream и без перезапроса', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('comparison-test-secret', { status: 429 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request({ variant: 1, prompt }));
    expect(response.status).toBe(429);
    expect(await response.text()).not.toContain('comparison-test-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('при обрезанном решении не предлагает несуществующий селектор длины', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request({ variant: 1, prompt }));
    const stream = await response.text();
    expect(stream).toContain('8000 токенов');
    expect(stream).not.toContain('целевую длину');
    expect(stream).not.toContain('event: done');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
