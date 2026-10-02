import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';

const bundled = join(DATA_DIR, 'runtime/ollama');
const binary = existsSync(bundled) ? bundled : 'ollama';
try {
  const response = await fetch(
    new URL(
      '/api/version',
      process.env.RAG_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ),
    { signal: AbortSignal.timeout(1500) },
  );
  if (response.ok) {
    console.log('Ollama уже запущена.');
    process.exit(0);
  }
} catch {
  // No reachable server: start our local process below.
}
if (
  process.env.RAG_OLLAMA_URL &&
  new URL(process.env.RAG_OLLAMA_URL).origin !== 'http://127.0.0.1:11434'
) {
  console.error(
    'Настроенный RAG_OLLAMA_URL недоступен. Запустите указанный сервер Ollama.',
  );
  process.exit(1);
}
const child = spawn(binary, ['serve'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_MODELS: join(DATA_DIR, 'models'),
    OLLAMA_NO_CLOUD: 'true',
  },
});
child.on('error', () => {
  console.error(
    'Ollama не найдена. Установите её с https://ollama.com/download.',
  );
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
