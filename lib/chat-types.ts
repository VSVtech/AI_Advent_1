export type ChatRole = 'user' | 'assistant';

export type ChatMessageStatus = 'streaming' | 'complete' | 'stopped' | 'error';

export type ChatOutputFormat = 'text' | 'json' | 'xml' | 'yaml';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  status?: ChatMessageStatus;
  format?: ChatOutputFormat;
  outputTokens?: number;
}

export interface ApiChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ApiChatMessage[];
  format?: ChatOutputFormat;
  targetOutputTokens?: number;
  temperature?: number;
  model?: string;
  useSystemPrompt?: boolean;
  useSelectorSystemPrompt?: boolean;
  customSystemPrompt?: string;
}

export interface ModelsResponsePayload {
  models: string[];
  default: string;
}

export type ChatStreamEvent =
  | { type: 'prepared'; prompt: string; promptOutputTokens?: number }
  | { type: 'delta'; content: string }
  | { type: 'done'; finishReason: string; outputTokens?: number }
  | { type: 'error'; code: string; message: string };

export interface ChatErrorPayload {
  error: {
    code: string;
    message: string;
  };
}
