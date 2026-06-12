import {
  FusedCandidateSchema,
  type FusedCandidate,
  type FusionMethod,
  type NormalizedCandidate,
  type RetrieverName,
  type RetrieverWeightMap
} from "./contracts";

export interface FuseCandidatesInput {
  readonly candidates: readonly NormalizedCandidate[];
  readonly retrievers: readonly RetrieverName[];
  readonly method: FusionMethod;
  readonly weights?: RetrieverWeightMap;
  readonly rrfK: number;
}

export interface FusionOutput {
  readonly hits: readonly FusedCandidate[];
  readonly weights: RetrieverWeightMap;
}

export function fuseCandidates(input: FuseCandidatesInput): FusionOutput {
  const weights = actualWeights(input.retrievers, input.weights);
  const hits = input.candidates
    .map((candidate) => {
      const fusedScore =
        input.method === "weighted"
          ? weightedLinearScore(candidate, input.retrievers, weights)
          : reciprocalRankFusionScore(
              candidate,
              input.retrievers,
              weights,
              input.rrfK
            );

      return {
        candidate,
        fusedScore
      };
    })
    .sort((left, right) => compareFusedEntries(left, right))
    .map((entry, index) =>
      FusedCandidateSchema.parse({
        ...entry.candidate,
        fusedScore: entry.fusedScore,
        fusionRank: index + 1
      })
    );

  return { hits, weights };
}

export function compareFusedCandidates(
  left: Pick<FusedCandidate, "fusedScore" | "chunkId">,
  right: Pick<FusedCandidate, "fusedScore" | "chunkId">
): number {
  return right.fusedScore - left.fusedScore || left.chunkId.localeCompare(right.chunkId);
}

function reciprocalRankFusionScore(
  candidate: NormalizedCandidate,
  retrievers: readonly RetrieverName[],
  weights: RetrieverWeightMap,
  rrfK: number
): number {
  let score = 0;

  for (const retriever of retrievers) {
    const rank = candidate.retrieverRanks[retriever];
    if (rank === undefined) {
      continue;
    }

    const weight = weights[retriever] ?? 1;
    score += weight * (1 / (rrfK + rank));
  }

  return score;
}

function weightedLinearScore(
  candidate: NormalizedCandidate,
  retrievers: readonly RetrieverName[],
  weights: RetrieverWeightMap
): number {
  let score = 0;

  for (const retriever of retrievers) {
    const normalized = candidate.normalized[retriever];
    if (normalized === undefined) {
      continue;
    }

    score += (weights[retriever] ?? 1) * normalized;
  }

  return score;
}

function actualWeights(
  retrievers: readonly RetrieverName[],
  weights: RetrieverWeightMap | undefined
): RetrieverWeightMap {
  const actual: Partial<Record<RetrieverName, number>> = {};
  for (const retriever of retrievers) {
    actual[retriever] = weights?.[retriever] ?? 1;
  }

  return actual as RetrieverWeightMap;
}

function compareFusedEntries(
  left: { readonly candidate: NormalizedCandidate; readonly fusedScore: number },
  right: { readonly candidate: NormalizedCandidate; readonly fusedScore: number }
): number {
  return (
    right.fusedScore - left.fusedScore ||
    left.candidate.chunkId.localeCompare(right.candidate.chunkId)
  );
}
