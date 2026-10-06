import { stringify as yaml } from 'yaml';
import type { ApiChatMessage, ChatOutputFormat } from '@/lib/chat-types';
import { ragQuery } from '@/lib/rag-context';
import { validateDialoguePlan } from '@/scripts/rag/dialogue.mjs';
import { RagError } from './rag';

export function dialogueInput(messages: ApiChatMessage[]) {
  const current = ragQuery(messages);
  // User messages include the structured session memory, but never assistant
  // answers: generated claims must not become assumptions of a new search.
  const previous = messages
    .slice(0, -1)
    .filter((m) => m.role === 'user' && typeof m.content === 'string');
  const memory = previous.find((m) =>
    (m.content as string).startsWith('Память задачи:'),
  );
  const recent = previous.filter((m) => m !== memory).slice(-8);
  let budget = 5000;
  const recentContext = recent
    .reverse()
    .map((m) => {
      const text = (m.content as string).slice(0, Math.min(1400, budget));
      budget -= text.length;
      return text;
    })
    .filter(Boolean)
    .reverse();
  return {
    current,
    context: [
      ...(memory ? [(memory.content as string).slice(0, 4000)] : []),
      ...recentContext,
    ],
  };
}

export async function prepareDialogueQuestion(
  messages: ApiChatMessage[],
  signal: AbortSignal,
) {
  const input = dialogueInput(messages);
  try {
    const response = await fetch(
      process.env.RAG_SERVICE_URL ?? 'http://127.0.0.1:18803/rag',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prepare-dialogue', ...input }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(95_000)]),
      },
    );
    if (!response.ok) throw new Error('dialogue_preparation_failed');
    return validateDialoguePlan(await response.json(), input);
  } catch {
    if (signal.aborted) throw signal.reason;
    // A failed intent check is an operational error, not lack of knowledge.
    throw new RagError(
      'rag_dialogue_unavailable',
      'Не удалось подготовить вопрос с учётом диалога. Проверьте локальный RAG-сервис и Qwen2.5:7b; повторите запрос.',
    );
  }
}

export function renderDialogueContext(
  messages: ApiChatMessage[],
  format: ChatOutputFormat,
) {
  const input = dialogueInput(messages);
  const memoryMessage = messages
    .slice(0, -1)
    .find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.startsWith('Память задачи:'),
    )?.content as string | undefined;
  const rawMemory = memoryMessage
    ?.split('Состояние задачи текущего диалога:\n')[1]
    ?.split('\n')[0];
  let memory: unknown = null;
  try {
    if (rawMemory) memory = JSON.parse(rawMemory);
  } catch {
    /* Show current quotation if memory is unavailable. */
  }
  const result = {
    kind: 'dialogue_context',
    answer:
      'Это контекст нашей задачи. Для пользовательских условий подтверждение в документах не требуется.',
    memory,
    sources: [
      'Текущее сообщение пользователя',
      ...(memory ? ['Память текущего диалога'] : []),
    ],
    quote: input.current,
  };
  if (format === 'json') return JSON.stringify(result, null, 2);
  if (format === 'yaml') return yaml(result);
  if (format === 'xml') {
    const escaped = JSON.stringify(result)
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;');
    return `<dialogue_context>${escaped}</dialogue_context>`;
  }
  const entries =
    memory && typeof memory === 'object' && !Array.isArray(memory)
      ? Object.entries(memory)
          .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
          .join('\n')
      : '';
  return `${result.answer}\n\n${entries ? `Доступная память задачи:\n${entries}\n\n` : ''}**Источники:** ${result.sources.join('; ')}. Это пользовательский контекст, а не сведения из базы знаний.\n\n**Цитата из текущего сообщения:**\n${input.current
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`;
}
