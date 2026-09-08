import {
  DEFAULT_MODEL,
  DEFAULT_TARGET_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  formatModelLabel,
} from '@/lib/chat-constraints';
import type {
  ApiChatMessage,
  ChatErrorPayload,
  ChatMessage,
  ChatOutputFormat,
  ChatRequest,
  ChatStreamEvent,
} from '@/lib/chat-types';
import { readChatStream } from '@/lib/read-chat-stream';

export interface AgentConfig {
  model: string;
  temperature: number;
  outputFormat: ChatOutputFormat;
  targetOutputTokens: number;
  useSystemPrompt: boolean;
  useSelectorSystemPrompt: boolean;
  customSystemPrompt: string | null;
}

export interface AgentSnapshot {
  messages: ChatMessage[];
  isGenerating: boolean;
  error: string | null;
}

export interface PersistedAgentState {
  id: string;
  name: string;
  config: AgentConfig;
  createdAt: number;
  messages: ChatMessage[];
}

type RestoredAgentState = Pick<
  PersistedAgentState,
  'id' | 'createdAt' | 'messages'
>;

function createId(): string {
  return crypto.randomUUID();
}

function toApiMessages(messages: ChatMessage[]): ApiChatMessage[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map(({ role, content }) => ({ role, content }));
}

export function createDefaultAgentConfig(): AgentConfig {
  return {
    model: DEFAULT_MODEL,
    temperature: DEFAULT_TEMPERATURE,
    outputFormat: 'text',
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
      restoredState?.messages.map((message) => ({ ...message })) ?? [];
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

  exportState(): PersistedAgentState {
    return {
      id: this.id,
      name: this.name,
      config: { ...this.config },
      createdAt: this.createdAt,
      messages: this.messages.map((message) => ({ ...message })),
    };
  }

  private notify() {
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

  async sendMessage(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || this.isGenerating) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: trimmed,
      status: 'complete',
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: '',
      status: 'streaming',
      format: this.config.outputFormat,
    };
    const requestMessages = toApiMessages([...this.messages, userMessage]);
    const controller = new AbortController();

    this.abortController = controller;
    this.messages = [...this.messages, userMessage, assistantMessage];
    this.error = null;
    this.isGenerating = true;
    this.notify();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: requestMessages,
          format: this.config.outputFormat,
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

      await readChatStream(response.body, (event: ChatStreamEvent) => {
        if (event.type === 'delta') {
          this.updateAssistant(assistantMessage.id, (message) => ({
            ...message,
            content: message.content + event.content,
          }));
        } else if (event.type === 'done') {
          completed = true;
          this.updateAssistant(assistantMessage.id, (message) => ({
            ...message,
            status: 'complete',
            ...(event.outputTokens === undefined
              ? {}
              : { outputTokens: event.outputTokens }),
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
    } catch (caughtError) {
      if (controller.signal.aborted) {
        this.removeEmptyAssistant(assistantMessage.id, 'stopped');
      } else {
        this.removeEmptyAssistant(assistantMessage.id, 'error');
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
    this.error = null;
    this.notify();
  }

  dispose(): void {
    this.abortController?.abort();
    this.listeners.clear();
  }
}
