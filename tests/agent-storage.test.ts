import { describe, expect, it } from 'vitest';

import {
  Agent,
  createDefaultAgentConfig,
  type PersistedAgentState,
} from '@/lib/agent';
import {
  AGENT_SESSIONS_STORAGE_KEY,
  deserializeAgentSessions,
  loadAgentSessions,
  saveAgentSessions,
} from '@/lib/agent-storage';

function agentState(
  overrides: Partial<PersistedAgentState> = {},
): PersistedAgentState {
  return {
    id: 'agent-1',
    name: 'Сохранённый агент',
    config: createDefaultAgentConfig(),
    createdAt: 123,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Привет',
        status: 'complete',
      },
      {
        id: 'message-2',
        role: 'assistant',
        content: 'Здравствуйте!',
        status: 'complete',
        format: 'text',
        outputTokens: 4,
      },
    ],
    ...overrides,
  };
}

describe('долговременное хранение сессий агентов', () => {
  it('сохраняет и восстанавливает объект агента, историю и активную сессию', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const state = agentState();
    const agent = new Agent(state.config, state.name, state);

    expect(saveAgentSessions(storage, [agent], agent.id)).toBe(true);
    expect(values.has(AGENT_SESSIONS_STORAGE_KEY)).toBe(true);

    const restored = loadAgentSessions(storage);
    expect(restored.activeAgentId).toBe(agent.id);
    expect(restored.agents).toHaveLength(1);
    expect(restored.agents[0]).toBeInstanceOf(Agent);
    expect(restored.agents[0].exportState()).toEqual(state);
  });

  it('помечает частичный поток остановленным и удаляет пустой плейсхолдер', () => {
    const state = agentState({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Привет',
          status: 'complete',
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'Частичный ответ',
          status: 'streaming',
          format: 'text',
        },
        {
          id: 'message-3',
          role: 'assistant',
          content: '',
          status: 'streaming',
          format: 'text',
        },
      ],
    });
    const restored = deserializeAgentSessions(
      JSON.stringify({ version: 1, agents: [state], activeAgentId: state.id }),
    );

    expect(restored.agents[0].getSnapshot().messages).toHaveLength(2);
    expect(restored.agents[0].getSnapshot().messages[1]).toMatchObject({
      content: 'Частичный ответ',
      status: 'stopped',
    });
  });

  it('игнорирует повреждённые данные, неизвестную версию и дубликаты id', () => {
    expect(deserializeAgentSessions('{')).toEqual({
      agents: [],
      activeAgentId: null,
    });
    expect(
      deserializeAgentSessions(
        JSON.stringify({ version: 2, agents: [], activeAgentId: null }),
      ),
    ).toEqual({ agents: [], activeAgentId: null });

    const valid = agentState();
    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 1,
        agents: [valid, valid, { ...valid, id: '' }],
        activeAgentId: valid.id,
      }),
    );
    expect(restored.agents).toHaveLength(1);
  });

  it('не ломает приложение, если браузерное хранилище недоступно', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage full');
      },
    };

    expect(loadAgentSessions(storage)).toEqual({
      agents: [],
      activeAgentId: null,
    });
    expect(saveAgentSessions(storage, [], null)).toBe(false);
  });
});
