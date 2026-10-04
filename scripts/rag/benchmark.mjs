import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR } from './config.mjs';
import { hash } from './documents.mjs';
import { OllamaEmbeddings } from './embeddings.mjs';
import { matchesEvidence } from './evaluate.mjs';
import { summarizeResults } from './evaluate-relevance.mjs';
import { LocalReranker, LocalRewriter } from './models.mjs';
import { DEFAULT_RAG_SEARCH } from './relevance.mjs';
import { retrieveCandidates } from './retrieval.mjs';
import { atomicWrite, loadIndex, readCurrent, readJson } from './storage.mjs';

const CALIBRATION = join(ROOT, 'rag/rerank-calibration.json');
export const THRESHOLDS = [
  0, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9,
];

export function selectThreshold(rows, topKAfter) {
  if (!rows.length || rows.some((row) => row.split !== 'dev'))
    throw new Error('Калибровка допускает только dev.');
  const table = THRESHOLDS.map((threshold) => ({
    threshold,
    ...summarizeResults(
      rows.map((row) => selectRow(row, threshold, topKAfter)),
    ),
  }));
  // Preserve dev retrieval recall first; then reject unsupported questions.
  // Prefer the smaller threshold when metrics tie. Test is never consulted.
  const best = [...table].sort(
    (a, b) =>
      b.hit - a.hit ||
      b.negative_abstention - a.negative_abstention ||
      b.mrr - a.mrr ||
      a.mean_chunks - b.mean_chunks ||
      a.threshold - b.threshold,
  )[0];
  return { threshold: best.threshold, table };
}

export function selectRow(row, threshold, topKAfter) {
  const selected = row.candidates
    .filter((hit) => (hit.rerank_score ?? 1) >= threshold)
    .slice(0, topKAfter);
  return {
    ...row,
    selected,
    rank: selected.findIndex((hit) => hit.relevant) + 1 || null,
    relevant: selected.filter((hit) => hit.relevant).length,
    evidence_coverage: row.evidence_count
      ? new Set(selected.flatMap((hit) => hit.evidence)).size /
        row.evidence_count
      : null,
  };
}

export async function benchmark(stage) {
  if (!['calibrate', 'evaluate'].includes(stage))
    throw new Error('Укажите calibrate или evaluate.');
  const current = await readCurrent(DATA_DIR);
  if (!current) throw new Error('Сначала pnpm rag:index.');
  const index = await loadIndex(DATA_DIR, current.build_id, 'overlap');
  const golden = await readJson(join(ROOT, 'rag/questions.json'));
  const dataset = await readJson(join(ROOT, 'rag/extended-questions.json'));
  const signal = AbortSignal.timeout(3_600_000);
  const rewriter = new LocalRewriter(),
    reranker = new LocalReranker(),
    embeddings = new OllamaEmbeddings();
  const identity = await embeddings.describe();
  if (JSON.stringify(identity) !== JSON.stringify(index.manifest.embedding))
    throw new Error('Модель не соответствует индексу.');
  const rewriteIdentity = await rewriter.describe(signal);
  const provenance = {
    build_id: current.build_id,
    corpus_hash: current.corpus_hash,
    questions_hash: hash(JSON.stringify(dataset)),
    evidence_hash: hash(JSON.stringify(golden)),
    embedding: identity,
    rewriter: rewriteIdentity,
    reranker: reranker.describe(),
  };
  const dev = dataset.questions.filter((q) => q.split === 'dev');
  const test = dataset.questions.filter((q) => q.split === 'test');
  if (
    dev.length !== 10 ||
    test.length !== 10 ||
    new Set(dataset.questions.map((q) => q.id)).size !== 20
  )
    throw new Error('Неверный состав dev/test.');
  for (const q of golden)
    for (const e of q.evidence)
      if (
        index.manifest.documents.find((doc) => doc.source === e.source)
          ?.content_hash !== e.content_hash
      )
        throw new Error(`Устарела разметка ${q.id}.`);
  const vectorCache = new Map();
  const provider = {
    async embed(queries, kind) {
      for (const query of queries)
        if (!vectorCache.has(query))
          vectorCache.set(query, (await embeddings.embed([query], kind))[0]);
      return queries.map((q) => vectorCache.get(q));
    },
  };
  const run = async (questions, options) => {
    const rows = [];
    for (const q of questions) {
      console.log(
        `${stage}: ${q.id}, rewrite=${options.rewrite}, rerank=${options.rerank}`,
      );
      const evidence =
        q.evidence ??
        q.evidence_refs.flatMap((id) => {
          const reference = golden.find((g) => g.id === id);
          if (!reference) throw new Error(`Не найден эталон ${id}.`);
          return reference.evidence;
        });
      const started = performance.now();
      const result = await retrieveCandidates({
        index,
        query: q.question,
        options,
        provider,
        rewriter,
        reranker,
        signal,
      });
      if (result.processing.rewrite_fallback)
        console.log(`Rewrite fallback: ${result.processing.rewrite_fallback}`);
      const candidates = result.ranked.map(({ text: _text, ...hit }) => ({
        ...hit,
        relevant: evidence.some((e) => matchesEvidence(hit, e)),
        evidence: evidence.flatMap((e, i) =>
          matchesEvidence(hit, e) ? [i] : [],
        ),
      }));
      rows.push(
        selectRow(
          {
            id: q.id,
            split: q.split ?? 'regression',
            question: q.question,
            answerable: q.answerable ?? true,
            evidence_count: evidence.length,
            evidence_fits: evidence.map((e) =>
              index.chunks.some((c) => matchesEvidence(c, e)),
            ),
            processing: result.processing,
            elapsed_ms: Math.round(performance.now() - started),
            candidates,
          },
          options.filter ? options.minRerankScore : 0,
          options.topKAfter,
        ),
      );
    }
    return rows;
  };
  const unchanged = async () => {
    if (
      JSON.stringify(await embeddings.describe()) !==
        JSON.stringify(identity) ||
      JSON.stringify(await rewriter.describe(signal)) !==
        JSON.stringify(rewriteIdentity)
    )
      throw new Error('Модель изменилась во время прогона.');
  };
  if (stage === 'calibrate') {
    const options = {
      ...DEFAULT_RAG_SEARCH,
      verifyEvidence: false,
      deduplicate: false,
      rewrite: true,
      rerank: true,
      filter: false,
    };
    const rows = await run(dev, options);
    const calibration = selectThreshold(rows, options.topKAfter);
    await unchanged();
    const report = {
      created_at: new Date().toISOString(),
      ...provenance,
      policy:
        'dev only: maximize Hit@5, then negative abstention, then MRR, then fewer chunks; lowest threshold breaks ties',
      options: {
        ...options,
        filter: true,
        minRerankScore: calibration.threshold,
      },
      ...calibration,
      rows,
    };
    await atomicWrite(CALIBRATION, JSON.stringify(report, null, 2));
    console.log('Параметры зафиксированы:', report.options);
    return report;
  }
  const calibration = await readJson(CALIBRATION);
  for (const [key, value] of Object.entries(provenance))
    if (JSON.stringify(calibration[key]) !== JSON.stringify(value))
      throw new Error(
        `Калибровка не соответствует ${key}. Сначала calibrate на dev.`,
      );
  const options = calibration.options;
  const variants = [
    {
      name: 'Без обработки',
      options: { ...options, rewrite: false, rerank: false, filter: false },
    },
    {
      name: 'Только rewrite',
      options: { ...options, rerank: false, filter: false },
    },
    {
      name: 'Только rerank',
      options: { ...options, rewrite: false, filter: false },
    },
    { name: 'Rewrite + rerank', options: { ...options, filter: false } },
    { name: 'Rewrite + rerank + порог dev', options },
  ];
  const modes = [];
  for (const variant of variants) {
    const results = await run(test, variant.options);
    modes.push({ ...variant, metrics: summarizeResults(results), results });
  }
  const regression = [];
  for (const variant of [variants[0], variants.at(-1)]) {
    const results = await run(golden, variant.options);
    regression.push({
      ...variant,
      metrics: summarizeResults(results),
      results,
    });
  }
  await unchanged();
  const report = {
    created_at: new Date().toISOString(),
    ...provenance,
    calibration_hash: hash(JSON.stringify(calibration)),
    options,
    modes,
    regression,
  };
  await atomicWrite(
    join(ROOT, 'rag/rerank-comparison.json'),
    JSON.stringify(report, null, 2),
  );
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    '# Локальная проверка rewrite и cross-encoder',
    '',
    `Индекс: ${current.build_id}. Корпус: ${current.corpus_hash}.`,
    `Порог ${options.minRerankScore} выбран только на 10 dev-вопросах и сохранён до запуска test. Top-K ${options.topKBefore} → ${options.topKAfter}.`,
    '',
    '| Отложенные 10 вопросов | Hit@5 | MRR@5 | Precision по разметке | Пустой контекст на вопросах без ответа | Среднее чанков |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...modes.map(
      ({ name, metrics: m }) =>
        `| ${name} | ${pct(m.hit)} | ${m.mrr.toFixed(3)} | ${pct(m.annotated_precision)} | ${pct(m.negative_abstention)} | ${m.mean_chunks.toFixed(2)} |`,
    ),
    '',
    '## Исходные 20 вопросов: регрессия',
    '',
    '| Режим | Hit@5 | MRR@5 |',
    '| --- | ---: | ---: |',
    ...regression.map(
      ({ name, metrics: m }) =>
        `| ${name} | ${pct(m.hit)} | ${m.mrr.toFixed(3)} |`,
    ),
    '',
    '## Ограничения',
    '',
    'Это оценка поиска, а не правильности сгенерированных ответов. На test только 6 вопросов с ответом и 4 без ответа; статистическую значимость такой размер не подтверждает. Исходные вопросы не заменялись ради улучшения результата.',
    '',
    'Попадание: полное вхождение хотя бы одного размеченного фрагмента в чанк. Другие корректные фрагменты могут быть не размечены. JSON содержит coverage всех фрагментов и evidence_fits: длинный эталон может пересекать границы чанков. Низкая метрика поэтому не равна доказанной ошибке ответа.',
    '',
    'Сигмоид cross-encoder — шкала ранжирования, не вероятность правильности. Тематически близкий чанк может иметь высокий score даже при отсутствии запрошенного факта. Пустой контекст измеряет отсечение, а не корректность отказа LLM.',
    '',
    'Rewrite: локальная Qwen2.5:1.5b. Reranker: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1, pinned revision; максимум 512 токенов на пару вопрос/фрагмент. Длинные пары обрезаются токенизатором. Оба запроса участвуют в RRF, максимум 24 уникальных кандидата. Время включает прогрев/кеш и не подходит для сравнения производительности.',
    '',
    '## Вопросы test: ранг первого размеченного фрагмента / чанки',
    '',
    '| Вопрос | Без обработки | Rewrite | Rerank | Оба | Оба + порог |',
    '| --- | --- | --- | --- | --- | --- |',
    ...test.map(
      (q, i) =>
        `| ${q.question.replaceAll('|', '/')} | ${modes.map((m) => `${m.results[i].rank ?? '—'} / ${m.results[i].selected.length}`).join(' | ')} |`,
    ),
    '',
  ];
  await atomicWrite(join(ROOT, 'rag/rerank-comparison.md'), lines.join('\n'));
  console.log('Отчёт: rag/rerank-comparison.md');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  benchmark(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
