import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentChat } from '@/components/agent-chat';
import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import { loadAgentSessions, saveAgentSessions } from '@/lib/agent-storage';
import { estimateTokenCount } from '@/lib/chat-constraints';
import type { ChatMessage, ChatRequest } from '@/lib/chat-types';
import type { ContextStrategy } from '@/lib/context-strategy';

const requirementsTurns = [
  'Собираем ТЗ для сервиса бронирования переговорок.',
  'Зафиксировала цель. Кто будет пользоваться сервисом?',
  'Сотрудники компании, вход через корпоративный SSO.',
  'Записала аудиторию и способ входа. Нужны ли роли?',
  'Да: сотрудник, администратор переговорок и офис-менеджер.',
  'Роли добавлены. Какие правила бронирования?',
  'Бронь не дольше 4 часов, отмена без ограничений.',
  'Правила записаны. Нужны ли уведомления?',
  'Да, письмо за 15 минут до начала встречи.',
  'Добавила напоминание. Какие интеграции требуются?',
  'Синхронизация с корпоративным календарём.',
  'Интеграция с календарём добавлена. Остались сроки запуска.',
];
const requirementsHistory: ChatMessage[] = requirementsTurns.map(
  (content, index) => ({
    id: `turn-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    status: 'complete',
  }),
);

function response(content: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: delta\ndata: ${JSON.stringify({ content })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            'event: done\ndata: {"finishReason":"stop","inputTokens":80}\n\n',
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function createAgent(strategy: ContextStrategy): Agent {
  return new Agent(
    { ...createDefaultAgentConfig(), contextStrategy: strategy },
    'Собираем ТЗ',
    {
      id: `requirements-${strategy}`,
      createdAt: 123,
      messages: requirementsHistory,
    },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('четыре стратегии на одном сценарии ТЗ из 12 сообщений', () => {
  it('без сжатия отправляет все 13 сообщений и хранит 14 с ответом', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as ChatRequest);
        return Promise.resolve(response('ТЗ дополнено'));
      }),
    );
    const agent = createAgent('none');

    await agent.sendMessage('Добавим ограничение по срокам');

    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toHaveLength(13);
    expect(requests[0].messages[0].content).toBe(requirementsTurns[0]);
    expect(agent.exportState().messages).toHaveLength(14);
  });

  it('Sliding Window отправляет только последние 10, сохраняя все 14 для UI', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as ChatRequest);
        return Promise.resolve(response('ТЗ дополнено'));
      }),
    );
    const agent = createAgent('sliding-window');

    await agent.sendMessage('Добавим ограничение по срокам');

    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toHaveLength(10);
    expect(requests[0].messages[0].content).toBe(requirementsTurns[3]);
    expect(requests[0].messages.at(-1)?.content).toBe(
      'Добавим ограничение по срокам',
    );
    expect(agent.exportState().messages).toHaveLength(14);
  });

  it('Sticky Facts обновляет память, отправляет facts + 10 сообщений и восстанавливает её', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        return Promise.resolve(
          response(
            request.format === 'json'
              ? '{"цель":"Собрать ТЗ","ограничения":"Сроки"}'
              : 'ТЗ дополнено',
          ),
        );
      }),
    );
    const agent = createAgent('sticky-facts');

    await agent.sendMessage('Добавим ограничение по срокам');

    expect(requests).toHaveLength(2);
    expect(requests[0].format).toBe('json');
    expect(requests[0].messages[0].content).toContain(
      'Добавим ограничение по срокам',
    );
    expect(requests[1].messages).toHaveLength(11);
    expect(requests[1].messages[0].content).toContain('"ограничения":"Сроки"');
    expect(requests[1].messages[1].content).toBe(requirementsTurns[3]);
    expect(agent.exportState().messages).toHaveLength(14);

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    expect(restored.getFacts()).toEqual({
      цель: 'Собрать ТЗ',
      ограничения: 'Сроки',
    });
    expect(restored.getSnapshot().messages).toHaveLength(14);
  });

  it('Branching создаёт две независимые ветки от checkpoint и восстанавливает их', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as ChatRequest);
        return Promise.resolve(response('Вариант ТЗ принят'));
      }),
    );
    const agent = createAgent('branching');
    expect(agent.createCheckpoint('turn-6')).toBe(true);
    const branchIds = agent.createBranches();
    expect(branchIds).not.toBeNull();
    const [first, second] = branchIds!;

    await agent.sendMessage('Вариант А: запускаем в сентябре');
    expect(agent.switchBranch(second)).toBe(true);
    await agent.sendMessage('Вариант Б: запускаем в октябре');

    expect(requests).toHaveLength(2);
    expect(requests[0].messages).toHaveLength(7);
    expect(requests[1].messages).toHaveLength(7);
    expect(requests[0].messages.at(-1)?.content).toContain('сентябре');
    expect(requests[1].messages.at(-1)?.content).toContain('октябре');
    expect(JSON.stringify(requests[1])).not.toContain('сентябре');
    expect(agent.switchBranch(first)).toBe(true);
    expect(agent.getSnapshot().messages).toHaveLength(8);
    expect(agent.getSnapshot().messages[6].content).toContain('сентябре');
    expect(agent.switchBranch('main')).toBe(true);
    expect(agent.getSnapshot().messages).toHaveLength(12);

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    expect(restored.getBranches()).toHaveLength(3);
    expect(restored.switchBranch(second)).toBe(true);
    expect(restored.getSnapshot().messages[6].content).toContain('октябре');
    expect(restored.switchBranch(first)).toBe(true);
    expect(restored.getSnapshot().messages[6].content).toContain('сентябре');
  });

  it('создаёт две ветки от последнего ответа без ручного checkpoint', () => {
    const agent = createAgent('branching');

    const branchIds = agent.createBranches();

    expect(branchIds).not.toBeNull();
    expect(agent.getSnapshot().messages).toHaveLength(12);
    expect(agent.getBranches()).toHaveLength(3);
    expect(agent.switchBranch('main')).toBe(true);
    expect(agent.getSnapshot().messages).toHaveLength(12);
  });

  it('разрешает создать ветки от начала пустого диалога', () => {
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      contextStrategy: 'branching',
    });

    expect(agent.createBranches()).not.toBeNull();
    expect(agent.getBranches()).toHaveLength(3);
    expect(agent.getSnapshot().messages).toHaveLength(0);
  });

  it('суммаризирует две ветки отдельно, объединяет summary и продолжает диалог с ним', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        const prompt = request.messages[0]?.content;
        if (
          typeof prompt === 'string' &&
          prompt.startsWith('Суммаризируй ветку')
        ) {
          return Promise.resolve(
            response(
              prompt.includes('сентябре')
                ? 'Вариант А: запуск в сентябре.'
                : 'Вариант Б: запуск в октябре.',
            ),
          );
        }
        if (
          typeof prompt === 'string' &&
          prompt.startsWith('Объедини две сводки')
        ) {
          return Promise.resolve(
            response(
              'Единое ТЗ: запуск в сентябре или октябре — решение пока не принято.',
            ),
          );
        }
        return Promise.resolve(response('Продолжаем единое ТЗ.'));
      }),
    );
    const agent = createAgent('branching');
    expect(agent.createCheckpoint('turn-6')).toBe(true);
    const [first, second] = agent.createBranches()!;
    await agent.sendMessage('Вариант А: запускаем в сентябре');
    agent.switchBranch(second);
    await agent.sendMessage('Вариант Б: запускаем в октябре');
    const sourceBranches = agent.exportState().branches!;
    const firstMessages = sourceBranches.find(
      (branch) => branch.id === first,
    )!.messages;
    const secondMessages = sourceBranches.find(
      (branch) => branch.id === second,
    )!.messages;

    const mergedId = await agent.mergeBranches(first, second);

    expect(mergedId).toBeTruthy();
    expect(agent.getActiveBranchId()).toBe(mergedId);
    expect(agent.getActiveBranchSummary()).toContain('сентябре или октябре');
    expect(agent.getBranches()).toHaveLength(4);
    expect(agent.getSnapshot().messages).toHaveLength(0);
    expect(agent.getMergeStatus()).toBeNull();
    expect(agent.getSnapshot().error).toBeNull();
    expect(requests).toHaveLength(5);
    expect(requests[2].messages[0].content).toContain('сентябре');
    expect(requests[3].messages[0].content).toContain('октябре');
    expect(requests[4].messages[0].content).toContain(
      'Вариант А: запуск в сентябре.',
    );
    expect(requests[4].messages[0].content).toContain(
      'Вариант Б: запуск в октябре.',
    );
    for (const summaryRequest of requests.slice(2, 5)) {
      expect(summaryRequest.targetOutputTokens).toBeNull();
      expect(summaryRequest.maxOutputTokens).toBe(8192);
      expect(summaryRequest.useSystemPrompt).toBe(false);
    }
    expect(
      agent.exportState().branches!.find((branch) => branch.id === first)!
        .messages,
    ).toEqual(firstMessages);
    expect(
      agent.exportState().branches!.find((branch) => branch.id === second)!
        .messages,
    ).toEqual(secondMessages);

    await agent.sendMessage('Сформируй итоговое ТЗ');
    expect(requests[5].messages[0].content).toContain('Единое ТЗ');
    expect(requests[5].messages.at(-1)?.content).toBe('Сформируй итоговое ТЗ');
    expect(JSON.stringify(requests[5])).not.toContain('Вариант А: запускаем');

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    expect(restored.getActiveBranchSummary()).toContain('сентябре или октябре');
    const mergedMarkup = renderToStaticMarkup(
      createElement(AgentChat, { agent: restored }),
    );
    expect(mergedMarkup).toContain('Объединённое summary');
    expect(mergedMarkup).toContain('решение пока не принято');
    expect(restored.switchBranch(first)).toBe(true);
    expect(restored.getSnapshot().messages).toEqual(firstMessages);
    expect(restored.switchBranch(second)).toBe(true);
    expect(restored.getSnapshot().messages).toEqual(secondMessages);
    expect(restored.switchBranch(mergedId!)).toBe(true);
    const forkedMergedBranches = restored.createBranches();
    expect(forkedMergedBranches).not.toBeNull();
    expect(restored.getActiveBranchSummary()).toContain('сентябре или октябре');
  });

  it('суммаризирует длинную ветку партиями и не создаёт слияние при ошибке API', async () => {
    const requests: ChatRequest[] = [];
    let summaryCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        summaryCalls += 1;
        if (summaryCalls === 3) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: 'api_error', message: 'Сбой суммаризации' },
              }),
              { status: 500, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(response(`Часть ${summaryCalls}`));
      }),
    );
    const agent = createAgent('branching');
    expect(agent.createCheckpoint('turn-6')).toBe(true);
    const [first] = agent.createBranches()!;
    const activeBefore = agent.getActiveBranchId();

    expect(await agent.mergeBranches('main', first)).toBeNull();
    expect(requests).toHaveLength(3);
    expect(requests[1].messages[0].content).toContain(
      'Предыдущая сводка этой ветки:\nЧасть 1',
    );
    expect(agent.getBranches()).toHaveLength(3);
    expect(agent.getActiveBranchId()).toBe(activeBefore);
    expect(agent.getSnapshot().error).toBe('Сбой суммаризации');
  });

  it('уменьшает размер партий суммаризации при искусственно малом окне', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as ChatRequest);
        return Promise.resolve(response('Краткая сводка ветки.'));
      }),
    );
    const agent = new Agent(
      {
        ...createDefaultAgentConfig(),
        contextStrategy: 'branching',
        contextWindowTokens: 1500,
      },
      'Длинное ТЗ',
      {
        id: 'long-requirements',
        createdAt: 123,
        messages: requirementsHistory.map((message) => ({
          ...message,
          content: `${message.content} ${'Подробность '.repeat(80)}`,
        })),
      },
    );
    const [first] = agent.createBranches()!;

    expect(await agent.mergeBranches('main', first)).toBeTruthy();
    const branchRequests = requests.filter((request) => {
      const content = request.messages[0]?.content;
      return (
        typeof content === 'string' && content.startsWith('Суммаризируй ветку')
      );
    });
    expect(branchRequests.length).toBeGreaterThan(2);
    for (const request of branchRequests) {
      const content = request.messages[0].content;
      if (typeof content !== 'string')
        throw new Error('Ожидался текстовый промпт');
      expect(estimateTokenCount(content)).toBeLessThan(1500);
    }
  });

  it('остановка слияния не создаёт новую ветку и не удаляет старые', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      ),
    );
    const agent = createAgent('branching');
    const [first, second] = agent.createBranches()!;

    const merging = agent.mergeBranches(first, second);
    expect(agent.getMergeStatus()).toContain('Суммаризирую');
    agent.stop();
    expect(await merging).toBeNull();
    expect(agent.getBranches()).toHaveLength(3);
    expect(agent.getSnapshot().error).toBeNull();
    expect(agent.getMergeStatus()).toBeNull();
  });

  it('показывает checkpoint, создание и переключение веток в интерфейсе', () => {
    const agent = createAgent('branching');
    const markup = renderToStaticMarkup(createElement(AgentChat, { agent }));

    expect(markup).toContain('Ветки диалога');
    expect(markup).toContain('Сделать checkpoint');
    expect(markup).toContain('Создать 2 ветки');
    expect(markup).toContain('Основная');
    const createButton = markup.match(
      /<button[^>]*>Создать 2 ветки<\/button>/,
    )?.[0];
    expect(createButton).toBeDefined();
    expect(createButton).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(markup).toContain('Объединить ветки');
  });
});
