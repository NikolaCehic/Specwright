import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DenseRetrievalResultSchema,
  FusedCandidateSchema,
  LexicalRetrievalResultSchema,
  MemoryError,
  ReferenceDeterministicReranker,
  applyRerank,
  candidatesFromUpstream,
  fuseCandidates,
  hashString,
  normalizeCandidateScores,
  parseRankerCandidate,
  parseRetrievalResult,
  rankHybridCandidates,
  stableStringify
} from "../index";
import type {
  DenseRetrievalResult,
  LexicalRetrievalResult,
  Reranker,
  RerankerInput,
  RerankerResult,
  RetrievalQueryInput,
  RetrievalResult
} from "../index";

const fixtureRoot = join(import.meta.dir, "..", "..", "test", "fixtures", "ranking");

describe("hybrid ranking fusion", () => {
  test("RRF is deterministic and stamps redaction-safe provenance", async () => {
    const fixture = readRankingFixture("hybrid-candidates.json");
    const query = baseQuery(fixture.query, {
      k: 4,
      fusion: { method: "rrf", rrfK: 60 },
      diversify: { method: "none" }
    });
    const first = await rankHybridCandidates({
      query,
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const second = await rankHybridCandidates({
      query,
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const golden = readJsonFixture("golden-rrf-result.json");

    expect(stableStringify(second)).toBe(stableStringify(first));
    expect(JSON.parse(stableStringify(first))).toEqual(golden);
    expect(first.hits.map((hit) => hit.chunkId)).toEqual([
      "chunk-alpha",
      "chunk-beta",
      "chunk-delta",
      "chunk-gamma"
    ]);
    expect(first.provenance.fusion).toEqual({
      method: "rrf",
      weights: { bm25: 1, proximity: 1, dense: 1 },
      rrfK: 60
    });
    expect(first.provenance.candidateSetSizes).toEqual({
      bm25: 3,
      proximity: 3,
      dense: 4
    });
    expect(first.provenance.normalizationMode).toBe("rank_based");
    expect(first.provenance.redactionSafe).toBe(true);
    expect(JSON.stringify(first)).not.toContain(fixture.query);
    expect(JSON.stringify(first)).not.toContain("Float32Array");
    expect(first.hits[0]?.queryHash).toBe(first.queryHash);
    expect(first.hits[0]?.cacheStatus).toBe("miss");
  });

  test("RRF applies caller-supplied weights and rrf_weighted matches the same vector", async () => {
    const fixture = readRankingFixture("hybrid-candidates.json");
    const weightedRrfQuery = baseQuery(fixture.query, {
      k: 4,
      fusion: {
        method: "rrf",
        rrfK: 60,
        weights: { bm25: 0, proximity: 0, dense: 10 }
      },
      diversify: { method: "none" }
    });
    const explicitWeightedRrfQuery = baseQuery(fixture.query, {
      k: 4,
      fusion: {
        method: "rrf_weighted",
        rrfK: 60,
        weights: { bm25: 0, proximity: 0, dense: 10 }
      },
      diversify: { method: "none" }
    });
    const weightedRrf = await rankHybridCandidates({
      query: weightedRrfQuery,
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const explicitWeightedRrf = await rankHybridCandidates({
      query: explicitWeightedRrfQuery,
      lexical: fixture.lexical,
      dense: fixture.dense
    });

    expect(weightedRrf.hits.map((hit) => hit.chunkId)).toEqual([
      "chunk-beta",
      "chunk-epsilon",
      "chunk-alpha",
      "chunk-zeta"
    ]);
    expect(weightedRrf.provenance.fusion.weights).toEqual({
      bm25: 0,
      proximity: 0,
      dense: 10
    });
    expect(explicitWeightedRrf.hits.map((hit) => hit.chunkId)).toEqual(
      weightedRrf.hits.map((hit) => hit.chunkId)
    );
  });

  test("weighted fusion is deterministic with min-max and z-score normalization", async () => {
    const fixture = readRankingFixture("hybrid-candidates.json");
    const query = baseQuery(fixture.query, {
      k: 5,
      fusion: {
        method: "weighted",
        normalization: "min_max",
        weights: { bm25: 0.8, proximity: 0.5, dense: 1.1 }
      },
      diversify: { method: "none" }
    });
    const first = await rankHybridCandidates({
      query,
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const second = await rankHybridCandidates({
      query,
      lexical: fixture.lexical,
      dense: fixture.dense
    });

    expect(second).toEqual(first);
    expect(first.provenance.normalizationMode).toBe("min_max");
    expect(first.provenance.fusion.weights).toEqual({
      bm25: 0.8,
      proximity: 0.5,
      dense: 1.1
    });
    expect(first.hits.every((hit) => Number.isFinite(hit.fusedScore))).toBe(true);

    const candidates = candidatesFromUpstream({
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const zScoreNormalized = normalizeCandidateScores({
      candidates,
      retrievers: ["bm25", "proximity", "dense"],
      mode: "z_score"
    });
    const zScoreFusion = fuseCandidates({
      candidates: zScoreNormalized,
      retrievers: ["bm25", "proximity", "dense"],
      method: "weighted",
      weights: { bm25: 1, proximity: 1, dense: 1 },
      rrfK: 60
    });

    expect(zScoreFusion.hits.map((hit) => hit.chunkId)).toEqual(
      fuseCandidates({
        candidates: zScoreNormalized,
        retrievers: ["bm25", "proximity", "dense"],
        method: "weighted",
        weights: { bm25: 1, proximity: 1, dense: 1 },
        rrfK: 60
      }).hits.map((hit) => hit.chunkId)
    );

    const equalScoreCandidates = [
      rankerCandidate("equal-a", { bm25: 2 }, { bm25: 1 }),
      rankerCandidate("equal-b", { bm25: 2 }, { bm25: 2 })
    ];
    expect(
      normalizeCandidateScores({
        candidates: equalScoreCandidates,
        retrievers: ["bm25"],
        mode: "min_max"
      }).map((candidate) => candidate.normalized.bm25)
    ).toEqual([1, 1]);
    expect(
      normalizeCandidateScores({
        candidates: equalScoreCandidates,
        retrievers: ["bm25"],
        mode: "z_score"
      }).map((candidate) => candidate.normalized.bm25)
    ).toEqual([0, 0]);
  });

  test("rerank unavailable degrades to fusion-only without fabricated scores", async () => {
    const fixture = readRankingFixture("hybrid-candidates.json");
    const fusionOnly = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 3,
        fusion: { method: "rrf", rrfK: 60 },
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const degraded = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 3,
        fusion: { method: "rrf", rrfK: 60 },
        rerank: { enabled: true, model: "fixture-rerank", topN: 3 },
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical,
      dense: fixture.dense,
      reranker: new ThrowingReranker()
    });

    expect(degraded.hits.map((hit) => hit.chunkId)).toEqual(
      fusionOnly.hits.map((hit) => hit.chunkId)
    );
    expect(degraded.hits.every((hit) => hit.rerankScore === undefined)).toBe(true);
    expect(degraded.provenance.rerankSkipped).toBe(true);
    expect(degraded.provenance.degraded).toContain("rerank_skipped");
  });

  test("reference reranker only reorders inside the fused top-N pool", async () => {
    const fixture = readRankingFixture("hybrid-candidates.json");
    const fusionOnly = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 5,
        fusion: { method: "rrf", rrfK: 60 },
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const reranked = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 5,
        fusion: { method: "rrf", rrfK: 60 },
        rerank: { enabled: true, model: "specwright-reference-reranker", topN: 3 },
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical,
      dense: fixture.dense,
      reranker: new ReferenceDeterministicReranker()
    });

    expect(new Set(reranked.hits.slice(0, 3).map((hit) => hit.chunkId))).toEqual(
      new Set(fusionOnly.hits.slice(0, 3).map((hit) => hit.chunkId))
    );
    expect(reranked.hits.slice(3).map((hit) => hit.chunkId)).toEqual(
      fusionOnly.hits.slice(3).map((hit) => hit.chunkId)
    );
    expect(reranked.hits.slice(0, 3).every((hit) => hit.rerankScore !== undefined)).toBe(
      true
    );
    expect(reranked.hits.slice(3).every((hit) => hit.rerankScore === undefined)).toBe(
      true
    );
    expect(reranked.provenance.rerankModel).toBe("specwright-reference-reranker");
    expect(reranked.provenance.rerankModelVersion).toBe("1.0.0");

    const direct = await applyRerank({
      query: "reference direct rerank",
      hits: [
        fusedCandidate("ref-a", "external", 0.04, 1),
        fusedCandidate("ref-b", "repo", 0.03, 2),
        fusedCandidate("ref-c", "generated", 0.02, 3)
      ],
      topN: 2,
      reranker: new ReferenceDeterministicReranker()
    });
    expect(direct.hits.map((hit) => hit.chunkId)).toEqual([
      "ref-b",
      "ref-a",
      "ref-c"
    ]);
  });

  test("MMR down-ranks near duplicates at a fixed lambda", async () => {
    const fixture = readRankingFixture("near-duplicates.json");
    const withoutMmr = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 2,
        retrievers: ["bm25", "proximity"],
        fusion: { method: "rrf", rrfK: 60 },
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical
    });
    const withMmr = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 2,
        retrievers: ["bm25", "proximity"],
        fusion: { method: "rrf", rrfK: 60 },
        diversify: { method: "mmr", lambda: 0.7 }
      }),
      lexical: fixture.lexical
    });

    expect(withoutMmr.hits.map((hit) => hit.chunkId)).toEqual([
      "chunk-near-a1",
      "chunk-near-a2"
    ]);
    expect(withMmr.hits.map((hit) => hit.chunkId)).toEqual([
      "chunk-near-a1",
      "chunk-near-c"
    ]);
    expect(withMmr.provenance.mmrLambda).toBe(0.7);
    expect(withMmr.provenance.mmrSimilarityMetric).toBe(
      "metadata_source_similarity_v1"
    );
  });

  test("empty and low-confidence paths return explicit empty results", async () => {
    const empty = await rankHybridCandidates({
      query: baseQuery("runtime kernel retrieval", {
        k: 3,
        diversify: { method: "none" }
      })
    });
    expect(empty.hits).toEqual([]);
    expect(empty.provenance.emptyResult).toBe(true);
    expect(empty.provenance.degraded).toContain("empty_result");

    const fixture = readRankingFixture("low-confidence.json");
    const lowConfidence = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 2,
        retrievers: ["bm25"],
        fusion: { method: "rrf", rrfK: 60 },
        confidenceFloor: 0.02,
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical
    });

    expect(lowConfidence.hits).toEqual([]);
    expect(lowConfidence.provenance.emptyResult).toBe(true);
    expect(lowConfidence.provenance.degraded).toContain("low_confidence");
    expect(lowConfidence.provenance.candidateSetSizes.bm25).toBe(2);
  });

  test("schema-invalid retrieval output fails closed", async () => {
    const fixture = readRankingFixture("hybrid-candidates.json");
    const valid = await rankHybridCandidates({
      query: baseQuery(fixture.query, {
        k: 2,
        fusion: { method: "rrf", rrfK: 60 },
        diversify: { method: "none" }
      }),
      lexical: fixture.lexical,
      dense: fixture.dense
    });
    const malformed = {
      ...valid,
      hits: valid.hits.map((hit) => {
        const clone = { ...hit };
        delete (clone as Record<string, unknown>).sourceHash;
        return clone;
      })
    };

    expect(() => parseRetrievalResult(malformed)).toThrow(MemoryError);
    try {
      parseRetrievalResult(malformed);
      throw new Error("expected parseRetrievalResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryError);
      expect((error as MemoryError).code).toBe("output_invalid");
    }
  });
});

interface RankingFixture {
  readonly query: string;
  readonly lexical?: LexicalRetrievalResult;
  readonly dense?: DenseRetrievalResult;
}

function readRankingFixture(name: string): RankingFixture {
  const parsed = readJsonFixture(name) as {
    readonly query: string;
    readonly lexical?: unknown;
    readonly dense?: unknown;
  };

  return {
    query: parsed.query,
    ...(parsed.lexical === undefined
      ? {}
      : { lexical: LexicalRetrievalResultSchema.parse(parsed.lexical) }),
    ...(parsed.dense === undefined
      ? {}
      : { dense: DenseRetrievalResultSchema.parse(parsed.dense) })
  };
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
}

function baseQuery(
  query: string,
  overrides: Partial<RetrievalQueryInput> = {}
): RetrievalQueryInput {
  return {
    query,
    tenantId: "tenant-test",
    corpusIds: ["semantic.test"],
    k: 8,
    retrievers: ["bm25", "proximity", "dense"],
    fusion: {
      method: "rrf",
      rrfK: 60,
      weights: { bm25: 1, proximity: 1, dense: 1 },
      normalization: "rank_based"
    },
    rerank: { enabled: false, topN: 50 },
    diversify: {
      method: "mmr",
      lambda: 0.7,
      similarityMetric: "metadata_source_similarity_v1"
    },
    redactionProfileVersion: "ranking-test-redaction-v1",
    ...overrides
  };
}

function rankerCandidate(
  chunkId: string,
  scores: { readonly bm25?: number; readonly proximity?: number; readonly dense?: number },
  retrieverRanks: {
    readonly bm25?: number;
    readonly proximity?: number;
    readonly dense?: number;
  }
) {
  return parseRankerCandidate({
    chunkId,
    documentId: `doc-${chunkId}`,
    corpusId: "semantic.test",
    tenantId: "tenant-test",
    sourceRef: `docs/${chunkId}.md`,
    sourceHash: hashString(chunkId),
    authority: "repo",
    trustLabel: "repo",
    chunkingStrategyVersion: hashString("ranking-test-chunking"),
    scores,
    retrieverRanks,
    injectionFlag: false
  });
}

function fusedCandidate(
  chunkId: string,
  authority: "repo" | "external" | "generated",
  fusedScore: number,
  fusionRank: number
) {
  return FusedCandidateSchema.parse({
    ...rankerCandidate(chunkId, { bm25: fusedScore }, { bm25: fusionRank }),
    authority,
    trustLabel: authority,
    normalized: { bm25: fusedScore },
    fusedScore,
    fusionRank
  });
}

class ThrowingReranker implements Reranker {
  readonly model = "throwing-reranker";
  readonly modelVersion = "1.0.0";

  rerank(_input: RerankerInput): RerankerResult {
    throw new Error("rerank unavailable");
  }
}
