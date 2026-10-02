'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownMessage } from '@/components/markdown-message';
import { RagSources } from '@/components/rag-sources';
import {
  COMPARISON_STORAGE_KEY,
  emptyComparison,
  restoreComparison,
  importComparisonReport,
  runComparison,
  type ComparisonAnswer,
  type ComparisonRun,
} from '@/lib/rag-comparison';
import control from '@/rag/answer-questions.json';

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
        <div className="max-h-[32rem] overflow-auto break-words text-sm leading-6">
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
  const [run, setRun] = useState<ComparisonRun>(emptyComparison);
  const runRef = useRef(run);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  const update = (change: (previous: ComparisonRun) => ComparisonRun) => {
    const next = change(runRef.current);
    runRef.current = next;
    setRun(next);
  };

  useEffect(() => {
    let active = true;
    let restored = false;
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COMPARISON_STORAGE_KEY);
        if (raw) {
          const saved = restoreComparison(JSON.parse(raw));
          if (saved) {
            runRef.current = saved;
            setRun(saved);
          } else
            setError(
              'Сохранённый прогон повреждён или набор вопросов изменился. Можно запустить новый.',
            );
        }
      } catch {
        setSaveError('Не удалось прочитать сохранённый прогон в браузере.');
      }
      restored = true;
      if (active) setLoaded(true);
    }, 0);
    const persist = () => {
      if (!restored) return;
      try {
        window.localStorage.setItem(
          COMPARISON_STORAGE_KEY,
          JSON.stringify(runRef.current),
        );
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
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          COMPARISON_STORAGE_KEY,
          JSON.stringify(runRef.current),
        );
        setSaveError('');
      } catch {
        setSaveError(
          'Не удалось сохранить результаты в браузере. Не закрывайте страницу, пока они нужны.',
        );
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [run, loaded]);

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
        ...emptyComparison(),
        startedAt: new Date().toISOString(),
        buildId,
      }));
      await runComparison({
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

  const loadReport = async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setImporting(true);
    setError('');
    try {
      const response = await fetch('/api/rag?view=answers', {
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15_000),
        ]),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error ?? 'Нет сохранённого отчёта.');
      const saved = importComparisonReport(payload);
      if (!saved)
        throw new Error(
          'Отчёт повреждён или не соответствует контрольным вопросам.',
        );
      if (!controller.signal.aborted) update(() => saved);
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

  const answers = run.rows.flatMap((row) => [row.baseline, row.rag]);
  const completed = answers.filter((answer) => answer.status === 'done').length;
  const failed = answers.filter((answer) => answer.status === 'error').length;
  const locked = !loaded || busy || importing;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 px-5 py-4">
        <p className="text-sm leading-6 text-white/60">
          10 вопросов · {control.model} · температура 0. Два независимых ответа
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
            onClick={() => void loadReport()}
          >
            Загрузить отчёт из CLI
          </Button>
          <output className="text-xs text-emerald-200" aria-live="polite">
            {importing
              ? 'Загружаю отчёт…'
              : `${completed}/20 ответов готовы${failed ? ` · ошибок: ${failed}` : ''}${busy ? ' · выполняется прогон' : ''}`}
          </output>
        </div>
        <p className="text-xs leading-5 text-white/45">
          Запуск отправляет 20 запросов в DeepSeek, включая найденные фрагменты
          проекта для RAG. Новый прогон заменяет ответы. Результаты сохраняются
          в этом браузере; при уходе со страницы запросы останавливаются.
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
        className="min-h-0 flex-1 overflow-auto border-t border-white/10"
        aria-label="Таблица сравнения ответов"
      >
        <table className="w-full min-w-[900px] table-fixed border-collapse text-left">
          <caption className="sr-only">
            Сравнение ответов на 10 контрольных вопросов с RAG и без RAG
          </caption>
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[37%]" />
            <col className="w-[37%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[#182425] text-sm text-white">
            <tr>
              {['Вопрос', 'Без RAG', 'С RAG'].map((title) => (
                <th
                  key={title}
                  scope="col"
                  className="border-b border-white/10 px-4 py-3 font-medium"
                >
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row, index) => {
              const question = control.questions[index];
              return (
                <tr
                  key={row.id}
                  className="border-b border-white/10 align-top even:bg-white/[0.02]"
                >
                  <th
                    scope="row"
                    className="p-4 text-sm font-normal leading-6 text-white/85"
                  >
                    <span className="mb-2 block text-xs text-emerald-200/60">
                      {index + 1} / 10
                    </span>
                    {question.question}
                  </th>
                  <td className="border-l border-white/5 p-4">
                    <AnswerCell answer={row.baseline} busy={busy} />
                  </td>
                  <td className="border-l border-white/5 p-4">
                    <AnswerCell answer={row.rag} busy={busy} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
