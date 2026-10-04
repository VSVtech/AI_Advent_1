import type { RagSearchOptions } from '@/lib/rag-context';

export function RagSearchSettings({
  value,
  onChange,
  disabled,
}: {
  value: RagSearchOptions;
  onChange: (value: RagSearchOptions) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-wrap items-center gap-4 rounded-lg border border-white/10 p-3 text-xs text-white/70"
    >
      <legend className="px-1">Настройки поиска</legend>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.rewrite}
          onChange={(event) =>
            onChange({ ...value, rewrite: event.target.checked })
          }
        />
        Query rewrite
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.filter}
          onChange={(event) =>
            onChange({ ...value, filter: event.target.checked })
          }
        />
        Фильтр релевантности
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.rerank === true}
          onChange={(event) =>
            onChange({
              ...value,
              rerank: event.target.checked,
              minRerankScore: value.minRerankScore ?? 0.05,
            })
          }
        />
        Cross-encoder
      </label>
      {(['verifyEvidence', 'deduplicate'] as const).map((key) => (
        <label key={key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value[key] === true}
            onChange={(event) =>
              onChange({ ...value, [key]: event.target.checked })
            }
          />
          {key === 'verifyEvidence' ? 'Проверка цитат' : 'Убрать повторы'}
        </label>
      ))}
      <span>Top-K после — максимум, без добора отвергнутых фрагментов.</span>
      {(
        [
          ['topKBefore', 'Top-K до фильтра', 1, 50, 1],
          ['topKAfter', 'Top-K после фильтра', 1, 10, 1],
          [
            value.rerank ? 'minRerankScore' : 'minSimilarity',
            value.rerank ? 'Порог реранкера' : 'Порог similarity',
            value.rerank ? 0 : -1,
            1,
            0.01,
          ],
        ] as const
      ).map(([key, label, min, max, step]) => (
        <label key={key} className="flex items-center gap-2">
          {label}
          <input
            aria-label={label}
            type="number"
            min={min}
            max={max}
            step={step}
            value={value[key] ?? 0.05}
            className="w-20 rounded border border-white/15 bg-[#18201f] px-2 py-1"
            onChange={(event) =>
              onChange({ ...value, [key]: Number(event.target.value) })
            }
          />
        </label>
      ))}
    </fieldset>
  );
}
