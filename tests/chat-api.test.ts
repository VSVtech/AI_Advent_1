import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';

const originalApiKey = process.env.DEEPSEEK_API_KEY;

function chatRequest(messages: Array<{ role: string; content: string }>) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

function deepSeekStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  vi.unstubAllGlobals();
});

describe('POST /api/chat', () => {
  it('не запускается без серверного токена', async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }]),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'configuration_error',
        message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
      },
    });
  });

  it('отклоняет пустую или некорректную историю', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';

    const response = await POST(chatRequest([]));

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('test-secret');
  });

  it('передаёт многошаговую историю и нормализует поток DeepSeek', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            ': keep-alive\n\n',
            'data: {"choices":[{"delta":{"content":"При"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{"content":"вет"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [
      { role: 'user', content: 'Первый вопрос' },
      { role: 'assistant', content: 'Первый ответ' },
      { role: 'user', content: 'Продолжи' },
    ];

    const response = await POST(chatRequest(messages));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: delta\ndata: {"content":"При"}');
    expect(body).toContain('event: delta\ndata: {"content":"вет"}');
    expect(body).toContain('event: done\ndata: {"finishReason":"stop"}');
    expect(body).not.toContain('test-secret');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-secret',
    );
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected JSON body');
    expect(JSON.parse(init.body)).toEqual({
      model: 'deepseek-v4-flash',
      messages,
      stream: true,
      thinking: { type: 'disabled' },
    });
  });

  it.each([
    [401, 'invalid_api_key'],
    [402, 'insufficient_balance'],
    [429, 'rate_limit'],
    [500, 'deepseek_server_error'],
    [503, 'deepseek_overloaded'],
  ])('безопасно отображает ошибку DeepSeek %s', async (status, code) => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('upstream details with test-secret', { status }),
        ),
    );

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }]),
    );
    const body = await response.text();

    expect(response.status).toBe(status);
    expect(JSON.parse(body).error.code).toBe(code);
    expect(body).not.toContain('upstream details');
    expect(body).not.toContain('test-secret');
  });
});
