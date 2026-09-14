import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentChat } from '@/components/agent-chat';
import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import { loadAgentSessions, saveAgentSessions } from '@/lib/agent-storage';
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

  it('показывает checkpoint, создание и переключение веток в интерфейсе', () => {
    const agent = createAgent('branching');
    const markup = renderToStaticMarkup(createElement(AgentChat, { agent }));

    expect(markup).toContain('Ветки диалога');
    expect(markup).toContain('Сделать checkpoint');
    expect(markup).toContain('Создать 2 ветки');
    expect(markup).toContain('Основная');
  });
});
