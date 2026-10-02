import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT, DATA_DIR, STRATEGIES, strategyById } from './config.mjs';
import { documentSummary, hash, loadDocuments } from './documents.mjs';
import { OllamaEmbeddings, searchIndex } from './embeddings.mjs';
import { buildIndices } from './pipeline.mjs';
import { evaluate } from './evaluate.mjs';
import { loadTokenizer } from './tokenizer.mjs';
import { loadIndex, readCurrent, readJson } from './storage.mjs';

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function createRagHandler({
  root = ROOT,
  dataDir = DATA_DIR,
  provider = new OllamaEmbeddings(),
} = {}) {
  let job = { status: 'idle', action: null, progress: null, error: null };
  const onProgress = (progress) => {
    job = { ...job, progress };
  };
  return async (request) => {
    // Only the same-machine application proxy may call this service. Browsers
    // cannot invoke expensive writes via a cross-origin request or HTML form.
    if (request.headers.get('Origin'))
      return json({ error: 'Прямые запросы из браузера запрещены.' }, 403);
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/rag') return json({ error: 'Не найдено.' }, 404);
      const current = await readCurrent(dataDir);
      if (request.method === 'GET') {
        if (url.searchParams.get('view') === 'answers') {
          try {
            return json(
              await readJson(join(root, 'rag/answers-comparison.json')),
            );
          } catch (error) {
            if (error.code === 'ENOENT')
              return json(
                {
                  error:
                    'Сравнение ещё не выполнено. Запустите pnpm rag:answers.',
                },
                404,
              );
            throw error;
          }
        }

        if (url.searchParams.get('view') === 'chunks') {
          if (!current) return json({ chunks: [], total: 0 });
          const strategy = strategyById(
            url.searchParams.get('strategy') ?? 'structure',
          );
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (!Number.isInteger(offset) || offset < 0)
            return json({ error: 'Некорректная страница.' }, 400);
          const index = await loadIndex(dataDir, current.build_id, strategy.id);
          const source = url.searchParams.get('source');
          const chunks = index.chunks.filter(
            (chunk) => !source || chunk.source === source,
          );
          return json({
            build_id: current.build_id,
            total: chunks.length,
            chunks: chunks
              .slice(offset, offset + 20)
              .map(({ embedding: _embedding, ...chunk }) => chunk),
          });
        }
        let comparison = null;
        if (current) {
          try {
            comparison = await readJson(
              join(dataDir, 'builds', current.build_id, 'comparison.json'),
            );
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        const documents = await loadDocuments(
          root,
          await readJson(join(root, 'rag/corpus.json')),
        );
        const corpus = documents.map(documentSummary);
        return json({
          current,
          documents: corpus,
          strategies: STRATEGIES,
          job,
          comparison,
          stale: current
            ? current.corpus_hash !== hash(JSON.stringify(corpus))
            : false,
        });
      }
      if (request.method !== 'POST')
        return json({ error: 'Метод не поддерживается.' }, 405);
      if (!request.headers.get('Content-Type')?.startsWith('application/json'))
        return json({ error: 'Требуется JSON.' }, 415);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Некорректный JSON.' }, 400);
      }
      if (!body || typeof body !== 'object')
        return json({ error: 'Некорректный запрос.' }, 400);
      if (body.action === 'index' || body.action === 'compare') {
        if (job.status === 'running')
          return json({ error: 'Дождитесь завершения текущей операции.' }, 409);
        if (body.action === 'compare' && !current)
          return json({ error: 'Сначала постройте индекс.' }, 409);
        job = {
          status: 'running',
          action: body.action,
          progress: null,
          error: null,
        };
        const run = async () => {
          if (body.action === 'index')
            await buildIndices({
              root,
              dataDir,
              provider,
              tokenizer: await loadTokenizer(dataDir),
              onProgress,
            });
          else await evaluate({ root, dataDir, provider, onProgress });
        };
        void run()
          .then(() => {
            job = { ...job, status: 'completed' };
          })
          .catch((error) => {
            job = { ...job, status: 'failed', error: error.message };
          });
        return json({ job }, 202);
      }
      if (body.action === 'search') {
        if (!current) return json({ error: 'Сначала постройте индекс.' }, 409);
        if (
          typeof body.query !== 'string' ||
          !body.query.trim() ||
          body.query.length > 2000 ||
          !STRATEGIES.some((strategy) => strategy.id === body.strategy)
        )
          return json(
            { error: 'Укажите стратегию и запрос от 1 до 2000 символов.' },
            400,
          );
        const requestedBuild = body.build_id ?? current.build_id;
        if (
          typeof requestedBuild !== 'string' ||
          !/^[a-zA-Z0-9-]{1,100}$/u.test(requestedBuild)
        )
          return json({ error: 'Некорректная версия индекса.' }, 400);
        const index = await loadIndex(dataDir, requestedBuild, body.strategy);
        if (
          JSON.stringify(await provider.describe()) !==
          JSON.stringify(index.manifest.embedding)
        )
          return json({ error: 'Модель изменилась. Перестройте индекс.' }, 409);
        const [vector] = await provider.embed([body.query.trim()], 'query');
        return json({
          build_id: requestedBuild,
          hits: searchIndex(index, vector),
        });
      }
      return json({ error: 'Неизвестная операция.' }, 400);
    } catch (error) {
      return json(
        {
          error: error.code
            ? 'Не удалось прочитать локальный корпус или индекс. Проверьте файлы и повторите сборку.'
            : error.message,
        },
        500,
      );
    }
  };
}

export function startRagServer(port = Number(process.env.RAG_PORT ?? 18803)) {
  const handler = createRagHandler();
  const server = createServer(async (incoming, outgoing) => {
    if (
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(
        incoming.headers.host,
      )
    ) {
      outgoing.writeHead(403);
      outgoing.end();
      return;
    }
    try {
      const buffers = [];
      let bytes = 0;
      for await (const buffer of incoming) {
        bytes += buffer.length;
        if (bytes > 16_384) {
          outgoing.writeHead(413);
          outgoing.end();
          return;
        }
        buffers.push(buffer);
      }
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        body: incoming.method === 'POST' ? Buffer.concat(buffers) : undefined,
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(500);
      outgoing.end('{"error":"Ошибка локального сервиса RAG."}');
    }
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`RAG: http://127.0.0.1:${port}/rag`),
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startRagServer();
