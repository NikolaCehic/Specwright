import type { RerankedCandidate } from "./contracts";

export interface SelectMmrInput {
  readonly candidates: readonly RerankedCandidate[];
  readonly k: number;
  readonly lambda: number;
}

export function selectMmr(input: SelectMmrInput): RerankedCandidate[] {
  if (input.k <= 0 || input.candidates.length === 0) {
    return [];
  }

  const selected: RerankedCandidate[] = [];
  const remaining = [...input.candidates];

  while (selected.length < input.k && remaining.length > 0) {
    const best = remaining
      .map((candidate, index) => ({
        candidate,
        index,
        relevance: relevanceScore(candidate),
        similarity: maxSimilarity(candidate, selected)
      }))
      .map((entry) => ({
        ...entry,
        mmrScore:
          input.lambda * entry.relevance - (1 - input.lambda) * entry.similarity
      }))
      .sort(
        (left, right) =>
          right.mmrScore - left.mmrScore ||
          right.relevance - left.relevance ||
          right.candidate.fusedScore - left.candidate.fusedScore ||
          left.candidate.chunkId.localeCompare(right.candidate.chunkId)
      )[0];

    if (best === undefined) {
      break;
    }

    selected.push(best.candidate);
    remaining.splice(best.index, 1);
  }

  return selected;
}

export function relevanceScore(candidate: RerankedCandidate): number {
  return candidate.rerankScore ?? candidate.fusedScore;
}

export function metadataSourceSimilarity(
  left: RerankedCandidate,
  right: RerankedCandidate
): number {
  if (left.chunkId === right.chunkId) {
    return 1;
  }

  if (left.sourceHash === right.sourceHash) {
    return 1;
  }

  if (left.documentId === right.documentId) {
    return 0.85;
  }

  if (left.corpusId === right.corpusId && left.trustLabel === right.trustLabel) {
    return 0.35;
  }

  if (left.authority === right.authority) {
    return 0.15;
  }

  return 0;
}

function maxSimilarity(
  candidate: RerankedCandidate,
  selected: readonly RerankedCandidate[]
): number {
  if (selected.length === 0) {
    return 0;
  }

  return Math.max(
    ...selected.map((selectedCandidate) =>
      metadataSourceSimilarity(candidate, selectedCandidate)
    )
  );
}
