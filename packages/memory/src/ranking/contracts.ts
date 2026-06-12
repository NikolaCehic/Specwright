import { z } from "zod";
import {
  CacheStatusSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import type { CacheStatus, SourceAuthority, SourceRef } from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "../corpus";
import type { TrustLabel } from "../corpus";
import { MemoryError } from "../errors";
import { Sha256HashSchema } from "../hash";
import type { Sha256Hash } from "../hash";
import { AnnParamsSchema, DistanceMetricSchema } from "../dense-contracts";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().positive();

export const RetrieverNameSchema = z.enum(["bm25", "proximity", "dense"]);
export type RetrieverName = z.infer<typeof RetrieverNameSchema>;

export const FusionMethodSchema = z.enum(["rrf", "weighted", "rrf_weighted"]);
export type FusionMethod = z.infer<typeof FusionMethodSchema>;

export const NormalizationModeSchema = z.enum([
  "rank_based",
  "min_max",
  "z_score"
]);
export type NormalizationMode = z.infer<typeof NormalizationModeSchema>;

export const DiversificationMethodSchema = z.enum(["mmr", "none"]);
export type DiversificationMethod = z.infer<typeof DiversificationMethodSchema>;

export const RerankDegradationSchema = z.enum([
  "rerank_disabled",
  "rerank_skipped",
  "empty_result",
  "low_confidence"
]);
export type RerankDegradation = z.infer<typeof RerankDegradationSchema>;

export const RetrieverScoreMapSchema = z
  .object({
    bm25: z.number().finite().optional(),
    proximity: z.number().finite().optional(),
    dense: z.number().finite().optional()
  })
  .strict()
  .refine(
    (scores) =>
      scores.bm25 !== undefined ||
      scores.proximity !== undefined ||
      scores.dense !== undefined,
    { message: "at least one retriever score is required" }
  );
export type RetrieverScoreMap = z.infer<typeof RetrieverScoreMapSchema>;

export const RetrieverRankMapSchema = z
  .object({
    bm25: positiveInteger.optional(),
    proximity: positiveInteger.optional(),
    dense: positiveInteger.optional()
  })
  .strict();
export type RetrieverRankMap = z.infer<typeof RetrieverRankMapSchema>;

export const RetrieverWeightMapSchema = z
  .object({
    bm25: z.number().finite().nonnegative().optional(),
    proximity: z.number().finite().nonnegative().optional(),
    dense: z.number().finite().nonnegative().optional()
  })
  .strict();
export type RetrieverWeightMap = z.infer<typeof RetrieverWeightMapSchema>;

export const CandidateSetSizesSchema = z
  .object({
    bm25: nonNegativeInteger.optional(),
    proximity: nonNegativeInteger.optional(),
    dense: nonNegativeInteger.optional()
  })
  .strict();
export type CandidateSetSizes = z.infer<typeof CandidateSetSizesSchema>;

export const RankerCandidateSchema = z
  .object({
    chunkId: nonEmptyString,
    documentId: nonEmptyString,
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    class: MemoryClassSchema.optional(),
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    chunkingStrategyVersion: Sha256HashSchema,
    scores: RetrieverScoreMapSchema,
    retrieverRanks: RetrieverRankMapSchema.default({}),
    injectionFlag: z.boolean()
  })
  .strict();
export type RankerCandidate = z.infer<typeof RankerCandidateSchema>;

export const NormalizedCandidateSchema = RankerCandidateSchema.extend({
  normalized: RetrieverScoreMapSchema
});
export type NormalizedCandidate = z.infer<typeof NormalizedCandidateSchema>;

export const FusedCandidateSchema = NormalizedCandidateSchema.extend({
  fusedScore: z.number().finite(),
  fusionRank: positiveInteger
});
export type FusedCandidate = z.infer<typeof FusedCandidateSchema>;

export const RerankedCandidateSchema = FusedCandidateSchema.extend({
  rerankScore: z.number().finite().optional(),
  rerankRank: positiveInteger.optional()
});
export type RerankedCandidate = z.infer<typeof RerankedCandidateSchema>;

export const RetrievalFusionConfigSchema = z
  .object({
    method: FusionMethodSchema.default("rrf"),
    weights: RetrieverWeightMapSchema.default({}),
    rrfK: positiveInteger.default(60),
    normalization: NormalizationModeSchema.default("rank_based")
  })
  .strict();
export type RetrievalFusionConfig = z.infer<
  typeof RetrievalFusionConfigSchema
>;

export const RetrievalRerankConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: nonEmptyString.optional(),
    topN: positiveInteger.max(1000).default(50)
  })
  .strict();
export type RetrievalRerankConfig = z.infer<
  typeof RetrievalRerankConfigSchema
>;

export const RetrievalDiversifyConfigSchema = z
  .object({
    method: DiversificationMethodSchema.default("mmr"),
    lambda: z.number().finite().min(0).max(1).default(0.7),
    similarityMetric: nonEmptyString.default("metadata_source_similarity_v1")
  })
  .strict();
export type RetrievalDiversifyConfig = z.infer<
  typeof RetrievalDiversifyConfigSchema
>;

export const RetrievalQuerySchema = z
  .object({
    tenantId: nonEmptyString.optional(),
    corpusIds: z.array(nonEmptyString).min(1).optional(),
    query: nonEmptyString,
    k: z.number().int().min(0).max(1000).default(8),
    retrievers: z.array(RetrieverNameSchema).min(1).default([
      "bm25",
      "proximity",
      "dense"
    ]),
    fusion: RetrievalFusionConfigSchema.default({}),
    rerank: RetrievalRerankConfigSchema.default({}),
    diversify: RetrievalDiversifyConfigSchema.default({}),
    confidenceFloor: z.number().finite().optional(),
    redactionProfileVersion: nonEmptyString.default("not_applied")
  })
  .strict();
export type RetrievalQuery = z.infer<typeof RetrievalQuerySchema>;
export type RetrievalQueryInput = z.input<typeof RetrievalQuerySchema>;

export const ProvenanceFusionSchema = z
  .object({
    method: FusionMethodSchema,
    weights: RetrieverWeightMapSchema,
    rrfK: positiveInteger.optional()
  })
  .strict();
export type ProvenanceFusion = z.infer<typeof ProvenanceFusionSchema>;

export const MemoryProvenanceSchema = z
  .object({
    corpusIds: z.array(nonEmptyString),
    indexId: nonEmptyString,
    indexVersion: Sha256HashSchema,
    embeddingProvider: nonEmptyString,
    embeddingModel: nonEmptyString,
    embeddingModelVersion: nonEmptyString,
    embeddingDims: nonNegativeInteger,
    distanceMetric: z.union([DistanceMetricSchema, z.literal("not_applicable")]),
    chunkingStrategy: nonEmptyString,
    chunkingStrategyVersion: Sha256HashSchema,
    retrievers: z.array(RetrieverNameSchema).min(1),
    candidateSetSizes: CandidateSetSizesSchema,
    normalizationMode: NormalizationModeSchema,
    fusion: ProvenanceFusionSchema,
    rerankModel: nonEmptyString.optional(),
    rerankModelVersion: nonEmptyString.optional(),
    rerankTopN: nonNegativeInteger.optional(),
    rerankSkipped: z.boolean().default(false),
    degraded: z.array(RerankDegradationSchema).default([]),
    mmrLambda: z.number().finite().min(0).max(1),
    mmrSimilarityMetric: nonEmptyString,
    annParams: z.union([AnnParamsSchema, z.record(z.string(), z.unknown())]),
    redactionProfileVersion: nonEmptyString,
    cacheStatus: CacheStatusSchema,
    queryHash: Sha256HashSchema,
    emptyResult: z.boolean().default(false),
    redactionSafe: z.literal(true)
  })
  .strict();
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const RankedHitSchema = z
  .object({
    chunkId: nonEmptyString,
    documentId: nonEmptyString,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    scores: RetrieverScoreMapSchema,
    normalized: RetrieverScoreMapSchema,
    fusedScore: z.number().finite(),
    rerankScore: z.number().finite().optional(),
    rank: positiveInteger,
    injectionFlag: z.boolean(),
    candidateSetSizes: CandidateSetSizesSchema,
    cacheStatus: CacheStatusSchema,
    queryHash: Sha256HashSchema
  })
  .strict();
export type RankedHit = z.infer<typeof RankedHitSchema>;

export const RetrievalResultSchema = z
  .object({
    queryHash: Sha256HashSchema,
    hits: z.array(RankedHitSchema),
    provenance: MemoryProvenanceSchema
  })
  .strict();
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

export interface CandidateIdentity {
  readonly chunkId: string;
  readonly documentId: string;
  readonly corpusId: string;
  readonly tenantId: string;
  readonly sourceRef: SourceRef;
  readonly sourceHash: Sha256Hash;
  readonly authority: SourceAuthority;
  readonly trustLabel: TrustLabel;
  readonly chunkingStrategyVersion: Sha256Hash;
  readonly injectionFlag: boolean;
}

export function parseRetrievalQuery(input: RetrievalQueryInput): RetrievalQuery {
  const parsed = RetrievalQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "output_invalid",
      field: "query",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export function parseRankerCandidate(input: unknown): RankerCandidate {
  const parsed = RankerCandidateSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "output_invalid",
      field: "candidate",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "candidate"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export function parseRetrievalResult(input: unknown): RetrievalResult {
  const parsed = RetrievalResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "output_invalid",
      field: "retrievalResult",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) =>
          `${issue.path.join(".") || "retrievalResult"}: ${issue.message}`
        )
        .join("; ")
    });
  }

  return parsed.data;
}

export function retrieverNames(): readonly RetrieverName[] {
  return ["bm25", "proximity", "dense"];
}
