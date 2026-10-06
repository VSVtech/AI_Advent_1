import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { completedOutputResponse } from '@/lib/server/deepseek';
import {
  enforceGroundedResponse,
  unknownGroundedResponse,
} from '@/lib/server/rag-grounding';
import { readChatStream } from '@/lib/read-chat-stream';
import type { ChatStreamEvent } from '@/lib/chat-types';
import { restoreRagRetrieval } from '@/lib/rag-context';
import {
  followupSearch,
  runGrounding,
  listContinuationSearch,
  selectFollowupSources,
} from '@/scripts/rag/grounding-flow.mjs';
import type { RagRetrieval } from '@/lib/rag-context';
import {
  isGroundedDraft,
  validateGroundedDraft,
  resolveGroundedDraft,
  groundingContextSources,
  renderGroundedAnswer,
  supportedAnswer,
  unknownAnswer,
  passesGroundingThreshold,
} from '@/scripts/rag/grounding.mjs';
import {
  LocalGroundingVerifier,
  coverageFromParts,
  questionParts,
  hasUnquotedNumber,
  hasOnlyNumericDeclarations,
  validateGroundingChecks,
} from '@/scripts/rag/grounding-model.mjs';
import { createRagHandler } from '@/scripts/rag/server.mjs';
import { validateStructuredOutput } from '@/lib/structured-output';

const query = 'Где хранится история?';
const quote = 'История хранится только в localStorage браузера.';
const retrieval: RagRetrieval = {
  build_id: 'b1',
  strategy: 'overlap',
  query,
  sources: [
    {
      id: 'S1',
      source: 'README.md',
      section: 'Хранение',
      chunk_id: 'c1',
      title: 'Project',
      start_line: 1,
      end_line: 2,
      score: 0.8,
      text: quote,
    },
  ],
};
const draft = {
  unknown: false,
  claims: [
    {
      text: 'История хранится в localStorage.',
      citations: [{ source_id: 'S1', quote }],
    },
  ],
};
const signal = () => new AbortController().signal;
const modelDraft = (value = draft) => ({
  ...value,
  claims: value.claims.map((c) => ({
    ...c,
    citations: c.citations.map((e) => ({
      source_id: e.source_id,
      quote_id: 1,
    })),
  })),
});
const generated = (value = draft) =>
  completedOutputResponse(JSON.stringify(modelDraft(value)), {
    outputTokens: 123,
    inputTokens: 500,
  });
const checked = (supported = true) =>
  Response.json({
    checks: [
      {
        index: 0,
        verdict: supported ? 'supported' : 'contradicted',
        reason: supported
          ? 'Цитата подтверждает факт.'
          : 'Противоречие цитате.',
      },
    ],
  });
async function read(response: Response) {
  const events: ChatStreamEvent[] = [];
  await readChatStream(response.body!, (e) => events.push(e));
  return {
    content: events
      .filter((e) => e.type === 'delta')
      .map((e) => e.content)
      .join(''),
    events,
  };
}
const fullCoverage = () =>
  Response.json({ relevant_indices: [0], missing_parts: [] });
function withCoverage(fetcher: typeof fetch) {
  return (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    return body.action === 'answer-coverage'
      ? Promise.resolve(fullCoverage())
      : fetcher(url, init);
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Grounded answer contract', () => {
  it('accepts a seven-component answer while keeping a bounded claim count', () => {
    expect(
      isGroundedDraft({
        unknown: false,
        claims: Array.from({ length: 7 }, () => draft.claims[0]),
      }),
    ).toBe(true);
    expect(
      isGroundedDraft({
        unknown: false,
        claims: Array.from({ length: 11 }, () => draft.claims[0]),
      }),
    ).toBe(false);
  });
  it('loads continuation of a visibly cut list before generation and excludes duplicate chunks', () => {
    const context = {
      ...retrieval,
      query: 'Каковы основные компоненты системы?',
      sources: [
        {
          ...retrieval.sources[0],
          text: '- Agent хранит историю.\n- Ollama выполняет локальные',
        },
      ],
    };
    const next = listContinuationSearch(context)!;
    expect(next.query).toContain('Agent Ollama');
    expect(next.options.minSimilarity).toBe(0.45);
    expect(
      listContinuationSearch({ ...context, query: 'Где хранится история?' }),
    ).toBeNull();
    const extra = { ...retrieval.sources[0], chunk_id: 'new-chunk' };
    expect(selectFollowupSources(context, [context.sources[0], extra])).toEqual(
      [{ ...extra, id: 'S1' }],
    );
  });
  it('keeps list details accessible when preliminary evidence selected only the introduction', () => {
    const introduction = 'Система состоит из следующих компонентов.';
    const detail = '- Agent хранит историю диалога в localStorage.';
    const source = {
      ...retrieval.sources[0],
      text: `${introduction}\n\n${detail}`,
      evidence: [{ quote: introduction, question_part: query }],
    };
    const context = { ...retrieval, sources: [source] };
    const quotes = groundingContextSources(context)[0].quotes;
    const listQuote = quotes.find((q) => q.quote.includes('Agent'))!;
    expect(listQuote).toBeDefined();
    const resolved = resolveGroundedDraft(
      {
        unknown: false,
        claims: [
          {
            text: 'Agent хранит историю в localStorage.',
            citations: [{ source_id: 'S1', quote_id: listQuote.quote_id }],
          },
        ],
      },
      context,
    );
    expect(resolved.claims[0].citations[0].quote).toBe(detail);
  });
  it('adds literal list anchors to follow-up search without duplicating the original question', () => {
    const context = {
      ...retrieval,
      sources: [
        {
          ...retrieval.sources[0],
          text: '- Класс `Agent` хранит историю.\n- Ollama выполняет модели.',
        },
      ],
    };
    const next = followupSearch(
      context,
      { unknown: false, claims: [] },
      [],
      [query],
    );
    expect(next.query).toBe(`${query}\nAgent Ollama`);
    expect(next.options.minSimilarity).toBe(0.45);
  });
  it('binds every claim to literal quotes and derives metadata from retrieved chunks', () => {
    expect(validateGroundedDraft(draft, retrieval)).toEqual(draft);
    const result = supportedAnswer(draft, retrieval);
    expect(result.sources).toEqual([
      {
        id: 'S1',
        source: 'README.md',
        section: 'Хранение',
        chunk_id: 'c1',
        start_line: 1,
        end_line: 2,
      },
    ]);
    expect(result.citations).toEqual([{ claim: 1, source_id: 'S1', quote }]);
  });
  it.each([
    { ...draft, answer: 'Uncited fact' },
    { unknown: false, claims: [] },
    { unknown: true, claims: draft.claims },
    { unknown: false, claims: [{ text: 'No citations', citations: [] }] },
    { unknown: false, claims: [{ ...draft.claims[0], extra: 'fact' }] },
  ])('rejects uncited fields and malformed contracts: %j', (value) => {
    expect(isGroundedDraft(value)).toBe(false);
    expect(() => validateGroundedDraft(value, retrieval)).toThrow();
  });
  it.each([
    { source_id: 'S99', quote },
    {
      source_id: 'S1',
      quote: 'История хранится только в PostgreSQL браузера.',
    },
  ])('rejects invented source IDs and nonliteral quotes: %j', (citation) => {
    expect(() =>
      validateGroundedDraft(
        { ...draft, claims: [{ ...draft.claims[0], citations: [citation] }] },
        retrieval,
      ),
    ).toThrow('invalid_citation');
  });
  it('resolves quote IDs to exact text and rejects unknown catalog entries', () => {
    expect(resolveGroundedDraft(modelDraft(), retrieval)).toEqual(draft);
    expect(() =>
      resolveGroundedDraft(
        {
          unknown: false,
          claims: [
            { text: 'Fact', citations: [{ source_id: 'S1', quote_id: 99 }] },
          ],
        },
        retrieval,
      ),
    ).toThrow('invalid_citation');
  });
  it('enforces the threshold even if the retrieval filter was switched off', () => {
    expect(() =>
      validateGroundedDraft(draft, {
        ...retrieval,
        sources: [{ ...retrieval.sources[0], score: 0.1 }],
      }),
    ).toThrow('below_threshold');
    expect(
      passesGroundingThreshold(
        { score: 0.99, rerank_score: 0.01 },
        { rerank: true, minRerankScore: 0.05 },
      ),
    ).toBe(false);
    expect(passesGroundingThreshold({ score: 0.45 }, undefined)).toBe(true);
  });
  it('keeps neighbouring table rows and method descriptions as separate literal quotes', () => {
    const text =
      '| Временная | не передаётся |\n| Постоянная | передаётся |\n- `A.stop()` прерывает запрос, `A.dispose()` снимает подписку.';
    const catalog = groundingContextSources({
      ...retrieval,
      sources: [{ ...retrieval.sources[0], text }],
    });
    const quotes = catalog[0].quotes.map((q) => q.quote);
    expect(quotes.every((q) => text.includes(q))).toBe(true);
    expect(
      quotes.some((q) => q.includes('Временная') && q.includes('Постоянная')),
    ).toBe(false);
    expect(
      quotes.some((q) => q.includes('A.stop()') && q.includes('A.dispose()')),
    ).toBe(false);
  });
  it('verifies each claim without exposing another claim’s citations', async () => {
    const bodies: { claims: { text: string }[] }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).endsWith('/api/tags'))
          return Response.json({
            models: [{ name: 'qwen2.5:7b', digest: 'test' }],
          });
        const body = JSON.parse(String(init?.body));
        bodies.push(JSON.parse(body.messages[1].content));
        return Response.json({
          message: {
            content: JSON.stringify({
              checks: [
                {
                  index: 0,
                  citation_subject: 'История',
                  claim_subject: 'История',
                  scope_matches: true,
                  reason: 'Подтверждено.',
                  verdict: 'supported',
                },
              ],
            }),
          },
        });
      }),
    );
    const claims = [
      draft.claims[0],
      { ...draft.claims[0], text: 'Другой факт' },
    ];
    const result = await new LocalGroundingVerifier().verify(
      query,
      claims,
      signal(),
    );
    expect(bodies.map((b) => b.claims.length)).toEqual([1, 1]);
    expect(bodies.every((b) => !Object.hasOwn(b, 'QUESTION'))).toBe(true);
    expect(bodies[0].claims[0].text).toBe(claims[0].text);
    expect(bodies[1].claims[0].text).toBe(claims[1].text);
    expect(result.checks.map((c: { index: number }) => c.index)).toEqual([
      0, 1,
    ]);
  });
  it('requires exactly one well-formed verdict per claim', () => {
    for (const checks of [
      [],
      [{ index: 0, supported: 'true', reason: 'fake' }],
      [{ index: 1, verdict: 'supported', reason: 'wrong id' }],
    ])
      expect(() => validateGroundingChecks({ checks }, 1)).toThrow();
    expect(() =>
      validateGroundingChecks(
        {
          checks: [
            { index: 0, verdict: 'supported', reason: 'ok' },
            { index: 0, verdict: 'supported', reason: 'duplicate' },
          ],
        },
        2,
      ),
    ).toThrow();
  });
  it.each(['json', 'xml', 'yaml'] as const)(
    'renders supported answers and refusals in valid %s',
    (format) => {
      for (const result of [
        supportedAnswer(draft, retrieval),
        unknownAnswer('weak_context'),
      ])
        expect(
          validateStructuredOutput(
            renderGroundedAnswer(result, format),
            format,
          ),
        ).toBe(true);
    },
  );
});

describe('Server grounding gate', () => {
  it('publishes only the verified answer with sources and quotes and preserves usage', async () => {
    const fetcher = vi.fn().mockResolvedValue(checked());
    vi.stubGlobal('fetch', withCoverage(fetcher));
    const response = await enforceGroundedResponse(
      generated(),
      retrieval,
      'json',
      signal(),
    );
    const { content, events } = await read(response);
    const result = JSON.parse(content);
    expect(result.status).toBe('supported');
    expect(result.sources[0].chunk_id).toBe('c1');
    expect(result.citations[0].quote).toBe(quote);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      outputTokens: 123,
      inputTokens: 500,
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      action: 'verify-answer',
      query,
      claims: draft.claims,
    });
  });
  it('does not stream draft tokens while semantic verification is pending', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      withCoverage(
        vi.fn(
          () =>
            new Promise<Response>((r) => {
              resolve = r;
            }),
        ),
      ),
    );
    let delivered = false;
    const pending = enforceGroundedResponse(
      generated(),
      retrieval,
      'text',
      signal(),
    ).then((r) => {
      delivered = true;
      return r;
    });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    expect(delivered).toBe(false);
    resolve(checked());
    expect((await pending).status).toBe(200);
  });
  it('replaces a semantically unsupported draft entirely and asks for clarification', async () => {
    vi.stubGlobal(
      'fetch',
      withCoverage(vi.fn().mockImplementation(async () => checked(false))),
    );
    const malicious = {
      ...draft,
      claims: [{ ...draft.claims[0], text: 'История хранится в PostgreSQL.' }],
    };
    const { content } = await read(
      await enforceGroundedResponse(
        generated(malicious),
        retrieval,
        'text',
        signal(),
      ),
    );
    expect(content).toContain('Не знаю');
    expect(content).toContain('Уточните');
    expect(content).not.toContain('PostgreSQL');
    expect(content).not.toContain('[S1]');
  });
  it('repairs at most once, verifies the replacement and accounts for both generations', async () => {
    vi.stubGlobal(
      'fetch',
      withCoverage(
        vi
          .fn()
          .mockResolvedValueOnce(checked(false))
          .mockResolvedValueOnce(checked()),
      ),
    );
    const repair = vi.fn(async () => generated());
    const response = await enforceGroundedResponse(
      generated(),
      retrieval,
      'json',
      signal(),
      repair,
    );
    const { content, events } = await read(response);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(content).status).toBe('supported');
    expect(events.at(-1)).toMatchObject({
      inputTokens: 1000,
      outputTokens: 246,
    });
  });
  it('refuses after an unsuccessful repair without entering a retry loop', async () => {
    vi.stubGlobal(
      'fetch',
      withCoverage(vi.fn().mockImplementation(async () => checked(false))),
    );
    const repair = vi.fn(async () => generated());
    const { content } = await read(
      await enforceGroundedResponse(
        generated(),
        retrieval,
        'json',
        signal(),
        repair,
      ),
    );
    expect(repair).toHaveBeenCalledTimes(1);
    expect(JSON.parse(content).status).toBe('unknown');
  });
  it('never calls the judge or invents citations for an invalid draft', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', withCoverage(fetcher));
    const response = await enforceGroundedResponse(
      completedOutputResponse('Uncited claim', { outputTokens: 5 }),
      retrieval,
      'json',
      signal(),
    );
    expect(JSON.parse((await read(response)).content)).toMatchObject({
      status: 'unknown',
      sources: [],
      citations: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports verifier failure as an error, not a false lack of knowledge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const response = await enforceGroundedResponse(
      generated(),
      retrieval,
      'text',
      signal(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'grounding_unavailable' },
    });
  });
  it('does not publish truncated or cancelled output', async () => {
    const response = new Response(
      'event: delta\ndata: {"content":"unverified"}\n\n',
    );
    expect(
      (await enforceGroundedResponse(response, retrieval, 'text', signal()))
        .status,
    ).toBe(502);
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await enforceGroundedResponse(
          generated(),
          retrieval,
          'text',
          controller.signal,
        )
      ).status,
    ).toBe(499);
  });
  it('returns an explicit refusal with empty lists', async () => {
    const { content } = await read(
      unknownGroundedResponse('weak_context', 'json'),
    );
    expect(JSON.parse(content)).toMatchObject({
      status: 'unknown',
      answer: expect.stringContaining('Не знаю'),
      clarification: expect.stringContaining('Уточните'),
      sources: [],
      citations: [],
    });
  });
});

describe('Chat integration', () => {
  const request = (extra = {}) =>
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        useRag: true,
        ragGrounding: true,
        useMcpTools: true,
        useSystemPrompt: false,
        targetOutputTokens: null,
        ...extra,
      }),
    });
  it('uses JSON internally and shows citations in the regular text chat', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ build_id: 'b1', hits: retrieval.sources }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify(modelDraft()) },
              ],
            },
          ],
          usage: { input_tokens: 50, output_tokens: 70 },
        }),
      )
      .mockResolvedValueOnce(checked());
    vi.stubGlobal('fetch', withCoverage(fetcher));
    const response = await POST(request());
    expect(response.status).toBe(200);
    const { content, events } = await read(response);
    expect(content).toContain('**Источники**');
    expect(content).toContain('**Цитаты**');
    expect(content).toContain('Хранение');
    expect(events[0]).toMatchObject({ type: 'rag' });
    const generation = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(generation.text.format.type).toBe('json_object');
    expect(generation.instructions).toContain('claims');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('refuses weak context without generating or calling the judge even with filter disabled', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        build_id: 'b1',
        hits: [{ ...retrieval.sources[0], score: 0.1 }],
      }),
    );
    vi.stubGlobal('fetch', withCoverage(fetcher));
    const { content } = await read(
      await POST(
        request({
          ragSearch: {
            rewrite: false,
            filter: false,
            topKBefore: 5,
            topKAfter: 5,
            minSimilarity: 0.45,
          },
        }),
      ),
    );
    expect(content).toContain('Не знаю');
    expect(content).toContain('Уточните');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses empty search results without requiring a cloud API key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ build_id: 'b1', hits: [] }));
    vi.stubGlobal('fetch', withCoverage(fetcher));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await read(response)).content).toContain('Не знаю');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed grounding flags before network calls', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', withCoverage(fetcher));
    expect((await POST(request({ ragGrounding: 'yes' }))).status).toBe(400);
    expect((await POST(request({ useRag: false }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Separate facts, coverage and partial answers', () => {
  const multiQuestion = 'Где хранится история и каков лимит файлов?';
  const incomplete = {
    relevant_indices: [0],
    missing_parts: ['каков лимит файлов'],
  };
  const irrelevant = { ...draft.claims[0], text: 'Лимит файлов равен 10.' };
  const raw = (claims = draft.claims) =>
    JSON.stringify(modelDraft({ unknown: false, claims }));
  const noAnswer = JSON.stringify({ unknown: true, claims: [] });
  const verdict = (v: string, index = 0) => ({
    index,
    verdict: v,
    reason: 'По своей цитате.',
  });

  it('preserves a verified fact when the missing part cannot be repaired', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce(raw([...draft.claims, irrelevant]))
      .mockResolvedValueOnce(noAnswer);
    const verify = vi.fn(async () => ({
      checks: [verdict('supported'), verdict('insufficient', 1)],
    }));
    const search = vi.fn(async () => {});
    const evaluated = await runGrounding({
      retrieval: { ...retrieval, query: multiQuestion },
      signal: signal(),
      generate,
      verify,
      coverage: async () => incomplete,
      search,
    });
    expect(evaluated.result).toMatchObject({
      status: 'partial',
      claims: draft.claims,
      missing_parts: ['каков лимит файлов'],
    });
    expect(evaluated.result.answer).not.toContain('10');
    expect(evaluated.result.sources).toHaveLength(1);
    expect(evaluated.result.citations).toHaveLength(1);
    expect(evaluated.result.clarification).toContain('каков лимит файлов');
    expect(search).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(renderGroundedAnswer(evaluated.result)).toContain(
      'Подтверждена только часть',
    );
  });

  it('does not mistake a correct but unrelated fact for an answer', async () => {
    const evaluated = await runGrounding({
      retrieval,
      signal: signal(),
      generate: async () => raw(),
      maxAttempts: 1,
      verify: async () => ({ checks: [verdict('supported')] }),
      coverage: async () => ({ relevant_indices: [], missing_parts: [query] }),
    });
    expect(evaluated.result.status).toBe('unknown');
    expect(evaluated.attempts[0].checks[0].verdict).toBe('supported');
    expect(evaluated.result.sources).toEqual([]);
  });

  it('does not publish a contradiction even when coverage says the answer is complete', async () => {
    const coverage = vi.fn();
    const evaluated = await runGrounding({
      retrieval,
      signal: signal(),
      generate: async () => raw(),
      maxAttempts: 1,
      verify: async () => ({ checks: [verdict('contradicted')] }),
      coverage,
    });
    expect(evaluated.result.status).toBe('unknown');
    expect(coverage).not.toHaveBeenCalled();
  });

  it.each(['generation', 'verification', 'search', 'coverage'])(
    'keeps verified facts if %s fails during repair',
    async (failure) => {
      const generate = vi
        .fn()
        .mockResolvedValueOnce(raw())
        .mockImplementationOnce(async () => {
          if (failure === 'generation') throw new Error('offline');
          return raw([irrelevant]);
        });
      const verify = vi
        .fn()
        .mockResolvedValueOnce({ checks: [verdict('supported')] })
        .mockImplementationOnce(async () => {
          if (failure === 'verification') throw new Error('offline');
          return { checks: [verdict('insufficient')] };
        });
      const evaluated = await runGrounding({
        retrieval: { ...retrieval, query: multiQuestion },
        signal: signal(),
        generate,
        verify,
        search: async () => {
          if (failure === 'search') throw new Error('offline');
        },
        coverage: vi
          .fn()
          .mockResolvedValueOnce(incomplete)
          .mockImplementationOnce(async () => {
            if (failure === 'coverage') throw new Error('offline');
            return incomplete;
          }),
      });
      expect(evaluated.result.status).toBe('partial');
      expect(evaluated.result.claims).toEqual(draft.claims);
      expect(evaluated.result.answer).not.toContain('10');
    },
  );

  it('rechecks a repaired claim against a new literal citation and retains the earlier fact', async () => {
    const context: RagRetrieval = structuredClone({
      ...retrieval,
      query: multiQuestion,
    });
    const newQuote = 'Лимит составляет не более 5 файлов за один запрос.';
    const second = {
      text: 'Можно добавить до 5 файлов.',
      citations: [{ source_id: 'S2', quote: newQuote }],
    };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(raw([...draft.claims, irrelevant]))
      .mockResolvedValueOnce(raw([second]));
    const coverage = vi
      .fn()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce({ relevant_indices: [0, 1], missing_parts: [] });
    const evaluated = await runGrounding({
      retrieval: context,
      signal: signal(),
      generate,
      coverage,
      verify: vi
        .fn()
        .mockResolvedValueOnce({
          checks: [verdict('supported'), verdict('insufficient', 1)],
        })
        .mockResolvedValueOnce({ checks: [verdict('supported')] }),
      search: async () => {
        context.followup = {
          ...retrieval,
          sources: [
            { ...retrieval.sources[0], chunk_id: 'c2', text: newQuote },
          ],
        };
      },
    });
    expect(evaluated.result.status).toBe('supported');
    expect(evaluated.result.claims).toEqual([...draft.claims, second]);
    expect(evaluated.result.sources.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(restoreRagRetrieval(context)).toEqual(context);
    expect(generate.mock.calls[1][0]).toContain(newQuote);
  });

  it('rejects nested or foreign-index extra evidence in SSE/history', () => {
    expect(
      restoreRagRetrieval({
        ...retrieval,
        followup: { ...retrieval, build_id: 'foreign' },
      }),
    ).toBeNull();
    expect(
      restoreRagRetrieval({
        ...retrieval,
        followup: { ...retrieval, followup: retrieval },
      }),
    ).toBeNull();
    expect(
      restoreRagRetrieval({
        ...retrieval,
        followup: {
          ...retrieval,
          sources: Array.from({ length: 4 }, (_, i) => ({
            ...retrieval.sources[0],
            id: `S${i + 1}`,
          })),
        },
      }),
    ).toBeNull();
  });

  it('does not publish facts with unestablished relevance when coverage is malformed', async () => {
    await expect(
      runGrounding({
        retrieval,
        signal: signal(),
        generate: async () => raw(),
        maxAttempts: 1,
        verify: async () => ({ checks: [verdict('supported')] }),
        coverage: async () => ({
          relevant_indices: [0],
          missing_parts: ['secret injected text'],
        }),
      }),
    ).rejects.toThrow('coverage_unavailable');
  });
});

describe('Local grounding service protocol', () => {
  it('dispatches fact checking and coverage independently', async () => {
    const verifier = Object.assign(new LocalGroundingVerifier(), {
      verify: vi.fn(async () => ({
        checks: [{ index: 0, verdict: 'supported', reason: 'Literal fact.' }],
      })),
      coverage: vi.fn(async () => ({
        relevant_indices: [0],
        missing_parts: [],
      })),
    });
    const handler = createRagHandler({
      dataDir: '/tmp/rag-grounding-unit-no-index',
      groundingVerifier: verifier,
    });
    for (const action of ['verify-answer', 'answer-coverage']) {
      const response = await handler(
        new Request('http://127.0.0.1/rag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, query, claims: draft.claims }),
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(verifier.coverage).toHaveBeenCalledTimes(1);
    expect(verifier.coverage.mock.calls[0]?.slice(0, 2)).toMatchObject([
      query,
      draft.claims,
    ]);
  });

  it('bounds extra retrieval and keeps the original cutoffs', () => {
    const context = {
      ...retrieval,
      processing: {
        options: {
          rewrite: true,
          filter: false,
          topKBefore: 24,
          topKAfter: 5,
          rerank: true,
          minSimilarity: 0.6,
          minRerankScore: 0.2,
        },
        search_query: query,
        candidates: 5,
        passed: 5,
      },
    };
    const unresolved = {
      unknown: false,
      claims: [
        {
          text: 'Лимит 10 MiB.',
          citations: [
            {
              source_id: 'S1',
              quote:
                'if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error();',
            },
          ],
        },
      ],
    };
    const request = followupSearch(
      context,
      unresolved,
      [{ index: 0, verdict: 'insufficient', reason: 'Нет определения.' }],
      ['лимит'],
    );
    expect(request.query).toContain('MAX_IMAGE_ATTACHMENT_BYTES');
    expect(request.query.length).toBeLessThanOrEqual(2000);
    expect(request.options).toMatchObject({
      topKBefore: 8,
      topKAfter: 3,
      minSimilarity: 0.6,
      minRerankScore: 0.2,
      filter: true,
      rewrite: false,
      verifyEvidence: false,
    });
  });

  it('uses the frozen build for followup retrieval and exposes new sources in metadata', async () => {
    const context = structuredClone(retrieval);
    const newQuote =
      'История сохраняется в localStorage на устройстве пользователя.';
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        if (body.action === 'answer-coverage') return fullCoverage();
        if (body.action === 'retrieve')
          return Response.json({
            build_id: 'b1',
            hits: [
              { ...retrieval.sources[0], chunk_id: 'extra', text: newQuote },
            ],
            processing: {
              options: body.options,
              search_query: body.query,
              candidates: 1,
              passed: 1,
              verified: 1,
              unique: 1,
            },
          });
        return Response.json({
          checks: [
            {
              index: 0,
              verdict: calls.length === 1 ? 'insufficient' : 'supported',
              reason: 'Проверено по цитате.',
            },
          ],
        });
      }),
    );
    const corrected = {
      ...draft,
      claims: [
        {
          text: draft.claims[0].text,
          citations: [{ source_id: 'S2', quote: newQuote }],
        },
      ],
    };
    const response = await enforceGroundedResponse(
      generated(),
      context,
      'json',
      signal(),
      async () => generated(corrected),
    );
    const answer = JSON.parse((await read(response)).content);
    expect(answer.status).toBe('supported');
    expect(answer.sources[0].chunk_id).toBe('extra');
    expect(calls.find((c) => c.action === 'retrieve')).toMatchObject({
      build_id: 'b1',
      options: { topKBefore: 8, topKAfter: 3 },
    });
    expect(restoreRagRetrieval(context)).toEqual(context);
    expect(context.followup?.sources[0].chunk_id).toBe('extra');
  });
});

describe('Conservative numerical evidence and explicit question coverage', () => {
  it('requires evidence for a numeric constant but leaves its truth undecided', () => {
    const claim = {
      text: 'Лимит изображения — 10 МБ.',
      citations: [
        {
          source_id: 'S1',
          quote:
            'if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error();',
        },
      ],
    };
    expect(hasUnquotedNumber(claim)).toBe(true);
    expect(
      hasUnquotedNumber({
        ...claim,
        citations: [
          ...claim.citations,
          {
            source_id: 'S2',
            quote: 'const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;',
          },
        ],
      }),
    ).toBe(false);
  });
  it('splits compound Russian questions without relying on ASCII word boundaries', () => {
    expect(
      questionParts(
        'Увидит ли пользователь ответ, сколько раз его исправляют и что будет при сбое?',
      ),
    ).toEqual([
      'Увидит ли пользователь ответ',
      'сколько раз его исправляют',
      'что будет при сбое',
    ]);
  });
  it('requires a verdict for every question part and keeps partially answered parts missing', () => {
    expect(
      coverageFromParts(
        {
          checks: [
            {
              index: 0,
              reason: 'Место известно.',
              status: 'full',
              answer_indices: [0],
            },
            {
              index: 1,
              reason: 'Число известно, размер нет.',
              status: 'partial',
              answer_indices: [1],
            },
          ],
        },
        'Где данные? Какие лимиты?',
        2,
      ),
    ).toEqual({ relevant_indices: [0, 1], missing_parts: ['Какие лимиты'] });
    expect(() => coverageFromParts({ checks: [] }, query, 1)).toThrow();
  });
});

it('downgrades supported when the judge has not established matching subjects and conditions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url).endsWith('/api/tags'))
        return Response.json({
          models: [{ name: 'qwen2.5:7b', digest: 'test' }],
        });
      return Response.json({
        message: {
          content: JSON.stringify({
            checks: [
              {
                index: 0,
                citation_subject: 'Лимит запросов',
                claim_subject: 'Лимит пользователей',
                scope_matches: false,
                reason: 'Число совпало.',
                verdict: 'supported',
              },
            ],
          }),
        },
      });
    }),
  );
  const result = await new LocalGroundingVerifier().verify(
    query,
    draft.claims,
    signal(),
  );
  expect(result.checks[0].verdict).toBe('insufficient');
});

it('requires application evidence for numerical limits described only by code declarations', () => {
  const claim = {
    text: 'Ограничение равно 8.',
    citations: [
      {
        source_id: 'S1',
        quote: '// configurable limit\nexport const MAX_ITEMS = 8;',
      },
    ],
  };
  expect(hasOnlyNumericDeclarations(claim)).toBe(true);
  expect(
    hasOnlyNumericDeclarations({
      ...claim,
      citations: [
        ...claim.citations,
        {
          source_id: 'S2',
          quote: 'if (items.length > MAX_ITEMS) throw new Error();',
        },
      ],
    }),
  ).toBe(false);
  expect(
    hasOnlyNumericDeclarations({
      ...claim,
      citations: [
        { source_id: 'S1', quote: 'Разрешено не более 8 элементов.' },
      ],
    }),
  ).toBe(false);
});
