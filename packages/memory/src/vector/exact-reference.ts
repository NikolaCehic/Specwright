import type { DenseSearchCandidate, DenseVectorIndex } from "./ann-index";
import { compareDenseSearchCandidates } from "./ann-index";
import { scoreVectorSimilarity } from "./scoring";

export function searchExactReference(
  index: DenseVectorIndex,
  queryVector: Float32Array,
  maxCandidates: number,
  allowedChunkIds?: ReadonlySet<string>
): DenseSearchCandidate[] {
  if (maxCandidates === 0) {
    return [];
  }

  return [...index.nodesById.values()]
    .filter(
      (node) => allowedChunkIds === undefined || allowedChunkIds.has(node.chunk.chunkId)
    )
    .map((node) => ({
      chunkId: node.chunk.chunkId,
      score: scoreVectorSimilarity(
        queryVector,
        node.vector,
        index.embedding.distanceMetric
      )
    }))
    .sort(compareDenseSearchCandidates)
    .slice(0, maxCandidates);
}
