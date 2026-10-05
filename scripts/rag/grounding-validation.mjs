export function questionParts(query) {
  const parts = query
    .split(
      /[?;\n]+|,\s*(?=(?:а\s+)?(?:как|какие|что|сколько|где|почему|how|what|where|when)(?=\s|[?.!,;:]|$))|\s+(?:и|and)\s+(?=(?:как|что|сколько|где|почему|how|what|where|when)(?=\s|[?.!,;:]|$))/iu,
    )
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  return parts.length > 0 && parts.length <= 6 ? parts : [query];
}

export function validateCoverage(value, query, count) {
  if (
    !value ||
    !Array.isArray(value.relevant_indices) ||
    new Set(value.relevant_indices).size !== value.relevant_indices.length ||
    value.relevant_indices.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= count,
    ) ||
    !Array.isArray(value.missing_parts) ||
    value.missing_parts.length > 6 ||
    value.missing_parts.some(
      (p) => typeof p !== 'string' || p.trim().length < 3 || !query.includes(p),
    ) ||
    (!value.relevant_indices.length && !value.missing_parts.length)
  )
    throw new Error('Некорректная оценка полноты.');
  return {
    relevant_indices: value.relevant_indices,
    missing_parts: [...new Set(value.missing_parts)],
  };
}

export function coverageFromParts(value, query, count) {
  const parts = questionParts(query);
  if (
    !value ||
    !Array.isArray(value.checks) ||
    value.checks.length !== parts.length ||
    new Set(value.checks.map((c) => c?.index)).size !== parts.length ||
    value.checks.some(
      (c) =>
        !Number.isInteger(c?.index) ||
        c.index < 0 ||
        c.index >= parts.length ||
        typeof c.reason !== 'string' ||
        !c.reason.trim() ||
        c.reason.length > 1000 ||
        !['full', 'partial', 'unanswered'].includes(c.status) ||
        !Array.isArray(c.answer_indices) ||
        c.answer_indices.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= count,
        ) ||
        (c.status === 'unanswered') !== (c.answer_indices.length === 0),
    )
  )
    throw new Error('Некорректная оценка частей вопроса.');
  return validateCoverage(
    {
      relevant_indices: [
        ...new Set(value.checks.flatMap((c) => c.answer_indices)),
      ],
      missing_parts: value.checks
        .filter((c) => c.status !== 'full')
        .map((c) => parts[c.index]),
    },
    query,
    count,
  );
}

export function validateGroundingChecks(value, count) {
  if (
    !value ||
    !Array.isArray(value.checks) ||
    value.checks.length !== count ||
    new Set(value.checks.map((c) => c?.index)).size !== count ||
    value.checks.some(
      (c) =>
        !Number.isInteger(c?.index) ||
        c.index < 0 ||
        c.index >= count ||
        !['supported', 'contradicted', 'insufficient'].includes(c.verdict) ||
        typeof c.reason !== 'string' ||
        !c.reason.trim() ||
        c.reason.length > 1000,
    )
  )
    throw new Error('Некорректный результат смысловой проверки.');
  return [...value.checks].sort((a, b) => a.index - b.index);
}
