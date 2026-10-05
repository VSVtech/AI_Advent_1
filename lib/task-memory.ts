import type { MemoryFacts } from '@/lib/context-strategy';

export const MAX_DIALOGUE_GOAL_LENGTH = 1000;

export type TaskMemoryItem = {
  label: string;
  value: string;
};

export type DialogueTaskMemory = {
  goal: string | null;
  constraints: TaskMemoryItem[];
  terms: TaskMemoryItem[];
  clarifications: TaskMemoryItem[];
};

export function normalizeDialogueGoal(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_DIALOGUE_GOAL_LENGTH)
    return null;
  const goal = value.trim();
  if (
    Array.from(goal).some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  )
    return null;
  return goal;
}

const category = (key: string) => {
  const match =
    /^(цель|goal|ограничение|constraint|термин|term|уточнение|clarification)(?:\s*[·:]\s*(.+))?$/iu.exec(
      key.trim(),
    );
  if (!match) return null;
  const raw = match[1].toLocaleLowerCase('ru-RU');
  const type =
    raw === 'цель' || raw === 'goal'
      ? 'goal'
      : raw === 'ограничение' || raw === 'constraint'
        ? 'constraints'
        : raw === 'термин' || raw === 'term'
          ? 'terms'
          : 'clarifications';
  return { type, label: match[2]?.trim() || key.trim() } as const;
};

export function taskMemoryFromFacts(
  facts: MemoryFacts,
  configuredGoal = '',
): DialogueTaskMemory {
  const result: DialogueTaskMemory = {
    goal: normalizeDialogueGoal(configuredGoal) || null,
    constraints: [],
    terms: [],
    clarifications: [],
  };
  for (const [key, value] of Object.entries(facts)) {
    const parsed = category(key);
    if (!parsed) continue;
    if (parsed.type === 'goal') result.goal = value;
    else result[parsed.type].push({ label: parsed.label, value });
  }
  return result;
}

export function factsWithConfiguredGoal(
  facts: MemoryFacts,
  configuredGoal = '',
): MemoryFacts {
  const goal = normalizeDialogueGoal(configuredGoal);
  if (!goal) return { ...facts };
  const hasGoal = Object.keys(facts).some(
    (key) => category(key)?.type === 'goal',
  );
  return hasGoal ? { ...facts } : { цель: goal, ...facts };
}
