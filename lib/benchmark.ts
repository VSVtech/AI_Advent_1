export const BENCHMARK_MAX_PROMPT_LENGTH = 20_000;
export const BENCHMARK_MAX_OUTPUT_TOKENS = 2000;

export interface BenchmarkRequest {
  model: string;
  prompt: string;
}

export interface BenchmarkResponsePayload {
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  answer: string;
}
