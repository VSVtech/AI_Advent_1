import extended from '@/rag/extended-questions.json';
import {
  isRagSearchOptions,
  type RagSearchOptions,
} from '@/scripts/rag/relevance.mjs';
import control from '@/rag/answer-questions.json';
import type { ChatRequest } from '@/lib/chat-types';
import { readChatStream } from '@/lib/read-chat-stream';
import { restoreRagRetrieval, type RagRetrieval } from '@/lib/rag-context';

export type ComparisonSuite = 'legacy' | 'dev' | 'test';
export function comparisonControl(suite: ComparisonSuite = 'legacy') {
  return suite === 'legacy'
    ? control
    : {
        ...control,
        questions: extended.questions.filter((q) => q.split === suite),
      };
}

export const COMPARISON_STORAGE_KEY = 'deepseek-rag-comparison-v1';
export type AnswerMode = 'baseline' | 'rag';
export type ComparisonAnswer = {
  status: 'idle' | 'running' | 'done' | 'error' | 'stopped';
  answer: string;
  rag: RagRetrieval | null;
  error?: string;
};
export type ComparisonRow = {
  id: string;
  baseline: ComparisonAnswer;
  rag: ComparisonAnswer;
  comment: string;
};
export type ComparisonRun = {
  version: 1;
  controls: string;
  startedAt: string | null;
  buildId: string | null;
  rows: ComparisonRow[];
  options?: RagSearchOptions;
  suite?: ComparisonSuite;
};
const blankAnswer = (): ComparisonAnswer => ({
  status: 'idle',
  answer: '',
  rag: null,
});
export const emptyComparison = (
  suite: ComparisonSuite = 'legacy',
): ComparisonRun => ({
  version: 1,
  controls: JSON.stringify(comparisonControl(suite)),
  ...(suite !== 'legacy' ? { suite } : {}),
  startedAt: null,
  buildId: null,
  rows: comparisonControl(suite).questions.map(({ id }) => ({
    id,
    baseline: blankAnswer(),
    rag: blankAnswer(),
    comment: '',
  })),
});

// Stored and imported answers are untrusted. Keep the fixed question order and
// never restore a pending network operation after a page reload.
export function restoreComparison(value: unknown): ComparisonRun | null {
  if (!value || typeof value !== 'object') return null;
  const run = value as ComparisonRun;
  if (run.suite !== undefined && !['legacy', 'dev', 'test'].includes(run.suite))
    return null;
  const selectedControl = comparisonControl(run.suite);
  if (run.options !== undefined && !isRagSearchOptions(run.options))
    return null;
  if (
    run.version !== 1 ||
    run.controls !== JSON.stringify(selectedControl) ||
    !Array.isArray(run.rows) ||
    run.rows.length !== selectedControl.questions.length ||
    (run.startedAt !== null && typeof run.startedAt !== 'string') ||
    (run.buildId !== null &&
      (typeof run.buildId !== 'string' || !/^[\w-]{1,100}$/.test(run.buildId)))
  )
    return null;
  const rows: ComparisonRow[] = [];
  for (const [index, row] of run.rows.entries()) {
    if (
      !row ||
      row.id !== selectedControl.questions[index].id ||
      typeof row.comment !== 'string' ||
      row.comment.length > 5000
    )
      return null;
    const answers = {} as Record<AnswerMode, ComparisonAnswer>;
    for (const mode of ['baseline', 'rag'] as const) {
      const item = row[mode];
      if (
        !item ||
        !['idle', 'running', 'done', 'error', 'stopped'].includes(
          item.status,
        ) ||
        typeof item.answer !== 'string' ||
        item.answer.length > 100_000 ||
        (item.error !== undefined && typeof item.error !== 'string')
      )
        return null;
      const rag = item.rag === null ? null : restoreRagRetrieval(item.rag);
      if (
        (item.rag !== null && !rag) ||
        (mode === 'baseline' && !run.options && rag) ||
        (rag && rag.build_id !== run.buildId) ||
        (item.status === 'done' &&
          (!item.answer.trim() || ((mode === 'rag' || run.options) && !rag)))
      )
        return null;
      answers[mode] = {
        ...item,
        rag,
        status: item.status === 'running' ? 'stopped' : item.status,
      };
    }
    rows.push({ id: row.id, comment: row.comment, ...answers });
  }
  return {
    version: 1,
    controls: run.controls,
    startedAt: run.startedAt,
    buildId: run.buildId,
    rows,
    ...(run.suite ? { suite: run.suite } : {}),
    ...(run.options ? { options: { ...run.options } } : {}),
  };
}

export function importComparisonReport(value: unknown): ComparisonRun | null {
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object';
  if (
    !isRecord(value) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== control.questions.length
  )
    return null;
  if (value.suite !== undefined && value.suite !== 'test') return null;
  const suite = value.suite === 'test' ? 'test' : 'legacy';
  if (suite === 'test' && !isRagSearchOptions(value.options)) return null;
  const selectedControl = comparisonControl(suite);
  const run = emptyComparison(suite);
  if (isRagSearchOptions(value.options)) run.options = { ...value.options };
  if (
    typeof value.build_id !== 'string' ||
    typeof value.created_at !== 'string'
  )
    return null;
  run.buildId = value.build_id;
  run.startedAt = value.created_at;
  for (const [i, item] of value.rows.entries()) {
    if (
      !isRecord(item) ||
      item.id !== run.rows[i].id ||
      item.question !== selectedControl.questions[i].question
    )
      return null;
    for (const mode of ['baseline', 'rag'] as const) {
      const answer = item[mode];
      if (!isRecord(answer) || typeof answer.answer !== 'string') return null;
      run.rows[i][mode] = {
        status: 'done',
        answer: answer.answer,
        rag: answer.rag as RagRetrieval | null,
      };
      if (
        isRecord(item.review) &&
        isRecord(item.review[mode]) &&
        typeof item.review[mode].notes === 'string'
      ) {
        run.rows[i].comment +=
          `${mode === 'rag' ? 'С RAG' : 'Без RAG'}: ${item.review[mode].notes}\n`;
      }
    }
  }
  return restoreComparison(run);
}

export async function runComparison({
  buildId,
  signal,
  onAnswer,
  fetcher = fetch,
  options,
  suite = 'legacy',
  onWithoutRag,
}: {
  buildId: string;
  signal: AbortSignal;
  onAnswer: (id: string, mode: AnswerMode, answer: ComparisonAnswer) => void;
  fetcher?: typeof fetch;
  options?: RagSearchOptions;
  suite?: ComparisonSuite;
  onWithoutRag?: (id: string, answer: ComparisonAnswer) => void;
}): Promise<void> {
  if (options && !isRagSearchOptions(options))
    throw new Error('Некорректные настройки сравнения.');
  for (const question of comparisonControl(suite).questions) {
    if (signal.aborted) break;
    // Each mode has a clean history; at most three requests are live.
    const modes: (AnswerMode | 'withoutRag')[] = onWithoutRag
      ? ['withoutRag', 'baseline', 'rag']
      : ['baseline', 'rag'];
    await Promise.allSettled(
      modes.map(async (mode) => {
        const useRag = mode === 'rag' || (mode === 'baseline' && !!options);
        let current: ComparisonAnswer = { ...blankAnswer(), status: 'running' };
        const publish = (patch: Partial<ComparisonAnswer>) => {
          current = { ...current, ...patch };
          if (mode === 'withoutRag') onWithoutRag?.(question.id, current);
          else onAnswer(question.id, mode, current);
        };
        publish({});
        try {
          const body: ChatRequest = {
            model: control.model,
            temperature: 0,
            format: 'text',
            targetOutputTokens: null,
            maxOutputTokens: 1400,
            contextWindowTokens: 64_000,
            useMcpTools: false,
            useSystemPrompt: true,
            useSelectorSystemPrompt: false,
            customSystemPrompt: control.system_prompt,
            messages: [{ role: 'user', content: question.question }],
            useRag,
            ...(useRag ? { ragBuildId: buildId } : {}),
            // Omission selects the original Day 22 search path (fixed top-5).
            ...(options && mode === 'rag' ? { ragSearch: { ...options } } : {}),
          };
          const response = await fetcher('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
          });
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            throw new Error(
              payload?.error?.message ??
                `Ошибка запроса: HTTP ${response.status}`,
            );
          }
          if (!response.body) throw new Error('Пустой ответ сервера.');
          let done = false;
          await readChatStream(response.body, (event) => {
            if (event.type === 'delta')
              publish({ answer: current.answer + event.content });
            if (event.type === 'rag') publish({ rag: event.retrieval });
            if (event.type === 'error') throw new Error(event.message);
            if (event.type === 'done') {
              if (event.finishReason === 'length')
                throw new Error('Достигнут лимит ответа; результат неполный.');
              done = true;
            }
          });
          if (signal.aborted) throw new Error('Прогон остановлен.');
          if (!done || !current.answer.trim())
            throw new Error('Ответ прерван или пуст.');
          if (useRag && current.rag?.build_id !== buildId)
            throw new Error('Сервер не подтвердил выбранный снимок RAG.');
          if (!useRag && current.rag)
            throw new Error('Обычный ответ неожиданно использовал RAG.');
          if (
            body.ragSearch &&
            (!current.rag?.processing ||
              Object.entries(body.ragSearch!).some(
                ([key, value]) =>
                  (
                    current.rag!.processing!.options as unknown as Record<
                      string,
                      unknown
                    >
                  )[key] !== value,
              ))
          )
            throw new Error('Сервер не подтвердил настройки поиска.');
          if (useRag && !body.ragSearch && current.rag?.processing)
            throw new Error('Вместо RAG дня 22 сервер применил обработку.');
          publish({ status: 'done' });
        } catch (error) {
          publish({
            status: signal.aborted ? 'stopped' : 'error',
            error: signal.aborted
              ? 'Прогон остановлен.'
              : error instanceof Error
                ? error.message
                : 'Ошибка запроса.',
          });
        }
      }),
    );
  }
}
