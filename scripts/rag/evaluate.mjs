import { join } from 'node:path';
import { STRATEGIES } from './config.mjs';
import { hash } from './documents.mjs';
import { searchIndex } from './embeddings.mjs';
import { atomicWrite, loadIndex, readCurrent, readJson } from './storage.mjs';

export function matchesEvidence(chunk, evidence) {
  return (
    chunk.source === evidence.source &&
    chunk.start_offset <= evidence.start_offset &&
    chunk.end_offset >= evidence.end_offset
  );
}

export async function evaluate({
  root,
  dataDir,
  provider,
  onProgress = (_progress) => {},
}) {
  const current = await readCurrent(dataDir);
  if (!current) throw new Error('Сначала постройте индекс: pnpm rag:index.');
  const questions = await readJson(join(root, 'rag/questions.json'));
  const identity = await provider.describe();
  if (
    JSON.stringify(identity) !== JSON.stringify(current.strategies[0].embedding)
  )
    throw new Error('Модель отличается от модели индекса. Перестройте индекс.');
  const vectors = await provider.embed(
    questions.map((question) => question.question),
    'query',
  );
  const rows = [];
  for (const strategy of STRATEGIES) {
    const index = await loadIndex(dataDir, current.build_id, strategy.id);
    for (const question of questions) {
      for (const evidence of question.evidence) {
        const document = index.manifest.documents.find(
          (item) => item.source === evidence.source,
        );
        if (!document || document.content_hash !== evidence.content_hash)
          throw new Error(
            `Разметка вопроса ${question.id} устарела: обновите эталон по исходникам.`,
          );
      }
    }
    const results = questions.map((question, i) => {
      const hits = searchIndex(index, vectors[i], 5);
      const rank =
        hits.findIndex((hit) =>
          question.evidence.some((evidence) => matchesEvidence(hit, evidence)),
        ) + 1;
      const evidenceFits = index.chunks.some((chunk) =>
        question.evidence.some((evidence) => matchesEvidence(chunk, evidence)),
      );
      return {
        id: question.id,
        question: question.question,
        category: question.category,
        rank: rank || null,
        failure: rank
          ? null
          : evidenceFits
            ? 'not_retrieved'
            : 'split_evidence',
        hits: hits.map(({ text: _text, ...hit }) => ({
          ...hit,
          relevant: question.evidence.some((evidence) =>
            matchesEvidence(hit, evidence),
          ),
        })),
      };
    });
    const summary = current.strategies.find(
      (item) => item.strategy.id === strategy.id,
    );
    rows.push({
      strategy: strategy.id,
      label: strategy.label,
      ...index.manifest.stats,
      index_bytes: summary.index_bytes,
      hit_at_5:
        results.filter((result) => result.rank !== null).length /
        results.length,
      mrr_at_5:
        results.reduce(
          (sum, result) => sum + (result.rank ? 1 / result.rank : 0),
          0,
        ) / results.length,
      results,
    });
    onProgress({
      strategy: strategy.id,
      completed: questions.length,
      total: questions.length,
    });
  }
  if (JSON.stringify(await provider.describe()) !== JSON.stringify(identity))
    throw new Error('Модель изменилась во время сравнения.');
  const report = {
    schema_version: 1,
    build_id: current.build_id,
    created_at: new Date().toISOString(),
    corpus_hash: current.corpus_hash,
    questions_hash: hash(JSON.stringify(questions)),
    question_count: questions.length,
    rows,
  };
  await atomicWrite(
    join(dataDir, 'builds', current.build_id, 'comparison.json'),
    JSON.stringify(report, null, 2),
  );
  await atomicWrite(
    join(dataDir, 'builds', current.build_id, 'comparison.md'),
    markdownReport(report, current),
  );
  return report;
}

export function markdownReport(report, current) {
  const documents = current.strategies[0].documents;
  const winner = [...report.rows].sort(
    (a, b) => b.hit_at_5 - a.hit_at_5 || b.mrr_at_5 - a.mrr_at_5,
  )[0];
  const lines = [
    '# День 21 — сравнение индексации',
    '',
    `Сборка: ${report.build_id}. Дата: ${report.created_at}.`,
    '',
    `Корпус: ${documents.length} файлов, ${documents.reduce((sum, item) => sum + item.lines, 0)} строк, ${documents.reduce((sum, item) => sum + item.characters, 0)} символов.`,
    `Модель: ${current.strategies[0].embedding.model}; digest: ${current.strategies[0].embedding.digest}; размерность: ${current.strategies[0].dimensions}.`,
    `Хеш корпуса: ${report.corpus_hash}. Хеш разметки: ${report.questions_hash}.`,
    '',
    '| Стратегия | Чанки | Токены min / median / max | Повтор текста | Время, с | Кеш | Размер, МБ | Hit@5 | MRR@5 |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.rows.map(
      (row) =>
        `| ${row.label} | ${row.chunks} | ${row.min_tokens} / ${row.median_tokens} / ${row.max_tokens} | ${(row.duplicate_character_ratio * 100).toFixed(1)}% | ${(row.elapsed_ms / 1000).toFixed(1)} | ${row.cache_hits} | ${(row.index_bytes / 1e6).toFixed(2)} | ${(row.hit_at_5 * 100).toFixed(1)}% | ${row.mrr_at_5.toFixed(3)} |`,
    ),
    '',
    `На этой выборке первая по Hit@5, затем MRR@5: **${winner.label}**. При равных метриках это не означает превосходства.`,
    '',
    '## Методика и ограничения',
    '',
    `${report.question_count} заранее составленных вопросов; один корпус, модель и top-5. Попадание засчитывается, если один чанк полностью содержит хотя бы один размеченный фрагмент исходника. Эталон привязан к смещениям и хешам документов, а не к chunk_id.`,
    'Hit@5 — доля вопросов с размеченным ответом среди пяти результатов. MRR@5 — среднее 1/позиция первого размеченного ответа (0 при промахе). Другие корректные, но не размеченные места в коде или документации не засчитываются; это консервативная оценка по эталону, не абсолютная полнота поиска и не качество ответов LLM. Маленькая ручная выборка не доказывает универсального преимущества стратегии.',
    'Время — фактическое время последовательного запуска, включая кеш и прогрев; оно не является чистым сравнением скорости моделей. Повтор текста — добавочный объём символов относительно корпуса. Векторы документа строятся по тексту чанка без заголовочных префиксов; запросы — с инструкцией Qwen. Все стратегии ограничены 512 токенами, overlap=96 только у второй.',
    '',
    '## Результаты по вопросам',
    '',
    '| Вопрос | Фиксированная | Пересечение | Структура |',
    '| --- | ---: | ---: | ---: |',
    ...report.rows[0].results.map(
      (result, i) =>
        `| ${result.question.replaceAll('|', '/')} | ${report.rows.map((row) => row.results[i].rank ?? '—').join(' | ')} |`,
    ),
    '',
    '## Примеры найденных фрагментов',
    '',
  ];
  const differing = report.rows[0].results
    .map((_, i) => i)
    .filter(
      (i) => new Set(report.rows.map((row) => row.results[i].rank)).size > 1,
    );
  const examples = [
    ...new Set([...differing, ...report.rows[0].results.map((_, i) => i)]),
  ].slice(0, 3);
  for (const i of examples) {
    lines.push(`### ${report.rows[0].results[i].question}`, '');
    for (const row of report.rows) {
      const result = row.results[i];
      const top = result.hits[0];
      lines.push(
        `- ${row.label}: первый ответ ${result.rank ?? 'не найден в top-5'}; top-1 — \`${top.source}:${top.start_line}–${top.end_line}\`, ${top.section}.`,
      );
      if (result.failure)
        lines.push(
          `  Причина промаха по эталону: ${result.failure === 'split_evidence' ? 'размеченный ответ пересекает границы чанков; ни один чанк не содержит его целиком' : 'ответ помещается в чанк, но этот чанк не вошёл в top-5'}.`,
        );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
