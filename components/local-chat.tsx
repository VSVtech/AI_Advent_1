'use client';
/* oxlint-disable next/no-html-link-for-pages -- Standalone Vinext page. */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Cpu, Send, Square } from 'lucide-react';
import { MarkdownMessage } from '@/components/markdown-message';
import { Button } from '@/components/ui/button';
import { readChatStream } from '@/lib/read-chat-stream';
import {
  LOCAL_CHAT_KEY,
  LOCAL_EXAMPLES,
  localContext,
  restoreLocalChat,
  type LocalMessage,
  type LocalModel,
} from '@/lib/local-chat';

export function LocalChat() {
  const [models, setModels] = useState<LocalModel[]>([]);
  const [model, setModel] = useState('qwen2.5:7b');
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const active = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/local-chat', { signal });
      const data = (await response.json()) as {
        error?: string;
        models: LocalModel[];
      };
      if (!response.ok) throw new Error(data.error);
      setModels(data.models);
      setModel((current) =>
        data.models.some((m: LocalModel) => m.name === current)
          ? current
          : (data.models.find((m: LocalModel) => m.name === 'qwen2.5:7b')
              ?.name ??
            data.models[0]?.name ??
            ''),
      );
    } catch (e) {
      if (!signal?.aborted) {
        setModels([]);
        setError(
          e instanceof Error ? e.message : 'Не удалось загрузить модели.',
        );
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try {
        const saved = restoreLocalChat(localStorage.getItem(LOCAL_CHAT_KEY));
        setModel(saved.model);
        setMessages(saved.messages);
      } catch {
        setStorageError('Браузер не разрешил загрузить историю.');
      }
      setReady(true);
      void refresh(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      try {
        const saved = messages.slice(-60);
        while (JSON.stringify(saved).length > 250000) saved.shift();
        localStorage.setItem(
          LOCAL_CHAT_KEY,
          JSON.stringify({ model, messages: saved }),
        );
        setStorageError('');
      } catch {
        setStorageError('Не удалось сохранить историю в браузере.');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [messages, model, ready]);

  async function send() {
    if (
      active.current ||
      !text.trim() ||
      !model ||
      loading ||
      !models.some((m) => m.name === model)
    )
      return;
    const user: LocalMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text.trim(),
      status: 'complete',
    };
    const reply: LocalMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'streaming',
      model,
    };
    const next = [...messages, user];
    const controller = new AbortController();
    active.current = controller;
    setMessages([...next, reply]);
    setText('');
    setBusy(true);
    setError('');
    const start = performance.now();
    let content = '',
      done = false;
    const update = (patch: Partial<LocalMessage>) =>
      setMessages((current) =>
        current.map((m) => (m.id === reply.id ? { ...m, ...patch } : m)),
      );
    try {
      const response = await fetch('/api/local-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: localContext(next) }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? 'Локальная модель недоступна.');
      }
      await readChatStream(response.body, (event) => {
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'delta') {
          content += event.content;
          update({ content });
        }
        if (event.type === 'done') {
          done = true;
          update({
            status: event.finishReason === 'length' ? 'stopped' : 'complete',
            tokens: event.outputTokens,
            seconds: (performance.now() - start) / 1000,
          });
          if (event.finishReason === 'length')
            setError(
              'Ответ достиг лимита 1024 токена. Задайте более узкий вопрос.',
            );
        }
      });
      if (!done) throw new Error('Ответ оборвался до завершения.');
    } catch (e) {
      update({ status: controller.signal.aborted ? 'stopped' : 'error' });
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Ошибка локальной модели.');
    } finally {
      active.current = null;
      setBusy(false);
      textarea.current?.focus();
    }
  }
  return (
    <main className="local-chat-page min-h-dvh px-4 py-6 text-white sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Cpu className="size-8 text-emerald-300" />
            <div>
              <h1 className="text-xl font-semibold">Локальная LLM</h1>
              <p className="text-sm text-white/50">
                День 26 · Ollama · всё на этом компьютере
              </p>
            </div>
          </div>
          <a
            href="/"
            className="flex items-center gap-2 text-sm text-white/70 hover:text-white"
          >
            <ArrowLeft className="size-4" />К агентам
          </a>
        </header>
        <section
          aria-label="Локальная модель"
          className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4"
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 space-y-2">
              <span className="block text-sm">Модель</span>
              <select
                aria-label="Локальная модель"
                value={model}
                disabled={busy || loading || !models.length}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-white/20 bg-[#15201f] p-2.5 text-sm"
              >
                {!models.length && (
                  <option value={model}>
                    {loading ? 'Проверяем Ollama…' : 'Нет доступных моделей'}
                  </option>
                )}
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} · {(m.size / 1e9).toFixed(1)} ГБ
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              disabled={busy || loading}
              onClick={() => void refresh()}
            >
              Обновить модели
            </Button>
            <Button
              variant="outline"
              disabled={busy || !messages.length}
              onClick={() => {
                setMessages([]);
                setError('');
              }}
            >
              Новый диалог
            </Button>
          </div>
          <p className="text-xs text-white/55">
            {loading
              ? 'Подключение…'
              : models.length
                ? '● Ollama доступна'
                : 'Ollama не готова'}{' '}
            · Прямой диалог без RAG и облачных запросов. История хранится
            отдельно в этом браузере.
          </p>
          {!loading && !models.length && (
            <p className="text-sm text-amber-200">
              Запустите <code>pnpm rag:ollama</code>. Если модели ещё нет,
              установите её: <code>ollama pull qwen2.5:7b</code>, затем обновите
              список.
            </p>
          )}
        </section>
        <section
          aria-label="Три тестовых запроса"
          className="grid gap-3 sm:grid-cols-3"
        >
          {LOCAL_EXAMPLES.map((item, i) => (
            <button
              key={item.level}
              disabled={busy}
              onClick={() => {
                setText(item.prompt);
                textarea.current?.focus();
              }}
              className="flex flex-col items-start rounded-xl border border-white/10 p-4 text-left transition hover:border-emerald-300/40 disabled:opacity-40"
            >
              <span className="text-sm font-medium text-emerald-200">
                {i + 1}. {item.level}
              </span>
              <span className="mt-2 block text-xs leading-5 text-white/60">
                {item.prompt}
              </span>
            </button>
          ))}
        </section>
        <section
          aria-label="История локального диалога"
          aria-live="polite"
          className="space-y-4"
        >
          {!messages.length && (
            <p className="py-8 text-center text-white/45">
              Выберите тестовый запрос или напишите свой.
            </p>
          )}
          {messages.map((m) => (
            <article
              key={m.id}
              className={`rounded-2xl border p-5 ${m.role === 'user' ? 'ml-6 border-emerald-300/15 bg-emerald-300/[0.06]' : 'border-white/10 bg-white/[0.025]'}`}
            >
              <p className="mb-3 text-xs text-white/45">
                {m.role === 'user' ? 'Вы' : (m.model ?? 'Локальная модель')}
              </p>
              <div className="prose prose-invert max-w-none break-words text-sm leading-7 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-3">
                <MarkdownMessage
                  content={
                    m.content ||
                    (m.status === 'streaming'
                      ? 'Модель готовит ответ…'
                      : 'Ответ не получен.')
                  }
                />
              </div>
              {m.role === 'assistant' && (
                <p className="mt-3 text-xs text-white/40">
                  {m.status === 'streaming'
                    ? 'Генерация…'
                    : m.status === 'stopped'
                      ? 'Ответ остановлен'
                      : m.status === 'error'
                        ? 'Ошибка'
                        : 'Готово'}
                  {typeof m.tokens === 'number' ? ` · ${m.tokens} токенов` : ''}
                  {typeof m.seconds === 'number'
                    ? ` · ${m.seconds.toFixed(1)} с`
                    : ''}
                </p>
              )}
            </article>
          ))}
        </section>
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-400/30 p-4 text-sm text-red-200"
          >
            {error}
          </p>
        )}
        {storageError && (
          <p role="alert" className="text-sm text-amber-200">
            {storageError}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="space-y-3 rounded-2xl border border-emerald-300/20 bg-[#121e1d] p-4"
        >
          <label htmlFor="local-question" className="text-sm text-white/70">
            Сообщение локальной модели
          </label>
          <textarea
            ref={textarea}
            id="local-question"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
            rows={3}
            placeholder="Задайте вопрос…"
            className="w-full resize-y rounded-lg border border-white/15 bg-black/15 p-3 text-sm outline-none focus:border-emerald-300/50"
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-lg text-xs text-white/40">
              Enter — отправить · Shift+Enter — новая строка. В контексте до 12
              последних сообщений, не более 16 000 символов. Сохраняются
              последние 60 сообщений.
            </p>
            {busy ? (
              <Button type="button" onClick={() => active.current?.abort()}>
                <Square className="size-4" />
                Остановить
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!ready || !text.trim() || loading || !models.length}
              >
                <Send className="size-4" />
                Отправить
              </Button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}
