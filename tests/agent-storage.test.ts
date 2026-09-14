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
    contextSummary: null,
    facts: {},
    branches: [],
    activeBranchId: 'main',
    checkpointMessageId: null,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Привет',
        status: 'complete',
        messageTokens: 2,
        attachments: [
          {
            id: 'attachment-1',
            kind: 'text',
            name: 'notes.txt',
            mediaType: 'text/plain',
            size: 12,
            text: 'Важная заметка',
          },
          {
            id: 'attachment-2',
            kind: 'image',
            name: 'diagram.png',
            mediaType: 'image/png',
            size: 1024,
            fileId: 'file-api-image-1',
          },
        ],
      },
      {
        id: 'message-2',
        role: 'assistant',
        content: 'Здравствуйте!',
        status: 'complete',
        format: 'text',
        contextTokens: 24,
        cachedContextTokens: 8,
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

  it('восстанавливает агента с отключённым ограничением длины', () => {
    const state = agentState({
      config: {
        ...createDefaultAgentConfig(),
        targetOutputTokens: null,
      },
    });

    const restored = deserializeAgentSessions(
      JSON.stringify({ version: 1, agents: [state], activeAgentId: state.id }),
    );

    expect(restored.agents).toHaveLength(1);
    expect(restored.agents[0].config.targetOutputTokens).toBeNull();
  });

  it('восстанавливает настройки контекста и мигрирует старые сессии', () => {
    const limitedState = agentState({
      config: {
        ...createDefaultAgentConfig(),
        contextWindowTokens: 2000,
        contextStrategy: 'none',
      },
    });
    const legacyState = agentState({ id: 'legacy-agent' });
    const legacyConfig = { ...legacyState.config } as Record<string, unknown>;
    delete legacyConfig.contextWindowTokens;
    delete legacyConfig.contextStrategy;
    legacyConfig.useContextCompression = true;

    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 1,
        agents: [limitedState, { ...legacyState, config: legacyConfig }],
        activeAgentId: limitedState.id,
      }),
    );

    expect(restored.agents[0].config.contextWindowTokens).toBe(2000);
    expect(restored.agents[0].config.contextStrategy).toBe('none');
    expect(restored.agents[1].config.contextWindowTokens).toBe(1_000_000);
    expect(restored.agents[1].config.contextStrategy).toBe('sticky-facts');
  });

  it('переносит старую summary в facts при восстановлении', () => {
    const state = agentState({
      config: {
        ...createDefaultAgentConfig(),
        contextStrategy: 'sticky-facts',
      },
      contextSummary: {
        content: 'Пользователь работает над агентом с DeepSeek.',
        summarizedMessageCount: 10,
        lastSummarizedMessageId: 'message-1',
        updatedAt: 456,
      },
    });

    const restored = deserializeAgentSessions(
      JSON.stringify({ version: 1, agents: [state], activeAgentId: state.id }),
    );

    expect(restored.agents[0].getFacts().previous_summary).toBe(
      'Пользователь работает над агентом с DeepSeek.',
    );
    expect(restored.agents[0].exportState().contextSummary).toBeNull();
    expect(restored.agents[0].getSnapshot().messages).toEqual(state.messages);
  });

  it('сохраняет совместимость со сессиями без summary и игнорирует повреждённую сводку', () => {
    const stateWithoutSummary = agentState();
    const { contextSummary: _contextSummary, ...legacyState } =
      stateWithoutSummary;
    const invalidSummaryState = {
      ...agentState({ id: 'agent-2' }),
      contextSummary: {
        content: '',
        summarizedMessageCount: -1,
        lastSummarizedMessageId: '',
        updatedAt: Number.NaN,
      },
    };
    const legacySummaryState = {
      ...agentState({ id: 'agent-3' }),
      contextSummary: {
        content: 'Сводка из предыдущей версии.',
        summarizedMessageCount: 10,
        updatedAt: 789,
      },
    };

    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 1,
        agents: [legacyState, invalidSummaryState, legacySummaryState],
        activeAgentId: legacyState.id,
      }),
    );

    expect(restored.agents).toHaveLength(3);
    expect(restored.agents[0].exportState().contextSummary).toBeNull();
    expect(restored.agents[1].exportState().contextSummary).toBeNull();
    expect(restored.agents[2].exportState().contextSummary).toBeNull();
  });

  it('игнорирует повреждённые значения счётчиков токенов', () => {
    const state = agentState({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Привет',
          status: 'complete',
          messageTokens: -1,
        },
        {
          id: 'message-2',
          role: 'assistant',
          content: 'Здравствуйте!',
          status: 'complete',
          contextTokens: Number.NaN,
          cachedContextTokens: 1.5,
          outputTokens: -4,
        },
      ],
    });

    const restored = deserializeAgentSessions(
      JSON.stringify({ version: 1, agents: [state], activeAgentId: state.id }),
    );

    expect(restored.agents[0].getSnapshot().messages).toEqual([
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
      },
    ]);
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
