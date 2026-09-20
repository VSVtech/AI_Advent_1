'use client';

import { CirclePause, CirclePlay, ListTodo } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAgentSnapshot } from '@/hooks/use-agent';
import type { Agent } from '@/lib/agent';
import { TASK_PHASES } from '@/lib/task-state';

export function AgentTaskStatePanel({ agent }: { agent: Agent }) {
  const { isGenerating } = useAgentSnapshot(agent);
  const state = agent.getTaskState();
  const phaseIndex = state ? TASK_PHASES.indexOf(state.phase) : -1;
  const nextPhase = TASK_PHASES[phaseIndex + 1];

  return (
    <section
      className="max-h-[min(42dvh,25rem)] shrink-0 overflow-y-auto border-b border-white/10 px-4 py-3 sm:px-6"
      aria-label="Состояние задачи"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white/85">
          <ListTodo className="size-4 text-emerald-300/80" aria-hidden="true" />
          Состояние задачи
        </h2>
        {state?.paused ? (
          <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-xs text-amber-200">
            Пауза
          </span>
        ) : null}
      </div>

      {state ? (
        <>
          <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="Этапы задачи">
            {TASK_PHASES.map((phase, index) => (
              <li
                key={phase}
                aria-current={state.phase === phase ? 'step' : undefined}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  state.phase === phase
                    ? 'border-emerald-300/35 bg-emerald-300/10 text-emerald-100'
                    : index < phaseIndex
                      ? 'border-white/10 text-white/55'
                      : 'border-white/8 text-white/35'
                }`}
              >
                {phase}
              </li>
            ))}
          </ol>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-white/45">Текущий шаг</dt>
              <dd className="mt-0.5 text-white/85">{state.phase}</dd>
            </div>
            <div>
              <dt className="text-xs text-white/45">Ожидаемое действие</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-white/85">
                {state.expectedAction ?? 'Агент предложит после ответа.'}
              </dd>
            </div>
          </dl>
          {state.awaitingConfirmation && nextPhase ? (
            <p className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-xs leading-5 text-emerald-100/85">
              Агент предложил переход к {nextPhase}. Если результат текущего
              этапа вас устраивает, подтвердите его своими словами в диалоге.
              Этап изменится после вашего сообщения.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {state.paused ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isGenerating}
                onClick={() => agent.dispatchTaskState({ type: 'resume' })}
              >
                <CirclePlay className="size-4" aria-hidden="true" />
                Продолжить задачу
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => agent.dispatchTaskState({ type: 'pause' })}
              >
                <CirclePause className="size-4" aria-hidden="true" />
                Пауза
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs leading-5 text-white/50">
          Состояние задачи не задано.
        </p>
      )}
    </section>
  );
}
