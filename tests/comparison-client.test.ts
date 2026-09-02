import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatStreamEvent } from '@/lib/chat-types';
import { requestComparison } from '@/lib/comparison-client';
import type { ComparisonRequest } from '@/lib/comparison';

const request: ComparisonRequest = {
  variant: 4,
  prompt: 'Задача',
  messages: [],
};
const streamResponse = (events: ChatStreamEvent[]) =>
  new Response(
    events
      .map(
        ({ type, ...data }) =>
          `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(''),
  );
afterEach(() => vi.unstubAllGlobals());

describe('запрос отдельного варианта сравнения', () => {
  it('принимает сгенерированный промпт, поток ответа и обе статистики токенов', async () => {
    const expected: ChatStreamEvent[] = [
      { type: 'prepared', prompt: 'Новый промпт', promptOutputTokens: 12 },
      { type: 'delta', content: 'Решение' },
      { type: 'done', finishReason: 'stop', outputTokens: 25 },
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(expected));
    vi.stubGlobal('fetch', fetchMock);
    const events: ChatStreamEvent[] = [];
    const signal = new AbortController().signal;
    await requestComparison(request, signal, (event) => events.push(event));
    expect(events).toEqual(expected);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(request);
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
  });

  it.each([
    {
      label: 'без завершения',
      events: [
        { type: 'prepared', prompt: 'Промпт' },
        { type: 'delta', content: 'Начало' },
      ],
    },
    {
      label: 'пустой',
      events: [
        { type: 'prepared', prompt: 'Промпт' },
        { type: 'done', finishReason: 'stop' },
      ],
    },
    {
      label: 'ошибка',
      events: [
        { type: 'error', code: 'upstream_error', message: 'Ошибка модели' },
      ],
    },
  ] satisfies Array<{ label: string; events: ChatStreamEvent[] }>)(
    'отклоняет ответ $label',
    async ({ events }) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(events)));
      await expect(
        requestComparison(request, new AbortController().signal, () => {}),
      ).rejects.toThrow();
    },
  );

  it('обрабатывает серверную ошибку и не повторяет запрос', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: 'error', message: 'Не удалось создать промпт' } },
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      requestComparison(request, new AbortController().signal, () => {}),
    ).rejects.toThrow('Не удалось создать промпт');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('после отмены не сообщает о завершении ответа', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([
          { type: 'prepared', prompt: 'Промпт' },
          { type: 'delta', content: 'Ответ' },
          { type: 'done', finishReason: 'stop' },
        ]),
      ),
    );
    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    await expect(
      requestComparison(request, controller.signal, (event) => {
        events.push(event);
        controller.abort();
      }),
    ).rejects.toThrow('остановлена');
    expect(events.map((event) => event.type)).toEqual(['prepared']);
  });
});
