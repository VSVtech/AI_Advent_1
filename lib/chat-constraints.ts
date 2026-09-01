export const DEFAULT_TARGET_OUTPUT_TOKENS = 500;
export const MIN_TARGET_OUTPUT_TOKENS = 50;
export const MAX_MAX_OUTPUT_TOKENS = 100_000;
export const MIN_OUTPUT_TOKEN_HEADROOM = 500;
export const MAX_OUTPUT_TOKEN_HEADROOM = 2000;
export const MAX_TARGET_OUTPUT_TOKENS =
  MAX_MAX_OUTPUT_TOKENS - MAX_OUTPUT_TOKEN_HEADROOM;

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
