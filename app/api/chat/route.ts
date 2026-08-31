import type {
  ApiChatMessage,
  ChatErrorPayload,
  ChatRequest,
  ChatStreamEvent,
} from '@/lib/chat-types';

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

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

function jsonError(status: number, error: ChatErrorPayload['error']): Response {
  return Response.json({ error } satisfies ChatErrorPayload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function isChatMessage(value: unknown): value is ApiChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;

  return (
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

function encodeEvent(event: ChatStreamEvent): Uint8Array {
  const encoder = new TextEncoder();
  const { type, ...data } = event;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function createNormalizedStream(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;
  let finishReason = 'stop';

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

      const handleBlock = (block: string) => {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (!data) return;

        if (data === '[DONE]') {
          emit({ type: 'done', finishReason });
          close();
          return;
        }

        const payload = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string | null };
            finish_reason?: string | null;
          }>;
        };
        const choice = payload.choices?.[0];
        const content = choice?.delta?.content;

        if (typeof content === 'string' && content.length > 0) {
          emit({ type: 'delta', content });
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
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
            emit({ type: 'done', finishReason });
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

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequest;

  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return jsonError(400, {
      code: 'invalid_json',
      message: 'Тело запроса должно быть корректным JSON.',
    });
  }

  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > 100 ||
    !body.messages.every(isChatMessage) ||
    body.messages.at(-1)?.role !== 'user'
  ) {
    return jsonError(400, {
      code: 'invalid_messages',
      message: 'Передана некорректная история диалога.',
    });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });
  }

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: body.messages,
        stream: true,
        thinking: { type: 'disabled' },
      }),
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    return jsonError(502, {
      code: 'deepseek_unreachable',
      message:
        'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
    });
  }

  if (!upstreamResponse.ok) {
    const mappedError = ERROR_BY_STATUS[upstreamResponse.status] ?? {
      code: 'deepseek_error',
      message: 'DeepSeek не смог обработать запрос. Попробуйте ещё раз.',
    };
    return jsonError(upstreamResponse.status, mappedError);
  }

  if (!upstreamResponse.body) {
    return jsonError(502, {
      code: 'empty_upstream_response',
      message: 'DeepSeek вернул пустой ответ. Попробуйте ещё раз.',
    });
  }

  return new Response(
    createNormalizedStream(upstreamResponse.body, request.signal),
    {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    },
  );
}
