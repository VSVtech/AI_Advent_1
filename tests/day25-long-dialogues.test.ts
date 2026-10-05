import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent, createDefaultAgentConfig } from '@/lib/agent';
import type { ChatRequest, ChatStreamEvent } from '@/lib/chat-types';
import type { MemoryFacts } from '@/lib/context-strategy';
import type { RagRetrieval } from '@/lib/rag-context';

const encoder = new TextEncoder();

function sse(events: ChatStreamEvent[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
        }
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function retrieval(query: string, turn: number): RagRetrieval {
  return {
    build_id: 'day25-build',
    strategy: 'overlap',
    query,
    sources: [
      {
        id: 'S1',
        chunk_id: `dialogue-${turn}`,
        source: 'README.md',
        title: 'Документация проекта',
        section: 'RAG и память',
        start_line: 10,
        end_line: 14,
        score: 0.82,
        text: 'Диалог использует RAG, источники и память задачи.',
      },
    ],
  };
}

function messageText(
  content: ChatRequest['messages'][number]['content'],
): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function runLongDialogue({
  goal,
  questions,
  memoryAt,
}: {
  goal: string;
  questions: string[];
  memoryAt: (turn: number) => MemoryFacts;
}) {
  const answerRequests: ChatRequest[] = [];
  let memoryTurn = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as ChatRequest;
      const first = request.messages[0]?.content;
      if (
        typeof first === 'string' &&
        first.startsWith('Ты отдельный агент управления памятью')
      ) {
        memoryTurn += 1;
        return sse([
          {
            type: 'delta',
            content: JSON.stringify({
              shortTerm: memoryAt(memoryTurn),
              longTerm: [],
            }),
          },
          { type: 'done', finishReason: 'stop' },
        ]);
      }
      answerRequests.push(request);
      const turn = answerRequests.length;
      const query = questions[turn - 1];
      return sse([
        { type: 'rag', retrieval: retrieval(query, turn) },
        {
          type: 'delta',
          content: `Ответ ${turn} по цели диалога [S1].\n\n**Источники:** README.md · RAG и память`,
        },
        { type: 'done', finishReason: 'stop', inputTokens: 300 + turn },
      ]);
    }),
  );

  const agent = new Agent(
    { ...createDefaultAgentConfig(), taskGoal: goal },
    'Длинный RAG-диалог',
  );
  for (const question of questions) await agent.sendMessage(question);
  return { agent, answerRequests };
}

afterEach(() => vi.unstubAllGlobals());

describe('День 25: длинные диалоги с RAG и памятью задачи', () => {
  it('сохраняет цель и ограничение в сценарии из 12 сообщений', async () => {
    const questions = Array.from(
      { length: 12 },
      (_, index) => `Сообщение ${index + 1}: продолжи проектирование чата`,
    );
    const { agent, answerRequests } = await runLongDialogue({
      goal: 'Спроектировать внутренний чат поддержки',
      questions,
      memoryAt: (turn) => ({
        цель: 'Спроектировать внутренний чат поддержки',
        ...(turn >= 3
          ? { 'ограничение · стек': 'Только TypeScript и локальный RAG' }
          : {}),
        ...(turn >= 6
          ? { 'термин · оператор': 'Сотрудник первой линии поддержки' }
          : {}),
        ...(turn >= 8
          ? { 'уточнение · аудитория': 'Интерфейс предназначен для операторов' }
          : {}),
      }),
    });

    expect(answerRequests).toHaveLength(12);
    expect(
      answerRequests.every(
        (request) =>
          request.useRag === true &&
          request.ragGrounding === true &&
          request.ragSearch?.rerank === true,
      ),
    ).toBe(true);
    const finalMemory = messageText(answerRequests.at(-1)!.messages[0].content);
    expect(finalMemory).toContain('Спроектировать внутренний чат поддержки');
    expect(finalMemory).toContain('Только TypeScript и локальный RAG');
    expect(finalMemory).toContain('Сотрудник первой линии поддержки');
    expect(answerRequests.at(-1)?.messages.length).toBeLessThanOrEqual(11);
    expect(agent.getTaskMemory()).toMatchObject({
      goal: 'Спроектировать внутренний чат поддержки',
      constraints: [
        { label: 'стек', value: 'Только TypeScript и локальный RAG' },
      ],
    });
    const answers = agent
      .getSnapshot()
      .messages.filter((message) => message.role === 'assistant');
    expect(answers).toHaveLength(12);
    expect(answers.every((answer) => answer.rag?.sources.length === 1)).toBe(
      true,
    );
    expect(
      answers.every((answer) => answer.content.includes('Источники')),
    ).toBe(true);
  });

  it('сохраняет согласованные термины и уточнения в сценарии из 15 сообщений', async () => {
    const questions = Array.from(
      { length: 15 },
      (_, index) => `Шаг ${index + 1}: уточни план миграции`,
    );
    const { agent, answerRequests } = await runLongDialogue({
      goal: 'Подготовить безопасный план миграции базы знаний',
      questions,
      memoryAt: (turn) => ({
        цель: 'Подготовить безопасный план миграции базы знаний',
        'ограничение · простой': 'Без остановки пользовательского чата',
        ...(turn >= 4
          ? { 'термин · снимок': 'Зафиксированная версия индекса RAG' }
          : {}),
        ...(turn >= 9
          ? {
              'уточнение · откат':
                'Возврат должен занимать не больше одного шага',
            }
          : {}),
      }),
    });

    expect(answerRequests).toHaveLength(15);
    const finalRequest = answerRequests.at(-1)!;
    expect(messageText(finalRequest.messages[0].content)).toContain(
      'Зафиксированная версия индекса RAG',
    );
    expect(messageText(finalRequest.messages[0].content)).toContain(
      'Возврат должен занимать не больше одного шага',
    );
    expect(finalRequest.messages.length).toBeLessThanOrEqual(11);
    expect(agent.getTaskMemory()).toMatchObject({
      goal: 'Подготовить безопасный план миграции базы знаний',
      terms: [{ label: 'снимок', value: 'Зафиксированная версия индекса RAG' }],
      clarifications: [
        {
          label: 'откат',
          value: 'Возврат должен занимать не больше одного шага',
        },
      ],
    });
    expect(
      agent
        .getSnapshot()
        .messages.filter((message) => message.role === 'assistant')
        .every((answer) => answer.rag?.sources[0]?.source === 'README.md'),
    ).toBe(true);
  });
});
