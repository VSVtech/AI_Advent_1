import {
  DEFAULT_RAG_SEARCH,
  isRagSearchOptions,
  type RagSearchOptions,
} from '@/scripts/rag/relevance.mjs';
import {
  comparisonControl,
  emptyComparison,
  restoreComparison,
  runComparison,
  type ComparisonAnswer,
  type ComparisonSuite,
} from '@/lib/rag-comparison';

export const LEGACY_UNIFIED_STORAGE_KEY = 'deepseek-rag-comparison-v2';
export const UNIFIED_STORAGE_KEY = 'deepseek-rag-comparison-v3';
export const COMPARISON_MODES = ['plain', 'rag', 'enhanced'] as const;
export type UnifiedMode = (typeof COMPARISON_MODES)[number];
export type UnifiedRun = {
  version: 3;
  suite: ComparisonSuite;
  controls: string;
  startedAt: string | null;
  buildId: string | null;
  options: RagSearchOptions;
  rows: ({ id: string } & Record<UnifiedMode, ComparisonAnswer>)[];
};
const blank = (): ComparisonAnswer => ({
  status: 'idle',
  answer: '',
  rag: null,
});
const outdatedBaseline = (): ComparisonAnswer => ({
  ...blank(),
  error:
    'Старый ответ получен другим пайплайном. Для RAG дня 22 нужен новый прогон.',
});
function day22Answer(answer: ComparisonAnswer): ComparisonAnswer {
  return answer.rag?.processing || (answer.answer && !answer.rag)
    ? outdatedBaseline()
    : answer;
}

export function emptyUnified(
  suite: ComparisonSuite = 'legacy',
  options: RagSearchOptions = DEFAULT_RAG_SEARCH,
): UnifiedRun {
  return {
    version: 3,
    suite,
    controls: JSON.stringify(comparisonControl(suite)),
    startedAt: null,
    buildId: null,
    options: { ...options },
    rows: comparisonControl(suite).questions.map(({ id }) => ({
      id,
      plain: blank(),
      rag: blank(),
      enhanced: blank(),
    })),
  };
}

// Preserve what each historical column actually meant. Never combine runs from
// different dates, question sets or index snapshots to fill an absent column.
export function migrateComparison(value: unknown): UnifiedRun | null {
  const old = restoreComparison(value);
  if (!old) return null;
  return {
    ...emptyUnified(old.suite, old.options),
    startedAt: old.startedAt,
    buildId: old.buildId,
    rows: old.rows.map((row) => ({
      id: row.id,
      plain: old.options ? blank() : row.baseline,
      rag: day22Answer(old.options ? row.baseline : row.rag),
      enhanced: old.options ? row.rag : blank(),
    })),
  };
}

export function restoreUnified(value: unknown): UnifiedRun | null {
  if (!value || typeof value !== 'object') return null;
  const run = value as Omit<UnifiedRun, 'version'> & { version: 2 | 3 };
  if (
    (run.version !== 2 && run.version !== 3) ||
    !['legacy', 'dev', 'test'].includes(run.suite) ||
    !isRagSearchOptions(run.options) ||
    !Array.isArray(run.rows) ||
    run.rows.some((row) => !row || !row.rag)
  )
    return null;
  const common = {
    ...emptyComparison(run.suite),
    controls: run.controls,
    startedAt: run.startedAt,
    buildId: run.buildId,
  };
  const plainAndRag = restoreComparison({
    ...common,
    rows: run.rows.map((row) => ({
      id: row.id,
      comment: '',
      baseline: row.plain,
      rag: run.version === 2 ? day22Answer(row.rag) : row.rag,
    })),
  });
  const processed = restoreComparison({
    ...common,
    options: run.options,
    rows: run.rows.map((row) => ({
      id: row.id,
      comment: '',
      baseline: row.rag,
      rag: row.enhanced,
    })),
  });
  if (!plainAndRag || !processed) return null;
  for (const row of run.rows) {
    if (run.version === 3 && row.rag.rag?.processing) return null;
    if (
      row.enhanced.status === 'done' &&
      (!row.enhanced.rag?.processing ||
        Object.entries(run.options).some(
          ([key, value]) =>
            (
              row.enhanced.rag!.processing!.options as unknown as Record<
                string,
                unknown
              >
            )[key] !== value,
        ))
    )
      return null;
  }
  return {
    ...emptyUnified(run.suite, run.options),
    startedAt: plainAndRag.startedAt,
    buildId: plainAndRag.buildId,
    rows: plainAndRag.rows.map((row, i) => ({
      id: row.id,
      plain: row.baseline,
      rag: row.rag,
      enhanced: processed.rows[i].rag,
    })),
  };
}

export function latestLegacyComparison(values: unknown[]): UnifiedRun | null {
  const runs = values
    .map(migrateComparison)
    .filter((run): run is UnifiedRun => run !== null);
  return (
    runs.sort((a, b) =>
      (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
    )[0] ?? null
  );
}

export async function runUnifiedComparison({
  onAnswer,
  ...parameters
}: {
  buildId: string;
  suite: ComparisonSuite;
  options: RagSearchOptions;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  onAnswer: (id: string, mode: UnifiedMode, answer: ComparisonAnswer) => void;
}) {
  await runComparison({
    ...parameters,
    onWithoutRag: (id, answer) => onAnswer(id, 'plain', answer),
    onAnswer: (id, mode, answer) =>
      onAnswer(id, mode === 'baseline' ? 'rag' : 'enhanced', answer),
  });
}
