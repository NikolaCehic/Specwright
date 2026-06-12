import { z } from "zod";
import type { SourceAuthority, SourceRef } from "@specwright/schemas";
import { ChunkSchema } from "../chunk";
import type { Chunk, ChunkingStrategyStamp } from "../chunk";
import { MemoryError } from "../errors";
import { Sha256HashSchema, hashValue } from "../hash";
import type { Sha256Hash } from "../hash";
import {
  DEFAULT_HNSW_ANN_PARAMS,
  DenseIndexedChunkSchema,
  type DenseIndexedChunk,
  type EmbeddingDescriptor,
  type HnswAnnParams,
  parseAnnParams
} from "../dense-contracts";
import type { MemoryClass, TrustLabel } from "../corpus";
import type { EmbeddingProvider } from "../embedding";
import { embedChunksChecked } from "../embedding";
import {
  DENSE_INDEX_FORMAT_VERSION,
  buildDenseIndexVersion
} from "./index-version";
import { scoreVectorSimilarity, vectorHashInput } from "./scoring";

const nonEmptyString = z.string().min(1);

export interface DenseVectorNode {
  readonly chunk: DenseIndexedChunk;
  readonly vector: Float32Array;
  readonly level: number;
  readonly vectorHash: Sha256Hash;
}

export interface DenseSearchCandidate {
  readonly chunkId: string;
  readonly score: number;
}

export interface DenseVectorIndex {
  readonly indexId: string;
  readonly indexVersion: Sha256Hash;
  readonly indexFormatVersion: typeof DENSE_INDEX_FORMAT_VERSION;
  readonly embedding: EmbeddingDescriptor;
  readonly annParams: HnswAnnParams;
  readonly corpusSnapshotHash: Sha256Hash;
  readonly corpusIds: readonly string[];
  readonly tenantIds: readonly string[];
  readonly chunkingStrategyVersion: Sha256Hash;
  readonly chunkingStrategyVersions: readonly Sha256Hash[];
  readonly chunkCount: number;
  readonly segmentIntegrityHash: Sha256Hash;
  readonly entryPoint: string;
  readonly maxLevel: number;
  readonly nodesById: ReadonlyMap<string, DenseVectorNode>;
  readonly graph: ReadonlyMap<string, ReadonlyMap<number, readonly string[]>>;
}

export interface BuildDenseVectorIndexInput {
  readonly chunks: readonly unknown[];
  readonly provider: EmbeddingProvider;
  readonly annParams?: unknown;
  readonly indexId?: string;
}

export async function buildDenseVectorIndex(
  input: BuildDenseVectorIndexInput
): Promise<DenseVectorIndex> {
  const annParams = parseAnnParams(input.annParams ?? DEFAULT_HNSW_ANN_PARAMS);
  const chunks = parseDenseChunks(input.chunks);
  if (chunks.length === 0) {
    throw new MemoryError({
      code: "invalid_vector_index",
      field: "chunks",
      condition: "empty",
      message: "Dense vector index requires at least one chunk"
    });
  }

  const vectors = await embedChunksChecked(
    input.provider,
    chunks.map((chunk) => chunk.text)
  );
  const nodes = chunks.map((chunk, index) => {
    const vector = vectors[index];
    if (vector === undefined) {
      throw new MemoryError({
        code: "embedding_provider_unavailable",
        field: "vectors",
        condition: "missing",
        message: `Missing vector for chunk ${chunk.chunkId}`
      });
    }

    return makeNode(chunk, vector, annParams);
  });

  const nodesById = new Map<string, DenseVectorNode>();
  for (const node of nodes) {
    if (nodesById.has(node.chunk.chunkId)) {
      throw new MemoryError({
        code: "index_corrupt",
        field: "chunkId",
        condition: node.chunk.chunkId,
        message: `Duplicate dense chunk id ${node.chunk.chunkId}`
      });
    }
    nodesById.set(node.chunk.chunkId, node);
  }

  const graph = buildHnswGraph(nodes, annParams, input.provider.descriptor.distanceMetric);
  const corpusIds = uniqueSorted(chunks.map((chunk) => chunk.corpusId));
  const tenantIds = uniqueSorted(chunks.map((chunk) => chunk.tenantId));
  const chunkingStrategyVersions = uniqueSorted(
    chunks.map((chunk) => chunk.chunkingStrategy.version)
  ) as Sha256Hash[];
  const firstChunkingStrategyVersion = chunkingStrategyVersions[0];
  if (firstChunkingStrategyVersion === undefined) {
    throw new MemoryError({
      code: "invalid_vector_index",
      field: "chunkingStrategyVersions",
      condition: "empty",
      message: "Dense index requires at least one chunking strategy version"
    });
  }

  const corpusSnapshotHash = hashValue(
    chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      contentHash: chunk.contentHash,
      sourceHash: chunk.sourceHash,
      chunkingStrategy: chunk.chunkingStrategy
    }))
  );
  const indexVersion = buildDenseIndexVersion({
    corpusSnapshotHash,
    embedding: input.provider.descriptor,
    annParams,
    chunkingStrategyVersions,
    indexFormatVersion: DENSE_INDEX_FORMAT_VERSION
  });
  const indexId =
    input.indexId ??
    `idx.dense.${hashValue({
      corpusIds,
      tenantIds,
      corpusSnapshotHash,
      embedding: input.provider.descriptor
    }).slice("sha256:".length, "sha256:".length + 16)}`;
  const maxLevel = Math.max(...nodes.map((node) => node.level));
  const entryPoint =
    nodes
      .slice()
      .sort(
        (left, right) =>
          right.level - left.level || left.chunk.chunkId.localeCompare(right.chunk.chunkId)
      )[0]?.chunk.chunkId ?? "";
  const chunkingStrategyVersion =
    chunkingStrategyVersions.length === 1
      ? firstChunkingStrategyVersion
      : hashValue({ chunkingStrategyVersions });
  const partialIndex = {
    indexId,
    indexVersion,
    indexFormatVersion: DENSE_INDEX_FORMAT_VERSION,
    embedding: input.provider.descriptor,
    annParams,
    corpusSnapshotHash,
    corpusIds,
    tenantIds,
    chunkingStrategyVersion,
    chunkingStrategyVersions,
    chunkCount: chunks.length,
    segmentIntegrityHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hash,
    entryPoint,
    maxLevel,
    nodesById,
    graph
  } satisfies DenseVectorIndex;

  const index = {
    ...partialIndex,
    segmentIntegrityHash: computeDenseSegmentIntegrityHash(partialIndex)
  } satisfies DenseVectorIndex;
  verifyDenseVectorIndexIntegrity(index);
  return index;
}

export function searchDenseVectorIndex(
  index: DenseVectorIndex,
  queryVector: Float32Array,
  maxCandidates: number,
  allowedChunkIds?: ReadonlySet<string>
): DenseSearchCandidate[] {
  verifyDenseVectorIndexIntegrity(index);
  if (maxCandidates === 0) {
    return [];
  }

  const entry = index.nodesById.get(index.entryPoint);
  if (entry === undefined) {
    throw new MemoryError({
      code: "index_corrupt",
      field: "entryPoint",
      condition: index.entryPoint,
      message: "Dense index entry point is missing"
    });
  }

  let entryPoint = entry;
  for (let layer = index.maxLevel; layer > 0; layer -= 1) {
    const nearest = searchLayer(index, queryVector, entryPoint.chunk.chunkId, 1, layer);
    const first = nearest[0];
    if (first !== undefined) {
      const node = index.nodesById.get(first.chunkId);
      if (node !== undefined) {
        entryPoint = node;
      }
    }
  }

  return searchLayer(
    index,
    queryVector,
    entryPoint.chunk.chunkId,
    index.annParams.efSearch,
    0,
    allowedChunkIds
  ).slice(0, maxCandidates);
}

export function verifyDenseVectorIndexIntegrity(index: DenseVectorIndex): void {
  if (index.nodesById.size !== index.chunkCount) {
    throw new MemoryError({
      code: "index_corrupt",
      field: "chunkCount",
      condition: `${index.nodesById.size}!=${index.chunkCount}`,
      message: "Dense index node count does not match chunk count"
    });
  }

  for (const node of index.nodesById.values()) {
    if (node.vector.length !== index.embedding.dims) {
      throw new MemoryError({
        code: "dimension_mismatch",
        field: "index.vector",
        condition: node.chunk.chunkId,
        message: `Indexed vector for ${node.chunk.chunkId} has dimension ${node.vector.length}; expected ${index.embedding.dims}`
      });
    }
  }

  const expected = computeDenseSegmentIntegrityHash(index);
  if (expected !== index.segmentIntegrityHash) {
    throw new MemoryError({
      code: "index_corrupt",
      field: "segmentIntegrityHash",
      condition: index.indexVersion,
      message: "Dense index segment integrity hash mismatch"
    });
  }
}

export function computeDenseSegmentIntegrityHash(index: DenseVectorIndex): Sha256Hash {
  return hashValue({
    indexId: index.indexId,
    indexVersion: index.indexVersion,
    embedding: index.embedding,
    annParams: index.annParams,
    corpusSnapshotHash: index.corpusSnapshotHash,
    chunkingStrategyVersions: index.chunkingStrategyVersions,
    nodes: [...index.nodesById.values()]
      .sort((left, right) => left.chunk.chunkId.localeCompare(right.chunk.chunkId))
      .map((node) => ({
        chunkId: node.chunk.chunkId,
        sourceHash: node.chunk.sourceHash,
        contentHash: node.chunk.contentHash,
        level: node.level,
        vectorHash: node.vectorHash
      })),
    graph: [...index.graph.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([chunkId, layers]) => ({
        chunkId,
        layers: [...layers.entries()]
          .sort(([left], [right]) => left - right)
          .map(([layer, neighbors]) => ({
            layer,
            neighbors: [...neighbors].sort()
          }))
      }))
  });
}

export function compareDenseSearchCandidates(
  left: DenseSearchCandidate,
  right: DenseSearchCandidate
): number {
  return right.score - left.score || left.chunkId.localeCompare(right.chunkId);
}

function parseDenseChunks(input: readonly unknown[]): Chunk[] {
  return input
    .map((chunk) => {
      const parsed = ChunkSchema.safeParse(chunk);
      if (!parsed.success) {
        throw new MemoryError({
          code: "invalid_chunk",
          field: "chunks",
          condition: "schema",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "chunk"}: ${issue.message}`)
            .join("; ")
        });
      }

      return parsed.data;
    })
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}

function makeNode(
  chunk: Chunk,
  vector: Float32Array,
  params: HnswAnnParams
): DenseVectorNode {
  return {
    chunk: DenseIndexedChunkSchema.parse({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      corpusId: chunk.corpusId,
      tenantId: chunk.tenantId,
      class: chunk.class,
      sourceRef: chunk.sourceRef,
      sourceHash: chunk.sourceHash,
      contentHash: chunk.contentHash,
      authority: chunk.authority,
      trustLabel: chunk.trustLabel,
      chunkingStrategy: chunk.chunkingStrategy,
      ordinal: chunk.ordinal,
      ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata })
    }),
    vector,
    level: deterministicHnswLevel(chunk.chunkId, params),
    vectorHash: hashValue(vectorHashInput(vector))
  };
}

function buildHnswGraph(
  nodes: readonly DenseVectorNode[],
  params: HnswAnnParams,
  metric: EmbeddingDescriptor["distanceMetric"]
): ReadonlyMap<string, ReadonlyMap<number, readonly string[]>> {
  const nodesById = new Map(nodes.map((node) => [node.chunk.chunkId, node]));
  const graph = new Map<string, Map<number, string[]>>();
  const inserted: DenseVectorNode[] = [];

  for (const node of [...nodes].sort((left, right) => left.chunk.chunkId.localeCompare(right.chunk.chunkId))) {
    graph.set(node.chunk.chunkId, new Map());
    for (let layer = 0; layer <= node.level; layer += 1) {
      graph.get(node.chunk.chunkId)?.set(layer, []);
    }

    for (let layer = Math.min(node.level, params.maxLevel); layer >= 0; layer -= 1) {
      const candidates = inserted
        .filter((candidate) => candidate.level >= layer)
        .map((candidate) => ({
          chunkId: candidate.chunk.chunkId,
          score: scoreVectorSimilarity(node.vector, candidate.vector, metric)
        }))
        .sort(compareDenseSearchCandidates)
        .slice(0, Math.min(params.m, params.efConstruction));

      for (const candidate of candidates.slice(0, params.m)) {
        connectNodes(graph, nodesById, node.chunk.chunkId, candidate.chunkId, layer, params.m, metric);
      }
    }

    inserted.push(node);
  }

  return graph;
}

function connectNodes(
  graph: Map<string, Map<number, string[]>>,
  nodesById: ReadonlyMap<string, DenseVectorNode>,
  leftId: string,
  rightId: string,
  layer: number,
  m: number,
  metric: EmbeddingDescriptor["distanceMetric"]
): void {
  addNeighbor(graph, nodesById, leftId, rightId, layer, m, metric);
  addNeighbor(graph, nodesById, rightId, leftId, layer, m, metric);
}

function addNeighbor(
  graph: Map<string, Map<number, string[]>>,
  nodesById: ReadonlyMap<string, DenseVectorNode>,
  sourceId: string,
  neighborId: string,
  layer: number,
  m: number,
  metric: EmbeddingDescriptor["distanceMetric"]
): void {
  const layers = graph.get(sourceId);
  if (layers === undefined) {
    return;
  }

  const neighbors = new Set([...(layers.get(layer) ?? []), neighborId]);
  const source = nodesById.get(sourceId);
  if (source === undefined) {
    return;
  }

  const sorted = [...neighbors]
    .map((candidateId) => {
      const candidate = nodesById.get(candidateId);
      return candidate === undefined
        ? undefined
        : {
            chunkId: candidateId,
            score: scoreVectorSimilarity(source.vector, candidate.vector, metric)
          };
    })
    .filter((candidate): candidate is DenseSearchCandidate => candidate !== undefined)
    .sort(compareDenseSearchCandidates)
    .slice(0, m)
    .map((candidate) => candidate.chunkId);
  layers.set(layer, sorted);
}

function searchLayer(
  index: DenseVectorIndex,
  queryVector: Float32Array,
  entryPointId: string,
  ef: number,
  layer: number,
  allowedChunkIds?: ReadonlySet<string>
): DenseSearchCandidate[] {
  const visited = new Set<string>();
  const candidates: DenseSearchCandidate[] = [];
  const results = new Map<string, DenseSearchCandidate>();
  candidates.push(scoreNode(index, queryVector, entryPointId));

  while (candidates.length > 0 && visited.size < Math.max(ef * 4, ef + 1)) {
    candidates.sort(compareDenseSearchCandidates);
    const current = candidates.shift();
    if (current === undefined || visited.has(current.chunkId)) {
      continue;
    }

    visited.add(current.chunkId);
    if (allowedChunkIds === undefined || allowedChunkIds.has(current.chunkId)) {
      results.set(current.chunkId, current);
    }

    const neighbors = index.graph.get(current.chunkId)?.get(layer) ?? [];
    for (const neighborId of neighbors) {
      if (!visited.has(neighborId)) {
        candidates.push(scoreNode(index, queryVector, neighborId));
      }
    }
  }

  return [...results.values()].sort(compareDenseSearchCandidates).slice(0, ef);
}

function scoreNode(
  index: DenseVectorIndex,
  queryVector: Float32Array,
  chunkId: string
): DenseSearchCandidate {
  const node = index.nodesById.get(chunkId);
  if (node === undefined) {
    throw new MemoryError({
      code: "index_corrupt",
      field: "chunkId",
      condition: chunkId,
      message: `Dense graph references missing node ${chunkId}`
    });
  }

  return {
    chunkId,
    score: scoreVectorSimilarity(
      queryVector,
      node.vector,
      index.embedding.distanceMetric
    )
  };
}

function deterministicHnswLevel(chunkId: string, params: HnswAnnParams): number {
  const hash = hashValue({
    seed: params.levelSeed,
    chunkId
  }).slice("sha256:".length);
  let level = 0;

  for (let offset = 0; offset < hash.length && level < params.maxLevel; offset += 2) {
    const byte = Number.parseInt(hash.slice(offset, offset + 2), 16);
    if (byte >= 96) {
      break;
    }
    level += 1;
  }

  return level;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
