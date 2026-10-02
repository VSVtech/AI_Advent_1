import { join } from 'node:path';
import { DATA_DIR, ROOT, strategyById } from './config.mjs';
import { OllamaEmbeddings, searchIndex } from './embeddings.mjs';
import { buildIndices } from './pipeline.mjs';
import { evaluate } from './evaluate.mjs';
import { loadTokenizer } from './tokenizer.mjs';
import { loadIndex, readCurrent } from './storage.mjs';

const provider = new OllamaEmbeddings();
const onProgress = ({ strategy, completed, total }) =>
  console.log(`${strategy}: ${completed}/${total}`);
async function main() {
  const command = process.argv[2];
  if (command === 'index') {
    const current = await buildIndices({
      root: ROOT,
      dataDir: DATA_DIR,
      provider,
      tokenizer: await loadTokenizer(DATA_DIR),
      onProgress,
    });
    console.log(
      `Индексы сохранены: ${join(DATA_DIR, 'builds', current.build_id)}`,
    );
  } else if (command === 'compare') {
    const report = await evaluate({
      root: ROOT,
      dataDir: DATA_DIR,
      provider,
      onProgress,
    });
    console.log(
      `Отчёт: ${join(DATA_DIR, 'builds', report.build_id, 'comparison.md')}`,
    );
  } else if (command === 'search') {
    const strategy = strategyById(process.argv[3] ?? 'structure');
    const query = process.argv.slice(4).join(' ').trim();
    if (!query || query.length > 2000)
      throw new Error(
        'Укажите запрос до 2000 символов: pnpm rag:search structure "Как устроена память?"',
      );
    const current = await readCurrent(DATA_DIR);
    if (!current) throw new Error('Сначала выполните pnpm rag:index.');
    const index = await loadIndex(DATA_DIR, current.build_id, strategy.id);
    if (
      JSON.stringify(await provider.describe()) !==
      JSON.stringify(index.manifest.embedding)
    )
      throw new Error('Модель изменилась; перестройте индекс.');
    const [vector] = await provider.embed([query], 'query');
    console.log(JSON.stringify(searchIndex(index, vector), null, 2));
  } else throw new Error('Команды: index, compare, search.');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
