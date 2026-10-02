import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { STRATEGIES, TOKENIZER_REPO, TOKENIZER_REVISION } from './config.mjs';
import { documentSummary, hash, loadDocuments } from './documents.mjs';
import { chunkDocument } from './chunking.mjs';
import { atomicWrite, readJson, withBuildLock } from './storage.mjs';
import { normalizeVector } from './embeddings.mjs';

export async function buildIndices({
  root,
  dataDir,
  tokenizer,
  provider,
  onProgress = (_progress) => {},
}) {
  return withBuildLock(dataDir, async () => {
    const documents = await loadDocuments(
      root,
      await readJson(join(root, 'rag/corpus.json')),
    );
    const corpus = documents.map(documentSummary);
    const corpusHash = hash(JSON.stringify(corpus));
    const identity = await provider.describe();
    const buildId = randomUUID();
    const cacheDir = join(dataDir, 'cache');
    const summaries = [];
    let dimensions = null;
    for (const strategy of STRATEGIES) {
      const start = performance.now();
      const chunks = documents.flatMap((document) =>
        chunkDocument(document, strategy, tokenizer),
      );
      let cacheHits = 0;
      for (let offset = 0; offset < chunks.length; offset += 16) {
        const batch = chunks.slice(offset, offset + 16);
        const missing = [];
        for (const chunk of batch) {
          const cacheKey = hash(
            JSON.stringify([identity, 'document', chunk.text]),
          );
          let embedding;
          try {
            embedding = normalizeVector(
              await readJson(join(cacheDir, `${cacheKey}.json`)),
            );
          } catch (error) {
            if (error.code !== 'ENOENT')
              throw new Error(
                'Повреждён кеш эмбеддингов; удалите .local-data/rag/cache и повторите.',
              );
          }
          if (embedding) {
            chunk.embedding = embedding;
            cacheHits++;
          } else missing.push({ chunk, cacheKey });
        }
        if (missing.length) {
          const vectors = await provider.embed(
            missing.map(({ chunk }) => chunk.text),
          );
          if (vectors.length !== missing.length)
            throw new Error('Неполный ответ провайдера эмбеддингов.');
          for (let i = 0; i < missing.length; i++) {
            const embedding = normalizeVector(vectors[i]);
            missing[i].chunk.embedding = embedding;
            await atomicWrite(
              join(cacheDir, `${missing[i].cacheKey}.json`),
              JSON.stringify(embedding),
            );
          }
        }
        for (const chunk of batch) {
          dimensions ??= chunk.embedding.length;
          if (chunk.embedding.length !== dimensions)
            throw new Error('Модель изменила размерность эмбеддингов.');
        }
        onProgress({
          strategy: strategy.id,
          completed: Math.min(offset + batch.length, chunks.length),
          total: chunks.length,
        });
      }
      const tokenCounts = chunks
        .map((chunk) => chunk.token_count)
        .sort((a, b) => a - b);
      const characters = corpus.reduce(
        (sum, document) => sum + document.characters,
        0,
      );
      const stats = {
        chunks: chunks.length,
        min_tokens: tokenCounts[0],
        median_tokens: tokenCounts[Math.floor(tokenCounts.length / 2)],
        max_tokens: tokenCounts.at(-1),
        total_tokens: tokenCounts.reduce((sum, count) => sum + count, 0),
        duplicate_character_ratio: Math.max(
          0,
          chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) /
            characters -
            1,
        ),
        elapsed_ms: Math.round(performance.now() - start),
        cache_hits: cacheHits,
      };
      const manifest = {
        schema_version: 1,
        build_id: buildId,
        created_at: new Date().toISOString(),
        corpus_hash: corpusHash,
        documents: corpus,
        embedding: identity,
        dimensions,
        tokenizer: { repository: TOKENIZER_REPO, revision: TOKENIZER_REVISION },
        strategy,
        stats,
      };
      const serialized = JSON.stringify({ manifest, chunks });
      await atomicWrite(
        join(dataDir, 'builds', buildId, `${strategy.id}.json`),
        serialized,
      );
      summaries.push({
        ...manifest,
        index_bytes: Buffer.byteLength(serialized),
      });
    }
    // A model tag may be updated while embedding; never publish mixed spaces.
    if (JSON.stringify(await provider.describe()) !== JSON.stringify(identity))
      throw new Error(
        'Модель изменилась во время индексации. Повторите сборку.',
      );
    // All three indexes become visible together; failed builds leave current intact.
    const current = {
      build_id: buildId,
      created_at: new Date().toISOString(),
      corpus_hash: corpusHash,
      strategies: summaries,
    };
    await atomicWrite(
      join(dataDir, 'current.json'),
      JSON.stringify(current, null, 2),
    );
    return current;
  });
}
