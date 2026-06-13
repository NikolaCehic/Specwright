import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CapabilityDefinitionSchema,
  CapabilityRegistry,
  createToolBroker,
  deriveTierConstraints,
  type AdapterExecutionResult,
  type CapabilityDefinition
} from "@specwright/tool-broker";
import type { PolicyEvaluator } from "@specwright/tool-broker";
import { hashString } from "../hash";
import {
  BrokerRankedHitSchema,
  MEMORY_CAPABILITY_IDS,
  MemoryGetOutputSchema,
  MemoryIngestOutputSchema,
  MemoryForgetOutputSchema,
  MemorySearchOutputSchema,
  createMemoryCapabilityDefinitions,
  createMemoryPolicyBundle
} from "./index";
import * as publicBroker from "./index";
import {
  createMemoryBrokerRuntime,
  type MemoryBrokerRuntime,
  type MemoryRuntimeGrants
} from "./runtime";
import * as publicMemory from "../index";

const workspaceRoot = resolve(import.meta.dir, "../../..");
const tenantId = "tenant_acme";
const allowedCorpus = "semantic.allowed";
const otherCorpus = "semantic.other";
const secret = "sk-live-super-secret-token-123456789";

describe("memory broker capability declarations", () => {
  test("declares all memory capabilities as schema-complete tier-1 definitions", () => {
    const runtime = runtimeWithGrants();
    const definitions = createMemoryCapabilityDefinitions({ runtime, tenantId });
    const registry = new CapabilityRegistry(definitions);

    expect(definitions.map((definition) => definition.id).sort()).toEqual([
      ...MEMORY_CAPABILITY_IDS
    ].sort());
    expect(registry.list().map((definition) => definition.id)).toEqual([
      ...MEMORY_CAPABILITY_IDS
    ].sort());

    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    expect(byId.get("memory.ingest")?.kind).toBe("memory");
    expect(byId.get("memory.ingest")?.risk).toBe("high");
    expect(byId.get("memory.ingest")?.requestedScopes).toEqual([
      "memory:write",
      `memory:tenant:${tenantId}`
    ]);
    expect(byId.get("memory.search")?.cache).toEqual({ enabled: true });
    expect(byId.get("memory.search")?.requestedScopes).toEqual([
      "memory:read",
      `memory:tenant:${tenantId}`
    ]);
    expect(byId.get("embeddings.search")?.kind).toBe("embeddings");
    expect(byId.get("embeddings.search")?.requestedScopes).toEqual([
      "memory:read",
      "embeddings:read"
    ]);
    expect(byId.get("memory.get")?.risk).toBe("low");
    expect(byId.get("memory.get")?.requestedScopes).toEqual([
      "memory:read",
      `memory:tenant:${tenantId}`
    ]);
    expect(byId.get("memory.forget")?.cache).toEqual({ enabled: false });
    expect(byId.get("memory.forget")?.requestedScopes).toEqual([
      "memory:admin",
      `memory:tenant:${tenantId}`
    ]);

    for (const definition of definitions) {
      expect(CapabilityDefinitionSchema.safeParse(definition).success).toBe(
        true
      );
      expect(definition.isolationTier).toBe(1);
      expect(deriveTierConstraints(definition).execution).toBe("unsupported");
    }
  });

  test("current ToolBroker fails closed for tier-1 memory before adapter execution", async () => {
    const runtime = runtimeWithGrants();
    const definitions = createMemoryCapabilityDefinitions({ runtime, tenantId });
    const broker = createToolBroker({
      workspaceRoot,
      registry: new CapabilityRegistry(definitions),
      policyBundle: createMemoryPolicyBundle({
        tenantId,
        readCorpusIds: [allowedCorpus],
        writeCorpusIds: [allowedCorpus],
        adminCorpusIds: [allowedCorpus],
        allowHighRiskMutations: true
      })
    });
    const result = await broker.callTool(
      request("memory.search", {
        tenantId,
        corpusIds: [allowedCorpus],
        query: "runtime kernel"
      }),
      {
        traceId: "trace_memory_tier1_unsupported"
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("unsupported_isolation_tier");
    expect(runtime.innerCalls()).toBe(0);
  });

  test("broker policy deny and policy error fail before tier execution", async () => {
    const runtime = runtimeWithGrants();
    const definitions = createMemoryCapabilityDefinitions({ runtime, tenantId });
    const denied = await createToolBroker({
      workspaceRoot,
      registry: new CapabilityRegistry(definitions),
      policyBundle: {
        id: "memory.deny",
        description: "Deny memory search.",
        scopes: ["memory:read"],
        toolPolicy: {
          "memory.search": {
            default: "deny",
            reason: "Fixture denies memory search",
            requiredScopes: ["memory:read"],
            allowedScopes: ["memory:read"],
            allowedPhases: ["evidence"]
          }
        }
      }
    }).callTool(
      request("memory.search", {
        tenantId,
        corpusIds: [allowedCorpus],
        query: "runtime kernel"
      })
    );
    const throwingPolicy: PolicyEvaluator = () => {
      throw new Error("policy exploded");
    };
    const errored = await createToolBroker({
      workspaceRoot,
      registry: new CapabilityRegistry(definitions),
      policyEngine: throwingPolicy
    }).callTool(
      request("memory.search", {
        tenantId,
        corpusIds: [allowedCorpus],
        query: "runtime kernel"
      })
    );

    expect(denied.status).toBe("denied");
    expect(denied.error?.code).toBe("policy_denied");
    expect(errored.status).toBe("denied");
    expect(errored.error?.code).toBe("policy_error");
    expect(runtime.innerCalls()).toBe(0);
  });

  test("public broker entrypoint does not export direct runtime bypass helpers", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(publicBroker).sort()).not.toContain(
      "createMemoryBrokerRuntime"
    );
    expect(Object.keys(publicBroker).sort()).not.toContain("MemoryBrokerRuntime");
    expect(
      Object.keys(publicBroker).some((key) =>
        ["search", "get", "ingest", "forget"].includes(key)
      )
    ).toBe(false);
    for (const directKey of [
      "InMemoryChunkStore",
      "ingestDocument",
      "buildLexicalIndex",
      "retrieveLexical",
      "DenseRetriever",
      "DenseVectorIndexStore",
      "buildAndSwapDenseIndex",
      "rankHybridCandidates"
    ]) {
      expect(Object.keys(publicMemory)).not.toContain(directKey);
    }
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./broker",
      "./evals"
    ]);
    expect(packageJson.exports["./internal"]).toBeUndefined();
  });
});

describe("memory-owned capability enforcement", () => {
  test("denies out-of-grant corpus before inner memory operation", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    const before = runtime.innerCalls();
    const result = await execute(definitions.get("memory.search"), {
      tenantId,
      corpusIds: [otherCorpus],
      query: "runtime kernel"
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("corpus_unauthorized");
    expect(runtime.innerCalls()).toBe(before);
    expect(JSON.stringify(runtime.snapshot().events)).toContain(
      "memory.corpus_unauthorized"
    );
    expect(JSON.stringify(runtime.snapshot().events)).not.toContain(
      "strict runtime kernel"
    );
  });

  test("denies cross-tenant access without leaking content or existence", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    await successful(
      execute(definitions.get("memory.ingest"), ingestArgs("strict runtime kernel"))
    );
    const before = runtime.innerCalls();
    const result = await execute(definitions.get("memory.get"), {
      tenantId: "tenant_other",
      corpusId: allowedCorpus,
      documentId: "doc-1"
    });
    const eventText = JSON.stringify(runtime.snapshot().events);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("tenant_mismatch");
    expect(result.error?.message).not.toContain("doc-1");
    expect(result.error?.message).not.toContain("strict runtime kernel");
    expect(runtime.innerCalls()).toBe(before);
    expect(eventText).toContain("memory.tenant_isolation.denied");
    expect(eventText).not.toContain("strict runtime kernel");
  });

  test("redacts secrets before indexing and before any output/cache/audit exposure", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    const ingest = await successful(
      execute(
        definitions.get("memory.ingest"),
        ingestArgs(`deploy token ${secret} belongs in memory never`)
      )
    );
    const search = await successful(
      execute(definitions.get("memory.search"), {
        tenantId,
        corpusIds: [allowedCorpus],
        query: "deploy token"
      })
    );
    const get = await successful(
      execute(definitions.get("memory.get"), {
        tenantId,
        corpusId: allowedCorpus,
        documentId: "doc-1"
      })
    );
    const snapshot = runtime.snapshot();
    const allRuntimeText = JSON.stringify(snapshot);

    expect(MemoryIngestOutputSchema.parse(ingest.output).redactedFields).toBeGreaterThan(
      0
    );
    expect(MemorySearchOutputSchema.parse(search.output).hits.length).toBe(1);
    expect(MemoryGetOutputSchema.parse(get.output).found).toBe(true);
    expect(snapshot.chunks.map((chunk) => chunk.text).join("\n")).not.toContain(
      secret
    );
    expect(JSON.stringify(search.output)).not.toContain(secret);
    expect(JSON.stringify(get.output)).not.toContain(secret);
    expect(allRuntimeText).not.toContain(secret);
  });

  test("memory.search is hybrid and records canonical provenance plus result event", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    await successful(
      execute(
        definitions.get("memory.ingest"),
        ingestArgs("strict runtime kernel retrieval broker dense lexical hybrid")
      )
    );
    const search = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "runtime kernel hybrid",
          k: 3,
          fusion: {
            method: "rrf",
            weights: {
              bm25: 1,
              proximity: 0.5,
              dense: 1
            },
            rrfK: 60
          },
          diversify: {
            method: "mmr",
            lambda: 0.7
          }
        })
      )).output
    );
    const eventTypes = search.audit.events.map((event) => event.type);

    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0]?.scores.bm25).toBeNumber();
    expect(search.hits[0]?.scores.proximity).toBeNumber();
    expect(search.hits[0]?.scores.dense).toBeNumber();
    expect(search.hits[0]?.normalized.dense).toBeNumber();
    expect(search.hits[0]?.fusedScore).toBeNumber();
    expect(search.provenance.retrievers).toEqual([
      "bm25",
      "proximity",
      "dense"
    ]);
    expect(search.provenance.candidateSetSizes.dense).toBeGreaterThan(0);
    expect(search.provenance.fusion).toEqual({
      method: "rrf",
      weights: {
        bm25: 1,
        proximity: 0.5,
        dense: 1
      },
      rrfK: 60
    });
    expect(search.provenance.mmrLambda).toBe(0.7);
    expect(search.provenance.annParams.kind).toBe("hnsw");
    expect(search.provenance.toolCallId).toStartWith("tool.");
    expect(search.provenance.spanId).toBe(search.audit.span.id);
    expect(search.provenance.eventIds).toEqual(search.audit.span.eventIds);
    expect(eventTypes).toEqual([
      "tool.requested",
      "tool.authorized",
      "tool.executed",
      "memory.searched",
      "memory.result_recorded",
      "tool.completed"
    ]);
    expect(JSON.stringify(search.audit.events)).not.toContain(
      "strict runtime kernel retrieval broker"
    );
  });

  test("embeddings.search is dense-only and never exposes raw vectors", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    await successful(
      execute(
        definitions.get("memory.ingest"),
        ingestArgs("dense nearest neighbor runtime kernel vector broker")
      )
    );
    const dense = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("embeddings.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "runtime vector",
          k: 2
        })
      )).output
    );

    expect(dense.provenance.retrievers).toEqual(["dense"]);
    expect(dense.provenance.embeddingModelVersion).toBe("1.0.0");
    expect(dense.provenance.candidateSetSizes).toEqual({
      dense: expect.any(Number)
    });
    expect(dense.hits.length).toBeGreaterThan(0);
    expect(Object.keys(dense.hits[0]?.scores ?? {})).toEqual(["dense"]);
    expect(JSON.stringify(dense)).not.toContain("vectorHash");
  });

  test("retrieval redaction is profile-versioned and cache-safe", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    await successful(
      execute(
        definitions.get("memory.ingest"),
        ingestArgs("classified release checklist for runtime kernel")
      )
    );
    const first = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "release checklist",
          redactionProfileVersion: "standard"
        })
      )).output
    );
    const second = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "release checklist",
          redactionProfileVersion: "standard"
        })
      )).output
    );
    const tightened = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "release checklist",
          redactionProfileVersion: "tight"
        })
      )).output
    );

    expect(first.provenance.cacheStatus).toBe("miss");
    expect(second.provenance.cacheStatus).toBe("hit");
    expect(tightened.provenance.cacheStatus).toBe("miss");
    expect(first.hits[0]?.content).toContain("classified");
    expect(tightened.hits[0]?.content).not.toContain("classified");
    expect(tightened.hits[0]?.redactionProfileVersion).toBe("tight");
  });

  test("forget tombstones invalidate cache and suppress live retrieval and replay", async () => {
    const runtime = runtimeWithGrants();
    const definitions = definitionsById(runtime);
    await successful(
      execute(
        definitions.get("memory.ingest"),
        ingestArgs("runtime kernel subject alpha should be forgotten", {
          subjectId: "subject-alpha"
        })
      )
    );
    const beforeForget = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "subject alpha"
        })
      )).output
    );
    const chunkId = beforeForget.hits[0]?.chunkId;
    expect(typeof chunkId).toBe("string");
    const forget = await successful(
      execute(definitions.get("memory.forget"), {
        tenantId,
        corpusId: allowedCorpus,
        match: {
          documentId: "doc-1"
        },
        reason: "rtbf-request-1"
      })
    );
    const afterSearch = MemorySearchOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.search"), {
          tenantId,
          corpusIds: [allowedCorpus],
          query: "subject alpha"
        })
      )).output
    );
    const afterGet = MemoryGetOutputSchema.parse(
      (await successful(
        execute(definitions.get("memory.get"), {
          tenantId,
          corpusId: allowedCorpus,
          documentId: "doc-1"
        })
      )).output
    );
    const output = MemoryForgetOutputSchema.parse(forget.output);
    const forgetOutput = JSON.stringify(forget.output);

    expect(output.tombstoned).toBe(1);
    expect(output.cachesInvalidated).toBeGreaterThan(0);
    expect(forgetOutput).toContain("replaySuppression");
    expect(forgetOutput).toContain("suppressesReplay");
    expect(afterSearch.hits).toEqual([]);
    expect(afterSearch.provenance.cacheStatus).toBe("miss");
    expect(afterGet.found).toBe(false);
    expect(
      runtime.replaySuppressed({
        tenantId,
        corpusIds: [allowedCorpus],
        chunkId: chunkId as string
      })
    ).toBe(true);
  });

  test("output schemas reject malformed adapter projections", () => {
    expect(BrokerRankedHitSchema.safeParse({ chunkId: "missing" }).success).toBe(
      false
    );
    expect(MemorySearchOutputSchema.safeParse({ hits: [] }).success).toBe(false);
  });
});

function runtimeWithGrants(
  grants: Partial<MemoryRuntimeGrants> = {}
): MemoryBrokerRuntime {
  return createMemoryBrokerRuntime({
    grants: {
      tenantId,
      readCorpusIds: [allowedCorpus],
      writeCorpusIds: [allowedCorpus],
      adminCorpusIds: [allowedCorpus],
      ...grants
    }
  });
}

function definitionsById(runtime: MemoryBrokerRuntime) {
  return new Map(
    createMemoryCapabilityDefinitions({ runtime, tenantId }).map((definition) => [
      definition.id,
      definition
    ])
  );
}

function ingestArgs(content: string, metadata: Record<string, unknown> = {}) {
  return {
    tenantId,
    corpusId: allowedCorpus,
    documents: [
      {
        documentId: "doc-1",
        content,
        sourceRef: {
          path: "memory-fixture.md",
          contentHash: hashString(content),
          authority: "repo",
          redactionClass: "operator"
        },
        authority: "repo",
        trustLabel: "repo",
        metadata
      }
    ],
    chunking: {
      strategy: "fixed-overlap",
      config: {
        chunkSize: 24,
        overlap: 0
      }
    }
  };
}

function request(toolId: string, args: unknown) {
  return {
    toolId,
    args,
    reason: "memory broker packet 06 test",
    idempotencyKey: `memory:${toolId}:${JSON.stringify(args)}`,
    requestedBy: {
      phase: "evidence"
    }
  };
}

async function execute(
  definition: CapabilityDefinition | undefined,
  args: unknown
): Promise<AdapterExecutionResult> {
  expect(definition).toBeDefined();
  if (definition === undefined) {
    throw new Error("missing definition");
  }

  return definition.adapter.execute({
    args,
    runContext: {
      runId: "run_memory_packet_06",
      phase: "evidence",
      cwd: workspaceRoot,
      workspaceRoot,
      traceId: "trace_memory_packet_06"
    },
    limits: {
      timeoutMs: 1_000,
      maxBytes: 200_000,
      maxTokens: 8_192
    }
  });
}

async function successful(
  promise: Promise<AdapterExecutionResult>
): Promise<Extract<AdapterExecutionResult, { status: "success" }>> {
  const result = await promise;
  expect(result.status).toBe("success");
  if (result.status !== "success") {
    throw new Error(result.error.message);
  }

  return result;
}
