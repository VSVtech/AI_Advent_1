import { Agent, type AgentConfig, type PersistedAgentState } from '@/lib/agent';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  isValidContextWindowTokens,
  isValidModel,
  isValidTargetOutputTokensOrNull,
  isValidTemperature,
} from '@/lib/chat-constraints';
import {
  classifyAttachment,
  isDeepSeekFileId,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_TOTAL_TEXT_ATTACHMENT_BYTES,
  validateAttachmentFiles,
} from '@/lib/file-attachments';
import {
  isValidCustomSystemPrompt,
  MAX_CUSTOM_SYSTEM_PROMPT_LENGTH,
} from '@/lib/chat-prompts';
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageStatus,
  ChatOutputFormat,
} from '@/lib/chat-types';

export const AGENT_SESSIONS_STORAGE_KEY = 'deepseek-chat:agent-sessions:v1';

const STORAGE_VERSION = 1;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

interface StoredAgentSessions {
  version: typeof STORAGE_VERSION;
  agents: PersistedAgentState[];
  activeAgentId: string | null;
}

export interface RestoredAgentSessions {
  agents: Agent[];
  activeAgentId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOutputFormat(value: unknown): value is ChatOutputFormat {
  return (
    value === 'text' || value === 'json' || value === 'xml' || value === 'yaml'
  );
}

function isMessageStatus(value: unknown): value is ChatMessageStatus {
  return (
    value === 'streaming' ||
    value === 'complete' ||
    value === 'stopped' ||
    value === 'error'
  );
}

function restoreAttachment(value: unknown): ChatAttachment | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    (value.kind !== 'image' && value.kind !== 'text') ||
    typeof value.name !== 'string' ||
    typeof value.mediaType !== 'string' ||
    typeof value.size !== 'number'
  ) {
    return null;
  }

  const descriptor = {
    name: value.name,
    type: value.mediaType,
    size: value.size,
  };
  const validation = validateAttachmentFiles([descriptor]);

  if (!validation.ok || classifyAttachment(descriptor) !== value.kind) {
    return null;
  }

  if (value.kind === 'image') {
    return isDeepSeekFileId(value.fileId)
      ? {
          id: value.id,
          kind: value.kind,
          name: value.name,
          mediaType: value.mediaType,
          size: value.size,
          fileId: value.fileId,
        }
      : null;
  }

  if (
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.includes('\u0000') ||
    new TextEncoder().encode(value.text).byteLength > MAX_TEXT_ATTACHMENT_BYTES
  ) {
    return null;
  }

  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    mediaType: value.mediaType,
    size: value.size,
    text: value.text,
  };
}

function restoreConfig(value: unknown): AgentConfig | null {
  if (!isRecord(value)) return null;

  // Sessions written before the artificial limit was introduced use the
  // model's full context window and remain loadable without a data migration.
  const contextWindowTokens =
    value.contextWindowTokens === undefined
      ? DEFAULT_CONTEXT_WINDOW_TOKENS
      : value.contextWindowTokens;
  const customSystemPrompt = value.customSystemPrompt;
  const hasValidCustomSystemPrompt =
    customSystemPrompt === null ||
    (typeof customSystemPrompt === 'string' &&
      customSystemPrompt.length <= MAX_CUSTOM_SYSTEM_PROMPT_LENGTH);

  if (
    !isValidModel(value.model) ||
    !isValidTemperature(value.temperature) ||
    !isOutputFormat(value.outputFormat) ||
    !isValidContextWindowTokens(contextWindowTokens) ||
    !isValidTargetOutputTokensOrNull(value.targetOutputTokens) ||
    typeof value.useSystemPrompt !== 'boolean' ||
    typeof value.useSelectorSystemPrompt !== 'boolean' ||
    !hasValidCustomSystemPrompt ||
    (value.useSystemPrompt &&
      !value.useSelectorSystemPrompt &&
      !isValidCustomSystemPrompt(customSystemPrompt))
  ) {
    return null;
  }

  return {
    model: value.model,
    temperature: value.temperature,
    outputFormat: value.outputFormat,
    contextWindowTokens,
    targetOutputTokens: value.targetOutputTokens,
    useSystemPrompt: value.useSystemPrompt,
    useSelectorSystemPrompt: value.useSelectorSystemPrompt,
    customSystemPrompt,
  };
}

function restoreMessage(value: unknown): ChatMessage | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string' ||
    !value.content.trim()
  ) {
    return null;
  }

  const rawStatus = isMessageStatus(value.status) ? value.status : 'complete';
  const status =
    value.role === 'user'
      ? 'complete'
      : rawStatus === 'streaming'
        ? 'stopped'
        : rawStatus;
  const format = isOutputFormat(value.format) ? value.format : undefined;
  const restoreTokenCount = (tokenCount: unknown): number | undefined =>
    typeof tokenCount === 'number' &&
    Number.isInteger(tokenCount) &&
    tokenCount >= 0
      ? tokenCount
      : undefined;
  const messageTokens = restoreTokenCount(value.messageTokens);
  const contextTokens = restoreTokenCount(value.contextTokens);
  const cachedContextTokens = restoreTokenCount(value.cachedContextTokens);
  const outputTokens = restoreTokenCount(value.outputTokens);
  const restoredAttachments =
    value.role === 'user' && Array.isArray(value.attachments)
      ? value.attachments.flatMap((attachment) => {
          const restored = restoreAttachment(attachment);
          return restored ? [restored] : [];
        })
      : [];
  const hasValidAttachmentSet = validateAttachmentFiles(
    restoredAttachments.map((attachment) => ({
      name: attachment.name,
      size: attachment.size,
      type: attachment.mediaType,
    })),
  ).ok;
  const restoredTextBytes = restoredAttachments.reduce(
    (total, attachment) =>
      total +
      (attachment.kind === 'text' && attachment.text
        ? new TextEncoder().encode(attachment.text).byteLength
        : 0),
    0,
  );
  const attachments =
    hasValidAttachmentSet &&
    restoredTextBytes <= MAX_TOTAL_TEXT_ATTACHMENT_BYTES
      ? restoredAttachments
      : [];

  return {
    id: value.id,
    role: value.role,
    content: value.content,
    status,
    ...(format === undefined ? {} : { format }),
    ...(attachments.length ? { attachments } : {}),
    ...(messageTokens === undefined ? {} : { messageTokens }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(cachedContextTokens === undefined ? {} : { cachedContextTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function restoreAgent(value: unknown): Agent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt < 0 ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }

  const config = restoreConfig(value.config);
  if (!config) return null;

  const messages = value.messages.flatMap((message) => {
    const restored = restoreMessage(message);
    return restored ? [restored] : [];
  });

  return new Agent(config, value.name, {
    id: value.id,
    createdAt: value.createdAt,
    messages,
  });
}

export function deserializeAgentSessions(
  rawValue: string | null,
): RestoredAgentSessions {
  if (!rawValue) return { agents: [], activeAgentId: null };

  let value: unknown;

  try {
    value = JSON.parse(rawValue);
  } catch {
    return { agents: [], activeAgentId: null };
  }

  if (
    !isRecord(value) ||
    value.version !== STORAGE_VERSION ||
    !Array.isArray(value.agents)
  ) {
    return { agents: [], activeAgentId: null };
  }

  const seenIds = new Set<string>();
  const agents = value.agents.flatMap((storedAgent) => {
    const agent = restoreAgent(storedAgent);
    if (!agent || seenIds.has(agent.id)) return [];
    seenIds.add(agent.id);
    return [agent];
  });
  const activeAgentId =
    typeof value.activeAgentId === 'string' && seenIds.has(value.activeAgentId)
      ? value.activeAgentId
      : null;

  return { agents, activeAgentId };
}

export function loadAgentSessions(
  storage: StorageReader,
): RestoredAgentSessions {
  try {
    return deserializeAgentSessions(
      storage.getItem(AGENT_SESSIONS_STORAGE_KEY),
    );
  } catch {
    return { agents: [], activeAgentId: null };
  }
}

export function saveAgentSessions(
  storage: StorageWriter,
  agents: Agent[],
  activeAgentId: string | null,
): boolean {
  const value: StoredAgentSessions = {
    version: STORAGE_VERSION,
    agents: agents.map((agent) => agent.exportState()),
    activeAgentId:
      activeAgentId && agents.some((agent) => agent.id === activeAgentId)
        ? activeAgentId
        : null,
  };

  try {
    storage.setItem(AGENT_SESSIONS_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
