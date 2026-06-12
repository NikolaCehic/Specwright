import { z } from "zod";
import { SourceAuthoritySchema, SourceRefSchema } from "@specwright/schemas";
import type { SourceAuthority, SourceRef } from "@specwright/schemas";
import { ChunkSchema } from "../chunk";
import type { Chunk, ChunkingStrategyStamp } from "../chunk";
import type { InMemoryChunkStore } from "../chunk-store";
import { MemoryClassSchema, TrustLabelSchema } from "../corpus";
import type { MemoryClass, TrustLabel } from "../corpus";
import { MemoryError } from "../errors";
import { Sha256HashSchema, hashValue } from "../hash";
import type { Sha256Hash } from "../hash";
import {
  PROSE_ANALYZER_CONFIG,
  createLexicalAnalyzer,
  parseLexicalAnalyzerConfig
} from "./analyzer";
import type { LexicalAnalyzerConfig } from "./analyzer";
import {
  DEFAULT_BM25_CONFIG,
  parseBM25Config
} from "./config";
import type { BM25Config } from "./config";
import {
  LEXICAL_INDEX_FORMAT_VERSION,
  buildLexicalIndexVersion
} from "./index-version";

const nonEmptyString = z.string().min(1);

export const LexicalIndexedChunkSchema = z
  .object({
    chunkId: nonEmptyString,
    documentId: nonEmptyString,
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    class: MemoryClassSchema,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    contentHash: Sha256HashSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    chunkingStrategy: z
      .object({
        id: nonEmptyString,
        version: Sha256HashSchema
      })
      .strict(),
    ordinal: z.number().int().min(0),
    length: z.number().int().min(0),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type LexicalIndexedChunk = z.infer<typeof LexicalIndexedChunkSchema>;

export interface LexicalPosting {
  readonly chunkId: string;
  readonly sourceHash: Sha256Hash;
  readonly termFrequency: number;
  readonly positions: readonly number[];
}

export interface LexicalTermStats {
  readonly term: string;
  readonly documentFrequency: number;
  readonly postings: readonly LexicalPosting[];
}

export interface LexicalIndex {
  readonly indexId: string;
  readonly indexVersion: Sha256Hash;
  readonly indexFormatVersion: typeof LEXICAL_INDEX_FORMAT_VERSION;
  readonly analyzer: LexicalAnalyzerConfig;
  readonly bm25: BM25Config;
  readonly corpusSnapshotHash: Sha256Hash;
  readonly corpusIds: readonly string[];
  readonly tenantIds: readonly string[];
  readonly chunkingStrategyVersion: Sha256Hash;
  readonly chunkingStrategyVersions: readonly Sha256Hash[];
  readonly chunkCount: number;
  readonly averageChunkLength: number;
  readonly chunkIds: readonly string[];
  readonly chunksById: ReadonlyMap<string, LexicalIndexedChunk>;
  readonly termStats: ReadonlyMap<string, LexicalTermStats>;
}

export interface BuildLexicalIndexInput {
  readonly chunks: readonly unknown[];
  readonly analyzer?: unknown;
  readonly bm25?: unknown;
  readonly indexId?: string;
}

export interface BuildLexicalIndexFromStoreInput
  extends Omit<BuildLexicalIndexInput, "chunks"> {
  readonly store: InMemoryChunkStore;
  readonly chunkIds: readonly string[];
}

export function buildLexicalIndex(input: BuildLexicalIndexInput): LexicalIndex {
  const analyzerConfig = parseLexicalAnalyzerConfig(
    input.analyzer ?? PROSE_ANALYZER_CONFIG
  );
  const analyzer = createLexicalAnalyzer(analyzerConfig);
  const bm25 = parseBM25Config(input.bm25 ?? DEFAULT_BM25_CONFIG);
  const chunks = parseIndexChunks(input.chunks);

  if (chunks.length === 0) {
    throw new MemoryError({
      code: "invalid_lexical_index",
      field: "chunks",
      condition: "empty",
      message: "Lexical index requires at least one chunk"
    });
  }

  const chunksById = new Map<string, LexicalIndexedChunk>();
  const termPostings = new Map<
    string,
    Map<string, { sourceHash: Sha256Hash; positions: number[] }>
  >();
  let totalLength = 0;

  for (const chunk of chunks) {
    if (chunksById.has(chunk.chunkId)) {
      throw new MemoryError({
        code: "index_corruption",
        field: "chunkId",
        condition: chunk.chunkId,
        message: `Duplicate chunk id ${chunk.chunkId}`
      });
    }

    assertSourceTrace(chunk);
    const analyzed = analyzer.analyze(chunk.text);
    totalLength += analyzed.length;

    chunksById.set(
      chunk.chunkId,
      LexicalIndexedChunkSchema.parse({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        corpusId: chunk.corpusId,
        tenantId: chunk.tenantId,
        class: chunk.class,
        sourceRef: chunk.sourceRef,
        sourceHash: chunk.sourceHash,
        contentHash: chunk.contentHash,
        authority: chunk.authority,
        trustLabel: chunk.trustLabel,
        chunkingStrategy: chunk.chunkingStrategy,
        ordinal: chunk.ordinal,
        length: analyzed.length,
        ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata })
      })
    );

    for (const token of analyzed) {
      const postingsForTerm =
        termPostings.get(token.term) ??
        new Map<string, { sourceHash: Sha256Hash; positions: number[] }>();
      const posting =
        postingsForTerm.get(chunk.chunkId) ??
        { sourceHash: chunk.sourceHash, positions: [] };
      posting.positions.push(token.position);
      postingsForTerm.set(chunk.chunkId, posting);
      termPostings.set(token.term, postingsForTerm);
    }
  }

  const termStats = new Map<string, LexicalTermStats>();
  for (const term of [...termPostings.keys()].sort()) {
    const postingsForTerm = termPostings.get(term);
    if (postingsForTerm === undefined) {
      continue;
    }

    const postings: LexicalPosting[] = [...postingsForTerm.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([chunkId, posting]) => ({
        chunkId,
        sourceHash: posting.sourceHash,
        termFrequency: posting.positions.length,
        positions: [...posting.positions].sort((left, right) => left - right)
      }));

    termStats.set(term, {
      term,
      documentFrequency: postings.length,
      postings
    });
  }

  const chunkIds = [...chunksById.keys()].sort();
  const corpusIds = uniqueSorted(chunks.map((chunk) => chunk.corpusId));
  const tenantIds = uniqueSorted(chunks.map((chunk) => chunk.tenantId));
  const chunkingStrategyVersions = uniqueSorted(
    chunks.map((chunk) => chunk.chunkingStrategy.version)
  ) as Sha256Hash[];
  const firstChunkingStrategyVersion = chunkingStrategyVersions[0];
  if (firstChunkingStrategyVersion === undefined) {
    throw new MemoryError({
      code: "invalid_lexical_index",
      field: "chunkingStrategyVersions",
      condition: "empty",
      message: "Lexical index requires at least one chunking strategy version"
    });
  }
  const corpusSnapshotHash = hashValue(
    chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      contentHash: chunk.contentHash,
      sourceHash: chunk.sourceHash,
      chunkingStrategy: chunk.chunkingStrategy
    }))
  );
  const chunkingStrategyVersion =
    chunkingStrategyVersions.length === 1
      ? firstChunkingStrategyVersion
      : hashValue({ chunkingStrategyVersions });
  const indexVersion = buildLexicalIndexVersion({
    corpusSnapshotHash,
    chunkingStrategyVersions,
    analyzer: analyzerConfig,
    bm25,
    indexFormatVersion: LEXICAL_INDEX_FORMAT_VERSION
  });

  return {
    indexId:
      input.indexId ??
      `idx.lexical.${hashValue({
        corpusIds,
        tenantIds,
        corpusSnapshotHash
      }).slice("sha256:".length, "sha256:".length + 16)}`,
    indexVersion,
    indexFormatVersion: LEXICAL_INDEX_FORMAT_VERSION,
    analyzer: analyzerConfig,
    bm25,
    corpusSnapshotHash,
    corpusIds,
    tenantIds,
    chunkingStrategyVersion,
    chunkingStrategyVersions,
    chunkCount: chunks.length,
    averageChunkLength: chunks.length === 0 ? 0 : totalLength / chunks.length,
    chunkIds,
    chunksById,
    termStats
  };
}

export function buildLexicalIndexFromStore(
  input: BuildLexicalIndexFromStoreInput
): LexicalIndex {
  const chunks = [...input.chunkIds].sort().map((chunkId) => {
    const chunk = input.store.getByChunkId(chunkId);
    if (chunk === undefined) {
      throw new MemoryError({
        code: "index_corruption",
        field: "chunkId",
        condition: chunkId,
        message: `Chunk ${chunkId} is not present in the chunk store`
      });
    }

    return chunk;
  });

  return buildLexicalIndex({
    chunks,
    ...(input.analyzer === undefined ? {} : { analyzer: input.analyzer }),
    ...(input.bm25 === undefined ? {} : { bm25: input.bm25 }),
    ...(input.indexId === undefined ? {} : { indexId: input.indexId })
  });
}

export function getPosting(
  index: LexicalIndex,
  term: string,
  chunkId: string
): LexicalPosting | undefined {
  return index.termStats
    .get(term)
    ?.postings.find((posting) => posting.chunkId === chunkId);
}

function parseIndexChunks(input: readonly unknown[]): Chunk[] {
  return input
    .map((chunk) => {
      const parsed = ChunkSchema.safeParse(chunk);
      if (!parsed.success) {
        throw new MemoryError({
          code: "invalid_chunk",
          field: "chunks",
          condition: "schema",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "chunk"}: ${issue.message}`)
            .join("; ")
        });
      }

      return parsed.data;
    })
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}

function assertSourceTrace(chunk: Chunk): void {
  if (typeof chunk.sourceRef !== "string") {
    const sourceRefContentHash = chunk.sourceRef.contentHash;
    if (
      sourceRefContentHash !== undefined &&
      sourceRefContentHash !== chunk.sourceHash
    ) {
      throw new MemoryError({
        code: "index_corruption",
        field: "sourceHash",
        condition: chunk.chunkId,
        message: `Chunk ${chunk.chunkId} sourceHash does not match sourceRef contentHash`
      });
    }
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
