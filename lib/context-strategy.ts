export type ContextStrategy =
  | 'none'
  | 'sliding-window'
  | 'sticky-facts'
  | 'branching';

export const RECENT_CONTEXT_MESSAGE_LIMIT = 10;
export const MAX_FACTS = 20;
export const MAX_FACT_KEY_LENGTH = 80;
export const MAX_FACT_VALUE_LENGTH = 500;

export type MemoryFacts = Record<string, string>;

export function isContextStrategy(value: unknown): value is ContextStrategy {
  return (
    value === 'none' ||
    value === 'sliding-window' ||
    value === 'sticky-facts' ||
    value === 'branching'
  );
}

export function sanitizeFacts(value: unknown): MemoryFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const facts: MemoryFacts = {};
  for (const [key, fact] of Object.entries(value)) {
    if (
      !key.trim() ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype' ||
      key.length > MAX_FACT_KEY_LENGTH ||
      typeof fact !== 'string' ||
      fact.length > MAX_FACT_VALUE_LENGTH
    ) {
      return null;
    }
    if (fact.trim()) facts[key] = fact.trim();
    if (Object.keys(facts).length > MAX_FACTS) return null;
  }

  return facts;
}
