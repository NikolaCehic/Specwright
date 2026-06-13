import { z } from "zod";
import {
  CacheStatusSchema,
  MetadataSchema,
  SourceAuthoritySchema,
  SourceRefSchema
} from "@specwright/schemas";
import { MemoryClassSchema, TrustLabelSchema } from "../corpus";
import { Sha256HashSchema } from "../hash";
import {
  FixedOverlapChunkingConfigSchema,
  SemanticChunkingConfigSchema,
  StructuralChunkingConfigSchema
} from "../chunking";
import {
  MemoryProvenanceSchema as CanonicalMemoryProvenanceSchema,
  RankedHitSchema as CanonicalRankedHitSchema,
  RetrievalDiversifyConfigSchema,
  RetrievalFusionConfigSchema,
  RetrievalRerankConfigSchema,
  RetrieverNameSchema,
  type MemoryProvenance as CanonicalMemoryProvenance,
  type RankedHit as CanonicalRankedHit
} from "../ranking/contracts";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);

export const MEMORY_CAPABILITY_IDS = [
  "memory.ingest",
  "memory.search",
  "embeddings.search",
  "memory.get",
  "memory.forget"
] as const;
export const MemoryCapabilityIdSchema = z.enum(MEMORY_CAPABILITY_IDS);
export type MemoryCapabilityId = z.infer<typeof MemoryCapabilityIdSchema>;

export const RedactionProfileVersionSchema = nonEmptyString.default("standard");

export const MemoryCorpusIdListSchema = z
  .array(nonEmptyString)
  .min(1)
  .transform((corpusIds) => [...new Set(corpusIds)].sort());

export const MemoryFixedChunkingInputSchema = z
  .object({
    strategy: z.literal("fixed-overlap"),
    config: FixedOverlapChunkingConfigSchema.default({
      chunkSize: 80,
      overlap: 0
    })
  })
  .strict();

export const MemoryStructuralChunkingInputSchema = z
  .object({
    strategy: z.literal("structural"),
    config: StructuralChunkingConfigSchema.default({
      parserVersion: "1.0.0",
      granularity: "block"
    })
  })
  .strict();

export const MemorySemanticChunkingInputSchema = z
  .object({
    strategy: z.literal("semantic"),
    config: SemanticChunkingConfigSchema.default({
      boundaryModelId: "specwright-topic-shift",
      boundaryModelVersion: "1.0.0",
      threshold: 0.76,
      minChunkSize: 80,
      maxChunkSize: 240
    })
  })
  .strict();

export const MemoryChunkingInputSchema = z.discriminatedUnion("strategy", [
  MemoryFixedChunkingInputSchema,
  MemoryStructuralChunkingInputSchema,
  MemorySemanticChunkingInputSchema
]);
export type MemoryChunkingInput = z.infer<typeof MemoryChunkingInputSchema>;

export const MemoryIngestDocumentInputSchema = z
  .object({
    documentId: nonEmptyString,
    content: nonEmptyString,
    sourceRef: SourceRefSchema,
    authority: SourceAuthoritySchema,
    trustLabel: TrustLabelSchema,
    class: MemoryClassSchema.default("semantic"),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type MemoryIngestDocumentInput = z.infer<
  typeof MemoryIngestDocumentInputSchema
>;

export const MemoryIngestInputSchema = z
  .object({
    tenantId: nonEmptyString,
    corpusId: nonEmptyString,
    documents: z.array(MemoryIngestDocumentInputSchema).min(1),
    chunking: MemoryChunkingInputSchema.default({
      strategy: "fixed-overlap",
      config: {
        chunkSize: 80,
        overlap: 0
      }
    }),
    redactionProfileVersion: RedactionProfileVersionSchema
  })
  .strict();
export type MemoryIngestInput = z.infer<typeof MemoryIngestInputSchema>;

export const MemorySearchInputSchema = z
  .object({
    tenantId: nonEmptyString,
    corpusIds: MemoryCorpusIdListSchema,
    query: nonEmptyString,
    k: z.number().int().min(0).max(100).default(8),
    maxCandidates: z.number().int().min(0).max(1000).default(200),
    retrievers: z.array(RetrieverNameSchema).min(1).default([
      "bm25",
      "proximity",
      "dense"
    ]),
    fusion: RetrievalFusionConfigSchema.default({}),
    rerank: RetrievalRerankConfigSchema.default({}),
    diversify: RetrievalDiversifyConfigSchema.default({}),
    confidenceFloor: z.number().finite().optional(),
    redactionProfileVersion: RedactionProfileVersionSchema
  })
  .strict();
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const EmbeddingsSearchInputSchema = MemorySearchInputSchema.extend({
  embeddingModelVersion: nonEmptyString.default("1.0.0"),
  retrievers: z.array(z.literal("dense")).min(1).default(["dense"])
}).strict();
export type EmbeddingsSearchInput = z.infer<
  typeof EmbeddingsSearchInputSchema
>;

export const MemoryGetInputSchema = z
  .object({
    tenantId: nonEmptyString,
    corpusId: nonEmptyString,
    documentId: nonEmptyString.optional(),
    chunkId: nonEmptyString.optional(),
    redactionProfileVersion: RedactionProfileVersionSchema
  })
  .strict()
  .superRefine((input, context) => {
    if (input.documentId === undefined && input.chunkId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "memory.get requires documentId or chunkId"
      });
    }
  });
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;

export const MemoryForgetMatchSchema = z
  .object({
    documentId: nonEmptyString.optional(),
    chunkId: nonEmptyString.optional(),
    subjectId: nonEmptyString.optional()
  })
  .strict()
  .superRefine((match, context) => {
    if (
      match.documentId === undefined &&
      match.chunkId === undefined &&
      match.subjectId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "memory.forget match requires documentId, chunkId, or subjectId"
      });
    }
  });
export type MemoryForgetMatch = z.infer<typeof MemoryForgetMatchSchema>;

export const MemoryForgetInputSchema = z
  .object({
    tenantId: nonEmptyString,
    corpusId: nonEmptyString,
    match: MemoryForgetMatchSchema,
    mode: z.enum(["delete", "redact"]).default("delete"),
    reason: nonEmptyString,
    redactionProfileVersion: RedactionProfileVersionSchema
  })
  .strict();
export type MemoryForgetInput = z.infer<typeof MemoryForgetInputSchema>;

export const MemoryRedactionRecordSchema = z
  .object({
    path: nonEmptyString,
    classification: nonEmptyString,
    hash: Sha256HashSchema
  })
  .strict();
export type MemoryRedactionRecord = z.infer<
  typeof MemoryRedactionRecordSchema
>;

export const MemoryEventSchema = z
  .object({
    id: nonEmptyString,
    type: nonEmptyString,
    toolId: MemoryCapabilityIdSchema.optional(),
    tenantId: nonEmptyString.optional(),
    corpusIds: z.array(nonEmptyString).optional(),
    documentIds: z.array(nonEmptyString).optional(),
    chunkIds: z.array(nonEmptyString).optional(),
    queryHash: Sha256HashSchema.optional(),
    redactionProfileVersion: nonEmptyString.optional(),
    status: nonEmptyString.optional(),
    errorCode: nonEmptyString.optional(),
    securitySignal: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

export const MemorySpanSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal("tool"),
    status: z.enum(["success", "failed", "denied", "approval_required"]),
    eventIds: z.array(nonEmptyString),
    metadata: MetadataSchema
  })
  .strict();
export type MemorySpan = z.infer<typeof MemorySpanSchema>;

export const MemoryOperationAuditSchema = z
  .object({
    events: z.array(MemoryEventSchema),
    span: MemorySpanSchema,
    redactions: z.array(MemoryRedactionRecordSchema),
    securitySignals: z.array(MemoryEventSchema)
  })
  .strict();
export type MemoryOperationAudit = z.infer<typeof MemoryOperationAuditSchema>;

export const BrokerRankedHitSchema = CanonicalRankedHitSchema.extend({
  corpusId: nonEmptyString,
  tenantId: nonEmptyString,
  contentHash: Sha256HashSchema,
  content: z.string(),
  redactionProfileVersion: nonEmptyString
}).strict();
export type BrokerRankedHit = z.infer<typeof BrokerRankedHitSchema>;
export type BrokerRankedHitInput = CanonicalRankedHit & {
  readonly corpusId: string;
  readonly tenantId: string;
  readonly contentHash: string;
  readonly content: string;
  readonly redactionProfileVersion: string;
};

export const MemoryBrokerProvenanceSchema =
  CanonicalMemoryProvenanceSchema.extend({
    tenantId: nonEmptyString,
    toolId: MemoryCapabilityIdSchema,
    toolVersion: nonEmptyString,
    adapterVersion: nonEmptyString,
    toolCallId: nonEmptyString,
    traceId: nonEmptyString,
    spanId: nonEmptyString,
    eventIds: z.array(nonEmptyString),
    policyDecisionHash: Sha256HashSchema,
    policyStatus: nonEmptyString,
    cacheKeyHash: Sha256HashSchema.optional(),
    tombstoneIds: z.array(nonEmptyString),
    replaySuppression: z.boolean()
  }).strict();
export type MemoryBrokerProvenance = z.infer<
  typeof MemoryBrokerProvenanceSchema
>;
export type MemoryBrokerProvenanceInput = CanonicalMemoryProvenance & {
  readonly tenantId: string;
  readonly toolId: MemoryCapabilityId;
  readonly toolVersion: string;
  readonly adapterVersion: string;
  readonly toolCallId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly eventIds: readonly string[];
  readonly policyDecisionHash: string;
  readonly policyStatus: string;
  readonly cacheKeyHash?: string;
  readonly tombstoneIds: readonly string[];
  readonly replaySuppression: boolean;
};

export const MemoryIngestOutputSchema = z
  .object({
    ingested: nonNegativeInteger,
    chunks: nonNegativeInteger,
    indexVersion: Sha256HashSchema,
    redactedFields: nonNegativeInteger,
    cacheInvalidated: nonNegativeInteger,
    provenance: MemoryBrokerProvenanceSchema,
    audit: MemoryOperationAuditSchema
  })
  .strict();
export type MemoryIngestOutput = z.infer<typeof MemoryIngestOutputSchema>;

export const MemorySearchOutputSchema = z
  .object({
    queryHash: Sha256HashSchema,
    hits: z.array(BrokerRankedHitSchema),
    provenance: MemoryBrokerProvenanceSchema,
    audit: MemoryOperationAuditSchema
  })
  .strict();
export type MemorySearchOutput = z.infer<typeof MemorySearchOutputSchema>;

export const EmbeddingsSearchOutputSchema = MemorySearchOutputSchema;
export type EmbeddingsSearchOutput = MemorySearchOutput;

export const MemoryGetOutputSchema = z
  .object({
    found: z.boolean(),
    documentId: nonEmptyString.optional(),
    chunkId: nonEmptyString.optional(),
    corpusId: nonEmptyString,
    tenantId: nonEmptyString,
    content: z.string().optional(),
    sourceRef: SourceRefSchema.optional(),
    sourceHash: Sha256HashSchema.optional(),
    contentHash: Sha256HashSchema.optional(),
    redactionProfileVersion: nonEmptyString,
    cacheStatus: CacheStatusSchema,
    provenance: MemoryBrokerProvenanceSchema,
    audit: MemoryOperationAuditSchema
  })
  .strict();
export type MemoryGetOutput = z.infer<typeof MemoryGetOutputSchema>;

export const MemoryForgetOutputSchema = z
  .object({
    tombstoned: nonNegativeInteger,
    chunksRemoved: nonNegativeInteger,
    cachesInvalidated: nonNegativeInteger,
    indexVersion: Sha256HashSchema,
    tombstoneIds: z.array(nonEmptyString),
    replaySuppression: z
      .object({
        tombstoneIds: z.array(nonEmptyString),
        suppressedChunkIds: z.array(nonEmptyString),
        suppressesReplay: z.literal(true)
      })
      .strict(),
    provenance: MemoryBrokerProvenanceSchema,
    audit: MemoryOperationAuditSchema
  })
  .strict();
export type MemoryForgetOutput = z.infer<typeof MemoryForgetOutputSchema>;
