// Three independent requests through the same HTTP endpoint as the local tab.
import { mkdir, writeFile } from 'node:fs/promises';
import { LOCAL_EXAMPLES } from '../lib/local-chat.ts';
const url = new URL(process.argv[2] ?? 'http://localhost:3000/api/local-chat');
if (
  url.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
)
  throw new Error('Only a loopback endpoint is allowed.');
const model = process.argv[3] ?? 'qwen2.5:7b';
const available = await fetch(url).then(async (r) => {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
});
if (!available.models.some((m) => m.name === model))
  throw new Error(`Local model not found: ${model}`);
const results = [];
for (const { level, prompt } of LOCAL_EXAMPLES) {
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(200000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(raw);
  let answer = '',
    done = null;
  for (const block of raw.trim().split(/\r?\n\r?\n/)) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}');
    if (event === 'error') throw new Error(data.message);
    if (event === 'delta') answer += data.content;
    if (event === 'done') done = data;
  }
  if (!answer.trim() || done?.finishReason !== 'stop')
    throw new Error(`Incomplete answer: ${level}`);
  const row = {
    level,
    prompt,
    answer,
    seconds: +((performance.now() - started) / 1000).toFixed(2),
    tokens: done.outputTokens,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
await mkdir('.local-data/day26', { recursive: true });
await writeFile(
  '.local-data/day26/check.json',
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      endpoint: url.href,
      model,
      results,
    },
    null,
    2,
  ),
);
console.log('3/3 completed. Report: .local-data/day26/check.json');
