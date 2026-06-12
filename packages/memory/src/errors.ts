export type MemoryErrorCode =
  | "unsafe_input"
  | "invalid_document"
  | "invalid_chunk"
  | "invalid_analyzer_config"
  | "invalid_lexical_index"
  | "invalid_lexical_query"
  | "lexical_version_mismatch"
  | "index_corruption"
  | "invalid_embedding_descriptor"
  | "embedding_provider_unavailable"
  | "stale_embedding_model"
  | "dimension_mismatch"
  | "invalid_vector_index"
  | "index_corrupt"
  | "invalid_dense_query"
  | "dense_version_mismatch"
  | "output_invalid"
  | "version_unavailable"
  | "recall_divergence"
  | "interrupted_build"
  | "strategy_unpinned"
  | "unsupported_strategy"
  | "hash_collision";

export interface MemoryErrorOptions {
  readonly code: MemoryErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly condition?: string;
}

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly field?: string;
  readonly condition?: string;

  constructor(options: MemoryErrorOptions) {
    super(options.message);
    this.name = "MemoryError";
    this.code = options.code;

    if (options.field !== undefined) {
      this.field = options.field;
    }

    if (options.condition !== undefined) {
      this.condition = options.condition;
    }
  }
}

export function memoryError(options: MemoryErrorOptions): MemoryError {
  return new MemoryError(options);
}

export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}
