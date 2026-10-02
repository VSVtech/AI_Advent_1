export type RagChunk = {
  chunk_id: string;
  source: string;
  title: string;
  section: string;
  text: string;
  start_line: number;
  end_line: number;
  token_count: number;
  score?: number;
};
export type RagStrategy = {
  id: string;
  label: string;
  size: number;
  overlap: number;
};
export type RagDocument = {
  source: string;
  title: string;
  characters: number;
  lines: number;
  words: number;
};
export type RagStats = {
  chunks: number;
  min_tokens: number;
  median_tokens: number;
  max_tokens: number;
  duplicate_character_ratio: number;
  elapsed_ms: number;
  cache_hits: number;
};
export type RagComparisonRow = RagStats & {
  strategy: string;
  label: string;
  index_bytes: number;
  hit_at_5: number;
  mrr_at_5: number;
  results: { id: string; question: string; rank: number | null }[];
};
export type RagStatus = {
  current: null | {
    build_id: string;
    created_at: string;
    strategies: {
      strategy: RagStrategy;
      stats: RagStats;
      index_bytes: number;
      dimensions: number;
      embedding: { model: string };
      documents: RagDocument[];
    }[];
  };
  documents: RagDocument[];
  strategies: RagStrategy[];
  stale: boolean;
  job: {
    status: string;
    action: string | null;
    error: string | null;
    progress: null | { strategy: string; completed: number; total: number };
  };
  comparison: null | { question_count: number; rows: RagComparisonRow[] };
};
