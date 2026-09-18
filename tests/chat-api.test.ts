import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import {
  buildSelectorSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';

const originalApiKey = process.env.DEEPSEEK_API_KEY;

function chatRequest(
  messages: Array<{ role: string; content: unknown }>,
  format?: string,
  targetOutputTokens?: number | null,
  options: {
    useSystemPrompt?: unknown;
    useSelectorSystemPrompt?: unknown;
    customSystemPrompt?: unknown;
    contextWindowTokens?: unknown;
    maxOutputTokens?: unknown;
    temperature?: unknown;
    model?: unknown;
    longTermMemory?: unknown;
  } = {},
) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      ...(format ? { format } : {}),
      ...(targetOutputTokens === undefined ? {} : { targetOutputTokens }),
      ...options,
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

  it('искусственно воспроизводит переполнение контекстного окна до вызова DeepSeek', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest(
        [
          { role: 'user', content: 'x'.repeat(1000) },
          { role: 'assistant', content: 'y'.repeat(1000) },
          { role: 'user', content: 'Продолжи' },
        ],
        'text',
        50,
        {
          contextWindowTokens: 500,
          useSystemPrompt: false,
        },
      ),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'context_window_exceeded',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([99, 1_000_001, 100.5, null, '2000'])(
    'отклоняет некорректный лимит контекста %j',
    async (contextWindowTokens) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Привет' }], 'text', 50, {
          contextWindowTokens,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_context_window_tokens' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

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
      temperature: 1,
      stream: true,
      reasoning: { effort: 'none' },
      text: { format: { type: 'text' } },
      instructions:
        'The complete answer must contain between 7000 and 9000 output tokens. For prose, use approximately 4800 words as an additional planning guide. Treat the token range as a required target, not merely an upper bound or a suggestion. The separate API token limit is only an emergency buffer for completing the answer and closing structured data; do not use that allowance as the target length. Plan the response length before writing and finish inside the target range. Develop relevant details, examples, edge cases, and explanations without repetition or filler. Do not cut off a sentence, list, code block, JSON object, XML document, or YAML document to meet the target.',
    });
  });

  it('передаёт мультимодальное сообщение с загруженным изображением', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ]),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Что изображено?' },
          { type: 'input_image', file_id: 'file-api-picture-1' },
        ],
      },
    ];

    const response = await POST(chatRequest(messages));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: done');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).input).toEqual(messages);
  });

  it('не принимает изображение для модели без поддержки vision', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest(
        [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Что изображено?' },
              { type: 'input_image', file_id: 'file-api-picture-1' },
            ],
          },
        ],
        undefined,
        undefined,
        { model: 'deepseek-v4-pro' },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'vision_model_required' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('передаёт число входных токенов (включая кэшированные) из usage в событие done', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Привет","sequence_number":1}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"status":"completed","usage":{"output_tokens":2,"input_tokens":40,"input_tokens_details":{"cached_tokens":15}}}}\n\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }]),
    );
    const body = await response.text();

    expect(body).toContain(
      'event: done\ndata: {"finishReason":"stop","outputTokens":2,"inputTokens":40,"cachedInputTokens":15}',
    );
  });

  it('не добавляет поля токенов в событие done, если usage их не содержит', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            deepSeekStream([
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            ]),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
    );

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }]),
    );
    const body = await response.text();

    expect(body).toContain('event: done\ndata: {"finishReason":"stop"}');
  });

  it('передаёт число входных токенов из usage и для структурированных форматов', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          status: 'completed',
          usage: {
            output_tokens: 9,
            input_tokens: 30,
            input_tokens_details: { cached_tokens: 5 },
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"ok":true}' }],
            },
          ],
        }),
      ),
    );

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], 'json'),
    );
    const body = await response.text();

    expect(body).toContain(
      'event: done\ndata: {"finishReason":"stop","outputTokens":9,"inputTokens":30,"cachedInputTokens":5}',
    );
  });

  it('отключённая целевая длина (null) снимает и максимум ответа, и инструкцию длины', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        deepSeekStream([
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1}}}\n\n',
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], undefined, null),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    if (typeof init.body !== 'string') throw new Error('Expected JSON body');
    const payload = JSON.parse(init.body) as {
      max_output_tokens: number;
      instructions?: string;
    };

    expect(payload.max_output_tokens).toBe(100_000);
    // The selector prompt for text with no target has nothing to say, so no
    // instructions field is sent at all.
    expect(payload.instructions).toBeUndefined();
  });

  it('принимает отдельный технический лимит для служебной сводки без инструкции целевой длины', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest(
        [{ role: 'user', content: 'Суммаризируй ветку' }],
        'text',
        null,
        {
          maxOutputTokens: 8192,
          useSystemPrompt: false,
        },
      ),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    if (typeof init.body !== 'string') throw new Error('Expected JSON body');
    const payload = JSON.parse(init.body) as {
      max_output_tokens: number;
      instructions?: string;
    };
    expect(payload.max_output_tokens).toBe(8192);
    expect(payload.instructions).toBeUndefined();
  });

  it.each([0, 100_001, 1.5, '8192'])(
    'отклоняет некорректный технический лимит %s',
    async (maxOutputTokens) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Привет' }], 'text', null, {
          maxOutputTokens,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'invalid_max_output_tokens' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('отключённая целевая длина не мешает инструкциям формата (json)', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(deepSeekResponse('{"ok":true}')),
    );

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], 'json', null),
    );

    expect(response.status).toBe(200);
  });

  it('отклоняет некорректное значение целевой длины, но принимает null', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const invalidResponse = await POST(
      chatRequest([{ role: 'user', content: 'Привет' }], undefined, 49),
    );
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: { code: 'invalid_target_output_tokens' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { useSelectorSystemPrompt: true, customSystemPrompt: 'Не отправлять' },
    { useSelectorSystemPrompt: false, customSystemPrompt: 'Не отправлять' },
    { useSelectorSystemPrompt: false, customSystemPrompt: '' },
    { useSelectorSystemPrompt: false, customSystemPrompt: null },
    { useSelectorSystemPrompt: false },
    {},
  ])(
    'отправляет текст без системного промпта при настройках %j',
    async (options) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            deepSeekStream([
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Ответ"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            ]),
          ),
        );
      vi.stubGlobal('fetch', fetchMock);
      const messages = [
        { role: 'user', content: 'Вопрос' },
        { role: 'assistant', content: 'Ответ' },
        { role: 'user', content: 'Продолжи' },
      ];

      const response = await POST(
        chatRequest(messages, 'text', 300, {
          ...options,
          useSystemPrompt: false,
          temperature: 0.2,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: done');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload).not.toHaveProperty('instructions');
      expect(payload.input).toEqual(messages);
      expect(payload.max_output_tokens).toBe(800);
      expect(payload.temperature).toBe(0.2);
      expect(payload.text.format.type).toBe('text');
    },
  );

  it.each(['false', null, 0, {}, []])(
    'отклоняет некорректный флаг системного промпта %j',
    async (useSystemPrompt) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Вопрос' }], 'text', 500, {
          useSystemPrompt,
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
    ['json', 'json_object', '{"answer":42}'],
    ['xml', 'text', '<response><answer>42</answer></response>'],
    ['yaml', 'text', 'answer: 42'],
  ])(
    'проверяет %s и уточняет формат через user без системного промпта',
    async (format, apiFormat, content) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(deepSeekResponse('неправильный формат'))
        .mockResolvedValueOnce(deepSeekResponse(content));
      vi.stubGlobal('fetch', fetchMock);
      const messages = [{ role: 'user', content: `Ответь в ${format}` }];

      const response = await POST(
        chatRequest(messages, format, 300, {
          useSystemPrompt: false,
          temperature: 0,
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('event: done');
      expect(body).not.toContain('неправильный формат');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const payloads = fetchMock.mock.calls.map(([, init]) =>
        JSON.parse(init.body),
      );
      expect(payloads[0].input).toEqual(messages);
      expect(payloads[1].input).toEqual([
        ...messages,
        {
          role: 'user',
          content: `A previous attempt did not pass server-side ${format.toUpperCase()} validation. Regenerate the complete answer and strictly follow the required format.`,
        },
      ]);
      for (const payload of payloads) {
        expect(payload).not.toHaveProperty('instructions');
        expect(payload.text.format.type).toBe(apiFormat);
        expect(payload.max_output_tokens).toBe(800);
        expect(payload.temperature).toBe(0);
      }
    },
  );

  it('не включает системный промпт и не накапливает уточнения за три повтора', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(deepSeekResponse('<response>')),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [{ role: 'user', content: 'Ответь в XML' }];

    const response = await POST(
      chatRequest(messages, 'xml', 300, {
        useSystemPrompt: false,
      }),
    );

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const payloads = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    for (const [index, payload] of payloads.entries()) {
      expect(payload).not.toHaveProperty('instructions');
      expect(payload.input).toHaveLength(index === 0 ? 1 : 2);
      expect(payload.input[0]).toEqual(messages[0]);
      expect(
        payload.input.every((item: { role: string }) => item.role === 'user'),
      ).toBe(true);
    }
    expect(payloads[1].input).toEqual(payloads[2].input);
    expect(payloads[2].input).toEqual(payloads[3].input);
    expect(messages).toHaveLength(1);
  });

  it('включает и выключает системный промпт между запросами без изменения истории', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(deepSeekResponse('answer: 42')),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [{ role: 'user', content: 'Ответь в YAML' }];
    const customSystemPrompt = 'Верни ответ в YAML.';

    for (const useSystemPrompt of [true, false, true]) {
      const response = await POST(
        chatRequest(messages, 'yaml', 300, {
          useSystemPrompt,
          useSelectorSystemPrompt: false,
          customSystemPrompt,
        }),
      );
      expect(response.status).toBe(200);
    }

    const payloads = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    expect(payloads[0].instructions).toBe(customSystemPrompt);
    expect(payloads[1]).not.toHaveProperty('instructions');
    expect(payloads[2].instructions).toBe(customSystemPrompt);
    for (const payload of payloads) expect(payload.input).toEqual(messages);
  });

  it('отправляет долговременную память в instructions даже при выключенном системном промпте', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const messages = [
      { role: 'assistant', content: 'Краткосрочные факты: цель — ТЗ' },
      { role: 'user', content: 'Продолжи' },
    ];

    const response = await POST(
      chatRequest(messages, 'text', 100, {
        useSystemPrompt: false,
        longTermMemory: [{ key: 'язык', value: 'Русский', kind: 'profile' }],
      }),
    );

    expect(response.status).toBe(200);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.input).toEqual(messages);
    expect(payload.instructions).toContain('Долговременная память');
    expect(payload.instructions).toContain('"key":"язык"');
    expect(payload.instructions).toContain('"value":"Русский"');
    expect(JSON.stringify(payload.input)).not.toContain('Русский');
  });

  it('добавляет долговременную память после пользовательского системного промпта и для JSON-ответа', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(deepSeekResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Ответь JSON' }], 'json', 100, {
        useSystemPrompt: true,
        useSelectorSystemPrompt: false,
        customSystemPrompt: 'Отвечай кратко.',
        longTermMemory: [{ key: 'проект', value: 'Альфа', kind: 'knowledge' }],
      }),
    );

    expect(response.status).toBe(200);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.instructions).toMatch(
      /^Отвечай кратко\.\n\nДолговременная память/,
    );
    expect(payload.instructions).toContain('"value":"Альфа"');
    expect(payload.input).toEqual([{ role: 'user', content: 'Ответь JSON' }]);
  });

  it('учитывает долговременную память в лимите контекста и отклоняет повреждённые записи', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const messages = [{ role: 'user', content: 'Привет' }];

    const overflow = await POST(
      chatRequest(messages, 'text', 100, {
        useSystemPrompt: false,
        contextWindowTokens: 100,
        longTermMemory: [
          { key: 'знание', value: 'А'.repeat(500), kind: 'knowledge' },
        ],
      }),
    );
    expect(overflow.status).toBe(413);

    for (const longTermMemory of [
      null,
      [{ key: 'цель', value: 'ТЗ', kind: 'other' }],
      [{ key: '', value: 'ТЗ', kind: 'knowledge' }],
    ]) {
      const invalid = await POST(
        chatRequest(messages, 'text', 100, {
          useSystemPrompt: false,
          longTermMemory,
        }),
      );
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        error: { code: 'invalid_long_term_memory' },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('при служебном лимите вывода не предлагает менять целевую длину обычного ответа', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            deepSeekStream([
              'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
            ]),
            { status: 200 },
          ),
        ),
    );

    const response = await POST(
      chatRequest(
        [{ role: 'user', content: 'Суммаризируй ветку' }],
        'text',
        null,
        {
          maxOutputTokens: 8192,
          useSystemPrompt: false,
        },
      ),
    );
    const body = await response.text();

    expect(body).toContain('технического лимита вывода 8192 токенов');
    expect(body).not.toContain('целевую длину');
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
        temperature: 0.3,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"outputTokens":3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.instructions).toBe(customSystemPrompt);
    expect(payload.input).toEqual(messages);
    expect(payload.max_output_tokens).toBe(800);
    expect(payload.temperature).toBe(0.3);
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
          temperature: 1.5,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: done');
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.instructions).toBe(customSystemPrompt);
      expect(payload.text.format.type).toBe(expectedApiFormat);
      expect(payload.max_output_tokens).toBe(800);
      expect(payload.temperature).toBe(1.5);
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
        temperature: 0,
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
      expect(payload.temperature).toBe(0);
    }
  });

  it.each([0, 0.25, 1, 2])(
    'передаёт температуру %s в потоковый запрос без изменения промпта',
    async (temperature) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            deepSeekStream([
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Ответ"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            ]),
          ),
        );
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Вопрос' }], 'text', 500, {
          temperature,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: done');
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.temperature).toBe(temperature);
      expect(payload.reasoning).toEqual({ effort: 'none' });
      expect(payload.instructions).toBe(buildSelectorSystemPrompt('text', 500));
    },
  );

  it.each([-0.1, 2.1, '1', '', null, true, {}, []])(
    'отклоняет температуру %j до обращения к DeepSeek',
    async (temperature) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Вопрос' }], 'text', 500, {
          temperature,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'invalid_temperature',
          message: 'Укажите температуру от 0 до 2.',
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('передаёт выбранную модель в потоковый запрос', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          deepSeekStream([
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Ответ"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          ]),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Вопрос' }], 'text', 500, {
        model: 'deepseek-v4-pro',
      }),
    );

    expect(response.status).toBe(200);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('deepseek-v4-pro');
  });

  it('передаёт выбранную модель в повторные запросы структурированного вывода', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deepSeekResponse('неправильный формат'))
      .mockResolvedValueOnce(deepSeekResponse('{"answer":42}'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      chatRequest([{ role: 'user', content: 'Ответь в json' }], 'json', 300, {
        model: 'deepseek-v4-pro',
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body).model).toBe('deepseek-v4-pro');
    }
  });

  it.each(['', '   ', 'x'.repeat(201), 123, null, true, {}, []])(
    'отклоняет некорректную модель %j до обращения к DeepSeek',
    async (model) => {
      process.env.DEEPSEEK_API_KEY = 'test-secret';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(
        chatRequest([{ role: 'user', content: 'Вопрос' }], 'text', 500, {
          model,
        }),
      );

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
      expect(JSON.parse(init.body).temperature).toBe(1);
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
      chatRequest([{ role: 'user', content: 'Ответь числом' }], 'json', 500, {
        temperature: 0.4,
      }),
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
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body).temperature).toBe(0.4);
    }
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
