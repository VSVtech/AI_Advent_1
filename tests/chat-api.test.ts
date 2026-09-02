import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import {
  buildSelectorSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';

const originalApiKey = process.env.DEEPSEEK_API_KEY;

function chatRequest(
  messages: Array<{ role: string; content: string }>,
  format?: string,
  targetOutputTokens?: number,
  systemPromptOptions: {
    useSelectorSystemPrompt?: unknown;
    customSystemPrompt?: unknown;
  } = {},
) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      ...(format ? { format } : {}),
      ...(targetOutputTokens === undefined ? {} : { targetOutputTokens }),
      ...systemPromptOptions,
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

  it('заменяет автоматические инструкции кастомным текстом в потоковом запросе', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Краткий ответ"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":3}}}\n\n',
          ]),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [
      { role: 'user', content: 'Вопрос' },
      { role: 'assistant', content: 'Ответ' },
      { role: 'user', content: 'Продолжи' },
    ];
    const customSystemPrompt = 'Ты преподаватель.\nОтветь в одном предложении.';

    const response = await POST(
      chatRequest(messages, 'text', 300, {
        useSelectorSystemPrompt: false,
        customSystemPrompt,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"outputTokens":3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.instructions).toBe(customSystemPrompt);
    expect(payload.input).toEqual(messages);
    expect(payload.max_output_tokens).toBe(800);
    expect(payload.stream).toBe(true);
  });

  it.each([
    ['json', 'json_object', '{"answer":42}'],
    ['xml', 'text', '<response><answer>42</answer></response>'],
    ['yaml', 'text', 'answer: 42'],
  ])(
    'сохраняет формат %s и его проверку при кастомном промпте',
    async (format, expectedApiFormat, validContent) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi
        .fn()
        .mockResolvedValue(deepSeekResponse(validContent));
      vi.stubGlobal('fetch', fetchMock);
      const customSystemPrompt = `Отвечай в формате ${format}. Укажи ответ в поле answer.`;

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Сколько?' }], format, 300, {
          useSelectorSystemPrompt: false,
          customSystemPrompt,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: done');
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.instructions).toBe(customSystemPrompt);
      expect(payload.text.format.type).toBe(expectedApiFormat);
      expect(payload.max_output_tokens).toBe(800);
      expect(payload.stream).toBe(false);
    },
  );

  it('в автоматическом режиме использует тот же промпт, что и предпросмотр, и игнорирует кастомный', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue(deepSeekResponse('answer: 42'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Сколько?' }], 'yaml', 8000, {
        useSelectorSystemPrompt: true,
        customSystemPrompt: 'Этот текст не должен попасть в запрос.',
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).instructions).toBe(
      buildSelectorSystemPrompt('yaml', 8000),
    );
  });

  it('не накапливает системные промпты при переключении режимов в диалоге', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(deepSeekResponse('answer: 42')),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [
      { role: 'user', content: 'Вопрос' },
      { role: 'assistant', content: 'answer: 42' },
      { role: 'user', content: 'Другой вопрос' },
    ];
    const modes = [
      {
        useSelectorSystemPrompt: false,
        customSystemPrompt: 'Первый YAML промпт',
      },
      {
        useSelectorSystemPrompt: true,
        customSystemPrompt: 'Первый YAML промпт',
      },
      {
        useSelectorSystemPrompt: false,
        customSystemPrompt: 'Второй YAML промпт',
      },
    ];

    for (const mode of modes) {
      const response = await POST(chatRequest(messages, 'yaml', 300, mode));
      expect(response.status).toBe(200);
    }

    const payloads = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    expect(payloads.map((payload) => payload.instructions)).toEqual([
      'Первый YAML промпт',
      buildSelectorSystemPrompt('yaml', 300),
      'Второй YAML промпт',
    ]);
    for (const payload of payloads) expect(payload.input).toEqual(messages);
  });

  it.each(['false', null, 0, {}, []])(
    'отклоняет некорректный режим промпта %j до запроса к модели',
    async (useSelectorSystemPrompt) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Привет' }], 'text', 500, {
          useSelectorSystemPrompt,
          customSystemPrompt: 'Ответь кратко.',
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_system_prompt_mode' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'отсутствующий', value: undefined },
    { label: 'null', value: null },
    { label: 'число', value: 42 },
    { label: 'объект', value: {} },
    { label: 'пустой', value: '' },
    { label: 'пробелы', value: ' \n\t ' },
    {
      label: 'слишком длинный',
      value: 'a'.repeat(MAX_CUSTOM_SYSTEM_PROMPT_LENGTH + 1),
    },
  ])(
    'отклоняет $label кастомный промпт до запроса к модели',
    async ({ value }) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Привет' }], 'text', 500, {
          useSelectorSystemPrompt: false,
          customSystemPrompt: value,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_custom_system_prompt' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('сохраняет кастомный промпт во всех трёх перезапросах без раздувания истории', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(deepSeekResponse('<response>')),
      );
    vi.stubGlobal('fetch', fetchMock);
    const customSystemPrompt =
      'Верни XML: <response><answer>текст</answer></response>.';
    const messages = [{ role: 'user', content: 'Вопрос' }];

    const response = await POST(
      chatRequest(messages, 'xml', 300, {
        useSelectorSystemPrompt: false,
        customSystemPrompt,
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_model_output' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [index, [, init]] of fetchMock.mock.calls.entries()) {
      const payload = JSON.parse(init.body);
      expect(payload.instructions).toBe(
        customSystemPrompt +
          (index === 0
            ? ''
            : ' A previous attempt did not pass server-side XML validation. Regenerate the complete answer and strictly follow the required format.'),
      );
      expect(payload.input).toEqual(messages);
      expect(payload.max_output_tokens).toBe(800);
    }
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
