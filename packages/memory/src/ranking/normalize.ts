import {
  NormalizedCandidateSchema,
  type NormalizationMode,
  type NormalizedCandidate,
  type RankerCandidate,
  type RetrieverName,
  type RetrieverScoreMap
} from "./contracts";

export interface NormalizeScoresInput {
  readonly candidates: readonly RankerCandidate[];
  readonly retrievers: readonly RetrieverName[];
  readonly mode: NormalizationMode;
}

export function normalizeCandidateScores(
  input: NormalizeScoresInput
): NormalizedCandidate[] {
  const ranks = rankCandidatesByRetriever(input.candidates, input.retrievers);
  const scoreStats = scoreStatsByRetriever(input.candidates, input.retrievers);

  return input.candidates
    .map((candidate) => {
      const normalized: Partial<Record<RetrieverName, number>> = {};
      for (const retriever of input.retrievers) {
        const score = candidate.scores[retriever];
        if (score === undefined) {
          continue;
        }

        if (input.mode === "rank_based") {
          const rank = ranks.get(retriever)?.get(candidate.chunkId);
          if (rank !== undefined) {
            normalized[retriever] = 1 / rank;
          }
          continue;
        }

        const stats = scoreStats.get(retriever);
        if (stats === undefined) {
          continue;
        }

        normalized[retriever] =
          input.mode === "min_max"
            ? normalizeMinMax(score, stats)
            : normalizeZScore(score, stats);
      }

      return NormalizedCandidateSchema.parse({
        ...candidate,
        retrieverRanks: Object.fromEntries(
          input.retrievers.flatMap((retriever) => {
            const rank = ranks.get(retriever)?.get(candidate.chunkId);
            return rank === undefined ? [] : [[retriever, rank]];
          })
        ),
        normalized: normalized as RetrieverScoreMap
      });
    })
    .sort(compareCandidatesByChunkId);
}

export function rankCandidatesByRetriever(
  candidates: readonly RankerCandidate[],
  retrievers: readonly RetrieverName[]
): ReadonlyMap<RetrieverName, ReadonlyMap<string, number>> {
  const ranks = new Map<RetrieverName, ReadonlyMap<string, number>>();

  for (const retriever of retrievers) {
    const scored = candidates.filter(
      (candidate) => candidate.scores[retriever] !== undefined
    );
    const ranked = scored
      .map((candidate) => ({
        candidate,
        existingRank: candidate.retrieverRanks[retriever],
        score: candidate.scores[retriever] ?? 0
      }))
      .sort((left, right) => {
        if (
          left.existingRank !== undefined &&
          right.existingRank !== undefined &&
          left.existingRank !== right.existingRank
        ) {
          return left.existingRank - right.existingRank;
        }

        return (
          right.score - left.score ||
          left.candidate.chunkId.localeCompare(right.candidate.chunkId)
        );
      });

    ranks.set(
      retriever,
      new Map(
        ranked.map((entry, index) => [
          entry.candidate.chunkId,
          entry.existingRank ?? index + 1
        ])
      )
    );
  }

  return ranks;
}

export function compareCandidatesByChunkId(
  left: Pick<RankerCandidate, "chunkId">,
  right: Pick<RankerCandidate, "chunkId">
): number {
  return left.chunkId.localeCompare(right.chunkId);
}

interface ScoreStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly standardDeviation: number;
}

function scoreStatsByRetriever(
  candidates: readonly RankerCandidate[],
  retrievers: readonly RetrieverName[]
): ReadonlyMap<RetrieverName, ScoreStats> {
  const stats = new Map<RetrieverName, ScoreStats>();

  for (const retriever of retrievers) {
    const scores = candidates
      .map((candidate) => candidate.scores[retriever])
      .filter((score): score is number => score !== undefined);
    if (scores.length === 0) {
      continue;
    }

    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const mean =
      scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
    const variance =
      scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) /
      Math.max(1, scores.length);

    stats.set(retriever, {
      min,
      max,
      mean,
      standardDeviation: Math.sqrt(variance)
    });
  }

  return stats;
}

function normalizeMinMax(score: number, stats: ScoreStats): number {
  if (stats.max === stats.min) {
    return 1;
  }

  return (score - stats.min) / (stats.max - stats.min);
}

function normalizeZScore(score: number, stats: ScoreStats): number {
  if (stats.standardDeviation === 0) {
    return 0;
  }

  return (score - stats.mean) / stats.standardDeviation;
}
