import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  estimateTokenCount,
  formatModelLabel,
} from '@/lib/chat-constraints';
import type {
  ApiChatContentPart,
  ApiChatMessage,
  ChatAttachment,
  ChatErrorPayload,
  ChatMessage,
  ChatOutputFormat,
  ChatRequest,
  ChatStreamEvent,
  FileUploadResponsePayload,
} from '@/lib/chat-types';
import {
  buildFactsPrompt,
  RECENT_CONTEXT_MESSAGE_LIMIT,
  sanitizeFacts,
  type ContextStrategy,
  type MemoryFacts,
} from '@/lib/context-strategy';
import {
  classifyAttachment,
  isDeepSeekFileId,
  isVisionModel,
  validateAttachmentFiles,
} from '@/lib/file-attachments';
import { readChatStream } from '@/lib/read-chat-stream';

export interface AgentConfig {
  model: string;
  temperature: number;
  outputFormat: ChatOutputFormat;
  contextWindowTokens: number;
  contextStrategy: ContextStrategy;
  // `null` disables the target length (and, with it, the derived
  // max-output cap) — the model is free to answer at whatever length it
  // judges appropriate, up to the technical API ceiling.
  targetOutputTokens: number | null;
  useSystemPrompt: boolean;
  useSelectorSystemPrompt: boolean;
  customSystemPrompt: string | null;
}

export interface AgentSnapshot {
  messages: ChatMessage[];
  isGenerating: boolean;
  error: string | null;
}

export interface AgentContextSummary {
  content: string;
  summarizedMessageCount: number;
  // Marks the last message from the full UI history already represented by
  // the summary. Legacy summaries use null because their source messages were
  // removed before full-history retention was introduced.
  lastSummarizedMessageId: string | null;
  updatedAt: number;
}

export interface AgentBranch {
  id: string;
  name: string;
  messages: ChatMessage[];
}

export interface PersistedAgentState {
  id: string;
  name: string;
  config: AgentConfig;
  createdAt: number;
  messages: ChatMessage[];
  facts?: MemoryFacts;
  branches?: AgentBranch[];
  activeBranchId?: string;
  checkpointMessageId?: string | null;
  // Read-only compatibility with sessions created by task 9.
  contextSummary?: AgentContextSummary | null;
}

type RestoredAgentState = Pick<
  PersistedAgentState,
  'id' | 'createdAt' | 'messages'
> &
  Partial<
    Pick<
      PersistedAgentState,
      | 'facts'
      | 'branches'
      | 'activeBranchId'
      | 'checkpointMessageId'
      | 'contextSummary'
    >
  >;

export { RECENT_CONTEXT_MESSAGE_LIMIT } from '@/lib/context-strategy';

function createId(): string {
  return crypto.randomUUID();
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.attachments
      ? {
          attachments: message.attachments.map((attachment) => ({
            ...attachment,
          })),
        }
      : {}),
  };
}

function attachmentText(attachment: ChatAttachment): string {
  return [
    `Начало файла ${JSON.stringify(attachment.name)}`,
    attachment.text ?? '',
    `Конец файла ${JSON.stringify(attachment.name)}`,
  ].join('\n');
}

function toApiMessages(messages: ChatMessage[]): ApiChatMessage[] {
  return messages
    .filter(
      (message) =>
        message.content.trim().length > 0 ||
        Boolean(message.attachments?.length),
    )
    .map(({ role, content, attachments }) => {
      if (role === 'assistant' || !attachments?.length) {
        return { role, content };
      }

      const parts: ApiChatContentPart[] = [];
      if (content.trim()) parts.push({ type: 'input_text', text: content });

      for (const attachment of attachments) {
        if (attachment.kind === 'text' && attachment.text !== undefined) {
          parts.push({ type: 'input_text', text: attachmentText(attachment) });
        } else if (
          attachment.kind === 'image' &&
          attachment.fileId !== undefined
        ) {
          parts.push({
            type: 'input_text',
            text: `Изображение ${JSON.stringify(attachment.name)}`,
          });
          parts.push({ type: 'input_image', file_id: attachment.fileId });
        }
      }

      return { role, content: parts };
    });
}

function toContextApiMessages(
  strategy: ContextStrategy,
  facts: MemoryFacts,
  messages: ChatMessage[],
): ApiChatMessage[] {
  const recentMessages =
    strategy === 'sliding-window' || strategy === 'sticky-facts'
      ? messages.slice(-RECENT_CONTEXT_MESSAGE_LIMIT)
      : messages;
  const apiMessages = toApiMessages(recentMessages);
  if (strategy !== 'sticky-facts' || Object.keys(facts).length === 0) {
    return apiMessages;
  }
  return [
    {
      role: 'assistant',
      content: `Память агента (facts):\n${JSON.stringify(facts)}`,
    },
    ...apiMessages,
  ];
}

function dialogueTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const sections = [
        `${message.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${message.content}`,
      ];

      for (const attachment of message.attachments ?? []) {
        if (attachment.kind === 'text' && attachment.text) {
          const text = attachment.text.slice(0, 2000);
          const suffix =
            attachment.text.length > 2000 ? '\n[Файл сокращён]' : '';
          sections.push(
            `Текстовый файл ${JSON.stringify(attachment.name)}:\n${text}${suffix}`,
          );
        } else if (attachment.kind === 'image') {
          sections.push(`Изображение ${JSON.stringify(attachment.name)}`);
        }
      }

      return sections.join('\n');
    })
    .join('\n\n');
}

export function createDefaultAgentConfig(): AgentConfig {
  return {
    model: DEFAULT_MODEL,
    temperature: DEFAULT_TEMPERATURE,
    outputFormat: 'text',
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    contextStrategy: 'none',
    targetOutputTokens: DEFAULT_TARGET_OUTPUT_TOKENS,
    useSystemPrompt: true,
    useSelectorSystemPrompt: true,
    customSystemPrompt: null,
  };
}

/**
 * Agent — a single, independent, stateful conversation with DeepSeek.
 *
 * This class is the entity that satisfies the assignment's requirement that
 * "the agent must be a separate entity, not just one API call": it owns its
 * own configuration (model, temperature, system prompt mode), its own
 * message history, and it fully encapsulates the request/response cycle —
 * building the request payload, calling `/api/chat`, consuming the streamed
 * response, and handling cancellation and errors. UI components never call
 * `fetch` themselves; they call `agent.sendMessage(...)` / `agent.stop()`
 * and read state via the `subscribe`/`getSnapshot` pair (consumed through
 * `useAgentSnapshot` in `hooks/use-agent.ts`).
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;
  readonly createdAt: number;

  private messages: ChatMessage[] = [];
  private facts: MemoryFacts = {};
  private branches: AgentBranch[] = [];
  private activeBranchId = 'main';
  private checkpointMessageId: string | null = null;
  private isGenerating = false;
  private error: string | null = null;
  private abortController: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentSnapshot;

  constructor(
    config: AgentConfig,
    name?: string,
    restoredState?: RestoredAgentState,
  ) {
    this.id = restoredState?.id ?? createId();
    this.config = { ...config };
    this.createdAt = restoredState?.createdAt ?? Date.now();
    this.name = name?.trim() || `Агент · ${formatModelLabel(config.model)}`;
    this.messages =
      restoredState?.messages.map((message) => cloneMessage(message)) ?? [];
    this.facts = sanitizeFacts(restoredState?.facts) ?? {};
    if (
      config.contextStrategy === 'sticky-facts' &&
      restoredState?.contextSummary?.content &&
      !this.facts.previous_summary
    ) {
      this.facts.previous_summary = restoredState.contextSummary.content.slice(
        0,
        500,
      );
    }
    if (config.contextStrategy === 'branching') {
      this.branches = restoredState?.branches?.length
        ? restoredState.branches.map((branch) => ({
            id: branch.id,
            name: branch.name,
            messages: branch.messages.map(cloneMessage),
          }))
        : [{ id: 'main', name: 'Основная', messages: this.messages }];
      this.activeBranchId = this.branches.some(
        (branch) => branch.id === restoredState?.activeBranchId,
      )
        ? (restoredState?.activeBranchId ?? 'main')
        : this.branches[0].id;
      this.messages = this.branches.find(
        (branch) => branch.id === this.activeBranchId,
      )!.messages;
      this.checkpointMessageId =
        restoredState?.checkpointMessageId &&
        this.messages.some(
          (message) => message.id === restoredState.checkpointMessageId,
        )
          ? restoredState.checkpointMessageId
          : null;
    }
    this.snapshot = {
      messages: this.messages,
      isGenerating: false,
      error: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AgentSnapshot => this.snapshot;

  getFacts(): MemoryFacts {
    return { ...this.facts };
  }

  getBranches(): Array<Pick<AgentBranch, 'id' | 'name'>> {
    return this.branches.map(({ id, name }) => ({ id, name }));
  }

  getActiveBranchId(): string {
    return this.activeBranchId;
  }

  getCheckpointMessageId(): string | null {
    return this.checkpointMessageId;
  }

  createCheckpoint(messageId: string): boolean {
    if (
      this.config.contextStrategy !== 'branching' ||
      this.isGenerating ||
      !this.messages.some(
        (message) => message.id === messageId && message.status === 'complete',
      )
    ) {
      return false;
    }
    this.checkpointMessageId = messageId;
    this.notify();
    return true;
  }

  createBranches(): [string, string] | null {
    if (
      this.config.contextStrategy !== 'branching' ||
      this.isGenerating ||
      !this.checkpointMessageId ||
      this.branches.length > 18
    ) {
      return null;
    }
    const checkpointIndex = this.messages.findIndex(
      (message) => message.id === this.checkpointMessageId,
    );
    if (checkpointIndex < 0) return null;

    const prefix = this.messages.slice(0, checkpointIndex + 1);
    const number = this.branches.length;
    const first = createId();
    const second = createId();
    this.branches.push(
      {
        id: first,
        name: `Ветка ${number}`,
        messages: prefix.map(cloneMessage),
      },
      {
        id: second,
        name: `Ветка ${number + 1}`,
        messages: prefix.map(cloneMessage),
      },
    );
    this.activeBranchId = first;
    this.messages = this.branches[this.branches.length - 2].messages;
    this.checkpointMessageId = null;
    this.error = null;
    this.notify();
    return [first, second];
  }

  switchBranch(branchId: string): boolean {
    if (this.config.contextStrategy !== 'branching' || this.isGenerating) {
      return false;
    }
    const branch = this.branches.find((item) => item.id === branchId);
    if (!branch) return false;
    this.activeBranchId = branchId;
    this.messages = branch.messages;
    this.checkpointMessageId = null;
    this.error = null;
    this.notify();
    return true;
  }

  exportState(): PersistedAgentState {
    return {
      id: this.id,
      name: this.name,
      config: { ...this.config },
      createdAt: this.createdAt,
      messages: this.messages.map((message) => cloneMessage(message)),
      facts: { ...this.facts },
      branches: this.branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        messages: branch.messages.map(cloneMessage),
      })),
      activeBranchId: this.activeBranchId,
      checkpointMessageId: this.checkpointMessageId,
      contextSummary: null,
    };
  }

  private notify() {
    const activeBranch = this.branches.find(
      (branch) => branch.id === this.activeBranchId,
    );
    if (activeBranch) activeBranch.messages = this.messages;
    this.snapshot = {
      messages: this.messages,
      isGenerating: this.isGenerating,
      error: this.error,
    };
    for (const listener of this.listeners) listener();
  }

  private updateAssistant(
    id: string,
    update: (message: ChatMessage) => ChatMessage,
  ) {
    this.messages = this.messages.map((message) =>
      message.id === id ? update(message) : message,
    );
    this.notify();
  }

  private removeEmptyAssistant(id: string, status: 'stopped' | 'error') {
    this.messages = this.messages.flatMap((message) => {
      if (message.id !== id) return [message];
      return message.content.trim() ? [{ ...message, status }] : [];
    });
    this.notify();
  }

  private latestExactContextTokens(): number | null {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.role === 'assistant' && message.contextTokens !== undefined) {
        return message.contextTokens;
      }
    }

    return null;
  }

  private contextLimitMessage(
    exactContextTokens: number,
    nextRequestBlocked: boolean,
  ): string {
    const state =
      exactContextTokens > this.config.contextWindowTokens
        ? 'переполнен'
        : 'достиг лимита';
    const consequence = nextRequestBlocked
      ? 'Новый запрос не отправлен.'
      : 'Ответ получен, но следующий запрос будет заблокирован.';
    return `Контекст ${state}: DeepSeek насчитал ${exactContextTokens.toLocaleString('ru-RU')} входных токенов при лимите агента ${this.config.contextWindowTokens.toLocaleString('ru-RU')}. ${consequence} Увеличьте лимит или очистите историю.`;
  }

  private async updateFacts(signal: AbortSignal): Promise<void> {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: buildFactsPrompt(
              this.facts,
              dialogueTranscript(
                this.messages
                  .filter((message) => message.content.trim())
                  .slice(-RECENT_CONTEXT_MESSAGE_LIMIT),
              ),
            ),
          },
        ],
        format: 'json',
        contextWindowTokens: this.config.contextWindowTokens,
        targetOutputTokens: 500,
        temperature: 0.2,
        model: this.config.model,
        useSystemPrompt: false,
        useSelectorSystemPrompt: true,
      } satisfies ChatRequest),
      signal,
    });

    if (!response.ok) {
      const payload = (await response
        .json()
        .catch(() => null)) as ChatErrorPayload | null;
      throw new Error(payload?.error.message ?? 'Не удалось обновить facts.');
    }

    if (!response.body) {
      throw new Error('DeepSeek вернул пустой ответ при обновлении facts.');
    }

    let content = '';
    let completed = false;

    await readChatStream(response.body, (event: ChatStreamEvent) => {
      if (event.type === 'delta') {
        content += event.content;
      } else if (event.type === 'done') {
        completed = true;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    });

    if (!completed || !content.trim()) {
      throw new Error('DeepSeek не смог обновить facts.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('DeepSeek вернул некорректный JSON для facts.');
    }
    const facts = sanitizeFacts(parsed);
    if (!facts) throw new Error('DeepSeek вернул некорректные facts.');
    this.facts = facts;
    this.notify();
  }

  private async prepareAttachments(
    files: File[],
    signal: AbortSignal,
  ): Promise<ChatAttachment[]> {
    const validation = validateAttachmentFiles(files);
    if (!validation.ok) throw new Error(validation.message);

    if (
      files.some((file) => classifyAttachment(file) === 'image') &&
      !isVisionModel(this.config.model)
    ) {
      throw new Error(
        'Изображения поддерживаются только моделями DeepSeek Flash. Создайте агента с моделью Flash.',
      );
    }

    return Promise.all(
      files.map(async (file): Promise<ChatAttachment> => {
        const kind = classifyAttachment(file);
        if (!kind)
          throw new Error(`Формат файла «${file.name}» не поддерживается.`);

        if (kind === 'text') {
          const text = await file.text();
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          if (!text.trim() || text.includes('\u0000')) {
            throw new Error(
              `Файл «${file.name}» не содержит читаемого текста.`,
            );
          }

          return {
            id: createId(),
            kind,
            name: file.name,
            mediaType: file.type || 'text/plain',
            size: file.size,
            text,
          };
        }

        const formData = new FormData();
        formData.set('file', file, file.name);
        const response = await fetch('/api/files', {
          method: 'POST',
          body: formData,
          signal,
        });

        if (!response.ok) {
          const payload = (await response
            .json()
            .catch(() => null)) as ChatErrorPayload | null;
          throw new Error(
            payload?.error.message ??
              `Не удалось загрузить файл «${file.name}».`,
          );
        }

        const payload = (await response
          .json()
          .catch(() => null)) as FileUploadResponsePayload | null;
        if (!isDeepSeekFileId(payload?.file.fileId)) {
          throw new Error(`Не удалось загрузить файл «${file.name}».`);
        }

        return {
          id: createId(),
          kind,
          name: file.name,
          mediaType: file.type,
          size: file.size,
          fileId: payload.file.fileId,
        };
      }),
    );
  }

  async sendMessage(content: string, files: File[] = []): Promise<void> {
    const trimmed = content.trim();
    if ((!trimmed && files.length === 0) || this.isGenerating) return;

    const exactContextTokens = this.latestExactContextTokens();
    const canRefreshCompressedContext =
      this.config.contextStrategy === 'sliding-window' ||
      this.config.contextStrategy === 'sticky-facts';
    if (
      exactContextTokens !== null &&
      exactContextTokens >= this.config.contextWindowTokens &&
      !canRefreshCompressedContext
    ) {
      this.error = this.contextLimitMessage(exactContextTokens, true);
      this.notify();
      return;
    }

    const controller = new AbortController();
    let assistantMessageId: string | null = null;

    this.abortController = controller;
    this.error = null;
    this.isGenerating = true;
    this.notify();

    try {
      const attachments = files.length
        ? await this.prepareAttachments(files, controller.signal)
        : [];
      if (controller.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const messageContent =
        trimmed || 'Проанализируй прикреплённые файлы и расскажи главное.';
      const estimatedInput = [
        messageContent,
        ...attachments.flatMap((attachment) =>
          attachment.kind === 'text' && attachment.text
            ? [attachmentText(attachment)]
            : [],
        ),
      ].join('\n');
      const userMessage: ChatMessage = {
        id: createId(),
        role: 'user',
        content: messageContent,
        status: 'complete',
        ...(attachments.length ? { attachments } : {}),
        // Approximate token count of the visible request and text attachments
        // (without history or system prompt). Images are counted by the API.
        messageTokens: estimateTokenCount(estimatedInput),
      };
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        status: 'streaming',
        format: this.config.outputFormat,
      };
      assistantMessageId = assistantMessage.id;
      this.messages = [...this.messages, userMessage, assistantMessage];
      this.notify();

      if (this.config.contextStrategy === 'sticky-facts') {
        await this.updateFacts(controller.signal);
      }
      const requestMessages = toContextApiMessages(
        this.config.contextStrategy,
        this.facts,
        this.messages.filter((message) => message.id !== assistantMessage.id),
      );

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: requestMessages,
          format: this.config.outputFormat,
          contextWindowTokens: this.config.contextWindowTokens,
          targetOutputTokens: this.config.targetOutputTokens,
          temperature: this.config.temperature,
          model: this.config.model,
          useSystemPrompt: this.config.useSystemPrompt,
          useSelectorSystemPrompt: this.config.useSelectorSystemPrompt,
          ...(this.config.useSystemPrompt &&
          !this.config.useSelectorSystemPrompt
            ? { customSystemPrompt: this.config.customSystemPrompt ?? '' }
            : {}),
        } satisfies ChatRequest),
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
      let exactInputTokens: number | undefined;

      await readChatStream(response.body, (event: ChatStreamEvent) => {
        if (event.type === 'delta') {
          this.updateAssistant(assistantMessage.id, (message) => ({
            ...message,
            content: message.content + event.content,
          }));
        } else if (event.type === 'done') {
          completed = true;
          exactInputTokens = event.inputTokens;
          this.updateAssistant(assistantMessage.id, (message) => ({
            ...message,
            status: 'complete',
            ...(event.outputTokens === undefined
              ? {}
              : { outputTokens: event.outputTokens }),
            // Exact input-token usage DeepSeek reports for this request —
            // i.e. the full input context: conversation history, the latest
            // user message, and the system prompt used for this answer.
            ...(event.inputTokens === undefined
              ? {}
              : { contextTokens: event.inputTokens }),
            ...(event.cachedInputTokens === undefined
              ? {}
              : { cachedContextTokens: event.cachedInputTokens }),
          }));
        } else if (event.type === 'error') {
          throw new Error(event.message);
        }
      });

      if (!completed) {
        this.updateAssistant(assistantMessage.id, (message) => ({
          ...message,
          status: 'complete',
        }));
      }

      if (
        exactInputTokens !== undefined &&
        exactInputTokens >= this.config.contextWindowTokens &&
        !canRefreshCompressedContext
      ) {
        this.error = this.contextLimitMessage(exactInputTokens, false);
        this.notify();
      }
    } catch (caughtError) {
      if (controller.signal.aborted) {
        if (assistantMessageId) {
          this.removeEmptyAssistant(assistantMessageId, 'stopped');
        }
      } else {
        if (assistantMessageId) {
          this.removeEmptyAssistant(assistantMessageId, 'error');
        }
        this.error =
          caughtError instanceof Error
            ? caughtError.message
            : 'Не удалось получить ответ от DeepSeek.';
        this.notify();
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.isGenerating = false;
      this.notify();
    }
  }

  stop(): void {
    this.abortController?.abort();
  }

  clearHistory(): void {
    this.abortController?.abort();
    this.messages = [];
    this.facts = {};
    this.branches =
      this.config.contextStrategy === 'branching'
        ? [{ id: 'main', name: 'Основная', messages: [] }]
        : [];
    this.activeBranchId = 'main';
    this.checkpointMessageId = null;
    this.error = null;
    this.notify();
  }

  dispose(): void {
    this.abortController?.abort();
    this.listeners.clear();
  }
}
