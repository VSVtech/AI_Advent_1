'use client';

import { tokenize, type ShjToken } from '@speed-highlight/core';
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

import { MarkdownMessage } from '@/components/markdown-message';
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
import { useAgentSnapshot } from '@/hooks/use-agent';
import type { Agent } from '@/lib/agent';
import { formatModelLabel } from '@/lib/chat-constraints';
import type { ChatOutputFormat } from '@/lib/chat-types';

const suggestions = [
  'Объясни сложную тему простыми словами',
  'Помоги придумать структуру проекта',
  'Разбери идею и найди слабые места',
];

type StructuredFormat = Exclude<ChatOutputFormat, 'text'>;

type HighlightToken = {
  text: string;
  type?: ShjToken;
};

function StructuredMessage({
  content,
  format,
}: {
  content: string;
  format: StructuredFormat;
}) {
  const [tokens, setTokens] = useState<HighlightToken[]>([{ text: content }]);

  useEffect(() => {
    let cancelled = false;
    const nextTokens: HighlightToken[] = [];

    void tokenize(content, format, (text, type) => {
      if (text) nextTokens.push({ text, type });
    }).then(() => {
      if (!cancelled) {
        setTokens(nextTokens.length ? nextTokens : [{ text: content }]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [content, format]);

  return (
    <div className="structured-output-frame">
      <div className="structured-output-header">
        <span>{format.toUpperCase()}</span>
      </div>
      <pre className="structured-output">
        <code>
          {tokens.map((token, index) => (
            <span
              key={`${index}-${token.type ?? 'plain'}`}
              className={token.type ? `syntax-${token.type}` : undefined}
            >
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function AgentChat({ agent }: { agent: Agent }) {
  const { messages, isGenerating, error } = useAgentSnapshot(agent);
  const [input, setInput] = useState('');
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({
      behavior: isGenerating ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [messages, isGenerating]);

  useEffect(() => {
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [agent]);

  const sendMessage = (rawContent?: string) => {
    const content = (rawContent ?? input).trim();
    if (!content || isGenerating) return;

    setInput('');
    void agent.sendMessage(content).finally(() => {
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    });
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const latestOutputTokens = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        typeof message.outputTokens === 'number',
    )?.outputTokens;

  return (
    <div className="chat-frame">
      <header className="chat-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="brand-mark shrink-0" aria-hidden="true">
            <Sparkles className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-white">
              {agent.name}
            </h1>
            <p className="truncate text-xs text-white/40">
              Температура {agent.config.temperature} · формат{' '}
              {agent.config.outputFormat.toUpperCase()}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge className="model-badge" variant="outline">
            <span className="status-dot" aria-hidden="true" />
            <span className="hidden sm:inline">
              {formatModelLabel(agent.config.model)}
            </span>
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="header-action"
            aria-label="Очистить историю диалога"
            disabled={messages.length === 0}
            onClick={() => agent.clearHistory()}
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
                Ответы приходят напрямую из DeepSeek. У этого агента своя
                отдельная история диалога.
              </p>
            </div>

            <div className="suggestion-grid">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion-card"
                  disabled={isGenerating}
                  onClick={() => sendMessage(suggestion)}
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
                  <MessageContent className={isUser ? 'items-end' : undefined}>
                    <MessageHeader className="message-author">
                      {isUser ? 'Вы' : agent.name}
                    </MessageHeader>
                    <div
                      className={isUser ? 'user-message' : 'assistant-message'}
                    >
                      {message.content ? (
                        isUser ? (
                          <p className="whitespace-pre-wrap">
                            {message.content}
                          </p>
                        ) : message.format && message.format !== 'text' ? (
                          <StructuredMessage
                            content={message.content}
                            format={message.format}
                          />
                        ) : (
                          <div className="markdown-body">
                            <MarkdownMessage content={message.content} />
                          </div>
                        )
                      ) : (
                        <span
                          className="typing-indicator"
                          aria-label="Агент отвечает"
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
            aria-label="Сообщение агенту"
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
              onClick={() => agent.stop()}
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
          {typeof latestOutputTokens === 'number'
            ? ` · последний ответ: ${latestOutputTokens} ток.`
            : ''}
        </p>
      </footer>

      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {isGenerating ? 'Агент отвечает' : ''}
      </output>
    </div>
  );
}
