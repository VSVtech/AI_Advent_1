'use client';
/* oxlint-disable next/no-html-link-for-pages -- Vinext has no Next Link package in the test runtime. */

import {
  CloudRain,
  ListTodo,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAgentSnapshot } from '@/hooks/use-agent';
import type { Agent } from '@/lib/agent';
import { formatModelLabel } from '@/lib/chat-constraints';
import {
  WEATHER_SUMMARY_URL,
  type DailyWeatherSummary,
  type WeatherSummaryResponse,
} from '@/lib/weather-summary';

function WeatherReportLink({ onOpen }: { onOpen: () => void }) {
  const [report, setReport] = useState<DailyWeatherSummary | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(WEATHER_SUMMARY_URL, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as WeatherSummaryResponse;
        if (active && payload.status === 'ready') setReport(payload.summary);
      } catch {
        // The weather report is optional; the rest of the sidebar stays usable.
      }
    };
    void refresh();
    const intervalId = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  if (!report) return null;
  const range =
    report.minTemperatureC === null || report.maxTemperatureC === null
      ? 'нет замеров'
      : `${report.minTemperatureC.toLocaleString('ru-RU')}…${report.maxTemperatureC.toLocaleString('ru-RU')} °C`;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.05] px-3 py-2.5 text-left text-xs leading-5 text-white/65 hover:bg-emerald-300/10"
    >
      <CloudRain
        className="mt-0.5 size-4 shrink-0 text-emerald-200"
        aria-hidden="true"
      />
      <span>
        <span className="block font-medium text-white/85">
          Погода · {report.date}
        </span>
        <span>
          {range} · дождь{' '}
          {report.rainObserved === null
            ? 'неизвестен'
            : report.rainObserved
              ? 'был'
              : 'не зафиксирован'}
        </span>
      </span>
    </button>
  );
}

function AgentListItem({
  agent,
  label,
  itemType,
  isActive,
  onSelect,
  onDelete,
}: {
  agent: Agent;
  label: string;
  itemType: 'агента' | 'задачу';
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
          <span className="truncate">{label}</span>
        </span>
        <span className="agent-list-item-model">
          {formatModelLabel(agent.config.model)}
        </span>
      </button>
      <button
        type="button"
        className="agent-list-item-delete"
        aria-label={`Удалить ${itemType} «${label}»`}
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
  onCreateTask,
  onOpenMcpTools,
  isMcpToolsActive,
  onSelectTask,
  onDelete,
}: {
  agents: Agent[];
  activeAgentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onCreateTask: () => void;
  onOpenMcpTools: () => void;
  isMcpToolsActive: boolean;
  onSelectTask: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const regularAgents = agents.filter((agent) => agent.kind === 'agent');
  const taskAgents = agents.filter(
    (agent) => agent.kind === 'task' || agent.getTaskState() !== null,
  );

  return (
    <aside className="app-sidebar agent-sidebar" aria-label="Агенты и задачи">
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
        <Button
          type="button"
          variant="outline"
          className={`min-h-10 w-full justify-start gap-2 border-white/10 bg-white/[0.035] text-white/80${isMcpToolsActive ? ' border-emerald-300/25 bg-emerald-300/10 text-emerald-200' : ''}`}
          onClick={onOpenMcpTools}
          aria-current={isMcpToolsActive || undefined}
        >
          <Wrench className="size-4" />
          MCP Инструменты
        </Button>
        <WeatherReportLink onOpen={onOpenMcpTools} />
        <Button
          type="button"
          variant="outline"
          className="min-h-10 w-full justify-start gap-2 border-white/10 bg-white/[0.035] text-white/80"
          onClick={onCreateTask}
        >
          <ListTodo className="size-4" />
          Создать задачу
        </Button>
        <a
          href="/general-profile"
          className="flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white"
        >
          <UserRound className="size-4" aria-hidden="true" />
          General Profile
        </a>

        {regularAgents.length === 0 ? (
          <p className="agent-sidebar-empty">Нет запущенных агентов</p>
        ) : (
          <ul className="agent-list">
            {regularAgents.map((agent) => (
              <AgentListItem
                key={agent.id}
                agent={agent}
                label={agent.name}
                itemType="агента"
                isActive={agent.id === activeAgentId}
                onSelect={() => onSelect(agent.id)}
                onDelete={() => onDelete(agent.id)}
              />
            ))}
          </ul>
        )}

        {taskAgents.length > 0 ? (
          <div className="mt-5">
            <h2 className="px-3 text-xs font-medium uppercase tracking-[0.12em] text-white/40">
              Задачи
            </h2>
            <ul className="agent-list mt-2">
              {taskAgents.map((agent) => (
                <AgentListItem
                  key={`task-${agent.id}`}
                  agent={agent}
                  label={agent.getTaskState()?.title ?? agent.name}
                  itemType="задачу"
                  isActive={agent.id === activeAgentId}
                  onSelect={() => onSelectTask(agent.id)}
                  onDelete={() => onDelete(agent.id)}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
