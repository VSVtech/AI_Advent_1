import { deduplicateHits, validateEvidence } from './evidence.mjs';
import { searchIndex } from './embeddings.mjs';
import { isRagSearchOptions } from './relevance.mjs';

// Reciprocal-rank fusion: merge both searches by chunk_id, without pretending
// that an embedding score and a cross-encoder score share the same scale.
export function fuseCandidates(lists, limit) {
  const merged = new Map();
  for (const hits of lists)
    hits.forEach((hit, i) => {
      const previous = merged.get(hit.chunk_id);
      merged.set(hit.chunk_id, {
        ...hit,
        score: Math.max(hit.score, previous?.score ?? -1),
        fusion_score: (previous?.fusion_score ?? 0) + 1 / (60 + i + 1),
      });
    });
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.fusion_score - a.fusion_score || a.chunk_id.localeCompare(b.chunk_id),
    )
    .slice(0, limit)
    .map((hit, i) => ({ ...hit, retrieval_rank: i + 1 }));
}

/** @param {{ index: any, query: string, options: import('./relevance.mjs').RagSearchOptions,
 * provider: any, rewriter: any, reranker: any,
 * verifier?: { verify: (query: string, hits: any[], signal: AbortSignal) => Promise<{ evidence: {quote: string, question_part: string}[][], identity: {model: string} }> },
 * signal?: AbortSignal }} args */
export async function retrieveCandidates({
  index,
  query,
  options,
  provider,
  rewriter,
  reranker,
  verifier,
  signal = new AbortController().signal,
}) {
  if (!isRagSearchOptions(options))
    throw new Error('Некорректные настройки поиска.');
  signal.throwIfAborted();
  const rewritten = options.rewrite
    ? await rewriter.rewrite(query, signal)
    : { query, identity: null, fallback: null };
  const queries = [...new Set([query, rewritten.query])];
  const vectors = await provider.embed(queries, 'query');
  signal.throwIfAborted();
  if (vectors.length !== queries.length)
    throw new Error('Некорректное число эмбеддингов.');
  const lists = vectors.map((vector) =>
    searchIndex(index, vector, options.topKBefore),
  );
  const candidates = fuseCandidates(lists, options.topKBefore);
  let ranked = candidates;
  if (options.rerank && candidates.length) {
    const scores = await reranker.score(
      query,
      candidates.map((hit) => `${hit.source}\n${hit.section}\n${hit.text}`),
      signal,
    );
    if (
      scores.length !== candidates.length ||
      scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    )
      throw new Error('Некорректные оценки реранкера.');
    signal.throwIfAborted();
    ranked = candidates
      .map((hit, i) => ({ ...hit, rerank_score: scores[i] }))
      .sort(
        (a, b) =>
          b.rerank_score - a.rerank_score ||
          a.retrieval_rank - b.retrieval_rank,
      );
  }
  const passed = ranked.filter(
    (hit) =>
      !options.filter ||
      (options.rerank
        ? hit.rerank_score >= options.minRerankScore
        : hit.score >= options.minSimilarity),
  );
  const checked =
    options.verifyEvidence && passed.length
      ? await verifier.verify(query, passed, signal)
      : null;
  signal.throwIfAborted();
  if (
    checked &&
    (!Array.isArray(checked.evidence) ||
      checked.evidence.length !== passed.length)
  )
    throw new Error('Некорректное число проверок цитат.');
  const verified = options.verifyEvidence
    ? passed
        .map((hit, i) => ({
          ...hit,
          evidence: validateEvidence(query, hit.text, {
            evidence: checked.evidence[i],
          }),
        }))
        .filter((hit) => hit.evidence.length)
    : passed;
  const unique = options.deduplicate ? deduplicateHits(verified) : verified;
  return {
    hits: unique.slice(0, options.topKAfter),
    // All scores are retained for evaluation and threshold calibration, not sent to the LLM.
    ranked,
    processing: {
      options,
      search_query: rewritten.query,
      search_queries: queries,
      candidates: candidates.length,
      passed: passed.length,
      ...(options.verifyEvidence || options.deduplicate
        ? {
            verified: verified.length,
            unique: unique.length,
            evidence_model: checked?.identity.model ?? null,
            evidence_revision: checked
              ? JSON.stringify(checked.identity)
              : null,
          }
        : {}),
      rewrite_fallback: rewritten.fallback,
      rewrite_model: rewritten.identity?.model ?? null,
      reranker_model: options.rerank ? reranker.describe().model : null,
      reranker_revision: options.rerank ? reranker.describe().revision : null,
    },
  };
}
