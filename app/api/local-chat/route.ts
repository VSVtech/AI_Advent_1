import { installedLocalModels, generateLocalChat } from '@/lib/server/ollama';
function failure(message: string, status = 503) {
  return Response.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
export async function GET(request: Request) {
  if (!sameOrigin(request))
    return failure('Запрос с другого сайта запрещён.', 403);
  try {
    const models = await installedLocalModels(
      AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    );
    return Response.json(
      { models },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return failure(
      'Ollama недоступна или настроена не локально. Запустите pnpm rag:ollama и обновите список моделей.',
    );
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return failure('Запрос с другого сайта запрещён.', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return failure('Требуется JSON.', 415);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 60000) return failure('Слишком большой запрос.', 413);
    body = JSON.parse(raw);
  } catch {
    return failure('Некорректный JSON.', 400);
  }
  if (
    !body ||
    typeof body.model !== 'string' ||
    body.model.length > 200 ||
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 12 ||
    !body.messages.every(
      (m: { role?: string; content?: string }) =>
        m &&
        ['user', 'assistant'].includes(m.role ?? '') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0 &&
        m.content.length <= 16000,
    ) ||
    body.messages.reduce(
      (sum: number, m: { content: string }) => sum + m.content.length,
      0,
    ) > 16000 ||
    body.messages.at(-1).role !== 'user'
  )
    return failure(
      'Некорректная история или модель. Лимит контекста — 12 сообщений и 16 000 символов.',
      400,
    );
  return generateLocalChat({
    model: body.model,
    messages: body.messages,
    signal: request.signal,
  });
}
