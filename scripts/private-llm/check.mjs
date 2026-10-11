// Checks the real VPS service through an authenticated SSH forward. No cloud calls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:18804');
if (
  base.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
)
  throw new Error('Use a loopback SSH tunnel.');
const token = (
  await readFile(
    process.env.PRIVATE_LLM_TOKEN_FILE ?? '.local-data/private-llm/token',
    'utf8',
  )
).trim();
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const results = [];
let requestTimeoutMs = 250000;
async function call(name, body, customHeaders = headers) {
  const started = performance.now();
  const response = await fetch(new URL('/api/chat', base), {
    method: 'POST',
    headers: customHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const data = await response.json();
  const row = {
    name,
    status: response.status,
    seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    ...data,
    clientSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
  };
  results.push(row);
  console.log(
    `${name}: HTTP ${row.status}, ${row.seconds} s${row.code ? `, ${row.code}` : ''}`,
  );
  return { row, retryAfter: Number(response.headers.get('Retry-After') ?? 1) };
}
function requireCheck(ok, message) {
  if (!ok) throw new Error(message);
}
const simple = (content) => ({ messages: [{ role: 'user', content }] });
const stateResponse = await fetch(new URL('/api/status', base), { headers });
requireCheck(stateResponse.ok, 'Cannot authenticate or service unavailable.');
const limits = await stateResponse.json();
requireCheck(
  limits.requestsPerMinute === 8 &&
    limits.concurrency === 1 &&
    limits.queueCapacity >= 2,
  'This scenario expects 8 RPM / 1 generation / at least 2 queue slots.',
);
requestTimeoutMs = limits.queueTimeoutMs + limits.generationTimeoutMs + 10000;
const startedAt = new Date().toISOString();
requireCheck(
  (
    await call('unauthorized', simple('Hi'), {
      'Content-Type': 'application/json',
    })
  ).row.status === 401,
  'Missing authentication accepted.',
);
requireCheck(
  (await call('max-context', simple('я'.repeat(limits.contextTokens)))).row
    .status === 413,
  'Context limit not enforced.',
);
requireCheck(
  (await call('model-override', { ...simple('Hi'), model: 'cloud-model' })).row
    .status === 400,
  'Model override accepted.',
);
for (const [name, content] of [
  ['arithmetic', 'Сколько будет 17 + 25? Ответь только числом.'],
  [
    'explanation',
    'В двух коротких предложениях объясни, зачем нужен HTTP API. Ответь по-русски.',
  ],
  [
    'logic',
    'Дан список [3, 1, 3, 2, 1]. Удали повторы, сохрани порядок первого появления. Ответь только списком.',
  ],
]) {
  const { row } = await call(name, simple(content));
  requireCheck(
    row.status === 200 && row.message?.content && row.finishReason === 'stop',
    `Incomplete answer: ${name}`,
  );
  if (name === 'arithmetic' || name === 'logic') {
    row.expectedAnswer = name === 'arithmetic' ? '42' : '[3,1,2]';
    row.answerMatchesExpected =
      row.message.content.replace(/\s/g, '') === row.expectedAnswer;
  }
}
const queueSamples = [];
let sampling = true;
const monitor = (async () => {
  while (sampling) {
    const response = await fetch(new URL('/api/status', base), {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const state = await response.json();
    queueSamples.push({
      at: new Date().toISOString(),
      active: state.active,
      queued: state.queued,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
})();
let parallel;
try {
  parallel = await Promise.all(
    [0, 1, 2].map((i) =>
      call(
        `parallel-${i + 1}`,
        simple(
          `Запрос ${i + 1}. Назови три преимущества локальной языковой модели. Ответь кратко по-русски.`,
        ),
      ),
    ),
  );
} finally {
  sampling = false;
  await monitor;
}
requireCheck(
  parallel.every(
    ({ row }) =>
      row.status === 200 && row.message?.content && row.finishReason === 'stop',
  ),
  'All concurrent requests must receive completed answers.',
);
requireCheck(
  parallel.filter(({ row }) => row.queueWaitSeconds > 0.1).length === 2,
  'Expected two requests to wait in queue.',
);
requireCheck(
  queueSamples.every((s) => s.active <= 1) &&
    queueSamples.some((s) => s.queued === 2),
  'Expected one active generation and two waiting requests.',
);
// No generation: consume whatever quota remains, then require explicit rate_limit.
let limited;
for (let i = 0; i <= limits.requestsPerMinute; i++) {
  const r = await call(`rate-${i + 1}`, {});
  if (r.row.status === 429 && r.row.code === 'rate_limit') {
    limited = r;
    break;
  }
}
requireCheck(limited, 'Rate limit was not reached.');
console.log(`Waiting ${limited.retryAfter + 1} s for quota recovery…`);
await new Promise((resolve) =>
  setTimeout(resolve, (limited.retryAfter + 1) * 1000),
);
const recovered = await call(
  'recovery',
  simple('Сколько будет 2 + 2? Ответь только числом.'),
);
requireCheck(
  recovered.row.status === 200 && recovered.row.finishReason === 'stop',
  'Service did not recover.',
);
await mkdir('.local-data/day30', { recursive: true });
await writeFile(
  '.local-data/day30/check.json',
  JSON.stringify(
    {
      startedAt,
      finishedAt: new Date().toISOString(),
      transport: 'HTTP over SSH tunnel',
      limits,
      results,
      queueSamples,
    },
    null,
    2,
  ),
);
console.log(
  'Transport and limit checks passed. Review answerMatchesExpected separately for model quality. Report: .local-data/day30/check.json',
);
