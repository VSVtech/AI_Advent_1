import { estimateContextTokenCount } from '@/lib/chat-constraints';
import type { ApiChatMessage } from '@/lib/chat-types';
import { jsonError } from '@/lib/server/deepseek';

export function contextWindowError({
  contextWindowTokens,
  messages,
  systemPrompt,
}: {
  contextWindowTokens: number;
  messages: ApiChatMessage[];
  systemPrompt: string | null;
}): Response | null {
  const estimatedInputTokens = estimateContextTokenCount(
    messages,
    systemPrompt,
  );

  if (estimatedInputTokens <= contextWindowTokens) return null;

  return jsonError(413, {
    code: 'context_window_exceeded',
    message: `Контекст переполнен: история, память и инструкции занимают примерно ${estimatedInputTokens} токенов, а лимит агента — ${contextWindowTokens}. Увеличьте лимит или сократите контекст.`,
  });
}
