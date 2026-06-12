import { z } from "zod";
import {
  CacheStatusSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "./corpus";
import { MemoryError } from "./errors";
import { Sha256HashSchema } from "./hash";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().positive();

export const DistanceMetricSchema = z.enum(["cosine", "inner_product", "l2"]);
export type DistanceMetric = z.infer<typeof DistanceMetricSchema>;

export const EmbeddingDescriptorSchema = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
    modelVersion: nonEmptyString,
    dims: positiveInteger.max(4096),
    distanceMetric: DistanceMetricSchema
  })
  .strict();
export type EmbeddingDescriptor = z.infer<typeof EmbeddingDescriptorSchema>;

export const HnswAnnParamsSchema = z
  .object({
    kind: z.literal("hnsw"),
    m: z.number().int().min(1).max(64),
    efConstruction: z.number().int().min(1).max(2048),
    efSearch: z.number().int().min(1).max(2048),
    levelSeed: nonEmptyString,
    maxLevel: z.number().int().min(0).max(16)
  })
  .strict();
export type HnswAnnParams = z.infer<typeof HnswAnnParamsSchema>;

export const DEFAULT_HNSW_ANN_PARAMS = {
  kind: "hnsw",
  m: 8,
  efConstruction: 32,
  efSearch: 32,
  levelSeed: "specwright-hnsw-v1",
  maxLevel: 4
} satisfies HnswAnnParams;

export const ExactAnnParamsSchema = z
  .object({
    kind: z.literal("exact")
  })
  .strict();
export type ExactAnnParams = z.infer<typeof ExactAnnParamsSchema>;

export const AnnParamsSchema = z.discriminatedUnion("kind", [
  HnswAnnParamsSchema,
  ExactAnnParamsSchema
]);
export type AnnParams = z.infer<typeof AnnParamsSchema>;

export const DenseIndexedChunkSchema = z
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
    ordinal: nonNegativeInteger,
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type DenseIndexedChunk = z.infer<typeof DenseIndexedChunkSchema>;

export const DenseIndexVersionDescriptorSchema = z
  .object({
    indexId: nonEmptyString,
    indexVersion: Sha256HashSchema,
    indexFormatVersion: nonEmptyString,
    corpusSnapshotHash: Sha256HashSchema,
    embedding: EmbeddingDescriptorSchema,
    annParams: HnswAnnParamsSchema,
    chunkingStrategyVersion: Sha256HashSchema,
    chunkingStrategyVersions: z.array(Sha256HashSchema).min(1),
    segmentIntegrityHash: Sha256HashSchema
  })
  .strict();
export type DenseIndexVersionDescriptor = z.infer<
  typeof DenseIndexVersionDescriptorSchema
>;

export const DenseCandidateSchema = z
  .object({
    chunkId: nonEmptyString,
    documentId: nonEmptyString,
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    chunkingStrategyVersion: Sha256HashSchema,
    denseScore: z.number().finite(),
    rank: z.number().int().positive(),
    distanceMetric: DistanceMetricSchema,
    injectionFlag: z.literal(false)
  })
  .strict();
export type DenseCandidate = z.infer<typeof DenseCandidateSchema>;

export const DenseProvenanceSchema = z
  .object({
    corpusIds: z.array(nonEmptyString),
    indexId: nonEmptyString,
    indexVersion: Sha256HashSchema,
    indexFormatVersion: nonEmptyString,
    embeddingProvider: nonEmptyString,
    embeddingModel: nonEmptyString,
    embeddingModelVersion: nonEmptyString,
    embeddingDims: positiveInteger,
    distanceMetric: DistanceMetricSchema,
    annParams: HnswAnnParamsSchema,
    chunkingStrategyVersion: Sha256HashSchema,
    chunkingStrategyVersions: z.array(Sha256HashSchema).min(1),
    candidateSetSize: nonNegativeInteger,
    cacheStatus: CacheStatusSchema,
    queryHash: Sha256HashSchema,
    redactionSafe: z.literal(true)
  })
  .strict();
export type DenseProvenance = z.infer<typeof DenseProvenanceSchema>;

export const DenseRetrievalResultSchema = z
  .object({
    queryHash: Sha256HashSchema,
    hits: z.array(DenseCandidateSchema),
    provenance: DenseProvenanceSchema
  })
  .strict();
export type DenseRetrievalResult = z.infer<typeof DenseRetrievalResultSchema>;

export function parseEmbeddingDescriptor(input: unknown): EmbeddingDescriptor {
  const parsed = EmbeddingDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_embedding_descriptor",
      field: "embedding",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "embedding"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export function parseAnnParams(input: unknown = DEFAULT_HNSW_ANN_PARAMS): HnswAnnParams {
  const parsed = HnswAnnParamsSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_vector_index",
      field: "annParams",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "annParams"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export function parseDenseRetrievalResult(
  input: unknown
): DenseRetrievalResult {
  const parsed = DenseRetrievalResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "output_invalid",
      field: "denseResult",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "denseResult"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}
