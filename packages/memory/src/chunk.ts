import { z } from "zod";
import {
  MetadataSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "./corpus";
import { MemoryDocumentSchema } from "./document";
import { MemoryError } from "./errors";
import { Sha256HashSchema, hashString, hashValue } from "./hash";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);

export const SpanSchema = z
  .object({
    start: nonNegativeInteger,
    end: nonNegativeInteger
  })
  .strict()
  .refine((span) => span.end >= span.start, {
    message: "span end must be greater than or equal to start"
  });
export type Span = z.infer<typeof SpanSchema>;

export const ChunkingStrategyStampSchema = z
  .object({
    id: nonEmptyString,
    version: Sha256HashSchema
  })
  .strict();
export type ChunkingStrategyStamp = z.infer<
  typeof ChunkingStrategyStampSchema
>;

export const CandidateChunkSchema = z
  .object({
    text: nonEmptyString,
    span: SpanSchema,
    tokenSpan: SpanSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type CandidateChunk = z.infer<typeof CandidateChunkSchema>;

export const ChunkSchema = z
  .object({
    chunkId: nonEmptyString,
    documentId: nonEmptyString,
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    class: MemoryClassSchema,
    sourceRef: SourceRefSchema,
    sourceHash: Sha256HashSchema,
    contentHash: Sha256HashSchema,
    trustLabel: TrustLabelSchema,
    authority: SourceAuthoritySchema,
    ordinal: nonNegativeInteger,
    text: nonEmptyString,
    span: SpanSchema,
    tokenSpan: SpanSchema.optional(),
    chunkingStrategy: ChunkingStrategyStampSchema,
    retrievalRole: z.literal("advisory_data"),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.contentHash !== hashString(chunk.text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentHash"],
        message: "contentHash must match chunk text"
      });
    }

  });
export type Chunk = z.infer<typeof ChunkSchema>;

export function parseChunk(input: unknown): Chunk {
  const parsed = ChunkSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_chunk",
      field: "chunk",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "chunk"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export function parseCandidateChunk(input: unknown): CandidateChunk {
  const parsed = CandidateChunkSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_chunk",
      field: "candidate",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "candidate"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export interface FinalizeChunkInput {
  readonly document: z.infer<typeof MemoryDocumentSchema>;
  readonly candidate: CandidateChunk;
  readonly ordinal: number;
  readonly strategy: ChunkingStrategyStamp;
}

export function finalizeChunk(input: FinalizeChunkInput): Chunk {
  const document = MemoryDocumentSchema.parse(input.document);
  const candidate = parseCandidateChunk(input.candidate);
  const strategy = ChunkingStrategyStampSchema.parse(input.strategy);
  const contentHash = hashString(candidate.text);
  const chunkId = hashValue({
    documentId: document.id,
    sourceHash: document.sourceHash,
    contentHash,
    ordinal: input.ordinal,
    span: candidate.span,
    tokenSpan: candidate.tokenSpan,
    chunkingStrategy: strategy
  });

  const maybeTokenSpan =
    candidate.tokenSpan === undefined ? {} : { tokenSpan: candidate.tokenSpan };
  const maybeMetadata =
    candidate.metadata === undefined ? {} : { metadata: candidate.metadata };

  return parseChunk({
    chunkId,
    documentId: document.id,
    corpusId: document.corpusId,
    tenantId: document.tenantId,
    class: document.class,
    sourceRef: document.sourceRef,
    sourceHash: document.sourceHash,
    contentHash,
    trustLabel: document.trustLabel,
    authority: document.authority,
    ordinal: input.ordinal,
    text: candidate.text,
    span: candidate.span,
    ...maybeTokenSpan,
    chunkingStrategy: strategy,
    retrievalRole: "advisory_data",
    ...maybeMetadata
  });
}
