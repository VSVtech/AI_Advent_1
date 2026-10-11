import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import { loadAgentSessions, saveAgentSessions } from '@/lib/agent-storage';
import { SharedLongTermMemory } from '@/lib/memory-layers';
import { formatModelLabel } from '@/lib/chat-constraints';
import { POST } from '@/app/api/chat/route';
import { readChatStream } from '@/lib/read-chat-stream';
import type { ChatRequest } from '@/lib/chat-types';
const model = 'ollama:qwen2.5:7b';
function answer(content: string) {
  return new Response(
    `event: delta\ndata: ${JSON.stringify({ content })}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n`,
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('unified local and cloud agents', () => {
  it('labels local models and restores both disabled settings without changing history', () => {
    expect(formatModelLabel(model)).toBe('qwen2.5:7b (локальная)');
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
    };
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      model,
      useRag: false,
      useMemory: false,
    });
    saveAgentSessions(storage, [agent], agent.id);
    expect(loadAgentSessions(storage).agents[0].config).toMatchObject({
      model,
      useRag: false,
      useMemory: false,
    });
    agent.dispose();
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('honors RAG=%s / memory=%s independently', async (useRag, useMemory) => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        return answer(
          body.format === 'json'
            ? '{"shortTerm":{"ограничение · платформа":"macOS"},"longTerm":[]}'
            : 'Ответ',
        );
      }),
    );
    const shared = new SharedLongTermMemory();
    shared.saveEntry('старый факт', 'private-value', 'knowledge');
    const agent = new Agent(
      {
        ...createDefaultAgentConfig(),
        model,
        useRag,
        useMemory,
        taskGoal: 'Цель',
      },
      undefined,
      undefined,
      shared,
      () => 'private-profile',
    );
    await agent.sendMessage('Работаем на macOS. Привет.');
    expect(agent.getSnapshot().error).toBeNull();
    expect(requests).toHaveLength(useMemory ? 2 : 1);
    expect(requests.every((r) => r.model === model)).toBe(true);
    const main = requests.at(-1)!;
    expect(Boolean(main.useRag)).toBe(useRag);
    expect(Boolean(main.ragGrounding)).toBe(useRag);
    expect(main.useMcpTools).toBe(false);
    if (useMemory) {
      expect(requests[0].format).toBe('json');
      expect(JSON.stringify(main.messages)).toContain('macOS');
      expect(main.longTermMemory).toHaveLength(1);
    } else {
      expect(JSON.stringify(main)).not.toContain('private');
      expect(JSON.stringify(main.messages)).not.toContain('Память задачи:');
    }
    agent.dispose();
  });
  it('uses the chosen cloud model for memory as well as the answer', async () => {
    const models: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const b = JSON.parse(init.body);
        models.push(b.model);
        return answer(
          b.format === 'json' ? '{"shortTerm":{},"longTerm":[]}' : 'OK',
        );
      }),
    );
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      model: 'deepseek-v4-pro',
      useRag: false,
    });
    await agent.sendMessage('Привет');
    expect(models).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro']);
    agent.dispose();
  });
  it.each([
    [false, 'baseline', false],
    [true, 'baseline', false],
    [true, 'compact', false],
    [false, 'baseline', true],
    [true, 'baseline', true],
    [true, 'compact', true],
  ] as const)(
    'generates locally with RAG=%s / profile=%s / custom settings=%s and no cloud calls',
    async (useRag, localRagProfile, custom) => {
      vi.stubEnv('DEEPSEEK_API_KEY', '');
      const quote = 'RAG-сервис запускается командой pnpm rag:server.';
      const actions: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          const u = new URL(url);
          expect(['localhost', '127.0.0.1']).toContain(u.hostname);
          const b = init?.body ? JSON.parse(init.body) : {};
          if (b.action) actions.push(b.action);
          if (b.action === 'prepare-dialogue')
            return Response.json({
              intent: 'knowledge',
              question: 'Как запустить RAG-сервис?',
            });
          if (b.action === 'search')
            return Response.json({
              build_id: 'b1',
              hits: [
                {
                  source: 'README.md',
                  title: 'README',
                  section: 'Запуск',
                  chunk_id: 'c1',
                  start_line: 1,
                  end_line: 1,
                  score: 0.9,
                  text: quote,
                },
              ],
            });
          if (b.action === 'verify-answer')
            return Response.json({
              checks: [
                { index: 0, verdict: 'supported', reason: 'Есть цитата' },
              ],
            });
          if (b.action === 'answer-coverage')
            return Response.json({ relevant_indices: [0], missing_parts: [] });
          if (u.pathname === '/api/tags')
            return Response.json({ models: [{ name: 'qwen2.5:7b', size: 1 }] });
          if (u.pathname === '/api/show')
            return Response.json({ capabilities: ['completion'] });
          expect(u.pathname).toBe('/api/chat');
          expect(b.model).toBe('qwen2.5:7b');
          if (custom)
            expect(b.options).toMatchObject({
              temperature: 0.7,
              num_ctx: 24576,
              num_predict: 3072,
            });
          if (useRag) {
            if (localRagProfile === 'compact') {
              expect(b.format).toMatchObject({
                type: 'object',
                required: ['unknown', 'claims'],
              });
              if (!custom)
                expect(b.options).toMatchObject({
                  temperature: 0,
                  num_ctx: 16384,
                  num_predict: 1536,
                });
              expect(b.messages[0].content).toContain('вопросы разработчика');
            } else expect(b.format).toBe('json');
            expect(JSON.stringify(b.messages)).toContain(quote);
          }
          const content = useRag
            ? JSON.stringify({
                unknown: false,
                claims: [
                  {
                    text: quote,
                    citations: [{ source_id: 'S1', quote_id: 1 }],
                  },
                ],
              })
            : 'Привет';
          return new Response(
            JSON.stringify({
              message: { content },
              done: true,
              done_reason: 'stop',
              eval_count: 10,
            }) + '\n',
          );
        }),
      );
      const response = await POST(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          body: JSON.stringify({
            model,
            localRagProfile,
            ...(custom
              ? {
                  temperature: 0.7,
                  contextWindowTokens: 24576,
                  maxOutputTokens: 3072,
                }
              : {}),
            targetOutputTokens: null,
            messages: [{ role: 'user', content: 'Как запустить RAG-сервис?' }],
            useRag,
            ...(useRag ? { ragGrounding: true, ragDialogue: true } : {}),
            useMcpTools: false,
          }),
        }),
      );
      expect(response.status).toBe(200);
      let result = '';
      await readChatStream(response.body!, (e) => {
        if (e.type === 'delta') result += e.content;
      });
      expect(result).toContain(useRag ? '**Источники**' : 'Привет');
      expect(actions).toEqual(
        useRag
          ? ['prepare-dialogue', 'search', 'verify-answer', 'answer-coverage']
          : [],
      );
    },
  );
  it('does not fall back to a cloud model when Ollama fails', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const fetcher = vi.fn(async (url) => {
      expect(new URL(url).hostname).toBe('127.0.0.1');
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetcher);
    const r = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      }),
    );
    expect(r.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
