import { MODEL, QUERY_INSTRUCTION } from './config.mjs';

export function normalizeVector(vector) {
  if (
    !Array.isArray(vector) ||
    !vector.length ||
    !vector.every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    )
  )
    throw new Error('Модель вернула некорректный вектор.');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0)
    throw new Error('Модель вернула нулевой вектор.');
  return vector.map((value) => value / norm);
}

export class OllamaEmbeddings {
  constructor(
    baseUrl = process.env.RAG_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  ) {
    this.baseUrl = baseUrl;
    this.identity = null;
  }

  async request(path, body) {
    let response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new Error(
        'Ollama недоступна. Запустите ollama serve или pnpm rag:ollama.',
      );
    }
    if (!response.ok)
      throw new Error(
        `Ollama: HTTP ${response.status}. Проверьте модель; выполните pnpm rag:setup.`,
      );
    return response.json();
  }

  async describe() {
    const { models } = await this.request('/api/tags');
    const model = models?.find(
      (item) => item.name === MODEL || item.model === MODEL,
    );
    if (!model?.digest)
      throw new Error('Модель Qwen не загружена. Выполните pnpm rag:setup.');
    this.identity = {
      provider: 'ollama',
      model: MODEL,
      digest: model.digest,
      query_instruction: QUERY_INSTRUCTION,
      num_ctx: 8192,
    };
    return this.identity;
  }

  async embed(texts, kind = 'document') {
    const input = texts.map((text) =>
      kind === 'query'
        ? `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${text}`
        : text,
    );
    const response = await this.request('/api/embed', {
      model: MODEL,
      input,
      truncate: false,
      options: { num_ctx: 8192 },
      keep_alive: '10m',
    });
    if (
      !Array.isArray(response.embeddings) ||
      response.embeddings.length !== input.length
    )
      throw new Error(
        'Количество эмбеддингов не совпадает с количеством текстов.',
      );
    return response.embeddings.map(normalizeVector);
  }
}

export function searchIndex(index, queryVector, limit = 5) {
  const query = normalizeVector(queryVector);
  if (query.length !== index.manifest.dimensions)
    throw new Error('Размерность запроса не совпадает с индексом.');
  return index.chunks
    .map((chunk) => {
      const vector = chunk.embedding;
      if (vector.length !== query.length)
        throw new Error('Повреждённая размерность в индексе.');
      const score = vector.reduce((sum, value, i) => sum + value * query[i], 0);
      const { embedding: _embedding, ...metadata } = chunk;
      return { ...metadata, score };
    })
    .sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, limit);
}
