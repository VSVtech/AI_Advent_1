import type {
  ApiChatMessage,
  ChatOutputFormat,
  ChatRequest,
} from '@/lib/chat-types';
import {
  calculateMaxOutputTokens,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  isValidTargetOutputTokens,
} from '@/lib/chat-constraints';
import {
  buildSelectorSystemPrompt,
  isValidCustomSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';
import {
  isStructuredOutputFormat,
  type StructuredOutputFormat,
  validateStructuredOutput,
} from '@/lib/structured-output';

import {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  jsonError,
  isChatMessage,
  createNormalizedStream,
  eventStreamResponse,
  completedOutputResponse,
  mappedUpstreamError,
  type DeepSeekResponsePayload,
  extractOutputTokens,
  extractOutputText,
} from '@/lib/server/deepseek';

const MAX_FORMAT_RETRIES = 3;

function isChatOutputFormat(value: unknown): value is ChatOutputFormat {
  return (
    value === 'text' || value === 'json' || value === 'xml' || value === 'yaml'
  );
}

async function generateStructuredOutput({
  apiKey,
  format,
  maxOutputTokens,
  messages,
  signal,
  systemPrompt,
}: {
  apiKey: string;
  format: StructuredOutputFormat;
  maxOutputTokens: number;
  messages: ApiChatMessage[];
  signal: AbortSignal;
  systemPrompt: string;
}): Promise<Response> {
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
          instructions: `${systemPrompt}${retryInstruction}`,
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

  if (
    body.useSelectorSystemPrompt !== undefined &&
    typeof body.useSelectorSystemPrompt !== 'boolean'
  ) {
    return jsonError(400, {
      code: 'invalid_system_prompt_mode',
      message: 'Режим системного промпта указан некорректно.',
    });
  }

  let systemPrompt: string;

  if (body.useSelectorSystemPrompt === false) {
    if (!isValidCustomSystemPrompt(body.customSystemPrompt)) {
      return jsonError(400, {
        code: 'invalid_custom_system_prompt',
        message: `Введите системный промпт от 1 до ${MAX_CUSTOM_SYSTEM_PROMPT_LENGTH} символов.`,
      });
    }
    systemPrompt = body.customSystemPrompt;
  } else {
    systemPrompt = buildSelectorSystemPrompt(outputFormat, targetOutputTokens);
  }

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
      systemPrompt,
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
        instructions: systemPrompt,
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
