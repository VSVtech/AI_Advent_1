// Lightweight BM25 search over the RAG corpus for CI: no Ollama, no embeddings.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const STOP = new Set([
  'the', 'and', 'for', 'const', 'let', 'var', 'return', 'import', 'from',
  'export', 'function', 'true', 'false', 'null', 'new', 'this', 'that',
  'для', 'что', 'как', 'это', 'или', 'при', 'если',
]);

// Identifiers are split on camelCase and snake_case so that `getWeatherSummary`
// also matches the text «weather summary».
export function tokenize(text) {
  const words = text
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/gu, '$1 $2')
    .toLocaleLowerCase('ru-RU')
    .match(/[\p{L}\p{N}]{3,}/gu);
  return (words ?? []).filter((word) => !STOP.has(word));
}

export function chunkText(source, text, { maxLines = 40 } = {}) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  // A final newline does not start another line.
  if (lines.at(-1) === '') lines.pop();
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(start + maxLines, lines.length);
    // Prefer to cut at a blank line in the second half of the window.
    for (let i = end - 1; i > start + maxLines / 2 && end < lines.length; i -= 1) {
      if (!lines[i].trim()) {
        end = i + 1;
        break;
      }
    }
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) {
      chunks.push({ source, startLine: start + 1, endLine: end, text: body });
    }
    start = end;
  }
  return chunks;
}

export function buildIndex(chunks) {
  const documents = chunks.map((chunk) => {
    const terms = new Map();
    for (const token of tokenize(`${chunk.source} ${chunk.text}`)) {
      terms.set(token, (terms.get(token) ?? 0) + 1);
    }
    return { chunk, terms, length: [...terms.values()].reduce((a, b) => a + b, 0) };
  });
  const frequency = new Map();
  for (const { terms } of documents) {
    for (const term of terms.keys()) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  const average =
    documents.reduce((sum, doc) => sum + doc.length, 0) /
    Math.max(documents.length, 1);
  return { documents, frequency, average };
}

/**
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{ limit?: number, exclude?: string[] }} [options]
 */
export function search(index, query, { limit = 6, exclude = [] } = {}) {
  const k1 = 1.4;
  const b = 0.75;
  const queryTerms = new Map();
  for (const token of tokenize(query)) {
    queryTerms.set(token, (queryTerms.get(token) ?? 0) + 1);
  }
  const total = index.documents.length;
  const scored = [];
  for (const doc of index.documents) {
    if (exclude.includes(doc.chunk.source)) continue;
    let score = 0;
    for (const [term, weight] of queryTerms) {
      const tf = doc.terms.get(term);
      if (!tf) continue;
      const df = index.frequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      // Repeated query terms add weight only logarithmically.
      score +=
        (1 + Math.log(weight)) *
        idf *
        ((tf * (k1 + 1)) /
          (tf + k1 * (1 - b + (b * doc.length) / index.average)));
    }
    if (score > 0) scored.push({ ...doc.chunk, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function loadCorpusChunks(root, manifestPath = 'rag/corpus.json') {
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8'));
  const chunks = [];
  for (const file of manifest.files) {
    let text;
    try {
      text = await readFile(resolve(root, file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    chunks.push(...chunkText(file, text));
  }
  return chunks;
}
