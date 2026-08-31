import { describe, expect, it } from 'vitest';

import type { ChatStreamEvent } from '@/lib/chat-types';
import { readChatStream } from '@/lib/read-chat-stream';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readChatStream', () => {
  it('собирает SSE-события из разрезанных чанков и игнорирует keep-alive', async () => {
    const events: ChatStreamEvent[] = [];
    const stream = streamFromChunks([
      ': keep-alive\r\n\r\nevent: del',
      'ta\r\ndata: {"content":"При"}\r\n\r\n',
      'event: delta\ndata: {"content":"вет"}\n\n',
      'event: done\ndata: {"finishReason":"stop"}\n\n',
    ]);

    await readChatStream(stream, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'delta', content: 'При' },
      { type: 'delta', content: 'вет' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('читает последнее событие даже без завершающей пустой строки', async () => {
    const events: ChatStreamEvent[] = [];
    const stream = streamFromChunks([
      'event: error\ndata: {"code":"stream_error","message":"Ошибка"}',
    ]);

    await readChatStream(stream, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'error', code: 'stream_error', message: 'Ошибка' },
    ]);
  });
});
