import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA_DIR = join(ROOT, '.local-data/rag');
export const MODEL = 'qwen3-embedding:0.6b';
export const TOKENIZER_REPO = 'Qwen/Qwen3-Embedding-0.6B';
export const TOKENIZER_REVISION = '3d106eabb5535a84de3ae88f45887a78259b52de';
export const QUERY_INSTRUCTION =
  'Given a question about this software project, retrieve passages of documentation or source code that answer the question.';
export const STRATEGIES = [
  { id: 'fixed', label: 'Фиксированная', size: 512, overlap: 0 },
  { id: 'overlap', label: 'С пересечением', size: 512, overlap: 96 },
  { id: 'structure', label: 'По структуре', size: 512, overlap: 0 },
];

export function strategyById(id) {
  const strategy = STRATEGIES.find((item) => item.id === id);
  if (!strategy) throw new Error('Неизвестная стратегия разбиения.');
  return strategy;
}
