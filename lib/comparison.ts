import type { ApiChatMessage } from '@/lib/chat-types';

export const COMPARISON_MAX_OUTPUT_TOKENS = 8000;
export const MAX_COMPARISON_PROMPT_LENGTH = 20_000;
export const MAX_COMPARISON_HISTORY_MESSAGES = 98;
export const PROMPT_CREATION_PREFIX = 'Составь промпт для решения задачи: ';
export const STEP_BY_STEP_SUFFIX = ' Решай пошагово.';

export const COMPARISON_VARIANTS = [
  {
    id: 1,
    title: 'Без системного промпта',
    systemPrompt: '',
    description: 'Пользовательский промпт без изменений.',
  },
  {
    id: 2,
    title: 'Пошагово в system',
    systemPrompt: 'решай пошагово',
    description: 'Инструкция только в системном промпте.',
  },
  {
    id: 3,
    title: 'Пошагово в user',
    systemPrompt: '',
    description: `В конец запроса добавляется: «${STEP_BY_STEP_SUFFIX.trim()}»`,
  },
  {
    id: 4,
    title: 'Создание промпта',
    systemPrompt: '',
    description: `Сначала «${PROMPT_CREATION_PREFIX}…», затем отдельный запрос с полученным промптом.`,
  },
  {
    id: 5,
    title: 'Группа экспертов',
    systemPrompt:
      'Создай группу экспертов: аналитик, инженер, критик. Получи решение от каждого и одно общее',
    description: 'Три решения и одно общее в одном ответе модели.',
  },
] as const;

export type ComparisonVariant = (typeof COMPARISON_VARIANTS)[number];
export type ComparisonVariantId = ComparisonVariant['id'];

export interface ComparisonRequest {
  variant: ComparisonVariantId;
  prompt: string;
  messages: ApiChatMessage[];
}

export interface ComparisonTurn {
  id: string;
  prompt: string;
  actualPrompt?: string;
  answer: string;
  status: 'preparing' | 'streaming' | 'complete' | 'error' | 'stopped';
  error?: string;
  outputTokens?: number;
  promptOutputTokens?: number;
}

export function comparisonHistory(turns: ComparisonTurn[]): ApiChatMessage[] {
  return turns.flatMap((turn) =>
    turn.status === 'complete' && turn.actualPrompt && turn.answer.trim()
      ? [
          { role: 'user' as const, content: turn.actualPrompt },
          { role: 'assistant' as const, content: turn.answer },
        ]
      : [],
  );
}
