import { hash } from './documents.mjs';

// Token boundaries may fall inside a UTF-8 character. Only exact source prefixes
// are accepted, so Cyrillic and emoji are never replaced or silently discarded.
export function tokenWindows(text, tokenizer, size, overlap = 0) {
  if (
    !Number.isInteger(size) ||
    size < 8 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= size
  )
    throw new Error('Некорректные параметры чанков.');
  const ids = tokenizer.encode(text);
  if (tokenizer.decode(ids) !== text)
    throw new Error('Токенизатор изменяет исходный текст.');
  const offsets = new Map([
    [0, 0],
    [ids.length, text.length],
  ]);
  const offsetAt = (position) => {
    if (!offsets.has(position)) {
      const prefix = tokenizer.decode(ids.slice(0, position));
      offsets.set(position, text.startsWith(prefix) ? prefix.length : null);
    }
    return offsets.get(position);
  };
  const windows = [];
  let start = 0;
  while (start < ids.length) {
    let end = Math.min(ids.length, start + size);
    while (
      end > start &&
      (offsetAt(end) === null ||
        tokenizer.encode(text.slice(offsetAt(start), offsetAt(end))).length >
          size)
    )
      end--;
    if (end <= start)
      throw new Error('Невозможно выделить чанк без потери символов.');
    windows.push({ start: offsetAt(start), end: offsetAt(end) });
    if (end === ids.length) break;
    let next = Math.max(start + 1, end - overlap);
    while (next < end && offsetAt(next) === null) next++;
    start = next;
  }
  return windows;
}

export function chunkDocument(document, strategy, tokenizer) {
  let ranges;
  if (strategy.id === 'structure') {
    const sections = [];
    for (const section of document.sections) {
      const previous = sections.at(-1);
      if (
        previous &&
        previous.scope === section.scope &&
        tokenizer.encode(document.text.slice(previous.start, section.end))
          .length <= strategy.size
      )
        previous.end = section.end;
      else sections.push({ ...section });
    }
    ranges = sections.flatMap((section) =>
      tokenWindows(
        document.text.slice(section.start, section.end),
        tokenizer,
        strategy.size,
        strategy.overlap,
      ).map((range) => ({
        start: range.start + section.start,
        end: range.end + section.start,
      })),
    );
  } else
    ranges = tokenWindows(
      document.text,
      tokenizer,
      strategy.size,
      strategy.overlap,
    );
  return ranges
    .filter((range) => document.text.slice(range.start, range.end).trim())
    .map((range, ordinal) => {
      const text = document.text.slice(range.start, range.end);
      const sections = document.sections
        .filter(
          (section) => section.start < range.end && section.end > range.start,
        )
        .map((section) => section.section);
      return {
        chunk_id: hash(
          JSON.stringify([
            document.document_id,
            document.content_hash,
            strategy,
            range.start,
            range.end,
          ]),
        ),
        document_id: document.document_id,
        source: document.source,
        file: document.file,
        title: document.title,
        section: [...new Set(sections)].join(' → '),
        ordinal,
        strategy: strategy.id,
        start_offset: range.start,
        end_offset: range.end,
        start_line: document.text.slice(0, range.start).split('\n').length,
        end_line: document.text.slice(0, range.end - 1).split('\n').length,
        token_count: tokenizer.encode(text).length,
        text,
      };
    });
}
