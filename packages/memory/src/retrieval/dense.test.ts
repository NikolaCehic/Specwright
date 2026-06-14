import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_HNSW_ANN_PARAMS,
  DenseRetriever,
  DenseVectorIndexStore,
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry,
  MemoryError,
  buildAndSwapDenseIndex,
  buildDenseVectorIndex,
  checkDenseReplay,
  chunkDocument,
  compareDenseCandidatesToExact,
  hashString,
  hashValue,
  parseDenseRetrievalResult,
  searchDenseVectorIndex,
  searchExactReference,
  verifyDenseVectorIndexIntegrity
} from "../../test/internal";
import type {
  Chunk,
  DenseRetrievalResult,
  EmbeddingProvider,
  MemoryDocument
} from "../../test/internal";

const denseFixtureRoot = join(import.meta.dir, "..", "..", "test", "fixtures", "dense");
const fixedConfig = {
  chunkSize: 80,
  overlap: 0
};
const annParams = {
  ...DEFAULT_HNSW_ANN_PARAMS,
  m: 4,
  efConstruction: 24,
  efSearch: 24,
  maxLevel: 3
};

describe("dense embedding provider", () => {
  test("deterministic local provider is reproducible and registry fails closed on stale versions", async () => {
    const provider = new DeterministicLocalEmbeddingProvider({ dims: 16 });
    const first = await provider.embedQuery("runtime kernel");
    const second = await provider.embedQuery("runtime kernel");

    expect(Array.from(second)).toEqual(Array.from(first));
    expect(first.length).toBe(16);

    const registry = new EmbeddingProviderRegistry();
    registry.register(provider);
    expect(registry.resolve(provider.descriptor).descriptor).toEqual(provider.descriptor);
    registry.deprecate(provider.descriptor);
    expect(() => registry.resolve(provider.descriptor)).toThrow(MemoryError);
  });
});

describe("dense vector index and retriever", () => {
  test("returns scored dense candidates with versioned provenance and no raw vectors", async () => {
    const fixture = readDenseFixture();
    const chunks = chunksForFixture(fixture);
    const provider = new DeterministicLocalEmbeddingProvider({ dims: 16 });
    const registry = registryWith(provider);
    const store = new DenseVectorIndexStore();
    const build = await buildAndSwapDenseIndex({
      store,
      chunks,
      provider,
      annParams
    });
    const retriever = new DenseRetriever({
      indexStore: store,
      providerRegistry: registry
    });
    const first = await retriever.retrieve({
      text: fixture.query,
      k: 3,
      maxCandidates: 5,
      filters: {
        documentIds: fixture.documents.map((document) => document.id)
      }
    });
    const second = await retriever.retrieve({
      text: fixture.query,
      k: 3,
      maxCandidates: 5,
      filters: {
        documentIds: fixture.documents.map((document) => document.id)
      }
    });

    expect(second).toEqual(first);
    expect(first.queryHash).toBe(hashValue(fixture.query));
    expect(first.provenance.indexId).toBe(build.index.indexId);
    expect(first.provenance.indexVersion).toBe(build.index.indexVersion);
    expect(first.provenance.embeddingProvider).toBe(provider.descriptor.provider);
    expect(first.provenance.embeddingModel).toBe(provider.descriptor.model);
    expect(first.provenance.embeddingModelVersion).toBe(provider.descriptor.modelVersion);
    expect(first.provenance.embeddingDims).toBe(16);
    expect(first.provenance.distanceMetric).toBe("cosine");
    expect(first.provenance.annParams).toEqual(annParams);
    expect(first.provenance.candidateSetSize).toBeGreaterThan(0);
    expect(first.hits[0]?.sourceHash).toMatch(/^sha256:/);
    expect(first.hits[0]?.denseScore).toBeNumber();
    expect(first.hits[0]?.rank).toBe(1);

    const capped = await retriever.retrieve({
      text: fixture.query,
      k: 5,
      maxCandidates: 1
    });
    expect(capped.provenance.candidateSetSize).toBe(1);
    expect(JSON.stringify(first)).not.toContain("Float32Array");
    expect(JSON.stringify(first)).not.toContain("vector");
    expect(JSON.stringify(first)).not.toContain(fixture.query);
  });

  test("HNSW result is within the declared determinism band versus exact reference", async () => {
    const fixture = readDenseFixture();
    const chunks = chunksForFixture(fixture);
    const provider = new DeterministicLocalEmbeddingProvider({ dims: 16 });
    const index = await buildDenseVectorIndex({
      chunks,
      provider,
      annParams
    });
    const queryVector = await provider.embedQuery(fixture.query);
    const ann = searchDenseVectorIndex(index, queryVector, 5);
    const exact = searchExactReference(index, queryVector, 5);
    const comparison = compareDenseCandidatesToExact({
      annCandidates: ann,
      exactCandidates: exact,
      band: {
        metric: "top_k_jaccard",
        threshold: 1,
        k: 5,
        requireTop1Stable: true
      }
    });

    expect(comparison.status).toBe("within_band");
    expect(comparison.topKJaccard).toBe(1);
    expect(comparison.top1Stable).toBe(true);
  });

  test("dimension mismatch and stale model versions fail closed", async () => {
    const chunks = chunksForDocuments([
      memoryDocument("dimension", "runtime kernel dense search")
    ]);
    const provider = new BadQueryDimensionProvider();
    const registry = registryWith(provider);
    const store = new DenseVectorIndexStore();
    await buildAndSwapDenseIndex({
      store,
      chunks,
      provider,
      annParams
    });
    const retriever = new DenseRetriever({
      indexStore: store,
      providerRegistry: registry
    });

    await expect(retriever.retrieve({ text: "runtime kernel" })).rejects.toThrow(
      MemoryError
    );

    const goodProvider = new DeterministicLocalEmbeddingProvider({
      dims: 16,
      modelVersion: "2.0.0"
    });
    const missingRegistry = new EmbeddingProviderRegistry();
    const missingStore = new DenseVectorIndexStore();
    await buildAndSwapDenseIndex({
      store: missingStore,
      chunks,
      provider: goodProvider,
      annParams
    });
    const missingRetriever = new DenseRetriever({
      indexStore: missingStore,
      providerRegistry: missingRegistry
    });

    await expect(missingRetriever.retrieve({ text: "runtime kernel" })).rejects.toThrow(
      MemoryError
    );
  });

  test("new model versions mint new index versions and old versions remain pinned", async () => {
    const chunks = chunksForFixture(readDenseFixture());
    const store = new DenseVectorIndexStore();
    const providerV1 = new DeterministicLocalEmbeddingProvider({
      dims: 16,
      modelVersion: "1.0.0"
    });
    const providerV2 = new DeterministicLocalEmbeddingProvider({
      dims: 16,
      modelVersion: "2.0.0"
    });
    const first = await buildAndSwapDenseIndex({
      store,
      chunks,
      provider: providerV1,
      annParams
    });
    const second = await buildAndSwapDenseIndex({
      store,
      chunks,
      provider: providerV2,
      annParams
    });

    expect(second.liveIndexVersion).not.toBe(first.liveIndexVersion);
    expect(store.resolve(first.liveIndexVersion).embedding.modelVersion).toBe("1.0.0");
    expect(store.resolve(second.liveIndexVersion).embedding.modelVersion).toBe("2.0.0");
    expect(store.listVersions()).toEqual(
      [first.liveIndexVersion, second.liveIndexVersion].sort()
    );
  });

  test("interrupted build does not replace the live index", async () => {
    const chunks = chunksForFixture(readDenseFixture());
    const store = new DenseVectorIndexStore();
    const providerV1 = new DeterministicLocalEmbeddingProvider({
      dims: 16,
      modelVersion: "1.0.0"
    });
    const providerV2 = new DeterministicLocalEmbeddingProvider({
      dims: 16,
      modelVersion: "2.0.0"
    });
    const first = await buildAndSwapDenseIndex({
      store,
      chunks,
      provider: providerV1,
      annParams
    });

    await expect(
      buildAndSwapDenseIndex({
        store,
        chunks,
        provider: providerV2,
        annParams,
        simulateInterruptBeforeSwap: true
      })
    ).rejects.toThrow(MemoryError);

    expect(store.liveIndexVersion()).toBe(first.liveIndexVersion);
    expect(store.listVersions()).toEqual([first.liveIndexVersion]);
  });

  test("missing replay version flags drift and schema-invalid output fails closed", async () => {
    const fixture = readDenseFixture();
    const chunks = chunksForFixture(fixture);
    const provider = new DeterministicLocalEmbeddingProvider({ dims: 16 });
    const registry = registryWith(provider);
    const store = new DenseVectorIndexStore();
    await buildAndSwapDenseIndex({
      store,
      chunks,
      provider,
      annParams
    });
    const retriever = new DenseRetriever({
      indexStore: store,
      providerRegistry: registry
    });
    const result = await retriever.retrieve({
      text: fixture.query,
      k: 3,
      maxCandidates: 5
    });
    const missingRecorded = {
      ...result,
      provenance: {
        ...result.provenance,
        indexVersion: hashString("missing dense index")
      }
    } satisfies DenseRetrievalResult;
    const replay = await checkDenseReplay({
      retriever,
      indexStore: store,
      recordedResult: missingRecorded,
      query: {
        text: fixture.query,
        k: 3,
        maxCandidates: 5
      }
    });

    expect(replay.status).toBe("version_unavailable");
    expect(() =>
      parseDenseRetrievalResult({
        ...result,
        hits: result.hits.map((hit) => {
          const clone = { ...hit };
          delete (clone as Record<string, unknown>).sourceHash;
          return clone;
        })
      })
    ).toThrow(MemoryError);
  });

  test("segment integrity detects index corruption", async () => {
    const chunks = chunksForDocuments([
      memoryDocument("corrupt", "runtime kernel dense search")
    ]);
    const provider = new DeterministicLocalEmbeddingProvider({ dims: 16 });
    const index = await buildDenseVectorIndex({
      chunks,
      provider,
      annParams
    });
    const corrupt = {
      ...index,
      segmentIntegrityHash: hashString("corrupt segment")
    };

    expect(() => verifyDenseVectorIndexIntegrity(corrupt)).toThrow(MemoryError);
  });
});

interface DenseFixture {
  readonly documents: readonly { readonly id: string; readonly content: string }[];
  readonly query: string;
}

function readDenseFixture(): DenseFixture {
  return JSON.parse(
    readFileSync(join(denseFixtureRoot, "tiny-corpus.json"), "utf8")
  ) as DenseFixture;
}

function registryWith(provider: EmbeddingProvider): EmbeddingProviderRegistry {
  const registry = new EmbeddingProviderRegistry();
  registry.register(provider);
  return registry;
}

function chunksForFixture(fixture: DenseFixture): Chunk[] {
  return chunksForDocuments(
    fixture.documents.map((document) =>
      memoryDocument(document.id, document.content, {
        id: document.id
      })
    )
  );
}

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

class BadQueryDimensionProvider extends DeterministicLocalEmbeddingProvider {
  override async embedQuery(_text: string): Promise<Float32Array> {
    return new Float32Array(8);
  }
}
