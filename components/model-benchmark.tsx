'use client';

import { ChevronDown, Play, Square } from 'lucide-react';
import {
  Fragment,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { SectionHeader } from '@/components/section-header';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { useAvailableModels } from '@/hooks/use-available-models';
import {
  BENCHMARK_MAX_OUTPUT_TOKENS,
  BENCHMARK_MAX_PROMPT_LENGTH,
  type BenchmarkResponsePayload,
} from '@/lib/benchmark';
import { formatModelLabel } from '@/lib/chat-constraints';
import type { ChatErrorPayload } from '@/lib/chat-types';
import { estimateCostUsd } from '@/lib/model-pricing';

type RowStatus = 'running' | 'complete' | 'error' | 'stopped';

interface Row {
  model: string;
  status: RowStatus;
  latencyMs?: number;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  answer?: string;
  error?: string;
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} с` : `${ms} мс`;
}

function formatTokens(tokens: number | null | undefined): string {
  return typeof tokens === 'number' ? tokens.toLocaleString('ru-RU') : '—';
}

function formatCost(cost: number | null): string {
  if (cost === null) return '—';
  if (cost === 0) return '$0';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(3)}`;
}

const statusLabel: Record<RowStatus, string> = {
  running: 'Генерация…',
  complete: 'Готово',
  stopped: 'Остановлено',
  error: 'Ошибка',
};

export function ModelBenchmark() {
  const { models, error: modelsError } = useAvailableModels();
  const [prompt, setPrompt] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<{
    id: string;
    controllers: Map<string, AbortController>;
  } | null>(null);

  useEffect(
    () => () => {
      runRef.current?.controllers.forEach((controller) => controller.abort());
    },
    [],
  );

  const stop = () =>
    runRef.current?.controllers.forEach((controller) => controller.abort());

  const clear = () => {
    stop();
    runRef.current = null;
    setIsRunning(false);
    setRows([]);
    setPrompt('');
    setError(null);
  };

  const run = async () => {
    const trimmedPrompt = prompt.trim();
    if (runRef.current || !trimmedPrompt || models.length === 0) return;
    if (prompt.length > BENCHMARK_MAX_PROMPT_LENGTH) {
      setError(
        `Промпт не должен превышать ${BENCHMARK_MAX_PROMPT_LENGTH} символов.`,
      );
      return;
    }

    const id = crypto.randomUUID();
    const controllers = new Map(
      models.map((model) => [model, new AbortController()] as const),
    );
    runRef.current = { id, controllers };
    setIsRunning(true);
    setError(null);
    setRows(models.map((model) => ({ model, status: 'running' })));

    const update = (model: string, apply: (row: Row) => Row) => {
      if (runRef.current?.id !== id) return;
      setRows((current) =>
        current.map((row) => (row.model === model ? apply(row) : row)),
      );
    };

    await Promise.all(
      models.map(async (model) => {
        const controller = controllers.get(model);
        if (!controller) return;

        try {
          const response = await fetch('/api/benchmark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: trimmedPrompt }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const payload = (await response
              .json()
              .catch(() => null)) as ChatErrorPayload | null;
            throw new Error(
              payload?.error.message ??
                'Не удалось получить ответ от DeepSeek.',
            );
          }

          const payload = (await response.json()) as BenchmarkResponsePayload;

          update(model, (row) => ({
            ...row,
            status: 'complete',
            latencyMs: payload.latencyMs,
            inputTokens: payload.inputTokens,
            cachedInputTokens: payload.cachedInputTokens,
            outputTokens: payload.outputTokens,
            answer: payload.answer,
          }));
        } catch (caught) {
          update(model, (row) => ({
            ...row,
            status: controller.signal.aborted ? 'stopped' : 'error',
            error: controller.signal.aborted
              ? undefined
              : caught instanceof Error
                ? caught.message
                : 'Не удалось получить ответ от DeepSeek.',
          }));
        }
      }),
    );

    if (runRef.current?.id === id) {
      runRef.current = null;
      setIsRunning(false);
    }
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run();
  };

  const completedLatencies = rows
    .filter(
      (row): row is Row & { latencyMs: number } =>
        row.status === 'complete' && typeof row.latencyMs === 'number',
    )
    .map((row) => row.latencyMs);
  const minLatency =
    completedLatencies.length > 0 ? Math.min(...completedLatencies) : null;
  const fastestModel =
    minLatency === null
      ? null
      : (rows.find((row) => row.latencyMs === minLatency)?.model ?? null);

  return (
    <div className="comparison-frame">
      <SectionHeader
        title="Бенчмарк"
        subtitle="одна задача — все модели"
        clearLabel="Очистить бенчмарк"
        canClear={rows.length > 0}
        onClear={clear}
      />
      <form className="comparison-composer" onSubmit={onSubmit}>
        <label className="format-label" htmlFor="benchmark-prompt">
          Промпт для всех моделей
        </label>
        <div className="comparison-composer-row">
          <Textarea
            id="benchmark-prompt"
            value={prompt}
            rows={2}
            maxLength={BENCHMARK_MAX_PROMPT_LENGTH}
            placeholder="Введите задачу, чтобы сравнить модели…"
            onChange={(event) => setPrompt(event.target.value)}
            className="comparison-user-input"
            aria-describedby="benchmark-hint"
          />
          {isRunning ? (
            <Button type="button" onClick={stop} variant="secondary">
              <Square className="size-3 fill-current" />
              Остановить
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!prompt.trim() || models.length === 0}
            >
              <Play className="size-4" />
              Запустить
            </Button>
          )}
        </div>
        <p id="benchmark-hint" className="comparison-hint">
          Один запуск — по одному запросу на каждую из {models.length} доступных
          моделей, без системного промпта и истории. Лимит ответа:{' '}
          {BENCHMARK_MAX_OUTPUT_TOKENS} токенов. Стоимость — оценка по публичным
          ценам DeepSeek на известные модели, может отличаться от фактической.
        </p>
        {modelsError ? <p className="comparison-hint">{modelsError}</p> : null}
        {error ? (
          <p className="comparison-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      <section
        className="benchmark-table-wrap"
        aria-label="Результаты по моделям"
      >
        {rows.length === 0 ? (
          <p className="comparison-placeholder px-4">
            Введите задачу выше и нажмите «Запустить», чтобы сравнить модели.
          </p>
        ) : (
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>Модель</th>
                <th>Статус</th>
                <th>Время ответа</th>
                <th>Входные токены</th>
                <th>Выходные токены</th>
                <th>Оценка стоимости</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cost = estimateCostUsd(
                  row.model,
                  row.inputTokens ?? null,
                  row.cachedInputTokens ?? null,
                  row.outputTokens ?? null,
                );

                return (
                  <Fragment key={row.model}>
                    <tr
                      className={
                        row.model === fastestModel
                          ? 'benchmark-row-fastest'
                          : undefined
                      }
                    >
                      <td>{formatModelLabel(row.model)}</td>
                      <td>{statusLabel[row.status]}</td>
                      <td>
                        {typeof row.latencyMs === 'number'
                          ? formatLatency(row.latencyMs)
                          : '—'}
                      </td>
                      <td>{formatTokens(row.inputTokens)}</td>
                      <td>{formatTokens(row.outputTokens)}</td>
                      <td>{formatCost(cost)}</td>
                    </tr>
                    {row.error ? (
                      <tr>
                        <td colSpan={6} className="comparison-error">
                          <p role="alert">{row.error}</p>
                        </td>
                      </tr>
                    ) : null}
                    {row.answer ? (
                      <tr>
                        <td
                          colSpan={6}
                          aria-label={`Ответ модели ${formatModelLabel(row.model)}`}
                        >
                          <Collapsible className="comparison-prompt-details">
                            <CollapsibleTrigger className="comparison-prompt-trigger">
                              Ответ
                              <ChevronDown
                                className="size-3"
                                aria-hidden="true"
                              />
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <p className="whitespace-pre-wrap break-words pt-2 text-xs leading-5 text-white/65">
                                {row.answer}
                              </p>
                            </CollapsibleContent>
                          </Collapsible>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
