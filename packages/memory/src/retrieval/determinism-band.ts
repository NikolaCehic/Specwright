import { z } from "zod";
import type { DenseRetrievalResult } from "../dense-contracts";
import { MemoryError } from "../errors";
import type { Sha256Hash } from "../hash";
import type { DenseSearchCandidate, DenseVectorIndex } from "../vector";
import { searchExactReference } from "../vector";
import type { DenseVectorIndexStore } from "../vector";
import type { DenseRetriever, DenseRetrieverQuery } from "./dense";

export const DenseDeterminismBandSchema = z
  .object({
    metric: z.literal("top_k_jaccard"),
    threshold: z.number().finite().min(0).max(1),
    k: z.number().int().positive(),
    requireTop1Stable: z.boolean()
  })
  .strict();
export type DenseDeterminismBand = z.infer<typeof DenseDeterminismBandSchema>;

export const DEFAULT_DENSE_DETERMINISM_BAND = {
  metric: "top_k_jaccard",
  threshold: 1,
  k: 5,
  requireTop1Stable: true
} satisfies DenseDeterminismBand;

export const DenseDeterminismBandResultSchema = z
  .object({
    status: z.enum(["within_band", "recall_divergence"]),
    topKJaccard: z.number().finite().min(0).max(1),
    top1Stable: z.boolean(),
    threshold: z.number().finite().min(0).max(1),
    k: z.number().int().positive()
  })
  .strict();
export type DenseDeterminismBandResult = z.infer<
  typeof DenseDeterminismBandResultSchema
>;

export const DenseReplayCheckResultSchema = z
  .object({
    status: z.enum(["within_band", "recall_divergence", "version_unavailable"]),
    indexVersion: z.string().min(1),
    topKJaccard: z.number().finite().min(0).max(1).optional(),
    top1Stable: z.boolean().optional(),
    threshold: z.number().finite().min(0).max(1).optional(),
    k: z.number().int().positive().optional()
  })
  .strict();
export type DenseReplayCheckResult = z.infer<
  typeof DenseReplayCheckResultSchema
>;

export function compareDenseCandidatesToExact(input: {
  readonly annCandidates: readonly DenseSearchCandidate[];
  readonly exactCandidates: readonly DenseSearchCandidate[];
  readonly band?: DenseDeterminismBand;
}): DenseDeterminismBandResult {
  const band = DenseDeterminismBandSchema.parse(
    input.band ?? DEFAULT_DENSE_DETERMINISM_BAND
  );
  const annTop = input.annCandidates
    .slice(0, band.k)
    .map((candidate) => candidate.chunkId);
  const exactTop = input.exactCandidates
    .slice(0, band.k)
    .map((candidate) => candidate.chunkId);
  const topKJaccard = jaccard(annTop, exactTop);
  const top1Stable =
    annTop[0] !== undefined && exactTop[0] !== undefined
      ? annTop[0] === exactTop[0]
      : annTop[0] === exactTop[0];
  const status =
    topKJaccard >= band.threshold && (!band.requireTop1Stable || top1Stable)
      ? "within_band"
      : "recall_divergence";

  return DenseDeterminismBandResultSchema.parse({
    status,
    topKJaccard,
    top1Stable,
    threshold: band.threshold,
    k: band.k
  });
}

export function checkDenseIndexAgainstExact(input: {
  readonly index: DenseVectorIndex;
  readonly queryVector: Float32Array;
  readonly annCandidates: readonly DenseSearchCandidate[];
  readonly band?: DenseDeterminismBand;
}): DenseDeterminismBandResult {
  const band = DenseDeterminismBandSchema.parse(
    input.band ?? DEFAULT_DENSE_DETERMINISM_BAND
  );
  return compareDenseCandidatesToExact({
    annCandidates: input.annCandidates,
    exactCandidates: searchExactReference(input.index, input.queryVector, band.k),
    band
  });
}

export async function checkDenseReplay(input: {
  readonly retriever: DenseRetriever;
  readonly indexStore: DenseVectorIndexStore;
  readonly recordedResult: DenseRetrievalResult;
  readonly query: Omit<DenseRetrieverQuery, "indexVersion">;
  readonly band?: DenseDeterminismBand;
}): Promise<DenseReplayCheckResult> {
  const band = DenseDeterminismBandSchema.parse(
    input.band ?? DEFAULT_DENSE_DETERMINISM_BAND
  );
  const indexVersion = input.recordedResult.provenance.indexVersion as Sha256Hash;
  if (input.indexStore.get(indexVersion) === undefined) {
    return DenseReplayCheckResultSchema.parse({
      status: "version_unavailable",
      indexVersion
    });
  }

  const replayed = await input.retriever.retrieve({
    ...input.query,
    k: Math.max(Number(input.query.k ?? 0), band.k),
    maxCandidates: Math.max(Number(input.query.maxCandidates ?? 0), band.k),
    indexVersion
  });
  const index = input.indexStore.resolve(indexVersion);
  const queryVector = await input.retriever.embedQueryForIndex(
    index,
    input.query.text
  );
  const annCandidates = replayed.hits.map((hit) => ({
    chunkId: hit.chunkId,
    score: hit.denseScore
  }));
  const comparisonInput = {
    index,
    queryVector,
    annCandidates
  };
  const comparison = checkDenseIndexAgainstExact({
    ...comparisonInput,
    band
  });

  return DenseReplayCheckResultSchema.parse({
    status: comparison.status,
    indexVersion,
    topKJaccard: comparison.topKJaccard,
    top1Stable: comparison.top1Stable,
    threshold: comparison.threshold,
    k: comparison.k
  });
}

export function throwIfDenseReplayDiverged(result: DenseReplayCheckResult): void {
  if (result.status === "recall_divergence") {
    throw new MemoryError({
      code: "recall_divergence",
      field: "denseReplay",
      condition: result.indexVersion,
      message: `Dense replay diverged beyond determinism band for ${result.indexVersion}`
    });
  }
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) {
      intersection += 1;
    }
  }

  return intersection / union.size;
}
