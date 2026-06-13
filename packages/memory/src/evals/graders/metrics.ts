import type { RankedHit } from "../../ranking";
import {
  countRelevantChunks,
  finiteMetric,
  relevantChunksById,
  safePositiveDenominator,
  type RetrievalEvalQuery
} from "./dataset";

export interface QueryMetricDetails {
  readonly queryId: string;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly relevantCount: number;
  readonly matchedCount: number;
  readonly firstRelevantRank?: number;
}

export interface RetrievalMetricScores {
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly details: readonly QueryMetricDetails[];
}

export interface ScoreRetrievalMetricsInput {
  readonly queries: readonly RetrievalEvalQuery[];
  readonly hitsByQueryId: ReadonlyMap<string, readonly RankedHit[]>;
  readonly recallK: number;
  readonly precisionK: number;
  readonly mrrK: number;
  readonly ndcgK: number;
}

export function scoreRetrievalMetrics(
  input: ScoreRetrievalMetricsInput
): RetrievalMetricScores {
  const details = input.queries.map((query) => {
    const hits = sortedHits(input.hitsByQueryId.get(query.id) ?? []);
    const recall = recallAtK(query, hits, input.recallK);
    const precision = precisionAtK(query, hits, input.precisionK);
    const mrrValue = reciprocalRank(query, hits, input.mrrK);
    const ndcg = ndcgAtK(query, hits, input.ndcgK);
    const matched = matchedRelevantIds(query, hits.slice(0, input.recallK));

    return {
      queryId: query.id,
      recallAtK: recall,
      precisionAtK: precision,
      mrr: mrrValue.score,
      ndcgAtK: ndcg,
      relevantCount: countRelevantChunks(query),
      matchedCount: matched.size,
      ...(mrrValue.rank === undefined ? {} : { firstRelevantRank: mrrValue.rank })
    };
  });

  return {
    recallAtK: average(details.map((detail) => detail.recallAtK)),
    precisionAtK: average(details.map((detail) => detail.precisionAtK)),
    mrr: average(details.map((detail) => detail.mrr)),
    ndcgAtK: average(details.map((detail) => detail.ndcgAtK)),
    details
  };
}

export function recallAtK(
  query: RetrievalEvalQuery,
  hits: readonly RankedHit[],
  k: number
): number {
  const relevantCount = countRelevantChunks(query);
  if (relevantCount === 0) {
    return 0;
  }

  return matchedRelevantIds(query, sortedHits(hits).slice(0, k)).size / relevantCount;
}

export function precisionAtK(
  query: RetrievalEvalQuery,
  hits: readonly RankedHit[],
  k: number
): number {
  if (k <= 0) {
    return 0;
  }

  return matchedRelevantIds(query, sortedHits(hits).slice(0, k)).size / k;
}

export function reciprocalRank(
  query: RetrievalEvalQuery,
  hits: readonly RankedHit[],
  k: number
): {
  readonly score: number;
  readonly rank?: number;
} {
  const relevant = relevantChunksById(query);
  for (const hit of sortedHits(hits).slice(0, k)) {
    const expected = relevant.get(hit.chunkId);
    if (expected !== undefined && expected.sourceHash === hit.sourceHash) {
      return {
        score: finiteMetric(1 / safePositiveDenominator(hit.rank)),
        rank: hit.rank
      };
    }
  }

  return { score: 0 };
}

export function ndcgAtK(
  query: RetrievalEvalQuery,
  hits: readonly RankedHit[],
  k: number
): number {
  const relevant = relevantChunksById(query);
  const gains = sortedHits(hits)
    .slice(0, k)
    .map((hit) => {
      const expected = relevant.get(hit.chunkId);
      return expected !== undefined && expected.sourceHash === hit.sourceHash
        ? expected.grade
        : 0;
    });
  const idealGains = [...relevant.values()]
    .map((chunk) => chunk.grade)
    .sort((left, right) => right - left)
    .slice(0, k);
  const ideal = discountedCumulativeGain(idealGains);

  if (ideal === 0) {
    return 0;
  }

  return discountedCumulativeGain(gains) / ideal;
}

export function sortedHits(hits: readonly RankedHit[]): RankedHit[] {
  return [...hits].sort(
    (left, right) => left.rank - right.rank || left.chunkId.localeCompare(right.chunkId)
  );
}

export function matchedRelevantIds(
  query: RetrievalEvalQuery,
  hits: readonly RankedHit[]
): ReadonlySet<string> {
  const relevant = relevantChunksById(query);
  const matched = new Set<string>();

  for (const hit of hits) {
    const expected = relevant.get(hit.chunkId);
    if (expected !== undefined && expected.sourceHash === hit.sourceHash) {
      matched.add(hit.chunkId);
    }
  }

  return matched;
}

function discountedCumulativeGain(gains: readonly number[]): number {
  return gains.reduce(
    (sum, gain, index) => sum + gain / Math.log2(index + 2),
    0
  );
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
