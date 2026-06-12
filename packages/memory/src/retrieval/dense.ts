import { z } from "zod";
import { CacheStatusSchema, SourceAuthoritySchema } from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "../corpus";
import {
  DenseCandidateSchema,
  DenseProvenanceSchema,
  type DenseCandidate,
  type DenseRetrievalResult,
  parseDenseRetrievalResult
} from "../dense-contracts";
import { MemoryError } from "../errors";
import { Sha256HashSchema, hashValue } from "../hash";
import type { Sha256Hash } from "../hash";
import type { EmbeddingProviderRegistry } from "../embedding";
import { embedQueryChecked } from "../embedding";
import type { DenseVectorIndex, DenseVectorIndexStore } from "../vector";
import { searchDenseVectorIndex } from "../vector";

const nonEmptyString = z.string().min(1);

export const DenseStructuralFilterSchema = z
  .object({
    corpusIds: z.array(nonEmptyString).min(1).optional(),
    documentIds: z.array(nonEmptyString).min(1).optional(),
    tenantIds: z.array(nonEmptyString).min(1).optional(),
    classes: z.array(MemoryClassSchema).min(1).optional(),
    authorities: z.array(SourceAuthoritySchema).min(1).optional(),
    trustLabels: z.array(TrustLabelSchema).min(1).optional(),
    tags: z.array(nonEmptyString).min(1).optional()
  })
  .strict();
export type DenseStructuralFilter = z.infer<typeof DenseStructuralFilterSchema>;

export const DenseRetrieverQuerySchema = z
  .object({
    text: nonEmptyString,
    k: z.number().int().min(0).max(1000).default(10),
    maxCandidates: z.number().int().min(0).max(10000).default(200),
    filters: DenseStructuralFilterSchema.optional(),
    indexVersion: Sha256HashSchema.optional(),
    expectedIndexVersion: Sha256HashSchema.optional(),
    cacheStatus: CacheStatusSchema.default("miss")
  })
  .strict();
export type DenseRetrieverQuery = z.input<typeof DenseRetrieverQuerySchema>;

export class DenseRetriever {
  readonly indexStore: DenseVectorIndexStore;
  readonly providerRegistry: EmbeddingProviderRegistry;

  constructor(input: {
    readonly indexStore: DenseVectorIndexStore;
    readonly providerRegistry: EmbeddingProviderRegistry;
  }) {
    this.indexStore = input.indexStore;
    this.providerRegistry = input.providerRegistry;
  }

  async retrieve(input: DenseRetrieverQuery): Promise<DenseRetrievalResult> {
    const query = parseDenseQuery(input);
    const index = this.indexStore.resolve(query.indexVersion);
    if (
      query.expectedIndexVersion !== undefined &&
      query.expectedIndexVersion !== index.indexVersion
    ) {
      throw new MemoryError({
        code: "dense_version_mismatch",
        field: "indexVersion",
        condition: query.expectedIndexVersion,
        message: `Dense query expected index ${query.expectedIndexVersion}, but resolved ${index.indexVersion}`
      });
    }

    const normalizedQuery = normalizeDenseQueryText(query.text);
    const queryHash = hashValue(normalizedQuery);
    const queryVector = await this.embedQueryForIndex(index, normalizedQuery);
    const allowedChunkIds = filterChunkIds(index, query.filters);
    const searchCandidates = searchDenseVectorIndex(
      index,
      queryVector,
      query.maxCandidates,
      allowedChunkIds
    );
    const hits = searchCandidates
      .slice(0, query.k)
      .map((candidate, rankIndex) =>
        buildDenseCandidate(index, candidate.chunkId, candidate.score, rankIndex + 1)
      );

    return parseDenseRetrievalResult({
      queryHash,
      hits,
      provenance: DenseProvenanceSchema.parse({
        corpusIds: index.corpusIds,
        indexId: index.indexId,
        indexVersion: index.indexVersion,
        indexFormatVersion: index.indexFormatVersion,
        embeddingProvider: index.embedding.provider,
        embeddingModel: index.embedding.model,
        embeddingModelVersion: index.embedding.modelVersion,
        embeddingDims: index.embedding.dims,
        distanceMetric: index.embedding.distanceMetric,
        annParams: index.annParams,
        chunkingStrategyVersion: index.chunkingStrategyVersion,
        chunkingStrategyVersions: index.chunkingStrategyVersions,
        candidateSetSize: searchCandidates.length,
        cacheStatus: query.cacheStatus,
        queryHash,
        redactionSafe: true
      })
    });
  }

  async embedQueryForIndex(
    index: DenseVectorIndex,
    text: string
  ): Promise<Float32Array> {
    const provider = this.providerRegistry.resolve(index.embedding);
    const vector = await embedQueryChecked(provider, normalizeDenseQueryText(text));
    if (vector.length !== index.embedding.dims) {
      throw new MemoryError({
        code: "dimension_mismatch",
        field: "query",
        condition: `${vector.length}!=${index.embedding.dims}`,
        message: `Dense query vector dimension ${vector.length} does not match index dimension ${index.embedding.dims}`
      });
    }

    return vector;
  }
}

export async function retrieveDense(
  retriever: DenseRetriever,
  query: DenseRetrieverQuery
): Promise<DenseRetrievalResult> {
  return retriever.retrieve(query);
}

export function normalizeDenseQueryText(query: string): string {
  return query.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function parseDenseQuery(
  input: DenseRetrieverQuery
): z.infer<typeof DenseRetrieverQuerySchema> {
  const parsed = DenseRetrieverQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_dense_query",
      field: "query",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

function buildDenseCandidate(
  index: DenseVectorIndex,
  chunkId: string,
  score: number,
  rank: number
): DenseCandidate {
  const node = index.nodesById.get(chunkId);
  if (node === undefined) {
    throw new MemoryError({
      code: "index_corrupt",
      field: "chunkId",
      condition: chunkId,
      message: `Dense search returned missing chunk ${chunkId}`
    });
  }

  return DenseCandidateSchema.parse({
    chunkId: node.chunk.chunkId,
    documentId: node.chunk.documentId,
    corpusId: node.chunk.corpusId,
    tenantId: node.chunk.tenantId,
    sourceRef: node.chunk.sourceRef,
    sourceHash: node.chunk.sourceHash,
    authority: node.chunk.authority,
    trustLabel: node.chunk.trustLabel,
    chunkingStrategyVersion: node.chunk.chunkingStrategy.version,
    denseScore: score,
    rank,
    distanceMetric: index.embedding.distanceMetric,
    injectionFlag: false
  });
}

function filterChunkIds(
  index: DenseVectorIndex,
  filters: DenseStructuralFilter | undefined
): ReadonlySet<string> | undefined {
  if (filters === undefined) {
    return undefined;
  }

  const allowed = new Set<string>();
  for (const [chunkId, node] of index.nodesById) {
    if (matchesFilters(node.chunk, filters)) {
      allowed.add(chunkId);
    }
  }

  return allowed;
}

function matchesFilters(
  chunk: DenseVectorIndex["nodesById"] extends ReadonlyMap<string, infer T>
    ? T extends { readonly chunk: infer C }
      ? C
      : never
    : never,
  filters: DenseStructuralFilter
): boolean {
  return (
    matchesList(filters.corpusIds, chunk.corpusId) &&
    matchesList(filters.documentIds, chunk.documentId) &&
    matchesList(filters.tenantIds, chunk.tenantId) &&
    matchesList(filters.classes, chunk.class) &&
    matchesList(filters.authorities, chunk.authority) &&
    matchesList(filters.trustLabels, chunk.trustLabel) &&
    matchesTags(filters.tags, chunk.metadata?.tags)
  );
}

function matchesList<T extends string>(
  allowed: readonly T[] | undefined,
  value: T
): boolean {
  return allowed === undefined || allowed.includes(value);
}

function matchesTags(
  requiredTags: readonly string[] | undefined,
  metadataTags: unknown
): boolean {
  if (requiredTags === undefined) {
    return true;
  }

  if (
    !Array.isArray(metadataTags) ||
    !metadataTags.every((tag): tag is string => typeof tag === "string")
  ) {
    return false;
  }

  return requiredTags.every((tag) => metadataTags.includes(tag));
}
