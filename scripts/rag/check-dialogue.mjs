// Local regression probe: no cloud calls, no automatic index mutation.
import { join } from 'node:path';
import { DATA_DIR } from './config.mjs';
import { LocalDialoguePlanner } from './dialogue.mjs';
import { readCurrent, loadIndex, atomicWrite } from './storage.mjs';
import { OllamaEmbeddings } from './embeddings.mjs';
import { LocalRewriter, LocalReranker } from './models.mjs';
import { LocalEvidenceVerifier } from './evidence.mjs';
import { DEFAULT_RAG_SEARCH } from './relevance.mjs';
import { retrieveCandidates } from './retrieval.mjs';

const context = [
  'Цель — инструкция запуска проекта на macOS для нового разработчика. Менеджер пакетов pnpm.',
  'Рабочий контур — веб-приложение, Ollama и локальный RAG-сервис.',
];
const cases = [
  {
    current:
      'Мы готовим инструкцию для разработчика, который впервые запускает проект на macOS. Используем pnpm. Индексация, эмбеддинги и проверка Qwen должны выполняться локально. DeepSeek разрешён для формирования финального ответа и ведения памяти. Зафиксируй эти ограничения и перечисли основные компоненты системы.',
    context: [],
  },
  {
    current:
      'macOS, pnpm и локальная обработка — мои требования к будущей инструкции, их не нужно подтверждать документацией. Цель — подготовить инструкцию запуска для нового разработчика. Назовём «рабочим контуром» веб-приложение, Ollama и локальный RAG-сервис. Сохрани это определение в памяти задачи. Теперь ответь на один технический вопрос: какие процессы запускает ./start.sh? Приведи источники.',
    context,
  },
  {
    current:
      'Как запустить тот же рабочий контур вручную? Учитывай ранее выбранную платформу и менеджер пакетов. Приведи команды и источники.',
    context,
  },
  { current: 'Запомни: RAG-порт 18803 занят, используем 18813.', context },
  {
    current: 'Какой SLA гарантирован для восстановления удалённого агента?',
    context,
  },
];
const planner = new LocalDialoguePlanner();
const current = await readCurrent(DATA_DIR);
const index = await loadIndex(DATA_DIR, current.build_id, 'overlap');
const deps = {
  provider: new OllamaEmbeddings(),
  rewriter: new LocalRewriter(),
  reranker: new LocalReranker(),
  verifier: new LocalEvidenceVerifier(),
};
const expectations = [
  { intent: 'knowledge', sources: true },
  { intent: 'knowledge', sources: true },
  { intent: 'knowledge', sources: true },
  { intent: 'memory', sources: false },
  { intent: 'knowledge', sources: false },
];
const report = { build_id: current.build_id, complete: false, cases: [] };
for (const input of cases) {
  const plan = await planner.prepare(input, new AbortController().signal);
  console.log(JSON.stringify({ original: input.current, plan }));
  const result =
    plan.intent === 'knowledge'
      ? await retrieveCandidates({
          index,
          query: plan.question,
          options: DEFAULT_RAG_SEARCH,
          ...deps,
        })
      : null;
  const row = {
    input,
    plan,
    processing: result?.processing,
    sources: result?.hits.map(({ embedding: _embedding, ...hit }) => hit) ?? [],
  };
  row.expected = expectations[report.cases.length];
  row.passed =
    plan.intent === row.expected.intent &&
    Boolean(row.sources.length) === row.expected.sources;
  report.cases.push(row);
  await atomicWrite(
    join(DATA_DIR, 'dialogue-check.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      sources: row.sources.map((s) => s.source),
      passed: result?.processing.passed,
      verified: result?.processing.verified,
    }),
  );
}
report.complete = true;
await atomicWrite(
  join(DATA_DIR, 'dialogue-check.json'),
  JSON.stringify(report, null, 2),
);
if (report.cases.some((row) => !row.passed))
  throw new Error(
    'Не все регрессионные сценарии прошли: см. dialogue-check.json.',
  );
console.log(
  `Пройдено ${report.cases.length}/${report.cases.length} локальных сценариев.`,
);
