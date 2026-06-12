import type { LexicalIndex } from "./inverted-index";
import { getPosting } from "./inverted-index";

export interface LexicalScoreCandidate {
  readonly chunkId: string;
  readonly score: number;
}

export function scoreBM25(
  index: LexicalIndex,
  queryTerms: readonly string[],
  chunkId: string
): number {
  if (index.averageChunkLength <= 0) {
    return 0;
  }

  const chunk = index.chunksById.get(chunkId);
  if (chunk === undefined || chunk.length === 0) {
    return 0;
  }

  let score = 0;
  for (const term of uniqueSorted(queryTerms)) {
    const posting = getPosting(index, term, chunkId);
    if (posting === undefined) {
      continue;
    }

    const idf = inverseDocumentFrequency(index, term);
    const frequency = posting.termFrequency;
    const denominator =
      frequency +
      index.bm25.k1 *
        (1 - index.bm25.b + index.bm25.b * (chunk.length / index.averageChunkLength));
    score +=
      idf * ((frequency * (index.bm25.k1 + 1)) / denominator);
  }

  return score;
}

export function scoreBM25Candidates(
  index: LexicalIndex,
  queryTerms: readonly string[],
  maxCandidates: number,
  allowedChunkIds?: ReadonlySet<string>
): LexicalScoreCandidate[] {
  if (maxCandidates === 0) {
    return [];
  }

  const candidateIds = new Set<string>();
  for (const term of uniqueSorted(queryTerms)) {
    for (const posting of index.termStats.get(term)?.postings ?? []) {
      if (allowedChunkIds === undefined || allowedChunkIds.has(posting.chunkId)) {
        candidateIds.add(posting.chunkId);
      }
    }
  }

  return [...candidateIds]
    .map((chunkId) => ({
      chunkId,
      score: scoreBM25(index, queryTerms, chunkId)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates)
    .slice(0, maxCandidates);
}

export function inverseDocumentFrequency(
  index: LexicalIndex,
  term: string
): number {
  const stats = index.termStats.get(term);
  if (stats === undefined || index.chunkCount === 0) {
    return 0;
  }

  return Math.log(
    1 + (index.chunkCount - stats.documentFrequency + 0.5) / (stats.documentFrequency + 0.5)
  );
}

export function compareCandidates(
  left: LexicalScoreCandidate,
  right: LexicalScoreCandidate
): number {
  return right.score - left.score || left.chunkId.localeCompare(right.chunkId);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
