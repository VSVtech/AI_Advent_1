'use client';

import { Bot } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { AgentChat } from '@/components/agent-chat';
import { AgentSetup } from '@/components/agent-setup';
import { AgentSidebar } from '@/components/agent-sidebar';
import { Agent, type AgentConfig } from '@/lib/agent';

type View = 'empty' | 'setup' | 'chat';

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [view, setView] = useState<View>('empty');
  const agentsRef = useRef<Agent[]>(agents);

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

  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? null;

  const handleCreate = (config: AgentConfig, name: string) => {
    const agent = new Agent(config, name);
    setAgents((current) => [...current, agent]);
    setActiveAgentId(agent.id);
    setView('chat');
  };

  const handleSelect = (id: string) => {
    setActiveAgentId(id);
    setView('chat');
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
          activeAgentId={activeAgentId}
          onSelect={handleSelect}
          onCreate={() => setView('setup')}
          onDelete={handleDelete}
        />

        <div className="section-panel flex-1">
          {view === 'setup' ? (
            <AgentSetup
              onCreate={handleCreate}
              onCancel={() => setView(activeAgent ? 'chat' : 'empty')}
            />
          ) : view === 'chat' && activeAgent ? (
            <AgentChat key={activeAgent.id} agent={activeAgent} />
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
