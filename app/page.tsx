'use client';

import { Bot } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AgentChat } from '@/components/agent-chat';
import { AgentSetup } from '@/components/agent-setup';
import { AgentSidebar } from '@/components/agent-sidebar';
import { McpToolsView } from '@/components/mcp-tools-view';
import { KnowledgeBaseView } from '@/components/knowledge-base-view';
import { TaskSetup } from '@/components/task-setup';
import { TaskWorkspace } from '@/components/task-workspace';
import { Agent, createDefaultAgentConfig, type AgentConfig } from '@/lib/agent';
import { loadAgentSessions, saveAgentSessions } from '@/lib/agent-storage';
import { SharedLongTermMemory } from '@/lib/memory-layers';
import { loadGeneralProfile } from '@/lib/user-profile';

type View =
  | 'empty'
  | 'setup'
  | 'chat'
  | 'task-setup'
  | 'task'
  | 'mcp-tools'
  | 'knowledge-base';

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [view, setView] = useState<View>('empty');
  const [hasRestoredSessions, setHasRestoredSessions] = useState(false);
  const agentsRef = useRef<Agent[]>(agents);
  const longTermMemoryRef = useRef(new SharedLongTermMemory());

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const restored = loadAgentSessions(window.localStorage);
      longTermMemoryRef.current = restored.longTermMemory;
      setAgents(restored.agents);
      setActiveAgentId(restored.activeAgentId);
      const restoredActiveAgent = restored.agents.find(
        (agent) => agent.id === restored.activeAgentId,
      );
      setView(
        restoredActiveAgent?.kind === 'task'
          ? 'task'
          : restoredActiveAgent
            ? 'chat'
            : 'empty',
      );
      setHasRestoredSessions(true);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!hasRestoredSessions) return;

    let timeoutId: number | null = null;
    const persist = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = null;
      saveAgentSessions(
        window.localStorage,
        agents,
        activeAgentId,
        longTermMemoryRef.current,
      );
    };
    const schedulePersist = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(persist, 100);
    };
    const unsubscribers = agents.map((agent) =>
      agent.subscribe(schedulePersist),
    );
    const unsubscribeMemory =
      longTermMemoryRef.current.subscribe(schedulePersist);

    persist();
    window.addEventListener('pagehide', persist);

    return () => {
      persist();
      window.removeEventListener('pagehide', persist);
      unsubscribeMemory();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [activeAgentId, agents, hasRestoredSessions]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // Every Agent owns a live fetch/stream connection once it starts
  // generating; disposing all of them on unmount guarantees no request keeps
  // running (and no state update fires) after the page itself is gone.
  useEffect(() => {
    return () => {
      for (const agent of agentsRef.current) agent.dispose();
    };
  }, []);

  const activeAgent =
    agents.find((agent) => agent.id === activeAgentId) ?? null;

  const handleCreate = (config: AgentConfig, name: string) => {
    const agent = new Agent(
      config,
      name,
      undefined,
      longTermMemoryRef.current,
      () => loadGeneralProfile(window.localStorage),
    );
    setAgents((current) => [...current, agent]);
    setActiveAgentId(agent.id);
    setView('chat');
  };

  const handleSelect = (id: string) => {
    setActiveAgentId(id);
    setView('chat');
  };

  const handleSelectTask = (id: string) => {
    setActiveAgentId(id);
    setView('task');
  };

  const handleCreateTask = (
    title: string,
    goal: string,
    invariants: string[],
  ) => {
    const taskAgent = new Agent(
      createDefaultAgentConfig(),
      title,
      undefined,
      longTermMemoryRef.current,
      () => loadGeneralProfile(window.localStorage),
      'task',
    );
    const started = taskAgent.dispatchTaskState({
      type: 'start',
      title,
      goal,
      invariants,
    });
    if (!started) {
      taskAgent.dispose();
      return;
    }
    setAgents((current) => [...current, taskAgent]);
    setActiveAgentId(taskAgent.id);
    setView('task');
  };

  const handleDelete = (id: string) => {
    setAgents((current) => {
      const agent = current.find((item) => item.id === id);
      agent?.dispose();
      return current.filter((item) => item.id !== id);
    });
    if (activeAgentId === id) {
      setActiveAgentId(null);
      setView('empty');
    }
  };

  return (
    <main className="chat-shell">
      <div className="app-frame flex flex-col md:flex-row">
        <AgentSidebar
          agents={agents}
          activeAgentId={
            view === 'mcp-tools' || view === 'knowledge-base'
              ? null
              : activeAgentId
          }
          onSelect={handleSelect}
          onCreate={() => setView('setup')}
          onCreateTask={() => setView('task-setup')}
          onOpenMcpTools={() => setView('mcp-tools')}
          isMcpToolsActive={view === 'mcp-tools'}
          onOpenKnowledgeBase={() => setView('knowledge-base')}
          isKnowledgeBaseActive={view === 'knowledge-base'}
          onSelectTask={handleSelectTask}
          onDelete={handleDelete}
        />

        <div className="section-panel flex-1">
          {view === 'knowledge-base' ? (
            <KnowledgeBaseView />
          ) : view === 'mcp-tools' ? (
            <McpToolsView />
          ) : view === 'setup' ? (
            <AgentSetup
              onCreate={handleCreate}
              onCancel={() => setView(activeAgent ? 'chat' : 'empty')}
            />
          ) : view === 'task-setup' ? (
            <TaskSetup
              onCreate={handleCreateTask}
              onCancel={() =>
                setView(
                  activeAgent?.kind === 'task'
                    ? 'task'
                    : activeAgent
                      ? 'chat'
                      : 'empty',
                )
              }
            />
          ) : view === 'task' && activeAgent ? (
            <TaskWorkspace
              key={activeAgent.id}
              agent={activeAgent}
              onOpenChat={() => setView('chat')}
              onStartPlanning={() => {
                setView('chat');
                void activeAgent.requestTaskPlan();
              }}
            />
          ) : view === 'chat' && activeAgent ? (
            <AgentChat
              key={activeAgent.id}
              agent={activeAgent}
              onOpenTask={
                activeAgent.kind === 'task' || activeAgent.getTaskState()
                  ? () => setView('task')
                  : undefined
              }
            />
          ) : (
            <div className="agent-empty-state">
              <span className="empty-icon" aria-hidden="true">
                <Bot className="size-7" />
              </span>
              <div className="space-y-2 text-center">
                <h2 className="text-xl font-semibold tracking-[-0.025em] text-white sm:text-2xl">
                  Нет активного агента
                </h2>
                <p className="mx-auto max-w-md text-sm leading-6 text-white/45">
                  Создайте агента, чтобы начать диалог с DeepSeek. У каждого
                  агента своя модель, настройки и история чата.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
