import type {
  ApiChatMessage,
  ChatOutputFormat,
  ChatRequest,
} from '@/lib/chat-types';
import {
  calculateMaxOutputTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  estimateContextTokenCount,
  isValidContextWindowTokens,
  isValidMaxOutputTokens,
  isValidModel,
  isValidTargetOutputTokensOrNull,
  isValidTemperature,
  MAX_TEMPERATURE,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  MIN_TEMPERATURE,
} from '@/lib/chat-constraints';
import {
  buildSelectorSystemPrompt,
  isValidCustomSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';
import { isVisionModel } from '@/lib/file-attachments';
import {
  buildLongTermMemorySystemPrompt,
  isLongTermMemoryFacts,
} from '@/lib/memory-layers';
import {
  buildUserProfileSystemPrompt,
  normalizeProfileText,
} from '@/lib/user-profile';
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
  extractInputTokenUsage,
  extractOutputText,
} from '@/lib/server/deepseek';

const MAX_FORMAT_RETRIES = 3;

function isChatOutputFormat(value: unknown): value is ChatOutputFormat {
  return (
    value === 'text' || value === 'json' || value === 'xml' || value === 'yaml'
  );
}

function contextWindowError({
  contextWindowTokens,
  messages,
  systemPrompt,
}: {
  contextWindowTokens: number;
  messages: ApiChatMessage[];
  systemPrompt: string | null;
}): Response | null {
  const estimatedInputTokens = estimateContextTokenCount(
    messages,
    systemPrompt,
  );

  if (estimatedInputTokens <= contextWindowTokens) return null;

  return jsonError(413, {
    code: 'context_window_exceeded',
    message: `Контекст переполнен: история, память и инструкции занимают примерно ${estimatedInputTokens} токенов, а лимит агента — ${contextWindowTokens}. Увеличьте лимит или сократите контекст.`,
  });
}

async function generateStructuredOutput({
  apiKey,
  contextWindowTokens,
  format,
  maxOutputTokens,
  messages,
  model,
  signal,
  systemPrompt,
  temperature,
}: {
  apiKey: string;
  contextWindowTokens: number;
  format: StructuredOutputFormat;
  maxOutputTokens: number;
  messages: ApiChatMessage[];
  model: string;
  signal: AbortSignal;
  systemPrompt: string | null;
  temperature: number;
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
    const requestMessages =
      systemPrompt === null && retryInstruction
        ? [
            ...messages,
            { role: 'user' as const, content: retryInstruction.trim() },
          ]
        : messages;
    const requestSystemPrompt =
      systemPrompt === null ? null : `${systemPrompt}${retryInstruction}`;
    const overflowResponse = contextWindowError({
      contextWindowTokens,
      messages: requestMessages,
      systemPrompt: requestSystemPrompt,
    });

    if (overflowResponse) return overflowResponse;

    let upstreamResponse: Response;

    try {
      upstreamResponse = await fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          // Format repair must not re-enable a disabled system prompt.
          // Only the current retry gets this user instruction; history is unchanged.
          input: requestMessages,
          max_output_tokens: maxOutputTokens,
          temperature,
          stream: false,
          reasoning: { effort: 'none' },
          text: { format: textFormat },
          ...(requestSystemPrompt === null
            ? {}
            : { instructions: requestSystemPrompt }),
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
      return completedOutputResponse(content, {
        outputTokens: extractOutputTokens(payload),
        ...extractInputTokenUsage(payload),
      });
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

  // `null` explicitly disables the target length (and, with it, the
  // derived max-output cap below) — only `undefined` falls back to the
  // default target.
  const targetOutputTokens =
    body.targetOutputTokens === undefined
      ? DEFAULT_TARGET_OUTPUT_TOKENS
      : body.targetOutputTokens;

  if (!isValidTargetOutputTokensOrNull(targetOutputTokens)) {
    return jsonError(400, {
      code: 'invalid_target_output_tokens',
      message: 'Целевая длина ответа указана некорректно.',
    });
  }

  const maxOutputTokens =
    body.maxOutputTokens === undefined
      ? calculateMaxOutputTokens(targetOutputTokens)
      : body.maxOutputTokens;

  if (!isValidMaxOutputTokens(maxOutputTokens)) {
    return jsonError(400, {
      code: 'invalid_max_output_tokens',
      message: 'Технический лимит длины ответа указан некорректно.',
    });
  }

  const contextWindowTokens =
    body.contextWindowTokens === undefined
      ? DEFAULT_CONTEXT_WINDOW_TOKENS
      : body.contextWindowTokens;

  if (!isValidContextWindowTokens(contextWindowTokens)) {
    return jsonError(400, {
      code: 'invalid_context_window_tokens',
      message: `Укажите лимит контекста от ${MIN_CONTEXT_WINDOW_TOKENS} до ${MAX_CONTEXT_WINDOW_TOKENS} токенов.`,
    });
  }

  const temperature =
    body.temperature === undefined ? DEFAULT_TEMPERATURE : body.temperature;

  if (!isValidTemperature(temperature)) {
    return jsonError(400, {
      code: 'invalid_temperature',
      message: `Укажите температуру от ${MIN_TEMPERATURE} до ${MAX_TEMPERATURE}.`,
    });
  }

  const model = body.model === undefined ? DEEPSEEK_MODEL : body.model;

  if (!isValidModel(model)) {
    return jsonError(400, {
      code: 'invalid_model',
      message: 'Некорректный идентификатор модели.',
    });
  }

  const hasImages = body.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'input_image'),
  );

  if (hasImages && !isVisionModel(model)) {
    return jsonError(400, {
      code: 'vision_model_required',
      message: 'Для работы с изображениями выберите модель DeepSeek Flash.',
    });
  }

  if (
    (body.useSystemPrompt !== undefined &&
      typeof body.useSystemPrompt !== 'boolean') ||
    (body.useSelectorSystemPrompt !== undefined &&
      typeof body.useSelectorSystemPrompt !== 'boolean')
  ) {
    return jsonError(400, {
      code: 'invalid_system_prompt_mode',
      message: 'Режим системного промпта указан некорректно.',
    });
  }

  if (
    body.longTermMemory !== undefined &&
    !isLongTermMemoryFacts(body.longTermMemory)
  ) {
    return jsonError(400, {
      code: 'invalid_long_term_memory',
      message: 'Долговременная память передана некорректно.',
    });
  }

  const profile =
    body.profile === undefined ? '' : normalizeProfileText(body.profile);
  if (body.profile !== undefined && profile === null) {
    return jsonError(400, {
      code: 'invalid_user_profile',
      message: 'Профиль пользователя передан некорректно.',
    });
  }

  let configuredPrompt: string | null;

  if (body.useSystemPrompt === false) {
    configuredPrompt = null;
  } else if (body.useSelectorSystemPrompt === false) {
    if (!isValidCustomSystemPrompt(body.customSystemPrompt)) {
      return jsonError(400, {
        code: 'invalid_custom_system_prompt',
        message: `Введите системный промпт от 1 до ${MAX_CUSTOM_SYSTEM_PROMPT_LENGTH} символов.`,
      });
    }
    configuredPrompt = body.customSystemPrompt;
  } else {
    configuredPrompt = buildSelectorSystemPrompt(
      outputFormat,
      targetOutputTokens,
    );
  }
  const longTermPrompt = buildLongTermMemorySystemPrompt(
    body.longTermMemory ?? [],
  );
  const profilePrompt = profile ? buildUserProfileSystemPrompt(profile) : null;
  const systemPrompt =
    [configuredPrompt, profilePrompt, longTermPrompt]
      .filter(Boolean)
      .join('\n\n') || null;

  const overflowResponse = contextWindowError({
    contextWindowTokens,
    messages: body.messages,
    systemPrompt,
  });

  if (overflowResponse) return overflowResponse;

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
      contextWindowTokens,
      format: outputFormat,
      maxOutputTokens,
      messages: body.messages,
      model,
      signal: request.signal,
      systemPrompt,
      temperature,
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
        model,
        input: body.messages,
        max_output_tokens: maxOutputTokens,
        temperature,
        stream: true,
        reasoning: { effort: 'none' },
        text: { format: { type: 'text' } },
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
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
    createNormalizedStream(
      upstreamResponse.body,
      request.signal,
      body.maxOutputTokens === undefined
        ? {}
        : {
            tokenLimitMessage: `Ответ DeepSeek достиг технического лимита вывода ${maxOutputTokens} токенов. Сократите требуемый ответ и повторите запрос.`,
          },
    ),
  );
}
