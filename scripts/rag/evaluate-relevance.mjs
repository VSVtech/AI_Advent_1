import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR } from './config.mjs';
import { hash } from './documents.mjs';
import { OllamaEmbeddings, searchIndex } from './embeddings.mjs';
import { matchesEvidence } from './evaluate.mjs';
import { loadIndex, readCurrent, readJson, atomicWrite } from './storage.mjs';
import { rewriteQuery, filterCandidates } from './relevance.mjs';

const DEFAULT_RAG_SEARCH = {
  rewrite: true,
  filter: true,
  topKBefore: 12,
  topKAfter: 5,
  minSimilarity: 0.45,
};

export function summarizeResults(results) {
  const positive = results.filter((row) => row.answerable);
  const negative = results.filter((row) => !row.answerable);
  return {
    hit: positive.filter((row) => row.rank).length / positive.length,
    mrr:
      positive.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) /
      positive.length,
    // This is annotated precision, not a judgement that every unlabelled hit is irrelevant.
    annotated_precision:
      results.reduce((sum, row) => sum + row.relevant, 0) /
      Math.max(
        1,
        results.reduce((sum, row) => sum + row.selected.length, 0),
      ),
    negative_abstention:
      negative.filter((row) => row.selected.length === 0).length /
      Math.max(1, negative.length),
    mean_chunks:
      results.reduce((sum, row) => sum + row.selected.length, 0) /
      results.length,
  };
}

export async function evaluateRelevance({
  root = ROOT,
  dataDir = DATA_DIR,
  provider = new OllamaEmbeddings(),
} = {}) {
  const current = await readCurrent(dataDir);
  if (!current) throw new Error('Сначала создайте индекс.');
  const index = await loadIndex(dataDir, current.build_id, 'overlap');
  const identity = await provider.describe();
  if (JSON.stringify(identity) !== JSON.stringify(index.manifest.embedding))
    throw new Error('Модель не соответствует индексу.');
  const positives = await readJson(join(root, 'rag/questions.json'));
  const negatives = await readJson(join(root, 'rag/irrelevant-questions.json'));
  const questions = [
    ...positives.map((q) => ({ ...q, answerable: true })),
    ...negatives,
  ];
  for (const q of positives)
    for (const evidence of q.evidence) {
      if (
        index.manifest.documents.find((doc) => doc.source === evidence.source)
          ?.content_hash !== evidence.content_hash
      )
        throw new Error(
          `Устарела разметка ${q.id}. Обновите индекс и эталоны.`,
        );
    }
  const cache = new Map();
  for (const q of questions) {
    for (const query of new Set([q.question, rewriteQuery(q.question)])) {
      if (!cache.has(query)) {
        const [vector] = await provider.embed([query], 'query');
        cache.set(
          query,
          searchIndex(index, vector, DEFAULT_RAG_SEARCH.topKBefore),
        );
      }
    }
  }
  const variants = [
    { name: 'Без фильтра и rewrite', filter: false, rewrite: false },
    { name: 'Только фильтр', filter: true, rewrite: false },
    { name: 'Только rewrite', filter: false, rewrite: true },
    { name: 'Фильтр + rewrite', filter: true, rewrite: true },
  ];
  const evaluateMode = (options) =>
    questions.map((q) => {
      const query = options.rewrite ? rewriteQuery(q.question) : q.question;
      const candidates = cache.get(query);
      const selected = filterCandidates(candidates, options).hits;
      const relevant = (hit) =>
        q.evidence.some((evidence) => matchesEvidence(hit, evidence));
      const rank = selected.findIndex(relevant) + 1;
      return {
        id: q.id,
        question: q.question,
        search_query: query,
        answerable: q.answerable,
        rank: rank || null,
        relevant: selected.filter(relevant).length,
        candidates: candidates.map((hit) => ({
          source: hit.source,
          chunk_id: hit.chunk_id,
          score: hit.score,
          relevant: relevant(hit),
        })),
        selected: selected.map((hit) => ({
          source: hit.source,
          chunk_id: hit.chunk_id,
          score: hit.score,
          relevant: relevant(hit),
        })),
      };
    });
  const modes = variants.map(({ name, ...flags }) => {
    const options = { ...DEFAULT_RAG_SEARCH, ...flags };
    const results = evaluateMode(options);
    return { name, options, metrics: summarizeResults(results), results };
  });
  const thresholds = [0.35, 0.45, 0.5, 0.55, 0.6, 0.65, 0.75].map(
    (minSimilarity) => ({
      minSimilarity,
      ...summarizeResults(
        evaluateMode({ ...DEFAULT_RAG_SEARCH, minSimilarity }),
      ),
    }),
  );
  if (JSON.stringify(await provider.describe()) !== JSON.stringify(identity))
    throw new Error('Модель изменилась во время прогона.');
  const report = {
    created_at: new Date().toISOString(),
    build_id: current.build_id,
    corpus_hash: current.corpus_hash,
    questions_hash: hash(JSON.stringify(questions)),
    embedding: identity,
    positive_count: positives.length,
    negative_count: negatives.length,
    modes,
    thresholds,
  };
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const markdown = [
    '# День 23 — фильтрация и query rewrite',
    '',
    `Прогон: ${report.created_at}. Индекс: ${report.build_id}. Модель: ${identity.model}.`,
    `Корпус: ${report.corpus_hash}. Набор вопросов: ${report.questions_hash}.`,
    '',
    `${positives.length} вопросов с размеченными фрагментами и ${negatives.length} вопросов без ответа в корпусе. Один снимок overlap, top-K ${DEFAULT_RAG_SEARCH.topKBefore} → ${DEFAULT_RAG_SEARCH.topKAfter}, порог ${DEFAULT_RAG_SEARCH.minSimilarity}. Эмбеддинги и rewrite локальные, генерация LLM в этом измерении не выполняется.`,
    '',
    '| Режим | Hit@K | MRR@K | Precision по разметке | Отсечены вопросы без ответа | Среднее число чанков |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...modes.map(
      ({ name, metrics: m }) =>
        `| ${name} | ${percent(m.hit)} | ${m.mrr.toFixed(3)} | ${percent(m.annotated_precision)} | ${percent(m.negative_abstention)} | ${m.mean_chunks.toFixed(2)} |`,
    ),
    '',
    '## Чувствительность к порогу (фильтр + rewrite)',
    '',
    '| Порог | Hit@K | MRR@K | Precision по разметке | Отсечение без ответа | Чанков |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...thresholds.map(
      (m) =>
        `| ${m.minSimilarity} | ${percent(m.hit)} | ${m.mrr.toFixed(3)} | ${percent(m.annotated_precision)} | ${percent(m.negative_abstention)} | ${m.mean_chunks.toFixed(2)} |`,
    ),
    '',
    '## Методика и ограничения',
    '',
    'По диагностическому прогону выбран консервативный порог 0,45: он сохранял Hit@5 и MRR относительно поиска без фильтра, отсекая часть вопросов без ответа. Значение 0,55 отсекало больше шума, но теряло размеченные ответы. Это выбор на текущей выборке, не универсальный оптимум.',
    '',
    'Hit и MRR вычисляются только по вопросам с ответом; попадание требует полного вхождения размеченного фрагмента в чанк. Precision считает долю таких размеченных чанков среди всех переданных. Другие правильные, но не размеченные источники не засчитываются. Это метрики retrieval, а не оценка фактической правильности ответов LLM.',
    '',
    'Порог — параметр именно этой модели и корпуса, не вероятность правильности. Таблица порогов служит диагностикой на том же наборе, не независимой валидацией. Высокий порог может удалить нужные источники. Rewrite сохраняет отрицания и идентификаторы, убирает вводные и расширяет аббревиатуры; это эвристика, не разрешение местоимений с помощью истории. Все четыре режима нужны, чтобы отличать эффект rewrite от эффекта фильтра.',
    '',
    'Ответы LLM сравниваются отдельно на странице /rag-filter-comparison: 10 контрольных вопросов, одинаковые настройки генерации, без истории и MCP. Исходный вопрос модели не меняется; переписывается только поисковый запрос.',
    '',
    '## Результаты по вопросам',
    '',
    '| Вопрос | Без обработки: ранг / чанки | Фильтр: ранг / чанки | Rewrite: ранг / чанки | Оба: ранг / чанки |',
    '| --- | --- | --- | --- | --- |',
    ...questions.map(
      (q, i) =>
        `| ${q.question.replaceAll('|', '/')} | ${modes.map((m) => `${m.results[i].rank ?? '—'} / ${m.results[i].selected.length}`).join(' | ')} |`,
    ),
    '',
  ].join('\n');
  await atomicWrite(
    join(root, 'rag/relevance-comparison.json'),
    JSON.stringify(report, null, 2),
  );
  await atomicWrite(join(root, 'rag/relevance-comparison.md'), markdown);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  evaluateRelevance()
    .then((report) => {
      for (const mode of report.modes) console.log(mode.name, mode.metrics);
      console.log('Отчёт: rag/relevance-comparison.md');
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
