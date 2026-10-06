// Uses the real local retrieval report; generation and verification stay local.
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';
import { readJson, atomicWrite } from './storage.mjs';
import { createConfiguredGroundingVerifier } from './grounding-config.mjs';
import { loadIndex } from './storage.mjs';
import { retrieveCandidates } from './retrieval.mjs';
import { OllamaEmbeddings } from './embeddings.mjs';
import { LocalRewriter, LocalReranker } from './models.mjs';
import { LocalEvidenceVerifier } from './evidence.mjs';
import {
  runGrounding,
  listContinuationSearch,
  selectFollowupSources,
} from './grounding-flow.mjs';
import {
  GROUNDING_PROMPT,
  DRAFT_SCHEMA,
  groundingContextSources,
  renderGroundedAnswer,
} from './grounding.mjs';

const report = await readJson(join(DATA_DIR, 'dialogue-check.json'));
const components = process.argv.includes('--components');
const generatorModel = process.argv.includes('--generator-27b')
  ? 'qwen3.5:27b-q4_K_M'
  : 'qwen2.5:7b';
const row = components
  ? report.cases[0]
  : report.cases.find((c) => c.plan.question.includes('start.sh'));
if (!row?.sources.length)
  throw new Error('Сначала выполните check-dialogue.mjs.');
const signal = AbortSignal.timeout(900_000);
const judge = createConfiguredGroundingVerifier();
const index = await loadIndex(DATA_DIR, report.build_id, 'overlap');
const searchDeps = {
  provider: new OllamaEmbeddings(),
  rewriter: new LocalRewriter(),
  reranker: new LocalReranker(),
  verifier: new LocalEvidenceVerifier(),
};
const sources = [];
for (const hit of row.sources) {
  const candidate = { ...hit, id: `S${sources.length + 1}` };
  if (JSON.stringify([...sources, candidate]).length <= 18000)
    sources.push(candidate);
}
const retrieval = {
  build_id: report.build_id,
  strategy: 'overlap',
  query: row.plan.question,
  sources,
  processing: row.processing,
};
console.log('Локальная генерация и проверка:', retrieval.query);
async function searchMore({ query, options }) {
  const extra = await retrieveCandidates({
    index,
    query,
    options,
    ...searchDeps,
    signal,
  });
  const followupSources = selectFollowupSources(retrieval, extra.hits);
  if (followupSources.length)
    retrieval.followup = {
      build_id: report.build_id,
      strategy: 'overlap',
      query,
      sources: followupSources,
      processing: extra.processing,
    };
  console.log(
    'Дополнительный поиск:',
    query,
    'источников:',
    followupSources.length,
  );
}
const continuation = listContinuationSearch(retrieval);
if (continuation) {
  retrieval.list_completion_attempted = true;
  await searchMore(continuation);
}
const evaluated = await runGrounding({
  retrieval,
  signal,
  verify: (claims) => judge.verify(retrieval.query, claims, signal),
  coverage: (claims) => judge.coverage(retrieval.query, claims, signal),
  search: searchMore,
  generate: async (feedback) => {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: generatorModel,
        think: false,
        stream: false,
        messages: [
          { role: 'system', content: GROUNDING_PROMPT },
          {
            role: 'user',
            content: `RAG_CONTEXT_JSON\n${JSON.stringify(groundingContextSources(retrieval))}`,
          },
          { role: 'user', content: retrieval.query },
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
    if (!response.ok) throw new Error(`Генерация: ${response.status}`);
    const payload = await response.json();
    if (payload.done_reason === 'length') throw new Error('Черновик оборван.');
    console.log('Черновик получен; проверка фактов и полноты.');
    return payload.message.content;
  },
});
await atomicWrite(
  join(
    DATA_DIR,
    components
      ? 'dialogue-components-check.json'
      : 'dialogue-answer-check.json',
  ),
  JSON.stringify(
    {
      build_id: report.build_id,
      query: retrieval.query,
      generator: generatorModel,
      judge: await judge.describe(signal),
      ...evaluated,
      retrieval,
    },
    null,
    2,
  ),
);
console.log(renderGroundedAnswer(evaluated.result));
if (
  !['supported', 'partial'].includes(evaluated.result.status) ||
  !evaluated.result.sources.length
)
  process.exitCode = 1;
if (components) {
  const claims = evaluated.result.claims ?? [];
  const text = claims.map((c) => c.text).join('\n');
  const complete =
    evaluated.result.status === 'supported' &&
    claims.length >= 4 &&
    ['Agent', 'Ollama', 'DeepSeek', 'RAG'].every((name) => text.includes(name));
  console.log(
    'Проверка перечисления и назначения компонентов:',
    complete ? 'PASS' : 'FAIL',
  );
  if (!complete) process.exitCode = 1;
}
