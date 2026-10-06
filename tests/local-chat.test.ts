import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/local-chat/route';
import { readChatStream } from '@/lib/read-chat-stream';
import {
  localContext,
  restoreLocalChat,
  type LocalMessage,
} from '@/lib/local-chat';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function request(body: unknown, origin?: string) {
  return new Request('http://localhost:3000/api/local-chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}
const input = {
  model: 'qwen2.5:7b',
  messages: [{ role: 'user', content: 'Привет' }],
};
function ollama(
  streamText = '{"message":{"content":"Привет"},"done":false}\n{"done":true,"done_reason":"stop","eval_count":3}\n',
) {
  return vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/tags')
      return Response.json({
        models: [
          { name: 'qwen2.5:7b', size: 4000 },
          { name: 'embed', size: 100 },
          { name: 'remote', size: 0 },
        ],
      });
    if (path === '/api/show') {
      const name = JSON.parse(init.body).model;
      return Response.json(
        name === 'remote'
          ? { capabilities: ['completion'], remote_host: 'https://ollama.com' }
          : { capabilities: [name === 'embed' ? 'embedding' : 'completion'] },
      );
    }
    if (path !== '/api/chat') throw new Error('Unexpected external call');
    const bytes = new TextEncoder().encode(streamText);
    return new Response(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
          c.close();
        },
      }),
    );
  });
}
describe('local-only chat', () => {
  it('lists only installed local completion models', async () => {
    vi.stubGlobal('fetch', ollama());
    const r = await GET(new Request('http://localhost:3000/api/local-chat'));
    expect(await r.json()).toEqual({
      models: [{ name: 'qwen2.5:7b', size: 4000 }],
    });
  });
  it('rejects non-local configuration before sending any data', async () => {
    const fetcher = ollama();
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('LOCAL_OLLAMA_URL', 'https://external.example');
    expect((await POST(request(input))).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects cross-origin, malformed history, arbitrary models and client system instructions', async () => {
    const fetcher = ollama();
    vi.stubGlobal('fetch', fetcher);
    expect((await POST(request(input, 'https://other.example'))).status).toBe(
      403,
    );
    expect(
      (
        await POST(
          request({
            ...input,
            messages: [{ role: 'system', content: 'test' }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({
            ...input,
            messages: [{ role: 'user', content: 'x'.repeat(16001) }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await POST(request({ ...input, model: 'remote' }))).status).toBe(
      400,
    );
    expect(
      fetcher.mock.calls.every(
        ([url]) => new URL(url).pathname !== '/api/chat',
      ),
    ).toBe(true);
  });
  it('streams split UTF-8 safely and passes only the supplied chat history to loopback', async () => {
    const fetcher = ollama();
    vi.stubGlobal('fetch', fetcher);
    const r = await POST(request(input));
    const events: unknown[] = [];
    await readChatStream(r.body!, (e) => events.push(e));
    expect(events).toEqual([
      { type: 'delta', content: 'Привет' },
      { type: 'done', finishReason: 'stop', outputTokens: 3 },
    ]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(url).hostname).toBe('127.0.0.1');
      expect(init.redirect).toBe('manual');
    }
    const [, init] = fetcher.mock.calls.find(
      ([url]) => new URL(url).pathname === '/api/chat',
    )!;
    expect(JSON.parse(init.body)).toMatchObject({
      model: input.model,
      messages: input.messages,
      think: false,
      stream: true,
    });
  });
  it('reports a truncated stream and upstream failures as errors, never successful answers', async () => {
    vi.stubGlobal('fetch', ollama('{"message":{"content":"Часть"}}\n'));
    const r = await POST(request(input));
    const events: Array<{ type: string }> = [];
    await readChatStream(r.body!, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(['delta', 'error']);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await POST(request(input))).status).toBe(503);
  });
  it('stops upstream generation when the client cancels', async () => {
    const fake = ollama();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (new URL(url).pathname !== '/api/chat') return fake(url, init);
        upstreamSignal = init.signal;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode('{"message":{"content":"A"}}\n'),
              );
            },
          }),
        );
      }),
    );
    const r = await POST(request(input));
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
  });
  it('restores interrupted history and bounds the next request, excluding incomplete answers', () => {
    const history: LocalMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      role: i % 2 ? 'assistant' : 'user',
      content: 'x'.repeat(2000),
      status: i === 19 ? 'streaming' : 'complete',
    }));
    const restored = restoreLocalChat(
      JSON.stringify({ model: 'qwen2.5:7b', messages: history }),
    );
    expect(restored.messages.at(-1)?.status).toBe('stopped');
    const context = localContext(restored.messages);
    expect(context.length).toBeLessThanOrEqual(12);
    expect(
      context.reduce((n, m) => n + m.content.length, 0),
    ).toBeLessThanOrEqual(16000);
    expect(context[0].role).toBe('user');
    expect(context.at(-1)?.role).toBe('user');
    expect(restoreLocalChat('corrupt').messages).toEqual([]);
  });
});
