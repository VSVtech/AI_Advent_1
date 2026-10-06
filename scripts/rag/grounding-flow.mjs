import {
  MAX_GROUNDED_CLAIMS,
  resolveGroundedDraft,
  groundingRepairPrompt,
  groundingContextSources,
  supportedAnswer,
  unknownAnswer,
} from './grounding.mjs';
import {
  validateCoverage,
  validateGroundingChecks,
} from './grounding-validation.mjs';

export function listContinuationSearch(retrieval) {
  const listQuestion =
    /(?:компонент|перечисл|список|какие.*(?:процесс|сервис)|list|components)/iu.test(
      retrieval.query,
    );
  const cutList = retrieval.sources.some(
    (source) =>
      /\.md$/iu.test(source.source) &&
      /^\s*[-*]\s+/mu.test(source.text) &&
      !/[.!?;`)}\]]\s*$/u.test(source.text),
  );
  return !retrieval.followup &&
    !retrieval.list_completion_attempted &&
    listQuestion &&
    cutList
    ? followupSearch(retrieval, { claims: [] }, [], [retrieval.query])
    : null;
}

export function selectFollowupSources(retrieval, hits) {
  const sources = [];
  for (const hit of hits) {
    if (
      retrieval.sources.some((existing) => existing.chunk_id === hit.chunk_id)
    )
      continue;
    const { embedding: _embedding, ...chunk } = hit;
    const candidate = { ...chunk, id: `S${sources.length + 1}` };
    if (
      sources.length < 3 &&
      JSON.stringify([...sources, candidate]).length <= 8000
    )
      sources.push(candidate);
  }
  return sources;
}

// One extra retrieval, at most three chunks, with the original thresholds.
export function followupSearch(retrieval, draft, checks, missing) {
  const insufficient = checks
    .filter((c) => c.verdict === 'insufficient')
    .map((c) => draft.claims[c.index]);
  const symbols = [
    ...new Set(
      insufficient.flatMap((c) =>
        c.citations.flatMap(
          (e) => e.quote.match(/\b[A-Z][A-Z0-9_]{3,}\b/gu) ?? [],
        ),
      ),
    ),
  ].slice(0, 5);
  // When a list crosses chunk boundaries, a repeated generic question finds
  // the same introduction. Use literal list-item names as additional anchors.
  const listAnchors = missing.length
    ? [
        ...new Set(
          retrieval.sources.flatMap((source) =>
            [...source.text.matchAll(/^\s*[-*]\s+(.+)$/gmu)].map((match) => {
              const line = match[1];
              return (
                /`([^`]{1,80})`/u.exec(line)?.[1] ??
                /^[\p{L}\p{N}-]+/u.exec(line)?.[0] ??
                ''
              );
            }),
          ),
        ),
      ]
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return {
    query: [
      ...new Set([
        symbols.join(' '),
        ...missing,
        ...insufficient.slice(0, 2).map((c) => c.text),
        retrieval.query,
        listAnchors.join(' '),
      ]),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000),
    options: {
      rewrite: false,
      filter: true,
      topKBefore: 8,
      topKAfter: 3,
      minSimilarity: retrieval.processing?.options.minSimilarity ?? 0.45,
      rerank: retrieval.processing?.options.rerank ?? false,
      minRerankScore: retrieval.processing?.options.minRerankScore ?? 0.05,
      verifyEvidence: false,
      deduplicate: true,
    },
  };
}

/** Shared by the chat and the fully local evaluation. Only checked claims survive
 * a failed repair. Completeness never changes a claim's factual verdict.
 * @param {{retrieval: import('../../lib/rag-context').RagRetrieval, generate: Function, verify: Function, coverage: Function, search?: Function, signal: AbortSignal, maxAttempts?: number}} options
 */
export async function runGrounding({
  retrieval,
  generate,
  verify,
  coverage,
  search,
  signal,
  maxAttempts = 2,
}) {
  const attempts = [];
  let relevantAccepted = [];
  let accepted = [],
    feedback = null,
    result = unknownAnswer('no_supported_claims');
  for (let attempt = 0; attempt < Math.min(2, maxAttempts); attempt++) {
    signal.throwIfAborted();
    let raw;
    try {
      raw = await generate(feedback);
    } catch (error) {
      signal.throwIfAborted();
      if (!accepted.length) throw error;
      return {
        result: partial(accepted, retrieval, [], 'repair_unavailable'),
        attempts,
      };
    }
    let draft = null,
      checks = [],
      structural = false;
    try {
      draft = resolveGroundedDraft(JSON.parse(raw), retrieval);
      structural = true;
    } catch {
      result = unknownAnswer('invalid_citation');
    }
    if (draft?.unknown) result = unknownAnswer('no_supported_claims');
    if (draft && !draft.unknown) {
      try {
        checks = validateGroundingChecks(
          await verify(draft.claims),
          draft.claims.length,
        );
      } catch (error) {
        signal.throwIfAborted();
        if (!accepted.length) throw error;
        return {
          result: partial(accepted, retrieval, [], 'verification_unavailable'),
          attempts,
        };
      }
      for (const check of checks) {
        const claim = draft.claims[check.index];
        if (
          check.verdict === 'supported' &&
          !accepted.some((c) => c.text === claim.text) &&
          accepted.length < MAX_GROUNDED_CLAIMS
        )
          accepted.push(claim);
      }
      result = unknownAnswer('unsupported_claim');
    }
    signal.throwIfAborted();
    let assessment = { relevant_indices: [], missing_parts: [retrieval.query] },
      coverageError = false;
    if (accepted.length) {
      try {
        assessment = validateCoverage(
          await coverage(accepted),
          retrieval.query,
          accepted.length,
        );
        accepted = accepted.filter((_, i) =>
          assessment.relevant_indices.includes(i),
        );
        relevantAccepted = [...accepted];
      } catch {
        signal.throwIfAborted();
        // Preserve previously established relevant facts, but do not publish
        // new facts whose relevance to the question has never been assessed.
        if (!relevantAccepted.length) throw new Error('coverage_unavailable');
        accepted = [...relevantAccepted];
        coverageError = true;
      }
      if (accepted.length)
        result =
          coverageError || assessment.missing_parts.length
            ? partial(
                accepted,
                retrieval,
                coverageError ? [] : assessment.missing_parts,
                coverageError ? 'coverage_unavailable' : 'incomplete_answer',
              )
            : supportedAnswer({ unknown: false, claims: accepted }, retrieval);
      else result = unknownAnswer('no_relevant_claims');
    }
    attempts.push({
      raw_draft: raw,
      checks,
      coverage: coverageError ? null : assessment,
      structure_and_quotes_valid: structural,
      result,
    });
    if (
      result.status === 'supported' ||
      attempt + 1 >= maxAttempts ||
      attempt === 1
    )
      break;
    // Contradiction is repaired/removed; insufficiency additionally triggers retrieval.
    let searchError = false;
    if (
      search &&
      !retrieval.followup &&
      !retrieval.list_completion_attempted &&
      (checks.some((c) => c.verdict === 'insufficient') ||
        draft?.unknown ||
        (accepted.length > 0 && assessment.missing_parts.length > 0))
    ) {
      try {
        await search(
          followupSearch(retrieval, draft, checks, assessment.missing_parts),
        );
      } catch {
        signal.throwIfAborted();
        searchError = true;
      }
    }
    attempts[attempt].followup_search_failed = searchError;
    feedback = `${groundingRepairPrompt(raw, checks)}\nПодтверждённые факты уже сохранены. Дополни ответ только недостающими фактами или исправлениями. Каждое новое утверждение будет проверено отдельно.\n${JSON.stringify({ verified_claims: accepted, missing_parts: assessment.missing_parts, additional_search_failed: searchError })}\nАктуальный RAG_CONTEXT_JSON (используй только этот каталог):\n${JSON.stringify(groundingContextSources(retrieval))}`;
  }
  return { result, attempts };
}

function partial(claims, retrieval, missing, reason) {
  return {
    ...supportedAnswer({ unknown: false, claims }, retrieval),
    status: 'partial',
    reason,
    missing_parts: missing,
    clarification: missing.length
      ? `Подтверждена только часть ответа. Не знаю ответа на: «${missing.join('»; «')}». Уточните эти части вопроса или добавьте источник.`
      : 'Показана подтверждённая часть ответа. Проверку полноты или дополнение завершить не удалось. Уточните оставшуюся часть вопроса или повторите запрос.',
  };
}
