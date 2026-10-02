import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
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
} = {}) {
  const corpus = await readCurrent(dataDir);
  if (!corpus) throw new Error('Сначала постройте индекс.');
  const control = await readJson(join(root, 'rag/answer-questions.json'));
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
          useRag: mode === 'rag',
          ...(mode === 'rag' ? { ragBuildId: corpus.build_id } : {}),
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const output = await collectAnswer(response);
      if (mode === 'rag' && output.rag?.build_id !== corpus.build_id)
        throw new Error('Ответ не подтверждает запрошенный снимок RAG.');
      if (mode === 'baseline' && output.rag)
        throw new Error('Контрольный ответ неожиданно использовал RAG.');
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
    join(dataDir, 'answers-current.json'),
    JSON.stringify(report, null, 2),
  );
  return report;
}

export function attachReview(report, review) {
  if (!review || review.run_id !== report.run_id) return report;
  return {
    ...report,
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
  const lines = [
    '# День 22 — ответы без RAG и с RAG',
    '',
    `Дата: ${report.created_at}. Снимок индекса: ${report.build_id}.`,
    `Модель: ${report.settings.model}; температура: ${report.settings.temperature}; top-k=5; стратегия overlap.`,
    '',
    'Каждый ответ получен отдельным запросом без истории, профиля, памяти и MCP. Общие инструкции и лимиты одинаковые. Отличие RAG — найденные фрагменты и правила работы с ними. Эталоны никогда не передаются отвечающей модели. Вопросы зафиксированы до прогона.',
    '',
    'Ручная оценка: по одному баллу за каждый ожидаемый факт; отдельно отмечены неподтверждённые утверждения. Оценка привязана к хешу конкретного ответа. Для вопроса без ответа в корпусе оценивается корректное признание недостатка данных. Ссылки проверяются по списку переданных фрагментов; наличие корректного ID само по себе не доказывает, что источник подтверждает утверждение.',
    '',
    '| Вопрос | Без RAG: факты | С RAG: факты | Выдуманные факты: без / с |',
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
      `${mode === 'rag' ? 'С RAG' : 'Без RAG'}: ${assessed.reduce((sum, row) => sum + row.review[mode].facts.filter(Boolean).length, 0)}/${assessed.reduce((sum, row) => sum + row.expected.length, 0)} ожидаемых фактов по ${assessed.length} оценённым ответам.`,
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
        `### ${mode === 'rag' ? 'С RAG' : 'Без RAG'}`,
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
  const report = process.argv.includes('--render')
    ? await readJson(join(DATA_DIR, 'answers-current.json'))
    : await compareAnswers({ onProgress: console.log });
  let review = null;
  try {
    review = await readJson(join(ROOT, 'rag/answer-review.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const reviewed = attachReview(report, review);
  await atomicWrite(
    join(ROOT, 'rag/answers-comparison.json'),
    JSON.stringify(reviewed, null, 2),
  );
  await atomicWrite(
    join(ROOT, 'rag/answers-comparison.md'),
    renderAnswers(reviewed),
  );
  console.log(
    'Сохранены rag/answers-comparison.json и rag/answers-comparison.md',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
