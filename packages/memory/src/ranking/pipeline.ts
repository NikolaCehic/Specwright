import { MemoryError } from "../errors";
import { fuseCandidates } from "./fusion";
import { selectMmr } from "./mmr";
import { normalizeCandidateScores } from "./normalize";
import {
  parseRankerCandidate,
  parseRetrievalQuery,
  parseRetrievalResult,
  RerankedCandidateSchema,
  type NormalizationMode,
  type RankerCandidate,
  type RerankDegradation,
  type RerankedCandidate,
  type RetrievalQuery,
  type RetrievalQueryInput,
  type RetrievalResult,
  type RetrieverName
} from "./contracts";
import type { Sha256Hash } from "../hash";
import {
  applyRerank,
  type ApplyRerankOutput,
  type Reranker
} from "./rerank";
import {
  buildMemoryProvenance,
  buildRankedHits,
  candidateSetSizesFromUpstream,
  candidatesFromUpstream,
  resolveCacheStatus,
  resolveQueryHash,
  type UpstreamRetrievalResults
} from "./provenance";
import { relevanceScore } from "./mmr";

export interface RankHybridCandidatesInput extends UpstreamRetrievalResults {
  readonly query: RetrievalQueryInput;
  readonly reranker?: Reranker;
}

export async function rankHybridCandidates(
  input: RankHybridCandidatesInput
): Promise<RetrievalResult> {
  const parsedQuery = parseRetrievalQuery(input.query);
  const query = withEffectiveFusionNormalization(parsedQuery);
  const upstream: UpstreamRetrievalResults = {
    ...(input.lexical === undefined ? {} : { lexical: input.lexical }),
    ...(input.dense === undefined ? {} : { dense: input.dense })
  };
  const queryHash = resolveQueryHash(query, upstream);
  const allCandidates = filterCandidatesToRetrievers(
    candidatesFromUpstream(upstream),
    query.retrievers
  );
  const candidateSetSizes = candidateSetSizesFromUpstream(upstream, query.retrievers);
  const cacheStatus = resolveCacheStatus(upstream);
  const normalized = normalizeCandidateScores({
    candidates: allCandidates,
    retrievers: query.retrievers,
    mode: query.fusion.normalization
  });
  const fusion = fuseCandidates({
    candidates: normalized,
    retrievers: query.retrievers,
    method: query.fusion.method,
    weights: query.fusion.weights,
    rrfK: query.fusion.rrfK
  });

  if (fusion.hits.length === 0) {
    return buildResult({
      query,
      upstream,
      queryHash,
      candidates: allCandidates,
      finalCandidates: [],
      candidateSetSizes,
      cacheStatus,
      actualWeights: fusion.weights,
      degraded: ["empty_result"],
      rerankSkipped: false,
      emptyResult: true
    });
  }

  const rerank = await maybeRerank({
    query,
    hits: fusion.hits,
    ...(input.reranker === undefined ? {} : { reranker: input.reranker })
  });
  const degraded: RerankDegradation[] = rerank.skipped ? ["rerank_skipped"] : [];

  if (belowConfidenceFloor(rerank.hits, query.confidenceFloor)) {
    return buildResult({
      query,
      upstream,
      queryHash,
      candidates: allCandidates,
      finalCandidates: [],
      candidateSetSizes,
      cacheStatus,
      actualWeights: fusion.weights,
      degraded: dedupeDegraded([...degraded, "low_confidence"]),
      rerankSkipped: rerank.skipped,
      emptyResult: true,
      ...rerankMetadataFields(rerank),
      rerankTopN: query.rerank.enabled ? Math.min(query.rerank.topN, fusion.hits.length) : 0
    });
  }

  const diversified =
    query.diversify.method === "none"
      ? rerank.hits.slice(0, query.k)
      : selectMmr({
          candidates: rerank.hits,
          k: query.k,
          lambda: query.diversify.lambda
        });

  return buildResult({
    query,
    upstream,
    queryHash,
    candidates: allCandidates,
    finalCandidates: diversified,
    candidateSetSizes,
    cacheStatus,
    actualWeights: fusion.weights,
    degraded,
    rerankSkipped: rerank.skipped,
    emptyResult: false,
    ...rerankMetadataFields(rerank),
    rerankTopN: query.rerank.enabled ? Math.min(query.rerank.topN, fusion.hits.length) : 0
  });
}

function withEffectiveFusionNormalization(query: RetrievalQuery): RetrievalQuery {
  const normalization: NormalizationMode =
    query.fusion.method === "weighted"
      ? query.fusion.normalization === "rank_based"
        ? "min_max"
        : query.fusion.normalization
      : "rank_based";

  return {
    ...query,
    fusion: {
      ...query.fusion,
      normalization
    }
  };
}

function filterCandidatesToRetrievers(
  candidates: readonly RankerCandidate[],
  retrievers: readonly RetrieverName[]
): RankerCandidate[] {
  return candidates.flatMap((candidate) => {
    const scores: Partial<Record<RetrieverName, number>> = {};
    const retrieverRanks: Partial<Record<RetrieverName, number>> = {};
    for (const retriever of retrievers) {
      const score = candidate.scores[retriever];
      if (score !== undefined) {
        scores[retriever] = score;
      }

      const rank = candidate.retrieverRanks[retriever];
      if (rank !== undefined) {
        retrieverRanks[retriever] = rank;
      }
    }

    if (Object.keys(scores).length === 0) {
      return [];
    }

    return [
      parseRankerCandidate({
        ...candidate,
        scores,
        retrieverRanks
      })
    ];
  });
}

async function maybeRerank(input: {
  readonly query: RetrievalQuery;
  readonly hits: Parameters<typeof applyRerank>[0]["hits"];
  readonly reranker?: Reranker;
}): Promise<ApplyRerankOutput> {
  if (!input.query.rerank.enabled) {
    return {
      hits: input.hits.map((hit) => RerankedCandidateSchema.parse(hit)),
      skipped: false
    };
  }

  return applyRerank({
    query: input.query.query,
    hits: input.hits,
    topN: Math.min(input.query.rerank.topN, input.hits.length),
    ...(input.reranker === undefined ? {} : { reranker: input.reranker })
  });
}

function rerankMetadataFields(rerank: ApplyRerankOutput): {
  readonly rerankModel?: string;
  readonly rerankModelVersion?: string;
} {
  return {
    ...(rerank.model === undefined ? {} : { rerankModel: rerank.model }),
    ...(rerank.modelVersion === undefined
      ? {}
      : { rerankModelVersion: rerank.modelVersion })
  };
}

function belowConfidenceFloor(
  candidates: readonly RerankedCandidate[],
  confidenceFloor: number | undefined
): boolean {
  if (confidenceFloor === undefined) {
    return false;
  }

  return candidates.every((candidate) => relevanceScore(candidate) < confidenceFloor);
}

function buildResult(input: {
  readonly query: RetrievalQuery;
  readonly upstream: UpstreamRetrievalResults;
  readonly queryHash: Sha256Hash;
  readonly candidates: readonly RankerCandidate[];
  readonly finalCandidates: readonly RerankedCandidate[];
  readonly candidateSetSizes: ReturnType<typeof candidateSetSizesFromUpstream>;
  readonly cacheStatus: ReturnType<typeof resolveCacheStatus>;
  readonly actualWeights: ReturnType<typeof fuseCandidates>["weights"];
  readonly degraded: readonly RerankDegradation[];
  readonly rerankSkipped: boolean;
  readonly emptyResult: boolean;
  readonly rerankModel?: string;
  readonly rerankModelVersion?: string;
  readonly rerankTopN?: number;
}): RetrievalResult {
  try {
    const provenance = buildMemoryProvenance(
      {
        ...input.upstream,
        query: input.query,
        queryHash: input.queryHash,
        actualWeights: input.actualWeights,
        candidateSetSizes: input.candidateSetSizes,
        cacheStatus: input.cacheStatus,
        degraded: dedupeDegraded(input.degraded),
        rerankSkipped: input.rerankSkipped,
        emptyResult: input.emptyResult,
        ...(input.rerankModel === undefined ? {} : { rerankModel: input.rerankModel }),
        ...(input.rerankModelVersion === undefined
          ? {}
          : { rerankModelVersion: input.rerankModelVersion }),
        ...(input.rerankTopN === undefined ? {} : { rerankTopN: input.rerankTopN })
      },
      input.candidates
    );
    const hits = buildRankedHits({
      candidates: input.finalCandidates,
      candidateSetSizes: input.candidateSetSizes,
      cacheStatus: input.cacheStatus,
      queryHash: input.queryHash
    });

    return parseRetrievalResult({
      queryHash: input.queryHash,
      hits,
      provenance
    });
  } catch (error) {
    if (error instanceof MemoryError && error.code === "output_invalid") {
      throw error;
    }

    throw new MemoryError({
      code: "output_invalid",
      field: "retrievalResult",
      condition: "schema",
      message: error instanceof Error ? error.message : "invalid retrieval output"
    });
  }
}

function dedupeDegraded(
  degraded: readonly RerankDegradation[]
): RerankDegradation[] {
  return [...new Set(degraded)].sort();
}
