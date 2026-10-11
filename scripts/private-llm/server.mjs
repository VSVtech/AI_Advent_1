import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { configuration, validateChat } from './config.mjs';
import { GenerationQueue } from './queue.mjs';

const publicFiles = new Map(
  [
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ].map(([url, [file, type]]) => [
    url,
    { type, data: readFileSync(new URL(`./public/${file}`, import.meta.url)) },
  ]),
);

export async function checkModel(
  config,
  fetcher = fetch,
  signal = AbortSignal.timeout(10000),
) {
  const response = await fetcher(`${config.ollamaURL}/api/show`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model }),
  });
  if (!response.ok) throw new Error('Local model unavailable.');
  const model = await response.json();
  if (
    model.remote_model ||
    model.remote_host ||
    !model.capabilities?.includes('completion')
  )
    throw new Error('Only an installed local completion model is allowed.');
}

function authorized(request, token) {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

async function readBounded(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createPrivateServer(
  config,
  { fetcher = fetch, now = Date.now, log = console.log } = {},
) {
  const queue = new GenerationQueue(config);
  let windowStart = now(),
    used = 0;
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 },
    async (request, response) => {
      const started = now();
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const send = (status, data, extra = {}) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          ...extra,
        });
        response.end(JSON.stringify(data));
      };
      // Log metadata only. Never log the URL query, authorization, prompts or answers.
      response.on('finish', () =>
        log(
          JSON.stringify({
            event: 'request',
            status: response.statusCode,
            ms: now() - started,
          }),
        ),
      );
      const abort = new AbortController();
      response.on('close', () => abort.abort());
      try {
        const host = request.headers.host ?? '';
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host))
          return send(403, {
            error: 'Use a loopback SSH tunnel.',
            code: 'invalid_host',
          });
        if (
          request.headers.origin &&
          request.headers.origin !== `http://${host}`
        )
          return send(403, {
            error: 'Запрос с другого сайта запрещён.',
            code: 'invalid_origin',
          });
        const url = new URL(request.url, `http://${host}`);
        if (url.search)
          return send(400, { error: 'Query parameters are not accepted.' });
        const file = publicFiles.get(url.pathname);
        if (request.method === 'GET' && file) {
          response.writeHead(200, { 'Content-Type': file.type });
          return response.end(file.data);
        }
        if (request.method === 'GET' && url.pathname === '/healthz')
          return send(200, { status: 'alive' });
        if (!authorized(request, config.token))
          return send(401, {
            error: 'Нужен ключ доступа.',
            code: 'unauthorized',
          });
        if (request.method === 'GET' && url.pathname === '/api/status') {
          // Static configuration + process state. No expensive upstream call per poll.
          return send(200, {
            model: config.model,
            contextTokens: config.contextTokens,
            maxOutputTokens: config.maxOutputTokens,
            requestsPerMinute: config.requestsPerMinute,
            concurrency: config.concurrency,
            active: queue.active,
            queued: queue.waiting.length,
            queueCapacity: config.queueCapacity,
            queueTimeoutMs: config.queueTimeoutMs,
            generationTimeoutMs: config.timeoutMs,
            access: 'ssh-tunnel',
            inference: 'local-on-server',
          });
        }
        if (request.method !== 'POST' || url.pathname !== '/api/chat')
          return send(404, { error: 'Not found.' });
        if (now() - windowStart >= 60000) {
          windowStart = now();
          used = 0;
        }
        const retryAfter = Math.max(
          1,
          Math.ceil((60000 - (now() - windowStart)) / 1000),
        );
        if (used >= config.requestsPerMinute)
          return send(
            429,
            {
              code: 'rate_limit',
              error: 'Лимит запросов исчерпан. Повторите позже.',
            },
            { 'Retry-After': String(retryAfter) },
          );
        used++;
        if (
          request.headers['content-type']?.split(';')[0].trim() !==
          'application/json'
        )
          return send(415, { error: 'Требуется application/json.' });
        if (
          Number(request.headers['content-length'] ?? 0) > config.maxBodyBytes
        )
          return send(413, {
            code: 'body_limit',
            error: 'Слишком большой запрос.',
          });
        let release;
        try {
          let body;
          try {
            body = JSON.parse(
              await readBounded(
                request.iterator({ destroyOnReturn: false }),
                config.maxBodyBytes,
              ),
            );
          } catch (error) {
            request.resume();
            return send(
              error.status ?? 400,
              {
                code: error.status === 413 ? 'body_limit' : 'invalid_json',
                error: 'Некорректный или слишком большой JSON.',
              },
              { Connection: 'close' },
            );
          }
          const input = validateChat(body, config);
          if (input.error)
            return send(input.status, { code: input.code, error: input.error });
          const queuedAt = now();
          release = await queue.acquire(abort.signal);
          const generationStarted = now();
          // Waiting has its own deadline. A queued request receives the full
          // inference timeout only after an Ollama slot becomes available.
          const signal = AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(config.timeoutMs),
          ]);
          await checkModel(config, fetcher, signal);
          const upstream = await fetcher(`${config.ollamaURL}/api/chat`, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: config.model,
              messages: input.messages,
              stream: false,
              think: false,
              keep_alive: '5m',
              options: {
                temperature: input.temperature,
                num_ctx: input.context,
                num_predict: input.output,
              },
            }),
          });
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();
            throw new Error('Upstream unavailable');
          }
          const data = JSON.parse(
            await readBounded(upstream.body, 1024 * 1024),
          );
          if (
            data.error ||
            data.done !== true ||
            typeof data.message?.content !== 'string' ||
            !data.message.content.trim()
          )
            throw new Error('Incomplete upstream response');
          return send(200, {
            model: config.model,
            message: { role: 'assistant', content: data.message.content },
            finishReason: data.done_reason ?? 'stop',
            usage: {
              inputTokens: data.prompt_eval_count,
              outputTokens: data.eval_count,
            },
            seconds: Number(((now() - started) / 1000).toFixed(2)),
            queueWaitSeconds: Number(
              ((generationStarted - queuedAt) / 1000).toFixed(3),
            ),
            generationSeconds: Number(
              ((now() - generationStarted) / 1000).toFixed(3),
            ),
          });
        } finally {
          release?.();
        }
      } catch (error) {
        if (
          !abort.signal.aborted &&
          ['queue_full', 'queue_timeout'].includes(error.code)
        )
          return send(
            error.status,
            { code: error.code, error: error.message },
            error.code === 'queue_full' ? { 'Retry-After': '5' } : {},
          );
        if (!abort.signal.aborted)
          send(error.name === 'TimeoutError' ? 504 : 503, {
            code: error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
            error:
              'Модель не ответила вовремя или недоступна. Повторите запрос позже.',
          });
      }
    },
  );
  server.maxConnections = 32;
  server.keepAliveTimeout = 5000;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = configuration();
    await checkModel(config);
    const server = createPrivateServer(config);
    server.listen(config.port, config.host, () =>
      console.log(
        `Private LLM listening on ${config.host}:${config.port}; model=${config.model}`,
      ),
    );
    const shutdown = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch {
    console.error(
      'Private LLM startup failed. Check configuration, token file and installed local model.',
    );
    process.exitCode = 1;
  }
}
