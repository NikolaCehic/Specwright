import { z } from "zod";
import {
  CacheStatusSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "../corpus";
import { MemoryError } from "../errors";
import { Sha256HashSchema, hashValue } from "../hash";
import type { Sha256Hash } from "../hash";
import {
  LexicalAnalyzerConfigSchema,
  createLexicalAnalyzer
} from "./analyzer";
import { scoreBM25Candidates } from "./bm25";
import { BM25ConfigSchema } from "./config";
import type { LexicalIndex, LexicalIndexedChunk } from "./inverted-index";
import { scoreProximityCandidates } from "./proximity";

const nonEmptyString = z.string().min(1);

export const LexicalStructuralFilterSchema = z
  .object({
    corpusIds: z.array(nonEmptyString).min(1).optional(),
    documentIds: z.array(nonEmptyString).min(1).optional(),
    tenantIds: z.array(nonEmptyString).min(1).optional(),
    classes: z.array(MemoryClassSchema).min(1).optional(),
    authorities: z.array(SourceAuthoritySchema).min(1).optional(),
    trustLabels: z.array(TrustLabelSchema).min(1).optional(),
    tags: z.array(nonEmptyString).min(1).optional()
  })
  .strict();
export type LexicalStructuralFilter = z.infer<
  typeof LexicalStructuralFilterSchema
>;

export const LexicalRetrieverQuerySchema = z
  .object({
    text: nonEmptyString,
    k: z.number().int().min(0).max(1000).default(10),
    maxCandidates: z.number().int().min(0).max(10000).default(200),
    filters: LexicalStructuralFilterSchema.optional(),
    expectedIndexVersion: Sha256HashSchema.optional(),
    expectedAnalyzer: z
      .object({
        id: nonEmptyString,
        version: nonEmptyString
      })
      .strict()
      .optional(),
    expectedBm25: BM25ConfigSchema.optional(),
    cacheStatus: CacheStatusSchema.default("miss")
  })
  .strict();
export type LexicalRetrieverQuery = z.input<typeof LexicalRetrieverQuerySchema>;

export const LexicalHitScoresSchema = z
  .object({
    bm25: z.number().finite().nonnegative().optional(),
    proximity: z.number().finite().nonnegative().optional()
  })
  .strict()
  .refine((scores) => scores.bm25 !== undefined || scores.proximity !== undefined, {
    message: "at least one retriever score is required"
  });
export type LexicalHitScores = z.infer<typeof LexicalHitScoresSchema>;

export const LexicalHitSchema = z
  .object({
    chunkId: nonEmptyString,
    documentId: nonEmptyString,
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    chunkingStrategyVersion: Sha256HashSchema,
    rank: z.number().int().positive(),
    scores: LexicalHitScoresSchema,
    retrieverRanks: z
      .object({
        bm25: z.number().int().positive().optional(),
        proximity: z.number().int().positive().optional()
      })
      .strict(),
    injectionFlag: z.literal(false)
  })
  .strict();
export type LexicalHit = z.infer<typeof LexicalHitSchema>;

export const LexicalMemoryProvenanceSchema = z
  .object({
    corpusIds: z.array(nonEmptyString),
    indexId: nonEmptyString,
    indexVersion: Sha256HashSchema,
    indexFormatVersion: nonEmptyString,
    analyzer: LexicalAnalyzerConfigSchema,
    bm25: BM25ConfigSchema,
    chunkingStrategyVersion: Sha256HashSchema,
    chunkingStrategyVersions: z.array(Sha256HashSchema).min(1),
    retrievers: z.tuple([z.literal("bm25"), z.literal("proximity")]),
    candidateSetSizes: z
      .object({
        bm25: z.number().int().min(0),
        proximity: z.number().int().min(0)
      })
      .strict(),
    queryHash: Sha256HashSchema,
    cacheStatus: CacheStatusSchema,
    redactionSafe: z.literal(true)
  })
  .strict();
export type LexicalMemoryProvenance = z.infer<
  typeof LexicalMemoryProvenanceSchema
>;

export const LexicalRetrievalResultSchema = z
  .object({
    queryHash: Sha256HashSchema,
    hits: z.array(LexicalHitSchema),
    provenance: LexicalMemoryProvenanceSchema
  })
  .strict();
export type LexicalRetrievalResult = z.infer<
  typeof LexicalRetrievalResultSchema
>;

export class LexicalRetriever {
  readonly index: LexicalIndex;

  constructor(index: LexicalIndex) {
    this.index = index;
  }

  retrieve(input: LexicalRetrieverQuery): LexicalRetrievalResult {
    const query = parseLexicalQuery(input);
    assertQueryMatchesIndex(query, this.index);

    const analyzer = createLexicalAnalyzer(this.index.analyzer);
    const normalizedQuery = normalizeQueryText(query.text);
    const queryTerms = analyzer
      .analyze(normalizedQuery)
      .map((token) => token.term);
    const queryHash = hashValue(normalizedQuery);
    const allowedChunkIds = filterChunkIds(this.index, query.filters);

    const bm25Candidates = scoreBM25Candidates(
      this.index,
      queryTerms,
      query.maxCandidates,
      allowedChunkIds
    );
    const proximityCandidates = scoreProximityCandidates(
      this.index,
      queryTerms,
      query.maxCandidates,
      allowedChunkIds
    );

    const bm25Scores = new Map(
      bm25Candidates.map((candidate, index) => [
        candidate.chunkId,
        { score: candidate.score, rank: index + 1 }
      ])
    );
    const proximityScores = new Map(
      proximityCandidates.map((candidate, index) => [
        candidate.chunkId,
        { score: candidate.score, rank: index + 1 }
      ])
    );
    const unionIds = [
      ...new Set([
        ...bm25Candidates.map((candidate) => candidate.chunkId),
        ...proximityCandidates.map((candidate) => candidate.chunkId)
      ])
    ];

    const hits = unionIds
      .map((chunkId) =>
        buildHit(this.index, chunkId, bm25Scores.get(chunkId), proximityScores.get(chunkId))
      )
      .sort(compareLexicalHits)
      .slice(0, query.k)
      .map((hit, index) => LexicalHitSchema.parse({ ...hit, rank: index + 1 }));

    return LexicalRetrievalResultSchema.parse({
      queryHash,
      hits,
      provenance: {
        corpusIds: this.index.corpusIds,
        indexId: this.index.indexId,
        indexVersion: this.index.indexVersion,
        indexFormatVersion: this.index.indexFormatVersion,
        analyzer: this.index.analyzer,
        bm25: this.index.bm25,
        chunkingStrategyVersion: this.index.chunkingStrategyVersion,
        chunkingStrategyVersions: this.index.chunkingStrategyVersions,
        retrievers: ["bm25", "proximity"],
        candidateSetSizes: {
          bm25: bm25Candidates.length,
          proximity: proximityCandidates.length
        },
        queryHash,
        cacheStatus: query.cacheStatus,
        redactionSafe: true
      }
    });
  }
}

export function retrieveLexical(
  index: LexicalIndex,
  query: LexicalRetrieverQuery
): LexicalRetrievalResult {
  return new LexicalRetriever(index).retrieve(query);
}

export function normalizeQueryText(query: string): string {
  return query.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function parseLexicalQuery(
  input: LexicalRetrieverQuery
): z.infer<typeof LexicalRetrieverQuerySchema> {
  const parsed = LexicalRetrieverQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_lexical_query",
      field: "query",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

function assertQueryMatchesIndex(
  query: z.infer<typeof LexicalRetrieverQuerySchema>,
  index: LexicalIndex
): void {
  if (
    query.expectedIndexVersion !== undefined &&
    query.expectedIndexVersion !== index.indexVersion
  ) {
    throw versionMismatch("indexVersion", query.expectedIndexVersion, index.indexVersion);
  }

  if (
    query.expectedAnalyzer !== undefined &&
    (query.expectedAnalyzer.id !== index.analyzer.id ||
      query.expectedAnalyzer.version !== index.analyzer.version)
  ) {
    throw versionMismatch(
      "analyzer",
      `${query.expectedAnalyzer.id}@${query.expectedAnalyzer.version}`,
      `${index.analyzer.id}@${index.analyzer.version}`
    );
  }

  if (
    query.expectedBm25 !== undefined &&
    (query.expectedBm25.k1 !== index.bm25.k1 || query.expectedBm25.b !== index.bm25.b)
  ) {
    throw versionMismatch(
      "bm25",
      `k1=${query.expectedBm25.k1},b=${query.expectedBm25.b}`,
      `k1=${index.bm25.k1},b=${index.bm25.b}`
    );
  }
}

function versionMismatch(
  field: string,
  expected: string,
  actual: string
): MemoryError {
  return new MemoryError({
    code: "lexical_version_mismatch",
    field,
    condition: expected,
    message: `Lexical query expected ${field} ${expected}, but index has ${actual}`
  });
}

function filterChunkIds(
  index: LexicalIndex,
  filters: LexicalStructuralFilter | undefined
): ReadonlySet<string> | undefined {
  if (filters === undefined) {
    return undefined;
  }

  const allowed = new Set<string>();
  for (const [chunkId, chunk] of index.chunksById) {
    if (matchesFilters(chunk, filters)) {
      allowed.add(chunkId);
    }
  }

  return allowed;
}

function matchesFilters(
  chunk: LexicalIndexedChunk,
  filters: LexicalStructuralFilter
): boolean {
  return (
    matchesList(filters.corpusIds, chunk.corpusId) &&
    matchesList(filters.documentIds, chunk.documentId) &&
    matchesList(filters.tenantIds, chunk.tenantId) &&
    matchesList(filters.classes, chunk.class) &&
    matchesList(filters.authorities, chunk.authority) &&
    matchesList(filters.trustLabels, chunk.trustLabel) &&
    matchesTags(filters.tags, chunk.metadata?.tags)
  );
}

function matchesList<T extends string>(
  allowed: readonly T[] | undefined,
  value: T
): boolean {
  return allowed === undefined || allowed.includes(value);
}

function matchesTags(
  requiredTags: readonly string[] | undefined,
  metadataTags: unknown
): boolean {
  if (requiredTags === undefined) {
    return true;
  }

  if (
    !Array.isArray(metadataTags) ||
    !metadataTags.every((tag): tag is string => typeof tag === "string")
  ) {
    return false;
  }

  return requiredTags.every((tag) => metadataTags.includes(tag));
}

function buildHit(
  index: LexicalIndex,
  chunkId: string,
  bm25: { readonly score: number; readonly rank: number } | undefined,
  proximity: { readonly score: number; readonly rank: number } | undefined
): Omit<LexicalHit, "rank"> {
  const chunk = index.chunksById.get(chunkId);
  if (chunk === undefined) {
    throw new MemoryError({
      code: "index_corruption",
      field: "chunkId",
      condition: chunkId,
      message: `Scored chunk ${chunkId} is not present in the lexical index`
    });
  }

  const scores: LexicalHitScores = {
    ...(bm25 === undefined ? {} : { bm25: bm25.score }),
    ...(proximity === undefined ? {} : { proximity: proximity.score })
  };
  const retrieverRanks = {
    ...(bm25 === undefined ? {} : { bm25: bm25.rank }),
    ...(proximity === undefined ? {} : { proximity: proximity.rank })
  };

  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    corpusId: chunk.corpusId,
    tenantId: chunk.tenantId,
    sourceRef: chunk.sourceRef,
    sourceHash: chunk.sourceHash,
    authority: chunk.authority,
    trustLabel: chunk.trustLabel,
    chunkingStrategyVersion: chunk.chunkingStrategy.version,
    scores,
    retrieverRanks,
    injectionFlag: false
  };
}

function compareLexicalHits(left: Omit<LexicalHit, "rank">, right: Omit<LexicalHit, "rank">): number {
  return (
    (right.scores.bm25 ?? 0) - (left.scores.bm25 ?? 0) ||
    (right.scores.proximity ?? 0) - (left.scores.proximity ?? 0) ||
    left.chunkId.localeCompare(right.chunkId)
  );
}
