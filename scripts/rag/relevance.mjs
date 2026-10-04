/** @typedef {{ rewrite: boolean, filter: boolean, topKBefore: number, topKAfter: number, minSimilarity: number, verifyEvidence?: boolean, deduplicate?: boolean, rerank?: boolean, minRerankScore?: number }} RagSearchOptions */

/** @type {Readonly<RagSearchOptions>} */
export const DEFAULT_RAG_SEARCH = Object.freeze({
  verifyEvidence: true,
  deduplicate: true,
  rewrite: true,
  filter: true,
  topKBefore: 24,
  topKAfter: 5,
  minSimilarity: 0.45,
  rerank: true,
  minRerankScore: 0.05,
});

/** @param {unknown} value @returns {value is RagSearchOptions} */
export function isRagSearchOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return (
    (v.verifyEvidence === undefined || typeof v.verifyEvidence === 'boolean') &&
    (v.deduplicate === undefined || typeof v.deduplicate === 'boolean') &&
    typeof v.rewrite === 'boolean' &&
    typeof v.filter === 'boolean' &&
    (v.rerank === undefined || typeof v.rerank === 'boolean') &&
    (v.minRerankScore === undefined ||
      (typeof v.minRerankScore === 'number' &&
        Number.isFinite(v.minRerankScore) &&
        v.minRerankScore >= 0 &&
        v.minRerankScore <= 1)) &&
    (v.rerank !== true || typeof v.minRerankScore === 'number') &&
    Number.isInteger(v.topKBefore) &&
    Number(v.topKBefore) >= 1 &&
    Number(v.topKBefore) <= 50 &&
    Number.isInteger(v.topKAfter) &&
    Number(v.topKAfter) >= 1 &&
    Number(v.topKAfter) <= 10 &&
    Number(v.topKAfter) <= Number(v.topKBefore) &&
    typeof v.minSimilarity === 'number' &&
    Number.isFinite(v.minSimilarity) &&
    v.minSimilarity >= -1 &&
    v.minSimilarity <= 1
  );
}

/** Conservative local rewrite: keep the full question/negations/identifiers,
 * remove polite filler, expand only unambiguous abbreviations. No expected
 * answers, document contents or question IDs participate in rewriting.
 * @param {string} query */
export function rewriteQuery(query) {
  const clean = query
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(
      /^(?:пожалуйста[, ]*|подскажи(?:те)?[, ]*|расскажи(?:те)?[, ]*)+/iu,
      '',
    )
    .replace(/\s+пожалуйста(?=[?.!]*$)/iu, '')
    .trim();
  const expansions = [
    [/\bMCP\b/iu, 'Model Context Protocol'],
    [/\bRAG\b/iu, 'retrieval augmented generation'],
    [/(?:^|\s)БД(?:\s|[?.!,]|$)/iu, 'база данных database'],
    [/\bLLM\b/iu, 'языковая модель'],
  ];
  const terms = expansions
    .filter(([pattern]) => /** @type {RegExp} */ (pattern).test(clean))
    .map(([, expansion]) => expansion);
  const expanded = terms.length
    ? `${clean}\nПоисковые термины: ${terms.join('; ')}`
    : clean;
  // Never truncate away the user's constraints to fit the retrieval budget.
  return expanded.length <= 2000 && expanded ? expanded : query.trim();
}

/** @template {{ score: number, chunk_id: string }} T
 * @param {T[]} hits @param {RagSearchOptions} options */
export function filterCandidates(hits, options) {
  if (!isRagSearchOptions(options))
    throw new Error('Некорректные настройки RAG.');
  const candidates = [...hits]
    .sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, options.topKBefore);
  const passed = candidates.filter(
    (hit) => !options.filter || hit.score >= options.minSimilarity,
  );
  return {
    hits: passed.slice(0, options.topKAfter),
    candidates: candidates.length,
    passed: passed.length,
  };
}
