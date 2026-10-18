'use client';
/* oxlint-disable next/no-html-link-for-pages -- Standalone Vinext page. */
import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, Send, Square } from 'lucide-react';

import { MarkdownMessage } from '@/components/markdown-message';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODEL } from '@/lib/chat-constraints';
import { readChatStream } from '@/lib/read-chat-stream';
import {
  RC_CAR_SYMPTOMS,
  rcCarCommand,
  type RcCarSnapshot,
  type ScopeCapture,
} from '@/lib/rc-car-types';

type Answer = {
  content: string;
  tools: string[];
  sources: string[];
  status: 'streaming' | 'complete' | 'error' | 'stopped';
};

const WIDTH = 320;
const HEIGHT = 96;

function Trace({ capture }: { capture: ScopeCapture }) {
  const { points, measurement: m } = capture;
  const top = Math.max(m.vmaxV, 0.5);
  const low = Math.min(m.vminV, 0);
  const range = top - low || 1;
  const y = (v: number) => HEIGHT - 8 - ((v - low) / range) * (HEIGHT - 16);
  const x = (t: number) => (t / m.windowMs) * WIDTH;
  const upper = points.map((p) => `${x(p.tMs)},${y(p.maxV)}`);
  const lower = [...points].reverse().map((p) => `${x(p.tMs)},${y(p.minV)}`);
  return (
    <figure className="rounded-xl border border-white/10 bg-black/20 p-3">
      <figcaption className="mb-2 flex justify-between gap-2 text-xs text-white/70">
        <span>
          CH{capture.channel} · {capture.label}
        </span>
        <span className="shrink-0 text-white/40">{capture.probe}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Осциллограмма канала ${capture.channel}`}
        className="h-24 w-full"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0"
            x2={WIDTH}
            y1={HEIGHT * f}
            y2={HEIGHT * f}
            stroke="rgba(255,255,255,0.07)"
          />
        ))}
        <polygon
          points={[...upper, ...lower].join(' ')}
          fill="rgba(110,231,183,0.35)"
          stroke="rgb(110,231,183)"
          strokeWidth="1"
        />
      </svg>
      <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-white/55">
        <span>
          {m.vminV.toFixed(2)}…{m.vmaxV.toFixed(2)} В
        </span>
        {m.baselineV !== null && <span>до старта {m.baselineV.toFixed(2)} В</span>}
        {m.sagV !== null && (
          <span className={m.sagV >= 1 ? 'text-amber-300' : ''}>
            просадка {m.sagV.toFixed(2)} В
          </span>
        )}
        {m.freqHz !== null && <span>{m.freqHz.toFixed(0)} Гц</span>}
        {m.dutyPct !== null && <span>скв. {m.dutyPct.toFixed(0)} %</span>}
        {m.kind === 'flat' && <span>сигнала нет</span>}
      </p>
    </figure>
  );
}

export function RcCarDesk() {
  const [snapshot, setSnapshot] = useState<RcCarSnapshot | null>(null);
  const [symptom, setSymptom] = useState<string>(RC_CAR_SYMPTOMS[0]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const active = useRef<AbortController | null>(null);
  const busy = answer?.status === 'streaming';

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/rc-car', { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as RcCarSnapshot & { error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Не удалось загрузить данные.');
        setSnapshot(data);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Ошибка загрузки данных.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  async function diagnose() {
    const text = symptom.trim();
    if (!text || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setAnswer({ content: '', tools: [], sources: [], status: 'streaming' });
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: rcCarCommand(text) }],
          model: DEFAULT_MODEL,
          useMcpTools: true,
          useRag: true,
          useSystemPrompt: false,
          maxOutputTokens: 6000,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = (await response.json()) as { error?: { message?: string } };
        throw new Error(data.error?.message ?? 'Ассистент недоступен.');
      }
      let done = false;
      await readChatStream(response.body, (event) => {
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'rag')
          setAnswer((a) =>
            a
              ? {
                  ...a,
                  sources: [...new Set(event.retrieval.sources.map((s) => s.source))],
                }
              : a,
          );
        if (event.type === 'delta')
          setAnswer((a) => (a ? { ...a, content: a.content + event.content } : a));
        if (event.type === 'done') {
          done = true;
          setAnswer((a) =>
            a ? { ...a, tools: event.mcpTools ?? [], status: 'complete' } : a,
          );
        }
      });
      if (!done) throw new Error('Ответ оборвался до завершения.');
    } catch (e) {
      const stopped = controller.signal.aborted;
      setAnswer((a) => (a ? { ...a, status: stopped ? 'stopped' : 'error' } : a));
      if (!stopped) setError(e instanceof Error ? e.message : 'Не удалось получить ответ.');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  return (
    <main className="min-h-screen bg-[#0b1110] p-4 text-white sm:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-center gap-3">
          <a href="/" className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white">
            <ArrowLeft className="size-4" aria-hidden="true" /> Агенты
          </a>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Activity className="size-5 text-emerald-300" aria-hidden="true" />
            Диагностика RC-машинки
          </h1>
          <span className="rounded-full border border-amber-300/40 px-3 py-1 text-xs text-amber-200">
            симулятор: данные синтезируются
          </span>
          <p className="basis-full text-sm text-white/55">
            Ассистент читает телеметрию, настройки прошивки и измерения осциллографа
            (MCP «RC-машинка»), сверяет их со справочником (RAG) и называет причину.
            Тот же режим — команда <code>/diagnose симптом</code> в любом чате.
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <section aria-label="Осциллограф и телеметрия" className="space-y-3">
            {loading && <p className="text-sm text-white/50">Чтение данных…</p>}
            {snapshot && (
              <>
                <p className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-white/70">
                  Телеметрия: <code>{snapshot.telemetry.raw}</code> · впереди{' '}
                  {snapshot.telemetry.frontCm >= 200 ? 'свободно' : `${snapshot.telemetry.frontCm} см`} · моторы L{' '}
                  {snapshot.telemetry.motorLeft} / R {snapshot.telemetry.motorRight}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {snapshot.captures.map((capture) => (
                    <Trace key={capture.channel} capture={capture} />
                  ))}
                </div>
                <p className="text-xs text-white/40">
                  Захват по запуску моторов, окно 60 мс; заливка — огибающая min/max.
                </p>
              </>
            )}
          </section>

          <section aria-label="Диагностика" className="space-y-4">
            <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap gap-2">
                {RC_CAR_SYMPTOMS.map((item) => (
                  <button
                    key={item}
                    disabled={busy}
                    onClick={() => setSymptom(item)}
                    className="rounded-full border border-white/15 px-3 py-1 text-left text-xs text-white/70 hover:border-emerald-300/40 disabled:opacity-40"
                  >
                    {item}
                  </button>
                ))}
              </div>
              <textarea
                aria-label="Симптом"
                value={symptom}
                onChange={(e) => setSymptom(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-white/20 bg-[#15201f] p-3 text-sm"
              />
              <div className="flex gap-2">
                <Button disabled={busy || !symptom.trim()} onClick={() => void diagnose()}>
                  <Send className="size-4" aria-hidden="true" /> Диагностировать
                </Button>
                {busy && (
                  <Button variant="outline" onClick={() => active.current?.abort()}>
                    <Square className="size-4" aria-hidden="true" /> Остановить
                  </Button>
                )}
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded-xl border border-red-400/30 p-4 text-sm text-red-200">
                {error}
              </p>
            )}

            {answer && (
              <article aria-live="polite" className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
                <div className="prose prose-invert max-w-none break-words text-sm leading-7 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-3">
                  <MarkdownMessage
                    content={
                      answer.content ||
                      (answer.status === 'streaming'
                        ? 'Ассистент изучает телеметрию и запрашивает измерения…'
                        : 'Ответ не получен.')
                    }
                  />
                </div>
                <p className="mt-3 text-xs text-white/40">
                  {answer.status === 'streaming' ? 'Генерация…' : 'Готово'}
                  {answer.tools.length ? ` · MCP: ${answer.tools.join(' → ')}` : ''}
                  {answer.sources.length ? ` · RAG: ${answer.sources.join(', ')}` : ''}
                </p>
              </article>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
