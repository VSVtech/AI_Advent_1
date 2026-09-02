import type { ApiChatMessage } from '@/lib/chat-types';
import {
  COMPARISON_MAX_OUTPUT_TOKENS,
  COMPARISON_VARIANTS,
  MAX_COMPARISON_HISTORY_MESSAGES,
  MAX_COMPARISON_PROMPT_LENGTH,
  PROMPT_CREATION_PREFIX,
  STEP_BY_STEP_SUFFIX,
  type ComparisonRequest,
} from '@/lib/comparison';
import {
  createNormalizedStream,
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  eventStreamResponse,
  extractOutputText,
  extractOutputTokens,
  isChatMessage,
  jsonError,
  mappedUpstreamError,
  type DeepSeekResponsePayload,
} from '@/lib/server/deepseek';

export async function POST(request: Request): Promise<Response> {
  let body: ComparisonRequest;

  try {
    body = (await request.json()) as ComparisonRequest;
  } catch {
    return jsonError(400, {
      code: 'invalid_json',
      message: 'Тело запроса должно быть корректным JSON.',
    });
  }

  const variant =
    body && COMPARISON_VARIANTS.find((item) => item.id === body.variant);
  if (!variant) {
    return jsonError(400, {
      code: 'invalid_variant',
      message: 'Выбран неизвестный вариант сравнения.',
    });
  }
  if (
    typeof body.prompt !== 'string' ||
    !body.prompt.trim() ||
    body.prompt.length > MAX_COMPARISON_PROMPT_LENGTH
  ) {
    return jsonError(400, {
      code: 'invalid_prompt',
      message: `Введите пользовательский промпт от 1 до ${MAX_COMPARISON_PROMPT_LENGTH} символов.`,
    });
  }
  const history = body.messages === undefined ? [] : body.messages;
  if (
    !Array.isArray(history) ||
    history.length > MAX_COMPARISON_HISTORY_MESSAGES ||
    history.length % 2 !== 0 ||
    !history.every(
      (message, index) =>
        isChatMessage(message) &&
        message.role === (index % 2 === 0 ? 'user' : 'assistant') &&
        message.content.length <= 50_000,
    ) ||
    history.reduce((length, message) => length + message.content.length, 0) >
      200_000
  ) {
    return jsonError(400, {
      code: 'invalid_messages',
      message:
        'История сравнения некорректна или слишком длинная. Очистите сравнение и повторите запрос.',
    });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });
  }
  if (request.signal.aborted) return new Response(null, { status: 499 });

  const prompt = body.prompt.trim();
  let actualPrompt = variant.id === 3 ? prompt + STEP_BY_STEP_SUFFIX : prompt;
  let promptOutputTokens: number | null = null;

  const generate = (
    input: ApiChatMessage[],
    stream: boolean,
    systemPrompt: string,
  ) =>
    fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        input,
        stream,
        max_output_tokens: COMPARISON_MAX_OUTPUT_TOKENS,
        reasoning: { effort: 'none' },
        text: { format: { type: 'text' } },
        // An empty system prompt really means no instructions, including length/format hints.
        ...(systemPrompt ? { instructions: systemPrompt } : {}),
      }),
      cache: 'no-store',
      signal: request.signal,
    });

  try {
    if (variant.id === 4) {
      // Prompt creation never receives, or becomes part of, the solution chat history.
      const preparation = await generate(
        [{ role: 'user', content: PROMPT_CREATION_PREFIX + prompt }],
        false,
        '',
      );
      if (!preparation.ok) return mappedUpstreamError(preparation);
      let payload: DeepSeekResponsePayload | null = null;
      let generatedPrompt: string | null = null;
      try {
        payload = (await preparation.json()) as DeepSeekResponsePayload;
        generatedPrompt = payload ? extractOutputText(payload) : null;
      } catch {
        // Invalid or incomplete preparation must never be sent to the solver.
      }
      if (!generatedPrompt) {
        return jsonError(502, {
          code: 'prompt_generation_failed',
          message:
            'DeepSeek не смог завершить создание промпта. Запрос на решение не выполнялся.',
        });
      }
      actualPrompt = generatedPrompt;
      promptOutputTokens = payload ? extractOutputTokens(payload) : null;
    }

    if (request.signal.aborted) return new Response(null, { status: 499 });
    const response = await generate(
      [...history, { role: 'user', content: actualPrompt }],
      true,
      variant.systemPrompt,
    );
    if (!response.ok) return mappedUpstreamError(response);
    if (!response.body)
      return jsonError(502, {
        code: 'empty_upstream_response',
        message: 'DeepSeek вернул пустой ответ. Попробуйте ещё раз.',
      });

    return eventStreamResponse(
      createNormalizedStream(response.body, request.signal, {
        initialEvent: {
          type: 'prepared',
          prompt: actualPrompt,
          ...(promptOutputTokens === null ? {} : { promptOutputTokens }),
        },
        tokenLimitMessage: `Ответ достиг лимита в ${COMPARISON_MAX_OUTPUT_TOKENS} токенов. Сократите задачу или начните новое сравнение.`,
      }),
    );
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return jsonError(502, {
      code: 'deepseek_unreachable',
      message:
        'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
    });
  }
}
