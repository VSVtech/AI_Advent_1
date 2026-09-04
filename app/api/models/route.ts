import { DEFAULT_MODEL } from '@/lib/chat-constraints';
import type { ModelsResponsePayload } from '@/lib/chat-types';
import {
  DEEPSEEK_MODELS_ENDPOINT,
  jsonError,
} from '@/lib/server/deepseek';

function jsonModels(models: string[]): Response {
  return Response.json(
    { models, default: DEFAULT_MODEL } satisfies ModelsResponsePayload,
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

// The token's available models can change server-side (new releases,
// account limits), so this list is fetched from DeepSeek on every call
// rather than hardcoded. Any failure degrades to the single default
// model instead of blocking the chat UI.
export async function GET(): Promise<Response> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    return jsonError(500, {
      code: 'configuration_error',
      message: 'DEEPSEEK_API_KEY не настроен. Добавьте токен в .env.local.',
    });
  }

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(DEEPSEEK_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
    });
  } catch {
    return jsonModels([DEFAULT_MODEL]);
  }

  if (!upstreamResponse.ok) return jsonModels([DEFAULT_MODEL]);

  let payload: { data?: Array<{ id?: unknown }> } | null = null;

  try {
    payload = (await upstreamResponse.json()) as {
      data?: Array<{ id?: unknown }>;
    };
  } catch {
    return jsonModels([DEFAULT_MODEL]);
  }

  const ids = Array.isArray(payload?.data)
    ? payload.data
        .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
        .filter((id) => id.length > 0)
    : [];

  const models = ids.length > 0 ? Array.from(new Set(ids)).sort() : [DEFAULT_MODEL];

  return jsonModels(models);
}
