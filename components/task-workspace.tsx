'use client';

import { ArrowRight, ListTodo } from 'lucide-react';

import { AgentTaskStatePanel } from '@/components/agent-task-state';
import { Button } from '@/components/ui/button';
import { useAgentSnapshot } from '@/hooks/use-agent';
import type { Agent } from '@/lib/agent';

export function TaskWorkspace({
  agent,
  onOpenChat,
  onStartPlanning,
}: {
  agent: Agent;
  onOpenChat: () => void;
  onStartPlanning: () => void;
}) {
  const { messages, isGenerating, error } = useAgentSnapshot(agent);
  const state = agent.getTaskState();
  const firstStep = messages.length === 0 && state?.phase === 'planning';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="chat-header shrink-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="brand-mark shrink-0" aria-hidden="true">
            <ListTodo className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-white">
              {state?.title ?? agent.name}
            </h1>
            <p className="text-xs text-white/40">Задача · отдельный диалог</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenChat}>
          Открыть диалог
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-white/10 px-4 py-5 sm:px-6">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-emerald-300/75">
            Цель
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-base leading-7 text-white/85">
            {state?.goal ?? 'Цель не задана.'}
          </p>
          <p className="mt-3 text-xs leading-5 text-white/45">
            Текущий шаг — активный этап. Агент предложит следующее действие и
            переход, когда результат этапа будет готов. Подтвердите результат
            ответом в диалоге; кнопки перехода нет.
          </p>
        </section>

        <AgentTaskStatePanel key={agent.getActiveBranchId()} agent={agent} />

        <section className="space-y-3 px-4 py-5 sm:px-6">
          <h2 className="text-sm font-semibold text-white/80">
            Диалог по задаче
          </h2>
          <p className="text-sm leading-6 text-white/50">
            {messages.length === 0
              ? 'История пока пуста. Цель и состояние задачи уже будут переданы агенту.'
              : `Сообщений: ${messages.length}. История сохраняется между открытиями приложения.`}
          </p>
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
          {firstStep ? (
            <Button
              type="button"
              disabled={isGenerating || state?.paused}
              onClick={onStartPlanning}
            >
              Попросить агента составить план
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={onOpenChat}>
              Продолжить диалог
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
