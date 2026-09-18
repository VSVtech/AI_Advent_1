'use client';

import { tokenize, type ShjToken } from '@speed-highlight/core';
import {
  ArrowUp,
  Bot,
  GitBranch,
  CircleAlert,
  FileText,
  ImageIcon,
  Paperclip,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { MarkdownMessage } from '@/components/markdown-message';
import { AgentMemoryDialog } from '@/components/agent-memory-dialog';
import {
  AgentMemoryPanel,
  AgentMemoryPanelSheet,
} from '@/components/agent-memory-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
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
import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatOutputFormat,
} from '@/lib/chat-types';
import {
  ATTACHMENT_INPUT_ACCEPT,
  classifyAttachment,
  formatFileSize,
  isVisionModel,
  validateAttachmentFiles,
} from '@/lib/file-attachments';

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

function AttachmentIcon({ kind }: { kind: ChatAttachmentKind }) {
  return kind === 'image' ? <ImageIcon /> : <FileText />;
}

function SentAttachment({ attachment }: { attachment: ChatAttachment }) {
  return (
    <Attachment size="xs" className="sent-attachment">
      <AttachmentMedia>
        <AttachmentIcon kind={attachment.kind} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.name}</AttachmentTitle>
        <AttachmentDescription>
          {attachment.kind === 'image' ? 'изображение' : 'текст'} ·{' '}
          {formatFileSize(attachment.size)}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}

function PendingAttachment({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const kind = classifyAttachment(file) ?? 'text';

  return (
    <Attachment size="xs" className="pending-attachment">
      <AttachmentMedia>
        <AttachmentIcon kind={kind} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{file.name}</AttachmentTitle>
        <AttachmentDescription>
          {formatFileSize(file.size)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction
          type="button"
          aria-label={`Убрать файл «${file.name}»`}
          onClick={onRemove}
        >
          <X />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

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

// Composes the three token counts requested for each answer: the current
// request (an approximate count of just the latest user message), the whole
// input context (the exact input-token usage DeepSeek reports — the full
// history, latest request, and system prompt it processed for this answer),
// and the model's response (exact output tokens). Any missing piece is
// simply omitted rather than shown as a placeholder.
function formatTokenStats({
  requestTokens,
  contextTokens,
  contextWindowTokens,
  cachedContextTokens,
  outputTokens,
}: {
  requestTokens: number | undefined;
  contextTokens: number | undefined;
  contextWindowTokens: number;
  cachedContextTokens: number | undefined;
  outputTokens: number | undefined;
}): string | null {
  const parts: string[] = [];

  if (requestTokens !== undefined) {
    parts.push(`запрос ~${requestTokens}`);
  }
  if (contextTokens !== undefined) {
    const usagePercent = (contextTokens / contextWindowTokens) * 100;
    const usageLabel =
      usagePercent < 1 ? '<1%' : `${Math.round(usagePercent)}%`;
    const contextLabel = `контекст ${contextTokens}/${contextWindowTokens} (${usageLabel})`;
    parts.push(
      cachedContextTokens
        ? `${contextLabel}, кэш ${cachedContextTokens}`
        : contextLabel,
    );
  }
  if (outputTokens !== undefined) {
    parts.push(`ответ ${outputTokens}`);
  }

  return parts.length ? `Токены: ${parts.join(' · ')}` : null;
}

export function AgentChat({ agent }: { agent: Agent }) {
  const { messages, isGenerating, error } = useAgentSnapshot(agent);
  const [input, setInput] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [mergeWithBranchId, setMergeWithBranchId] = useState('');
  const [branchFeedback, setBranchFeedback] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mergeCandidates = agent
    .getBranches()
    .filter((branch) => branch.id !== agent.getActiveBranchId());
  const selectedMergeBranchId = mergeCandidates.some(
    (branch) => branch.id === mergeWithBranchId,
  )
    ? mergeWithBranchId
    : (mergeCandidates.at(-1)?.id ?? '');
  const activeBranchSummary = agent.getActiveBranchSummary();

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
    if ((!content && selectedFiles.length === 0) || isGenerating) return;

    setInput('');
    const files = selectedFiles;
    setSelectedFiles([]);
    setAttachmentError(null);
    void agent.sendMessage(content, files).finally(() => {
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    });
  };

  const handleFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const pickedFiles = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!pickedFiles.length) return;

    const knownFiles = new Set(
      selectedFiles.map(
        (file) => `${file.name}:${file.size}:${file.lastModified}`,
      ),
    );
    const nextFiles = [
      ...selectedFiles,
      ...pickedFiles.filter(
        (file) =>
          !knownFiles.has(`${file.name}:${file.size}:${file.lastModified}`),
      ),
    ];
    const validation = validateAttachmentFiles(nextFiles);

    if (!validation.ok) {
      setAttachmentError(validation.message);
      return;
    }
    if (
      nextFiles.some((file) => classifyAttachment(file) === 'image') &&
      !isVisionModel(agent.config.model)
    ) {
      setAttachmentError(
        'Для изображений нужен агент с моделью DeepSeek Flash.',
      );
      return;
    }

    setSelectedFiles(nextFiles);
    setAttachmentError(null);
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendMessage();
  };

  const handleCreateBranches = () => {
    const created = agent.createBranches();
    if (!created) {
      setBranchFeedback({
        tone: 'error',
        text: 'Не удалось создать ветки. Проверьте checkpoint и попробуйте снова.',
      });
      return;
    }

    const branches = agent.getBranches();
    const firstName =
      branches.find((branch) => branch.id === created[0])?.name ??
      'первая ветка';
    const secondName =
      branches.find((branch) => branch.id === created[1])?.name ??
      'вторая ветка';
    setBranchFeedback({
      tone: 'success',
      text: `Созданы «${firstName}» и «${secondName}». Сейчас активна «${firstName}».`,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-workspace">
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
                {agent.config.outputFormat.toUpperCase()} · цель{' '}
                {agent.config.targetOutputTokens === null
                  ? 'без ограничения'
                  : `${agent.config.targetOutputTokens} ток.`}{' '}
                · окно {agent.config.contextWindowTokens} ток.
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
            <AgentMemoryPanelSheet agent={agent} />
            <AgentMemoryDialog agent={agent} isGenerating={isGenerating} />
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

        {agent.config.contextStrategy === 'branching' ? (
          <section
            className="max-h-[min(30dvh,18rem)] shrink-0 overflow-y-auto border-b border-white/10 px-4 py-3 sm:px-6"
            aria-label="Ветки диалога"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white/85">
                <GitBranch
                  className="size-4 text-emerald-300/80"
                  aria-hidden="true"
                />
                Ветки диалога
                <span className="font-normal text-white/40">
                  {agent.getBranches().length}
                </span>
              </h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9 border-white/15 bg-white/[0.035] px-3 text-white/85 hover:bg-white/[0.08]"
                disabled={isGenerating || agent.getBranches().length > 18}
                onClick={handleCreateBranches}
              >
                Создать 2 ветки
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label
                className="text-xs text-white/60"
                htmlFor="agent-branch-select"
              >
                Активная ветка
              </label>
              <select
                id="agent-branch-select"
                value={agent.getActiveBranchId()}
                disabled={isGenerating}
                onChange={(event) => {
                  const branchId = event.target.value;
                  if (agent.switchBranch(branchId)) {
                    const branchName =
                      agent
                        .getBranches()
                        .find((branch) => branch.id === branchId)?.name ??
                      'ветка';
                    setBranchFeedback({
                      tone: 'success',
                      text: `Активна «${branchName}». История других веток сохранена.`,
                    });
                  }
                }}
                className="min-h-9 min-w-32 max-w-full rounded-lg border border-white/15 bg-neutral-900 px-3 py-1 text-sm text-white"
              >
                {agent.getBranches().map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
              <span className="text-xs leading-5 text-white/45">
                {agent.getCheckpointMessageId()
                  ? 'Checkpoint выбран'
                  : messages.some(
                        (message) =>
                          message.role === 'assistant' &&
                          message.status === 'complete',
                      )
                    ? 'Точка ветвления — последний ответ'
                    : 'Точка ветвления — начало диалога'}
              </span>
            </div>
            <output
              aria-live="polite"
              className={`mt-3 block rounded-lg px-3 py-2 text-xs leading-5 ${
                branchFeedback?.tone === 'error'
                  ? 'bg-red-400/10 text-red-200'
                  : branchFeedback
                    ? 'bg-emerald-300/10 text-emerald-100'
                    : 'bg-white/[0.035] text-white/50'
              }`}
            >
              {branchFeedback?.text ??
                'Исходная история остаётся в своей ветке после создания новых.'}
            </output>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              <label
                className="text-xs text-white/60"
                htmlFor="agent-merge-branch-select"
              >
                Объединить текущую с
              </label>
              <select
                id="agent-merge-branch-select"
                value={selectedMergeBranchId}
                disabled={isGenerating || mergeCandidates.length === 0}
                onChange={(event) => setMergeWithBranchId(event.target.value)}
                className="min-h-9 min-w-32 max-w-full rounded-lg border border-white/15 bg-neutral-900 px-3 py-1 text-sm text-white"
              >
                {mergeCandidates.length ? (
                  mergeCandidates.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))
                ) : (
                  <option value="">Нет второй ветки</option>
                )}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9 border-white/15 bg-white/[0.035] px-3 text-white/85 hover:bg-white/[0.08]"
                disabled={
                  !selectedMergeBranchId ||
                  isGenerating ||
                  agent.getBranches().length >= 20
                }
                onClick={() => {
                  void agent.mergeBranches(
                    agent.getActiveBranchId(),
                    selectedMergeBranchId,
                  );
                }}
              >
                Объединить ветки
              </Button>
            </div>
            {agent.getMergeStatus() ? (
              <output className="mt-2 block text-xs text-white/60">
                {agent.getMergeStatus()}
              </output>
            ) : null}
          </section>
        ) : null}

        {activeBranchSummary ? (
          <section
            className="max-h-[20dvh] shrink-0 overflow-y-auto border-b border-white/10 px-5 py-3"
            aria-label="Объединённое summary"
          >
            <h2 className="mb-2 text-sm font-semibold text-white/80">
              Объединённое summary
            </h2>
            <div className="markdown-body text-sm text-white/70">
              <MarkdownMessage content={activeBranchSummary} />
            </div>
          </section>
        ) : null}

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
              {messages.map((message, index) => {
                const isUser = message.role === 'user';
                const precedingUserMessage =
                  !isUser && messages[index - 1]?.role === 'user'
                    ? messages[index - 1]
                    : undefined;
                const tokenStats =
                  !isUser && message.status === 'complete'
                    ? formatTokenStats({
                        requestTokens: precedingUserMessage?.messageTokens,
                        contextTokens: message.contextTokens,
                        contextWindowTokens: agent.config.contextWindowTokens,
                        cachedContextTokens: message.cachedContextTokens,
                        outputTokens: message.outputTokens,
                      })
                    : null;

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
                        {isUser ? 'Вы' : agent.name}
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
                        {isUser && message.attachments?.length ? (
                          <AttachmentGroup className="message-attachments">
                            {message.attachments.map((attachment) => (
                              <SentAttachment
                                key={attachment.id}
                                attachment={attachment}
                              />
                            ))}
                          </AttachmentGroup>
                        ) : null}
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
                      {tokenStats ? (
                        <MessageFooter className="message-tokens">
                          {tokenStats}
                        </MessageFooter>
                      ) : null}
                      {!isUser &&
                      message.status === 'complete' &&
                      agent.config.contextStrategy === 'branching' ? (
                        <MessageFooter>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isGenerating}
                            onClick={() => agent.createCheckpoint(message.id)}
                          >
                            {agent.getCheckpointMessageId() === message.id
                              ? '✓ Checkpoint'
                              : 'Сделать checkpoint'}
                          </Button>
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
          {error || attachmentError ? (
            <Alert variant="destructive" className="error-alert">
              <CircleAlert />
              <AlertTitle>
                {attachmentError
                  ? 'Не удалось прикрепить файл'
                  : 'Ошибка агента'}
              </AlertTitle>
              <AlertDescription>{attachmentError ?? error}</AlertDescription>
            </Alert>
          ) : null}

          <form className="composer" onSubmit={handleSubmit}>
            {selectedFiles.length ? (
              <AttachmentGroup className="selected-attachments">
                {selectedFiles.map((file) => {
                  const key = `${file.name}:${file.size}:${file.lastModified}`;
                  return (
                    <PendingAttachment
                      key={key}
                      file={file}
                      onRemove={() => {
                        setSelectedFiles((current) =>
                          current.filter(
                            (item) =>
                              `${item.name}:${item.size}:${item.lastModified}` !==
                              key,
                          ),
                        );
                        setAttachmentError(null);
                      }}
                    />
                  );
                })}
              </AttachmentGroup>
            ) : null}
            <div className="composer-row">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_INPUT_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={handleFilesSelected}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                className="attach-button"
                aria-label="Прикрепить файлы"
                disabled={isGenerating}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="size-[18px]" />
              </Button>
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
                  disabled={!input.trim() && selectedFiles.length === 0}
                >
                  <ArrowUp className="size-[18px]" />
                </Button>
              )}
            </div>
          </form>
          <p className="composer-hint">
            Enter — отправить · Shift + Enter — новая строка · до 5 файлов ·
            вложения отправляются в DeepSeek
          </p>
        </footer>

        <output className="sr-only" aria-live="polite" aria-atomic="true">
          {isGenerating ? 'Агент отвечает' : ''}
        </output>
      </div>
      <AgentMemoryPanel agent={agent} />
    </div>
  );
}
