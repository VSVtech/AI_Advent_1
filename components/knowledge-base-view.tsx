'use client';
/* oxlint-disable next/no-html-link-for-pages -- Vinext uses ordinary links for standalone pages. */

import { BookOpen, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RagChunk, RagStatus } from '@/lib/rag-types';

async function api<T>(
  path = '',
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/rag${path}`, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(payload.error ?? 'Не удалось выполнить операцию.');
  return payload as T;
}

function ChunkCard({ chunk }: { chunk: RagChunk }) {
  return (
    <details className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <summary className="cursor-pointer space-y-1 text-sm text-white/85">
        <span className="break-all font-medium">
          {chunk.source}:{chunk.start_line}–{chunk.end_line}
        </span>
        <span className="ml-3 text-xs text-emerald-200">
          {chunk.token_count} токенов
          {chunk.score === undefined
            ? ''
            : ` · сходство ${chunk.score.toFixed(3)}`}
        </span>
        <span className="block truncate text-xs text-white/45">
          {chunk.section}
        </span>
      </summary>
      <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-white/70">
        {chunk.text}
      </pre>
      <p className="mt-3 break-all text-[10px] text-white/35">
        chunk_id: {chunk.chunk_id}
      </p>
    </details>
  );
}

export function KnowledgeBaseView() {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [strategy, setStrategy] = useState('structure');
  const [source, setSource] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{
    chunks: RagChunk[];
    total: number;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RagChunk[] | null>(null);
  const [busy, setBusy] = useState(false);
  const buildId = status?.current?.build_id;
  const running = status?.job.status === 'running';

  useEffect(() => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api<RagStatus>('', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setError('');
        if (next.job.status === 'running')
          timeout = setTimeout(() => void load(), 1500);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Ошибка загрузки.');
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [refresh]);

  useEffect(() => {
    if (!buildId) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      view: 'chunks',
      strategy,
      source,
      offset: String(offset),
    });
    void api<{ chunks: RagChunk[]; total: number }>(
      `?${parameters}`,
      undefined,
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setPage(next);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [buildId, strategy, source, offset]);

  const run = async (action: 'index' | 'compare') => {
    setBusy(true);
    setError('');
    try {
      await api('', { action });
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка запуска.');
    } finally {
      setBusy(false);
    }
  };

  const search = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    setHits(null);
    try {
      setHits(
        (
          await api<{ hits: RagChunk[] }>('', {
            action: 'search',
            query,
            strategy,
          })
        ).hits,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка поиска.');
    } finally {
      setBusy(false);
    }
  };

  const documents =
    status?.current?.strategies[0].documents ?? status?.documents ?? [];
  const disabled = busy || running || !status;
  const selectClass =
    'min-h-10 max-w-full rounded-lg border border-white/15 bg-[#18201f] px-3 text-sm text-white/85';

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="chat-header shrink-0">
        <div className="flex items-center gap-3">
          <span className="brand-mark">
            <BookOpen className="size-[18px]" />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white">База знаний</h1>
            <p className="text-xs text-white/40">
              День 21 · Индексация документов
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          aria-label="Обновить состояние индекса"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
        <div className="space-y-3">
          <p className="max-w-3xl text-sm leading-6 text-white/60">
            Документация и исходники проекта. Просматривайте чанки, проверяйте
            поиск и сравнивайте ответы модели с найденным контекстом и без него.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={disabled} onClick={() => void run('index')}>
              {status?.current ? 'Перестроить индексы' : 'Построить индексы'}
            </Button>
            <Button
              variant="outline"
              disabled={disabled || !status?.current}
              onClick={() => void run('compare')}
            >
              Сравнить стратегии
            </Button>
          </div>
          {!status && !error ? (
            <output className="text-sm text-white/50">
              Загружаю состояние…
            </output>
          ) : null}
          {status && !status.current ? (
            <p className="text-sm text-white/55">
              Индекса ещё нет. Для первого запуска подготовьте локальную модель:{' '}
              <code>pnpm rag:ollama</code>, затем <code>pnpm rag:setup</code>.
            </p>
          ) : null}
          {status?.current ? (
            <p className="text-xs text-white/45">
              {status.current.strategies[0].embedding.model} ·{' '}
              {status.current.strategies[0].dimensions} измерений · Обновлён{' '}
              {new Date(status.current.created_at).toLocaleString('ru-RU')}
            </p>
          ) : null}
          {status?.stale ? (
            <output className="text-sm text-amber-200">
              Исходники изменились после индексации. Перестройте индексы, чтобы
              искать по актуальной версии.
            </output>
          ) : null}
          {running ? (
            <output className="text-sm text-emerald-200">
              {status.job.action === 'index' ? 'Индексация' : 'Сравнение'}…{' '}
              {status.job.progress
                ? `${status.job.progress.strategy}: ${status.job.progress.completed}/${status.job.progress.total}`
                : 'Подготовка модели'}
            </output>
          ) : null}
          {status?.job.status === 'completed' ? (
            <output className="text-sm text-emerald-200">
              {status.job.action === 'index'
                ? 'Индексы построены.'
                : 'Сравнение завершено.'}
            </output>
          ) : null}
          {error || status?.job.error ? (
            <p
              role="alert"
              className="rounded-lg border border-red-300/20 bg-red-300/5 p-3 text-sm text-red-200"
            >
              {error || status?.job.error}
            </p>
          ) : null}
        </div>

        <a
          href="/rag-comparison"
          className="block rounded-xl border border-emerald-300/20 bg-emerald-300/[0.035] p-4 text-sm text-emerald-200 hover:bg-emerald-300/10"
        >
          День 22 · Сравнение RAG — 10 вопросов, ответы с RAG и без RAG в
          таблице →
        </a>

        <details className="rounded-xl border border-white/10 p-4">
          <summary className="cursor-pointer text-sm font-medium text-white/80">
            Документы · {documents.length} файлов ·{' '}
            {documents
              .reduce((sum, item) => sum + item.lines, 0)
              .toLocaleString('ru-RU')}{' '}
            строк
          </summary>
          <ul className="mt-3 max-h-64 space-y-2 overflow-auto text-xs text-white/55">
            {documents.map((document) => (
              <li
                key={document.source}
                className="flex flex-wrap justify-between gap-2"
              >
                <span className="break-all">{document.source}</span>
                <span>
                  {document.lines} строк ·{' '}
                  {document.characters.toLocaleString('ru-RU')} символов
                </span>
              </li>
            ))}
          </ul>
        </details>

        {status?.current ? (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-white">
              Стратегии разбиения
            </h2>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full whitespace-nowrap text-left text-xs text-white/65">
                <thead className="bg-white/5 text-white/85">
                  <tr>
                    {[
                      'Стратегия',
                      'Чанки',
                      'Токены min / med / max',
                      'Повтор текста',
                      'Размер',
                      'Время',
                      'Hit@5',
                      'MRR@5',
                    ].map((label) => (
                      <th className="p-3 font-medium" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {status.current.strategies.map((item) => {
                    const comparison = status.comparison?.rows.find(
                      (row) => row.strategy === item.strategy.id,
                    );
                    return (
                      <tr
                        className="border-t border-white/5"
                        key={item.strategy.id}
                      >
                        <td className="p-3 text-white/85">
                          {item.strategy.label}
                          <span className="block text-[10px] text-white/40">
                            до {item.strategy.size} · overlap{' '}
                            {item.strategy.overlap}
                          </span>
                        </td>
                        <td className="p-3">{item.stats.chunks}</td>
                        <td className="p-3">
                          {item.stats.min_tokens} / {item.stats.median_tokens} /{' '}
                          {item.stats.max_tokens}
                        </td>
                        <td className="p-3">
                          {(item.stats.duplicate_character_ratio * 100).toFixed(
                            1,
                          )}
                          %
                        </td>
                        <td className="p-3">
                          {(item.index_bytes / 1e6).toFixed(2)} МБ
                        </td>
                        <td className="p-3">
                          {(item.stats.elapsed_ms / 1000).toFixed(1)} с
                          <span className="block text-[10px] text-white/40">
                            кеш: {item.stats.cache_hits}
                          </span>
                        </td>
                        <td className="p-3">
                          {comparison
                            ? `${(comparison.hit_at_5 * 100).toFixed(1)}%`
                            : '—'}
                        </td>
                        <td className="p-3">
                          {comparison?.mrr_at_5.toFixed(3) ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs leading-5 text-white/45">
              Hit@5 — доля вопросов с ответом среди пяти фрагментов. MRR@5
              учитывает позицию первого ответа. Время включает прогрев модели и
              использование кеша.
            </p>
            {status.comparison ? (
              <details className="text-xs text-white/65">
                <summary className="cursor-pointer">
                  Проверочные вопросы · {status.comparison.question_count}
                </summary>
                <div className="mt-3 space-y-3">
                  {status.comparison.rows[0].results.map((result, i) => (
                    <div key={result.id}>
                      <p className="text-white/85">{result.question}</p>
                      <p className="mt-1">
                        {status.comparison?.rows
                          .map(
                            (row) =>
                              `${row.label}: ${row.results[i].rank ? `позиция ${row.results[i].rank}` : 'нет в top-5'}`,
                          )
                          .join(' · ')}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {status?.current ? (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-white">
              Поиск и просмотр чанков
            </h2>
            <label className="flex flex-wrap items-center gap-3 text-xs text-white/60">
              Стратегия
              <select
                className={selectClass}
                value={strategy}
                disabled={busy}
                onChange={(event) => {
                  setStrategy(event.target.value);
                  setOffset(0);
                  setPage(null);
                  setHits(null);
                }}
              >
                {status.strategies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <form onSubmit={search} className="flex gap-2">
              <Input
                aria-label="Вопрос к документам"
                placeholder="Как сохраняется память агента?"
                value={query}
                maxLength={2000}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 border-white/15 bg-white/[0.03] text-white"
              />
              <Button type="submit" disabled={disabled || !query.trim()}>
                <Search className="size-4" />
                <span className="hidden sm:inline">Найти</span>
              </Button>
            </form>
            {busy ? (
              <output className="text-xs text-white/50">
                Выполняю запрос…
              </output>
            ) : null}
            {hits ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs text-emerald-200">
                    Результаты поиска · top-{hits.length}
                  </h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHits(null)}
                  >
                    Закрыть результаты
                  </Button>
                </div>
                {hits.map((chunk) => (
                  <ChunkCard key={chunk.chunk_id} chunk={chunk} />
                ))}
              </div>
            ) : null}
            <label className="flex flex-wrap items-center gap-3 text-xs text-white/60">
              Просмотр файла
              <select
                className={selectClass}
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setOffset(0);
                  setPage(null);
                }}
              >
                <option value="">Все документы</option>
                {documents.map((document) => (
                  <option key={document.source} value={document.source}>
                    {document.source}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-3">
              {page?.chunks.map((chunk) => (
                <ChunkCard key={chunk.chunk_id} chunk={chunk} />
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-white/50">
              <Button
                variant="outline"
                size="sm"
                disabled={!page || offset === 0}
                onClick={() => {
                  setOffset((value) => Math.max(0, value - 20));
                  setPage(null);
                }}
              >
                Назад
              </Button>
              <span>
                {page
                  ? `${page.total ? offset + 1 : 0}–${Math.min(offset + 20, page.total)} из ${page.total}`
                  : 'Загрузка чанков…'}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={!page || offset + 20 >= page.total}
                onClick={() => {
                  setOffset((value) => value + 20);
                  setPage(null);
                }}
              >
                Далее
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
