'use client';

import { BrainCircuit, ChevronDown } from 'lucide-react';

import { useAgentSnapshot } from '@/hooks/use-agent';
import type { Agent } from '@/lib/agent';
import type { TaskMemoryItem } from '@/lib/task-memory';

function MemoryList({
  label,
  items,
}: {
  label: string;
  items: TaskMemoryItem[];
}) {
  if (!items.length) return null;
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/35">
        {label}
      </dt>
      <dd className="mt-1.5 space-y-1.5">
        {items.map((item) => (
          <p
            key={`${item.label}:${item.value}`}
            className="break-words text-xs leading-5 text-white/65"
          >
            <span className="text-white/85">{item.label}:</span> {item.value}
          </p>
        ))}
      </dd>
    </div>
  );
}

export function TaskMemoryCard({ agent }: { agent: Agent }) {
  useAgentSnapshot(agent);
  const memory = agent.getTaskMemory();
  const memoryStatus = agent.getMemoryAnalysisStatus();
  const count =
    Number(Boolean(memory.goal)) +
    memory.constraints.length +
    memory.terms.length +
    memory.clarifications.length;

  return (
    <details className="group border-b border-white/5 bg-emerald-300/[0.025] px-4 py-2 sm:px-6">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-white/60 marker:hidden">
        <BrainCircuit
          className="size-4 text-emerald-200/75"
          aria-hidden="true"
        />
        <span className="font-medium text-white/75">Память задачи</span>
        <span className="text-white/35">
          {memoryStatus.analyzing
            ? 'обновляется…'
            : count
              ? `${count} записей`
              : 'заполнится по ходу диалога'}
        </span>
        <ChevronDown
          className="ml-auto size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <dl className="grid gap-4 pb-2 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/35">
            Цель
          </dt>
          <dd className="mt-1.5 break-words text-xs leading-5 text-white/70">
            {memory.goal ?? 'Будет определена из диалога.'}
          </dd>
        </div>
        <MemoryList label="Ограничения" items={memory.constraints} />
        <MemoryList label="Термины" items={memory.terms} />
        <MemoryList label="Уточнения" items={memory.clarifications} />
      </dl>
      {memoryStatus.error ? (
        <p className="pb-2 text-xs leading-5 text-amber-200/70">
          Память не обновилась: {memoryStatus.error}
        </p>
      ) : null}
    </details>
  );
}
