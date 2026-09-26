import type { ChatStreamEvent } from '@/lib/chat-types';

function parseEventBlock(block: string): ChatStreamEvent | null {
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;

  if (eventName === 'prepared' && typeof data.prompt === 'string') {
    const promptOutputTokens = data.promptOutputTokens;
    return {
      type: 'prepared',
      prompt: data.prompt,
      ...(typeof promptOutputTokens === 'number' &&
      Number.isInteger(promptOutputTokens) &&
      promptOutputTokens >= 0
        ? { promptOutputTokens }
        : {}),
    };
  }

  if (eventName === 'delta' && typeof data.content === 'string') {
    return { type: 'delta', content: data.content };
  }

  if (eventName === 'done') {
    const outputTokens = data.outputTokens;
    const inputTokens = data.inputTokens;
    const cachedInputTokens = data.cachedInputTokens;
    const invariantInputTokens = data.invariantInputTokens;
    const invariantOutputTokens = data.invariantOutputTokens;
    const toolInputTokens = data.toolInputTokens;
    const toolOutputTokens = data.toolOutputTokens;
    const mcpTools = data.mcpTools;
    const weatherJobId = data.weatherJobId;
    const isNonNegativeInt = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0;

    return {
      type: 'done',
      finishReason:
        typeof data.finishReason === 'string' ? data.finishReason : 'stop',
      ...(isNonNegativeInt(outputTokens) ? { outputTokens } : {}),
      ...(isNonNegativeInt(inputTokens) ? { inputTokens } : {}),
      ...(isNonNegativeInt(cachedInputTokens) ? { cachedInputTokens } : {}),
      ...(isNonNegativeInt(invariantInputTokens)
        ? { invariantInputTokens }
        : {}),
      ...(isNonNegativeInt(invariantOutputTokens)
        ? { invariantOutputTokens }
        : {}),
      ...(isNonNegativeInt(toolInputTokens) ? { toolInputTokens } : {}),
      ...(isNonNegativeInt(toolOutputTokens) ? { toolOutputTokens } : {}),
      ...(Array.isArray(mcpTools) &&
      mcpTools.length <= 8 &&
      mcpTools.every((name) => typeof name === 'string' && name.length <= 128)
        ? { mcpTools }
        : {}),
      ...(typeof weatherJobId === 'string' &&
      /^[a-zA-Z0-9_-]{1,100}$/u.test(weatherJobId)
        ? { weatherJobId }
        : {}),
    };
  }

  if (
    eventName === 'error' &&
    typeof data.code === 'string' &&
    typeof data.message === 'string'
  ) {
    return { type: 'error', code: data.code, message: data.message };
  }

  return null;
}

export async function readChatStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (flush = false) => {
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      if (block.trim()) {
        const event = parseEventBlock(block);
        if (event) onEvent(event);
      }

      boundary = buffer.indexOf('\n\n');
    }

    if (flush && buffer.trim()) {
      const event = parseEventBlock(buffer);
      if (event) onEvent(event);
      buffer = '';
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consume();
    }

    buffer += decoder.decode();
    consume(true);
  } finally {
    reader.releaseLock();
  }
}
