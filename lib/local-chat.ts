export const LOCAL_CHAT_KEY = 'local-llm-chat-v1';
export const LOCAL_EXAMPLES = [
  { level: 'Простой', prompt: 'Сколько будет 17 + 25? Ответь одним числом.' },
  {
    level: 'Объяснение',
    prompt:
      'Объясни разницу между процессом и потоком в операционной системе. Дай три отличия и один короткий пример. Ответь по-русски.',
  },
  {
    level: 'Код и логика',
    prompt:
      'Напиши функцию uniqueStable(items) на Python: удали повторы, сохрани порядок первого появления, не меняй исходный список. Элементы хешируемые. Покажи результат для [3, 1, 3, 2, 1] и объясни сложность по времени и памяти. Ответь по-русски.',
  },
];
export type LocalMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'streaming' | 'stopped' | 'error';
  model?: string;
  tokens?: number;
  seconds?: number;
};
export type LocalModel = { name: string; size: number };

export function localContext(messages: LocalMessage[]) {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let length = 0;
  for (const m of messages.slice(-12).reverse()) {
    if (m.status !== 'complete' || !m.content) continue;
    if (length + m.content.length > 16000) break;
    length += m.content.length;
    result.unshift({ role: m.role, content: m.content });
  }
  while (result[0]?.role === 'assistant') result.shift();
  return result;
}

export function restoreLocalChat(raw: string | null): {
  model: string;
  messages: LocalMessage[];
} {
  const empty = { model: 'qwen2.5:7b', messages: [] as LocalMessage[] };
  try {
    if (!raw || raw.length > 300000) return empty;
    const value = JSON.parse(raw);
    if (!Array.isArray(value.messages)) return empty;
    return {
      model: typeof value.model === 'string' ? value.model : empty.model,
      messages: value.messages
        .slice(-60)
        .filter(
          (m: LocalMessage) =>
            m &&
            typeof m.id === 'string' &&
            ['user', 'assistant'].includes(m.role) &&
            typeof m.content === 'string' &&
            m.content.length <= 24000 &&
            ['complete', 'streaming', 'stopped', 'error'].includes(m.status),
        )
        .map((m: LocalMessage) => ({
          ...m,
          status: m.status === 'streaming' ? 'stopped' : m.status,
        })),
    };
  } catch {
    return empty;
  }
}
