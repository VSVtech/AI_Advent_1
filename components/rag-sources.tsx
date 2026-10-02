import type { RagRetrieval } from '@/lib/rag-context';

export function RagSources({ retrieval }: { retrieval: RagRetrieval }) {
  return (
    <details className="mt-3 min-w-0 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.035] p-3 text-xs text-white/65">
      <summary className="cursor-pointer text-emerald-200">
        С RAG · Передано модели: {retrieval.sources.length} источников
      </summary>
      <p className="mt-2 break-all text-[10px] text-white/40">
        Индекс {retrieval.build_id} · стратегия с пересечением. Ссылки [S1]…
        относятся к этому ответу; наличие фрагмента не гарантирует, что модель
        использовала его верно.
      </p>
      <div className="mt-3 space-y-3">
        {retrieval.sources.map((source) => (
          <details
            key={source.id}
            className="rounded border border-white/10 p-2"
          >
            <summary className="cursor-pointer break-all">
              [{source.id}] {source.source}:{source.start_line}–
              {source.end_line} · {source.score.toFixed(3)}
            </summary>
            <p className="my-2 break-words text-white/40">{source.section}</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
              {source.text}
            </pre>
          </details>
        ))}
      </div>
    </details>
  );
}
