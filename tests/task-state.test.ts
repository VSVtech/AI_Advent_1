import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTaskStatePanel } from '@/components/agent-task-state';
import { AgentChat } from '@/components/agent-chat';
import { AgentSidebar } from '@/components/agent-sidebar';
import { TaskSetup } from '@/components/task-setup';
import { TaskWorkspace } from '@/components/task-workspace';
import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import {
  deserializeAgentSessions,
  loadAgentSessions,
  saveAgentSessions,
} from '@/lib/agent-storage';
import type { ChatRequest } from '@/lib/chat-types';
import {
  buildTaskStateSystemPrompt,
  canTransitionTaskPhase,
  invalidTaskTransitionProposal,
  isTaskConfirmation,
  isTaskConfirmationEligible,
  isTaskRollbackConfirmation,
  MAX_TASK_INVARIANTS,
  normalizeTaskInvariants,
  readTaskProgressFromAnswer,
  readTaskRollbackFromAnswer,
  reconcileTaskStateWithHistory,
  restoreTaskState,
  TASK_PHASES,
  TASK_PLAN_REQUEST,
  TASK_TRANSITIONS,
  transitionTaskState,
  type TaskState,
} from '@/lib/task-state';

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
  );
}

function makeTask(
  title = 'Отчёт',
  goal = 'Подготовить отчёт',
  invariants: string[] = [],
): Agent {
  const task = new Agent(
    createDefaultAgentConfig(),
    title,
    undefined,
    undefined,
    undefined,
    'task',
  );
  expect(
    task.dispatchTaskState({ type: 'start', title, goal, invariants }),
  ).toBe(true);
  return task;
}

function mockTaskReplies(...answers: string[]) {
  const requests: ChatRequest[] = [];
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as ChatRequest;
    requests.push(body);
    const first = body.messages[0]?.content;
    if (
      typeof first === 'string' &&
      first.startsWith('Ты отдельный агент управления памятью')
    ) {
      return Promise.resolve(response('{"shortTerm":{},"longTerm":[]}'));
    }
    return Promise.resolve(
      response(answers.shift() ?? 'Ответ без предложения.'),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe('конечный автомат состояния задачи', () => {
  it('хранит инварианты отдельно от диалога и восстанавливает их без изменения', () => {
    const state = transitionTaskState(
      null,
      {
        type: 'start',
        title: 'Сервис',
        goal: 'Спроектировать хранение',
        invariants: ['  Только PostgreSQL  ', 'Не хранить персональные данные'],
      },
      1,
    ) as TaskState;
    expect(state.invariants).toEqual([
      'Только PostgreSQL',
      'Не хранить персональные данные',
    ]);
    expect(restoreTaskState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(buildTaskStateSystemPrompt(state)).toContain(
      'Если запрос несовместим с инвариантом',
    );
    expect(buildTaskStateSystemPrompt(state)).toContain('1. Только PostgreSQL');
    expect(transitionTaskState(state, { type: 'pause' })?.invariants).toEqual(
      state.invariants,
    );
    expect(
      transitionTaskState(
        state,
        {
          type: 'propose',
          expectedAction: 'Подтвердить план',
          awaitingConfirmation: true,
        },
        2,
      )?.invariants,
    ).toEqual(state.invariants);
  });

  it('отклоняет пустые, повторяющиеся и слишком длинные инварианты', () => {
    expect(normalizeTaskInvariants([])).toEqual([]);
    expect(normalizeTaskInvariants([' '])).toBeNull();
    expect(normalizeTaskInvariants(['PostgreSQL', 'postgresql'])).toBeNull();
    expect(normalizeTaskInvariants(['Первая\nВторая'])).toBeNull();
    expect(
      normalizeTaskInvariants(Array(MAX_TASK_INVARIANTS + 1).fill('x')),
    ).toBeNull();
    expect(
      transitionTaskState(null, {
        type: 'start',
        title: 'Сервис',
        goal: 'Сделать',
        invariants: [' ', 'Только PostgreSQL'],
      }),
    ).toBeUndefined();
    expect(
      restoreTaskState({
        phase: 'planning',
        paused: false,
        updatedAt: 1,
        invariants: ['Один', 'один'],
      }),
    ).toBeNull();
  });

  it('не позволяет изменить инварианты через снимок состояния агента', () => {
    const task = makeTask('Сервис', 'Сделать сервис', [
      'Использовать только PostgreSQL',
    ]);
    task.getTaskState()!.invariants[0] = 'Использовать MongoDB';
    expect(task.getTaskState()?.invariants).toEqual([
      'Использовать только PostgreSQL',
    ]);
  });

  it('считает текущим шагом активный этап и переходит только после предложения и подтверждения', () => {
    let state = transitionTaskState(
      null,
      { type: 'start', title: 'Борщ', goal: 'Сварить борщ' },
      1,
    ) as TaskState;
    expect(state).toMatchObject({
      phase: 'planning',
      expectedAction: null,
      awaitingConfirmation: false,
    });
    expect('currentStep' in state).toBe(false);
    expect(
      transitionTaskState(state, { type: 'confirm', message: 'Подтверждаю' }),
    ).toBeUndefined();

    for (const [index, phase] of TASK_PHASES.entries()) {
      expect(state.phase).toBe(phase);
      const paused = transitionTaskState(
        state,
        { type: 'pause' },
        10 + index,
      ) as TaskState;
      expect(paused).toMatchObject({ phase, paused: true });
      expect(transitionTaskState(paused, { type: 'pause' })).toBeUndefined();
      expect(
        transitionTaskState(paused, { type: 'confirm', message: 'Да' }),
      ).toBeUndefined();
      state = transitionTaskState(
        paused,
        { type: 'resume' },
        20 + index,
      ) as TaskState;
      expect(state.paused).toBe(false);
      if (phase === 'done') break;

      state = transitionTaskState(
        state,
        {
          type: 'propose',
          expectedAction: `Проверить результат ${phase}`,
          awaitingConfirmation: true,
        },
        30 + index,
      ) as TaskState;
      expect(state.expectedAction).toBe(`Проверить результат ${phase}`);
      expect(state.awaitingConfirmation).toBe(true);
      expect(
        transitionTaskState(state, {
          type: 'confirm',
          message: 'Не подтверждаю, доработай',
          semanticConfirmed: true,
        }),
      ).toBeUndefined();
      state = transitionTaskState(
        state,
        { type: 'confirm', message: 'Подтверждаю' },
        40 + index,
      ) as TaskState;
      expect(state.phase).toBe(TASK_PHASES[index + 1]);
      expect(state.expectedAction).toBeNull();
      expect(state.awaitingConfirmation).toBe(false);
    }
    expect(transitionTaskState(state, { type: 'reset' })).toBeNull();
  });

  it('разрешает только соседние переходы и отвергает перескакивание', () => {
    expect(TASK_TRANSITIONS).toEqual({
      planning: { forward: 'execution', backward: null },
      execution: { forward: 'validation', backward: 'planning' },
      validation: { forward: 'done', backward: 'execution' },
      done: { forward: null, backward: 'validation' },
    });
    expect(canTransitionTaskPhase('planning', 'validation', 'forward')).toBe(
      false,
    );
    expect(canTransitionTaskPhase('validation', 'planning', 'backward')).toBe(
      false,
    );
    expect(
      invalidTaskTransitionProposal(
        'Предлагаю переход: planning → validation.',
        'planning',
      ),
    ).toContain('недопустимый');
    expect(
      invalidTaskTransitionProposal(
        'Предлагаю откат: validation → planning.',
        'validation',
      ),
    ).toContain('недопустимый');
    expect(
      invalidTaskTransitionProposal(
        'Предлагаю откат: validation → execution.',
        'validation',
      ),
    ).toBeNull();
    expect(
      readTaskRollbackFromAnswer(
        'Обнаружена ошибка.\n**Предлагаю откат:** validation → execution.',
        'validation',
      )?.target,
    ).toBe('execution');
  });

  it.each([
    ['execution', 'planning'],
    ['validation', 'execution'],
    ['done', 'validation'],
  ] as const)(
    'подтверждает откат %s → %s на один этап, а не выполняет его по предложению',
    (phase, target) => {
      let state = transitionTaskState(
        null,
        { type: 'start', title: 'Задача', goal: 'Проверить результат' },
        1,
      ) as TaskState;
      while (state.phase !== phase) {
        state = transitionTaskState(state, {
          type: 'propose',
          expectedAction: 'Подтвердите результат',
          awaitingConfirmation: true,
        }) as TaskState;
        state = transitionTaskState(state, {
          type: 'confirm',
          message: 'Да',
        }) as TaskState;
      }
      if (phase !== 'execution') {
        expect(
          transitionTaskState(state, {
            type: 'proposeRollback',
            target: 'planning',
            reason: 'Ошибка',
          }),
        ).toBeUndefined();
      }
      const proposed = transitionTaskState(state, {
        type: 'proposeRollback',
        target,
        reason: 'Предыдущий этап оказался ошибочным',
      }) as TaskState;
      expect(proposed).toMatchObject({
        phase,
        pendingRollback: true,
        awaitingConfirmation: true,
      });
      expect(
        transitionTaskState(proposed, { type: 'confirm', message: 'Нет' }),
      ).toBeUndefined();
      const paused = transitionTaskState(proposed, {
        type: 'pause',
      }) as TaskState;
      expect(
        transitionTaskState(paused, { type: 'confirm', message: 'Да' }),
      ).toBeUndefined();
      const restored = restoreTaskState(
        JSON.parse(JSON.stringify(paused)),
      ) as TaskState;
      expect(restored.pendingRollback).toBe(true);
      const resumed = transitionTaskState(restored, {
        type: 'resume',
      }) as TaskState;
      const rolledBack = transitionTaskState(resumed, {
        type: 'confirm',
        message: 'Да, откатываемся назад',
      }) as TaskState;
      expect(rolledBack).toMatchObject({
        phase: target,
        rollbackFrom: phase,
        historyRepairDisabled: true,
        awaitingConfirmation: false,
      });
      expect(isTaskRollbackConfirmation('Нет, оставь как есть', phase)).toBe(
        false,
      );
      expect(
        restoreTaskState(JSON.parse(JSON.stringify(rolledBack))),
      ).toMatchObject({
        phase: target,
        rollbackFrom: phase,
        historyRepairDisabled: true,
      });
      const reapproved = transitionTaskState(
        transitionTaskState(rolledBack, {
          type: 'propose',
          expectedAction: 'Утвердить исправленный результат',
          awaitingConfirmation: true,
        }) as TaskState,
        { type: 'confirm', message: 'Подтверждаю' },
      ) as TaskState;
      expect(reapproved.phase).toBe(phase);
      expect(reapproved.rollbackFrom).toBeUndefined();
    },
  );

  it('распознаёт только осмысленное подтверждение результата, не просьбу начать следующий этап', () => {
    expect(isTaskConfirmation('Да', 'planning')).toBe(true);
    expect(isTaskConfirmation('«Подтверждаю»', 'planning')).toBe(true);
    expect(isTaskConfirmation('давай', 'planning')).toBe(true);
    expect(isTaskConfirmation('давай попробуем', 'planning')).toBe(false);
    expect(isTaskConfirmation('План подтверждаю, правок нет', 'planning')).toBe(
      true,
    );
    expect(isTaskConfirmation('Нет правок', 'planning')).toBe(true);
    expect(isTaskConfirmation('done', 'validation')).toBe(true);
    expect(isTaskConfirmation('done', 'planning')).toBe(false);
    expect(isTaskConfirmation('Правок нет, можно переходить', 'planning')).toBe(
      true,
    );
    expect(isTaskConfirmation('Всё устраивает, идём дальше', 'planning')).toBe(
      true,
    );
    expect(
      isTaskConfirmation('План устраивает, переходи к execution', 'planning'),
    ).toBe(true);
    expect(
      isTaskConfirmation(
        'Подтверждаю результат этапа planning и переходи к execution.',
        'planning',
      ),
    ).toBe(true);
    expect(isTaskConfirmation('Перейди к execution', 'planning')).toBe(false);
    expect(
      isTaskConfirmation('Подтверждаю переход к execution', 'planning'),
    ).toBe(false);
    expect(isTaskConfirmation('Не подтверждаю результат', 'planning')).toBe(
      false,
    );
    expect(isTaskConfirmation('План не устраивает', 'planning')).toBe(false);
    expect(
      isTaskConfirmation('Подтверждаю, давай доработаем план', 'planning'),
    ).toBe(false);
    expect(
      isTaskConfirmationEligible('План подтверждаю, правок нет', 'planning'),
    ).toBe(true);
    expect(
      isTaskConfirmationEligible(
        'План подтверждаю, но поправь сроки',
        'planning',
      ),
    ).toBe(false);
    expect(isTaskConfirmation('Давай попробуем', 'planning')).toBe(false);
    expect(
      isTaskConfirmation(
        'Подтверждаю результат planning и переходи к validation',
        'planning',
      ),
    ).toBe(false);
    expect(
      isTaskConfirmation('План подтверждаю, переходи к проверке', 'planning'),
    ).toBe(false);
  });

  it('понимает свободное подтверждение по смыслу до основного запроса', async () => {
    const task = makeTask();
    const requests: ChatRequest[] = [];
    const replies = [
      'План готов.\nОжидаемое действие: оцените план.\nПредлагаю переход: planning → execution.',
      'Приступаю к выполнению.\nОжидаемое действие: оцените промежуточный результат.',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as ChatRequest;
        requests.push(body);
        const first = body.messages[0]?.content;
        if (
          typeof first === 'string' &&
          first.startsWith('Ты классификатор ответа пользователя')
        ) {
          return Promise.resolve(response('{"confirmed":true}'));
        }
        if (
          typeof first === 'string' &&
          first.startsWith('Ты отдельный агент управления памятью')
        ) {
          return Promise.resolve(response('{"shortTerm":{},"longTerm":[]}'));
        }
        return Promise.resolve(response(replies.shift() ?? 'Ответ'));
      }),
    );

    await task.sendMessage('Предложи план');
    expect(task.getTaskState()?.awaitingConfirmation).toBe(true);
    await task.sendMessage('Выглядит хорошо, теперь можно приступать');
    expect(
      requests.some((request) => {
        const content = request.messages[0]?.content;
        return (
          typeof content === 'string' &&
          content.startsWith('Ты классификатор ответа пользователя')
        );
      }),
    ).toBe(true);
    expect(task.getTaskState()?.phase).toBe('execution');
    expect(
      requests
        .find((request) => request.taskState?.phase === 'execution')
        ?.messages.at(-1),
    ).toEqual({
      role: 'user',
      content: 'Выглядит хорошо, теперь можно приступать',
    });
  });

  it.each(['{"confirmed":false}', 'not json'])(
    'при ответе классификатора %s оставляет текущий этап',
    async (classifierAnswer) => {
      const task = makeTask();
      task.dispatchTaskState({
        type: 'propose',
        expectedAction: 'Проверьте план',
        awaitingConfirmation: true,
      });
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as ChatRequest;
        const first = body.messages[0]?.content;
        if (
          typeof first === 'string' &&
          first.startsWith('Ты классификатор ответа пользователя')
        ) {
          return Promise.resolve(response(classifierAnswer));
        }
        if (
          typeof first === 'string' &&
          first.startsWith('Ты отдельный агент управления памятью')
        ) {
          return Promise.resolve(response('{"shortTerm":{},"longTerm":[]}'));
        }
        return Promise.resolve(response('Давайте уточним.'));
      });
      vi.stubGlobal('fetch', fetchMock);
      await task.sendMessage('Кажется, выглядит неплохо');
      expect(task.getTaskState()).toMatchObject({
        phase: 'planning',
        awaitingConfirmation: false,
      });
      expect(fetchMock).toHaveBeenCalled();
    },
  );

  it('пауза отменяет смысловую проверку без перехода этапа', async () => {
    const task = makeTask();
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Проверьте план',
      awaitingConfirmation: true,
    });
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = task.sendMessage('Выглядит хорошо, можно начинать');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(task.dispatchTaskState({ type: 'pause' })).toBe(true);
    await pending;
    expect(task.getTaskState()).toMatchObject({
      phase: 'planning',
      awaitingConfirmation: true,
      paused: true,
    });
  });

  it('сохраняет предложенное LLM действие только из завершённого ответа текущего этапа', () => {
    expect(
      readTaskProgressFromAnswer(
        'План готов.\nОжидаемое действие: изучите план.\nПредлагаю переход: planning → execution. Подтвердите результат в чате.',
        'planning',
      ),
    ).toEqual({
      expectedAction: 'изучите план.',
      awaitingConfirmation: true,
    });
    expect(
      readTaskProgressFromAnswer(
        'Уточните требования.\nОжидаемое действие: ответьте на вопрос.',
        'planning',
      ),
    ).toEqual({
      expectedAction: 'ответьте на вопрос.',
      awaitingConfirmation: false,
    });
    expect(
      readTaskProgressFromAnswer(
        'Ожидаемое действие: изучите план.\nПредлагаю переход: planning → validation.',
        'planning',
      )?.awaitingConfirmation,
    ).toBe(false);
    expect(readTaskProgressFromAnswer('План готов.', 'planning')).toBeNull();
    expect(
      readTaskProgressFromAnswer(
        'Ожидаемое действие: подтвердите результат этапа validation своими словами — например, что рецепт проверен. Предлагаю переход: validation → done. Пожалуйста, подтвердите результат.',
        'validation',
      ),
    ).toEqual({
      expectedAction:
        'подтвердите результат этапа validation своими словами — например, что рецепт проверен.',
      awaitingConfirmation: true,
    });
    expect(
      readTaskProgressFromAnswer(
        'План приготовления борща готов.\nОжидаемое действие: подтвердите план своими словами или уточните вид мяса на кости, кислоту и капусту, чтобы я доработал его перед переходом.',
        'planning',
      ),
    ).toMatchObject({ awaitingConfirmation: true });
    expect(
      readTaskProgressFromAnswer(
        'Задача завершена, дополнительных действий не требуется.',
        'validation',
      ),
    ).toEqual({
      expectedAction:
        'Подтвердите результат этапа validation своими словами, чтобы перейти к done.',
      awaitingConfirmation: true,
    });
    expect(
      readTaskProgressFromAnswer(
        'Задача не завершена: обнаружены ошибки.',
        'validation',
      ),
    ).toBeNull();
  });

  it('принимает подтверждение плана без технической строки перехода до вызова модели', async () => {
    const task = makeTask('Борщ', 'Приготовить борщ');
    const { requests } = mockTaskReplies(
      'План: подготовить продукты, сварить бульон, добавить овощи.\nОжидаемое действие: подтвердите план своими словами или уточните детали, чтобы я доработал его перед переходом.',
      'Приступаю к приготовлению по утверждённому плану.',
    );
    await task.sendMessage('Предложи план борща');
    expect(task.getTaskState()).toMatchObject({
      phase: 'planning',
      awaitingConfirmation: true,
    });
    await task.sendMessage('подтверждаю. Давай варить');
    expect(task.getTaskState()?.phase).toBe('execution');
    expect(
      requests
        .find((request) => request.taskState?.phase === 'execution')
        ?.messages.at(-1),
    ).toEqual({ role: 'user', content: 'подтверждаю. Давай варить' });
    expect(isTaskConfirmation('подтверждаю. Давай варить', 'planning')).toBe(
      true,
    );
  });

  it('после ошибки ответа восстанавливает уже отправленное подтверждение плана', () => {
    const taskState: TaskState = {
      title: 'Борщ',
      goal: 'Приготовить борщ',
      invariants: [],
      phase: 'planning',
      expectedAction: 'подтвердите план своими словами',
      awaitingConfirmation: false,
      paused: false,
      updatedAt: 1,
    };
    const restored = new Agent(
      createDefaultAgentConfig(),
      'Борщ',
      {
        id: 'failed-approval',
        createdAt: 1,
        taskState,
        messages: [
          {
            id: 'plan',
            role: 'assistant',
            content:
              'План борща готов.\nОжидаемое действие: подтвердите план своими словами, чтобы перейти дальше.',
            status: 'complete',
          },
          {
            id: 'approval',
            role: 'user',
            content: 'подтверждаю. Давай варить',
            status: 'complete',
          },
        ],
      },
      undefined,
      undefined,
      'task',
    );
    expect(restored.getTaskState()?.phase).toBe('execution');
    expect(buildTaskStateSystemPrompt(restored.getTaskState()!)).toContain(
      '"phase":"execution"',
    );
  });

  it('после отката восстанавливает согласие с новым планом, но не повторяет старое подтверждение отката', () => {
    const state: TaskState = {
      title: 'Борщ',
      goal: 'Исправить план борща',
      invariants: [],
      phase: 'planning',
      expectedAction: null,
      awaitingConfirmation: false,
      paused: false,
      updatedAt: 2,
      historyRepairDisabled: true,
      rollbackFrom: 'execution',
      rollbackReason: 'Невозможно выполнить прежний план',
    };
    const messages = [
      {
        id: 'rollback-proposal',
        role: 'assistant' as const,
        content: 'План невыполним.\nПредлагаю откат: execution → planning.',
        status: 'complete' as const,
      },
      {
        id: 'rollback-confirmation',
        role: 'user' as const,
        content: 'Да, откатываемся назад',
        status: 'complete' as const,
      },
    ];
    expect(reconcileTaskStateWithHistory(state, messages)?.phase).toBe(
      'planning',
    );
    messages.push(
      {
        id: 'new-plan',
        role: 'assistant',
        content:
          'Исправленный план готов.\nОжидаемое действие: подтвердите план.\nПредлагаю переход: planning → execution.',
        status: 'complete',
      },
      {
        id: 'new-approval',
        role: 'user',
        content: 'давай',
        status: 'complete',
      },
    );
    const restored = new Agent(
      createDefaultAgentConfig(),
      'Борщ',
      {
        id: 'post-rollback-failed-approval',
        createdAt: 1,
        taskState: state,
        messages,
      },
      undefined,
      undefined,
      'task',
    );
    expect(restored.getTaskState()?.phase).toBe('execution');
  });

  it('предлагает откат при ошибке плана, сохраняет его и заново утверждает исправленный план', async () => {
    const task = makeTask('Сервис', 'Реализовать сервис');
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Утвердите план',
      awaitingConfirmation: true,
    });
    task.dispatchTaskState({ type: 'confirm', message: 'Подтверждаю' });
    const { requests } = mockTaskReplies(
      'Ранее утверждённый план не реализуем: нужный API недоступен. Продолжать реализацию нельзя. Подтвердите возврат для исправления плана.\nПредлагаю откат: execution → planning.',
      'Исправленный план использует доступный API.\nОжидаемое действие: утвердите исправленный план.\nПредлагаю переход: planning → execution.',
      'Приступаю к реализации исправленного плана.',
    );
    await task.sendMessage('В API нет нужного метода, план не реализуем');
    expect(
      readTaskRollbackFromAnswer(
        task.getSnapshot().messages.at(-1)!.content,
        'execution',
      )?.target,
    ).toBe('planning');
    expect(task.getTaskState()).toMatchObject({
      phase: 'execution',
      pendingRollback: true,
      awaitingConfirmation: true,
    });
    const saved = JSON.stringify(task.exportState());
    const restored = new Agent(
      createDefaultAgentConfig(),
      'Сервис',
      JSON.parse(saved),
      undefined,
      undefined,
      'task',
    );
    expect(restored.getTaskState()?.pendingRollback).toBe(true);
    await restored.sendMessage('Да, откатываемся назад');
    expect(restored.getTaskState()).toMatchObject({
      phase: 'planning',
      rollbackFrom: 'execution',
      awaitingConfirmation: true,
    });
    expect(
      requests.find(
        (request) => request.taskState?.rollbackFrom === 'execution',
      )?.taskState?.phase,
    ).toBe('planning');
    expect(
      reconcileTaskStateWithHistory(
        restored.getTaskState(),
        restored.getSnapshot().messages,
      )?.phase,
    ).toBe('planning');
    await restored.sendMessage('давай');
    expect(restored.getTaskState()?.phase).toBe('execution');
    expect(
      requests
        .findLast((request) => request.taskState?.phase === 'execution')
        ?.messages.at(-1),
    ).toEqual({ role: 'user', content: 'давай' });
  });

  it('не откатывает этап при отказе пользователя от предложенного возврата', async () => {
    const task = makeTask();
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Утвердите план',
      awaitingConfirmation: true,
    });
    task.dispatchTaskState({ type: 'confirm', message: 'Да' });
    task.dispatchTaskState({
      type: 'proposeRollback',
      target: 'planning',
      reason: 'План не реализуем',
    });
    const { requests } = mockTaskReplies('Уточним причину блокировки.');
    await task.sendMessage('Нет, не откатывай');
    expect(task.getTaskState()).toMatchObject({
      phase: 'execution',
      awaitingConfirmation: false,
    });
    expect(task.getTaskState()?.pendingRollback).toBeUndefined();
    expect(
      requests.find((request) => request.taskState)?.taskState?.phase,
    ).toBe('execution');
  });

  it('после предложения в одной строке принимает done и отправляет новый этап модели', async () => {
    const task = makeTask('Борщ', 'Приготовить борщ');
    for (const phase of ['execution', 'validation'] as const) {
      task.dispatchTaskState({
        type: 'propose',
        expectedAction: 'Примите результат этапа',
        awaitingConfirmation: true,
      });
      task.dispatchTaskState({ type: 'confirm', message: phase });
    }
    expect(task.getTaskState()?.phase).toBe('validation');
    const { requests } = mockTaskReplies(
      'Ожидаемое действие: подтвердите результат этапа validation своими словами. Предлагаю переход: validation → done. Пожалуйста, подтвердите результат.',
      'Задача завершена.',
    );
    await task.sendMessage('Проверь результат');
    expect(task.getTaskState()).toMatchObject({
      phase: 'validation',
      expectedAction: 'подтвердите результат этапа validation своими словами.',
      awaitingConfirmation: true,
    });
    await task.sendMessage('done');
    expect(task.getTaskState()?.phase).toBe('done');
    expect(
      requests
        .find((request) => request.taskState?.phase === 'done')
        ?.messages.at(-1),
    ).toEqual({ role: 'user', content: 'done' });
  });

  it('восстанавливает пропущенное подтверждение done из сохранённого диалога', () => {
    const taskState: TaskState = {
      title: 'Борщ',
      goal: 'Приготовить борщ',
      invariants: [],
      phase: 'validation',
      expectedAction: null,
      awaitingConfirmation: false,
      paused: false,
      updatedAt: 1,
    };
    const messages = [
      {
        id: 'a',
        role: 'assistant' as const,
        content:
          'Ожидаемое действие: подтвердите рецепт. Предлагаю переход: validation → done.',
        status: 'complete' as const,
      },
      {
        id: 'u',
        role: 'user' as const,
        content: 'done',
        status: 'complete' as const,
      },
      {
        id: 'b',
        role: 'assistant' as const,
        content: 'Пользователь подтвердил рецепт, задача завершена.',
        status: 'complete' as const,
      },
    ];
    const restored = new Agent(
      createDefaultAgentConfig(),
      'Борщ',
      { id: 'task-1', createdAt: 1, messages, taskState },
      undefined,
      undefined,
      'task',
    );
    expect(restored.getTaskState()?.phase).toBe('done');

    const waiting = new Agent(
      createDefaultAgentConfig(),
      'Борщ',
      { id: 'task-2', createdAt: 1, messages: messages.slice(0, 1), taskState },
      undefined,
      undefined,
      'task',
    );
    expect(waiting.getTaskState()).toMatchObject({
      phase: 'validation',
      awaitingConfirmation: true,
    });
    const claimedDone = new Agent(
      createDefaultAgentConfig(),
      'Борщ',
      {
        id: 'task-3',
        createdAt: 1,
        messages: [
          {
            id: 'a',
            role: 'assistant',
            content: 'Задача завершена, дополнительных действий не требуется.',
            status: 'complete',
          },
        ],
        taskState,
      },
      undefined,
      undefined,
      'task',
    );
    expect(claimedDone.getTaskState()).toMatchObject({
      phase: 'validation',
      awaitingConfirmation: true,
    });
    expect(buildTaskStateSystemPrompt(taskState)).toContain(
      'не говори «задача завершена»',
    );
  });

  it('применяет подтверждение из чата до LLM-запроса и не перескакивает этапы', async () => {
    const task = makeTask();
    const { requests } = mockTaskReplies(
      'План готов.\nОжидаемое действие: проверьте план.\nПредлагаю переход: planning → execution. Подтвердите результат в чате.',
      'Черновик готов.\nОжидаемое действие: проверьте черновик.\nПредлагаю переход: execution → validation. Подтвердите результат в чате.',
      'Проверка завершена.\nОжидаемое действие: примите результат проверки.\nПредлагаю переход: validation → done. Подтвердите результат в чате.',
      'Задача завершена.',
    );

    await task.sendMessage('Покажи план');
    expect(task.getTaskState()).toMatchObject({
      phase: 'planning',
      expectedAction: 'проверьте план.',
      awaitingConfirmation: true,
    });
    await task.sendMessage('План подтверждаю, правок нет');
    expect(task.getTaskState()?.phase).toBe('execution');
    expect(
      requests
        .find((request) => request.taskState?.phase === 'execution')
        ?.messages.at(-1),
    ).toEqual({ role: 'user', content: 'План подтверждаю, правок нет' });
    await task.sendMessage('Да');
    expect(task.getTaskState()?.phase).toBe('validation');
    await task.sendMessage('Результат принят');
    expect(task.getTaskState()?.phase).toBe('done');
    expect(
      task
        .getSnapshot()
        .messages.some((message) => message.source === 'task-transition'),
    ).toBe(false);
    expect(
      task
        .getSnapshot()
        .messages.filter(
          (message) => message.content === 'План подтверждаю, правок нет',
        ),
    ).toHaveLength(1);
  });

  it('не переключает этап командой, без предложения или после доработки', async () => {
    const task = makeTask();
    const { fetchMock } = mockTaskReplies(
      'Нужно уточнение.\nОжидаемое действие: опишите срок.',
      'План готов.\nОжидаемое действие: проверьте план.\nПредлагаю переход: planning → execution.',
      'План обновлён.\nОжидаемое действие: проверьте изменения.',
    );
    await task.sendMessage('/этап execution');
    expect(task.getSnapshot().error).toContain('больше не переключает');
    expect(fetchMock).not.toHaveBeenCalled();
    await task.sendMessage('execution');
    expect(task.getSnapshot().error).toContain('пока не предложен');
    expect(fetchMock).not.toHaveBeenCalled();
    await task.sendMessage('validation');
    expect(task.getSnapshot().error).toContain('нельзя перескочить этап');
    expect(fetchMock).not.toHaveBeenCalled();
    await task.sendMessage('done');
    expect(task.getSnapshot().error).toContain('нельзя перескочить этап');
    expect(fetchMock).not.toHaveBeenCalled();
    await task.sendMessage('Начинай выполнение');
    expect(task.getTaskState()?.phase).toBe('planning');
    await task.sendMessage('Подтверждаю');
    expect(task.getTaskState()?.phase).toBe('planning');
    expect(task.getTaskState()?.awaitingConfirmation).toBe(true);
    await task.sendMessage('Доработай план');
    expect(task.getTaskState()).toMatchObject({
      phase: 'planning',
      awaitingConfirmation: false,
      expectedAction: 'проверьте изменения.',
    });
  });

  it('восстанавливает старую задачу без отдельного шага и не превращает старое ожидание в подтверждение', () => {
    expect(
      restoreTaskState({
        title: 'Отчёт',
        goal: 'Подготовить отчёт',
        phase: 'execution',
        currentStep: 'Написать отчёт',
        expectedAction: 'Агент продолжит черновик',
        paused: false,
        updatedAt: 1,
      }),
    ).toEqual({
      title: 'Отчёт',
      goal: 'Подготовить отчёт',
      invariants: [],
      phase: 'execution',
      expectedAction: null,
      awaitingConfirmation: false,
      paused: false,
      updatedAt: 1,
    });
    expect(
      restoreTaskState({ phase: 'unknown', paused: false, updatedAt: 1 }),
    ).toBeNull();
  });

  it('сохраняет предложение, паузу и продолжение между запусками', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const task = makeTask('Отчёт', 'Подготовить отчёт', [
      'Использовать только PostgreSQL',
    ]);
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Проверьте план',
      awaitingConfirmation: true,
    });
    task.dispatchTaskState({ type: 'pause' });
    expect(saveAgentSessions(storage, [task], task.id)).toBe(true);
    const restored = loadAgentSessions(storage).agents[0];
    expect(restored.getTaskState()).toMatchObject({
      phase: 'planning',
      invariants: ['Использовать только PostgreSQL'],
      expectedAction: 'Проверьте план',
      awaitingConfirmation: true,
      paused: true,
    });
    const { fetchMock, requests } = mockTaskReplies(
      'Продолжаю на этапе execution.',
    );
    await restored.sendMessage('Подтверждаю');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(restored.dispatchTaskState({ type: 'resume' })).toBe(true);
    await restored.sendMessage('Подтверждаю');
    expect(restored.getTaskState()?.phase).toBe('execution');
    expect(requests.find((request) => request.taskState)?.taskState?.goal).toBe(
      'Подготовить отчёт',
    );
    expect(
      requests.find((request) => request.taskState)?.taskState?.invariants,
    ).toEqual(['Использовать только PostgreSQL']);
    expect(buildTaskStateSystemPrompt(restored.getTaskState()!)).toContain(
      'Пользователь уже подтвердил результат planning',
    );
  });

  it('исключает технический запрос плана из памяти, но сохраняет обычное подтверждение', async () => {
    const task = makeTask('Отчёт', 'Подготовить отчёт', [
      'Использовать только PostgreSQL',
    ]);
    const { requests } = mockTaskReplies(
      'План готов.\nОжидаемое действие: проверьте план.\nПредлагаю переход: planning → execution.',
      'Начинаю работу.\nОжидаемое действие: сообщите детали.',
    );
    await task.requestTaskPlan();
    expect(task.getSnapshot().messages[0].source).toBe('task-control');
    await task.sendMessage('Подтверждаю');
    const memoryRequests = requests.filter((request) => {
      const content = request.messages[0]?.content;
      return (
        typeof content === 'string' &&
        content.startsWith('Ты отдельный агент управления памятью')
      );
    });
    const memoryContent = memoryRequests.at(-1)?.messages[0]?.content;
    const memoryPrompt = typeof memoryContent === 'string' ? memoryContent : '';
    expect(memoryPrompt).not.toContain(TASK_PLAN_REQUEST);
    expect(memoryPrompt).not.toContain('Использовать только PostgreSQL');
    expect(memoryPrompt).toContain('Пользователь: Подтверждаю');
    expect(memoryPrompt).toContain('Ассистент: Начинаю работу.');
  });

  it('прерывает активный запрос при паузе и продолжает с тем же этапом', async () => {
    const task = makeTask();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = task.sendMessage('Покажи план');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(task.dispatchTaskState({ type: 'pause' })).toBe(true);
    await pending;
    expect(task.getTaskState()).toMatchObject({
      phase: 'planning',
      paused: true,
    });
    expect(task.dispatchTaskState({ type: 'resume' })).toBe(true);
    expect(task.getTaskState()?.phase).toBe('planning');
  });

  it('разводит состояние по веткам диалога', () => {
    const task = new Agent({
      ...createDefaultAgentConfig(),
      contextStrategy: 'branching',
    });
    task.dispatchTaskState({
      type: 'start',
      title: 'Варианты',
      goal: 'Проверить варианты',
    });
    const branches = task.createBranches();
    expect(branches).not.toBeNull();
    const [first, second] = branches!;
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Принять план',
      awaitingConfirmation: true,
    });
    task.dispatchTaskState({ type: 'confirm', message: 'Да' });
    expect(task.getTaskState()?.phase).toBe('execution');
    expect(task.switchBranch(second)).toBe(true);
    expect(task.getTaskState()?.phase).toBe('planning');
    expect(task.switchBranch(first)).toBe(true);
    expect(task.getTaskState()?.phase).toBe('execution');

    const restored = deserializeAgentSessions(
      JSON.stringify({
        version: 2,
        agents: [task.exportState()],
        activeAgentId: task.id,
        longTermMemory: [],
      }),
    ).agents[0];
    expect(restored.getTaskState()?.phase).toBe('execution');
    restored.switchBranch(second);
    expect(restored.getTaskState()?.phase).toBe('planning');
  });

  it('показывает английские этапы и не предлагает кнопку смены этапа', () => {
    const task = makeTask('ТЗ', 'Согласовать требования', [
      'Не использовать MongoDB',
    ]);
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Проверьте план требований',
      awaitingConfirmation: true,
    });
    const stateMarkup = renderToStaticMarkup(
      createElement(AgentTaskStatePanel, { agent: task }),
    );
    expect(stateMarkup).toContain('planning');
    expect(stateMarkup).toContain('execution');
    expect(stateMarkup).toContain('Проверьте план требований');
    expect(stateMarkup).toContain('подтвердите его своими словами в диалоге');
    expect(stateMarkup).not.toContain('Перейти:');
    expect(stateMarkup).not.toContain('Изменить шаг');
    expect(
      renderToStaticMarkup(
        createElement(AgentChat, { agent: task, onOpenTask: () => {} }),
      ),
    ).not.toContain('/этап');

    const sidebar = renderToStaticMarkup(
      createElement(AgentSidebar, {
        agents: [task],
        activeAgentId: task.id,
        onSelect: () => {},
        onSelectTask: () => {},
        onCreate: () => {},
        onCreateTask: () => {},
        onDelete: () => {},
      }),
    );
    expect(sidebar).toContain('Создать задачу');
    const setup = renderToStaticMarkup(
      createElement(TaskSetup, { onCreate: () => {}, onCancel: () => {} }),
    );
    expect(setup).toContain('Название задачи');
    expect(setup).toContain('Инварианты задачи');
    expect(setup).toContain('Добавить');
    expect(setup).not.toContain('Добавленные инварианты');
    const workspace = renderToStaticMarkup(
      createElement(TaskWorkspace, {
        agent: task,
        onOpenChat: () => {},
        onStartPlanning: () => {},
      }),
    );
    expect(workspace).toContain('Согласовать требования');
    expect(workspace).toContain('Не использовать MongoDB');
    expect(workspace).not.toContain('Перейти:');
  });

  it('показывает в интерфейсе, что обратный переход ожидает подтверждения', () => {
    const task = makeTask();
    task.dispatchTaskState({
      type: 'propose',
      expectedAction: 'Утвердить план',
      awaitingConfirmation: true,
    });
    task.dispatchTaskState({ type: 'confirm', message: 'Да' });
    task.dispatchTaskState({
      type: 'proposeRollback',
      target: 'planning',
      reason: 'План невыполним',
    });
    const markup = renderToStaticMarkup(
      createElement(AgentTaskStatePanel, { agent: task }),
    );
    expect(markup).toContain('вернуться к');
    expect(markup).toContain('planning');
    expect(markup).toContain('Подтвердите откат своими словами');
    expect(markup).toContain('активен');
    expect(task.getTaskState()?.phase).toBe('execution');
  });
});
