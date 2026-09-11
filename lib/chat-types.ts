export type ChatRole = 'user' | 'assistant';

export type ChatMessageStatus = 'streaming' | 'complete' | 'stopped' | 'error';

export type ChatOutputFormat = 'text' | 'json' | 'xml' | 'yaml';

export type ChatAttachmentKind = 'image' | 'text';

export interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  mediaType: string;
  size: number;
  // Images are uploaded once to DeepSeek and referenced by this id in every
  // later turn. Keeping only the id avoids storing binary data in localStorage.
  fileId?: string;
  // Text attachments are small enough to persist with the local chat history.
  text?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  status?: ChatMessageStatus;
  format?: ChatOutputFormat;
  attachments?: ChatAttachment[];
  // Приблизительное число токенов только этого сообщения (без истории и
  // системного промпта), посчитанное локально в момент отправки.
  messageTokens?: number;
  // Точное число входных токенов, которое DeepSeek обработал для запроса,
  // породившего этот ответ (история, текущее сообщение и системный промпт).
  contextTokens?: number;
  // Из contextTokens — обслужено кэшем DeepSeek.
  cachedContextTokens?: number;
  // Точное число выходных токенов ответа модели.
  outputTokens?: number;
}

export type ApiChatContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; file_id: string };

export interface ApiChatMessage {
  role: ChatRole;
  content: string | ApiChatContentPart[];
}

export interface ChatRequest {
  messages: ApiChatMessage[];
  format?: ChatOutputFormat;
  // `null` explicitly disables the target length (and, with it, the
  // derived max-output cap); `undefined` falls back to the default target.
  targetOutputTokens?: number | null;
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

export interface FileUploadResponsePayload {
  file: {
    fileId: string;
    name: string;
    mediaType: string;
    size: number;
  };
}

export type ChatStreamEvent =
  | { type: 'prepared'; prompt: string; promptOutputTokens?: number }
  | { type: 'delta'; content: string }
  | {
      type: 'done';
      finishReason: string;
      outputTokens?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: 'error'; code: string; message: string };

export interface ChatErrorPayload {
  error: {
    code: string;
    message: string;
  };
}
