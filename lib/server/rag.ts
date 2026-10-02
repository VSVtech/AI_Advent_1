import {
  MAX_RAG_CONTEXT_CHARS,
  MAX_RAG_QUERY_CHARS,
  RAG_STRATEGY,
  RAG_TOP_K,
  ragQuery,
  restoreRagRetrieval,
  type RagRetrieval,
  type RagSource,
} from '@/lib/rag-context';
import type { ApiChatMessage } from '@/lib/chat-types';
import { encodeEvent } from '@/lib/server/deepseek';

export class RagError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 503,
  ) {
    super(message);
  }
}

export async function retrieveRagContext(
  messages: ApiChatMessage[],
  signal: AbortSignal,
  buildId?: string,
): Promise<RagRetrieval> {
  const query = ragQuery(messages);
  if (!query || query.length > MAX_RAG_QUERY_CHARS)
    throw new RagError(
      'invalid_rag_query',
      `Для RAG нужен текстовый вопрос до ${MAX_RAG_QUERY_CHARS} символов.`,
      400,
    );
  let response: Response;
  try {
    response = await fetch(
      process.env.RAG_SERVICE_URL ?? 'http://127.0.0.1:18803/rag',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'search',
          strategy: RAG_STRATEGY,
          query,
          ...(buildId ? { build_id: buildId } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(190_000)]),
      },
    );
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new RagError(
      'rag_unavailable',
      'База знаний недоступна. Запустите pnpm rag:server и Ollama или выберите режим «Без RAG».',
    );
  }
  if (!response.ok)
    throw new RagError(
      'rag_unavailable',
      'Поиск по базе знаний не выполнен. Проверьте локальный сервис, Ollama и наличие индекса. Ответ без RAG автоматически не подставляется.',
    );
  let payload: { build_id?: unknown; hits?: unknown };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new RagError(
      'invalid_rag_response',
      'База знаний вернула некорректный ответ.',
    );
  }
  if (
    !Array.isArray(payload.hits) ||
    typeof payload.build_id !== 'string' ||
    (buildId && payload.build_id !== buildId)
  )
    throw new RagError(
      'invalid_rag_response',
      'Не удалось проверить версию индекса и источники.',
    );
  const sources: RagSource[] = [];
  for (const hit of payload.hits.slice(0, RAG_TOP_K)) {
    const candidate = {
      id: `S${sources.length + 1}`,
      chunk_id: hit?.chunk_id,
      source: hit?.source,
      title: hit?.title,
      section: hit?.section,
      start_line: hit?.start_line,
      end_line: hit?.end_line,
      score: hit?.score,
      text: hit?.text,
    };
    if (JSON.stringify([...sources, candidate]).length > MAX_RAG_CONTEXT_CHARS)
      continue;
    sources.push(candidate);
  }
  if (!sources.length)
    throw new RagError(
      'rag_no_sources',
      'В индексе нет фрагментов, которые можно передать модели. Перестройте индекс или выберите «Без RAG».',
      422,
    );
  const retrieval = restoreRagRetrieval({
    build_id: payload.build_id,
    strategy: RAG_STRATEGY,
    query,
    sources,
  });
  if (!retrieval)
    throw new RagError(
      'invalid_rag_response',
      'Источники из индекса не прошли проверку.',
    );
  return retrieval;
}

// A separate event precedes deltas for every generation path (MCP, structured,
// invariant checks, streaming). Cancelling the output also cancels its source.
export function withRagMetadata(
  response: Response,
  retrieval: RagRetrieval,
): Response {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('Content-Type')?.includes('text/event-stream')
  )
    return response;
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(encodeEvent({ type: 'rag', retrieval }));
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    headers: response.headers,
  });
}
