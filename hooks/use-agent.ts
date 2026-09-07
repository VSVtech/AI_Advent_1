'use client';

import { useSyncExternalStore } from 'react';

import type { Agent, AgentSnapshot } from '@/lib/agent';

/**
 * Subscribes a React component to one Agent instance. The Agent owns its
 * state and notifies listeners itself (see lib/agent.ts); this hook is the
 * thin bridge that turns those notifications into re-renders via
 * useSyncExternalStore, without ever duplicating the agent's state into
 * React state.
 */
export function useAgentSnapshot(agent: Agent): AgentSnapshot {
  return useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);
}
