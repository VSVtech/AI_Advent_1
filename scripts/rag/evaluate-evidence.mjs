import { join } from 'node:path';
import { ROOT, DATA_DIR } from './config.mjs';
import { readCurrent, readJson, loadIndex, atomicWrite } from './storage.mjs';
import { hash } from './documents.mjs';
import { OllamaEmbeddings } from './embeddings.mjs';
import { LocalRewriter, LocalReranker } from './models.mjs';
import { LocalEvidenceVerifier } from './evidence.mjs';
import { retrieveCandidates } from './retrieval.mjs';
import { DEFAULT_RAG_SEARCH } from './relevance.mjs';
import { matchesEvidence } from './evaluate.mjs';

// Local retrieval evaluation only: no requests to the answer provider.
const current = await readCurrent(DATA_DIR);
if (!current) throw new Error('Сначала постройте индекс.');
const index = await loadIndex(DATA_DIR, current.build_id, 'overlap');
const dataset = await readJson(join(ROOT, 'rag/extended-questions.json'));
const golden = await readJson(join(ROOT, 'rag/questions.json'));
const provider = new OllamaEmbeddings();
if (
  JSON.stringify(await provider.describe()) !==
  JSON.stringify(index.manifest.embedding)
)
  throw new Error('Модель эмбеддингов не соответствует индексу.');
for (const q of golden)
  for (const e of q.evidence)
    if (
      index.manifest.documents.find((d) => d.source === e.source)
        ?.content_hash !== e.content_hash
    )
      throw new Error(`Устарела разметка ${q.id}.`);
const rewriter = new LocalRewriter(),
  reranker = new LocalReranker(),
  verifier = new LocalEvidenceVerifier();
const signal = AbortSignal.timeout(3_600_000);
const rows = [];
const report = {
  complete: false,
  created_at: new Date().toISOString(),
  build_id: current.build_id,
  corpus_hash: current.corpus_hash,
  questions_hash: hash(JSON.stringify(dataset)),
  evidence_hash: hash(JSON.stringify(golden)),
  embedding: index.manifest.embedding,
  rewrite: await rewriter.describe(signal),
  reranker: reranker.describe(),
  verifier: await verifier.describe(signal),
  options: DEFAULT_RAG_SEARCH,
  note: 'Повторная проверка известных вопросов, не новый слепой holdout. Hit учитывает полное попадание размеченного span. Ответы DeepSeek не генерируются.',
  rows,
};
for (const q of dataset.questions) {
  const started = performance.now();
  const result = await retrieveCandidates({
    index,
    query: q.question,
    options: DEFAULT_RAG_SEARCH,
    provider,
    rewriter,
    reranker,
    verifier,
    signal,
  });
  const evidence = q.evidence_refs.flatMap(
    (id) => golden.find((g) => g.id === id).evidence,
  );
  const before = result.ranked
    .filter((h) => h.rerank_score >= DEFAULT_RAG_SEARCH.minRerankScore)
    .slice(0, DEFAULT_RAG_SEARCH.topKAfter);
  const pack = (hits) => ({
    count: hits.length,
    hit: evidence.some((e) => hits.some((h) => matchesEvidence(h, e))),
    sources: hits.map(({ embedding: _embedding, ...h }) => h),
  });
  rows.push({
    ...q,
    processing: result.processing,
    elapsed_ms: Math.round(performance.now() - started),
    before_evidence: pack(before),
    after_evidence: pack(result.hits),
  });
  console.log(
    `${q.id}: ${result.processing.candidates} → ${result.processing.passed} → ${result.processing.verified} → ${result.processing.unique} → ${result.hits.length}; ${Math.round((performance.now() - started) / 1000)}s`,
  );
  await atomicWrite(
    join(DATA_DIR, 'evidence-progress.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
if ((await readCurrent(DATA_DIR)).build_id !== current.build_id)
  throw new Error('Индекс изменился во время проверки.');
report.complete = true;
await atomicWrite(
  join(ROOT, 'rag/evidence-comparison.json'),
  JSON.stringify(report, null, 2) + '\n',
);
const summary = (key) => {
  const positives = rows.filter((r) => r.answerable),
    negatives = rows.filter((r) => !r.answerable);
  return `${rows.reduce((s, r) => s + r[key].count, 0)} источников; Hit ${positives.filter((r) => r[key].hit).length}/${positives.length}; пустой контекст на отрицательных ${negatives.filter((r) => !r[key].count).length}/${negatives.length}`;
};
await atomicWrite(
  join(ROOT, 'rag/evidence-comparison.md'),
  [
    '# Проверка цитат и повторов',
    '',
    report.note,
    '',
    `Индекс: ${current.build_id}. Rewrite в обоих вариантах новый; порог и top-K одинаковые. Старые отчёты сохранены отдельно.`,
    '',
    `До проверки цитат: ${summary('before_evidence')}.`,
    `После проверки цитат и повторов: ${summary('after_evidence')}.`,
    '',
    '| Вопрос | Порог | Цитаты | Уникальные | До → после top-K | Hit до → после |',
    '|---|---:|---:|---:|---:|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.processing.passed} | ${r.processing.verified} | ${r.processing.unique} | ${r.before_evidence.count} → ${r.after_evidence.count} | ${r.answerable ? `${r.before_evidence.hit} → ${r.after_evidence.hit}` : 'нет ответа в базе'} |`,
    ),
    '',
    'Количество источников не является оценкой правильности ответа. Наличие цитаты проверяется точно; смысловую релевантность оценивает локальная модель, возможны ложные допуски и отказы. Разметка источников неполная; Hit относится только к отмеченным span.',
    '',
  ].join('\n'),
);
console.log(summary('before_evidence'), '→', summary('after_evidence'));
