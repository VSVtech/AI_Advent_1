import {
  BENCHMARK_MAX_OUTPUT_TOKENS,
  BENCHMARK_MAX_PROMPT_LENGTH,
  type BenchmarkRequest,
  type BenchmarkResponsePayload,
} from '@/lib/benchmark';
import { isValidModel } from '@/lib/chat-constraints';
import {
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  extractInputTokenUsage,
  extractOutputText,
  extractOutputTokens,
  jsonError,
  mappedUpstreamError,
  type DeepSeekResponsePayload,
} from '@/lib/server/deepseek';

// One-shot, non-streaming request used only to measure and compare
// per-model latency and token usage for the same prompt. No system
// prompt, no history — each call is independent so timings aren't
// skewed by unrelated context.
export async function POST(request: Request): Promise<Response> {
  let body: BenchmarkRequest;

  try {
    body = (await request.json()) as BenchmarkRequest;
  } catch {
    return jsonError(400, {
      code: 'invalid_json',
      message: 'Тело запроса должно быть корректным JSON.',
    });
  }

  if (!body || typeof body !== 'object') {
    return jsonError(400, {
      code: 'invalid_request',
      message: 'Тело запроса должно быть JSON-объектом.',
    });
  }

  const model = body.model === undefined ? DEEPSEEK_MODEL : body.model;

  if (!isValidModel(model)) {
    return jsonError(400, {
      code: 'invalid_model',
      message: 'Некорректный идентификатор модели.',
    });
  }

  if (
    typeof body.prompt !== 'string' ||
    !body.prompt.trim() ||
    body.prompt.length > BENCHMARK_MAX_PROMPT_LENGTH
  ) {
    return jsonError(400, {
      code: 'invalid_prompt',
      message: `Введите промпт от 1 до ${BENCHMARK_MAX_PROMPT_LENGTH} символов.`,
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
  const startedAt = Date.now();
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
        input: [{ role: 'user', content: prompt }],
        max_output_tokens: BENCHMARK_MAX_OUTPUT_TOKENS,
        stream: false,
        reasoning: { effort: 'none' },
        text: { format: { type: 'text' } },
      }),
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return jsonError(502, {
      code: 'deepseek_unreachable',
      message:
        'Не удалось связаться с DeepSeek. Проверьте подключение к интернету.',
    });
  }

  const latencyMs = Date.now() - startedAt;

  if (!upstreamResponse.ok) return mappedUpstreamError(upstreamResponse);

  let payload: DeepSeekResponsePayload | null = null;

  try {
    payload = (await upstreamResponse.json()) as DeepSeekResponsePayload;
  } catch {
    // A malformed upstream body is treated as an incomplete run below.
  }

  if (payload?.status === 'incomplete') {
    const reachedTokenLimit =
      payload.incomplete_details?.reason === 'max_output_tokens';

    return jsonError(502, {
      code: reachedTokenLimit ? 'max_output_tokens' : 'response_incomplete',
      message: reachedTokenLimit
        ? `Ответ достиг лимита в ${BENCHMARK_MAX_OUTPUT_TOKENS} токенов.`
        : 'DeepSeek не смог завершить ответ. Попробуйте ещё раз.',
    });
  }

  const answer = payload ? extractOutputText(payload) : null;

  if (!payload || !answer) {
    return jsonError(502, {
      code: 'empty_upstream_response',
      message: 'DeepSeek вернул пустой ответ. Попробуйте ещё раз.',
    });
  }

  const { inputTokens, cachedInputTokens } = extractInputTokenUsage(payload);

  return Response.json(
    {
      model,
      latencyMs,
      inputTokens,
      cachedInputTokens,
      outputTokens: extractOutputTokens(payload),
      answer,
    } satisfies BenchmarkResponsePayload,
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
