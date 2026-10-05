import { join } from 'node:path';
import { ROOT, DATA_DIR } from './config.mjs';
import { readCurrent, readJson, loadIndex, atomicWrite } from './storage.mjs';
import { hash } from './documents.mjs';
import { OllamaEmbeddings } from './embeddings.mjs';
import { LocalRewriter, LocalReranker } from './models.mjs';
import { EVIDENCE_MODEL, LocalEvidenceVerifier } from './evidence.mjs';
import { createConfiguredGroundingVerifier } from './grounding-config.mjs';
import { runGrounding } from './grounding-flow.mjs';
import { retrieveCandidates } from './retrieval.mjs';
import { DEFAULT_RAG_SEARCH } from './relevance.mjs';
import {
  GROUNDING_PROMPT,
  DRAFT_SCHEMA,
  passesGroundingThreshold,
  groundingContextSources,
  unknownAnswer,
  renderGroundedAnswer,
} from './grounding.mjs';

const current = await readCurrent(DATA_DIR);
if (!current) throw new Error('Сначала постройте индекс.');
const index = await loadIndex(DATA_DIR, current.build_id, 'overlap');
const dataset = await readJson(join(ROOT, 'rag/extended-questions.json'));
const questions = dataset.questions.filter((q) => q.split === 'test');
if (questions.length !== 10) throw new Error('Требуется ровно 10 вопросов.');
const provider = new OllamaEmbeddings();
if (
  JSON.stringify(await provider.describe()) !==
  JSON.stringify(index.manifest.embedding)
)
  throw new Error('Модель эмбеддингов изменилась.');
const signal = AbortSignal.timeout(1_800_000);
const rewriter = new LocalRewriter(),
  reranker = new LocalReranker(),
  verifier = new LocalEvidenceVerifier(),
  judge = createConfiguredGroundingVerifier();
const report = {
  complete: false,
  created_at: new Date().toISOString(),
  build_id: current.build_id,
  corpus_hash: current.corpus_hash,
  questions_hash: hash(JSON.stringify(questions)),
  generation: {
    model: EVIDENCE_MODEL,
    prompt_hash: hash(GROUNDING_PROMPT),
    temperature: 0,
  },
  judge: await judge.describe(signal),
  options: DEFAULT_RAG_SEARCH,
  note: 'Полностью локальный прогон Qwen2.5:7b, без DeepSeek. Генератор и смысловой проверяющий используют одну модель: их согласие не является независимой оценкой. Повторная проверка известных test-вопросов, не новый слепой holdout. Отказы должны иметь пустые источники/цитаты и уточнение; это исключение, а не фиктивные ссылки.',
  rows: [],
};
for (const question of questions) {
  const start = performance.now();
  const result = await retrieveCandidates({
    index,
    query: question.question,
    options: DEFAULT_RAG_SEARCH,
    provider,
    rewriter,
    reranker,
    verifier,
    signal,
  });
  const sources = [];
  for (const hit of result.hits) {
    const {
      chunk_id,
      source,
      title,
      section,
      start_line,
      end_line,
      score,
      text,
      rerank_score,
      retrieval_rank,
      evidence,
    } = hit;
    const candidate = {
      id: `S${sources.length + 1}`,
      chunk_id,
      source,
      title,
      section,
      start_line,
      end_line,
      score,
      text,
      rerank_score,
      retrieval_rank,
      evidence,
    };
    if (JSON.stringify([...sources, candidate]).length <= 18000)
      sources.push(candidate);
  }
  const retrieval = {
    build_id: current.build_id,
    strategy: 'overlap',
    query: question.question,
    sources,
    processing: result.processing,
  };
  let attempts = [],
    answer;
  if (
    !sources.some((s) => passesGroundingThreshold(s, result.processing.options))
  )
    answer = unknownAnswer('weak_context');
  else {
    const evaluated = await runGrounding({
      retrieval,
      signal,
      verify: (claims) => judge.verify(question.question, claims, signal),
      coverage: (claims) => judge.coverage(question.question, claims, signal),
      search: async ({ query, options }) => {
        const extra = await retrieveCandidates({
          index,
          query,
          options,
          provider,
          rewriter,
          reranker,
          verifier,
          signal,
        });
        const followupSources = [];
        for (const hit of extra.hits) {
          const { embedding: _embedding, ...chunk } = hit;
          const candidate = { ...chunk, id: `S${followupSources.length + 1}` };
          if (JSON.stringify([...followupSources, candidate]).length <= 8000)
            followupSources.push(candidate);
        }
        if (followupSources.length)
          retrieval.followup = {
            build_id: retrieval.build_id,
            strategy: 'overlap',
            query,
            sources: followupSources,
            processing: extra.processing,
          };
      },
      generate: async (feedback) => {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
          body: JSON.stringify({
            model: EVIDENCE_MODEL,
            stream: false,
            messages: [
              { role: 'system', content: GROUNDING_PROMPT },
              ...(!feedback
                ? [
                    {
                      role: 'user',
                      content: `RAG_CONTEXT_JSON\n${JSON.stringify(groundingContextSources(retrieval))}`,
                    },
                  ]
                : []),
              { role: 'user', content: question.question },
              ...(feedback ? [{ role: 'user', content: feedback }] : []),
            ],
            format: DRAFT_SCHEMA,
            options: {
              temperature: 0,
              seed: 42,
              num_ctx: 16384,
              num_predict: 2200,
            },
            keep_alive: '10m',
          }),
        });
        if (!response.ok) throw new Error(`Генерация: HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.done_reason === 'length')
          throw new Error(`Ответ ${question.id} не завершён.`);
        return payload.message?.content;
      },
    }).catch((error) => {
      signal.throwIfAborted();
      if (error.message !== 'coverage_unavailable') throw error;
      return {
        attempts: [],
        result: {
          ...unknownAnswer('coverage_unavailable'),
          status: 'error',
          answer: 'Не удалось оценить полноту и уместность ответа.',
          clarification: 'Повторите запрос.',
        },
      };
    });

    answer = evaluated.result;
    attempts = evaluated.attempts;
  }
  const last = attempts.at(-1),
    checks = last?.checks ?? [];
  report.rows.push({
    ...question,
    retrieval,
    raw_draft: last?.raw_draft ?? null,
    attempts,
    structure_and_quotes_valid: last?.structure_and_quotes_valid ?? null,
    checks,
    result: answer,
    has_sources: answer.sources.length > 0,
    has_quotes: answer.citations.length > 0,
    semantic_supported: ['supported', 'partial'].includes(answer.status)
      ? answer.claims.every((claim) =>
          attempts.some((attempt) =>
            attempt.checks.some(
              (check) =>
                check.verdict === 'supported' &&
                JSON.parse(attempt.raw_draft).claims[check.index].text ===
                  claim.text,
            ),
          ),
        )
      : null,
    refusal_valid:
      answer.status === 'unknown'
        ? !!answer.clarification &&
          !answer.sources.length &&
          !answer.citations.length
        : null,
    elapsed_ms: Math.round(performance.now() - start),
  });
  await atomicWrite(
    join(DATA_DIR, 'grounding-progress.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    `${question.id}: ${answer.status} (${answer.reason ?? 'checked'}), ${answer.sources.length} источников, ${answer.citations.length} цитат, ${Math.round((performance.now() - start) / 1000)}s`,
  );
}
report.complete = true;
await atomicWrite(
  join(ROOT, 'rag/grounding-comparison.json'),
  JSON.stringify(report, null, 2) + '\n',
);
await atomicWrite(
  join(ROOT, 'rag/grounding-comparison.md'),
  [
    '# День 24 — источники, цитаты и проверка ответа',
    '',
    report.note,
    '',
    `Индекс: ${report.build_id}. Дата: ${report.created_at}.`,
    '',
    '| Вопрос | Есть ответ в базе | Результат | Источники | Цитаты | Смысл по проверяющей модели |',
    '|---|---|---|---:|---:|---|',
    ...report.rows.map(
      (r) =>
        `| ${r.id} | ${r.answerable ? 'да' : 'нет'} | ${r.result.status} / ${r.result.reason ?? '—'} | ${r.result.sources.length} | ${r.result.citations.length} | ${r.semantic_supported === null ? 'не применимо: отказ' : r.semantic_supported ? 'подтверждён' : 'не подтверждён'} |`,
    ),
    '',
    ...report.rows.flatMap((r) => [
      `## ${r.id}. ${r.question}`,
      '',
      renderGroundedAnswer(r.result),
      '',
      'Проверка черновика:',
      ...r.checks.map(
        (c) => `- Факт ${c.index + 1}: ${c.verdict} — ${c.reason}`,
      ),
      '',
    ]),
  ].join('\n'),
);
console.log('Сохранён rag/grounding-comparison.json и .md');
