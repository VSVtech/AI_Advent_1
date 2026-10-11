// Frozen retrieval + the production prompt/schema. No cloud inference or grading.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ROOT, DATA_DIR } from './rag/config.mjs';
import { DEFAULT_RAG_SEARCH } from './rag/relevance.mjs';
import { resolveGroundedDraft } from './rag/grounding.mjs';
import {
  LOCAL_RAG_PROFILES,
  localRagPrompt,
  localRagFormat,
  localRagContext,
  isLocalRagProfile,
} from '../lib/local-rag-profile.ts';

const hash = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const directory = join(ROOT, '.local-data/day29');
await mkdir(directory, { recursive: true });
const dataset = JSON.parse(
  await readFile(join(ROOT, 'rag/local-optimization-questions.json'), 'utf8'),
);
const action = process.argv[2] ?? 'prepare';
const option = (name, fallback) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const ollama =
  process.env.LOCAL_OLLAMA_URL ??
  process.env.RAG_OLLAMA_URL ??
  'http://127.0.0.1:11434';
const rag = process.env.RAG_SERVICE_URL ?? 'http://127.0.0.1:18803/rag';
for (const base of [ollama, rag]) {
  const u = new URL(base);
  if (
    u.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw new Error('Benchmark allows loopback HTTP only.');
}
const json = async (url, body, timeout = 240000) => {
  const r = await fetch(url, {
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} at ${new URL(url).pathname}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data;
};
const endpoint = (path) => new URL(path, ollama);
const snapshotPath = resolve(
  option('snapshot', join(directory, 'retrieval.json')),
);
if (action === 'prepare') {
  const current = JSON.parse(
    await readFile(join(DATA_DIR, 'current.json'), 'utf8'),
  );
  const snapshot = {
    build_id: current.build_id,
    dataset_hash: hash(dataset),
    created_at: new Date().toISOString(),
    cases: [],
  };
  for (const item of dataset.cases) {
    const start = performance.now();
    const found = await json(rag, {
      action: 'retrieve',
      build_id: current.build_id,
      strategy: 'overlap',
      query: item.question,
      options: DEFAULT_RAG_SEARCH,
    });
    if (found.build_id !== current.build_id) throw new Error('Index changed');
    const sources = [];
    for (const hit of found.hits.slice(0, DEFAULT_RAG_SEARCH.topKAfter)) {
      const { embedding: _, ...source } = hit;
      const candidate = { ...source, id: `S${sources.length + 1}` };
      if (JSON.stringify([...sources, candidate]).length <= 16000)
        sources.push(candidate);
    }
    snapshot.cases.push({
      id: item.id,
      retrieval_ms: Math.round(performance.now() - start),
      retrieval: {
        build_id: found.build_id,
        strategy: 'overlap',
        query: item.question,
        sources,
        processing: found.processing,
      },
    });
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log(
      `${item.id}: ${sources.length} sources, ${Math.round((performance.now() - start) / 1000)}s`,
    );
  }
  console.log(snapshotPath);
} else if (action === 'run') {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  if (
    snapshot.dataset_hash !== hash(dataset) ||
    snapshot.cases.length !== dataset.cases.length
  )
    throw new Error('Incomplete or stale retrieval snapshot');
  const profile = option('profile', 'baseline');
  if (!isLocalRagProfile(profile)) throw new Error('Unknown profile');
  const model = option('model', 'qwen2.5:7b');
  const split = option('split', 'all');
  const freshContext = process.argv.includes('--fresh-context');
  const repeat = Number(option('repeat', '2'));
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5)
    throw new Error('repeat must be 1..5');
  const cases = dataset.cases.filter(
    (c) => split === 'all' || c.split === split,
  );
  if (!cases.length) throw new Error('Empty dataset');
  const settings = LOCAL_RAG_PROFILES[profile];
  const options = {
    temperature: settings.temperature,
    num_ctx: settings.contextTokens,
    num_predict: settings.maxOutputTokens,
    seed: 42,
  };
  const tags = await json(endpoint('/api/tags'));
  const identity = tags.models.find((m) => m.name === model);
  if (!identity || identity.remote_model || /cloud/i.test(model))
    throw new Error('Install a local model first');
  const details = await json(endpoint('/api/show'), { model });
  if (
    details.remote_host ||
    details.remote_model ||
    !details.capabilities?.includes('completion')
  )
    throw new Error('Local completion model required');
  const path = join(
    directory,
    `${profile}-${model.replace(/[^a-z0-9.-]/gi, '_')}-${split}${freshContext ? '-fresh' : ''}.json`,
  );
  const report = {
    complete: false,
    created_at: new Date().toISOString(),
    profile,
    model,
    identity,
    settings,
    format: localRagFormat(profile),
    prompt: localRagPrompt(profile),
    prompt_hash: hash(localRagPrompt(profile)),
    snapshot_hash: hash(snapshot),
    dataset_hash: hash(dataset),
    build_id: snapshot.build_id,
    split,
    repeat,
    fresh_context: freshContext,
    rows: [],
    note: 'Isolated generation on identical frozen retrieval. Exact citation validation + keyword rubric, not an independent semantic judge. Warm requests; memory/retrieval/verifier not included in timings. Peak sampled /api/ps bytes are Ollama-reported allocations, not OS peak RAM.',
  };
  await json(endpoint('/api/generate'), { model, keep_alive: 0 });
  const warmStart = performance.now();
  const warmup = await json(endpoint('/api/chat'), {
    model,
    messages: [{ role: 'user', content: 'Ответь: готово.' }],
    stream: false,
    think: false,
    keep_alive: '10m',
    options: { ...options, num_predict: 8 },
  });
  report.warmup = {
    wall_ms: Math.round(performance.now() - warmStart),
    load_ms: Math.round(warmup.load_duration / 1e6),
  };
  for (let round = 0; round < repeat; round++)
    for (const item of round % 2 ? [...cases].reverse() : cases) {
      const retrieval = snapshot.cases.find((c) => c.id === item.id).retrieval;
      const messages = [
        { role: 'system', content: localRagPrompt(profile) },
        ...(item.history ?? []),
        {
          role: 'user',
          content: `RAG_CONTEXT_JSON\n${JSON.stringify(localRagContext(retrieval, profile))}`,
        },
        { role: 'user', content: item.question },
      ];
      if (freshContext) {
        await json(endpoint('/api/generate'), { model, keep_alive: 0 });
        await json(endpoint('/api/chat'), {
          model,
          messages: [{ role: 'user', content: 'Ответь: готово.' }],
          stream: false,
          think: false,
          keep_alive: '10m',
          options: { ...options, num_predict: 8 },
        });
      }
      let peak = 0,
        peakVram = 0,
        contextLength = null,
        polling = false;
      const sample = async () => {
        if (polling) return;
        polling = true;
        try {
          const state = await json(endpoint('/api/ps'), undefined, 3000);
          const resident = state.models?.find((m) => m.name === model);
          if (resident) {
            peak = Math.max(peak, resident.size ?? 0);
            peakVram = Math.max(peakVram, resident.size_vram ?? 0);
            contextLength = resident.context_length;
          }
        } catch {
        } finally {
          polling = false;
        }
      };
      await sample();
      const timer = setInterval(() => void sample(), 500);
      const start = performance.now();
      let firstToken = null,
        raw = '',
        usage = null,
        error = null;
      try {
        // Match the app's conservative preflight instead of letting Ollama
        // silently truncate a prompt when comparing smaller context windows.
        const estimatedTokens = messages.reduce(
          (n, m) =>
            n +
            4 +
            Math.ceil(new TextEncoder().encode(m.content).byteLength / 4),
          2,
        );
        if (estimatedTokens + settings.maxOutputTokens > settings.contextTokens)
          throw new Error('context_window_exceeded');
        const r = await fetch(endpoint('/api/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(180000),
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            think: false,
            keep_alive: '10m',
            format: localRagFormat(profile),
            options,
          }),
        });
        if (!r.ok || !r.body) throw new Error(`Ollama HTTP ${r.status}`);
        const decoder = new TextDecoder();
        let buffer = '';
        const line = (text) => {
          if (!text.trim()) return;
          const event = JSON.parse(text);
          if (event.error) throw new Error(event.error);
          if (event.message?.content) {
            if (firstToken === null) firstToken = performance.now() - start;
            raw += event.message.content;
          }
          if (event.done) usage = event;
        };
        for await (const bytes of r.body) {
          buffer += decoder.decode(bytes, { stream: true });
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            line(buffer.slice(0, at));
            buffer = buffer.slice(at + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) line(buffer);
        if (!usage || usage.done_reason !== 'stop')
          throw new Error('Truncated/incomplete output');
      } catch (e) {
        error = e.message;
      } finally {
        clearInterval(timer);
      }
      const wall_ms = Math.round(performance.now() - start);
      await sample();
      let draft = null,
        valid = false;
      if (!error)
        try {
          draft = resolveGroundedDraft(JSON.parse(raw), retrieval);
          valid = true;
        } catch (e) {
          error = e.message;
        }
      const answer = draft?.claims.map((c) => c.text).join('\n') ?? '';
      const citations = draft?.claims.flatMap((c) => c.citations) ?? [];
      const formatOK = !/```/u.test(answer);
      const sourceOK =
        !item.source ||
        citations.some(
          (c) =>
            retrieval.sources.find((s) => s.id === c.source_id)?.source ===
            item.source,
        );
      // This task-specific rubric catches correct text linked to an unrelated
      // quote. It supplements, rather than replaces, manual semantic review.
      const quoteOK =
        item.unknown ||
        item.expected.every((pattern) =>
          new RegExp(pattern, 'iu').test(
            citations.map((c) => c.quote).join('\n'),
          ),
        );
      const rubricPass =
        valid &&
        formatOK &&
        quoteOK &&
        (item.unknown
          ? draft.unknown
          : !draft.unknown &&
            item.expected.every((pattern) =>
              new RegExp(pattern, 'iu').test(answer),
            ) &&
            sourceOK);
      const row = {
        id: item.id,
        split: item.split,
        round,
        question: item.question,
        raw,
        answer,
        draft,
        valid,
        rubric_pass: rubricPass,
        format_ok: formatOK,
        quote_rubric_pass: quoteOK,
        error,
        wall_ms,
        ttft_ms: firstToken === null ? null : Math.round(firstToken),
        peak_allocated_bytes: peak,
        peak_vram_bytes: peakVram,
        context_length: contextLength,
        usage: usage
          ? {
              finish_reason: usage.done_reason,
              input_tokens: usage.prompt_eval_count,
              output_tokens: usage.eval_count,
              load_ms: usage.load_duration / 1e6,
              prefill_ms: usage.prompt_eval_duration / 1e6,
              generation_ms: usage.eval_duration / 1e6,
              tokens_per_second: usage.eval_duration
                ? usage.eval_count / (usage.eval_duration / 1e9)
                : null,
            }
          : null,
      };
      report.rows.push(row);
      await writeFile(path, JSON.stringify(report, null, 2));
      console.log(
        `${profile} ${model} ${item.id} #${round + 1}: ${rubricPass ? 'PASS' : 'FAIL'} ${wall_ms}ms ${error ?? ''}`,
      );
    }
  const median = (values) => {
    const a = [...values].sort((a, b) => a - b);
    return a.length % 2
      ? a[(a.length - 1) / 2]
      : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  report.summary = {
    total: report.rows.length,
    pass: report.rows.filter((r) => r.rubric_pass).length,
    invalid: report.rows.filter((r) => !r.valid).length,
    median_ms: median(report.rows.map((r) => r.wall_ms)),
    median_ttft_ms: median(
      report.rows.map((r) => r.ttft_ms).filter((v) => v !== null),
    ),
    peak_allocated_bytes: Math.max(
      ...report.rows.map((r) => r.peak_allocated_bytes),
    ),
    peak_vram_bytes: Math.max(...report.rows.map((r) => r.peak_vram_bytes)),
    by_split: Object.fromEntries(
      ['dev', 'test'].map((split) => [
        split,
        {
          total: report.rows.filter((r) => r.split === split).length,
          pass: report.rows.filter((r) => r.split === split && r.rubric_pass)
            .length,
        },
      ]),
    ),
  };
  report.complete = true;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
  console.log(path);
} else throw new Error('Use prepare or run');
