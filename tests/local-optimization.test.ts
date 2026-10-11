import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import { loadAgentSessions, saveAgentSessions } from '@/lib/agent-storage';
import {
  localRagPrompt,
  localRagContext,
  LOCAL_RAG_PROFILES,
} from '@/lib/local-rag-profile';
import {
  GROUNDING_PROMPT,
  resolveGroundedDraft,
} from '@/scripts/rag/grounding.mjs';
import type { ChatRequest } from '@/lib/chat-types';
import type { RagRetrieval } from '@/lib/rag-context';

it('keeps cross-source quote IDs and follow-up evidence compatible with the existing verifier', () => {
  const source = {
    id: 'S1',
    source: 'README.md',
    title: 'README',
    section: 'Запуск',
    chunk_id: 'first',
    start_line: 1,
    end_line: 2,
    score: 0.9,
    text: 'Первый сервис слушает порт 18803.',
  };
  const retrieval: RagRetrieval = {
    build_id: 'test',
    strategy: 'overlap',
    query: 'Какой порт?',
    sources: [source],
    followup: {
      build_id: 'test',
      strategy: 'overlap',
      query: 'Какой порт?',
      sources: [
        {
          ...source,
          chunk_id: 'second',
          text: 'Второй сервис слушает порт 11434.',
        },
      ],
    },
  };
  const catalog = localRagContext(retrieval, 'compact');
  if (Array.isArray(catalog)) throw new Error('Expected compact evidence');
  expect(catalog.evidence).toEqual([
    { source_id: 'S1', quote_id: 1, quote: source.text },
    {
      source_id: 'S2',
      quote_id: 1,
      quote: 'Второй сервис слушает порт 11434.',
    },
  ]);
  const resolved = resolveGroundedDraft(
    {
      unknown: false,
      claims: [
        {
          text: 'Порт второго сервиса 11434.',
          citations: [{ source_id: 'S2', quote_id: 1 }],
        },
      ],
    },
    retrieval,
  );
  expect(resolved.claims[0].citations[0].quote).toBe(
    'Второй сервис слушает порт 11434.',
  );
  expect(() =>
    resolveGroundedDraft(
      {
        unknown: false,
        claims: [
          {
            text: 'Несуществующая цитата.',
            citations: [{ source_id: 'S3', quote_id: 1 }],
          },
        ],
      },
      retrieval,
    ),
  ).toThrow('invalid_citation');
});

afterEach(() => vi.unstubAllGlobals());
it('preserves the baseline prompt and uses a smaller bounded compact profile', () => {
  expect(localRagPrompt('baseline')).toBe(GROUNDING_PROMPT);
  expect(localRagPrompt('compact').length).toBeLessThan(
    GROUNDING_PROMPT.length,
  );
  expect(LOCAL_RAG_PROFILES.compact.contextTokens).toBeLessThan(
    LOCAL_RAG_PROFILES.baseline.contextTokens,
  );
});
it('rejects unrecognized profile before inference', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const r = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'ollama:qwen2.5:7b',
        messages: [{ role: 'user', content: 'Привет' }],
        localRagProfile: 'unbounded',
      }),
    }),
  );
  expect(r.status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['baseline', 'compact'] as const)(
  'saves custom settings independently of template %s and shares the context window with memory',
  async (localRagProfile) => {
    const requests: ChatRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        const content =
          body.format === 'json'
            ? '{"shortTerm":{"ограничение · платформа":"macOS"},"longTerm":[]}'
            : 'OK';
        return new Response(
          `event: delta\ndata: ${JSON.stringify({ content })}\n\nevent: done\ndata: {"finishReason":"stop"}\n\n`,
        );
      }),
    );
    const agent = new Agent({
      ...createDefaultAgentConfig(),
      model: 'ollama:qwen2.5:7b',
      localRagProfile,
      temperature: 0.6,
      maxOutputTokens: 2048,
      contextWindowTokens: 24576,
    });
    await agent.sendMessage('Используем macOS. Как запустить сервис?');
    expect(requests[0]).toMatchObject({
      model: 'ollama:qwen2.5:7b',
      format: 'json',
      contextWindowTokens: 24576,
    });
    expect(requests[1]).toMatchObject({
      localRagProfile,
      temperature: 0.6,
      contextWindowTokens: 24576,
      maxOutputTokens: 2048,
      ragGrounding: true,
    });
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
    };
    saveAgentSessions(storage, [agent], agent.id);
    expect(loadAgentSessions(storage).agents[0].config).toEqual(agent.config);
    agent.dispose();
  },
);

it('rejects oversized compact RAG context without silently truncating or invoking Ollama', async () => {
  const fetcher = vi.fn(async (url) => {
    expect(String(url)).toContain('18803/rag');
    return Response.json({
      build_id: 'snapshot',
      hits: [
        {
          source: 'README.md',
          title: 'README',
          section: 'Запуск',
          chunk_id: 'c1',
          start_line: 1,
          end_line: 20,
          score: 0.9,
          text: Array.from(
            { length: 12 },
            (_, i) => `Абзац ${i} ${'я'.repeat(1190)}`,
          ).join('\n\n'),
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const r = await POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'ollama:qwen2.5:7b',
        localRagProfile: 'compact',
        useRag: true,
        ragGrounding: true,
        contextWindowTokens: 16384,
        targetOutputTokens: null,
        messages: [
          { role: 'user', content: 'я'.repeat(18000) },
          { role: 'assistant', content: 'Ок' },
          { role: 'user', content: 'Как запустить сервис?' },
        ],
      }),
    }),
  );
  expect(r.status).toBe(413);
  const payload = (await r.json()) as { error: { code: string } };
  expect(payload.error.code).toBe('context_window_exceeded');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
