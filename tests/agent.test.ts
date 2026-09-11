import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import type { AgentConfig } from '@/lib/agent';
import type { ChatRequest } from '@/lib/chat-types';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(streamFromChunks(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...createDefaultAgentConfig(), ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Agent', () => {
  it('инкапсулирует конфигурацию и заводит собственную историю', () => {
    const agent = new Agent(config({ model: 'deepseek-v4-pro' }), 'Мой агент');

    expect(agent.name).toBe('Мой агент');
    expect(agent.config.model).toBe('deepseek-v4-pro');
    expect(agent.getSnapshot()).toEqual({
      messages: [],
      isGenerating: false,
      error: null,
    });
  });

  it('присваивает имя по умолчанию на основе модели', () => {
    const agent = new Agent(config({ model: 'deepseek-v4-flash' }));

    expect(agent.name).toBe('Агент · V4 Flash');
  });

  it('строит корректный запрос к /api/chat и передаёт свою конфигурацию', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
      );
    vi.stubGlobal('fetch', fetchMock);

    const agent = new Agent(
      config({
        model: 'deepseek-v4-pro',
        temperature: 0.4,
        outputFormat: 'json',
        targetOutputTokens: 300,
        useSystemPrompt: false,
      }),
    );

    await agent.sendMessage('Привет');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat');
    const body = JSON.parse(init.body as string) as ChatRequest;
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'Привет' }],
      format: 'json',
      targetOutputTokens: 300,
      temperature: 0.4,
      model: 'deepseek-v4-pro',
      useSystemPrompt: false,
      useSelectorSystemPrompt: true,
    });
  });

  it('пробрасывает отключённую целевую длину (null) в запрос как есть', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
      );
    vi.stubGlobal('fetch', fetchMock);

    const agent = new Agent(config({ targetOutputTokens: null }));
    await agent.sendMessage('Привет');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as ChatRequest;
    expect(body.targetOutputTokens).toBeNull();
  });

  it('добавляет текстовый файл в запрос и сохраняет его в истории', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
      );
    vi.stubGlobal('fetch', fetchMock);

    const agent = new Agent(config());
    const file = new File(['Ключ: 42'], 'notes.txt', { type: 'text/plain' });

    await agent.sendMessage('Прочитай файл', [file]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as ChatRequest;
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Прочитай файл' },
          {
            type: 'input_text',
            text: 'Начало файла "notes.txt"\nКлюч: 42\nКонец файла "notes.txt"',
          },
        ],
      },
    ]);
    expect(agent.getSnapshot().messages[0]).toMatchObject({
      content: 'Прочитай файл',
      attachments: [
        {
          kind: 'text',
          name: 'notes.txt',
          mediaType: 'text/plain',
          text: 'Ключ: 42',
        },
      ],
    });
  });

  it('загружает изображение один раз и отправляет в чат его file_id', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/files') {
        return Promise.resolve(
          Response.json({
            file: {
              fileId: 'file-api-picture-1',
              name: 'picture.png',
              mediaType: 'image/png',
              size: 4,
            },
          }),
        );
      }
      return Promise.resolve(
        sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const agent = new Agent(config());
    const file = new File(['image'], 'picture.png', { type: 'image/png' });

    await agent.sendMessage('', [file]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/files');
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    const [, chatInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(chatInit.body as string) as ChatRequest;
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Проанализируй прикреплённые файлы и расскажи главное.',
          },
          { type: 'input_text', text: 'Изображение "picture.png"' },
          { type: 'input_image', file_id: 'file-api-picture-1' },
        ],
      },
    ]);
    expect(agent.getSnapshot().messages[0].attachments?.[0]).toMatchObject({
      kind: 'image',
      fileId: 'file-api-picture-1',
    });
  });

  it('не отправляет изображение моделью без поддержки vision', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const agent = new Agent(config({ model: 'deepseek-v4-pro' }));

    await agent.sendMessage('Что на картинке?', [
      new File(['image'], 'picture.png', { type: 'image/png' }),
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(agent.getSnapshot().error).toContain('DeepSeek Flash');
    expect(agent.getSnapshot().messages).toEqual([]);
  });

  it('не отправляет пустое сообщение и не запускает второй запрос параллельно', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
      );
    vi.stubGlobal('fetch', fetchMock);

    const agent = new Agent(config());

    await agent.sendMessage('   ');
    expect(fetchMock).not.toHaveBeenCalled();

    const first = agent.sendMessage('Первое');
    const second = agent.sendMessage('Второе');
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('накапливает дельты и сохраняет число выходных токенов по завершении', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: delta\ndata: {"content":"При"}\n\n',
            'event: delta\ndata: {"content":"вет"}\n\n',
            'event: done\ndata: {"finishReason":"stop","outputTokens":7}\n\n',
          ]),
        ),
    );

    const agent = new Agent(config());
    const seenContents: string[] = [];
    agent.subscribe(() => {
      const last = agent.getSnapshot().messages.at(-1);
      if (last?.role === 'assistant') seenContents.push(last.content);
    });

    await agent.sendMessage('Привет');

    const snapshot = agent.getSnapshot();
    expect(snapshot.isGenerating).toBe(false);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({
      role: 'user',
      content: 'Привет',
      // "Привет" — 6 символов, оценка ~4 символа/токен, округление вверх.
      messageTokens: 2,
    });
    expect(snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Привет',
      status: 'complete',
      outputTokens: 7,
    });
    expect(seenContents).toContain('При');
    expect(seenContents).toContain('Привет');
  });

  it('сохраняет точное число входных токенов (истории) и кэшированных из события done', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: delta\ndata: {"content":"Ответ"}\n\n',
            'event: done\ndata: {"finishReason":"stop","outputTokens":5,"inputTokens":120,"cachedInputTokens":40}\n\n',
          ]),
        ),
    );

    const agent = new Agent(config());
    await agent.sendMessage('Вопрос');

    const snapshot = agent.getSnapshot();
    expect(snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      outputTokens: 5,
      contextTokens: 120,
      cachedContextTokens: 40,
    });
  });

  it('не добавляет поля контекстных токенов, если событие done их не содержит', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
        ),
    );

    const agent = new Agent(config());
    await agent.sendMessage('Вопрос');

    const assistantMessage = agent.getSnapshot().messages[1];
    expect(assistantMessage.contextTokens).toBeUndefined();
    expect(assistantMessage.cachedContextTokens).toBeUndefined();
    expect(assistantMessage.outputTokens).toBeUndefined();
  });

  it('уведомляет подписчиков на каждое изменение состояния', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse(['event: done\ndata: {"finishReason":"stop"}\n\n']),
        ),
    );

    const agent = new Agent(config());
    const listener = vi.fn();
    const unsubscribe = agent.subscribe(listener);

    await agent.sendMessage('Привет');

    expect(listener).toHaveBeenCalled();
    const callsBeforeUnsubscribe = listener.mock.calls.length;
    unsubscribe();
    agent.clearHistory();
    expect(listener.mock.calls.length).toBe(callsBeforeUnsubscribe);
  });

  it('помечает ответ как остановленный при вызове stop()', async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            resolveFetch = resolve;
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      ),
    );

    const agent = new Agent(config());
    const sendPromise = agent.sendMessage('Привет');

    expect(agent.getSnapshot().isGenerating).toBe(true);
    agent.stop();
    await sendPromise;
    void resolveFetch;

    const snapshot = agent.getSnapshot();
    expect(snapshot.isGenerating).toBe(false);
    expect(snapshot.error).toBeNull();
    // The empty streaming assistant placeholder is dropped; only the user
    // turn survives a stop with no partial content.
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].role).toBe('user');
  });

  it('сохраняет частичный ответ со статусом "stopped" при остановке', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(
          encoder.encode('event: delta\ndata: {"content":"Часть"}\n\n'),
        );
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            resolve(
              new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
              }),
            );
            init.signal?.addEventListener('abort', () => {
              controllerRef?.error(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              );
            });
          }),
      ),
    );

    const agent = new Agent(config());
    const sendPromise = agent.sendMessage('Привет');

    // Give the stream a tick to deliver the first delta before aborting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    agent.stop();
    await sendPromise;

    const snapshot = agent.getSnapshot();
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Часть',
      status: 'stopped',
    });
  });

  it('переводит сетевую ошибку в сообщение об ошибке и удаляет пустой ответ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    const agent = new Agent(config());
    await agent.sendMessage('Привет');

    const snapshot = agent.getSnapshot();
    expect(snapshot.isGenerating).toBe(false);
    expect(snapshot.error).toBe('network down');
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].role).toBe('user');
  });

  it('переводит ошибку API (не ok) в понятное сообщение', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: { code: 'rate_limit', message: 'Слишком много запросов' },
          },
          { status: 429 },
        ),
      ),
    );

    const agent = new Agent(config());
    await agent.sendMessage('Привет');

    expect(agent.getSnapshot().error).toBe('Слишком много запросов');
  });

  it('clearHistory() очищает сообщения и ошибку и прерывает активный запрос', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    const agent = new Agent(config());
    await agent.sendMessage('Привет');
    expect(agent.getSnapshot().error).toBe('boom');

    agent.clearHistory();

    const snapshot = agent.getSnapshot();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.error).toBeNull();
  });

  it('dispose() отписывает всех слушателей и прерывает активный запрос', async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const agent = new Agent(config());
    const listener = vi.fn();
    agent.subscribe(listener);

    const sendPromise = agent.sendMessage('Привет');
    agent.dispose();
    await sendPromise;

    const callsAtDispose = listener.mock.calls.length;
    agent.clearHistory();
    expect(listener.mock.calls.length).toBe(callsAtDispose);
  });
});
