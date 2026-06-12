import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODE_ANALYZER_CONFIG,
  InMemoryChunkStore,
  LexicalRetriever,
  MemoryError,
  PROSE_ANALYZER_CONFIG,
  buildLexicalIndex,
  buildLexicalIndexFromStore,
  chunkDocument,
  createLexicalAnalyzer,
  hashString,
  hashValue,
  retrieveLexical,
  scoreBM25,
  scoreProximity
} from "../index";
import type { Chunk, MemoryDocument } from "../index";

const lexicalFixtureRoot = join(import.meta.dir, "..", "..", "test", "fixtures", "lexical");
const fixedConfig = {
  chunkSize: 80,
  overlap: 0
};

describe("lexical analyzers", () => {
  test("prose analyzer is deterministic and code analyzer preserves identifiers", () => {
    const prose = createLexicalAnalyzer(PROSE_ANALYZER_CONFIG);
    const code = createLexicalAnalyzer(CODE_ANALYZER_CONFIG);

    expect(prose.analyze("The Café services were running").map((token) => token.term)).toEqual([
      "cafe",
      "service",
      "run"
    ]);
    expect(prose.analyze("The Café services were running")).toEqual(
      prose.analyze("The Café services were running")
    );
    expect(code.analyze("runtimeKernel_42 strictMode").map((token) => token.term)).toEqual([
      "runtimeKernel_42",
      "strictMode"
    ]);
  });
});

describe("lexical BM25 index", () => {
  test("builds deterministic term statistics and matches hand-computed BM25", () => {
    const chunks = chunksForDocuments([
      memoryDocument("alpha-beta", "alpha beta beta"),
      memoryDocument("alpha-gamma", "alpha gamma")
    ]);
    const first = buildLexicalIndex({ chunks });
    const second = buildLexicalIndex({ chunks: [...chunks].reverse() });

    expect(second.indexVersion).toBe(first.indexVersion);
    expect([...second.termStats.keys()]).toEqual([...first.termStats.keys()]);

    const betaChunk = chunks.find((chunk) => chunk.text === "alpha beta beta");
    const gammaChunk = chunks.find((chunk) => chunk.text === "alpha gamma");
    expect(betaChunk).toBeDefined();
    expect(gammaChunk).toBeDefined();

    const betaScore = scoreBM25(first, ["alpha", "beta"], betaChunk!.chunkId);
    const gammaScore = scoreBM25(first, ["alpha", "beta"], gammaChunk!.chunkId);

    expect(betaScore).toBeCloseTo(1.070854, 5);
    expect(gammaScore).toBeCloseTo(0.198568, 5);
    expect(betaScore).toBeGreaterThan(gammaScore);

    const higherK1 = buildLexicalIndex({
      chunks,
      bm25: {
        k1: 2,
        b: 0.75
      }
    });
    expect(scoreBM25(higherK1, ["beta"], betaChunk!.chunkId)).toBeGreaterThan(
      scoreBM25(first, ["beta"], betaChunk!.chunkId)
    );
  });

  test("builds from the chunk store and rejects untraceable source hashes", () => {
    const document = memoryDocument("traceable", "strict runtime kernel");
    const store = new InMemoryChunkStore();
    const result = store.ingestDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    const index = buildLexicalIndexFromStore({
      store,
      chunkIds: result.chunks.map((chunk) => chunk.chunkId)
    });

    expect(index.chunkCount).toBe(result.chunks.length);

    const corrupt = {
      ...result.chunks[0],
      sourceRef: {
        path: "fixtures/corrupt.txt",
        contentHash: hashString("different source"),
        authority: "repo",
        redactionClass: "operator"
      }
    };

    expect(() => buildLexicalIndex({ chunks: [corrupt] })).toThrow(MemoryError);
  });

  test("index version changes when analyzer, BM25 config, or corpus snapshot changes", () => {
    const chunks = chunksForDocuments([
      memoryDocument("version-a", "strict runtime kernel"),
      memoryDocument("version-b", "strict runtime planner")
    ]);
    const base = buildLexicalIndex({ chunks });
    const codeAnalyzer = buildLexicalIndex({
      chunks,
      analyzer: CODE_ANALYZER_CONFIG
    });
    const changedBm25 = buildLexicalIndex({
      chunks,
      bm25: {
        k1: 1.6,
        b: 0.75
      }
    });
    const changedCorpus = buildLexicalIndex({
      chunks: [
        ...chunks,
        ...chunksForDocuments([
          memoryDocument("version-c", "new retrieval evidence enters the corpus")
        ])
      ]
    });

    expect(codeAnalyzer.indexVersion).not.toBe(base.indexVersion);
    expect(changedBm25.indexVersion).not.toBe(base.indexVersion);
    expect(changedCorpus.indexVersion).not.toBe(base.indexVersion);
  });
});

describe("lexical proximity and retrieval", () => {
  test("proximity boosts adjacent in-order query terms without changing BM25 math", () => {
    const adjacent = memoryDocument("adjacent", "strict runtime kernel prevents drift", {
      id: "doc-adjacent"
    });
    const scattered = memoryDocument(
      "scattered",
      "strict guardrail text appears before runtime and later kernel",
      {
        id: "doc-scattered"
      }
    );
    const chunks = chunksForDocuments([adjacent, scattered]);
    const index = buildLexicalIndex({ chunks });
    const adjacentChunk = chunks.find((chunk) => chunk.documentId === "doc-adjacent");
    const scatteredChunk = chunks.find((chunk) => chunk.documentId === "doc-scattered");
    expect(adjacentChunk).toBeDefined();
    expect(scatteredChunk).toBeDefined();

    const queryTerms = ["strict", "runtime", "kernel"];
    const adjacentProximity = scoreProximity(index, queryTerms, adjacentChunk!.chunkId);
    const scatteredProximity = scoreProximity(index, queryTerms, scatteredChunk!.chunkId);

    expect(adjacentProximity).toBeGreaterThan(scatteredProximity);
    expect(scoreBM25(index, queryTerms, adjacentChunk!.chunkId)).toBeGreaterThan(0);
    expect(scoreBM25(index, queryTerms, scatteredChunk!.chunkId)).toBeGreaterThan(0);
  });

  test("returns standalone lexical results with per-retriever provenance and no raw query text", () => {
    const fixture = JSON.parse(
      readFileSync(join(lexicalFixtureRoot, "tiny-corpus.json"), "utf8")
    ) as { documents: { id: string; content: string }[]; query: string };
    const chunks = chunksForDocuments(
      fixture.documents.map((document) =>
        memoryDocument(document.id, document.content, {
          id: document.id,
          metadata: {
            tags: ["lexical-fixture"]
          }
        })
      )
    );
    const index = buildLexicalIndex({ chunks });
    const first = retrieveLexical(index, {
      text: fixture.query,
      k: 3,
      maxCandidates: 10,
      filters: {
        documentIds: fixture.documents.map((document) => document.id)
      }
    });
    const second = new LexicalRetriever(index).retrieve({
      text: fixture.query,
      k: 3,
      maxCandidates: 10,
      filters: {
        documentIds: fixture.documents.map((document) => document.id)
      }
    });

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.queryHash).toBe(hashValue("strict runtime kernel"));
    expect(first.provenance.candidateSetSizes.bm25).toBeGreaterThan(0);
    expect(first.provenance.candidateSetSizes.proximity).toBeGreaterThan(0);
    expect(first.provenance.indexVersion).toBe(index.indexVersion);
    expect(first.provenance.analyzer).toEqual(PROSE_ANALYZER_CONFIG);
    expect(first.provenance.bm25).toEqual({ k1: 1.2, b: 0.75 });
    expect(first.provenance.redactionSafe).toBe(true);
    expect(first.hits[0]?.scores.bm25).toBeGreaterThan(0);
    expect(first.hits.some((hit) => hit.scores.proximity !== undefined)).toBe(true);
    expect(JSON.stringify(first.provenance)).not.toContain(fixture.query);
    expect(JSON.stringify(first.hits)).not.toContain("strict runtime kernel");

    const capped = retrieveLexical(index, {
      text: fixture.query,
      k: 10,
      maxCandidates: 1
    });
    expect(capped.provenance.candidateSetSizes).toEqual({
      bm25: 1,
      proximity: 1
    });
  });

  test("returns explicit empty results and fails closed on version mismatch", () => {
    const chunks = chunksForDocuments([
      memoryDocument("empty-result", "strict runtime kernel")
    ]);
    const index = buildLexicalIndex({ chunks });
    const empty = retrieveLexical(index, {
      text: "unmatched rare phrase",
      k: 5,
      maxCandidates: 10
    });

    expect(empty.hits).toEqual([]);
    expect(empty.provenance.candidateSetSizes).toEqual({
      bm25: 0,
      proximity: 0
    });

    expect(() =>
      retrieveLexical(index, {
        text: "strict runtime",
        expectedIndexVersion: hashString("wrong-version")
      })
    ).toThrow(MemoryError);
    expect(() =>
      retrieveLexical(index, {
        text: "strict runtime",
        expectedAnalyzer: {
          id: "specwright-code",
          version: "1.0.0"
        }
      })
    ).toThrow(MemoryError);
    expect(() =>
      retrieveLexical(index, {
        text: "strict runtime",
        expectedBm25: {
          k1: 2,
          b: 0.75
        }
      })
    ).toThrow(MemoryError);
    expect(() => retrieveLexical(index, { text: "" })).toThrow(MemoryError);
  });
});

function chunksForDocuments(documents: readonly MemoryDocument[]): Chunk[] {
  return documents.flatMap((document) =>
    chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    })
  );
}

function memoryDocument(
  name: string,
  content: string,
  overrides: Partial<MemoryDocument> = {}
): MemoryDocument {
  const id = overrides.id ?? `doc-${name.replace(/[^a-z0-9]+/giu, "-")}`;
  return {
    id,
    corpusId: overrides.corpusId ?? "corpus-semantic",
    tenantId: overrides.tenantId ?? "tenant-alpha",
    class: overrides.class ?? "semantic",
    sourceRef:
      overrides.sourceRef ?? {
        path: `fixtures/${name}`,
        contentHash: hashString(content),
        authority: "repo",
        redactionClass: "operator"
      },
    sourceHash: hashString(content),
    authority: overrides.authority ?? "repo",
    trustLabel: overrides.trustLabel ?? "repo",
    content,
    ingestTimestamp:
      overrides.ingestTimestamp ?? "2026-06-13T00:00:00.000Z",
    metadata: overrides.metadata ?? {
      fixture: name
    }
  };
}
