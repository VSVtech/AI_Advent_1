export const DEFAULT_TARGET_OUTPUT_TOKENS = 500;
export const MIN_TARGET_OUTPUT_TOKENS = 50;
export const MAX_MAX_OUTPUT_TOKENS = 100_000;
export const MIN_OUTPUT_TOKEN_HEADROOM = 500;
export const MAX_OUTPUT_TOKEN_HEADROOM = 2000;
export const MAX_TARGET_OUTPUT_TOKENS =
  MAX_MAX_OUTPUT_TOKENS - MAX_OUTPUT_TOKEN_HEADROOM;

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

export function isValidTargetOutputTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TARGET_OUTPUT_TOKENS &&
    value <= MAX_TARGET_OUTPUT_TOKENS
  );
}

export function calculateMaxOutputTokens(targetOutputTokens: number): number {
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
