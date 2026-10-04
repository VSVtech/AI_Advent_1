import { EVIDENCE_MODEL } from './evidence.mjs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import {
  RERANKER_DIR,
  RERANKER_REPO,
  RERANKER_REVISION,
  REWRITE_MODEL,
  LocalReranker,
} from './models.mjs';

await mkdir(join(RERANKER_DIR, 'onnx'), { recursive: true });
const weights =
  process.arch === 'arm64'
    ? 'onnx/model_qint8_arm64.onnx'
    : 'onnx/model_quint8_avx2.onnx';
for (const name of [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  weights,
]) {
  const destination = join(
    RERANKER_DIR,
    name === weights ? 'onnx/model.onnx' : name,
  );
  try {
    await stat(destination);
    continue;
  } catch {
    /* Download missing pinned artifacts. */
  }
  console.log(`Загрузка ${name}`);
  const response = await fetch(
    `https://huggingface.co/${RERANKER_REPO}/resolve/${RERANKER_REVISION}/${name}`,
    { signal: AbortSignal.timeout(900_000) },
  );
  if (!response.ok || !response.body)
    throw new Error(`Hugging Face: HTTP ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(`${destination}.tmp`),
  );
  await rename(`${destination}.tmp`, destination);
}
for (const model of [REWRITE_MODEL, EVIDENCE_MODEL]) {
  console.log(`Загрузка локальной модели ${model}`);
  const response = await fetch('http://127.0.0.1:11434/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal: AbortSignal.timeout(1_800_000),
  });
  if (!response.ok || !response.body)
    throw new Error('Запустите Ollama и повторите pnpm rag:models.');
  let buffer = '',
    complete = false;
  for await (const bytes of response.body) {
    buffer += new TextDecoder().decode(bytes);
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const progress = JSON.parse(line);
      if (progress.error) throw new Error(progress.error);
      if (progress.status === 'success') complete = true;
    }
  }
  if (!complete)
    throw new Error(
      'Загрузка rewrite не завершена. Повторите pnpm rag:models.',
    );
}
const reranker = new LocalReranker();
console.log(
  'Проверка реранкера:',
  await reranker.score(
    'Где хранятся сессии?',
    ['Сессии сохраняются в localStorage.', 'Рецепт теста для пиццы.'],
    AbortSignal.timeout(120_000),
  ),
);
