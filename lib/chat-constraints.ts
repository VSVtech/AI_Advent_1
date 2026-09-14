import type { ApiChatMessage } from '@/lib/chat-types';

export const DEFAULT_TARGET_OUTPUT_TOKENS = 500;
export const MIN_TARGET_OUTPUT_TOKENS = 50;
export const MAX_MAX_OUTPUT_TOKENS = 100_000;
export const MIN_OUTPUT_TOKEN_HEADROOM = 500;
export const MAX_OUTPUT_TOKEN_HEADROOM = 2000;
export const MAX_TARGET_OUTPUT_TOKENS =
  MAX_MAX_OUTPUT_TOKENS - MAX_OUTPUT_TOKEN_HEADROOM;

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const MIN_CONTEXT_WINDOW_TOKENS = 100;
export const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

const MESSAGE_TOKEN_OVERHEAD = 4;
const RESPONSE_PRIMING_TOKENS = 2;
const IMAGE_TOKEN_ESTIMATE = 1024;

export const DEFAULT_TEMPERATURE = 1;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;

export function isValidTemperature(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_TEMPERATURE &&
    value <= MAX_TEMPERATURE
  );
}

export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const MAX_MODEL_ID_LENGTH = 200;

export function isValidModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_MODEL_ID_LENGTH
  );
}

// Turns a raw DeepSeek model id ("deepseek-v4-flash") into a short,
// human-friendly label ("V4 Flash") for compact UI like the header badge.
export function formatModelLabel(id: string): string {
  const withoutPrefix = id.replace(/^deepseek-/i, '');
  const parts = withoutPrefix.split('-').filter(Boolean);

  if (parts.length === 0) return id;

  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Грубая локальная оценка числа токенов до получения usage от DeepSeek.
// Считаем UTF-8-байты, а не UTF-16 code units: прежняя оценка сильно
// занижала объём кириллицы и другого Unicode-текста. Для точного биллинга
// источником истины всё равно остаётся usage из ответа API.
export function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  return trimmed
    ? Math.max(1, Math.ceil(new TextEncoder().encode(trimmed).byteLength / 4))
    : 0;
}

export function isValidContextWindowTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_CONTEXT_WINDOW_TOKENS &&
    value <= MAX_CONTEXT_WINDOW_TOKENS
  );
}

// Preflight estimate for the complete input sent to DeepSeek. Exact input
// usage is only available after a successful response, so the artificial
// context-window guard intentionally uses the same local ~4 UTF-8 bytes/token
// approximation as individual messages. Images receive a conservative fixed
// estimate because their token cost is determined by the API.
export function estimateContextTokenCount(
  messages: ApiChatMessage[],
  systemPrompt: string | null,
): number {
  const messageTokens = messages.reduce((total, message) => {
    const contentTokens =
      typeof message.content === 'string'
        ? estimateTokenCount(message.content)
        : message.content.reduce(
            (contentTotal, part) =>
              contentTotal +
              (part.type === 'input_text'
                ? estimateTokenCount(part.text)
                : IMAGE_TOKEN_ESTIMATE),
            0,
          );

    return total + MESSAGE_TOKEN_OVERHEAD + contentTokens;
  }, 0);

  return (
    messageTokens +
    (systemPrompt ? estimateTokenCount(systemPrompt) : 0) +
    RESPONSE_PRIMING_TOKENS
  );
}

export function isValidTargetOutputTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TARGET_OUTPUT_TOKENS &&
    value <= MAX_TARGET_OUTPUT_TOKENS
  );
}

export function isValidMaxOutputTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_TARGET_OUTPUT_TOKENS &&
    value <= MAX_MAX_OUTPUT_TOKENS
  );
}

// `null` means "target length disabled" — a legitimate, explicit choice,
// distinct from an unset/invalid value.
export function isValidTargetOutputTokensOrNull(
  value: unknown,
): value is number | null {
  return value === null || isValidTargetOutputTokens(value);
}

// Disabling the target length also disables the derived max-output cap:
// with no target to build a headroom around, the only limit left is the
// API's own technical ceiling.
export function calculateMaxOutputTokens(
  targetOutputTokens: number | null,
): number {
  if (targetOutputTokens === null) return MAX_MAX_OUTPUT_TOKENS;

  const proportionalHeadroom = Math.ceil(targetOutputTokens * 0.2);
  const headroom = Math.min(
    MAX_OUTPUT_TOKEN_HEADROOM,
    Math.max(MIN_OUTPUT_TOKEN_HEADROOM, proportionalHeadroom),
  );

  return targetOutputTokens + headroom;
}

export function calculateTargetOutputRange(targetOutputTokens: number): {
  min: number;
  max: number;
} {
  return {
    min: Math.max(
      MIN_TARGET_OUTPUT_TOKENS,
      Math.floor(targetOutputTokens * 0.875),
    ),
    max: Math.min(
      Math.ceil(targetOutputTokens * 1.125),
      calculateMaxOutputTokens(targetOutputTokens),
    ),
  };
}
