export type ChatRole = 'user' | 'assistant';

export type ChatMessageStatus = 'streaming' | 'complete' | 'stopped' | 'error';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  status?: ChatMessageStatus;
}

export interface ApiChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ApiChatMessage[];
}

export type ChatStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; code: string; message: string };

export interface ChatErrorPayload {
  error: {
    code: string;
    message: string;
  };
}
