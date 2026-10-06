import { groundingSources } from '@/scripts/rag/grounding.mjs';
import type { RagRetrieval } from '@/lib/rag-context';

export function RagSources({ retrieval }: { retrieval: RagRetrieval }) {
  const allSources = groundingSources(retrieval);
  return (
    <details className="mt-3 min-w-0 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.035] p-3 text-xs text-white/65">
      <summary className="cursor-pointer text-emerald-200">
        Найденные фрагменты RAG{' '}
        {retrieval.processing
          ? `· Найдено: ${retrieval.processing.candidates} · После порога: ${retrieval.processing.passed}${retrieval.processing.options.verifyEvidence ? ` · С цитатами: ${retrieval.processing.verified}` : ''}${retrieval.processing.options.deduplicate ? ` · Без повторов: ${retrieval.processing.unique}` : ''}`
          : ''}{' '}
        · Передано модели: {allSources.length} источников
      </summary>
      {retrieval.index_stale ? (
        <p className="mt-2 text-amber-200">
          Документы изменились после индексации. Обновите индекс в «Базе
          знаний»; этот ответ использует сохранённую версию документов.
        </p>
      ) : null}
      {retrieval.original_query ? (
        <p className="mt-2 whitespace-pre-wrap break-words">
          Вопрос к документам с учётом диалога: {retrieval.query}
        </p>
      ) : null}
      {retrieval.processing ? (
        <div className="mt-2 space-y-1 text-xs">
          <p>
            Кандидатов: {retrieval.processing.candidates} → прошли порог:{' '}
            {retrieval.processing.passed} → в первичном контексте:{' '}
            {retrieval.sources.length}.
          </p>
          {retrieval.processing.verified !== undefined ? (
            <p>
              Не прошли проверку цитат:{' '}
              {retrieval.processing.passed - retrieval.processing.verified};
              повторов удалено:{' '}
              {retrieval.processing.verified -
                (retrieval.processing.unique ?? retrieval.processing.verified)}
              .
            </p>
          ) : null}
          {retrieval.processing.evidence_model ? (
            <p>
              Проверка цитат: {retrieval.processing.evidence_model} (локально).
              Цитаты найдены в тексте; их релевантность оценивает модель и может
              ошибаться.
            </p>
          ) : null}
          <p>
            Top-K: {retrieval.processing.options.topKBefore} →{' '}
            {retrieval.processing.options.topKAfter}; фильтр:{' '}
            {retrieval.processing.options.filter
              ? `≥ ${retrieval.processing.options.rerank ? retrieval.processing.options.minRerankScore : retrieval.processing.options.minSimilarity} (${retrieval.processing.options.rerank ? 'reranker' : 'similarity'})`
              : 'выключен'}
            ; rewrite:{' '}
            {retrieval.processing.options.rewrite ? 'включён' : 'выключен'}.
          </p>
          <p className="whitespace-pre-wrap break-words">
            Поисковые запросы:{' '}
            {(
              retrieval.processing.search_queries ?? [
                retrieval.processing.search_query,
              ]
            ).join('\n')}
          </p>
          {retrieval.processing.reranker_model ? (
            <p>
              Реранкер: {retrieval.processing.reranker_model}. Оценка не
              является вероятностью правильности.
            </p>
          ) : null}
          {retrieval.processing.rewrite_fallback ? (
            <p className="text-amber-200">
              Rewrite недоступен: использован исходный запрос.{' '}
              {retrieval.processing.rewrite_fallback}
            </p>
          ) : null}
          {!retrieval.sources.length ? (
            <p className="text-amber-200">
              Релевантных источников после фильтрации нет.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="mt-2 break-all text-[10px] text-white/40">
        Индекс {retrieval.build_id} · стратегия с пересечением. Ссылки [S1]…
        относятся к этому ответу; наличие фрагмента не гарантирует, что модель
        использовала его верно.
      </p>
      {retrieval.followup ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-amber-200">
          Дополнительный поиск доказательств: {retrieval.followup.query} · ещё{' '}
          {retrieval.followup.sources.length} фрагментов (тот же индекс).
        </p>
      ) : null}
      <div className="mt-3 space-y-3">
        {allSources.map((source) => (
          <details
            key={source.id}
            className="rounded border border-white/10 p-2"
          >
            <summary className="cursor-pointer break-all">
              [{source.id}] {source.source}:{source.start_line}–
              {source.end_line} · similarity {source.score.toFixed(3)}
              {source.rerank_score !== undefined
                ? ` · reranker ${source.rerank_score.toFixed(3)} · место до реранкинга ${source.retrieval_rank}`
                : ''}
            </summary>
            <p className="my-2 break-words text-white/40">{source.section}</p>
            {source.evidence?.map((e, i) => (
              <blockquote
                key={i}
                className="my-2 whitespace-pre-wrap border-l-2 border-emerald-300/30 pl-2"
              >
                <p className="text-emerald-200">
                  Подтверждение для вопроса: {e.question_part}
                </p>
                {e.quote}
              </blockquote>
            ))}
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
              {source.text}
            </pre>
          </details>
        ))}
      </div>
    </details>
  );
}
