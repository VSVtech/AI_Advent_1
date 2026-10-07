// Shared local transport for standalone chat, agents, and memory analysis.
export function ollamaEndpoint(path: string) {
  const base = new URL(
    process.env.LOCAL_OLLAMA_URL ??
      process.env.RAG_OLLAMA_URL ??
      'http://127.0.0.1:11434',
  );
  if (
    base.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error('Для локального чата нужен HTTP-адрес Ollama на loopback.');
  return new URL(path, base);
}
function failure(message: string, status = 503) {
  return Response.json(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
export async function installedLocalModels(signal: AbortSignal) {
  const response = await fetch(ollamaEndpoint('/api/tags'), {
    signal,
    redirect: 'manual',
  });
  if (!response.ok) throw new Error('Ollama недоступна.');
  const data = (await response.json()) as {
    models?: Array<{ name: string; size: number; remote_model?: string }>;
  };
  if (!Array.isArray(data.models))
    throw new Error('Некорректный список моделей.');
  const models = await Promise.all(
    data.models.slice(0, 50).map(async (model) => {
      if (
        typeof model.name !== 'string' ||
        model.remote_model ||
        /cloud/i.test(model.name)
      )
        return null;
      const info = await fetch(ollamaEndpoint('/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model.name }),
        signal,
        redirect: 'manual',
      });
      if (!info.ok) return null;
      const details = (await info.json()) as {
        capabilities?: string[];
        remote_model?: string;
        remote_host?: string;
      };
      if (
        details.remote_model ||
        details.remote_host ||
        !details.capabilities?.includes('completion')
      )
        return null;
      return { name: model.name, size: model.size };
    }),
  );
  return models.filter((m): m is { name: string; size: number } => m !== null);
}

export async function generateLocalChat({
  model,
  messages,
  signal: requestSignal,
  format = 'text',
  temperature = 0.3,
  contextTokens = 8192,
  maxOutputTokens = 1024,
}: {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  signal: AbortSignal;
  format?: string;
  temperature?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
}): Promise<Response> {
  const abort = new AbortController();
  const signal = AbortSignal.any([
    requestSignal,
    abort.signal,
    AbortSignal.timeout(180000),
  ]);
  try {
    const models = await installedLocalModels(signal);
    if (!models.some((m) => m.name === model))
      return failure('Выберите установленную локальную модель для чата.', 400);
    const response = await fetch(ollamaEndpoint('/api/chat'), {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: true,
        think: false,
        ...(format === 'json' ? { format: 'json' } : {}),
        options: {
          temperature,
          num_ctx: contextTokens,
          num_predict: maxOutputTokens,
        },
      }),
    });
    if (!response.ok || !response.body) {
      abort.abort();
      return failure(
        'Ollama не смогла запустить модель. Проверьте её наличие и свободную память.',
      );
    }
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = '',
      finished = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: string, data: object) =>
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        const line = (raw: string) => {
          if (!raw.trim()) return;
          const value = JSON.parse(raw);
          if (value.error) throw new Error('Ollama прервала генерацию.');
          if (
            typeof value.message?.content === 'string' &&
            value.message.content
          )
            emit('delta', { content: value.message.content });
          if (value.done === true) {
            finished = true;
            emit('done', {
              finishReason: value.done_reason ?? 'stop',
              outputTokens: value.eval_count,
              inputTokens: value.prompt_eval_count,
            });
          }
        };
        try {
          while (!finished) {
            const { done, value } = await reader.read();
            buffer += done
              ? decoder.decode()
              : decoder.decode(value, { stream: true });
            if (buffer.length > 1000000)
              throw new Error('Слишком большой фрагмент ответа.');
            let end;
            while (!finished && (end = buffer.indexOf('\n')) !== -1) {
              const raw = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              line(raw);
            }
            if (done) {
              if (!finished) line(buffer);
              break;
            }
          }
          if (!finished) throw new Error('Поток ответа оборвался.');
        } catch {
          if (!signal.aborted)
            emit('error', {
              code: 'local_stream_error',
              message: 'Локальная модель прервала ответ. Повторите запрос.',
            });
          else if (!requestSignal.aborted && !abort.signal.aborted)
            emit('error', {
              code: 'local_timeout',
              message: 'Превышено время ожидания локальной модели (3 минуты).',
            });
        } finally {
          await reader.cancel().catch(() => {});
          abort.abort();
          try {
            controller.close();
          } catch {
            /* Client cancelled. */
          }
        }
      },
      cancel() {
        abort.abort();
        return reader.cancel();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    abort.abort();
    return failure(
      'Не удалось обратиться к локальной модели. Проверьте Ollama и повторите запрос.',
    );
  }
}
