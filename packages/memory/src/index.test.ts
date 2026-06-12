import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./lexical/lexical.test";
import {
  ChunkSchema,
  InMemoryChunkStore,
  MemoryError,
  SemanticChunkingStrategy,
  StructuralChunkingStrategy,
  chunkDocument,
  diffChunks,
  hashString,
  ingestDocument
} from "./index";
import type { Chunk, MemoryDocument } from "./index";

const fixtureRoot = join(import.meta.dir, "..", "fixtures");

const fixedConfig = {
  chunkSize: 12,
  overlap: 3
};

const structuralConfig = {
  parserVersion: "1.0.0",
  granularity: "block" as const
};

const semanticConfig = {
  boundaryModelId: "specwright-topic-shift",
  boundaryModelVersion: "1.0.0",
  threshold: 0.76,
  minChunkSize: 110,
  maxChunkSize: 230
};

describe("memory chunking", () => {
  test("fixed overlap chunking is deterministic and stamps full metadata", () => {
    const document = memoryDocument("uniform-prose.txt", readFixture("uniform-prose.txt"));
    const first = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    const second = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    for (const chunk of first) {
      expect(chunk.documentId).toBe(document.id);
      expect(chunk.corpusId).toBe(document.corpusId);
      expect(chunk.tenantId).toBe(document.tenantId);
      expect(chunk.sourceRef).toEqual(document.sourceRef);
      expect(chunk.sourceHash).toBe(document.sourceHash);
      expect(chunk.contentHash).toBe(hashString(chunk.text));
      expect(chunk.trustLabel).toBe("repo");
      expect(chunk.authority).toBe("repo");
      expect(chunk.chunkingStrategy.id).toBe("fixed-overlap");
      expect(chunk.chunkingStrategy.version).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(chunk.retrievalRole).toBe("advisory_data");
      expect(chunk.tokenSpan?.end).toBeGreaterThan(chunk.tokenSpan?.start ?? -1);
    }
  });

  test("structural chunking preserves section metadata and is deterministic", () => {
    const document = memoryDocument(
      "structured-markdown.md",
      readFixture("structured-markdown.md")
    );
    const first = chunkDocument({
      document,
      strategyId: "structural",
      config: structuralConfig
    });
    const second = chunkDocument({
      document,
      strategyId: "structural",
      config: structuralConfig
    });

    expect(second).toEqual(first);
    expect(first.some((chunk) => chunk.text.includes("neverExecuteMemory"))).toBe(
      true
    );
    expect(
      first.some((chunk) =>
        Array.isArray(chunk.metadata?.sectionPath)
          ? chunk.metadata.sectionPath.includes("Retrieval Boundary")
          : false
      )
    ).toBe(true);
  });

  test("semantic chunking is deterministic, pinned, and treats injected text as data", () => {
    const document = memoryDocument(
      "mixed-topic-narrative.txt",
      readFixture("mixed-topic-narrative.txt"),
      {
        authority: "external",
        trustLabel: "external",
        sourceRef: {
          uri: "https://example.test/mixed-topic",
          contentHash: hashString(readFixture("mixed-topic-narrative.txt")),
          authority: "external",
          redactionClass: "operator",
          externalTrustPolicy: "test-fixture-policy"
        }
      }
    );
    const first = chunkDocument({
      document,
      strategyId: "semantic",
      config: semanticConfig
    });
    const second = chunkDocument({
      document,
      strategyId: "semantic",
      config: semanticConfig
    });

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(first.map((chunk) => chunk.text).join("\n")).toContain(
      "SYSTEM OVERRIDE"
    );
    expect(first.every((chunk) => chunk.retrievalRole === "advisory_data")).toBe(
      true
    );
  });

  test("strategy versions are derived from pinned config", () => {
    const document = memoryDocument("uniform-prose.txt", readFixture("uniform-prose.txt"));
    const base = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    })[0];
    const changed = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: { ...fixedConfig, overlap: 1 }
    })[0];

    expect(base?.chunkingStrategy.version).not.toBe(
      changed?.chunkingStrategy.version
    );
    expect(
      StructuralChunkingStrategy.version({
        ...structuralConfig,
        parserVersion: "1.0.1"
      })
    ).not.toBe(StructuralChunkingStrategy.version(structuralConfig));
    expect(
      SemanticChunkingStrategy.version({
        ...semanticConfig,
        threshold: 0.52
      })
    ).not.toBe(SemanticChunkingStrategy.version(semanticConfig));
  });
});

describe("memory contracts and fail-closed behavior", () => {
  test("rejects missing required document and chunk metadata", () => {
    const document = memoryDocument("uniform-prose.txt", readFixture("uniform-prose.txt"));
    expect(() => chunkDocument({ document: { ...document, sourceHash: undefined }, strategyId: "fixed-overlap", config: fixedConfig })).toThrow(MemoryError);

    const [chunk] = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    expect(chunk).toBeDefined();
    const invalidChunk = { ...chunk };
    delete (invalidChunk as Record<string, unknown>).documentId;
    expect(() => ChunkSchema.parse(invalidChunk)).toThrow();
  });

  test("rejects malformed source refs, unknown strategies, unpinned semantic config, and invalid overlap", () => {
    const document = memoryDocument("uniform-prose.txt", readFixture("uniform-prose.txt"));
    expect(() =>
      chunkDocument({
        document: {
          ...document,
          sourceRef: {
            authority: "external",
            redactionClass: "operator"
          }
        },
        strategyId: "fixed-overlap",
        config: fixedConfig
      })
    ).toThrow(MemoryError);

    expect(() =>
      chunkDocument({
        document,
        strategyId: "unknown",
        config: fixedConfig
      })
    ).toThrow(MemoryError);

    expect(() =>
      chunkDocument({
        document,
        strategyId: "semantic",
        config: {
          threshold: 0.7,
          minChunkSize: 80,
          maxChunkSize: 160
        }
      })
    ).toThrow(MemoryError);

    expect(() =>
      chunkDocument({
        document,
        strategyId: "fixed-overlap",
        config: {
          chunkSize: 4,
          overlap: 4
        }
      })
    ).toThrow(MemoryError);
  });
});

describe("content-addressed chunk store", () => {
  test("is idempotent and de-duplicates identical chunk content", () => {
    const content = readFixture("uniform-prose.txt");
    const firstDocument = memoryDocument("uniform-a.txt", content);
    const secondDocument = memoryDocument("uniform-b.txt", content, {
      id: "doc-uniform-b",
      sourceRef: {
        path: "fixtures/uniform-b.txt",
        contentHash: hashString(content),
        authority: "repo",
        redactionClass: "operator"
      }
    });
    const store = new InMemoryChunkStore();

    const first = store.ingestDocument({
      document: firstDocument,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    const contentEntryCount = store.contentEntryCount();
    store.ingestDocument({
      document: firstDocument,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    expect(store.contentEntryCount()).toBe(contentEntryCount);
    expect(store.listByDocument(firstDocument.id)).toEqual(first.chunks);

    store.ingestDocument({
      document: secondDocument,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    expect(store.contentEntryCount()).toBe(contentEntryCount);
    expect(store.chunkCount()).toBe(first.chunks.length * 2);
  });

  test("writes are all-or-nothing on invalid chunks and hash collisions", () => {
    const document = memoryDocument("uniform-prose.txt", readFixture("uniform-prose.txt"));
    const chunks = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    const [firstChunk] = chunks;
    expect(firstChunk).toBeDefined();

    const store = new InMemoryChunkStore();
    const invalidChunk = { ...firstChunk };
    delete (invalidChunk as Record<string, unknown>).documentId;

    expect(() => store.put([firstChunk, invalidChunk])).toThrow(MemoryError);
    expect(store.chunkCount()).toBe(0);
    expect(store.contentEntryCount()).toBe(0);

    store.put([firstChunk]);
    const internals = store as unknown as {
      contentByHash: Map<string, { contentHash: string; text: string }>;
    };
    internals.contentByHash.set(firstChunk.contentHash, {
      contentHash: firstChunk.contentHash,
      text: `${firstChunk.text} collision`
    });

    expect(() => store.put([firstChunk])).toThrow(MemoryError);
    expect(store.chunkCount()).toBe(1);
  });
});

describe("chunk diff", () => {
  test("detects precise content changes without marking unchanged spans", () => {
    const content = readFixture("uniform-prose.txt");
    const document = memoryDocument("uniform-prose.txt", content);
    const nextContent = content.replace("retrieved sentence", "retrieved language");
    const nextDocument = memoryDocument("uniform-prose.txt", nextContent);

    expect(nextDocument.sourceHash).not.toBe(document.sourceHash);

    const previousChunks = chunkDocument({
      document,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    const nextChunks = chunkDocument({
      document: nextDocument,
      strategyId: "fixed-overlap",
      config: fixedConfig
    });
    const diff = diffChunks(previousChunks, nextChunks);

    expect(diff.changed.length).toBeGreaterThan(0);
    expect(diff.unchanged.length).toBeGreaterThan(0);
    expect(diff.changed.every((entry) => entry.previous?.text !== entry.next?.text)).toBe(
      true
    );
  });

  test("top-level ingestDocument can write through a supplied store", () => {
    const document = memoryDocument(
      "structured-markdown.md",
      readFixture("structured-markdown.md")
    );
    const store = new InMemoryChunkStore();
    const result = ingestDocument({
      document,
      strategyId: "structural",
      config: structuralConfig,
      store
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(store.listByDocument(document.id)).toEqual(result.chunks);
  });
});

function readFixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), "utf8");
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
      overrides.ingestTimestamp ?? "2026-06-12T00:00:00.000Z",
    metadata: overrides.metadata ?? {
      fixture: name
    }
  };
}
