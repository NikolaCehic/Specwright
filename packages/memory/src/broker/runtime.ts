import type { AdapterExecutionResult } from "@specwright/tool-broker";
import type { SourceRef } from "@specwright/schemas";
import type { Chunk } from "../chunk";
import { DEFAULT_HNSW_ANN_PARAMS } from "../dense-contracts";
import type { MemoryDocument } from "../document";
import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderRegistry
} from "../embedding";
import { MemoryError } from "../errors";
import { hashString, hashValue, type Sha256Hash } from "../hash";
import { chunkDocument } from "../chunking";
import { buildLexicalIndex, retrieveLexical } from "../lexical";
import type { LexicalRetrievalResult } from "../lexical";
import { rankHybridCandidates } from "../ranking";
import type {
  MemoryProvenance,
  RankedHit,
  RetrievalQueryInput
} from "../ranking";
import { DenseRetriever, retrieveDense } from "../retrieval";
import type { DenseRetrievalResult } from "../dense-contracts";
import { DenseVectorIndexStore, buildAndSwapDenseIndex } from "../vector";
import {
  MemoryGetOutputSchema,
  MemoryIngestOutputSchema,
  MemorySearchOutputSchema,
  MemoryForgetOutputSchema,
  MemoryBrokerProvenanceSchema,
  type BrokerRankedHit,
  type EmbeddingsSearchInput,
  type MemoryCapabilityId,
  type MemoryEvent,
  type MemoryForgetInput,
  type MemoryGetInput,
  type MemoryIngestInput,
  type MemoryOperationAudit,
  type MemoryRedactionRecord,
  type MemorySearchInput,
  type MemorySpan
} from "./schemas";
import {
  rawSecretPresent,
  redactForIngest,
  redactForRetrieval,
  type MemoryRedactionProfile
} from "./redaction";

type MemoryOperation = "read" | "write" | "admin";
type CacheEntry = {
  readonly toolId: MemoryCapabilityId;
  readonly key: string;
  readonly output: unknown;
  readonly tenantId: string;
  readonly corpusIds: readonly string[];
  readonly chunkIds: readonly string[];
  readonly redactionProfileVersion: string;
};
type StoredDocument = {
  readonly document: MemoryDocument;
  readonly chunks: readonly Chunk[];
  readonly originalContentHash: Sha256Hash;
  readonly redactionProfileVersion: string;
  readonly redactions: readonly MemoryRedactionRecord[];
};
type Tombstone = {
  readonly tombstoneId: string;
  readonly tenantId: string;
  readonly corpusId: string;
  readonly documentIds: readonly string[];
  readonly chunkIds: readonly string[];
  readonly reason: string;
  readonly mode: "delete" | "redact";
  readonly createdAt: string;
};
type OperationAuditDraft = {
  readonly toolId: MemoryCapabilityId;
  readonly tenantId: string;
  readonly corpusIds: readonly string[];
  readonly redactionProfileVersion: string;
  readonly startedEventIds: readonly string[];
};

export type MemoryRuntimeGrants = {
  readonly tenantId: string;
  readonly readCorpusIds?: readonly string[];
  readonly writeCorpusIds?: readonly string[];
  readonly adminCorpusIds?: readonly string[];
};

export type MemoryBrokerRuntimeOptions = {
  readonly grants: MemoryRuntimeGrants;
  readonly profiles?: readonly MemoryRedactionProfile[];
  readonly now?: () => Date;
};

export type MemoryRuntimeSnapshot = {
  readonly documents: readonly StoredDocument[];
  readonly chunks: readonly Chunk[];
  readonly tombstones: readonly Tombstone[];
  readonly events: readonly MemoryEvent[];
  readonly spans: readonly MemorySpan[];
  readonly cacheEntryCount: number;
};

const DEFAULT_PROFILE: MemoryRedactionProfile = {
  version: "standard"
};
const MEMORY_RUNTIME_TOOL_VERSION = "0.11.6";
const MEMORY_RUNTIME_ADAPTER_VERSION = "0.11.6";

export class MemoryBrokerRuntime {
  private readonly grants: MemoryRuntimeGrants;
  private readonly profiles = new Map<string, MemoryRedactionProfile>();
  private readonly now: () => Date;
  private readonly embeddingProvider = new DeterministicLocalEmbeddingProvider();
  private readonly embeddingRegistry = new EmbeddingProviderRegistry();
  private denseStore = new DenseVectorIndexStore();
  private readonly documentsById = new Map<string, StoredDocument>();
  private readonly chunksById = new Map<string, Chunk>();
  private readonly tombstonesById = new Map<string, Tombstone>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly events: MemoryEvent[] = [];
  private readonly spans: MemorySpan[] = [];
  private innerOperationCount = 0;

  constructor(options: MemoryBrokerRuntimeOptions) {
    this.grants = options.grants;
    this.now = options.now ?? (() => new Date());
    this.profiles.set(DEFAULT_PROFILE.version, DEFAULT_PROFILE);
    this.embeddingRegistry.register(this.embeddingProvider);

    for (const profile of options.profiles ?? []) {
      this.profiles.set(profile.version, profile);
    }
  }

  innerCalls() {
    return this.innerOperationCount;
  }

  snapshot(): MemoryRuntimeSnapshot {
    return {
      documents: [...this.documentsById.values()],
      chunks: [...this.chunksById.values()].sort(compareChunks),
      tombstones: [...this.tombstonesById.values()].sort((left, right) =>
        left.tombstoneId.localeCompare(right.tombstoneId)
      ),
      events: [...this.events],
      spans: [...this.spans],
      cacheEntryCount: this.cache.size
    };
  }

  async ingest(input: MemoryIngestInput): Promise<AdapterExecutionResult> {
    try {
      const audit = this.startAudit("memory.ingest", input.tenantId, [
        input.corpusId
      ], input.redactionProfileVersion);
      const denied = this.authorize({
        toolId: "memory.ingest",
        tenantId: input.tenantId,
        corpusIds: [input.corpusId],
        operation: "write",
        audit
      });
      if (denied !== undefined) {
        return denied;
      }

      const profile = this.profile(input.redactionProfileVersion);
      const stored: StoredDocument[] = [];
      const allRedactions: MemoryRedactionRecord[] = [];

      for (const [index, documentInput] of input.documents.entries()) {
        const redacted = redactForIngest(
          documentInput.content,
          profile,
          `documents.${index}.content`
        );
        if (redacted.blocked) {
          return this.failure({
            toolId: "memory.ingest",
            code: "unsafe_input",
            message: "Memory ingest input matched a blocked redaction profile.",
            audit,
            redactions: redacted.redactions
          });
        }

        allRedactions.push(...redacted.redactions);
        const document: MemoryDocument = {
          id: documentInput.documentId,
          corpusId: input.corpusId,
          tenantId: input.tenantId,
          class: documentInput.class,
          sourceRef: redactedSourceRef(documentInput.sourceRef, redacted.text),
          sourceHash: hashString(redacted.text),
          authority: documentInput.authority,
          trustLabel: documentInput.trustLabel,
          content: redacted.text,
          ingestTimestamp: this.now().toISOString(),
          ...(documentInput.metadata === undefined
            ? {}
            : { metadata: documentInput.metadata })
        };
        const chunks = chunkDocument({
          document,
          strategyId: input.chunking.strategy,
          config: input.chunking.config
        });
        stored.push({
          document,
          chunks,
          originalContentHash: hashString(documentInput.content),
          redactionProfileVersion: profile.version,
          redactions: redacted.redactions
        });
      }

      this.innerOperationCount += 1;
      for (const entry of stored) {
        this.documentsById.set(entry.document.id, entry);
        for (const chunk of entry.chunks) {
          this.chunksById.set(chunk.chunkId, chunk);
        }
      }
      await this.rebuildDenseIndex(input.tenantId);

      const invalidated = this.invalidateCorpus(input.tenantId, input.corpusId);
      const chunks = stored.flatMap((entry) => [...entry.chunks]);
      const indexVersion = this.indexVersion(input.tenantId, [input.corpusId]);
      const output = MemoryIngestOutputSchema.parse({
        ingested: stored.length,
        chunks: chunks.length,
        indexVersion,
        redactedFields: allRedactions.length,
        cacheInvalidated: invalidated,
        provenance: this.provenance({
          toolId: "memory.ingest",
          tenantId: input.tenantId,
          corpusIds: [input.corpusId],
          indexVersion,
          redactionProfileVersion: profile.version,
          cacheStatus: "bypass",
          tombstoneIds: []
        }),
        audit: this.completeAudit({
          audit,
          status: "success",
          memoryEventType: "memory.ingested",
          redactions: allRedactions,
          documentIds: stored.map((entry) => entry.document.id),
          chunkIds: chunks.map((chunk) => chunk.chunkId),
          metadata: {
            redactedFields: allRedactions.length,
            cacheInvalidated: invalidated
          }
        })
      });

      return {
        status: "success",
        output,
        metrics: {
          durationMs: 0
        }
      };
    } catch (error) {
      return failureFromUnknown(error);
    }
  }

  async search(
    input: MemorySearchInput,
    toolId: "memory.search" | "embeddings.search" = "memory.search"
  ): Promise<AdapterExecutionResult> {
    try {
      const audit = this.startAudit(
        toolId,
        input.tenantId,
        input.corpusIds,
        input.redactionProfileVersion
      );
      const denied = this.authorize({
        toolId,
        tenantId: input.tenantId,
        corpusIds: input.corpusIds,
        operation: "read",
        audit
      });
      if (denied !== undefined) {
        return denied;
      }

      const cacheKey = this.cacheKey(toolId, input);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        const cachedOutput = withSearchCacheStatus(cached.output, "hit");
        const output = MemorySearchOutputSchema.parse(cachedOutput);
        const cacheAudit = this.completeAudit({
          audit,
          status: "success",
          memoryEventType: "memory.searched",
          resultRecorded: {
            hits: output.hits,
            provenance: output.provenance,
            queryHash: output.queryHash
          },
          redactions: output.audit.redactions,
          chunkIds: output.hits.map((hit) => hit.chunkId),
          queryHash: output.queryHash,
          metadata: {
            cacheStatus: "hit",
            hitCount: output.hits.length
          }
        });
        const provenance = this.provenance({
          base: output.provenance,
          toolId,
          tenantId: input.tenantId,
          corpusIds: input.corpusIds,
          redactionProfileVersion: input.redactionProfileVersion,
          cacheStatus: "hit",
          queryHash: output.queryHash,
          tombstoneIds: this.tombstoneIdsFor(input.tenantId, input.corpusIds),
          cacheKeyHash: cacheKey,
          audit: cacheAudit
        });
        return {
          status: "success",
          output: MemorySearchOutputSchema.parse({
            ...output,
            provenance,
            audit: cacheAudit
          }),
          metrics: {
            durationMs: 0
          }
        };
      }

      this.innerOperationCount += 1;
      const profile = this.profile(input.redactionProfileVersion);
      const chunks = this.visibleChunks(input.tenantId, input.corpusIds);
      const lexical = this.retrieveLexical({
        input,
        chunks,
        cacheStatus: "miss",
        includeLexical:
          toolId === "memory.search" &&
          input.retrievers.some(
            (retriever) => retriever === "bm25" || retriever === "proximity"
          )
      });
      const dense = await this.retrieveDense({
        input,
        chunks,
        cacheStatus: "miss",
        includeDense: input.retrievers.includes("dense")
      });
      const retrieval = await rankHybridCandidates({
        query: this.retrievalQuery(input, toolId),
        ...(lexical === undefined ? {} : { lexical }),
        ...(dense === undefined ? {} : { dense })
      });
      const decorated = this.decorateRankedHits({
        hits: retrieval.hits,
        chunks,
        profile
      });
      const redactions = decorated.flatMap((hit) => hit.redactions);
      const provisionalProvenance = this.provenance({
        base: retrieval.provenance,
        toolId,
        tenantId: input.tenantId,
        corpusIds: input.corpusIds,
        redactionProfileVersion: profile.version,
        cacheStatus: "miss",
        queryHash: retrieval.queryHash,
        tombstoneIds: this.tombstoneIdsFor(input.tenantId, input.corpusIds),
        cacheKeyHash: cacheKey
      });
      const auditResult = this.completeAudit({
        audit,
        status: "success",
        memoryEventType: "memory.searched",
        resultRecorded: {
          hits: decorated.map((hit) => hit.hit),
          provenance: provisionalProvenance,
          queryHash: retrieval.queryHash
        },
        redactions,
        chunkIds: decorated.map((hit) => hit.hit.chunkId),
        queryHash: retrieval.queryHash,
        metadata: {
          cacheStatus: "miss",
          hitCount: decorated.length,
          retrievers: retrieval.provenance.retrievers,
          candidateSetSizes: retrieval.provenance.candidateSetSizes,
          fusion: retrieval.provenance.fusion,
          rerankModel: retrieval.provenance.rerankModel ?? "not_applicable",
          mmrLambda: retrieval.provenance.mmrLambda
        }
      });
      const output = MemorySearchOutputSchema.parse({
        queryHash: retrieval.queryHash,
        hits: decorated.map((hit) => hit.hit),
        provenance: this.provenance({
          base: retrieval.provenance,
          toolId,
          tenantId: input.tenantId,
          corpusIds: input.corpusIds,
          redactionProfileVersion: profile.version,
          cacheStatus: "miss",
          queryHash: retrieval.queryHash,
          tombstoneIds: this.tombstoneIdsFor(input.tenantId, input.corpusIds),
          cacheKeyHash: cacheKey,
          audit: auditResult
        }),
        audit: auditResult
      });

      this.cache.set(cacheKey, {
        toolId,
        key: cacheKey,
        output,
        tenantId: input.tenantId,
        corpusIds: input.corpusIds,
        chunkIds: output.hits.map((hit) => hit.chunkId),
        redactionProfileVersion: profile.version
      });

      return {
        status: "success",
        output,
        metrics: {
          durationMs: 0
        }
      };
    } catch (error) {
      return failureFromUnknown(error);
    }
  }

  async get(input: MemoryGetInput): Promise<AdapterExecutionResult> {
    try {
      const audit = this.startAudit(
        "memory.get",
        input.tenantId,
        [input.corpusId],
        input.redactionProfileVersion
      );
      const denied = this.authorize({
        toolId: "memory.get",
        tenantId: input.tenantId,
        corpusIds: [input.corpusId],
        operation: "read",
        audit
      });
      if (denied !== undefined) {
        return denied;
      }

      const cacheKey = this.cacheKey("memory.get", input);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        const cachedOutput = withGetCacheStatus(cached.output, "hit");
        const output = MemoryGetOutputSchema.parse(cachedOutput);
        return {
          status: "success",
          output: {
            ...output,
            audit: this.completeAudit({
              audit,
              status: "success",
              memoryEventType: "memory.result_recorded",
              redactions: output.audit.redactions,
              chunkIds: output.chunkId === undefined ? [] : [output.chunkId],
              metadata: {
                cacheStatus: "hit"
              }
            })
          },
          metrics: {
            durationMs: 0
          }
        };
      }

      this.innerOperationCount += 1;
      const profile = this.profile(input.redactionProfileVersion);
      const found = this.findVisible(input);
      const redacted =
        found === undefined
          ? { text: undefined, redactions: [] as MemoryRedactionRecord[] }
          : redactForRetrieval(found.content, profile, "memory.get.content");
      const indexVersion = this.indexVersion(input.tenantId, [input.corpusId]);
      const output = MemoryGetOutputSchema.parse({
        found: found !== undefined,
        ...(found === undefined
          ? {}
          : {
              documentId: found.documentId,
              chunkId: found.chunkId,
              content: redacted.text,
              sourceRef: found.sourceRef,
              sourceHash: found.sourceHash,
              contentHash: hashString(redacted.text ?? "")
            }),
        corpusId: input.corpusId,
        tenantId: input.tenantId,
        redactionProfileVersion: profile.version,
        cacheStatus: "miss",
        provenance: this.provenance({
          toolId: "memory.get",
          tenantId: input.tenantId,
          corpusIds: [input.corpusId],
          indexVersion,
          redactionProfileVersion: profile.version,
          cacheStatus: "miss",
          tombstoneIds: this.tombstoneIdsFor(input.tenantId, [input.corpusId])
        }),
        audit: this.completeAudit({
          audit,
          status: "success",
          memoryEventType: "memory.result_recorded",
          redactions: redacted.redactions,
          chunkIds: found?.chunkId === undefined ? [] : [found.chunkId],
          documentIds: found?.documentId === undefined ? [] : [found.documentId],
          metadata: {
            cacheStatus: "miss",
            found: found !== undefined
          }
        })
      });

      this.cache.set(cacheKey, {
        toolId: "memory.get",
        key: cacheKey,
        output,
        tenantId: input.tenantId,
        corpusIds: [input.corpusId],
        chunkIds: output.chunkId === undefined ? [] : [output.chunkId],
        redactionProfileVersion: profile.version
      });

      return {
        status: "success",
        output,
        metrics: {
          durationMs: 0
        }
      };
    } catch (error) {
      return failureFromUnknown(error);
    }
  }

  async forget(input: MemoryForgetInput): Promise<AdapterExecutionResult> {
    try {
      const audit = this.startAudit(
        "memory.forget",
        input.tenantId,
        [input.corpusId],
        input.redactionProfileVersion
      );
      const denied = this.authorize({
        toolId: "memory.forget",
        tenantId: input.tenantId,
        corpusIds: [input.corpusId],
        operation: "admin",
        audit
      });
      if (denied !== undefined) {
        return denied;
      }

      const targets = this.findForgetTargets(input);
      if (targets.chunkIds.length === 0 && targets.documentIds.length === 0) {
        return this.failure({
          toolId: "memory.forget",
          code: "missing_tombstone_state",
          message: "memory.forget did not resolve any in-grant subject to tombstone.",
          audit,
          redactions: []
        });
      }

      this.innerOperationCount += 1;
      const tombstoneId = hashValue({
        tenantId: input.tenantId,
        corpusId: input.corpusId,
        match: input.match,
        reason: input.reason,
        chunkIds: targets.chunkIds
      });
      const tombstone: Tombstone = {
        tombstoneId,
        tenantId: input.tenantId,
        corpusId: input.corpusId,
        documentIds: targets.documentIds,
        chunkIds: targets.chunkIds,
        reason: input.reason,
        mode: input.mode,
        createdAt: this.now().toISOString()
      };
      this.tombstonesById.set(tombstone.tombstoneId, tombstone);
      await this.rebuildDenseIndex(input.tenantId);

      const invalidated = this.invalidateCorpus(input.tenantId, input.corpusId);
      const indexVersion = this.indexVersion(input.tenantId, [input.corpusId]);
      const output = MemoryForgetOutputSchema.parse({
        tombstoned: 1,
        chunksRemoved: targets.chunkIds.length,
        cachesInvalidated: invalidated,
        indexVersion,
        tombstoneIds: [tombstoneId],
        replaySuppression: {
          tombstoneIds: [tombstoneId],
          suppressedChunkIds: targets.chunkIds,
          suppressesReplay: true
        },
        provenance: this.provenance({
          toolId: "memory.forget",
          tenantId: input.tenantId,
          corpusIds: [input.corpusId],
          indexVersion,
          redactionProfileVersion: input.redactionProfileVersion,
          cacheStatus: "bypass",
          tombstoneIds: [tombstoneId],
          replaySuppression: true
        }),
        audit: this.completeAudit({
          audit,
          status: "success",
          memoryEventType: "memory.forgotten",
          redactions: [],
          chunkIds: targets.chunkIds,
          documentIds: targets.documentIds,
          metadata: {
            tombstoneIds: [tombstoneId],
            cacheInvalidated: invalidated,
            suppressesReplay: true
          }
        })
      });

      return {
        status: "success",
        output,
        metrics: {
          durationMs: 0
        }
      };
    } catch (error) {
      return failureFromUnknown(error);
    }
  }

  replaySuppressed(input: {
    readonly tenantId: string;
    readonly corpusIds: readonly string[];
    readonly chunkId: string;
  }): boolean {
    return this.tombstonesFor(input.tenantId, input.corpusIds).some((tombstone) =>
      tombstone.chunkIds.includes(input.chunkId)
    );
  }

  private authorize(input: {
    readonly toolId: MemoryCapabilityId;
    readonly tenantId: string;
    readonly corpusIds: readonly string[];
    readonly operation: MemoryOperation;
    readonly audit: OperationAuditDraft;
  }): AdapterExecutionResult | undefined {
    if (input.tenantId !== this.grants.tenantId) {
      return this.failure({
        toolId: input.toolId,
        code: "tenant_mismatch",
        message: "Memory capability request is outside the authorized tenant.",
        audit: input.audit,
        redactions: [],
        securitySignal: "memory.tenant_isolation.denied"
      });
    }

    const allowed = this.allowedCorpusIds(input.operation);
    const unauthorized = input.corpusIds.filter(
      (corpusId) => !allowed.has(corpusId)
    );
    if (unauthorized.length > 0) {
      return this.failure({
        toolId: input.toolId,
        code: "corpus_unauthorized",
        message: "Memory capability request includes a corpus outside the grant.",
        audit: input.audit,
        redactions: [],
        securitySignal: "memory.corpus_unauthorized"
      });
    }

    return undefined;
  }

  private allowedCorpusIds(operation: MemoryOperation): ReadonlySet<string> {
    const values =
      operation === "read"
        ? this.grants.readCorpusIds
        : operation === "write"
          ? this.grants.writeCorpusIds
          : this.grants.adminCorpusIds;
    return new Set(values ?? []);
  }

  private profile(version: string): MemoryRedactionProfile {
    return this.profiles.get(version) ?? {
      version,
      additionalPatterns: version === "tight" ? [/\bclassified\b/gi] : []
    };
  }

  private startAudit(
    toolId: MemoryCapabilityId,
    tenantId: string,
    corpusIds: readonly string[],
    redactionProfileVersion: string
  ): OperationAuditDraft {
    const event = this.event({
      type: "tool.requested",
      toolId,
      tenantId,
      corpusIds: [...corpusIds],
      redactionProfileVersion,
      status: "requested"
    });
    return {
      toolId,
      tenantId,
      corpusIds: [...corpusIds],
      redactionProfileVersion,
      startedEventIds: [event.id]
    };
  }

  private completeAudit(input: {
    readonly audit: OperationAuditDraft;
    readonly status: "success" | "failed" | "denied";
    readonly memoryEventType: string;
    readonly redactions: readonly MemoryRedactionRecord[];
    readonly documentIds?: readonly string[];
    readonly chunkIds?: readonly string[];
    readonly queryHash?: Sha256Hash;
    readonly errorCode?: string;
    readonly securitySignal?: string;
    readonly metadata?: Record<string, unknown>;
    readonly resultRecorded?: {
      readonly hits: readonly BrokerRankedHit[];
      readonly provenance: unknown;
      readonly queryHash: Sha256Hash;
    };
  }): MemoryOperationAudit {
    const authorizedOrDenied =
      input.status === "success"
        ? this.event({
            type: "tool.authorized",
            toolId: input.audit.toolId,
            tenantId: input.audit.tenantId,
            corpusIds: [...input.audit.corpusIds],
            redactionProfileVersion: input.audit.redactionProfileVersion,
            status: "allow"
          })
        : this.event({
            type: "tool.denied",
            toolId: input.audit.toolId,
            tenantId: input.audit.tenantId,
            corpusIds: [...input.audit.corpusIds],
            redactionProfileVersion: input.audit.redactionProfileVersion,
            status: input.status,
            ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
            ...(input.securitySignal === undefined
              ? {}
              : { securitySignal: input.securitySignal })
          });
    const executed =
      input.status === "success"
        ? this.event({
            type: "tool.executed",
            toolId: input.audit.toolId,
            tenantId: input.audit.tenantId,
            corpusIds: [...input.audit.corpusIds],
            ...(input.queryHash === undefined ? {} : { queryHash: input.queryHash }),
            redactionProfileVersion: input.audit.redactionProfileVersion,
            status: "executed"
          })
        : undefined;
    const memoryEvent = this.event({
      type: input.memoryEventType,
      toolId: input.audit.toolId,
      tenantId: input.audit.tenantId,
      corpusIds: [...input.audit.corpusIds],
      ...(input.documentIds === undefined
        ? {}
        : { documentIds: [...input.documentIds] }),
      ...(input.chunkIds === undefined ? {} : { chunkIds: [...input.chunkIds] }),
      ...(input.queryHash === undefined ? {} : { queryHash: input.queryHash }),
      redactionProfileVersion: input.audit.redactionProfileVersion,
      status: input.status,
      ...(input.errorCode === undefined
        ? {}
        : { errorCode: input.errorCode }),
      ...(input.securitySignal === undefined
        ? {}
        : { securitySignal: input.securitySignal }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata })
    });
    const resultRecorded =
      input.resultRecorded === undefined
        ? undefined
        : this.event({
            type: "memory.result_recorded",
            toolId: input.audit.toolId,
            tenantId: input.audit.tenantId,
            corpusIds: [...input.audit.corpusIds],
            chunkIds: input.resultRecorded.hits.map((hit) => hit.chunkId),
            queryHash: input.resultRecorded.queryHash,
            redactionProfileVersion: input.audit.redactionProfileVersion,
            status: input.status,
            metadata: {
              hits: input.resultRecorded.hits.map((hit) => ({
                chunkId: hit.chunkId,
                documentId: hit.documentId,
                corpusId: hit.corpusId,
                tenantId: hit.tenantId,
                sourceRef: hit.sourceRef,
                sourceHash: hit.sourceHash,
                scores: hit.scores,
                normalized: hit.normalized,
                fusedScore: hit.fusedScore,
                ...(hit.rerankScore === undefined
                  ? {}
                  : { rerankScore: hit.rerankScore }),
                rank: hit.rank,
                trustLabel: hit.trustLabel,
                injectionFlag: hit.injectionFlag,
                contentHash: hit.contentHash,
                redactionProfileVersion: hit.redactionProfileVersion
              })),
              provenance: input.resultRecorded.provenance
            }
    });
    const terminal = this.event({
      type:
        input.status === "success"
          ? "tool.completed"
          : input.status === "denied"
            ? "tool.denied"
            : "tool.failed",
      toolId: input.audit.toolId,
      tenantId: input.audit.tenantId,
      corpusIds: [...input.audit.corpusIds],
      ...(input.documentIds === undefined
        ? {}
        : { documentIds: [...input.documentIds] }),
      ...(input.chunkIds === undefined ? {} : { chunkIds: [...input.chunkIds] }),
      ...(input.queryHash === undefined ? {} : { queryHash: input.queryHash }),
      redactionProfileVersion: input.audit.redactionProfileVersion,
      status: input.status,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.securitySignal === undefined
        ? {}
        : { securitySignal: input.securitySignal })
    });
    const eventIds = [
      ...input.audit.startedEventIds,
      authorizedOrDenied.id,
      ...(executed === undefined ? [] : [executed.id]),
      memoryEvent.id,
      ...(resultRecorded === undefined ? [] : [resultRecorded.id]),
      terminal.id
    ];
    const span = {
      id: `span.${hashValue({ eventIds }).slice("sha256:".length, "sha256:".length + 16)}`,
      kind: "tool",
      status: input.status,
      eventIds,
      metadata: {
        toolId: input.audit.toolId,
        tenantId: input.audit.tenantId,
        corpusIds: input.audit.corpusIds,
        redactionProfileVersion: input.audit.redactionProfileVersion,
        status: input.status,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.metadata === undefined ? {} : input.metadata)
      }
    } satisfies MemorySpan;
    this.spans.push(span);

    const events = eventIds
      .map((eventId) => this.events.find((event) => event.id === eventId))
      .filter((event): event is MemoryEvent => event !== undefined);
    const securitySignals = events.filter(
      (event) => event.securitySignal !== undefined
    );

    return {
      events,
      span,
      redactions: [...input.redactions],
      securitySignals
    };
  }

  private failure(input: {
    readonly toolId: MemoryCapabilityId;
    readonly code: string;
    readonly message: string;
    readonly audit: OperationAuditDraft;
    readonly redactions: readonly MemoryRedactionRecord[];
    readonly securitySignal?: string;
  }): AdapterExecutionResult {
    this.completeAudit({
      audit: input.audit,
      status: "failed",
      memoryEventType: "memory.failed",
      redactions: input.redactions,
      errorCode: input.code,
      ...(input.securitySignal === undefined
        ? {}
        : { securitySignal: input.securitySignal })
    });
    return {
      status: "failed",
      error: {
        code: input.code,
        message: sanitize(input.message),
        retryable: false
      }
    };
  }

  private event(input: Omit<MemoryEvent, "id">): MemoryEvent {
    const event = {
      id: `evt.${this.events.length + 1}.${hashValue(input).slice("sha256:".length, "sha256:".length + 12)}`,
      ...input
    };
    this.events.push(event);
    return event;
  }

  private async rebuildDenseIndex(tenantId: string): Promise<void> {
    const chunks = this.visibleChunksForTenant(tenantId);
    this.denseStore = new DenseVectorIndexStore();
    if (chunks.length === 0) {
      return;
    }

    await buildAndSwapDenseIndex({
      store: this.denseStore,
      chunks,
      provider: this.embeddingProvider,
      indexId: `idx.dense.${tenantId}`
    });
  }

  private visibleChunksForTenant(tenantId: string): Chunk[] {
    const corpusIds = [
      ...new Set(
        [...this.chunksById.values()]
          .filter((chunk) => chunk.tenantId === tenantId)
          .map((chunk) => chunk.corpusId)
      )
    ];
    return this.visibleChunks(tenantId, corpusIds);
  }

  private visibleChunks(
    tenantId: string,
    corpusIds: readonly string[]
  ): Chunk[] {
    const tombstoned = new Set(
      this.tombstonesFor(tenantId, corpusIds).flatMap((tombstone) =>
        tombstone.chunkIds
      )
    );
    return [...this.chunksById.values()]
      .filter(
        (chunk) =>
          chunk.tenantId === tenantId &&
          corpusIds.includes(chunk.corpusId) &&
          !tombstoned.has(chunk.chunkId)
      )
      .sort(compareChunks);
  }

  private retrieveLexical(input: {
    readonly input: MemorySearchInput;
    readonly chunks: readonly Chunk[];
    readonly cacheStatus: "hit" | "miss" | "bypass";
    readonly includeLexical: boolean;
  }): LexicalRetrievalResult | undefined {
    if (
      !input.includeLexical ||
      input.chunks.length === 0 ||
      input.input.k === 0 ||
      input.input.maxCandidates === 0
    ) {
      return undefined;
    }

    const index = buildLexicalIndex({ chunks: input.chunks });
    return retrieveLexical(index, {
      text: input.input.query,
      k: Math.min(input.input.k, input.input.maxCandidates),
      maxCandidates: input.input.maxCandidates,
      filters: {
        tenantIds: [input.input.tenantId],
        corpusIds: input.input.corpusIds
      },
      cacheStatus: input.cacheStatus
    });
  }

  private async retrieveDense(input: {
    readonly input: MemorySearchInput;
    readonly chunks: readonly Chunk[];
    readonly cacheStatus: "hit" | "miss" | "bypass";
    readonly includeDense: boolean;
  }): Promise<DenseRetrievalResult | undefined> {
    if (
      !input.includeDense ||
      input.chunks.length === 0 ||
      input.input.k === 0 ||
      input.input.maxCandidates === 0 ||
      this.denseStore.liveIndexVersion() === undefined
    ) {
      return undefined;
    }

    return retrieveDense(
      new DenseRetriever({
        indexStore: this.denseStore,
        providerRegistry: this.embeddingRegistry
      }),
      {
        text: input.input.query,
        k: Math.min(input.input.k, input.input.maxCandidates),
        maxCandidates: input.input.maxCandidates,
        filters: {
          tenantIds: [input.input.tenantId],
          corpusIds: input.input.corpusIds
        },
        cacheStatus: input.cacheStatus
      }
    );
  }

  private retrievalQuery(
    input: MemorySearchInput,
    toolId: "memory.search" | "embeddings.search"
  ): RetrievalQueryInput {
    return {
      tenantId: input.tenantId,
      corpusIds: input.corpusIds,
      query: input.query,
      k: input.k,
      retrievers: toolId === "embeddings.search" ? ["dense"] : input.retrievers,
      fusion: input.fusion,
      rerank: input.rerank,
      diversify: input.diversify,
      ...(input.confidenceFloor === undefined
        ? {}
        : { confidenceFloor: input.confidenceFloor }),
      redactionProfileVersion: input.redactionProfileVersion
    };
  }

  private decorateRankedHits(input: {
    readonly hits: readonly RankedHit[];
    readonly chunks: readonly Chunk[];
    readonly profile: MemoryRedactionProfile;
  }): Array<{ hit: BrokerRankedHit; redactions: MemoryRedactionRecord[] }> {
    const chunksById = new Map(input.chunks.map((chunk) => [chunk.chunkId, chunk]));
    return input.hits.map((hit, index) => {
      const chunk = chunksById.get(hit.chunkId);
      if (chunk === undefined) {
        throw new MemoryError({
          code: "index_corrupt",
          field: "chunkId",
          condition: hit.chunkId,
          message: `Missing chunk ${hit.chunkId}`
        });
      }

      const redacted = redactForRetrieval(
        chunk.text,
        input.profile,
        `hits.${index}.content`
      );
      return {
        hit: {
          ...hit,
          corpusId: chunk.corpusId,
          tenantId: chunk.tenantId,
          contentHash: hashString(redacted.text),
          content: redacted.text,
          injectionFlag: hit.injectionFlag || injectionPattern(chunk.text),
          redactionProfileVersion: input.profile.version
        },
        redactions: redacted.redactions
      };
    });
  }

  private findVisible(input: MemoryGetInput):
    | {
        readonly documentId: string;
        readonly chunkId?: string;
        readonly content: string;
        readonly sourceRef: Chunk["sourceRef"];
        readonly sourceHash: Sha256Hash;
      }
    | undefined {
    const tombstoned = new Set(
      this.tombstonesFor(input.tenantId, [input.corpusId]).flatMap((tombstone) =>
        tombstone.chunkIds
      )
    );

    if (input.chunkId !== undefined) {
      const chunk = this.chunksById.get(input.chunkId);
      if (
        chunk === undefined ||
        chunk.tenantId !== input.tenantId ||
        chunk.corpusId !== input.corpusId ||
        tombstoned.has(chunk.chunkId)
      ) {
        return undefined;
      }

      return {
        documentId: chunk.documentId,
        chunkId: chunk.chunkId,
        content: chunk.text,
        sourceRef: chunk.sourceRef,
        sourceHash: chunk.sourceHash
      };
    }

    if (input.documentId !== undefined) {
      const stored = this.documentsById.get(input.documentId);
      if (
        stored === undefined ||
        stored.document.tenantId !== input.tenantId ||
        stored.document.corpusId !== input.corpusId ||
        stored.chunks.every((chunk) => tombstoned.has(chunk.chunkId))
      ) {
        return undefined;
      }

      return {
        documentId: stored.document.id,
        content: stored.chunks
          .filter((chunk) => !tombstoned.has(chunk.chunkId))
          .sort(compareChunks)
          .map((chunk) => chunk.text)
          .join("\n"),
        sourceRef: stored.document.sourceRef,
        sourceHash: stored.document.sourceHash
      };
    }

    return undefined;
  }

  private findForgetTargets(input: MemoryForgetInput): {
    readonly documentIds: string[];
    readonly chunkIds: string[];
  } {
    const documentIds = new Set<string>();
    const chunkIds = new Set<string>();

    if (input.match.documentId !== undefined) {
      const stored = this.documentsById.get(input.match.documentId);
      if (
        stored !== undefined &&
        stored.document.tenantId === input.tenantId &&
        stored.document.corpusId === input.corpusId
      ) {
        documentIds.add(stored.document.id);
        for (const chunk of stored.chunks) {
          chunkIds.add(chunk.chunkId);
        }
      }
    }

    if (input.match.chunkId !== undefined) {
      const chunk = this.chunksById.get(input.match.chunkId);
      if (
        chunk !== undefined &&
        chunk.tenantId === input.tenantId &&
        chunk.corpusId === input.corpusId
      ) {
        chunkIds.add(chunk.chunkId);
        documentIds.add(chunk.documentId);
      }
    }

    if (input.match.subjectId !== undefined) {
      for (const stored of this.documentsById.values()) {
        if (
          stored.document.tenantId === input.tenantId &&
          stored.document.corpusId === input.corpusId &&
          stored.document.metadata?.subjectId === input.match.subjectId
        ) {
          documentIds.add(stored.document.id);
          for (const chunk of stored.chunks) {
            chunkIds.add(chunk.chunkId);
          }
        }
      }
    }

    const alreadyTombstoned = new Set(
      this.tombstonesFor(input.tenantId, [input.corpusId]).flatMap((tombstone) =>
        tombstone.chunkIds
      )
    );
    return {
      documentIds: [...documentIds].sort(),
      chunkIds: [...chunkIds]
        .filter((chunkId) => !alreadyTombstoned.has(chunkId))
        .sort()
    };
  }

  private tombstonesFor(
    tenantId: string,
    corpusIds: readonly string[]
  ): Tombstone[] {
    return [...this.tombstonesById.values()].filter(
      (tombstone) =>
        tombstone.tenantId === tenantId && corpusIds.includes(tombstone.corpusId)
    );
  }

  private tombstoneIdsFor(
    tenantId: string,
    corpusIds: readonly string[]
  ): string[] {
    return this.tombstonesFor(tenantId, corpusIds)
      .map((tombstone) => tombstone.tombstoneId)
      .sort();
  }

  private indexVersion(tenantId: string, corpusIds: readonly string[]): Sha256Hash {
    const chunks = this.visibleChunks(tenantId, corpusIds);
    const tombstones = this.tombstoneIdsFor(tenantId, corpusIds);
    return hashValue({
      tenantId,
      corpusIds: [...corpusIds].sort(),
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        sourceHash: chunk.sourceHash,
        contentHash: chunk.contentHash,
        chunkingStrategy: chunk.chunkingStrategy
      })),
      tombstones
    });
  }

  private provenance(input: {
    readonly base?: MemoryProvenance;
    readonly toolId?: MemoryCapabilityId;
    readonly tenantId: string;
    readonly corpusIds: readonly string[];
    readonly indexVersion?: Sha256Hash;
    readonly redactionProfileVersion: string;
    readonly cacheStatus: "hit" | "miss" | "bypass";
    readonly queryHash?: Sha256Hash;
    readonly tombstoneIds: readonly string[];
    readonly replaySuppression?: boolean;
    readonly retrievers?: readonly ("bm25" | "proximity" | "dense")[];
    readonly embeddingModelVersion?: string;
    readonly cacheKeyHash?: Sha256Hash;
    readonly audit?: MemoryOperationAudit;
  }) {
    const toolId = input.toolId ?? "memory.search";
    const firstChunk = this.visibleChunks(input.tenantId, input.corpusIds)[0];
    const indexVersion =
      input.indexVersion ?? this.indexVersion(input.tenantId, input.corpusIds);
    const queryHash =
      input.queryHash ??
      hashValue({
        toolId,
        tenantId: input.tenantId,
        corpusIds: input.corpusIds,
        indexVersion
      });
    const base =
      input.base ??
      ({
        corpusIds: [...input.corpusIds].sort(),
        indexId: `memory.${input.tenantId}.${hashValue(input.corpusIds).slice("sha256:".length, "sha256:".length + 12)}`,
        indexVersion,
        embeddingProvider: this.embeddingProvider.descriptor.provider,
        embeddingModel: this.embeddingProvider.descriptor.model,
        embeddingModelVersion:
          input.embeddingModelVersion ??
          this.embeddingProvider.descriptor.modelVersion,
        embeddingDims: this.embeddingProvider.descriptor.dims,
        distanceMetric: this.embeddingProvider.descriptor.distanceMetric,
        chunkingStrategy: firstChunk?.chunkingStrategy.id ?? "none",
        chunkingStrategyVersion:
          firstChunk?.chunkingStrategy.version ??
          hashValue({ empty: true, corpusIds: input.corpusIds }),
        retrievers: [...(input.retrievers ?? ["bm25", "proximity", "dense"])],
        candidateSetSizes: {
          bm25: 0,
          proximity: 0,
          dense: 0
        },
        normalizationMode: "rank_based",
        fusion: {
          method: "rrf",
          weights: {
            bm25: 1,
            proximity: 1,
            dense: 1
          },
          rrfK: 60
        },
        rerankSkipped: true,
        degraded: [],
        mmrLambda: 0.7,
        mmrSimilarityMetric: "metadata_source_similarity_v1",
        annParams: DEFAULT_HNSW_ANN_PARAMS,
        redactionProfileVersion: input.redactionProfileVersion,
        cacheStatus: input.cacheStatus,
        queryHash,
        emptyResult: false,
        redactionSafe: true
      } satisfies MemoryProvenance);
    const eventIds = input.audit?.span.eventIds ?? [];
    const spanId =
      input.audit?.span.id ??
      `span.${hashValue({ toolId, queryHash }).slice("sha256:".length, "sha256:".length + 16)}`;

    return MemoryBrokerProvenanceSchema.parse({
      ...base,
      tenantId: input.tenantId,
      redactionProfileVersion: input.redactionProfileVersion,
      cacheStatus: input.cacheStatus,
      queryHash,
      toolId,
      toolVersion: MEMORY_RUNTIME_TOOL_VERSION,
      adapterVersion: MEMORY_RUNTIME_ADAPTER_VERSION,
      toolCallId: `tool.${hashValue({ toolId, queryHash, eventIds }).slice("sha256:".length, "sha256:".length + 16)}`,
      traceId: `trace.${input.tenantId}`,
      spanId,
      eventIds,
      policyDecisionHash: hashValue({
        toolId,
        tenantId: input.tenantId,
        corpusIds: [...input.corpusIds].sort(),
        status: input.audit?.span.status ?? "allow"
      }),
      policyStatus: input.audit?.span.status ?? "allow",
      ...(input.cacheKeyHash === undefined
        ? {}
        : { cacheKeyHash: input.cacheKeyHash }),
      tombstoneIds: [...input.tombstoneIds].sort(),
      replaySuppression: input.replaySuppression ?? input.tombstoneIds.length > 0
    });
  }

  private cacheKey(toolId: MemoryCapabilityId, input: unknown) {
    return hashValue({
      toolId,
      input,
      indexVersion:
        typeof input === "object" &&
        input !== null &&
        "tenantId" in input &&
        "corpusIds" in input &&
        Array.isArray((input as { corpusIds?: unknown }).corpusIds)
          ? this.indexVersion(
              (input as { tenantId: string }).tenantId,
              (input as { corpusIds: string[] }).corpusIds
            )
          : undefined
    });
  }

  private invalidateCorpus(tenantId: string, corpusId: string) {
    const before = this.cache.size;
    for (const [key, entry] of this.cache) {
      if (entry.tenantId === tenantId && entry.corpusIds.includes(corpusId)) {
        this.cache.delete(key);
      }
    }

    return before - this.cache.size;
  }
}

export function createMemoryBrokerRuntime(
  options: MemoryBrokerRuntimeOptions
): MemoryBrokerRuntime {
  return new MemoryBrokerRuntime(options);
}

function normalizeQuery(query: string) {
  return query.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function compareChunks(left: Chunk, right: Chunk) {
  return (
    left.documentId.localeCompare(right.documentId) ||
    left.ordinal - right.ordinal ||
    left.chunkId.localeCompare(right.chunkId)
  );
}

function injectionPattern(text: string) {
  return /\b(ignore|override|developer|system)\b.{0,40}\b(instruction|tool|approval|shell)\b/iu.test(
    text
  );
}

function sanitize(message: string) {
  return rawSecretPresent(message)
    ? "Memory capability failed with redacted details."
    : message;
}

function redactedSourceRef(
  sourceRef: SourceRef,
  redactedContent: string
): SourceRef {
  if (typeof sourceRef === "string") {
    return sourceRef;
  }

  return {
    ...sourceRef,
    contentHash: hashString(redactedContent)
  };
}

function failureFromUnknown(error: unknown): AdapterExecutionResult {
  const message =
    error instanceof Error ? sanitize(error.message) : "Memory adapter failed.";
  return {
    status: "failed",
    error: {
      code: error instanceof MemoryError ? error.code : "adapter_error",
      message,
      retryable: false
    }
  };
}

function withSearchCacheStatus(output: unknown, cacheStatus: "hit" | "miss") {
  const parsed = MemorySearchOutputSchema.parse(output);
  return {
    ...parsed,
    hits: parsed.hits.map((hit) => ({
      ...hit,
      cacheStatus
    })),
    provenance: {
      ...parsed.provenance,
      cacheStatus
    }
  };
}

function withGetCacheStatus(output: unknown, cacheStatus: "hit" | "miss") {
  const parsed = MemoryGetOutputSchema.parse(output);
  return {
    ...parsed,
    cacheStatus,
    provenance: {
      ...parsed.provenance,
      cacheStatus
    }
  };
}
