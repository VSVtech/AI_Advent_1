'use client';
import {
  DEFAULT_RAG_SEARCH,
  isRagSearchOptions,
} from '@/scripts/rag/relevance.mjs';
import { RagSearchSettings } from '@/components/rag-search-settings';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownMessage } from '@/components/markdown-message';
import { RagSources } from '@/components/rag-sources';
import {
  COMPARISON_STORAGE_KEY,
  comparisonControl,
  type ComparisonSuite,
  importComparisonReport,
  type ComparisonAnswer,
} from '@/lib/rag-comparison';
import {
  UNIFIED_STORAGE_KEY,
  LEGACY_UNIFIED_STORAGE_KEY,
  COMPARISON_MODES,
  emptyUnified,
  restoreUnified,
  migrateComparison,
  latestLegacyComparison,
  runUnifiedComparison,
  type UnifiedRun,
} from '@/lib/rag-unified-comparison';

function AnswerCell({
  answer,
  busy,
}: {
  answer: ComparisonAnswer;
  busy: boolean;
}) {
  return (
    <>
      <p
        className={`mb-2 text-xs ${answer.status === 'error' || answer.status === 'stopped' ? 'text-amber-200' : 'text-emerald-200/70'}`}
      >
        {
          {
            idle: busy ? 'В очереди' : 'Не запущен',
            running: 'Получаю ответ…',
            done: 'Готово',
            error: 'Ошибка',
            stopped: 'Остановлен',
          }[answer.status]
        }
      </p>
      {answer.answer ? (
        <div className="break-words text-sm leading-6">
          <MarkdownMessage content={answer.answer} />
        </div>
      ) : null}
      {answer.error ? (
        <p className="mt-2 text-xs text-amber-200">{answer.error}</p>
      ) : null}
      {answer.rag ? <RagSources retrieval={answer.rag} /> : null}
    </>
  );
}

export function RagAnswerComparison() {
  const storageKey = UNIFIED_STORAGE_KEY;
  const [options, setOptions] = useState({ ...DEFAULT_RAG_SEARCH });
  const [run, setRun] = useState<UnifiedRun>(() => emptyUnified());
  const [suite, setSuite] = useState<ComparisonSuite>('legacy');
  const control = comparisonControl(run.suite);
  const runRef = useRef(run);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  const update = (change: (previous: UnifiedRun) => UnifiedRun) => {
    const next = change(runRef.current);
    runRef.current = next;
    setRun(next);
  };

  useEffect(() => {
    let active = true;
    let restored = false;
    const timer = window.setTimeout(() => {
      try {
        const raw =
          window.localStorage.getItem(storageKey) ??
          window.localStorage.getItem(LEGACY_UNIFIED_STORAGE_KEY);
        const saved = raw
          ? restoreUnified(JSON.parse(raw))
          : latestLegacyComparison(
              [COMPARISON_STORAGE_KEY, COMPARISON_STORAGE_KEY + '-filter'].map(
                (key) => {
                  try {
                    return JSON.parse(
                      window.localStorage.getItem(key) ?? 'null',
                    );
                  } catch {
                    return null;
                  }
                },
              ),
            );
        if (saved) {
          runRef.current = saved;
          setRun(saved);
          setSuite(saved.suite);
          setOptions({ ...DEFAULT_RAG_SEARCH, ...saved.options });
        } else if (raw)
          setError(
            'Сохранённый прогон повреждён или набор вопросов изменился. Можно запустить новый.',
          );
      } catch {
        setSaveError('Не удалось прочитать сохранённый прогон в браузере.');
      }
      restored = true;
      if (active) setLoaded(true);
    }, 0);
    const persist = () => {
      if (!restored) return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(runRef.current));
      } catch {
        if (active)
          setSaveError(
            'Не удалось сохранить результаты в браузере. Не закрывайте страницу, пока они нужны.',
          );
      }
    };
    const stop = () => controllerRef.current?.abort();
    window.addEventListener('pagehide', stop);
    window.addEventListener('pagehide', persist);
    return () => {
      active = false;
      window.clearTimeout(timer);
      stop();
      persist();
      controllerRef.current = null;
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pagehide', persist);
    };
  }, [storageKey]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(runRef.current));
        setSaveError('');
      } catch {
        setSaveError(
          'Не удалось сохранить результаты в браузере. Не закрывайте страницу, пока они нужны.',
        );
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [run, loaded, storageKey]);

  const start = async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/rag', {
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      });
      const payload = (await response.json()) as {
        error?: string;
        current?: { build_id?: unknown };
      };
      if (!response.ok)
        throw new Error(payload.error ?? 'Не удалось открыть индекс.');
      const buildId = payload.current?.build_id;
      if (typeof buildId !== 'string' || !/^[\w-]{1,100}$/.test(buildId))
        throw new Error(
          'Индекс не создан. Откройте базу знаний и постройте индекс.',
        );
      if (controller.signal.aborted) return;
      update(() => ({
        ...emptyUnified(suite, options),
        startedAt: new Date().toISOString(),
        buildId,
      }));
      await runUnifiedComparison({
        suite,
        options: { ...options },
        buildId,
        signal: controller.signal,
        onAnswer: (id, mode, answer) => {
          if (controllerRef.current !== controller) return;
          update((previous) => ({
            ...previous,
            rows: previous.rows.map((row) =>
              row.id === id ? { ...row, [mode]: answer } : row,
            ),
          }));
        },
      });
    } catch (cause) {
      if (controllerRef.current === controller)
        setError(
          controller.signal.aborted
            ? 'Прогон остановлен.'
            : cause instanceof Error
              ? cause.message
              : 'Ошибка запуска.',
        );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  };

  const loadReport = async (view: 'answers' | 'enhanced-answers') => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setImporting(true);
    setError('');
    try {
      const response = await fetch(`/api/rag?view=${view}`, {
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error ?? 'Нет сохранённого отчёта.');
      const imported = importComparisonReport(payload);
      const saved = imported ? migrateComparison(imported) : null;
      if (!saved)
        throw new Error(
          'Отчёт повреждён или не соответствует контрольным вопросам.',
        );
      if (!controller.signal.aborted) {
        update(() => saved);
        setSuite(saved.suite ?? 'legacy');
        if (saved.options)
          setOptions({ ...DEFAULT_RAG_SEARCH, ...saved.options });
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Ошибка загрузки.');
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setImporting(false);
      }
    }
  };

  const answers = run.rows.flatMap((row) =>
    COMPARISON_MODES.map((mode) => row[mode]),
  );
  const completed = answers.filter((answer) => answer.status === 'done').length;
  const failed = answers.filter((answer) => answer.status === 'error').length;
  const locked = !loaded || busy || importing || !isRagSearchOptions(options);

  return (
    <div className="flex flex-col">
      <div className="shrink-0 space-y-3 px-5 py-4">
        <>
          <label className="flex items-center gap-3 text-xs text-white/70">
            Набор вопросов
            <select
              aria-label="Набор вопросов"
              value={suite}
              disabled={busy || importing || !loaded}
              className="rounded border border-white/15 bg-[#18201f] p-2"
              onChange={(event) => {
                const next = event.target.value as ComparisonSuite;
                setSuite(next);
                update(() => emptyUnified(next, options));
              }}
            >
              <option value="legacy">Исходные 10 — регрессия</option>
              <option value="dev">Новые 10 — настройка</option>
              <option value="test">Новые 10 — отложенная проверка</option>
            </select>
          </label>
          <RagSearchSettings
            value={options}
            onChange={setOptions}
            disabled={busy || importing || !loaded}
          />
          <p className="text-xs text-white/50">
            Второй столбец — RAG дня 22: исходный вопрос, поиск top-5 по
            стратегии overlap, контекст до 18 000 символов. Настройки выше
            действуют только на третий столбец. Оба режима RAG используют один
            снимок индекса; исходный вопрос модели не меняется.
          </p>
          {!isRagSearchOptions(options) ? (
            <p role="alert" className="text-xs text-amber-200">
              До: 1–50, после: 1–10 и не больше «до»; порог реранкера: 0–1,
              similarity: −1–1.
            </p>
          ) : null}
          {run.rows.some((row) => row.enhanced.status !== 'idle') ? (
            <p className="text-xs text-white/40">
              Третий столбец, настройки показанного прогона: top-K{' '}
              {run.options.topKBefore} → {run.options.topKAfter}; порог{' '}
              {run.options.rerank
                ? run.options.minRerankScore
                : run.options.minSimilarity}{' '}
              ({run.options.rerank ? 'reranker' : 'similarity'}); фильтр{' '}
              {run.options.filter ? 'вкл' : 'выкл'}; rewrite{' '}
              {run.options.rewrite ? 'вкл' : 'выкл'}; цитаты{' '}
              {run.options.verifyEvidence ? 'вкл' : 'выкл'}; дедупликация{' '}
              {run.options.deduplicate ? 'вкл' : 'выкл'}.
            </p>
          ) : null}
        </>
        <p className="text-sm leading-6 text-white/60">
          10 вопросов · {control.model} · температура 0. Три независимых ответа
          на вопрос, без истории, памяти, профиля и MCP.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={locked} onClick={() => void start()}>
            Запустить 10 вопросов
          </Button>
          {busy ? (
            <Button
              variant="outline"
              onClick={() => controllerRef.current?.abort()}
            >
              Остановить
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => void loadReport('answers')}
          >
            Отчёт без/с RAG
          </Button>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => void loadReport('enhanced-answers')}
          >
            Отчёт с обработкой
          </Button>
          <output className="text-xs text-emerald-200" aria-live="polite">
            {importing
              ? 'Загружаю отчёт…'
              : `${completed}/30 ответов готовы${failed ? ` · ошибок: ${failed}` : ''}${busy ? ' · выполняется прогон' : ''}`}
          </output>
        </div>
        <p className="text-xs leading-5 text-white/45">
          Запуск отправляет 30 запросов в DeepSeek, включая найденные фрагменты
          проекта для RAG. Новый прогон заменяет ответы. Результаты сохраняются
          в этом браузере; при уходе со страницы запросы останавливаются. В
          старых отчётах отсутствующий третий режим остаётся незапущенным.
        </p>
        {run.startedAt ? (
          <p className="break-all text-xs text-white/40">
            Прогон от {new Date(run.startedAt).toLocaleString('ru-RU')} · индекс{' '}
            {run.buildId}
          </p>
        ) : null}
        {error || saveError ? (
          <p role="alert" className="text-sm text-amber-200">
            {error || saveError}
          </p>
        ) : null}
      </div>
      <section
        className="border-t border-white/10"
        aria-label="Таблица сравнения ответов"
      >
        <table className="w-full min-w-[900px] table-fixed border-collapse text-left">
          <caption className="sr-only">
            Три режима ответа на 10 контрольных вопросов
          </caption>
          <colgroup>
            <col className="w-1/3" />
            <col className="w-1/3" />
            <col className="w-1/3" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[#182425] text-sm text-white">
            <tr>
              {['Без RAG', 'С RAG · день 22', 'С RAG + обработка'].map(
                (title) => (
                  <th
                    key={title}
                    scope="col"
                    className="border-b border-white/10 px-4 py-3 font-medium"
                  >
                    {title}
                  </th>
                ),
              )}
            </tr>
          </thead>
          {run.rows.map((row, index) => {
            const question = control.questions[index];
            return (
              <tbody key={row.id} aria-label={`Вопрос ${index + 1}`}>
                <tr className="bg-white/[0.035]">
                  <th
                    scope="rowgroup"
                    colSpan={3}
                    className="p-4 text-sm font-normal leading-6 text-white/85"
                  >
                    <span className="mb-2 block text-xs text-emerald-200/60">
                      {index + 1} / 10
                    </span>
                    {question.question}
                    <details className="mt-3 text-xs text-white/55">
                      <summary className="cursor-pointer">
                        Что проверяем
                      </summary>
                      <ul className="mt-2 list-disc space-y-1 pl-4">
                        {question.expected.map((fact) => (
                          <li key={fact}>{fact}</li>
                        ))}
                      </ul>
                      <p className="mt-2 break-words">
                        Источники:{' '}
                        {question.expected_sources.join(', ') ||
                          'нет ответа в базе'}
                      </p>
                    </details>
                  </th>
                </tr>
                <tr className="border-b border-white/10 align-top">
                  {COMPARISON_MODES.map((mode) => (
                    <td
                      key={mode}
                      className="border-l border-white/5 p-4 first:border-l-0"
                    >
                      <AnswerCell answer={row[mode]} busy={busy} />
                    </td>
                  ))}
                </tr>
              </tbody>
            );
          })}
        </table>
      </section>
    </div>
  );
}
