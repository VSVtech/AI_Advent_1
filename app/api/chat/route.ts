import type {
  ApiChatMessage,
  ChatErrorPayload,
  ChatOutputFormat,
  ChatRequest,
  ChatStreamEvent,
} from '@/lib/chat-types';
import {
  calculateMaxOutputTokens,
  calculateTargetOutputRange,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  isValidTargetOutputTokens,
} from '@/lib/chat-constraints';
import {
  isStructuredOutputFormat,
  type StructuredOutputFormat,
  validateStructuredOutput,
} from '@/lib/structured-output';

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/responses';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const MAX_FORMAT_RETRIES = 3;

function targetLengthInstruction(targetOutputTokens: number): string {
  const targetRange = calculateTargetOutputRange(targetOutputTokens);
  const approximateWordTarget = Math.max(
    20,
    Math.floor(targetOutputTokens * 0.6),
  );

  return [
    `The complete answer must contain between ${targetRange.min} and ${targetRange.max} output tokens.`,
    `For prose, use approximately ${approximateWordTarget} words as an additional planning guide.`,
    'Treat the token range as a required target, not merely an upper bound or a suggestion.',
    'The separate API token limit is only an emergency buffer for completing the answer and closing structured data; do not use that allowance as the target length.',
    'Plan the response length before writing and finish inside the target range.',
    'Develop relevant details, examples, edge cases, and explanations without repetition or filler.',
    'Do not cut off a sentence, list, code block, JSON object, XML document, or YAML document to meet the target.',
  ].join(' ');
}

const FORMAT_INSTRUCTIONS: Record<StructuredOutputFormat, string> = {
  json: [
    'Return only valid json.',
    'Use a JSON object with a structure appropriate to the user request.',
    'Do not wrap the result in Markdown or add explanatory text.',
  ].join(' '),
  xml: [
    'Return only well-formed XML with exactly one <response> root element.',
    'Do not put answer text directly inside <response>.',
    'Represent every top-level logical section as its own direct child element with a descriptive tag name.',
    'For example, an answer containing a topic and an explanation must use separate <topic> and <explanation> elements.',
    'Never combine labeled sections such as "Topic:" and "Explanation:" inside one text node.',
    'Do not wrap the result in Markdown or add explanatory text.',
  ].join(' '),
  yaml: [
    'Return only valid YAML whose root is a mapping or sequence.',
    'Do not return a scalar string, number, boolean, or null as the root value.',
    'Use a structure appropriate to the user request.',
    'Place semantic fields directly at the document root.',
    'Do not add a generic wrapper key named YAML, response, data, result, or output.',
    'Do not wrap the result in Markdown or add explanatory text.',
  ].join(' '),
};

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

function isChatOutputFormat(value: unknown): value is ChatOutputFormat {
  return (
    value === 'text' || value === 'json' || value === 'xml' || value === 'yaml'
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
            usage?: { output_tokens?: unknown } | null;
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
          const outputTokens = payload.response?.usage?.output_tokens;
          emit({
            type: 'done',
            finishReason: 'stop',
            ...(typeof outputTokens === 'number' &&
            Number.isInteger(outputTokens) &&
            outputTokens >= 0
              ? { outputTokens }
              : {}),
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
                ? 'Ответ DeepSeek достиг заданного лимита. Увеличьте целевую длину или сократите запрос.'
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

function eventStreamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}

function completedOutputResponse(
  content: string,
  outputTokens: number | null,
): Response {
  return eventStreamResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodeEvent({ type: 'delta', content }));
        controller.enqueue(
          encodeEvent({
            type: 'done',
            finishReason: 'stop',
            ...(outputTokens === null ? {} : { outputTokens }),
          }),
        );
        controller.close();
      },
    }),
  );
}

function mappedUpstreamError(response: Response): Response {
  const error = ERROR_BY_STATUS[response.status] ?? {
    code: 'deepseek_error',
    message: 'DeepSeek не смог обработать запрос. Попробуйте ещё раз.',
  };
  return jsonError(response.status, error);
}

type DeepSeekResponsePayload = {
  status?: unknown;
  usage?: {
    output_tokens?: unknown;
  } | null;
  incomplete_details?: {
    reason?: unknown;
  } | null;
  output?: Array<{
    type?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
    }>;
  }>;
};

function extractOutputTokens(payload: DeepSeekResponsePayload): number | null {
  const outputTokens = payload.usage?.output_tokens;

  return typeof outputTokens === 'number' &&
    Number.isInteger(outputTokens) &&
    outputTokens >= 0
    ? outputTokens
    : null;
}

function extractOutputText(payload: DeepSeekResponsePayload): string | null {
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

async function generateStructuredOutput({
  apiKey,
  format,
  maxOutputTokens,
  messages,
  signal,
  targetOutputTokens,
}: {
  apiKey: string;
  format: StructuredOutputFormat;
  maxOutputTokens: number;
  messages: ApiChatMessage[];
  signal: AbortSignal;
  targetOutputTokens: number;
}): Promise<Response> {
  const baseInstructions = FORMAT_INSTRUCTIONS[format];
  const lengthInstruction = targetLengthInstruction(targetOutputTokens);
  const textFormat =
    format === 'json'
      ? ({ type: 'json_object' } as const)
      : ({ type: 'text' } as const);

  for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt += 1) {
    if (signal.aborted) return new Response(null, { status: 499 });

    const retryInstruction =
      attempt === 0
        ? ''
        : ` A previous attempt did not pass server-side ${format.toUpperCase()} validation. Regenerate the complete answer and strictly follow the required format.`;

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
          input: messages,
          max_output_tokens: maxOutputTokens,
          stream: false,
          reasoning: { effort: 'none' },
          text: { format: textFormat },
          instructions: `${baseInstructions} ${lengthInstruction}${retryInstruction}`,
        }),
        cache: 'no-store',
        signal,
      });
    } catch {
      if (signal.aborted) return new Response(null, { status: 499 });
      return jsonError(502, {
        code: 'deepseek_unreachable',
        message:
          'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
      });
    }

    if (!upstreamResponse.ok) return mappedUpstreamError(upstreamResponse);

    let payload: DeepSeekResponsePayload | null = null;

    try {
      payload = (await upstreamResponse.json()) as DeepSeekResponsePayload;
    } catch {
      // A malformed upstream body is treated as an invalid generated result.
    }

    if (payload?.status === 'incomplete') {
      const reachedTokenLimit =
        payload.incomplete_details?.reason === 'max_output_tokens';

      return jsonError(502, {
        code: reachedTokenLimit ? 'max_output_tokens' : 'response_incomplete',
        message: reachedTokenLimit
          ? `Ответ DeepSeek достиг лимита в ${maxOutputTokens} токенов. Увеличьте целевую длину и повторите запрос.`
          : 'DeepSeek не смог завершить структурированный ответ. Попробуйте ещё раз.',
      });
    }

    const content = payload ? extractOutputText(payload) : null;

    if (payload && content && validateStructuredOutput(content, format)) {
      return completedOutputResponse(content, extractOutputTokens(payload));
    }
  }

  return jsonError(502, {
    code: 'invalid_model_output',
    message: `DeepSeek не смог сформировать корректный ${format.toUpperCase()} после трёх повторных попыток.`,
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
    !body ||
    typeof body !== 'object' ||
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

  const outputFormat = body.format ?? 'text';

  if (!isChatOutputFormat(outputFormat)) {
    return jsonError(400, {
      code: 'invalid_format',
      message: 'Выбран неподдерживаемый формат ответа.',
    });
  }

  const targetOutputTokens =
    body.targetOutputTokens ?? DEFAULT_TARGET_OUTPUT_TOKENS;

  if (!isValidTargetOutputTokens(targetOutputTokens)) {
    return jsonError(400, {
      code: 'invalid_target_output_tokens',
      message: 'Целевая длина ответа указана некорректно.',
    });
  }

  const maxOutputTokens = calculateMaxOutputTokens(targetOutputTokens);

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });
  }

  if (isStructuredOutputFormat(outputFormat)) {
    return generateStructuredOutput({
      apiKey,
      format: outputFormat,
      maxOutputTokens,
      messages: body.messages,
      signal: request.signal,
      targetOutputTokens,
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
        input: body.messages,
        max_output_tokens: maxOutputTokens,
        stream: true,
        reasoning: { effort: 'none' },
        text: { format: { type: 'text' } },
        instructions: targetLengthInstruction(targetOutputTokens),
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

  if (!upstreamResponse.ok) return mappedUpstreamError(upstreamResponse);

  if (!upstreamResponse.body) {
    return jsonError(502, {
      code: 'empty_upstream_response',
      message: 'DeepSeek вернул пустой ответ. Попробуйте ещё раз.',
    });
  }

  return eventStreamResponse(
    createNormalizedStream(upstreamResponse.body, request.signal),
  );
}
