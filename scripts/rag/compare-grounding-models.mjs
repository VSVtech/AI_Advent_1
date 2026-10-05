import { join } from 'node:path';
import { ROOT, DATA_DIR } from './config.mjs';
import { readJson, atomicWrite } from './storage.mjs';
import { hash } from './documents.mjs';
import { LocalGroundingVerifier } from './grounding-model.mjs';

const name =
  process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? '27b';
const profiles = {
  '7b': { model: 'qwen2.5:7b', think: false },
  '27b': { model: 'qwen3.5:27b-q4_K_M', think: false },
  '27b-thinking': { model: 'qwen3.5:27b-q4_K_M', think: true },
};
if (!profiles[name]) throw new Error('Профиль: 7b, 27b или 27b-thinking.');
const dataset = await readJson(join(ROOT, 'rag/grounding-judge-cases.json'));
const judge = new LocalGroundingVerifier(undefined, {
  ...profiles[name],
  guardrails: false,
});
const signal = AbortSignal.timeout(1_800_000);
const report = {
  complete: false,
  created_at: new Date().toISOString(),
  profile: name,
  dataset_hash: hash(JSON.stringify(dataset)),
  identity: await judge.describe(signal),
  note: dataset.note,
  rows: [],
  coverage: [],
  memory: [],
};
const path = join(ROOT, `rag/grounding-model-${name}.json`);
const checkpoint = async () =>
  atomicWrite(
    join(DATA_DIR, `judge-${name}-progress.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
// The thinking pilot uses the same preselected difficult cases; compare it only
// to these rows in the other profiles, never to their full-set average.
const pilot = new Set([
  'saved-test01-1',
  'saved-wrong-limit',
  'new-generalized-code',
]);
for (const item of dataset.cases.filter(
  (c) => name !== '27b-thinking' || pilot.has(c.id),
)) {
  const start = performance.now();
  let checks, error;
  judge.lastUsage = undefined;
  try {
    checks = (await judge.verify(item.query, [item.claim], signal)).checks;
  } catch (e) {
    signal.throwIfAborted();
    error = e.message;
  }
  const predicted = checks?.[0]?.verdict ?? 'error';
  report.rows.push({
    ...item,
    predicted,
    correct: predicted === item.expected,
    false_accept: predicted === 'supported' && item.expected !== 'supported',
    false_reject:
      predicted !== 'supported' &&
      predicted !== 'error' &&
      item.expected === 'supported',
    checks,
    error,
    elapsed_ms: Math.round(performance.now() - start),
    usage: judge.lastUsage,
  });
  if (report.rows.length === 1 || report.rows.length === dataset.cases.length) {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal });
    const payload = await response.json();
    report.memory.push({
      at: new Date().toISOString(),
      models: payload.models?.map(
        ({ name, size, size_vram, context_length }) => ({
          name,
          size,
          size_vram,
          context_length,
        }),
      ),
    });
  }
  await checkpoint();
  console.log(
    `${name} ${item.id}: ${predicted} / ${item.expected} · ${Math.round((performance.now() - start) / 1000)}s`,
  );
  if (name === '27b-thinking' && error) {
    report.stopped_early = `Thinking pilot stopped after ${item.id}: ${error}`;
    break;
  }
}
for (const item of dataset.coverage.filter(
  (c) =>
    !report.stopped_early &&
    (name !== '27b-thinking' || c.id === 'coverage-test05'),
)) {
  const start = performance.now();
  let result, error;
  judge.lastUsage = undefined;
  try {
    result = await judge.coverage(item.query, item.claims, signal);
  } catch (e) {
    signal.throwIfAborted();
    error = e.message;
  }
  const same = (a, b) =>
    JSON.stringify(
      [...a].sort((x, y) => String(x).localeCompare(String(y))),
    ) ===
    JSON.stringify([...b].sort((x, y) => String(x).localeCompare(String(y))));
  report.coverage.push({
    ...item,
    result,
    error,
    correct:
      !!result &&
      same(result.relevant_indices, item.expected_relevant) &&
      same(result.missing_parts, item.expected_missing),
    elapsed_ms: Math.round(performance.now() - start),
    usage: judge.lastUsage,
  });
  await checkpoint();
  console.log(
    `${name} ${item.id}: ${report.coverage.at(-1).correct ? 'correct' : 'incorrect/error'} · ${Math.round((performance.now() - start) / 1000)}s`,
  );
}
const times = report.rows.map((r) => r.elapsed_ms).sort((a, b) => a - b);
report.summary = {
  cases: report.rows.length,
  correct: report.rows.filter((r) => r.correct).length,
  false_accepts: report.rows.filter((r) => r.false_accept).length,
  false_rejects: report.rows.filter((r) => r.false_reject).length,
  errors: report.rows.filter((r) => r.error).length,
  coverage_correct: report.coverage.filter((r) => r.correct).length,
  coverage_total: report.coverage.length,
  median_ms: times[Math.floor(times.length / 2)],
  p95_ms: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)],
};
report.complete = !report.stopped_early;
await atomicWrite(path, JSON.stringify(report, null, 2) + '\n');
await checkpoint();
console.log(JSON.stringify(report.summary));
