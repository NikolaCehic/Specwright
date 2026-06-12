import { z } from "zod";
import type { CandidateChunk, Chunk } from "../chunk";
import { finalizeChunk } from "../chunk";
import type { MemoryDocument } from "../document";
import { parseMemoryDocument } from "../document";
import { MemoryError } from "../errors";
import type { Sha256Hash } from "../hash";
import { FixedOverlapChunkingStrategy } from "./fixed-overlap";
import { SemanticChunkingStrategy } from "./semantic";
import { StructuralChunkingStrategy } from "./structural";

export interface ChunkingStrategy<TConfig = unknown> {
  readonly id: string;
  readonly configSchema: z.ZodTypeAny;
  version(config: unknown): Sha256Hash;
  chunk(document: MemoryDocument, config: unknown): CandidateChunk[];
}

export const BuiltInChunkingStrategies = [
  FixedOverlapChunkingStrategy,
  StructuralChunkingStrategy,
  SemanticChunkingStrategy
] as const;

export class ChunkingStrategyRegistry {
  private readonly strategies = new Map<string, ChunkingStrategy>();

  constructor(strategies: readonly ChunkingStrategy[] = []) {
    for (const strategy of strategies) {
      this.register(strategy);
    }
  }

  register(strategy: ChunkingStrategy): void {
    if (this.strategies.has(strategy.id)) {
      throw new MemoryError({
        code: "unsupported_strategy",
        field: "strategy.id",
        condition: "duplicate",
        message: `Duplicate chunking strategy id: ${strategy.id}`
      });
    }

    this.strategies.set(strategy.id, strategy);
  }

  get(strategyId: string): ChunkingStrategy {
    const strategy = this.strategies.get(strategyId);
    if (strategy === undefined) {
      throw new MemoryError({
        code: "unsupported_strategy",
        field: "strategyId",
        condition: "missing",
        message: `Unsupported chunking strategy: ${strategyId}`
      });
    }

    return strategy;
  }

  list(): ChunkingStrategy[] {
    return [...this.strategies.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }
}

export const defaultChunkingStrategyRegistry = new ChunkingStrategyRegistry(
  BuiltInChunkingStrategies
);

export interface ChunkDocumentInput {
  readonly document: unknown;
  readonly strategyId: string;
  readonly config: unknown;
  readonly registry?: ChunkingStrategyRegistry;
}

export function chunkDocument(input: ChunkDocumentInput): Chunk[] {
  const document = parseMemoryDocument(input.document);
  const registry = input.registry ?? defaultChunkingStrategyRegistry;
  const strategy = registry.get(input.strategyId);
  const strategyVersion = strategy.version(input.config);
  const candidates = strategy.chunk(document, input.config);

  if (candidates.length === 0) {
    throw new MemoryError({
      code: "invalid_chunk",
      field: "chunks",
      condition: "empty",
      message: "Chunking produced no chunks"
    });
  }

  return candidates.map((candidate, ordinal) =>
    finalizeChunk({
      document,
      candidate,
      ordinal,
      strategy: {
        id: strategy.id,
        version: strategyVersion
      }
    })
  );
}

export {
  FixedOverlapChunkingStrategy,
  FixedOverlapChunkingConfigSchema
} from "./fixed-overlap";
export {
  StructuralChunkingStrategy,
  StructuralChunkingConfigSchema
} from "./structural";
export {
  SemanticChunkingStrategy,
  SemanticChunkingConfigSchema
} from "./semantic";
export { tokenizeText, TOKENIZER_ID, TOKENIZER_VERSION } from "./tokenizer";
