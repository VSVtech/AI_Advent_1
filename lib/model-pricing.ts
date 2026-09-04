export interface ModelPricing {
  /** USD per 1,000,000 input tokens not served from the context cache. */
  inputPerMillion: number;
  /** USD per 1,000,000 input tokens served from the context cache. */
  cachedInputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
}

// Best publicly known DeepSeek API pricing as of early September 2026
// (https://api-docs.deepseek.com/quick_start/pricing). DeepSeek has
// signalled a broader price change without publishing exact replacement
// rates yet, so treat this as an approximation and update it once new
// rates are published. Models not listed here show no cost estimate
// rather than a guessed number.
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'deepseek-v4-flash': {
    inputPerMillion: 0.14,
    cachedInputPerMillion: 0.0028,
    outputPerMillion: 0.28,
  },
  'deepseek-v4-pro': {
    inputPerMillion: 0.435,
    cachedInputPerMillion: 0.003625,
    outputPerMillion: 0.87,
  },
};

// Returns null (rather than a guess) when the model has no known pricing,
// or when either token count is missing.
export function estimateCostUsd(
  model: string,
  inputTokens: number | null,
  cachedInputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const pricing = MODEL_PRICING[model];

  if (!pricing || inputTokens === null || outputTokens === null) return null;

  const uncachedInputTokens = Math.max(0, inputTokens - (cachedInputTokens ?? 0));

  return (
    (uncachedInputTokens / 1_000_000) * pricing.inputPerMillion +
    ((cachedInputTokens ?? 0) / 1_000_000) * pricing.cachedInputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}
