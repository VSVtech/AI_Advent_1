'use client';
/* oxlint-disable next/no-html-link-for-pages -- Standalone Vinext page. */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Headset, Send, Square } from 'lucide-react';

import { MarkdownMessage } from '@/components/markdown-message';
import { Button } from '@/components/ui/button';
import { DEFAULT_MODEL } from '@/lib/chat-constraints';
import { readChatStream } from '@/lib/read-chat-stream';
import {
  SUPPORT_QUESTIONS,
  supportCommand,
  type SupportTicket,
} from '@/lib/support-tickets';

type Answer = {
  question: string;
  ticketId: string | null;
  content: string;
  tools: string[];
  sources: string[];
  status: 'streaming' | 'complete' | 'error' | 'stopped';
};

export function SupportDesk() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [question, setQuestion] = useState<string>(SUPPORT_QUESTIONS[0]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const active = useRef<AbortController | null>(null);
  const busy = answer?.status === 'streaming';

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/support/tickets', { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as {
          error?: string;
          tickets?: SupportTicket[];
        };
        if (!response.ok || !data.tickets)
          throw new Error(data.error ?? 'Не удалось загрузить тикеты.');
        setTickets(data.tickets);
        setTicketId((current) => current ?? data.tickets?.[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Ошибка загрузки тикетов.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  async function ask() {
    const text = question.trim();
    if (!text || busy) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    const next: Answer = {
      question: text,
      ticketId,
      content: '',
      tools: [],
      sources: [],
      status: 'streaming',
    };
    setAnswer(next);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: supportCommand(ticketId, text) }],
          model: DEFAULT_MODEL,
          useMcpTools: true,
          useRag: true,
          useSystemPrompt: false,
          maxOutputTokens: 4000,
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
                  sources: [
                    ...new Set(event.retrieval.sources.map((s) => s.source)),
                  ],
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
      if (!stopped)
        setError(e instanceof Error ? e.message : 'Не удалось получить ответ.');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  const selected = tickets.find((t) => t.id === ticketId);

  return (
    <main className="min-h-screen bg-[#0b1110] p-4 text-white sm:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-center gap-3">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white"
          >
            <ArrowLeft className="size-4" aria-hidden="true" /> Агенты
          </a>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Headset className="size-5 text-emerald-300" aria-hidden="true" />
            Ассистент поддержки
          </h1>
          <p className="basis-full text-sm text-white/55">
            Ответ строится по FAQ (RAG) и данным тикета и пользователя (MCP
            «Поддержка»). Тот же режим доступен в любом чате командой{' '}
            <code>/support TCK-1001 вопрос</code>.
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          <section aria-label="Тикеты" className="space-y-2">
            {loading && <p className="text-sm text-white/50">Загрузка тикетов…</p>}
            {tickets.map((t) => (
              <button
                key={t.id}
                disabled={busy}
                onClick={() => setTicketId(t.id)}
                aria-pressed={t.id === ticketId}
                className={`w-full rounded-xl border p-3 text-left text-sm transition disabled:opacity-50 ${t.id === ticketId ? 'border-emerald-300/50 bg-emerald-300/10' : 'border-white/10 hover:border-white/25'}`}
              >
                <span className="flex justify-between text-xs text-white/50">
                  <span>{t.id}</span>
                  <span>{t.userName}</span>
                </span>
                <span className="mt-1 block">{t.subject}</span>
              </button>
            ))}
          </section>

          <section aria-label="Вопрос ассистенту" className="space-y-4">
            <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-sm text-white/60">
                {selected
                  ? `${selected.id} · ${selected.userName} · «${selected.subject}»`
                  : 'Тикет не выбран: ассистент ответит только по FAQ.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {SUPPORT_QUESTIONS.map((item) => (
                  <button
                    key={item}
                    disabled={busy}
                    onClick={() => setQuestion(item)}
                    className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70 hover:border-emerald-300/40 disabled:opacity-40"
                  >
                    {item}
                  </button>
                ))}
              </div>
              <textarea
                aria-label="Вопрос"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-white/20 bg-[#15201f] p-3 text-sm"
              />
              <div className="flex gap-2">
                <Button disabled={busy || !question.trim()} onClick={() => void ask()}>
                  <Send className="size-4" aria-hidden="true" /> Спросить
                </Button>
                {busy && (
                  <Button variant="outline" onClick={() => active.current?.abort()}>
                    <Square className="size-4" aria-hidden="true" /> Остановить
                  </Button>
                )}
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-red-400/30 p-4 text-sm text-red-200"
              >
                {error}
              </p>
            )}

            {answer && (
              <article
                aria-live="polite"
                className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"
              >
                <div className="prose prose-invert max-w-none break-words text-sm leading-7 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-3">
                  <MarkdownMessage
                    content={
                      answer.content ||
                      (answer.status === 'streaming'
                        ? 'Ассистент изучает тикет…'
                        : 'Ответ не получен.')
                    }
                  />
                </div>
                <p className="mt-3 text-xs text-white/40">
                  {answer.status === 'streaming' ? 'Генерация…' : 'Готово'}
                  {answer.tools.length
                    ? ` · MCP: ${answer.tools.join(' → ')}`
                    : ''}
                  {answer.sources.length
                    ? ` · FAQ/RAG: ${answer.sources.join(', ')}`
                    : ''}
                </p>
              </article>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
