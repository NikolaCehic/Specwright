import type { LexicalIndex } from "./inverted-index";
import { getPosting } from "./inverted-index";
import type { LexicalScoreCandidate } from "./bm25";
import { compareCandidates } from "./bm25";

export function scoreProximity(
  index: LexicalIndex,
  queryTerms: readonly string[],
  chunkId: string
): number {
  if (queryTerms.length < 2) {
    return 0;
  }

  const positionsByTerm = new Map<string, readonly number[]>();
  for (const term of uniqueInOrder(queryTerms)) {
    const posting = getPosting(index, term, chunkId);
    if (posting === undefined) {
      return 0;
    }
    positionsByTerm.set(term, posting.positions);
  }

  const phraseScore = bestOrderedPhraseScore(queryTerms, positionsByTerm);
  const pairScore = adjacentPairScore(queryTerms, positionsByTerm);

  return phraseScore + pairScore;
}

export function scoreProximityCandidates(
  index: LexicalIndex,
  queryTerms: readonly string[],
  maxCandidates: number,
  allowedChunkIds?: ReadonlySet<string>
): LexicalScoreCandidate[] {
  if (maxCandidates === 0 || queryTerms.length < 2) {
    return [];
  }

  const firstTerm = queryTerms[0];
  if (firstTerm === undefined) {
    return [];
  }

  const candidateIds = new Set<string>();
  for (const posting of index.termStats.get(firstTerm)?.postings ?? []) {
    if (allowedChunkIds === undefined || allowedChunkIds.has(posting.chunkId)) {
      candidateIds.add(posting.chunkId);
    }
  }

  return [...candidateIds]
    .map((chunkId) => ({
      chunkId,
      score: scoreProximity(index, queryTerms, chunkId)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(compareCandidates)
    .slice(0, maxCandidates);
}

function bestOrderedPhraseScore(
  queryTerms: readonly string[],
  positionsByTerm: ReadonlyMap<string, readonly number[]>
): number {
  const firstTerm = queryTerms[0];
  if (firstTerm === undefined) {
    return 0;
  }

  let best = 0;
  for (const start of positionsByTerm.get(firstTerm) ?? []) {
    let previous = start;
    let totalGap = 0;
    let matched = true;

    for (const term of queryTerms.slice(1)) {
      const next = firstGreaterThan(positionsByTerm.get(term) ?? [], previous);
      if (next === undefined) {
        matched = false;
        break;
      }

      totalGap += Math.max(0, next - previous - 1);
      previous = next;
    }

    if (matched) {
      best = Math.max(best, queryTerms.length / (1 + totalGap));
    }
  }

  return best;
}

function adjacentPairScore(
  queryTerms: readonly string[],
  positionsByTerm: ReadonlyMap<string, readonly number[]>
): number {
  let score = 0;
  for (let index = 0; index < queryTerms.length - 1; index += 1) {
    const leftTerm = queryTerms[index];
    const rightTerm = queryTerms[index + 1];
    if (leftTerm === undefined || rightTerm === undefined) {
      continue;
    }

    const leftPositions = positionsByTerm.get(leftTerm) ?? [];
    const rightPositions = positionsByTerm.get(rightTerm) ?? [];
    const gap = bestForwardGap(leftPositions, rightPositions);
    if (gap !== undefined) {
      score += 1 / (1 + gap);
    }
  }

  return score;
}

function bestForwardGap(
  leftPositions: readonly number[],
  rightPositions: readonly number[]
): number | undefined {
  let best: number | undefined;
  for (const left of leftPositions) {
    const right = firstGreaterThan(rightPositions, left);
    if (right === undefined) {
      continue;
    }

    const gap = Math.max(0, right - left - 1);
    best = best === undefined ? gap : Math.min(best, gap);
  }

  return best;
}

function firstGreaterThan(
  sortedPositions: readonly number[],
  value: number
): number | undefined {
  for (const position of sortedPositions) {
    if (position > value) {
      return position;
    }
  }

  return undefined;
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }

  return unique;
}
