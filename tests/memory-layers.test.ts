import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentMemoryPanel } from '@/components/agent-memory-panel';
import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import {
  deserializeAgentSessions,
  loadAgentSessions,
  saveAgentSessions,
} from '@/lib/agent-storage';
import type { ChatRequest } from '@/lib/chat-types';
import type { ContextStrategy } from '@/lib/context-strategy';
import {
  MAX_SHARED_LONG_TERM_MEMORY_ENTRIES,
  SharedLongTermMemory,
} from '@/lib/memory-layers';

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
          encoder.encode('event: done\ndata: {"finishReason":"stop"}\n\n'),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('слои памяти агента', () => {
  it('не считает сообщения краткосрочной памятью', () => {
    const agent = new Agent(createDefaultAgentConfig(), 'Память', {
      id: 'memory-agent',
      createdAt: 1,
      messages: [
        { id: 'one', role: 'user', content: 'Нужен отчёт', status: 'complete' },
      ],
    });

    expect(agent.getMemoryLayers()).toMatchObject({
      shortTerm: {},
      working: [],
      longTerm: [],
    });
    agent.clearHistory();
    expect(agent.getMemoryLayers().shortTerm).toEqual({});
    expect(agent.getSnapshot().messages).toEqual([]);
  });

  it('удаляет факт и переносит другой в общую долговременную память без изменения чата', () => {
    const shared = new SharedLongTermMemory();
    const agent = new Agent(
      createDefaultAgentConfig(),
      'Память',
      {
        id: 'memory-actions',
        createdAt: 1,
        messages: [
          {
            id: 'one',
            role: 'user',
            content: 'Собираем ТЗ',
            status: 'complete',
          },
        ],
        facts: { цель: 'Собрать ТЗ', язык: 'Русский' },
      },
      shared,
    );
    const second = new Agent(
      createDefaultAgentConfig(),
      'Второй',
      undefined,
      shared,
    );

    const markup = renderToStaticMarkup(
      createElement(AgentMemoryPanel, { agent }),
    );
    expect(markup).toContain('Удалить «цель» из краткосрочной памяти');
    expect(markup).toContain('В долговременную');
    expect(agent.deleteShortTermFact('цель')).toBe(true);
    expect(agent.deleteShortTermFact('цель')).toBe(false);
    expect(agent.promoteShortTermFact('язык', 'profile')).toBe(true);
    expect(agent.getMemoryLayers().shortTerm).toEqual({});
    expect(second.getMemoryLayers().longTerm).toMatchObject([
      { key: 'язык', value: 'Русский', kind: 'profile' },
    ]);
    expect(agent.getSnapshot().messages).toHaveLength(1);
    expect(agent.exportState().memoryCutoffMessageId).toBe('one');

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(saveAgentSessions(storage, [agent, second], agent.id, shared)).toBe(
      true,
    );
    const restored = loadAgentSessions(storage);
    expect(restored.agents[0].getMemoryLayers().shortTerm).toEqual({});
    expect(restored.agents[0].exportState().memoryCutoffMessageId).toBe('one');
    expect(restored.agents[1].getMemoryLayers().longTerm[0].key).toBe('язык');

    const id = second.getMemoryLayers().longTerm[0].id;
    expect(second.deleteMemoryEntry('long-term', id)).toBe(true);
    expect(agent.getMemoryLayers().longTerm).toEqual([]);
  });

  it('не теряет исходный факт, если перенос не помещается в общую память', () => {
    const fullMemory = new SharedLongTermMemory(
      Array.from({ length: MAX_SHARED_LONG_TERM_MEMORY_ENTRIES }, (_, i) => ({
        id: `entry-${i}`,
        key: `ключ-${i}`,
        value: `значение-${i}`,
        kind: 'knowledge',
        updatedAt: 1,
      })),
    );
    const agent = new Agent(
      createDefaultAgentConfig(),
      'Агент',
      { id: 'full-memory', createdAt: 1, messages: [], facts: { цель: 'ТЗ' } },
      fullMemory,
    );

    expect(agent.promoteShortTermFact('цель', 'decision')).toBe(false);
    expect(agent.getMemoryLayers().shortTerm).toEqual({ цель: 'ТЗ' });
    expect(agent.getMemoryLayers().longTerm).toHaveLength(
      MAX_SHARED_LONG_TERM_MEMORY_ENTRIES,
    );
  });

  it('сохраняет выбранный слой и категорию, обновляет ключ и очищает только выбранную запись', () => {
    const agent = new Agent(createDefaultAgentConfig());

    expect(agent.saveMemoryEntry('working', 'дедлайн', 'Пятница')).toBe(true);
    expect(
      agent.saveMemoryEntry('long-term', 'язык', 'Русский', 'profile'),
    ).toBe(true);
    expect(
      agent.saveMemoryEntry('long-term', 'архитектура', 'REST API', 'decision'),
    ).toBe(true);
    const originalId = agent.getMemoryLayers().working[0].id;
    expect(agent.saveMemoryEntry('working', 'дедлайн', 'Суббота')).toBe(true);
    expect(agent.getMemoryLayers().working).toMatchObject([
      { id: originalId, key: 'дедлайн', value: 'Суббота' },
    ]);
    expect(agent.getMemoryLayers().longTerm).toMatchObject([
      { key: 'язык', kind: 'profile' },
      { key: 'архитектура', kind: 'decision' },
    ]);
    expect(agent.saveMemoryEntry('long-term', 'без типа', 'Значение')).toBe(
      false,
    );
    expect(agent.saveMemoryEntry('working', '', 'Значение')).toBe(false);
    expect(agent.deleteMemoryEntry('working', originalId)).toBe(true);
    expect(agent.getMemoryLayers().working).toEqual([]);
    expect(agent.getMemoryLayers().longTerm).toHaveLength(2);
  });

  it.each<ContextStrategy>([
    'none',
    'sliding-window',
    'sticky-facts',
    'branching',
  ])('передаёт выбранную память модели при стратегии %s', async (strategy) => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        if (request.format === 'json') return Promise.resolve(response('{}'));
        const memoryText = JSON.stringify({
          session: request.messages[0],
          longTerm: request.longTermMemory,
        });
        return Promise.resolve(
          response(
            memoryText.includes('дедлайн') && memoryText.includes('Русский')
              ? 'Отчёт на русском к пятнице.'
              : 'Срок и язык не указаны.',
          ),
        );
      }),
    );
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      contextStrategy: strategy,
    });
    agent.saveMemoryEntry('working', 'дедлайн', 'Пятница');
    agent.saveMemoryEntry('long-term', 'язык', 'Русский', 'profile');

    await agent.sendMessage('Подготовь отчёт');

    const chatRequest = requests.at(-1)!;
    expect(chatRequest.messages[0].role).toBe('assistant');
    expect(chatRequest.messages[0].content).toContain('дедлайн');
    expect(chatRequest.messages[0].content).not.toContain('Русский');
    expect(chatRequest.longTermMemory).toMatchObject([
      { key: 'язык', value: 'Русский', kind: 'profile' },
    ]);
    expect(chatRequest.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Подготовь отчёт',
    });
    expect(agent.getSnapshot().messages.at(-1)?.content).toBe(
      'Отчёт на русском к пятнице.',
    );
  });

  it('меняет контекст и проверяемый ответ после явного сохранения памяти', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        return Promise.resolve(
          response(
            JSON.stringify(request.messages).includes('Пятница')
              ? 'Дедлайн — пятница.'
              : 'Дедлайн не указан.',
          ),
        );
      }),
    );
    const agent = new Agent(createDefaultAgentConfig());

    await agent.sendMessage('Когда дедлайн?');
    expect(agent.getSnapshot().messages.at(-1)?.content).toBe(
      'Дедлайн не указан.',
    );
    agent.saveMemoryEntry('working', 'дедлайн', 'Пятница');
    await agent.sendMessage('Когда дедлайн?');

    const chatRequests = requests.filter(
      (request) => request.format !== 'json',
    );
    expect(chatRequests[0].messages[0].role).toBe('user');
    expect(chatRequests[1].messages[0].content).toContain('Пятница');
    expect(agent.getSnapshot().messages.at(-1)?.content).toBe(
      'Дедлайн — пятница.',
    );
  });

  it('сохраняет память отдельно от истории и восстанавливает после перезапуска', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const agent = new Agent(createDefaultAgentConfig());
    agent.saveMemoryEntry('working', 'задача', 'Собрать ТЗ');
    agent.saveMemoryEntry('long-term', 'стек', 'TypeScript', 'knowledge');
    agent.clearHistory();

    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    expect(restored.getMemoryLayers()).toMatchObject({
      shortTerm: {},
      working: [{ key: 'задача', value: 'Собрать ТЗ' }],
      longTerm: [{ key: 'стек', value: 'TypeScript', kind: 'knowledge' }],
    });
  });

  it('показывает общую запись другому агенту и передаёт её в его API-запрос', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        return Promise.resolve(
          response(
            JSON.stringify(request.longTermMemory).includes('ОРИОН-581')
              ? 'ОРИОН-581'
              : 'нет',
          ),
        );
      }),
    );
    const shared = new SharedLongTermMemory();
    const first = new Agent(
      createDefaultAgentConfig(),
      'Первый',
      undefined,
      shared,
    );
    const second = new Agent(
      createDefaultAgentConfig(),
      'Второй',
      undefined,
      shared,
    );
    const secondChanged = vi.fn();
    second.subscribe(secondChanged);

    expect(first.saveMemoryEntry('working', 'срок', 'Пятница')).toBe(true);
    expect(
      first.saveMemoryEntry('long-term', 'код', 'ОРИОН-581', 'knowledge'),
    ).toBe(true);
    expect(secondChanged).toHaveBeenCalledTimes(1);
    expect(second.getMemoryLayers()).toMatchObject({
      shortTerm: {},
      working: [],
      longTerm: [{ key: 'код', value: 'ОРИОН-581' }],
    });

    await second.sendMessage('Какой код?');
    const chatRequest = requests.find((request) => request.format !== 'json')!;
    expect(chatRequest.messages[0].content).not.toContain('ОРИОН-581');
    expect(chatRequest.longTermMemory).toMatchObject([
      { key: 'код', value: 'ОРИОН-581', kind: 'knowledge' },
    ]);
    expect(chatRequest.messages[0].content).not.toContain('Пятница');
    expect(second.getSnapshot().messages.at(-1)?.content).toBe('ОРИОН-581');
    expect(first.getMemoryLayers().shortTerm).toEqual({});

    const id = second.getMemoryLayers().longTerm[0].id;
    expect(second.deleteMemoryEntry('long-term', id)).toBe(true);
    expect(first.getMemoryLayers().longTerm).toEqual([]);
  });

  it('хранит общую память отдельно от агентов и сохраняет её после удаления всех агентов', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const shared = new SharedLongTermMemory();
    const first = new Agent(
      createDefaultAgentConfig(),
      'Первый',
      undefined,
      shared,
    );
    const second = new Agent(
      createDefaultAgentConfig(),
      'Второй',
      undefined,
      shared,
    );
    first.saveMemoryEntry('long-term', 'язык', 'Русский', 'profile');

    expect(saveAgentSessions(storage, [first, second], first.id, shared)).toBe(
      true,
    );
    const saved = JSON.parse(values.values().next().value!);
    expect(saved.version).toBe(2);
    expect(saved.longTermMemory).toMatchObject([{ key: 'язык' }]);
    expect(saved.agents[0].memoryLayers?.longTerm).toBeUndefined();
    expect(saved.agents[1].memoryLayers?.longTerm).toBeUndefined();

    const restored = loadAgentSessions(storage);
    expect(restored.agents[0].getMemoryLayers().longTerm).toMatchObject([
      { key: 'язык', value: 'Русский' },
    ]);
    expect(restored.agents[1].getMemoryLayers().longTerm).toMatchObject([
      { key: 'язык', value: 'Русский' },
    ]);
    const newAgent = new Agent(
      createDefaultAgentConfig(),
      'Третий',
      undefined,
      restored.longTermMemory,
    );
    expect(newAgent.getMemoryLayers().longTerm[0].value).toBe('Русский');

    expect(saveAgentSessions(storage, [], null, restored.longTermMemory)).toBe(
      true,
    );
    const afterDeletion = loadAgentSessions(storage);
    expect(afterDeletion.agents).toEqual([]);
    expect(afterDeletion.longTermMemory.getEntries()[0].value).toBe('Русский');
  });

  it('объединяет старую память агентов без потери конфликтующих значений', () => {
    const first = new Agent(
      createDefaultAgentConfig(),
      'Агент А',
    ).exportState();
    const second = new Agent(
      createDefaultAgentConfig(),
      'Агент Б',
    ).exportState();
    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 1,
        agents: [
          {
            ...first,
            memoryLayers: {
              longTerm: [
                {
                  id: 'one',
                  key: 'язык',
                  value: 'Русский',
                  kind: 'profile',
                  updatedAt: 1,
                },
                {
                  id: 'two',
                  key: 'стек',
                  value: 'TypeScript',
                  kind: 'knowledge',
                  updatedAt: 1,
                },
              ],
            },
          },
          {
            ...second,
            memoryLayers: {
              longTerm: [
                {
                  id: 'three',
                  key: 'язык',
                  value: 'Английский',
                  kind: 'profile',
                  updatedAt: 2,
                },
                {
                  id: 'four',
                  key: 'стек',
                  value: 'TypeScript',
                  kind: 'knowledge',
                  updatedAt: 2,
                },
              ],
            },
          },
        ],
        activeAgentId: first.id,
      }),
    );

    const entries = restored.longTermMemory.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.value)).toEqual([
      'Русский',
      'TypeScript',
      'Английский',
    ]);
    expect(entries[2].key).toContain('Агент Б');
    expect(restored.agents[0].getMemoryLayers().longTerm).toEqual(entries);
    expect(restored.agents[1].getMemoryLayers().longTerm).toEqual(entries);
  });

  it('изолирует рабочую память веток, но разделяет долговременную', () => {
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      contextStrategy: 'branching',
    });
    agent.saveMemoryEntry('working', 'срок', 'Общий');
    agent.saveMemoryEntry('long-term', 'язык', 'Русский', 'profile');
    const [first, second] = agent.createBranches()!;
    agent.saveMemoryEntry('working', 'срок', 'Сентябрь');

    expect(agent.switchBranch(second)).toBe(true);
    expect(agent.getMemoryLayers().working[0].value).toBe('Общий');
    agent.saveMemoryEntry('working', 'срок', 'Октябрь');
    expect(agent.switchBranch(first)).toBe(true);
    expect(agent.getMemoryLayers().working[0].value).toBe('Сентябрь');
    expect(agent.getMemoryLayers().longTerm[0].value).toBe('Русский');

    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 2,
        agents: [agent.exportState()],
        activeAgentId: agent.id,
        longTermMemory: agent.getMemoryLayers().longTerm,
      }),
    ).agents[0];
    expect(restored.getMemoryLayers().working[0].value).toBe('Сентябрь');
    expect(restored.switchBranch(second)).toBe(true);
    expect(restored.getMemoryLayers().working[0].value).toBe('Октябрь');
    expect(restored.getMemoryLayers().longTerm[0].value).toBe('Русский');
  });

  it('учитывает рабочую память каждой ветки при объединении', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        return Promise.resolve(response('Сводка сохранена.'));
      }),
    );
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      contextStrategy: 'branching',
    });
    const [first, second] = agent.createBranches()!;
    agent.saveMemoryEntry('working', 'вариант', 'Сентябрь');
    agent.switchBranch(second);
    agent.saveMemoryEntry('working', 'вариант', 'Октябрь');

    expect(await agent.mergeBranches(first, second)).toBeTruthy();
    expect(requests[0].messages[0].content).toContain('Сентябрь');
    expect(requests[1].messages[0].content).toContain('Октябрь');
    expect(agent.getMemoryLayers().working).toEqual([]);
  });

  it('отбрасывает повреждённые записи, сохраняя остальную сессию', () => {
    const agent = new Agent(createDefaultAgentConfig());
    const state = agent.exportState();
    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 1,
        agents: [
          {
            ...state,
            memoryLayers: {
              working: [
                { id: 'ok', key: 'цель', value: 'ТЗ', updatedAt: 1 },
                { id: 'bad', key: '', value: 'Ошибка', updatedAt: 1 },
              ],
              longTerm: [
                {
                  id: 'profile',
                  key: 'язык',
                  value: 'Русский',
                  kind: 'profile',
                  updatedAt: 1,
                },
                {
                  id: 'invalid',
                  key: 'секрет',
                  value: 'Не сохранять',
                  kind: 'other',
                  updatedAt: 1,
                },
              ],
            },
          },
        ],
        activeAgentId: state.id,
      }),
    );

    expect(restored.agents).toHaveLength(1);
    expect(restored.agents[0].getMemoryLayers().working).toHaveLength(1);
    expect(restored.agents[0].getMemoryLayers().longTerm).toHaveLength(1);
  });
});
