import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';

const originalApiKey = process.env.DEEPSEEK_API_KEY;

function chatRequest(
  messages: Array<{ role: string; content: string }>,
  format?: string,
  targetOutputTokens?: number,
) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      ...(format ? { format } : {}),
      ...(targetOutputTokens === undefined ? {} : { targetOutputTokens }),
    }),
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

function deepSeekResponse(content: string, outputTokens = 12): Response {
  return Response.json({
    status: 'completed',
    usage: { output_tokens: outputTokens },
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: content }],
      },
    ],
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

  it('отклоняет неизвестный формат ответа', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], 'csv'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_format',
        message: 'Выбран неподдерживаемый формат ответа.',
      },
    });
  });

  it('передаёт историю в Responses API и нормализует поток DeepSeek', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"При","sequence_number":1}\n\n',
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"вет","sequence_number":2}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","sequence_number":3,"response":{"status":"completed","usage":{"output_tokens":2}}}\n\n',
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

    const response = await POST(chatRequest(messages, undefined, 8000));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('event: delta\ndata: {"content":"При"}');
    expect(body).toContain('event: delta\ndata: {"content":"вет"}');
    expect(body).toContain(
      'event: done\ndata: {"finishReason":"stop","outputTokens":2}',
    );
    expect(body).not.toContain('test-secret');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/responses');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer test-secret',
    );
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected JSON body');
    expect(JSON.parse(init.body)).toEqual({
      model: 'deepseek-v4-flash',
      input: messages,
      max_output_tokens: 9600,
      stream: true,
      reasoning: { effort: 'none' },
      text: { format: { type: 'text' } },
      instructions:
        'The complete answer must contain between 7000 and 9000 output tokens. For prose, use approximately 4800 words as an additional planning guide. Treat the token range as a required target, not merely an upper bound or a suggestion. The separate API token limit is only an emergency buffer for completing the answer and closing structured data; do not use that allowance as the target length. Plan the response length before writing and finish inside the target range. Develop relevant details, examples, edge cases, and explanations without repetition or filler. Do not cut off a sentence, list, code block, JSON object, XML document, or YAML document to meet the target.',
    });
  });

  it('преобразует незавершённый ответ Responses API в безопасную ошибку', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            deepSeekStream([
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Частичный ответ"}\n\n',
              'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
            ]),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
    );

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }]),
    );
    const body = await response.text();

    expect(body).toContain('event: delta\ndata: {"content":"Частичный ответ"}');
    expect(body).toContain('event: error\ndata: {"code":"response_incomplete"');
    expect(body).not.toContain('test-secret');
  });

  it.each([49, 98_001, 100.5])(
    'отклоняет некорректную целевую длину %s',
    async (targetOutputTokens) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest(
          [{ role: 'user', content: 'Привет' }],
          'text',
          targetOutputTokens,
        ),
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_target_output_tokens',
          message: 'Целевая длина ответа указана некорректно.',
        },
      });
    },
  );

  it.each([
    ['json', 'json_object', 'valid json', '{"answer":42}'],
    [
      'xml',
      'text',
      'well-formed XML',
      '<response><answer>42</answer></response>',
    ],
    ['yaml', 'text', 'valid YAML', 'answer: 42'],
  ])(
    'настраивает формат %s на сервере',
    async (format, expectedApiFormat, expectedInstruction, validContent) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi
        .fn()
        .mockResolvedValue(deepSeekResponse(validContent));
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Привет' }], format),
      );
      const responseBody = await response.text();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      if (typeof init.body !== 'string') throw new Error('Expected JSON body');
      const payload = JSON.parse(init.body) as {
        instructions?: string;
        text: { format: { type: string } };
      };

      expect(payload.text.format.type).toBe(expectedApiFormat);
      expect(payload.instructions).toContain(expectedInstruction);
      expect(payload.instructions).toContain(
        'between 437 and 563 output tokens',
      );
      expect(JSON.parse(init.body).stream).toBe(false);
      expect(JSON.parse(init.body).max_output_tokens).toBe(1000);
      expect(responseBody).toContain('"outputTokens":12');
      expect(responseBody).toContain('event: done');
    },
  );

  it('повторяет запрос после невалидного ответа и не показывает его клиенту', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deepSeekResponse('это не json'))
      .mockResolvedValueOnce(deepSeekResponse('{"answer":42}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Ответь числом' }], 'json'),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toContain('answer');
    expect(body).not.toContain('это не json');

    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    if (typeof retryInit.body !== 'string') {
      throw new Error('Expected JSON body');
    }
    expect(JSON.parse(retryInit.body).instructions).toContain(
      'previous attempt did not pass server-side JSON validation',
    );
    expect(JSON.parse(retryInit.body).instructions).toContain(
      'between 437 and 563 output tokens',
    );
  });

  it('повторяет YAML без лишнего корневого ключа формата', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        deepSeekResponse('YAML:\n  тема: Квантовая запутанность'),
      )
      .mockResolvedValueOnce(
        deepSeekResponse(
          'тема: Квантовая запутанность\nобъяснение: Простыми словами',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Объясни тему' }], 'yaml'),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toContain('тема: Квантовая запутанность');
    expect(body).not.toContain('YAML:');
  });

  it('останавливается после трёх повторных попыток', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue(deepSeekResponse('<response>'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], 'xml'),
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_model_output',
        message:
          'DeepSeek не смог сформировать корректный XML после трёх повторных попыток.',
      },
    });
  });

  it('не повторяет структурированный запрос после достижения лимита', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], 'yaml', 8000),
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'max_output_tokens',
        message:
          'Ответ DeepSeek достиг лимита в 9600 токенов. Увеличьте целевую длину и повторите запрос.',
      },
    });
  });

  it('считает поток без финального события прерванным', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            deepSeekStream([
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Начало"}\n\n',
            ]),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
    );

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }]),
    );
    const body = await response.text();

    expect(body).toContain('event: error');
    expect(body).toContain('"code":"upstream_stream_error"');
    expect(body).not.toContain('event: done');
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
