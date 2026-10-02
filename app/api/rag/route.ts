const DEFAULT_RAG_URL = 'http://127.0.0.1:18803/rag';

async function proxy(request: Request): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json(
      { error: 'Запрос с другого сайта запрещён.' },
      { status: 403 },
    );
  }
  const target = new URL(process.env.RAG_SERVICE_URL ?? DEFAULT_RAG_URL);
  const url = new URL(request.url);
  for (const key of ['view', 'strategy', 'source', 'offset']) {
    const value = url.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  try {
    let body: string | undefined;
    if (request.method === 'POST') {
      if (!request.headers.get('Content-Type')?.startsWith('application/json'))
        return Response.json({ error: 'Требуется JSON.' }, { status: 415 });
      body = await request.text();
      if (new TextEncoder().encode(body).length > 16_384)
        return Response.json(
          { error: 'Слишком большой запрос.' },
          { status: 413 },
        );
    }
    const response = await fetch(target, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(190_000)]),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return Response.json(
      {
        error:
          'Сервис базы знаний недоступен. Запустите приложение через start.sh или выполните pnpm rag:server.',
      },
      { status: 503 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
