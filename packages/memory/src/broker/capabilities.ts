import {
  DEFAULT_TOOL_TIMEOUT_MS,
  isolationTierForKind,
  type CapabilityAdapter,
  type CapabilityDefinition
} from "@specwright/tool-broker";
import {
  EmbeddingsSearchInputSchema,
  EmbeddingsSearchOutputSchema,
  MemoryForgetInputSchema,
  MemoryForgetOutputSchema,
  MemoryGetInputSchema,
  MemoryGetOutputSchema,
  MemoryIngestInputSchema,
  MemoryIngestOutputSchema,
  MemorySearchInputSchema,
  MemorySearchOutputSchema
} from "./schemas";
import type { MemoryBrokerRuntime } from "./runtime";
import { createMemoryBrokerRuntime } from "./runtime";

export const MEMORY_CAPABILITY_VERSION = "0.11.6";
export const MEMORY_ADAPTER_VERSION = "0.11.6";

export type CreateMemoryCapabilityDefinitionsOptions = {
  readonly runtime?: MemoryBrokerRuntime;
  readonly tenantId?: string;
};

export function createMemoryCapabilityDefinitions(
  options: CreateMemoryCapabilityDefinitionsOptions = {}
): CapabilityDefinition[] {
  const tenantId = options.tenantId ?? "tenant_default";
  const runtime =
    options.runtime ??
    createMemoryBrokerRuntime({
      grants: {
        tenantId,
        readCorpusIds: [],
        writeCorpusIds: [],
        adminCorpusIds: []
      }
    });
  const tenantScope = `memory:tenant:${tenantId}`;

  return [
    {
      id: "memory.ingest",
      kind: "memory",
      description:
        "Ingest redacted tenant-scoped documents into governed harness memory.",
      version: MEMORY_CAPABILITY_VERSION,
      inputSchema: MemoryIngestInputSchema,
      outputSchema: MemoryIngestOutputSchema,
      adapter: adapter("adapters/memory/ingest", "memory", (args) =>
        runtime.ingest(MemoryIngestInputSchema.parse(args))
      ),
      risk: "high",
      requestedScopes: ["memory:write", tenantScope],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: 200_000,
        maxTokens: 8_192
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("memory")
    },
    {
      id: "memory.search",
      kind: "memory",
      description:
        "Search governed harness memory with tenant/corpus isolation and retrieval redaction.",
      version: MEMORY_CAPABILITY_VERSION,
      inputSchema: MemorySearchInputSchema,
      outputSchema: MemorySearchOutputSchema,
      adapter: adapter("adapters/memory/search", "memory", (args) =>
        runtime.search(MemorySearchInputSchema.parse(args), "memory.search")
      ),
      risk: "medium",
      requestedScopes: ["memory:read", tenantScope],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: 200_000,
        maxTokens: 8_192
      },
      cache: {
        enabled: true
      },
      isolationTier: isolationTierForKind("memory")
    },
    {
      id: "embeddings.search",
      kind: "embeddings",
      description:
        "Search tenant-scoped embedding memory without returning raw vectors.",
      version: MEMORY_CAPABILITY_VERSION,
      inputSchema: EmbeddingsSearchInputSchema,
      outputSchema: EmbeddingsSearchOutputSchema,
      adapter: adapter("adapters/embeddings/search", "embeddings", (args) =>
        runtime.search(
          EmbeddingsSearchInputSchema.parse(args),
          "embeddings.search"
        )
      ),
      risk: "medium",
      requestedScopes: ["memory:read", "embeddings:read"],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: 200_000,
        maxTokens: 8_192
      },
      cache: {
        enabled: true
      },
      isolationTier: isolationTierForKind("embeddings")
    },
    {
      id: "memory.get",
      kind: "memory",
      description:
        "Fetch a governed tenant-scoped memory document or chunk by id.",
      version: MEMORY_CAPABILITY_VERSION,
      inputSchema: MemoryGetInputSchema,
      outputSchema: MemoryGetOutputSchema,
      adapter: adapter("adapters/memory/get", "memory", (args) =>
        runtime.get(MemoryGetInputSchema.parse(args))
      ),
      risk: "low",
      requestedScopes: ["memory:read", tenantScope],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: 200_000,
        maxTokens: 8_192
      },
      cache: {
        enabled: true
      },
      isolationTier: isolationTierForKind("memory")
    },
    {
      id: "memory.forget",
      kind: "memory",
      description:
        "Tombstone governed harness memory so live retrieval and replay suppress it.",
      version: MEMORY_CAPABILITY_VERSION,
      inputSchema: MemoryForgetInputSchema,
      outputSchema: MemoryForgetOutputSchema,
      adapter: adapter("adapters/memory/forget", "memory", (args) =>
        runtime.forget(MemoryForgetInputSchema.parse(args))
      ),
      risk: "high",
      requestedScopes: ["memory:admin", tenantScope],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: 200_000,
        maxTokens: 8_192
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("memory")
    }
  ];
}

function adapter(
  id: string,
  kind: CapabilityAdapter["kind"],
  executeArgs: (args: unknown) => ReturnType<CapabilityAdapter["execute"]>
): CapabilityAdapter {
  return {
    id,
    version: MEMORY_ADAPTER_VERSION,
    kind,
    execute(input) {
      return executeArgs(input.args);
    }
  };
}
