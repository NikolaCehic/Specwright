import { z } from "zod";
import {
  ClaimLevelSchema,
  EvalFindingSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import { MemoryClassSchema } from "../../corpus";
import { Sha256HashSchema, hashValue } from "../../hash";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);

export const RETRIEVAL_EVAL_DATASET_SCHEMA_VERSION =
  "specwright.memory.retrieval-eval-dataset.v1";

export const DATASET_INVALID_CODE = "dataset.invalid";
export const DATASET_CONTENT_HASH_MISMATCH_CODE =
  "dataset.content_hash.mismatch";
export const DATASET_PINNED_VERSION_MISSING_CODE =
  "dataset.pinned_version.missing";

export const RetrievalMetricThresholdSchema = z
  .object({
    k: z.number().int().positive().max(1000),
    minimum: z.number().finite().min(0).max(1)
  })
  .strict();
export type RetrievalMetricThreshold = z.infer<
  typeof RetrievalMetricThresholdSchema
>;

export const RetrievalEvalThresholdsSchema = z
  .object({
    recallAtK: RetrievalMetricThresholdSchema,
    ndcgAtK: RetrievalMetricThresholdSchema,
    mrr: RetrievalMetricThresholdSchema,
    precisionAtK: RetrievalMetricThresholdSchema
  })
  .strict();
export type RetrievalEvalThresholds = z.infer<
  typeof RetrievalEvalThresholdsSchema
>;

export const RetrievalRelevantChunkSchema = z
  .object({
    chunkId: nonEmptyString,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    grade: z.number().finite().min(0).max(3)
  })
  .strict();
export type RetrievalRelevantChunk = z.infer<
  typeof RetrievalRelevantChunkSchema
>;

export const RetrievalEvalQuerySchema = z
  .object({
    id: nonEmptyString,
    query: nonEmptyString,
    queryHash: Sha256HashSchema.optional(),
    relevant: z.array(RetrievalRelevantChunkSchema).min(1)
  })
  .strict();
export type RetrievalEvalQuery = z.infer<typeof RetrievalEvalQuerySchema>;

export const RetrievalClaimSupportSchema = z
  .object({
    chunkId: nonEmptyString,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    modelVisibleSourceHash: Sha256HashSchema.optional()
  })
  .strict();
export type RetrievalClaimSupport = z.infer<
  typeof RetrievalClaimSupportSchema
>;

export const RetrievalGroundedClaimSchema = z
  .object({
    id: nonEmptyString,
    claim: nonEmptyString,
    claimLevel: ClaimLevelSchema,
    authority: SourceAuthoritySchema,
    owningArtifactId: nonEmptyString,
    support: z.array(RetrievalClaimSupportSchema).min(1),
    independentEvidenceRefs: z.array(nonEmptyString).default([]),
    selfArtifactId: nonEmptyString.optional()
  })
  .strict();
export type RetrievalGroundedClaim = z.infer<
  typeof RetrievalGroundedClaimSchema
>;

export const RetrievalEvalPinnedVersionsSchema = z
  .object({
    indexVersion: Sha256HashSchema,
    embeddingModelVersion: nonEmptyString,
    chunkingStrategyVersion: Sha256HashSchema
  })
  .strict();
export type RetrievalEvalPinnedVersions = z.infer<
  typeof RetrievalEvalPinnedVersionsSchema
>;

const RetrievalEvalDatasetContentBaseSchema = z
  .object({
    schemaVersion: z.literal(RETRIEVAL_EVAL_DATASET_SCHEMA_VERSION),
    datasetId: nonEmptyString,
    version: nonEmptyString,
    evalId: nonEmptyString,
    corpusClass: MemoryClassSchema,
    pinned: RetrievalEvalPinnedVersionsSchema,
    thresholds: RetrievalEvalThresholdsSchema,
    queries: z.array(RetrievalEvalQuerySchema).min(1),
    claims: z.array(RetrievalGroundedClaimSchema).default([]),
    tombstonedChunkIds: z.array(nonEmptyString).default([])
  })
  .strict();
type RetrievalEvalDatasetContentBase = z.infer<
  typeof RetrievalEvalDatasetContentBaseSchema
>;
type RetrievalEvalDatasetIdFields = Pick<
  RetrievalEvalDatasetContentBase,
  "queries" | "claims"
>;

export const RetrievalEvalDatasetContentSchema =
  RetrievalEvalDatasetContentBaseSchema.superRefine(refineDatasetIds);
export type RetrievalEvalDatasetContent = z.infer<
  typeof RetrievalEvalDatasetContentSchema
>;

export const RetrievalEvalDatasetSchema =
  RetrievalEvalDatasetContentBaseSchema.extend({
    contentHash: Sha256HashSchema
  })
    .strict()
    .superRefine(refineDatasetIds);
export type RetrievalEvalDataset = z.infer<typeof RetrievalEvalDatasetSchema>;

export const RetrievalEvalDatasetWithOptionalHashSchema =
  RetrievalEvalDatasetContentBaseSchema.extend({
    contentHash: Sha256HashSchema.optional()
  })
    .strict()
    .superRefine(refineDatasetIds);
export type RetrievalEvalDatasetWithOptionalHash = z.infer<
  typeof RetrievalEvalDatasetWithOptionalHashSchema
>;

export type RetrievalEvalDatasetLoadResult =
  | {
      status: "loaded";
      dataset: RetrievalEvalDataset;
      recomputedContentHash: string;
    }
  | {
      status: "failed";
      code:
        | typeof DATASET_INVALID_CODE
        | typeof DATASET_CONTENT_HASH_MISMATCH_CODE;
      finding: z.infer<typeof EvalFindingSchema>;
    };

export function computeRetrievalEvalDatasetContentHash(
  input: unknown
): string {
  const parsed = RetrievalEvalDatasetWithOptionalHashSchema.parse(input);
  const { contentHash: _contentHash, ...content } = parsed;
  return hashValue(content);
}

export function loadRetrievalEvalDataset(
  input: unknown
): RetrievalEvalDatasetLoadResult {
  const parsed = RetrievalEvalDatasetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "failed",
      code: DATASET_INVALID_CODE,
      finding: EvalFindingSchema.parse({
        message: "Retrieval eval dataset is invalid",
        code: DATASET_INVALID_CODE,
        targetRef: "memory:retrieval-eval-dataset",
        severity: "blocking",
        repairHint: "Fix the retrieval eval dataset schema before grading.",
        metadata: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      })
    };
  }

  const recomputedContentHash = computeRetrievalEvalDatasetContentHash(
    parsed.data
  );
  if (recomputedContentHash !== parsed.data.contentHash) {
    return {
      status: "failed",
      code: DATASET_CONTENT_HASH_MISMATCH_CODE,
      finding: EvalFindingSchema.parse({
        message: `Retrieval eval dataset ${parsed.data.datasetId}@${parsed.data.version} content hash changed`,
        code: DATASET_CONTENT_HASH_MISMATCH_CODE,
        targetRef: `memory-dataset:${parsed.data.datasetId}@${parsed.data.version}`,
        severity: "blocking",
        repairHint:
          "Restore the reviewed dataset bytes or re-pin the dataset through a governed review.",
        metadata: {
          datasetId: parsed.data.datasetId,
          version: parsed.data.version,
          expectedContentHash: parsed.data.contentHash,
          actualContentHash: recomputedContentHash
        }
      })
    };
  }

  return {
    status: "loaded",
    dataset: parsed.data,
    recomputedContentHash
  };
}

export function retrievalDatasetContentWithoutHash(
  dataset: RetrievalEvalDataset
): RetrievalEvalDatasetContent {
  const { contentHash: _contentHash, ...content } = dataset;
  return RetrievalEvalDatasetContentSchema.parse(content);
}

export function queryHashOrId(query: RetrievalEvalQuery): string {
  return query.queryHash ?? hashValue(query.query);
}

export function activeTombstones(
  dataset: Pick<RetrievalEvalDataset, "tombstonedChunkIds">
): ReadonlySet<string> {
  return new Set(dataset.tombstonedChunkIds);
}

export function countRelevantChunks(query: RetrievalEvalQuery): number {
  return query.relevant.filter((chunk) => chunk.grade > 0).length;
}

export function relevantChunksById(
  query: RetrievalEvalQuery
): ReadonlyMap<string, RetrievalRelevantChunk> {
  return new Map(
    query.relevant
      .filter((chunk) => chunk.grade > 0)
      .map((chunk) => [chunk.chunkId, chunk])
  );
}

export function safePositiveDenominator(value: number): number {
  return Math.max(1, value);
}

export function finiteMetric(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function assertNonNegativeInteger(value: number): number {
  return nonNegativeInteger.parse(value);
}

function refineDatasetIds(
  dataset: RetrievalEvalDatasetIdFields,
  context: z.RefinementCtx
): void {
  const queryIds = new Set<string>();
  for (const [index, query] of dataset.queries.entries()) {
    if (queryIds.has(query.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queries", index, "id"],
        message: `duplicate query id ${query.id}`
      });
    }
    queryIds.add(query.id);
  }

  const claimIds = new Set<string>();
  for (const [index, claim] of dataset.claims.entries()) {
    if (claimIds.has(claim.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims", index, "id"],
        message: `duplicate claim id ${claim.id}`
      });
    }
    claimIds.add(claim.id);
  }
}
