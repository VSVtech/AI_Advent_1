import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/chat/route';
import { readChatStream } from '@/lib/read-chat-stream';
import {
  dialogueInput,
  prepareDialogueQuestion,
  renderDialogueContext,
} from '@/lib/server/rag-dialogue';
import {
  validateDialoguePlan,
  LocalDialoguePlanner,
  explicitRequests,
} from '@/scripts/rag/dialogue.mjs';
import type { ApiChatMessage } from '@/lib/chat-types';

const original =
  'macOS и pnpm — мои требования. Запомни термин «рабочий контур». Какие процессы запускает ./start.sh?';
const question = 'Какие процессы запускает ./start.sh?';
const messages: ApiChatMessage[] = [
  {
    role: 'user',
    content:
      'Память задачи:\nСостояние задачи текущего диалога:\n{"цель":"Инструкция запуска","термин · рабочий контур":"веб-приложение, Ollama и RAG-сервис"}',
  },
  {
    role: 'assistant',
    content: 'Непроверенное утверждение ассистента о PostgreSQL.',
  },
  { role: 'user', content: original },
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Conversational RAG preparation', () => {
  it('uses task memory and user history without treating earlier generated answers as facts', () => {
    const input = dialogueInput(messages);
    expect(input.current).toBe(original);
    expect(input.context).toHaveLength(1);
    expect(input.context[0]).toContain('Ollama');
    expect(JSON.stringify(input)).not.toContain('PostgreSQL');
  });
  it('does not accept invented identifiers or an empty technical question', () => {
    const input = dialogueInput(messages);
    expect(() =>
      validateDialoguePlan(
        { intent: 'knowledge', question: 'Что запускает invented.sh?' },
        input,
      ),
    ).toThrow();
    expect(() =>
      validateDialoguePlan({ intent: 'knowledge', question: '' }, input),
    ).toThrow();
    expect(() => new LocalDialoguePlanner('https://example.com')).toThrow();
    expect(() =>
      validateDialoguePlan(
        { intent: 'memory', question: '' },
        {
          current: 'Запомни условия и перечисли основные компоненты системы.',
          context: [],
        },
      ),
    ).toThrow();
    expect(
      explicitRequests(
        'Цель — инструкция. Запомни ограничения и перечисли основные компоненты системы.',
      ),
    ).toBe('перечисли основные компоненты системы.');
    expect(
      explicitRequests('Запомни. Как запустить сервер? Где настроить порт?'),
    ).toBe('Как запустить сервер? Где настроить порт?');
  });
  it('reports planner failure as an operational error, not an unknown answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 503 })),
    );
    await expect(
      prepareDialogueQuestion(messages, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'rag_dialogue_unavailable' });
  });
  it('searches, generates and checks coverage for the extracted question, keeping original requirements in context', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
    const quote =
      'Скрипт start.sh запускает веб-приложение и локальный RAG-сервис.';
    const requests: Array<{
      action?: string;
      query?: string;
      input?: ApiChatMessage[];
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        if (body.action === 'prepare-dialogue')
          return Response.json({ intent: 'knowledge', question });
        if (body.action === 'search')
          return Response.json({
            build_id: 'b1',
            hits: [
              {
                source: 'start.sh',
                section: 'start.sh',
                title: 'start.sh',
                chunk_id: 'c1',
                start_line: 1,
                end_line: 3,
                score: 0.9,
                text: quote,
              },
            ],
          });
        if (body.action === 'verify-answer')
          return Response.json({
            checks: [
              { index: 0, verdict: 'supported', reason: 'Есть в цитате.' },
            ],
          });
        if (body.action === 'answer-coverage')
          return Response.json({ relevant_indices: [0], missing_parts: [] });
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    unknown: false,
                    claims: [
                      {
                        text: quote,
                        citations: [{ source_id: 'S1', quote_id: 1 }],
                      },
                    ],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        });
      }),
    );
    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          useRag: true,
          ragGrounding: true,
          ragDialogue: true,
          targetOutputTokens: null,
        }),
      }),
    );
    expect(response.status).toBe(200);
    let content = '';
    await readChatStream(response.body!, (e) => {
      if (e.type === 'delta') content += e.content;
    });
    expect(content).toContain('start\\.sh');
    expect(content).toContain('**Источники**');
    expect(content).not.toContain('Не знаю');
    for (const action of ['search', 'verify-answer', 'answer-coverage'])
      expect(requests.find((r) => r.action === action)?.query).toBe(question);
    const generation = requests.find((r) => r.input)!;
    expect(generation.input!.at(-1)!.content).toBe(question);
    expect(
      generation.input!.some((m: ApiChatMessage) => m.content === original),
    ).toBe(true);
  });
  it('acknowledges memory-only input with dialogue provenance, without fabricated document citations', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ intent: 'memory', question: '' }),
    );
    vi.stubGlobal('fetch', fetcher);
    const current = [
      ...messages.slice(0, 1),
      { role: 'user', content: 'Запомни: используем порт 18813.' },
    ];
    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: current,
          useRag: true,
          ragGrounding: true,
          ragDialogue: true,
        }),
      }),
    );
    const text = await response.text();
    expect(text).toContain('18813');
    expect(text).toContain('Инструкция запуска');
    expect(text).not.toContain('Не знаю');
    expect(text).not.toContain('[S1]');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(renderDialogueContext(messages, 'json')).sources,
    ).toContain('Память текущего диалога');
  });
});
