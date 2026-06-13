import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EvalVerdictSchema } from "@specwright/schemas";
import {
  DATASET_CONTENT_HASH_MISMATCH_CODE,
  DATASET_PINNED_VERSION_MISSING_CODE,
  FAITHFULNESS_MISMATCH_CODE,
  GROUNDEDNESS_CLAIM_UNTRACED_CODE,
  GROUNDEDNESS_LOW_TRUST_SOURCE_CODE,
  GROUNDEDNESS_SELF_RETRIEVAL_CODE,
  MEMORY_RETRIEVAL_EVAL_DEFINITIONS,
  RETRIEVAL_NDCG_BELOW_THRESHOLD_CODE,
  RETRIEVAL_RECALL_BELOW_THRESHOLD_CODE,
  RETRIEVAL_TOMBSTONED_HIT_RETURNED_CODE,
  RETRIEVAL_EVAL_DATASET_SCHEMA_VERSION,
  RetrievalEvalDatasetSchema,
  computeRetrievalEvalDatasetContentHash,
  gradeGroundedness,
  gradeRetrievalQuality,
  loadRetrievalEvalDataset,
  ndcgAtK,
  parseRetrievalResult,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreRetrievalMetrics,
  stableStringify
} from "../index";
import type {
  RankedHit,
  RetrievalEvalDataset,
  RetrievalEvalDatasetContent,
  RetrievalGroundedClaim,
  RetrievalResult
} from "../index";

const fixtureRoot = join(import.meta.dir, "..", "..", "evals");
const rankingFixtureRoot = join(
  import.meta.dir,
  "..",
  "..",
  "test",
  "fixtures",
  "ranking"
);

const INDEX_VERSION =
  "sha256:dac7e43860e0e2e0f7c2d80557c8396a3f55903e8b6ecccae93c066cb2f86bdf";
const CHUNKING_STRATEGY_VERSION =
  "sha256:1dbe9d255c30e315f075f60a38a87f03f4fd9f31dfd6e04c58d7a124765b78d4";
const ALPHA_HASH =
  "sha256:7e84c4e04817c9f55ebb2845f2fce3f49695f3c2dfd5ae3985fb64ddaff03781";
const BETA_HASH =
  "sha256:81a118f1d478f286959d4d9f69e47fdf0503d33097b8b0e887fb0a5a2ee06ae8";
const DELTA_HASH =
  "sha256:43942a8a9285e2eb9473034c26523046fb660714693d26c52b4e7937ea76e531";
const EPSILON_HASH =
  "sha256:cb85de833619513afe133ffb8d02c3b700d9942914d9e0a8aa37040c0516e768";
const ZETA_HASH =
  "sha256:2c8c91dfd74bec1b885c3e263a087cedee3a2f7c87c7568c2f2d21804fed0a5d";

describe("memory retrieval eval metrics", () => {
  test("computes recall, precision, MRR, and graded nDCG on known hits", () => {
    const dataset = datasetWithHash(baseDatasetContent());
    const query = dataset.queries[0];
    const hits = goldenResult().hits;

    expect(query).toBeDefined();
    expect(recallAtK(query, hits, 3)).toBeCloseTo(2 / 3, 12);
    expect(precisionAtK(query, hits, 3)).toBeCloseTo(2 / 3, 12);
    expect(reciprocalRank(query, hits, 3)).toEqual({ score: 1, rank: 1 });

    const expectedNdcg =
      (3 / Math.log2(2) + 2 / Math.log2(3)) /
      (3 / Math.log2(2) + 2 / Math.log2(3) + 1 / Math.log2(4));
    expect(ndcgAtK(query, hits, 3)).toBeCloseTo(expectedNdcg, 12);

    const scores = scoreRetrievalMetrics({
      queries: dataset.queries,
      hitsByQueryId: new Map([["runtime-hybrid", hits]]),
      recallK: 3,
      precisionK: 3,
      mrrK: 3,
      ndcgK: 3
    });
    expect(scores.recallAtK).toBeCloseTo(2 / 3, 12);
    expect(scores.precisionAtK).toBeCloseTo(2 / 3, 12);
    expect(scores.mrr).toBe(1);
    expect(scores.ndcgAtK).toBeCloseTo(expectedNdcg, 12);
  });

  test("handles no-hit, all-hit, and k-larger-than-set edge cases", () => {
    const query = datasetWithHash(baseDatasetContent()).queries[0];
    expect(query).toBeDefined();

    expect(recallAtK(query, [], 10)).toBe(0);
    expect(precisionAtK(query, [], 10)).toBe(0);
    expect(reciprocalRank(query, [], 10)).toEqual({ score: 0 });
    expect(ndcgAtK(query, [], 10)).toBe(0);

    const allRelevantHits = [
      hit("chunk-alpha", ALPHA_HASH, 1),
      hit("chunk-beta", BETA_HASH, 2),
      hit("chunk-epsilon", EPSILON_HASH, 3)
    ];
    expect(recallAtK(query, allRelevantHits, 10)).toBe(1);
    expect(precisionAtK(query, allRelevantHits, 10)).toBeCloseTo(0.3, 12);
    expect(ndcgAtK(query, allRelevantHits, 10)).toBe(1);
  });
});

describe("memory retrieval-quality grader", () => {
  test("matches the golden expected verdict fixture byte-for-byte", () => {
    const dataset = readJson<RetrievalEvalDataset>(
      join(fixtureRoot, "datasets", "semantic-hybrid-quality-v1.json")
    );
    const expected = readJson(
      join(
        fixtureRoot,
        "fixtures",
        "retrieval-quality-pass",
        "expected-verdict.json"
      )
    );
    const loaded = loadRetrievalEvalDataset(dataset);

    expect(loaded.status).toBe("loaded");
    const verdict = gradeRetrievalQuality({
      dataset,
      resultsByQueryId: resultsByQuery(),
      availableIndexVersions: [dataset.pinned.indexVersion]
    });
    expect(EvalVerdictSchema.parse(verdict)).toEqual(verdict);
    expect(JSON.parse(stableStringify(verdict))).toEqual(expected);
    expect(stableStringify(gradeRetrievalQuality({
      dataset,
      resultsByQueryId: resultsByQuery(),
      availableIndexVersions: [dataset.pinned.indexVersion]
    }))).toBe(stableStringify(verdict));
  });

  test("fails closed on silent dataset edits", () => {
    const dataset = datasetWithHash(baseDatasetContent());
    const edited = clone(dataset);
    edited.queries[0]?.relevant.push({
      chunkId: "chunk-zeta",
      sourceRef: "docs/generated.md#zeta",
      sourceHash: ZETA_HASH,
      grade: 2
    });

    const verdict = gradeRetrievalQuality({
      dataset: edited,
      resultsByQueryId: resultsByQuery()
    });
    expect(findingCodes(verdict)).toContain(DATASET_CONTENT_HASH_MISMATCH_CODE);
    expect(verdict.status).toBe("fail");
  });

  test("gates index promotion on metric thresholds and passes once thresholds are met", () => {
    const passingDataset = datasetWithHash(baseDatasetContent());
    const failingDataset = datasetWithHash(
      baseDatasetContent({
        thresholds: {
          ...baseDatasetContent().thresholds,
          recallAtK: { k: 3, minimum: 1 }
        }
      })
    );

    const failing = gradeRetrievalQuality({
      dataset: failingDataset,
      resultsByQueryId: resultsByQuery(),
      availableIndexVersions: [INDEX_VERSION]
    });
    expect(failing.status).toBe("fail");
    expect(findingCodes(failing)).toEqual(
      expect.arrayContaining([RETRIEVAL_RECALL_BELOW_THRESHOLD_CODE])
    );

    const passing = gradeRetrievalQuality({
      dataset: passingDataset,
      resultsByQueryId: resultsByQuery(),
      availableIndexVersions: [INDEX_VERSION]
    });
    expect(passing.status).toBe("pass");
    expect(findingCodes(passing)).not.toContain(
      RETRIEVAL_NDCG_BELOW_THRESHOLD_CODE
    );
  });

  test("fails replay when pinned versions are missing or tombstoned hits return", () => {
    const dataset = datasetWithHash(baseDatasetContent());
    const missingVersion = gradeRetrievalQuality({
      dataset,
      resultsByQueryId: resultsByQuery(),
      availableIndexVersions: []
    });
    expect(missingVersion.status).toBe("fail");
    expect(findingCodes(missingVersion)).toContain(
      DATASET_PINNED_VERSION_MISSING_CODE
    );

    const tombstoned = datasetWithHash(
      baseDatasetContent({ tombstonedChunkIds: ["chunk-alpha"] })
    );
    const tombstonedVerdict = gradeRetrievalQuality({
      dataset: tombstoned,
      resultsByQueryId: resultsByQuery(),
      availableIndexVersions: [INDEX_VERSION]
    });
    expect(tombstonedVerdict.status).toBe("fail");
    expect(findingCodes(tombstonedVerdict)).toContain(
      RETRIEVAL_TOMBSTONED_HIT_RETURNED_CODE
    );
  });
});

describe("memory groundedness grader", () => {
  test("passes traced repo support and fails untraced, low-trust, self, and hash-mismatch claims", () => {
    const passing = gradeGroundedness({
      dataset: datasetWithHash(baseDatasetContent()),
      resultsByQueryId: resultsByQuery()
    });
    expect(passing.status).toBe("pass");

    const failing = gradeGroundedness({
      dataset: datasetWithHash(
        baseDatasetContent({
          claims: [
            claim({
              id: "claim-untraced",
              support: [
                {
                  chunkId: "chunk-missing",
                  sourceRef: "docs/missing.md#missing",
                  sourceHash: ZETA_HASH
                }
              ]
            }),
            claim({
              id: "claim-low-trust",
              support: [
                {
                  chunkId: "chunk-delta",
                  sourceRef: "docs/retrieval.md#delta",
                  sourceHash: DELTA_HASH
                }
              ]
            }),
            claim({
              id: "claim-self",
              owningArtifactId: "artifact-self",
              selfArtifactId: "artifact-self"
            }),
            claim({
              id: "claim-faithfulness",
              support: [
                {
                  chunkId: "chunk-alpha",
                  sourceRef: "docs/runtime.md#alpha",
                  sourceHash: ALPHA_HASH,
                  modelVisibleSourceHash: BETA_HASH
                }
              ],
              independentEvidenceRefs: ["evidence:repo:runtime-alpha"]
            })
          ]
        })
      ),
      resultsByQueryId: resultsByQuery()
    });
    expect(failing.status).toBe("fail");
    expect(findingCodes(failing)).toEqual(
      expect.arrayContaining([
        GROUNDEDNESS_CLAIM_UNTRACED_CODE,
        GROUNDEDNESS_LOW_TRUST_SOURCE_CODE,
        GROUNDEDNESS_SELF_RETRIEVAL_CODE,
        FAITHFULNESS_MISMATCH_CODE
      ])
    );
  });

  test("exports schema-valid blocking eval definitions without touching eval-runner core", () => {
    expect(MEMORY_RETRIEVAL_EVAL_DEFINITIONS).toHaveLength(2);
    expect(MEMORY_RETRIEVAL_EVAL_DEFINITIONS.map((definition) => definition.id)).toEqual([
      "memory.semantic.retrieval_quality.v1",
      "memory.semantic.groundedness.v1"
    ]);
  });
});

function baseDatasetContent(
  overrides: Partial<RetrievalEvalDatasetContent> = {}
): RetrievalEvalDatasetContent {
  const content: RetrievalEvalDatasetContent = {
    schemaVersion: RETRIEVAL_EVAL_DATASET_SCHEMA_VERSION,
    datasetId: "memory.semantic.hybrid_retrieval_quality.v1",
    version: "1.0.0",
    evalId: "memory.semantic.retrieval_quality.v1",
    corpusClass: "semantic",
    pinned: {
      indexVersion: INDEX_VERSION,
      embeddingModelVersion: "1.0.0",
      chunkingStrategyVersion: CHUNKING_STRATEGY_VERSION
    },
    thresholds: {
      recallAtK: { k: 3, minimum: 0.66 },
      precisionAtK: { k: 3, minimum: 0.66 },
      mrr: { k: 3, minimum: 1 },
      ndcgAtK: { k: 3, minimum: 0.89 }
    },
    queries: [
      {
        id: "runtime-hybrid",
        query: "How does the runtime combine lexical, dense, and proximity retrieval?",
        queryHash:
          "sha256:f55c6084c94d223ab15b72c4d08d2ff2a180d20adc9bcf68a7886294b1988f7b",
        relevant: [
          {
            chunkId: "chunk-alpha",
            sourceRef: "docs/runtime.md#alpha",
            sourceHash: ALPHA_HASH,
            grade: 3
          },
          {
            chunkId: "chunk-beta",
            sourceRef: "docs/runtime.md#beta",
            sourceHash: BETA_HASH,
            grade: 2
          },
          {
            chunkId: "chunk-epsilon",
            sourceRef: "docs/memory.md#epsilon",
            sourceHash: EPSILON_HASH,
            grade: 1
          }
        ]
      }
    ],
    claims: [
      claim({
        id: "claim-runtime-grounded",
        independentEvidenceRefs: ["evidence:repo:runtime-alpha"]
      })
    ],
    tombstonedChunkIds: []
  };

  return {
    ...content,
    ...overrides
  };
}

function datasetWithHash(
  content: RetrievalEvalDatasetContent
): RetrievalEvalDataset {
  return RetrievalEvalDatasetSchema.parse({
    ...content,
    contentHash: computeRetrievalEvalDatasetContentHash(content)
  });
}

function resultsByQuery(): ReadonlyMap<string, RetrievalResult> {
  return new Map([["runtime-hybrid", goldenResult()]]);
}

function goldenResult(): RetrievalResult {
  return parseRetrievalResult(
    readJson(join(rankingFixtureRoot, "golden-rrf-result.json"))
  );
}

function hit(chunkId: string, sourceHash: string, rank: number): RankedHit {
  const base = goldenResult().hits[0];
  if (base === undefined) {
    throw new Error("golden result must contain hits");
  }

  return {
    ...base,
    chunkId,
    sourceHash,
    sourceRef:
      chunkId === "chunk-beta"
        ? "docs/runtime.md#beta"
        : chunkId === "chunk-epsilon"
          ? "docs/memory.md#epsilon"
          : "docs/runtime.md#alpha",
    rank
  };
}

function claim(
  overrides: Partial<RetrievalGroundedClaim> = {}
): RetrievalGroundedClaim {
  return {
    id: "claim-runtime-grounded",
    claim: "The runtime combines deterministic hybrid retrieval signals before promotion.",
    claimLevel: "source_fact",
    authority: "repo",
    owningArtifactId: "artifact-runtime-summary",
    support: [
      {
        chunkId: "chunk-alpha",
        sourceRef: "docs/runtime.md#alpha",
        sourceHash: ALPHA_HASH
      }
    ],
    independentEvidenceRefs: [],
    ...overrides
  };
}

function findingCodes(verdict: { findings: readonly { code?: string }[] }): string[] {
  return verdict.findings
    .map((finding) => finding.code)
    .filter((code): code is string => code !== undefined)
    .sort();
}

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
