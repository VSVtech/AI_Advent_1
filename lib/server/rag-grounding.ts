import type { ChatOutputFormat, ChatStreamEvent } from '@/lib/chat-types';
import type { RagRetrieval } from '@/lib/rag-context';
import { readChatStream } from '@/lib/read-chat-stream';
import {
  MAX_GROUNDED_CLAIMS,
  renderGroundedAnswer,
  unknownAnswer,
} from '@/scripts/rag/grounding.mjs';
import { runGrounding } from '@/scripts/rag/grounding-flow.mjs';
import { retrieveRagContext } from './rag';
import type { RagSearchOptions, RagSource } from '@/lib/rag-context';
import { completedOutputResponse, jsonError } from './deepseek';

export function unknownGroundedResponse(
  reason: string,
  format: ChatOutputFormat,
) {
  return completedOutputResponse(
    renderGroundedAnswer(unknownAnswer(reason), format),
    { outputTokens: 0 },
  );
}

// No draft tokens reach the client before both checks have passed.
export async function enforceGroundedResponse(
  response: Response,
  retrieval: RagRetrieval,
  format: ChatOutputFormat,
  signal: AbortSignal,
  regenerate?: (feedback: string) => Promise<Response>,
  previousUsage?: Extract<ChatStreamEvent, { type: 'done' }>,
): Promise<Response> {
  if (!response.ok || !response.body) return response;
  let totals = { ...previousUsage } as Extract<
    ChatStreamEvent,
    { type: 'done' }
  >;
  async function readDraft(current: Response) {
    if (!current.ok || !current.body) throw new Error('generation_failed');
    let content = '';
    let usage: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
    await readChatStream(current.body, (event) => {
      signal.throwIfAborted();
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'delta') content += event.content;
      if (content.length > 40_000)
        throw new Error('incomplete_grounded_answer');
      if (event.type === 'done') usage = event;
    });
    if (!usage || usage.finishReason !== 'stop')
      throw new Error('incomplete_grounded_answer');
    const previous = totals;
    totals = { ...usage };
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'invariantInputTokens',
      'invariantOutputTokens',
    ] as const) {
      if (previous?.[key] !== undefined)
        totals[key] = (totals[key] ?? 0) + previous[key];
    }
    return content;
  }
  async function localCheck(action: string, claims: unknown) {
    const checked = await fetch(
      process.env.RAG_SERVICE_URL ?? 'http://127.0.0.1:18803/rag',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, query: retrieval.query, claims }),
        // One isolated check per claim, including the local thinking budget.
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(
            action === 'verify-answer'
              ? MAX_GROUNDED_CLAIMS * 240_000 + 10_000
              : 245_000,
          ),
        ]),
      },
    );
    if (!checked.ok) throw new Error('grounding_unavailable');
    return checked.json();
  }
  try {
    const evaluated = await runGrounding({
      retrieval,
      signal,
      maxAttempts: regenerate ? 2 : 1,
      generate: async (feedback: string | null) =>
        readDraft(feedback === null ? response : await regenerate!(feedback)),
      verify: (claims: unknown) => localCheck('verify-answer', claims),
      coverage: (claims: unknown) => localCheck('answer-coverage', claims),
      search: async ({
        query,
        options,
      }: {
        query: string;
        options: RagSearchOptions;
      }) => {
        const followup = await retrieveRagContext(
          [{ role: 'user', content: query }],
          signal,
          retrieval.build_id,
          options,
        );
        const sources: RagSource[] = [];
        for (const source of followup.sources) {
          if (
            retrieval.sources.some(
              (existing) => existing.chunk_id === source.chunk_id,
            )
          )
            continue;
          const candidate = { ...source, id: `S${sources.length + 1}` };
          if (JSON.stringify([...sources, candidate]).length <= 8000)
            sources.push(candidate);
        }
        if (sources.length) retrieval.followup = { ...followup, sources };
      },
    });
    return completedOutputResponse(
      renderGroundedAnswer(evaluated.result, format),
      {
        ...totals,
        outputTokens: totals.outputTokens ?? null,
      },
    );
  } catch (error) {
    if (signal.aborted) return new Response(null, { status: 499 });
    const incomplete =
      error instanceof Error && error.message === 'incomplete_grounded_answer';
    return jsonError(incomplete ? 502 : 503, {
      code: incomplete ? 'incomplete_grounded_answer' : 'grounding_unavailable',
      message: incomplete
        ? 'Ответ прерван до проверки цитат. Повторите запрос.'
        : 'Не удалось проверить смысл ответа. Проверьте локальный RAG-сервис, Ollama и настроенную модель проверки; непроверенный ответ не показан.',
    });
  }
}
