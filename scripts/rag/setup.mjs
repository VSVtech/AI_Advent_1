import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DATA_DIR,
  MODEL,
  TOKENIZER_REPO,
  TOKENIZER_REVISION,
} from './config.mjs';
import { atomicWrite } from './storage.mjs';
import { loadTokenizer } from './tokenizer.mjs';

async function setup() {
  const directory = join(DATA_DIR, 'tokenizer', TOKENIZER_REVISION);
  await mkdir(directory, { recursive: true });
  for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
    const response = await fetch(
      `https://huggingface.co/${TOKENIZER_REPO}/resolve/${TOKENIZER_REVISION}/${name}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok)
      throw new Error(`Загрузка токенизатора: HTTP ${response.status}`);
    const text = await response.text();
    JSON.parse(text);
    await atomicWrite(join(directory, name), text);
    console.log(`Токенизатор: ${name}`);
  }
  await loadTokenizer(DATA_DIR);
  console.log(`Загрузка ${MODEL} в Ollama…`);
  const response = await fetch(
    new URL(
      '/api/pull',
      process.env.RAG_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: false }),
      signal: AbortSignal.timeout(1_800_000),
    },
  );
  if (!response.ok || (await response.json()).status !== 'success')
    throw new Error(
      'Не удалось загрузить модель. Запустите Ollama и повторите pnpm rag:setup.',
    );
  console.log('Готово. Теперь выполните pnpm rag:index.');
}

setup().catch(() => {
  console.error(
    'Подготовка не завершена. Проверьте интернет и запущенную Ollama (ollama serve / pnpm rag:ollama), затем повторите pnpm rag:setup.',
  );
  process.exitCode = 1;
});
