import type { ChatErrorPayload, ChatStreamEvent } from '@/lib/chat-types';
import type { ComparisonRequest } from '@/lib/comparison';
import { readChatStream } from '@/lib/read-chat-stream';

export async function requestComparison(
  request: ComparisonRequest,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const response = await fetch('/api/comparison', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as ChatErrorPayload | null;
    throw new Error(
      payload?.error?.message ?? 'Не удалось получить ответ от DeepSeek.',
    );
  }
  if (!response.body) throw new Error('DeepSeek вернул пустой ответ.');

  let completed = false;
  let prepared = false;
  let answer = '';
  await readChatStream(response.body, (event) => {
    if (signal.aborted) throw new Error('Генерация остановлена.');
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'prepared') prepared = Boolean(event.prompt.trim());
    if (event.type === 'delta') answer += event.content;
    if (event.type === 'done') {
      if (!prepared || !answer.trim())
        throw new Error('DeepSeek вернул пустой или некорректный ответ.');
      completed = true;
    }
    onEvent(event);
  });
  if (!completed)
    throw new Error('Поток ответа прервался. Попробуйте ещё раз.');
}
