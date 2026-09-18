import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import { loadAgentSessions, saveAgentSessions } from '@/lib/agent-storage';
import type { ChatRequest } from '@/lib/chat-types';
import { MemoryCurator, parseMemoryCuration } from '@/lib/memory-curator';
import { SharedLongTermMemory } from '@/lib/memory-layers';

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

function isMemoryRequest(request: ChatRequest): boolean {
  const prompt = request.messages[0]?.content;
  return (
    typeof prompt === 'string' &&
    prompt.startsWith('Ты отдельный агент управления памятью')
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('автоматическая память', () => {
  it('передаёт прежнюю долговременную память анализатору отдельно от его сообщения', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string) as ChatRequest);
        return Promise.resolve(response('{"shortTerm":{},"longTerm":[]}'));
      }),
    );

    await new MemoryCurator().analyze({
      shortTerm: {},
      longTerm: [
        {
          id: 'language',
          key: 'язык',
          value: 'Русский',
          kind: 'profile',
          updatedAt: 1,
        },
      ],
      recentDialogue: 'Пользователь: Продолжим',
      signal: new AbortController().signal,
    });

    expect(requests[0].longTermMemory).toEqual([
      { key: 'язык', value: 'Русский', kind: 'profile' },
    ]);
    expect(JSON.stringify(requests[0].messages)).not.toContain('"язык"');
  });

  it('вызывает отдельного LLM-агента, сохраняет факты отдельно от истории и делится устойчивым знанием', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        return Promise.resolve(
          response(
            isMemoryRequest(request)
              ? JSON.stringify({
                  shortTerm: { цель: 'Собрать ТЗ' },
                  longTerm: [
                    { key: 'язык', value: 'Русский', kind: 'profile' },
                  ],
                })
              : 'Начнём собирать ТЗ.',
          ),
        );
      }),
    );
    const shared = new SharedLongTermMemory();
    const agent = new Agent(
      createDefaultAgentConfig(),
      'Первый',
      undefined,
      shared,
    );

    await agent.sendMessage('Собираем ТЗ. Отвечай по-русски.');

    expect(requests).toHaveLength(2);
    expect(requests[0].format).toBe('json');
    expect(requests[0].messages[0].content).toContain('Собираем ТЗ');
    expect(requests[1].messages[0].content).toContain('"цель":"Собрать ТЗ"');
    expect(requests[1].messages[0].content).not.toContain('"язык"');
    expect(requests[1].longTermMemory).toEqual([
      { key: 'язык', value: 'Русский', kind: 'profile' },
    ]);
    expect(agent.getMemoryLayers().shortTerm).toEqual({ цель: 'Собрать ТЗ' });
    expect(agent.getSnapshot().messages).toHaveLength(2);
    expect(agent.getSnapshot().messages[0].content).toContain('Собираем ТЗ');
    expect(shared.getEntries()).toMatchObject([
      { key: 'язык', value: 'Русский', kind: 'profile' },
    ]);

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(saveAgentSessions(storage, [agent], agent.id, shared)).toBe(true);
    const restored = loadAgentSessions(storage);
    expect(restored.agents[0].getMemoryLayers().shortTerm).toEqual({
      цель: 'Собрать ТЗ',
    });
    expect(restored.agents[0].getSnapshot().messages).toHaveLength(2);
    const second = new Agent(
      createDefaultAgentConfig(),
      'Второй',
      undefined,
      restored.longTermMemory,
    );
    expect(second.getMemoryLayers().shortTerm).toEqual({});
    expect(second.getMemoryLayers().longTerm[0].value).toBe('Русский');
  });

  it('не блокирует основной ответ и сохраняет старую память при ошибке анализатора', async () => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        requests.push(request);
        return Promise.resolve(
          isMemoryRequest(request)
            ? Response.json(
                { error: { code: 'failed', message: 'Сбой анализатора' } },
                { status: 503 },
              )
            : response('Основной ответ.'),
        );
      }),
    );
    const agent = new Agent(createDefaultAgentConfig(), 'Агент', {
      id: 'restored',
      createdAt: 1,
      messages: [],
      facts: { цель: 'Собрать ТЗ' },
    });

    await agent.sendMessage('Продолжим');

    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0].content).toContain('Собрать ТЗ');
    expect(agent.getMemoryLayers().shortTerm).toEqual({ цель: 'Собрать ТЗ' });
    expect(agent.getSnapshot().messages.at(-1)?.content).toBe(
      'Основной ответ.',
    );
    expect(agent.getSnapshot().error).toBeNull();
    expect(agent.getMemoryAnalysisStatus().error).toBe('Сбой анализатора');
  });

  it('не перечитывает старые реплики после ручного удаления факта, в том числе после перезапуска', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const agent = new Agent(createDefaultAgentConfig(), 'Агент', {
      id: 'forget-test',
      createdAt: 1,
      messages: [
        {
          id: 'old-user',
          role: 'user',
          content: 'Кодовое слово СИРИУС-42',
          status: 'complete',
        },
        {
          id: 'old-assistant',
          role: 'assistant',
          content: 'Запомнила',
          status: 'complete',
        },
      ],
      facts: { код: 'СИРИУС-42' },
    });
    expect(agent.deleteShortTermFact('код')).toBe(true);
    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    let curatorPrompt = '';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        if (isMemoryRequest(request)) {
          curatorPrompt = request.messages[0].content as string;
          return Promise.resolve(response('{"shortTerm":{},"longTerm":[]}'));
        }
        return Promise.resolve(response('Продолжим.'));
      }),
    );

    await restored.sendMessage('Привет');

    expect(curatorPrompt).toContain('Пользователь: Привет');
    expect(curatorPrompt).not.toContain('СИРИУС-42');
    expect(restored.getMemoryLayers().shortTerm).toEqual({});
    expect(restored.getSnapshot().messages).toHaveLength(4);
  });

  it('держит извлечённые факты независимо по веткам', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as ChatRequest;
        const content = request.messages[0]?.content;
        const prompt = typeof content === 'string' ? content : '';
        if (isMemoryRequest(request)) {
          const value = prompt.includes('Вариант А') ? 'Сентябрь' : 'Октябрь';
          return Promise.resolve(
            response(
              JSON.stringify({ shortTerm: { срок: value }, longTerm: [] }),
            ),
          );
        }
        return Promise.resolve(response('Принято.'));
      }),
    );
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      contextStrategy: 'branching',
    });
    const [first, second] = agent.createBranches()!;
    await agent.sendMessage('Вариант А — срок сентябрь');
    expect(agent.getMemoryLayers().shortTerm).toEqual({ срок: 'Сентябрь' });
    agent.switchBranch(second);
    expect(agent.getMemoryLayers().shortTerm).toEqual({});
    await agent.sendMessage('Вариант Б — срок октябрь');
    expect(agent.getMemoryLayers().shortTerm).toEqual({ срок: 'Октябрь' });
    agent.switchBranch(first);
    expect(agent.getMemoryLayers().shortTerm).toEqual({ срок: 'Сентябрь' });

    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    expect(restored.getMemoryLayers().shortTerm).toEqual({ срок: 'Сентябрь' });
    restored.switchBranch(second);
    expect(restored.getMemoryLayers().shortTerm).toEqual({ срок: 'Октябрь' });
  });

  it('отбрасывает некорректные или неподтверждённые поля JSON', () => {
    expect(parseMemoryCuration({ shortTerm: [], longTerm: [] })).toBeNull();
    expect(parseMemoryCuration({ shortTerm: {}, longTerm: 'oops' })).toBeNull();
    expect(
      parseMemoryCuration({
        shortTerm: { цель: 'ТЗ' },
        longTerm: [
          { key: 'секрет', value: '123', kind: 'unknown' },
          { key: 'язык', value: 'Русский', kind: 'profile' },
        ],
      }),
    ).toEqual({
      shortTerm: { цель: 'ТЗ' },
      longTerm: [{ key: 'язык', value: 'Русский', kind: 'profile' }],
    });
  });
});
