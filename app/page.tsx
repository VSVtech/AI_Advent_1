'use client';

import {
  ArrowUp,
  Bot,
  CircleAlert,
  Sparkles,
  Square,
  Trash2,
  UserRound,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '@/components/ui/message';
import { Textarea } from '@/components/ui/textarea';
import type {
  ApiChatMessage,
  ChatErrorPayload,
  ChatMessage,
  ChatStreamEvent,
} from '@/lib/chat-types';
import { readChatStream } from '@/lib/read-chat-stream';

const suggestions = [
  'Объясни сложную тему простыми словами',
  'Помоги придумать структуру проекта',
  'Разбери идею и найди слабые места',
];

function createId(): string {
  return crypto.randomUUID();
}

function toApiMessages(messages: ChatMessage[]): ApiChatMessage[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map(({ role, content }) => ({ role, content }));
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({
      behavior: isGenerating ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [messages, isGenerating]);

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

  const updateAssistant = (
    id: string,
    update: (message: ChatMessage) => ChatMessage,
  ) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? update(message) : message)),
    );
  };

  const removeEmptyAssistant = (id: string, status: 'stopped' | 'error') => {
    setMessages((current) =>
      current.flatMap((message) => {
        if (message.id !== id) return [message];
        return message.content.trim() ? [{ ...message, status }] : [];
      }),
    );
  };

  const sendMessage = async (rawContent?: string) => {
    const content = (rawContent ?? input).trim();
    if (!content || isGenerating) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content,
      status: 'complete',
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: '',
      status: 'streaming',
    };
    const requestMessages = toApiMessages([...messages, userMessage]);
    const controller = new AbortController();

    abortControllerRef.current = controller;
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput('');
    setError(null);
    setIsGenerating(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: requestMessages }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = (await response
          .json()
          .catch(() => null)) as ChatErrorPayload | null;
        throw new Error(
          payload?.error.message ?? 'Не удалось получить ответ от DeepSeek.',
        );
      }

      if (!response.body) {
        throw new Error('DeepSeek вернул пустой ответ. Попробуйте ещё раз.');
      }

      let completed = false;

      await readChatStream(response.body, (event: ChatStreamEvent) => {
        if (event.type === 'delta') {
          updateAssistant(assistantMessage.id, (message) => ({
            ...message,
            content: message.content + event.content,
          }));
        } else if (event.type === 'done') {
          completed = true;
          updateAssistant(assistantMessage.id, (message) => ({
            ...message,
            status: 'complete',
          }));
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      });

      if (!completed) {
        updateAssistant(assistantMessage.id, (message) => ({
          ...message,
          status: 'complete',
        }));
      }
    } catch (caughtError) {
      if (controller.signal.aborted) {
        removeEmptyAssistant(assistantMessage.id, 'stopped');
      } else {
        removeEmptyAssistant(assistantMessage.id, 'error');
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : 'Не удалось получить ответ от DeepSeek.',
        );
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsGenerating(false);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const stopGeneration = () => abortControllerRef.current?.abort();

  const clearChat = () => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setError(null);
    setInput('');
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const latestAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');

  return (
    <main className="chat-shell">
      <div className="chat-frame">
        <header className="chat-header">
          <div className="flex min-w-0 items-center gap-3">
            <span className="brand-mark" aria-hidden="true">
              <Sparkles className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-white">
                DeepSeek Chat
              </h1>
              <p className="truncate text-xs text-white/40">
                Локальный AI-диалог
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge className="model-badge" variant="outline">
              <span className="status-dot" aria-hidden="true" />
              <span className="hidden sm:inline">V4 Flash</span>
              <span className="sm:hidden">V4</span>
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="header-action"
              aria-label="Очистить диалог"
              disabled={messages.length === 0}
              onClick={clearChat}
            >
              <Trash2 />
            </Button>
          </div>
        </header>

        <section className="chat-content" aria-label="История диалога">
          {messages.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon" aria-hidden="true">
                <Bot className="size-7" />
              </span>
              <div className="space-y-2 text-center">
                <h2 className="text-xl font-semibold tracking-[-0.025em] text-white sm:text-2xl">
                  О чём поговорим?
                </h2>
                <p className="mx-auto max-w-md text-sm leading-6 text-white/45">
                  Ответы приходят напрямую из DeepSeek. История останется только
                  до обновления страницы.
                </p>
              </div>

              <div className="suggestion-grid">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="suggestion-card"
                    disabled={isGenerating}
                    onClick={() => void sendMessage(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-list">
              {messages.map((message) => {
                const isUser = message.role === 'user';

                return (
                  <Message
                    key={message.id}
                    align={isUser ? 'end' : 'start'}
                    className="message-row"
                  >
                    <MessageAvatar
                      className={isUser ? 'user-avatar' : 'assistant-avatar'}
                      aria-hidden="true"
                    >
                      {isUser ? <UserRound /> : <Sparkles />}
                    </MessageAvatar>
                    <MessageContent
                      className={isUser ? 'items-end' : undefined}
                    >
                      <MessageHeader className="message-author">
                        {isUser ? 'Вы' : 'DeepSeek'}
                      </MessageHeader>
                      <div
                        className={
                          isUser ? 'user-message' : 'assistant-message'
                        }
                      >
                        {message.content ? (
                          isUser ? (
                            <p className="whitespace-pre-wrap">
                              {message.content}
                            </p>
                          ) : (
                            <div className="markdown-body">
                              <MarkdownMessage content={message.content} />
                            </div>
                          )
                        ) : (
                          <span
                            className="typing-indicator"
                            aria-label="DeepSeek отвечает"
                          >
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                      </div>
                      {!isUser && message.status === 'stopped' ? (
                        <MessageFooter className="message-status">
                          Генерация остановлена
                        </MessageFooter>
                      ) : null}
                      {!isUser && message.status === 'error' ? (
                        <MessageFooter className="message-status text-red-300/60">
                          Ответ прерван
                        </MessageFooter>
                      ) : null}
                    </MessageContent>
                  </Message>
                );
              })}
              <div ref={endOfMessagesRef} className="h-px" />
            </div>
          )}
        </section>

        <footer className="composer-wrap">
          {error ? (
            <Alert variant="destructive" className="error-alert">
              <CircleAlert />
              <AlertTitle>Не удалось получить ответ</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <form className="composer" onSubmit={handleSubmit}>
            <Textarea
              ref={textareaRef}
              aria-label="Сообщение для DeepSeek"
              placeholder="Напишите сообщение…"
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              className="composer-input"
            />
            {isGenerating ? (
              <Button
                type="button"
                size="icon-lg"
                className="stop-button"
                aria-label="Остановить генерацию"
                onClick={stopGeneration}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-lg"
                className="send-button"
                aria-label="Отправить сообщение"
                disabled={!input.trim()}
              >
                <ArrowUp className="size-[18px]" />
              </Button>
            )}
          </form>
          <p className="composer-hint">
            Enter — отправить · Shift + Enter — новая строка
          </p>
        </footer>

        <output className="sr-only" aria-live="polite" aria-atomic="true">
          {isGenerating
            ? 'DeepSeek отвечает'
            : latestAssistant?.status === 'complete'
              ? 'Ответ DeepSeek завершён'
              : latestAssistant?.status === 'stopped'
                ? 'Генерация остановлена'
                : ''}
        </output>
      </div>
    </main>
  );
}
