import { MemoryError } from "../errors";
import { hashValue } from "../hash";
import {
  RerankedCandidateSchema,
  type FusedCandidate,
  type RerankedCandidate
} from "./contracts";

export interface RerankerHitScore {
  readonly chunkId: string;
  readonly score: number;
}

export interface RerankerInput {
  readonly query: string;
  readonly hits: readonly FusedCandidate[];
  readonly topN: number;
}

export interface RerankerResult {
  readonly hits: readonly RerankerHitScore[];
  readonly model: string;
  readonly modelVersion: string;
}

export interface Reranker {
  readonly model: string;
  readonly modelVersion: string;
  rerank(input: RerankerInput): RerankerResult | Promise<RerankerResult>;
}

export interface ApplyRerankInput {
  readonly query: string;
  readonly hits: readonly FusedCandidate[];
  readonly topN: number;
  readonly reranker?: Reranker;
}

export interface ApplyRerankOutput {
  readonly hits: readonly RerankedCandidate[];
  readonly skipped: boolean;
  readonly model?: string;
  readonly modelVersion?: string;
}

export async function applyRerank(
  input: ApplyRerankInput
): Promise<ApplyRerankOutput> {
  if (input.reranker === undefined) {
    return {
      hits: input.hits.map((hit) => RerankedCandidateSchema.parse(hit)),
      skipped: true
    };
  }

  const topN = Math.min(input.topN, input.hits.length);
  const pool = input.hits.slice(0, topN);
  const rest = input.hits.slice(topN).map((hit) => RerankedCandidateSchema.parse(hit));

  try {
    const reranked = await input.reranker.rerank({
      query: input.query,
      hits: pool,
      topN
    });
    const rerankedPool = validateAndApplyRerank(pool, reranked);

    return {
      hits: [...rerankedPool, ...rest],
      skipped: false,
      model: reranked.model,
      modelVersion: reranked.modelVersion
    };
  } catch (error) {
    if (error instanceof MemoryError && error.code === "output_invalid") {
      throw error;
    }

    return {
      hits: input.hits.map((hit) => RerankedCandidateSchema.parse(hit)),
      skipped: true
    };
  }
}

export class ReferenceDeterministicReranker implements Reranker {
  readonly model: string;
  readonly modelVersion: string;

  constructor(
    input: {
      readonly model?: string;
      readonly modelVersion?: string;
    } = {}
  ) {
    this.model = input.model ?? "specwright-reference-reranker";
    this.modelVersion = input.modelVersion ?? "1.0.0";
  }

  rerank(input: RerankerInput): RerankerResult {
    const pool = input.hits.slice(0, input.topN);
    const scored = pool
      .map((hit) => ({
        chunkId: hit.chunkId,
        score:
          hit.fusedScore * 0.7 +
          authorityPrior(hit.authority) * 0.2 +
          stableQueryAffinity(input.query, hit.chunkId, hit.sourceHash) * 0.1
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.chunkId.localeCompare(right.chunkId)
      );

    return {
      hits: scored,
      model: this.model,
      modelVersion: this.modelVersion
    };
  }
}

function validateAndApplyRerank(
  pool: readonly FusedCandidate[],
  result: RerankerResult
): RerankedCandidate[] {
  const poolById = new Map(pool.map((hit) => [hit.chunkId, hit]));
  const seen = new Set<string>();

  if (result.hits.length !== pool.length) {
    throw invalidRerankOutput(
      `Reranker returned ${result.hits.length} hits for a pool of ${pool.length}`
    );
  }

  return result.hits.map((scored, index) => {
    const hit = poolById.get(scored.chunkId);
    if (hit === undefined) {
      throw invalidRerankOutput(
        `Reranker returned out-of-pool chunk ${scored.chunkId}`
      );
    }

    if (seen.has(scored.chunkId)) {
      throw invalidRerankOutput(`Reranker returned duplicate chunk ${scored.chunkId}`);
    }

    if (!Number.isFinite(scored.score)) {
      throw invalidRerankOutput(`Reranker returned non-finite score for ${scored.chunkId}`);
    }

    seen.add(scored.chunkId);
    return RerankedCandidateSchema.parse({
      ...hit,
      rerankScore: scored.score,
      rerankRank: index + 1
    });
  });
}

function invalidRerankOutput(message: string): MemoryError {
  return new MemoryError({
    code: "output_invalid",
    field: "rerank",
    condition: "schema",
    message
  });
}

function authorityPrior(authority: FusedCandidate["authority"]): number {
  switch (authority) {
    case "repo":
    case "design":
    case "user":
      return 1;
    case "external":
      return 0.7;
    case "generated":
    case "model":
      return 0.25;
    default:
      return 0;
  }
}

function stableQueryAffinity(
  query: string,
  chunkId: string,
  sourceHash: string
): number {
  const hash = hashValue({ query, chunkId, sourceHash }).slice("sha256:".length);
  return Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
}
