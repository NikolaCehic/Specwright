import type { CacheStatus } from "@specwright/schemas";
import type { DenseRetrievalResult } from "../dense-contracts";
import { MemoryError } from "../errors";
import { hashValue, stableStringify } from "../hash";
import type { Sha256Hash } from "../hash";
import type { LexicalRetrievalResult } from "../lexical";
import {
  MemoryProvenanceSchema,
  RankedHitSchema,
  parseRankerCandidate,
  type CandidateSetSizes,
  type MemoryProvenance,
  type RankedHit,
  type RankerCandidate,
  type RerankDegradation,
  type RerankedCandidate,
  type RetrievalQuery,
  type RetrieverName,
  type RetrieverWeightMap
} from "./contracts";

export interface UpstreamRetrievalResults {
  readonly lexical?: LexicalRetrievalResult;
  readonly dense?: DenseRetrievalResult;
}

export interface BuildProvenanceInput extends UpstreamRetrievalResults {
  readonly query: RetrievalQuery;
  readonly queryHash: Sha256Hash;
  readonly actualWeights: RetrieverWeightMap;
  readonly candidateSetSizes: CandidateSetSizes;
  readonly cacheStatus: CacheStatus;
  readonly degraded: readonly RerankDegradation[];
  readonly rerankSkipped: boolean;
  readonly emptyResult: boolean;
  readonly rerankModel?: string;
  readonly rerankModelVersion?: string;
  readonly rerankTopN?: number;
}

export function candidatesFromUpstream(
  input: UpstreamRetrievalResults
): RankerCandidate[] {
  return mergeCandidates([
    ...candidatesFromLexical(input.lexical),
    ...candidatesFromDense(input.dense)
  ]);
}

export function candidateSetSizesFromUpstream(
  input: UpstreamRetrievalResults,
  retrievers: readonly RetrieverName[]
): CandidateSetSizes {
  const sizes: Partial<Record<RetrieverName, number>> = {};
  for (const retriever of retrievers) {
    sizes[retriever] = 0;
  }

  if (input.lexical !== undefined) {
    sizes.bm25 = input.lexical.provenance.candidateSetSizes.bm25;
    sizes.proximity = input.lexical.provenance.candidateSetSizes.proximity;
  }

  if (input.dense !== undefined) {
    sizes.dense = input.dense.provenance.candidateSetSize;
  }

  return sizes as CandidateSetSizes;
}

export function resolveCacheStatus(input: UpstreamRetrievalResults): CacheStatus {
  const statuses = [
    input.lexical?.provenance.cacheStatus,
    input.dense?.provenance.cacheStatus
  ].filter((status): status is CacheStatus => status !== undefined);

  if (statuses.includes("bypass")) {
    return "bypass";
  }

  if (statuses.length === 0 || statuses.includes("miss")) {
    return "miss";
  }

  return "hit";
}

export function resolveQueryHash(
  query: RetrievalQuery,
  input: UpstreamRetrievalResults
): Sha256Hash {
  const queryHash = hashValue(normalizeQueryText(query.query));
  const upstreamHashes = [
    input.lexical?.queryHash,
    input.dense?.queryHash
  ].filter((hash): hash is Sha256Hash => hash !== undefined);

  for (const upstreamHash of upstreamHashes) {
    if (upstreamHash !== queryHash) {
      throw new MemoryError({
        code: "output_invalid",
        field: "queryHash",
        condition: upstreamHash,
        message: `Upstream query hash ${upstreamHash} does not match ranker query hash ${queryHash}`
      });
    }
  }

  return queryHash;
}

export function buildMemoryProvenance(
  input: BuildProvenanceInput,
  candidates: readonly RankerCandidate[]
): MemoryProvenance {
  const dense = input.dense?.provenance;
  const indexStamp = hybridIndexStamp(input);
  const chunkingVersions = uniqueStrings([
    input.lexical?.provenance.chunkingStrategyVersion,
    dense?.chunkingStrategyVersion,
    ...candidates.map((candidate) => candidate.chunkingStrategyVersion)
  ]);
  const chunkingStrategyVersion =
    chunkingVersions.length === 1
      ? chunkingVersions[0]
      : hashValue({ chunkingStrategyVersions: chunkingVersions });
  const fusion = {
    method: input.query.fusion.method,
    weights: input.actualWeights,
    ...(input.query.fusion.method === "weighted"
      ? {}
      : { rrfK: input.query.fusion.rrfK })
  };

  return MemoryProvenanceSchema.parse({
    corpusIds: resolveCorpusIds(input.query, input, candidates),
    indexId: indexStamp.indexId,
    indexVersion: indexStamp.indexVersion,
    embeddingProvider: dense?.embeddingProvider ?? "not_applicable",
    embeddingModel: dense?.embeddingModel ?? "not_applicable",
    embeddingModelVersion: dense?.embeddingModelVersion ?? "not_applicable",
    embeddingDims: dense?.embeddingDims ?? 0,
    distanceMetric: dense?.distanceMetric ?? "not_applicable",
    chunkingStrategy: "hybrid",
    chunkingStrategyVersion,
    retrievers: input.query.retrievers,
    candidateSetSizes: input.candidateSetSizes,
    normalizationMode: input.query.fusion.normalization,
    fusion,
    ...(input.rerankModel === undefined ? {} : { rerankModel: input.rerankModel }),
    ...(input.rerankModelVersion === undefined
      ? {}
      : { rerankModelVersion: input.rerankModelVersion }),
    ...(input.rerankTopN === undefined ? {} : { rerankTopN: input.rerankTopN }),
    rerankSkipped: input.rerankSkipped,
    degraded: input.degraded,
    mmrLambda: input.query.diversify.lambda,
    mmrSimilarityMetric:
      input.query.diversify.method === "none"
        ? "disabled"
        : input.query.diversify.similarityMetric,
    annParams: dense?.annParams ?? { kind: "not_applicable" },
    redactionProfileVersion: input.query.redactionProfileVersion,
    cacheStatus: input.cacheStatus,
    queryHash: input.queryHash,
    emptyResult: input.emptyResult,
    redactionSafe: true
  });
}

export function buildRankedHits(input: {
  readonly candidates: readonly RerankedCandidate[];
  readonly candidateSetSizes: CandidateSetSizes;
  readonly cacheStatus: CacheStatus;
  readonly queryHash: Sha256Hash;
}): RankedHit[] {
  return input.candidates.map((candidate, index) =>
    RankedHitSchema.parse({
      chunkId: candidate.chunkId,
      documentId: candidate.documentId,
      sourceRef: candidate.sourceRef,
      sourceHash: candidate.sourceHash,
      authority: candidate.authority,
      trustLabel: candidate.trustLabel,
      scores: candidate.scores,
      normalized: candidate.normalized,
      fusedScore: candidate.fusedScore,
      ...(candidate.rerankScore === undefined
        ? {}
        : { rerankScore: candidate.rerankScore }),
      rank: index + 1,
      injectionFlag: candidate.injectionFlag,
      candidateSetSizes: input.candidateSetSizes,
      cacheStatus: input.cacheStatus,
      queryHash: input.queryHash
    })
  );
}

export function normalizeQueryText(query: string): string {
  return query.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function candidatesFromLexical(
  result: LexicalRetrievalResult | undefined
): RankerCandidate[] {
  if (result === undefined) {
    return [];
  }

  return result.hits.map((hit) =>
    parseRankerCandidate({
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      corpusId: hit.corpusId,
      tenantId: hit.tenantId,
      sourceRef: hit.sourceRef,
      sourceHash: hit.sourceHash,
      authority: hit.authority,
      trustLabel: hit.trustLabel,
      chunkingStrategyVersion: hit.chunkingStrategyVersion,
      scores: hit.scores,
      retrieverRanks: hit.retrieverRanks,
      injectionFlag: hit.injectionFlag
    })
  );
}

function candidatesFromDense(
  result: DenseRetrievalResult | undefined
): RankerCandidate[] {
  if (result === undefined) {
    return [];
  }

  return result.hits.map((hit) =>
    parseRankerCandidate({
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      corpusId: hit.corpusId,
      tenantId: hit.tenantId,
      sourceRef: hit.sourceRef,
      sourceHash: hit.sourceHash,
      authority: hit.authority,
      trustLabel: hit.trustLabel,
      chunkingStrategyVersion: hit.chunkingStrategyVersion,
      scores: { dense: hit.denseScore },
      retrieverRanks: { dense: hit.rank },
      injectionFlag: hit.injectionFlag
    })
  );
}

function mergeCandidates(candidates: readonly RankerCandidate[]): RankerCandidate[] {
  const byChunkId = new Map<string, RankerCandidate>();

  for (const candidate of candidates) {
    const existing = byChunkId.get(candidate.chunkId);
    if (existing === undefined) {
      byChunkId.set(candidate.chunkId, candidate);
      continue;
    }

    assertSameCandidateIdentity(existing, candidate);
    byChunkId.set(
      candidate.chunkId,
      parseRankerCandidate({
        ...existing,
        scores: { ...existing.scores, ...candidate.scores },
        retrieverRanks: {
          ...existing.retrieverRanks,
          ...candidate.retrieverRanks
        },
        injectionFlag: existing.injectionFlag || candidate.injectionFlag
      })
    );
  }

  return [...byChunkId.values()].sort((left, right) =>
    left.chunkId.localeCompare(right.chunkId)
  );
}

function assertSameCandidateIdentity(
  left: RankerCandidate,
  right: RankerCandidate
): void {
  const fields = [
    "documentId",
    "corpusId",
    "tenantId",
    "sourceHash",
    "authority",
    "trustLabel",
    "chunkingStrategyVersion"
  ] as const;

  for (const field of fields) {
    if (left[field] !== right[field]) {
      throw new MemoryError({
        code: "output_invalid",
        field,
        condition: right[field],
        message: `Candidate ${left.chunkId} has inconsistent ${field} across retrievers`
      });
    }
  }

  if (stableStringify(left.sourceRef) !== stableStringify(right.sourceRef)) {
    throw new MemoryError({
      code: "output_invalid",
      field: "sourceRef",
      condition: stableStringify(right.sourceRef),
      message: `Candidate ${left.chunkId} has inconsistent sourceRef across retrievers`
    });
  }
}

function hybridIndexStamp(input: UpstreamRetrievalResults): {
  readonly indexId: string;
  readonly indexVersion: Sha256Hash;
} {
  const lexical = input.lexical?.provenance;
  const dense = input.dense?.provenance;
  const components = {
    lexical:
      lexical === undefined
        ? null
        : {
            indexId: lexical.indexId,
            indexVersion: lexical.indexVersion,
            indexFormatVersion: lexical.indexFormatVersion
          },
    dense:
      dense === undefined
        ? null
        : {
            indexId: dense.indexId,
            indexVersion: dense.indexVersion,
            indexFormatVersion: dense.indexFormatVersion
          }
  };
  const indexNames = [lexical?.indexId, dense?.indexId].filter(
    (indexId): indexId is string => indexId !== undefined
  );

  return {
    indexId: `hybrid:${indexNames.length === 0 ? "none" : indexNames.join("+")}`,
    indexVersion: hashValue(components)
  };
}

function resolveCorpusIds(
  query: RetrievalQuery,
  input: UpstreamRetrievalResults,
  candidates: readonly RankerCandidate[]
): string[] {
  return uniqueStrings([
    ...(query.corpusIds ?? []),
    ...(input.lexical?.provenance.corpusIds ?? []),
    ...(input.dense?.provenance.corpusIds ?? []),
    ...candidates.map((candidate) => candidate.corpusId)
  ]);
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))].sort();
}
