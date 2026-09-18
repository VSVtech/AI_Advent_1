'use client';
/* oxlint-disable next/no-html-link-for-pages -- Vinext has no Next Link package in the test runtime. */

import { Plus, Sparkles, Trash2, UserRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAgentSnapshot } from '@/hooks/use-agent';
import type { Agent } from '@/lib/agent';
import { formatModelLabel } from '@/lib/chat-constraints';

function AgentListItem({
  agent,
  isActive,
  onSelect,
  onDelete,
}: {
  agent: Agent;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { isGenerating } = useAgentSnapshot(agent);

  return (
    <li
      className={`agent-list-item group/agent${isActive ? ' agent-list-item-active' : ''}`}
    >
      <button
        type="button"
        className="agent-list-item-button"
        onClick={onSelect}
        aria-current={isActive || undefined}
      >
        <span className="agent-list-item-name">
          {isGenerating ? (
            <span className="status-dot shrink-0" aria-hidden="true" />
          ) : null}
          <span className="truncate">{agent.name}</span>
        </span>
        <span className="agent-list-item-model">
          {formatModelLabel(agent.config.model)}
        </span>
      </button>
      <button
        type="button"
        className="agent-list-item-delete"
        aria-label={`Удалить агента «${agent.name}»`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}

export function AgentSidebar({
  agents,
  activeAgentId,
  onSelect,
  onCreate,
  onDelete,
}: {
  agents: Agent[];
  activeAgentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="app-sidebar agent-sidebar" aria-label="Агенты">
      <div className="flex h-[68px] shrink-0 items-center gap-2.5 px-4">
        <span className="brand-mark shrink-0" aria-hidden="true">
          <Sparkles className="size-[18px]" />
        </span>
        <span className="text-sm font-semibold tracking-[-0.01em] text-white">
          DeepSeek
        </span>
      </div>

      <div className="agent-sidebar-body">
        <Button
          type="button"
          className="agent-create-button"
          onClick={onCreate}
        >
          <Plus className="size-4" />
          Новый агент
        </Button>
        <a
          href="/general-profile"
          className="flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <UserRound className="size-4" aria-hidden="true" />
          General Profile
        </a>

        {agents.length === 0 ? (
          <p className="agent-sidebar-empty">Нет запущенных агентов</p>
        ) : (
          <ul className="agent-list">
            {agents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                isActive={agent.id === activeAgentId}
                onSelect={() => onSelect(agent.id)}
                onDelete={() => onDelete(agent.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
