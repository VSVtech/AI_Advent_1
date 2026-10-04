import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RAG_SEARCH } from './relevance.mjs';
import { ROOT, DATA_DIR } from './config.mjs';
import { hash } from './documents.mjs';
import { atomicWrite, readCurrent, readJson } from './storage.mjs';

export async function collectAnswer(response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(
      payload?.error?.message ?? `Chat API: HTTP ${response.status}`,
    );
  }
  let answer = '';
  let rag = null;
  let usage = null;
  const stream = (await response.text()).replace(/\r\n/gu, '\n');
  for (const block of stream.split('\n\n')) {
    const event = /^event: (.+)$/mu.exec(block)?.[1];
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    const payload = JSON.parse(data);
    if (event === 'error') throw new Error(payload.message);
    if (event === 'delta') answer += payload.content;
    if (event === 'rag') rag = payload.retrieval;
    if (event === 'done') usage = payload;
  }
  if (!usage || usage.finishReason === 'length' || !answer.trim())
    throw new Error(
      'Модель не завершила полный ответ; сравнение не опубликовано.',
    );
  const citations = [
    ...new Set([...answer.matchAll(/\[(S\d+)\]/gu)].map((match) => match[1])),
  ];
  return {
    answer,
    answer_hash: hash(answer),
    rag,
    usage,
    citations,
    invalid_citations: citations.filter(
      (id) => !rag?.sources.some((source) => source.id === id),
    ),
  };
}

export async function compareAnswers({
  root = ROOT,
  dataDir = DATA_DIR,
  apiUrl = process.env.RAG_CHAT_URL ?? 'http://localhost:3000/api/chat',
  fetcher = fetch,
  onProgress = (_message) => {},
  enhanced = false,
} = {}) {
  const corpus = await readCurrent(dataDir);
  if (!corpus) throw new Error('Сначала постройте индекс.');
  let control = await readJson(join(root, 'rag/answer-questions.json'));
  let options;
  if (enhanced) {
    const dataset = await readJson(join(root, 'rag/extended-questions.json'));
    const calibration = await readJson(
      join(root, 'rag/rerank-calibration.json'),
    );
    if (
      calibration.build_id !== corpus.build_id ||
      calibration.questions_hash !== hash(JSON.stringify(dataset))
    )
      throw new Error('Сначала выполните актуальную калибровку dev.');
    options = {
      ...calibration.options,
      verifyEvidence: DEFAULT_RAG_SEARCH.verifyEvidence,
      deduplicate: DEFAULT_RAG_SEARCH.deduplicate,
    };
    control = {
      ...control,
      questions: dataset.questions.filter((q) => q.split === 'test'),
    };
  }
  if (control.questions.length !== 10)
    throw new Error('Для дня 22 требуется ровно 10 вопросов.');
  const runId = randomUUID();
  const settings = {
    model: control.model,
    temperature: 0,
    format: 'text',
    targetOutputTokens: null,
    maxOutputTokens: 1400,
    contextWindowTokens: 64_000,
    useMcpTools: false,
    useSystemPrompt: true,
    useSelectorSystemPrompt: false,
    customSystemPrompt: control.system_prompt,
  };
  const rows = [];
  for (const question of control.questions) {
    const outputs = {};
    // Alternating order avoids systematically giving one mode the warm request.
    for (const mode of rows.length % 2
      ? ['rag', 'baseline']
      : ['baseline', 'rag']) {
      onProgress(`${question.id}: ${mode}`);
      const start = performance.now();
      const response = await fetcher(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...settings,
          messages: [{ role: 'user', content: question.question }],
          useRag: enhanced || mode === 'rag',
          ...(enhanced || mode === 'rag'
            ? { ragBuildId: corpus.build_id }
            : {}),
          ...(enhanced && mode === 'rag' ? { ragSearch: options } : {}),
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const output = await collectAnswer(response);
      if (
        (enhanced || mode === 'rag') &&
        output.rag?.build_id !== corpus.build_id
      )
        throw new Error('Ответ не подтверждает запрошенный снимок RAG.');
      if (!enhanced && mode === 'baseline' && output.rag)
        throw new Error('Контрольный ответ неожиданно использовал RAG.');
      if (enhanced && mode === 'rag') {
        const expected = options;
        if (
          !output.rag?.processing ||
          Object.entries(expected).some(
            ([key, value]) => output.rag.processing.options[key] !== value,
          )
        )
          throw new Error('Ответ не подтвердил настройки поиска.');
      }
      if (!(enhanced && mode === 'rag') && output.rag?.processing)
        throw new Error('Вместо RAG дня 22 сервер применил обработку.');
      outputs[mode] = {
        ...output,
        elapsed_ms: Math.round(performance.now() - start),
      };
    }
    rows.push({ ...question, ...outputs });
    // Resume/debug evidence survives interruptions, but only a complete run is current.
    await atomicWrite(
      join(dataDir, 'answer-runs', runId, 'progress.json'),
      JSON.stringify({ rows }, null, 2),
    );
  }
  const report = {
    schema_version: 1,
    ...(enhanced ? { suite: 'test', options } : {}),
    run_id: runId,
    created_at: new Date().toISOString(),
    build_id: corpus.build_id,
    corpus_hash: corpus.corpus_hash,
    controls_hash: hash(JSON.stringify(control)),
    settings,
    rows,
  };
  await atomicWrite(
    join(dataDir, 'answer-runs', runId, 'answers.json'),
    JSON.stringify(report, null, 2),
  );
  await atomicWrite(
    join(
      dataDir,
      enhanced ? 'enhanced-answers-current.json' : 'answers-current.json',
    ),
    JSON.stringify(report, null, 2),
  );
  return report;
}

export function attachReview(report, review) {
  if (!review || review.run_id !== report.run_id) return report;
  return {
    ...report,
    review_method:
      typeof review.reviewer === 'string' ? review.reviewer : 'Ручная оценка',
    rows: report.rows.map((row) => {
      const assessed = review.rows.find((item) => item.id === row.id);
      if (!assessed) return row;
      const scores = {};
      for (const mode of ['baseline', 'rag']) {
        const result = assessed[mode];
        if (
          result?.answer_hash === row[mode].answer_hash &&
          result.facts?.length === row.expected.length &&
          result.facts.every((fact) => typeof fact === 'boolean') &&
          typeof result.unsupported_claims === 'boolean' &&
          typeof result.notes === 'string'
        )
          scores[mode] = result;
      }
      return { ...row, review: scores };
    }),
  };
}

export function renderAnswers(report) {
  const historicalBaseline = report.rows.some(
    (row) => row.baseline.rag?.processing,
  );
  const baselineLabel = report.options
    ? historicalBaseline
      ? 'RAG без обработки (старый пайплайн)'
      : 'RAG дня 22'
    : 'Без RAG';
  const ragLabel = report.options ? 'RAG с обработкой' : 'С RAG';
  const lines = [
    report.options
      ? '# День 23 — качество ответов до и после обработки'
      : '# День 22 — ответы без RAG и с RAG',
    '',
    `Дата: ${report.created_at}. Снимок индекса: ${report.build_id}.`,
    `Модель: ${report.settings.model}; температура: ${report.settings.temperature}; ${historicalBaseline ? `top-k=${report.options?.topKAfter ?? 5}` : `top-k RAG дня 22=5${report.options ? `; top-k с обработкой=${report.options.topKAfter}` : ''}`}; стратегия overlap.`,
    ...(report.review_method ? [`Кто оценивал: ${report.review_method}.`] : []),
    '',
    ...(report.options
      ? [
          `Обработка: ${JSON.stringify(report.options)}. Оба режима используют RAG; слева ${historicalBaseline ? 'исторический пайплайн с отключённой обработкой' : 'поиск дня 22 (top-5)'}.`,
        ]
      : []),
    'Каждый ответ получен отдельным запросом без истории, профиля, памяти и MCP. Общие инструкции и лимиты одинаковые. Для RAG передаются найденные фрагменты и правила работы с ними. Эталоны никогда не передаются отвечающей модели. Вопросы зафиксированы до прогона.',
    '',
    'Ручная оценка: по одному баллу за каждый ожидаемый факт; отдельно отмечены неподтверждённые утверждения. Оценка привязана к хешу конкретного ответа. Для вопроса без ответа в корпусе оценивается корректное признание недостатка данных. Ссылки проверяются по списку переданных фрагментов; наличие корректного ID само по себе не доказывает, что источник подтверждает утверждение.',
    '',
    `| Вопрос | ${baselineLabel}: факты | ${ragLabel}: факты | Выдуманные факты: без / с |`,
    '| --- | ---: | ---: | --- |',
  ];
  for (const row of report.rows) {
    const score = (mode) =>
      row.review?.[mode]
        ? `${row.review[mode].facts.filter(Boolean).length}/${row.expected.length}`
        : 'не оценено';
    const unsupported = (mode) =>
      row.review?.[mode]
        ? row.review[mode].unsupported_claims
          ? 'да'
          : 'нет'
        : '—';
    lines.push(
      `| ${row.id}: ${row.question} | ${score('baseline')} | ${score('rag')} | ${unsupported('baseline')} / ${unsupported('rag')} |`,
    );
  }
  for (const mode of ['baseline', 'rag']) {
    const assessed = report.rows.filter((row) => row.review?.[mode]);
    lines.push(
      '',
      `${mode === 'rag' ? ragLabel : baselineLabel}: ${assessed.reduce((sum, row) => sum + row.review[mode].facts.filter(Boolean).length, 0)}/${assessed.reduce((sum, row) => sum + row.expected.length, 0)} ожидаемых фактов по ${assessed.length} оценённым ответам.`,
    );
  }
  if (report.options) {
    const totals = (mode) => ({
      input: report.rows.reduce(
        (sum, row) => sum + (row[mode].usage.inputTokens ?? 0),
        0,
      ),
      chunks: report.rows.reduce(
        (sum, row) => sum + row[mode].rag.sources.length,
        0,
      ),
      invalid: report.rows.reduce(
        (sum, row) => sum + row[mode].invalid_citations.length,
        0,
      ),
    });
    const before = totals('baseline'),
      after = totals('rag');
    lines.push(
      '',
      `Входные токены: ${before.input} → ${after.input}. Переданные чанки: ${before.chunks} → ${after.chunks}. Неизвестные ID цитат: ${before.invalid} / ${after.invalid}.`,
      '',
      'Меньше входных токенов или источников само по себе не означает лучший ответ. Сравнивайте полноту фактов, неподтверждённые утверждения и причины отказов выше; вывод относится только к этому прогону.',
    );
  }
  lines.push(
    '',
    'Ограничения: 10 вопросов, один прогон и ручная оценка. Это демонстрация на текущем корпусе, не статистическое доказательство превосходства. RAG может находить нерелевантные чанки и пропускать нужные сведения.',
    '',
  );
  for (const row of report.rows) {
    lines.push(
      `## ${row.id}. ${row.question}`,
      '',
      'Ожидание:',
      ...row.expected.map((item) => `- ${item}`),
      '',
      `Ожидаемые источники (допустимые альтернативы): ${row.expected_sources.join(', ') || 'нет: сведений в базе недостаточно'}.`,
      '',
    );
    for (const mode of ['baseline', 'rag']) {
      const output = row[mode];
      lines.push(
        `### ${mode === 'rag' ? ragLabel : baselineLabel}`,
        '',
        output.answer,
        '',
        `Время: ${(output.elapsed_ms / 1000).toFixed(1)} с. Вход: ${output.usage.inputTokens ?? '—'}; выход: ${output.usage.outputTokens ?? '—'} токенов.`,
        '',
      );
      if (row.review?.[mode])
        lines.push(`Оценка: ${row.review[mode].notes}`, '');
      if (output.rag)
        lines.push(
          'Переданные источники:',
          ...output.rag.sources.map(
            (source) =>
              `- [${source.id}] ${source.source}:${source.start_line}–${source.end_line} · score=${source.score.toFixed(3)} · chunk_id=${source.chunk_id}`,
          ),
          '',
          `Неизвестные ссылки: ${output.invalid_citations.join(', ') || 'нет'}.`,
          '',
        );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function main() {
  const enhanced = process.argv.includes('--enhanced');
  const prefix = enhanced ? 'rerank-answers' : 'answers';
  const report = process.argv.includes('--render')
    ? await readJson(
        join(
          DATA_DIR,
          enhanced ? 'enhanced-answers-current.json' : 'answers-current.json',
        ),
      )
    : await compareAnswers({ enhanced, onProgress: console.log });
  let review = null;
  try {
    review = await readJson(
      join(
        ROOT,
        enhanced ? 'rag/rerank-answer-review.json' : 'rag/answer-review.json',
      ),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const reviewed = attachReview(report, review);
  await atomicWrite(
    join(ROOT, `rag/${prefix}-comparison.json`),
    JSON.stringify(reviewed, null, 2),
  );
  await atomicWrite(
    join(ROOT, `rag/${prefix}-comparison.md`),
    renderAnswers(reviewed),
  );
  console.log(
    `Сохранены rag/${prefix}-comparison.json и rag/${prefix}-comparison.md`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
