import {
  Agent,
  MAX_BRANCH_SUMMARY_LENGTH,
  type AgentConfig,
  type AgentBranch,
  type AgentContextSummary,
  type PersistedAgentState,
} from '@/lib/agent';
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
import { isContextStrategy, sanitizeFacts } from '@/lib/context-strategy';
import {
  MAX_MEMORY_KEY_LENGTH,
  MAX_SHARED_LONG_TERM_MEMORY_ENTRIES,
  restoreMemoryEntries,
  SharedLongTermMemory,
  type MemoryEntry,
} from '@/lib/memory-layers';
import {
  isAgentProfileMode,
  loadGeneralProfile,
  normalizeProfileText,
} from '@/lib/user-profile';
import { restoreTaskState } from '@/lib/task-state';

export const AGENT_SESSIONS_STORAGE_KEY = 'deepseek-chat:agent-sessions:v2';
const PREVIOUS_AGENT_SESSIONS_STORAGE_KEY = 'deepseek-chat:agent-sessions:v1';
const AGENT_SESSIONS_RESET_KEY =
  'deepseek-chat:agent-sessions:reset-2026-09-18';

const STORAGE_VERSION = 2;
const MAX_CONTEXT_SUMMARY_LENGTH = 20_000;

type StorageReader = Pick<Storage, 'getItem'> &
  Partial<Pick<Storage, 'removeItem' | 'setItem'>>;
type StorageWriter = Pick<Storage, 'setItem'>;

interface StoredAgentSessions {
  version: typeof STORAGE_VERSION;
  agents: PersistedAgentState[];
  activeAgentId: string | null;
  longTermMemory: MemoryEntry[];
}

export interface RestoredAgentSessions {
  agents: Agent[];
  activeAgentId: string | null;
  longTermMemory: SharedLongTermMemory;
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
  const contextStrategy =
    value.contextStrategy === undefined
      ? value.useContextCompression === false
        ? 'none'
        : 'sticky-facts'
      : value.contextStrategy;
  const customSystemPrompt = value.customSystemPrompt;
  // Pre-profile sessions preserve their old behavior: no profile instructions.
  const profileMode =
    value.profileMode === undefined ? 'custom' : value.profileMode;
  const customProfile =
    value.customProfile === undefined
      ? ''
      : normalizeProfileText(value.customProfile);
  const hasValidCustomSystemPrompt =
    customSystemPrompt === null ||
    (typeof customSystemPrompt === 'string' &&
      customSystemPrompt.length <= MAX_CUSTOM_SYSTEM_PROMPT_LENGTH);

  if (
    !isValidModel(value.model) ||
    !isAgentProfileMode(profileMode) ||
    customProfile === null ||
    !isValidTemperature(value.temperature) ||
    !isOutputFormat(value.outputFormat) ||
    !isValidContextWindowTokens(contextWindowTokens) ||
    !isContextStrategy(contextStrategy) ||
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
    profileMode,
    customProfile,
    model: value.model,
    temperature: value.temperature,
    outputFormat: value.outputFormat,
    contextWindowTokens,
    contextStrategy,
    targetOutputTokens: value.targetOutputTokens,
    useSystemPrompt: value.useSystemPrompt,
    useSelectorSystemPrompt: value.useSelectorSystemPrompt,
    customSystemPrompt,
  };
}

function restoreContextSummary(value: unknown): AgentContextSummary | null {
  const lastSummarizedMessageId =
    isRecord(value) && value.lastSummarizedMessageId === undefined
      ? null
      : isRecord(value)
        ? value.lastSummarizedMessageId
        : null;

  if (
    !isRecord(value) ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    value.content.length > MAX_CONTEXT_SUMMARY_LENGTH ||
    typeof value.summarizedMessageCount !== 'number' ||
    !Number.isInteger(value.summarizedMessageCount) ||
    value.summarizedMessageCount <= 0 ||
    (lastSummarizedMessageId !== null &&
      (typeof lastSummarizedMessageId !== 'string' ||
        !lastSummarizedMessageId.trim())) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    return null;
  }

  return {
    content: value.content,
    summarizedMessageCount: value.summarizedMessageCount,
    lastSummarizedMessageId,
    updatedAt: value.updatedAt,
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
  const invariantInputTokens = restoreTokenCount(value.invariantInputTokens);
  const invariantOutputTokens = restoreTokenCount(value.invariantOutputTokens);
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
    ...(value.source === 'task-control' || value.source === 'task-transition'
      ? { source: value.source }
      : {}),
    status,
    ...(format === undefined ? {} : { format }),
    ...(attachments.length ? { attachments } : {}),
    ...(messageTokens === undefined ? {} : { messageTokens }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(cachedContextTokens === undefined ? {} : { cachedContextTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(invariantInputTokens === undefined ? {} : { invariantInputTokens }),
    ...(invariantOutputTokens === undefined ? {} : { invariantOutputTokens }),
  };
}

function restoreBranches(value: unknown): AgentBranch[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return null;
  }
  const seenIds = new Set<string>();
  const branches: AgentBranch[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      seenIds.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      !Array.isArray(item.messages)
    ) {
      return null;
    }
    seenIds.add(item.id);
    const workingMemory = restoreMemoryEntries(item.workingMemory, 'working');
    const facts = sanitizeFacts(item.facts);
    const taskState = restoreTaskState(item.taskState);
    branches.push({
      id: item.id,
      name: item.name,
      messages: item.messages.flatMap((message) => {
        const restored = restoreMessage(message);
        return restored ? [restored] : [];
      }),
      ...(workingMemory.length ? { workingMemory } : {}),
      ...(facts ? { facts } : {}),
      ...(taskState ? { taskState } : {}),
      ...(typeof item.memoryCutoffMessageId === 'string'
        ? { memoryCutoffMessageId: item.memoryCutoffMessageId }
        : {}),
      ...(typeof item.summary === 'string' &&
      item.summary.trim() &&
      item.summary.length <= MAX_BRANCH_SUMMARY_LENGTH
        ? { summary: item.summary }
        : {}),
    });
  }
  return branches;
}

function restoreAgent(
  value: unknown,
  sharedLongTermMemory: SharedLongTermMemory,
  getGeneralProfile: () => string,
): Agent | null {
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
  const contextSummary = restoreContextSummary(value.contextSummary);
  const facts = sanitizeFacts(value.facts) ?? {};
  const taskState = restoreTaskState(value.taskState);
  const memoryCutoffMessageId =
    typeof value.memoryCutoffMessageId === 'string'
      ? value.memoryCutoffMessageId
      : null;
  const memoryLayers = isRecord(value.memoryLayers)
    ? {
        working: restoreMemoryEntries(value.memoryLayers.working, 'working'),
        longTerm: restoreMemoryEntries(
          value.memoryLayers.longTerm,
          'long-term',
        ),
      }
    : undefined;
  const branches = restoreBranches(value.branches) ?? undefined;
  const activeBranchId =
    typeof value.activeBranchId === 'string' ? value.activeBranchId : undefined;
  const checkpointMessageId =
    typeof value.checkpointMessageId === 'string'
      ? value.checkpointMessageId
      : null;

  return new Agent(
    config,
    value.name,
    {
      id: value.id,
      kind: value.kind === 'task' ? 'task' : 'agent',
      createdAt: value.createdAt,
      messages,
      contextSummary,
      facts,
      taskState,
      memoryCutoffMessageId,
      memoryLayers,
      branches,
      activeBranchId,
      checkpointMessageId,
    },
    sharedLongTermMemory,
    getGeneralProfile,
  );
}

function mergeLegacyLongTermMemory(
  sources: Array<{ agentName: string; entries: MemoryEntry[] }>,
): MemoryEntry[] {
  const merged: MemoryEntry[] = [];
  for (const { agentName, entries } of sources) {
    for (const entry of entries) {
      const sameKey = merged.find(
        (item) =>
          item.key.toLocaleLowerCase() === entry.key.toLocaleLowerCase(),
      );
      if (sameKey?.value === entry.value && sameKey.kind === entry.kind) {
        continue;
      }

      let key = entry.key;
      if (sameKey) {
        let sequence = 1;
        do {
          const suffix = ` [${agentName.slice(0, 18)}${sequence > 1 ? ` ${sequence}` : ''}]`;
          key = `${entry.key.slice(0, MAX_MEMORY_KEY_LENGTH - suffix.length)}${suffix}`;
          sequence += 1;
        } while (
          merged.some(
            (item) => item.key.toLocaleLowerCase() === key.toLocaleLowerCase(),
          )
        );
      }
      merged.push({ ...entry, id: crypto.randomUUID(), key });
      if (merged.length === MAX_SHARED_LONG_TERM_MEMORY_ENTRIES) return merged;
    }
  }
  return merged;
}

export function deserializeAgentSessions(
  rawValue: string | null,
  getGeneralProfile: () => string = () => '',
): RestoredAgentSessions {
  const empty = () => ({
    agents: [],
    activeAgentId: null,
    longTermMemory: new SharedLongTermMemory(),
  });
  if (!rawValue) return empty();

  let value: unknown;

  try {
    value = JSON.parse(rawValue);
  } catch {
    return empty();
  }

  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== STORAGE_VERSION) ||
    !Array.isArray(value.agents)
  ) {
    return empty();
  }

  const hasSharedMemory =
    value.version === STORAGE_VERSION && Array.isArray(value.longTermMemory);
  const longTermMemory = new SharedLongTermMemory(
    hasSharedMemory ? value.longTermMemory : undefined,
  );
  const legacySources: Array<{ agentName: string; entries: MemoryEntry[] }> =
    [];
  const seenIds = new Set<string>();
  const agents = value.agents.flatMap((storedAgent) => {
    const agent = restoreAgent(storedAgent, longTermMemory, getGeneralProfile);
    if (!agent || seenIds.has(agent.id)) return [];
    seenIds.add(agent.id);
    if (!hasSharedMemory && isRecord(storedAgent)) {
      const memoryLayers = storedAgent.memoryLayers;
      if (isRecord(memoryLayers)) {
        legacySources.push({
          agentName: agent.name,
          entries: restoreMemoryEntries(memoryLayers.longTerm, 'long-term'),
        });
      }
    }
    return [agent];
  });
  if (!hasSharedMemory) {
    longTermMemory.restoreEntries(mergeLegacyLongTermMemory(legacySources));
  }
  const activeAgentId =
    typeof value.activeAgentId === 'string' && seenIds.has(value.activeAgentId)
      ? value.activeAgentId
      : null;

  return { agents, activeAgentId, longTermMemory };
}

export function loadAgentSessions(
  storage: StorageReader,
): RestoredAgentSessions {
  // One-time user-requested reset. A live HMR page may have copied old state
  // into the new key, so clear both versions before restoring anything.
  // General Profile has a separate key and is deliberately untouched.
  try {
    if (
      storage.getItem(AGENT_SESSIONS_RESET_KEY) !== 'done' &&
      storage.removeItem &&
      storage.setItem
    ) {
      storage.removeItem(PREVIOUS_AGENT_SESSIONS_STORAGE_KEY);
      storage.removeItem(AGENT_SESSIONS_STORAGE_KEY);
      storage.setItem(AGENT_SESSIONS_RESET_KEY, 'done');
    }
  } catch {
    // Storage can be unavailable (private mode); normal empty restore follows.
  }
  try {
    return deserializeAgentSessions(
      storage.getItem(AGENT_SESSIONS_STORAGE_KEY),
      () => loadGeneralProfile(storage),
    );
  } catch {
    return {
      agents: [],
      activeAgentId: null,
      longTermMemory: new SharedLongTermMemory(),
    };
  }
}

export function saveAgentSessions(
  storage: StorageWriter,
  agents: Agent[],
  activeAgentId: string | null,
  sharedLongTermMemory?: SharedLongTermMemory,
): boolean {
  const value: StoredAgentSessions = {
    version: STORAGE_VERSION,
    agents: agents.map((agent) => agent.exportState()),
    activeAgentId:
      activeAgentId && agents.some((agent) => agent.id === activeAgentId)
        ? activeAgentId
        : null,
    longTermMemory:
      sharedLongTermMemory?.getEntries() ??
      agents[0]?.getMemoryLayers().longTerm ??
      [],
  };

  try {
    storage.setItem(AGENT_SESSIONS_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
