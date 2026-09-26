import { DEFAULT_MODEL } from '@/lib/chat-constraints';
import type {
  ApiChatContentPart,
  ApiChatMessage,
  ChatErrorPayload,
  ChatStreamEvent,
} from '@/lib/chat-types';
import { isDeepSeekFileId } from '@/lib/file-attachments';

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/responses';
export const DEEPSEEK_FILES_ENDPOINT = 'https://api.deepseek.com/files';
export const DEEPSEEK_MODELS_ENDPOINT = 'https://api.deepseek.com/models';
// Kept as an alias so existing imports keep working; the canonical value
// lives in chat-constraints.ts so client code can use it without importing
// this server-only module.
export const DEEPSEEK_MODEL = DEFAULT_MODEL;

const ERROR_BY_STATUS: Record<number, ChatErrorPayload['error']> = {
  400: {
    code: 'invalid_request',
    message:
      'DeepSeek отклонил формат запроса. Попробуйте начать новый диалог.',
  },
  401: {
    code: 'invalid_api_key',
    message: 'API-токен DeepSeek недействителен. Проверьте DEEPSEEK_API_KEY.',
  },
  402: {
    code: 'insufficient_balance',
    message: 'На балансе DeepSeek недостаточно средств.',
  },
  422: {
    code: 'invalid_parameters',
    message: 'DeepSeek не смог обработать параметры запроса.',
  },
  429: {
    code: 'rate_limit',
    message: 'Слишком много запросов к DeepSeek. Попробуйте чуть позже.',
  },
  500: {
    code: 'deepseek_server_error',
    message: 'На стороне DeepSeek произошла ошибка. Попробуйте ещё раз.',
  },
  503: {
    code: 'deepseek_overloaded',
    message: 'DeepSeek сейчас перегружен. Попробуйте чуть позже.',
  },
};

export function jsonError(
  status: number,
  error: ChatErrorPayload['error'],
): Response {
  return Response.json({ error } satisfies ChatErrorPayload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function isChatContentPart(value: unknown): value is ApiChatContentPart {
  if (!value || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;

  if (part.type === 'input_text') {
    return (
      typeof part.text === 'string' &&
      part.text.trim().length > 0 &&
      part.text.length <= 1_000_000
    );
  }

  return part.type === 'input_image' && isDeepSeekFileId(part.file_id);
}

export function isChatMessage(value: unknown): value is ApiChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;

  if (message.role !== 'user' && message.role !== 'assistant') return false;

  if (typeof message.content === 'string') {
    return message.content.trim().length > 0;
  }

  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.length <= 16 &&
    message.content.every(isChatContentPart)
  );
}

export function encodeEvent(event: ChatStreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  const { type, ...data } = event;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createNormalizedStream(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: { initialEvent?: ChatStreamEvent; tokenLimitMessage?: string } = {},
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      const emit = (event: ChatStreamEvent) => {
        if (!closed) controller.enqueue(encodeEvent(event));
      };

      if (options.initialEvent) emit(options.initialEvent);

      const handleBlock = (block: string) => {
        const eventName = block
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (!data) return;

        const payload = JSON.parse(data) as {
          type?: string;
          delta?: unknown;
          response?: {
            incomplete_details?: { reason?: unknown } | null;
            usage?: {
              output_tokens?: unknown;
              input_tokens?: unknown;
              input_tokens_details?: { cached_tokens?: unknown } | null;
            } | null;
          };
        };
        const eventType = payload.type ?? eventName;

        if (
          eventType === 'response.output_text.delta' &&
          typeof payload.delta === 'string' &&
          payload.delta.length > 0
        ) {
          emit({ type: 'delta', content: payload.delta });
          return;
        }

        if (eventType === 'response.completed') {
          const outputTokens = extractOutputTokens({
            usage: payload.response?.usage,
          });
          const { inputTokens, cachedInputTokens } = extractInputTokenUsage({
            usage: payload.response?.usage,
          });
          emit({
            type: 'done',
            finishReason: 'stop',
            ...(outputTokens === null ? {} : { outputTokens }),
            ...(inputTokens === null ? {} : { inputTokens }),
            ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
          });
          close();
          return;
        }

        if (eventType === 'response.incomplete') {
          const reason = payload.response?.incomplete_details?.reason;
          emit({
            type: 'error',
            code: 'response_incomplete',
            message:
              reason === 'max_output_tokens'
                ? (options.tokenLimitMessage ??
                  'Ответ DeepSeek достиг заданного лимита. Увеличьте целевую длину или сократите запрос.')
                : 'DeepSeek не смог завершить ответ. Попробуйте ещё раз.',
          });
          close();
          return;
        }

        if (eventType === 'response.failed' || eventType === 'error') {
          emit({
            type: 'error',
            code: 'deepseek_response_failed',
            message: 'DeepSeek не смог сформировать ответ. Попробуйте ещё раз.',
          });
          close();
        }
      };

      const consume = (flush = false) => {
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');

        while (boundary !== -1 && !closed) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.trim() && !block.trimStart().startsWith(':')) {
            handleBlock(block);
          }
          boundary = buffer.indexOf('\n\n');
        }

        if (flush && buffer.trim() && !closed) handleBlock(buffer);
      };

      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          consume();
        }

        if (!closed) {
          buffer += decoder.decode();
          consume(true);
          if (!closed) {
            emit({
              type: 'error',
              code: 'upstream_stream_error',
              message: 'Поток ответа DeepSeek прервался. Попробуйте ещё раз.',
            });
            close();
          }
        }
      } catch {
        if (!closed) {
          if (!signal.aborted) {
            emit({
              type: 'error',
              code: 'upstream_stream_error',
              message: 'Поток ответа DeepSeek прервался. Попробуйте ещё раз.',
            });
          }
          close();
        }
      } finally {
        reader.releaseLock();
      }
    },
    async cancel() {
      closed = true;
      await reader.cancel();
    },
  });
}

export function eventStreamResponse(
  body: ReadableStream<Uint8Array>,
): Response {
  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function completedOutputResponse(
  content: string,
  usage: {
    outputTokens: number | null;
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    invariantInputTokens?: number | null;
    invariantOutputTokens?: number | null;
    toolInputTokens?: number | null;
    toolOutputTokens?: number | null;
    mcpTools?: string[];
    weatherJobId?: string;
  },
): Response {
  return eventStreamResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeEvent({ type: 'delta', content }));
        controller.enqueue(
          encodeEvent({
            type: 'done',
            finishReason: 'stop',
            ...(usage.outputTokens === null
              ? {}
              : { outputTokens: usage.outputTokens }),
            ...(usage.inputTokens === null || usage.inputTokens === undefined
              ? {}
              : { inputTokens: usage.inputTokens }),
            ...(usage.cachedInputTokens === null ||
            usage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: usage.cachedInputTokens }),
            ...(usage.invariantInputTokens === null ||
            usage.invariantInputTokens === undefined
              ? {}
              : { invariantInputTokens: usage.invariantInputTokens }),
            ...(usage.invariantOutputTokens === null ||
            usage.invariantOutputTokens === undefined
              ? {}
              : { invariantOutputTokens: usage.invariantOutputTokens }),
            ...(usage.toolInputTokens === null ||
            usage.toolInputTokens === undefined
              ? {}
              : { toolInputTokens: usage.toolInputTokens }),
            ...(usage.toolOutputTokens === null ||
            usage.toolOutputTokens === undefined
              ? {}
              : { toolOutputTokens: usage.toolOutputTokens }),
            ...(usage.mcpTools?.length ? { mcpTools: usage.mcpTools } : {}),
            ...(usage.weatherJobId ? { weatherJobId: usage.weatherJobId } : {}),
          }),
        );
        controller.close();
      },
    }),
  );
}

export function mappedUpstreamError(response: Response): Response {
  const error = ERROR_BY_STATUS[response.status] ?? {
    code: 'deepseek_error',
    message: 'DeepSeek не смог обработать запрос. Попробуйте ещё раз.',
  };
  return jsonError(response.status, error);
}

export type DeepSeekResponsePayload = {
  status?: unknown;
  usage?: {
    output_tokens?: unknown;
    input_tokens?: unknown;
    input_tokens_details?: {
      cached_tokens?: unknown;
    } | null;
  } | null;
  incomplete_details?: {
    reason?: unknown;
  } | null;
  output?: Array<{
    type?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
    }>;
  }>;
};

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function extractOutputTokens(
  payload: DeepSeekResponsePayload,
): number | null {
  return asNonNegativeInteger(payload.usage?.output_tokens);
}

export function extractInputTokenUsage(payload: DeepSeekResponsePayload): {
  inputTokens: number | null;
  cachedInputTokens: number | null;
} {
  return {
    inputTokens: asNonNegativeInteger(payload.usage?.input_tokens),
    cachedInputTokens: asNonNegativeInteger(
      payload.usage?.input_tokens_details?.cached_tokens,
    ),
  };
}

export function extractOutputText(
  payload: DeepSeekResponsePayload,
): string | null {
  if (payload.status !== 'completed' || !Array.isArray(payload.output)) {
    return null;
  }

  const content = payload.output
    .filter((item) => item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content ?? [])
    .filter(
      (part) => part.type === 'output_text' && typeof part.text === 'string',
    )
    .map((part) => part.text as string)
    .join('');

  return content.trim() ? content : null;
}
