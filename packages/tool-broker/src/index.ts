import { createHash, randomUUID } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { evaluatePolicy } from "@specwright/policy-engine";
import type {
  FixturePolicyBundle,
  PolicyRequest,
  PolicyRisk,
  PolicyVerdict
} from "@specwright/policy-engine";
import {
  ToolCallRequestSchema,
  ToolCallResultSchema,
  type CacheStatus,
  type ToolCallRequest,
  type ToolCallResult
} from "@specwright/schemas";
import { z, type ZodTypeAny } from "zod";

declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(timeoutId: unknown): void;

export const TOOL_BROKER_VERSION = "0.1.0";
export const FILESYSTEM_ADAPTER_VERSION = "0.1.0";
export const DEFAULT_FS_READ_MAX_BYTES = 200_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

const toolPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "Path cannot contain null bytes.");

export const FsListInputSchema = z
  .object({
    path: toolPathSchema
  })
  .strict();
export type FsListInput = z.infer<typeof FsListInputSchema>;

export const FsListEntrySchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(["file", "directory", "symlink", "other"])
  })
  .strict();
export type FsListEntry = z.infer<typeof FsListEntrySchema>;

export const FsListOutputSchema = z
  .object({
    path: z.string().min(1),
    entries: z.array(FsListEntrySchema)
  })
  .strict();
export type FsListOutput = z.infer<typeof FsListOutputSchema>;

export const FsReadInputSchema = z
  .object({
    path: toolPathSchema,
    encoding: z.literal("utf8").optional(),
    maxBytes: z.number().int().positive().optional()
  })
  .strict();
export type FsReadInput = z.infer<typeof FsReadInputSchema>;

export const FsReadOutputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.literal("utf8"),
    bytesRead: z.number().int().nonnegative(),
    truncated: z.boolean()
  })
  .strict();
export type FsReadOutput = z.infer<typeof FsReadOutputSchema>;

export const CAPABILITY_KINDS = [
  "filesystem",
  "git",
  "browser",
  "model",
  "embeddings",
  "memory",
  "cache",
  "shell",
  "mcp",
  "network",
  "human"
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const ISOLATION_TIERS = [0, 1, 2, 3, 4] as const;
export type IsolationTier = (typeof ISOLATION_TIERS)[number];

export const CAPABILITY_KIND_ISOLATION_TIERS = Object.freeze({
  filesystem: 0,
  git: 0,
  browser: 4,
  model: 1,
  embeddings: 1,
  memory: 1,
  cache: 1,
  shell: 3,
  mcp: 4,
  network: 4,
  human: 4
} as const satisfies Record<CapabilityKind, IsolationTier>);

export function isolationTierForKind(kind: CapabilityKind): IsolationTier {
  return CAPABILITY_KIND_ISOLATION_TIERS[kind];
}

export type NetworkAllowlist = "deny_all" | readonly string[];
export type SubprocessPosture = "forbidden" | "sandboxed";
export type WriteConfinementPosture =
  | "none"
  | "workspace_readonly"
  | "workspace_staged";
export type TierExecutionPosture = "sanctioned" | "unsupported";

export type TierConstraintSet = {
  isolationTier: IsolationTier;
  deadlineMs: number;
  maxBytes?: number;
  maxTokens?: number;
  networkAllowlist: NetworkAllowlist;
  subprocess: SubprocessPosture;
  writeConfinement: WriteConfinementPosture;
  execution: TierExecutionPosture;
  unsupportedReason?: string;
};

export type AdapterStatus = "success" | "failed";

export type AdapterError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type AdapterMetrics = {
  durationMs?: number;
  bytesRead?: number;
  bytesWritten?: number;
  tokensIn?: number;
  tokensOut?: number;
};

export type AdapterExecutionLimits = {
  timeoutMs: number;
  maxBytes?: number;
  maxTokens?: number;
};

export type AdapterExecutionInput = {
  args: unknown;
  runContext: {
    runId: string;
    phase: string;
    cwd: string;
    workspaceRoot: string;
    traceId: string;
  };
  limits: AdapterExecutionLimits;
};

export type AdapterExecutionResult =
  | {
      status: "success";
      output: unknown;
      metrics?: AdapterMetrics;
    }
  | {
      status: "failed";
      error: AdapterError;
      metrics?: AdapterMetrics;
    };

export type CapabilityAdapter = {
  id: string;
  version: string;
  kind: CapabilityKind;
  execute(input: AdapterExecutionInput): Promise<AdapterExecutionResult>;
};

export type CapabilityLimits = {
  timeoutMs?: number;
  maxBytes?: number;
  maxTokens?: number;
};

export type CapabilityDefinition = {
  id: string;
  kind: CapabilityKind;
  description: string;
  version: string;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  adapter: CapabilityAdapter;
  risk: PolicyRisk;
  requestedScopes: string[];
  limits: CapabilityLimits;
  cache: {
    enabled: boolean;
  };
  isolationTier: IsolationTier;
};

export type ToolCacheMetadata = {
  sourceHashes?: Record<string, string>;
  harnessSpecHash?: string;
  modelVersion?: string;
};

export type ToolCacheKeyInputs = {
  toolId: string;
  toolVersion: string;
  argsHash: string;
  harnessSpecHash: string;
  sourceHashes?: Record<string, string>;
  modelVersion?: string;
};

export type ToolCacheProvenance = {
  status: CacheStatus;
  key?: string;
  keyInputs?: ToolCacheKeyInputs;
  entryCreatedAt?: string;
  invalidationReason?: string;
  writeError?: string;
};

export type ToolResultCacheEntry = {
  key: string;
  keyInputs: ToolCacheKeyInputs;
  output: unknown;
  resultHash: string;
  adapterVersion: string;
  createdAt: string;
  redactionSummary?: RedactionSummary;
};

export type ToolResultCacheStore = {
  get(
    key: string
  ): Promise<ToolResultCacheEntry | undefined> | ToolResultCacheEntry | undefined;
  set(entry: ToolResultCacheEntry): Promise<void> | void;
};

export class InMemoryToolResultCacheStore implements ToolResultCacheStore {
  private readonly entries = new Map<string, ToolResultCacheEntry>();

  get(key: string) {
    return cloneCacheEntry(this.entries.get(key));
  }

  set(entry: ToolResultCacheEntry) {
    this.entries.set(entry.key, cloneCacheEntry(entry) ?? entry);
  }
}

const CapabilityKindSchema = z.enum(CAPABILITY_KINDS);
const IsolationTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4)
]);
const PolicyRiskSchema = z.enum(["low", "medium", "high", "critical"]);
const NonEmptyStringSchema = z.string().min(1);
const ZodTypeSchema = z.custom<ZodTypeAny>(isZodType, {
  message: "Expected a Zod schema."
});
const CapabilityLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional()
  })
  .strict();
const CapabilityCacheSchema = z
  .object({
    enabled: z.boolean()
  })
  .strict();
const CapabilityAdapterSchema = z
  .object({
    id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    kind: CapabilityKindSchema,
    execute: z.custom<CapabilityAdapter["execute"]>(
      (value) => typeof value === "function",
      {
        message: "Expected adapter execute function."
      }
    )
  })
  .strict();

export const CapabilityDefinitionSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: CapabilityKindSchema,
    description: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    inputSchema: ZodTypeSchema,
    outputSchema: ZodTypeSchema,
    adapter: CapabilityAdapterSchema,
    risk: PolicyRiskSchema,
    requestedScopes: z.array(NonEmptyStringSchema).nonempty(),
    limits: CapabilityLimitsSchema,
    cache: CapabilityCacheSchema,
    isolationTier: IsolationTierSchema
  })
  .strict();

export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();

  constructor(definitions: readonly CapabilityDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: CapabilityDefinition) {
    assertValidCapabilityDefinition(definition);

    if (this.definitions.has(definition.id)) {
      throw new ToolBrokerError(
        "duplicate_tool",
        `Tool ${definition.id} is already registered.`
      );
    }

    this.definitions.set(definition.id, definition);
    return this;
  }

  resolve(toolId: string) {
    return this.definitions.get(toolId);
  }

  list() {
    return [...this.definitions.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }
}

export type CreateDefaultCapabilityRegistryOptions = {
  fsListAdapter?: CapabilityAdapter;
  fsReadAdapter?: CapabilityAdapter;
};

export function createDefaultCapabilityRegistry(
  options: CreateDefaultCapabilityRegistryOptions = {}
) {
  const fsListAdapter = options.fsListAdapter ?? createFsListAdapter();
  const fsReadAdapter = options.fsReadAdapter ?? createFsReadAdapter();

  return new CapabilityRegistry([
    {
      id: "fs.list",
      kind: "filesystem",
      description: "List entries below a path in the configured workspace.",
      version: "0.1.0",
      inputSchema: FsListInputSchema,
      outputSchema: FsListOutputSchema,
      adapter: fsListAdapter,
      risk: "low",
      requestedScopes: ["workspace:read"],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("filesystem")
    },
    {
      id: "fs.read",
      kind: "filesystem",
      description: "Read a UTF-8 file from the configured workspace.",
      version: "0.1.0",
      inputSchema: FsReadInputSchema,
      outputSchema: FsReadOutputSchema,
      adapter: fsReadAdapter,
      risk: "low",
      requestedScopes: ["workspace:read"],
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: DEFAULT_FS_READ_MAX_BYTES
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("filesystem")
    }
  ]);
}

export type PolicyEvaluator = (
  request: PolicyRequest,
  policyBundles?: FixturePolicyBundle | readonly FixturePolicyBundle[]
) => PolicyVerdict;

export type ToolBrokerOptions = {
  workspaceRoot: string;
  runId?: string;
  registry?: CapabilityRegistry;
  policyBundle?: FixturePolicyBundle | readonly FixturePolicyBundle[];
  policyEngine?: PolicyEvaluator;
  cacheStore?: ToolResultCacheStore;
};

export type ToolCallContext = {
  runId?: string;
  cwd?: string;
  traceId?: string;
  spanId?: string;
  eventIds?: string[];
  runMode?: string;
  approvalDeadlineAt?: string | number | Date;
  policyBundle?: FixturePolicyBundle | readonly FixturePolicyBundle[];
  snapshots?: PolicyRequest["snapshots"];
  cache?: ToolCacheMetadata;
};

export class ToolBroker {
  private readonly workspaceRoot: string;
  private readonly runId: string;
  private readonly registry: CapabilityRegistry;
  private readonly policyBundle?:
    | FixturePolicyBundle
    | readonly FixturePolicyBundle[];
  private readonly policyEngine: PolicyEvaluator;
  private readonly cacheStore: ToolResultCacheStore;

  constructor(options: ToolBrokerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.runId = options.runId ?? "run_unspecified";
    this.registry = options.registry ?? createDefaultCapabilityRegistry();
    this.policyEngine = options.policyEngine ?? evaluatePolicy;
    this.cacheStore = options.cacheStore ?? new InMemoryToolResultCacheStore();

    if (options.policyBundle !== undefined) {
      this.policyBundle = options.policyBundle;
    }
  }

  async callTool(
    requestLike: ToolCallRequest | unknown,
    context: ToolCallContext = {}
  ): Promise<ToolCallResult> {
    // Stage 0: establish trace and pre-validation provenance.
    const traceId = context.traceId ?? `trace_${randomUUID()}`;
    const requestedToolId = readStringProperty(requestLike, "toolId") ?? "unknown";
    const rawArgs = readProperty(requestLike, "args");
    const unresolvedArgsHash = hashValue(rawArgs);

    // Stage 1: validate the request envelope before resolving anything.
    const parsedRequest = ToolCallRequestSchema.safeParse(requestLike);
    if (!parsedRequest.success) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: requestedToolId,
        toolVersion: "unresolved",
        argsHash: unresolvedArgsHash,
        cacheStatus: "bypass",
        traceId,
        error: {
          code: "invalid_request",
          message: formatZodIssues(parsedRequest.error),
          retryable: false
        }
      });
    }

    const request = parsedRequest.data;
    const argsHash = hashValue(request.args);

    // Stage 2: resolve the declared capability. Discovery is not permission.
    const definition = this.registry.resolve(request.toolId);

    if (definition === undefined) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "denied",
        toolId: request.toolId,
        toolVersion: "undeclared",
        argsHash,
        cacheStatus: "bypass",
        traceId,
        error: {
          code: "tool_not_found",
          message: `Tool ${request.toolId} is not declared in the capability registry.`,
          retryable: false
        }
      });
    }

    // Stage 3: validate args against the registered capability contract.
    const parsedArgs = definition.inputSchema.safeParse(request.args);
    if (!parsedArgs.success) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        error: {
          code: "invalid_request",
          message: formatZodIssues(parsedArgs.error),
          retryable: false
        }
      });
    }

    // Stage 4: authorize via the policy engine, failing closed on errors.
    const policyRequest = buildPolicyRequest({
      request,
      args: parsedArgs.data,
      definition,
      context,
      runId: context.runId ?? this.runId
    });
    const policyBundle = context.policyBundle ?? this.policyBundle;
    let policyVerdict: PolicyVerdict;

    try {
      policyVerdict = this.policyEngine(policyRequest, policyBundle);
    } catch (error) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "denied",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        error: {
          code: "policy_error",
          message:
            error instanceof Error
              ? error.message
              : "Policy evaluation failed closed.",
          retryable: false
        }
      });
    }

    if (policyVerdict.status === "deny") {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "denied",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        decisionHash: policyVerdict.decisionHash,
        approvalId: policyVerdict.approvalId,
        error: {
          code: "policy_denied",
          message: policyVerdict.reasons.join("; ") || "Policy denied tool call.",
          retryable: false
        }
      });
    }

    // Stage 5: coordinate approval without deciding policy in the broker.
    if (policyVerdict.status === "approval_required") {
      const approvalId = approvalIdFromVerdict(policyVerdict);
      const approvalDecision = findApprovalDecision(context, approvalId);

      if (approvalDecision?.decision === "rejected") {
        return buildToolResult({
          toolCallId: createToolCallId(),
          status: "denied",
          toolId: definition.id,
          toolVersion: definition.version,
          argsHash,
          cacheStatus: "bypass",
          traceId,
          decisionHash: policyVerdict.decisionHash,
          approvalId,
          error: {
            code: "approval_rejected",
            message: `Approval ${approvalId} was rejected.`,
            retryable: false
          }
        });
      }

      if (isApprovalDeadlineElapsed(context, approvalDecision)) {
        return buildToolResult({
          toolCallId: createToolCallId(),
          status: "denied",
          toolId: definition.id,
          toolVersion: definition.version,
          argsHash,
          cacheStatus: "bypass",
          traceId,
          decisionHash: policyVerdict.decisionHash,
          approvalId,
          error: {
            code: "approval_timeout",
            message: `Approval ${approvalId} timed out before execution.`,
            retryable: false
          }
        });
      }

      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "approval_required",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        decisionHash: policyVerdict.decisionHash,
        approvalId,
        error: {
          code: "approval_required",
          message: approvalRequiredMessage(policyVerdict, approvalId),
          retryable: false
        }
      });
    }

    const satisfiedApprovalId = satisfiedApprovalIdFromVerdict(
      policyVerdict,
      context
    );
    const executedApprovalId = policyVerdict.approvalId ?? satisfiedApprovalId;
    if (
      satisfiedApprovalId !== undefined &&
      isApprovalDeadlineElapsed(
        context,
        findApprovalDecision(context, satisfiedApprovalId)
      )
    ) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "denied",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        decisionHash: policyVerdict.decisionHash,
        approvalId: executedApprovalId,
        error: {
          code: "approval_timeout",
          message: `Approval ${satisfiedApprovalId} timed out before execution.`,
          retryable: false
        }
      });
    }

    // Stage 6: authorized cache lookup before adapter execution.
    const cacheLookup = await this.lookupCachedResult({
      definition,
      args: parsedArgs.data,
      context
    });

    if (cacheLookup.status === "hit") {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "success",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        resultHash: cacheLookup.resultHash,
        cacheStatus: "hit",
        cache: cacheLookup.cache,
        traceId,
        adapterVersion: cacheLookup.entry.adapterVersion,
        decisionHash: policyVerdict.decisionHash,
        approvalId: executedApprovalId,
        spanId: context.spanId,
        eventIds: context.eventIds,
        redactionSummary: cacheLookup.entry.redactionSummary,
        output: cacheLookup.output
      });
    }

    // Stage 7: execute the adapter under broker-computed limits and deadline.
    const adapterResult = await this.executeAdapter({
      definition,
      args: parsedArgs.data,
      request,
      context,
      policyVerdict,
      traceId
    });

    if (adapterResult.status === "failed") {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: cacheLookup.cacheStatus,
        cache: cacheLookup.cache,
        traceId,
        adapterVersion: definition.adapter.version,
        decisionHash: policyVerdict.decisionHash,
        approvalId: executedApprovalId,
        spanId: context.spanId,
        eventIds: context.eventIds,
        error: adapterResult.error
      });
    }

    // Stage 8: validate adapter output before exposing it to callers.
    const parsedOutput = definition.outputSchema.safeParse(adapterResult.output);
    if (!parsedOutput.success) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: cacheLookup.cacheStatus,
        cache: cacheLookup.cache,
        traceId,
        adapterVersion: definition.adapter.version,
        decisionHash: policyVerdict.decisionHash,
        approvalId: executedApprovalId,
        spanId: context.spanId,
        eventIds: context.eventIds,
        error: {
          code: "output_invalid",
          message: formatZodIssues(parsedOutput.error),
          retryable: false
        }
      });
    }

    const output = parsedOutput.data;
    const redactionResult = redactOutput(output, policyVerdict.obligations);

    if (!redactionResult.ok) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: cacheLookup.cacheStatus,
        cache: cacheLookup.cache,
        traceId,
        adapterVersion: definition.adapter.version,
        decisionHash: policyVerdict.decisionHash,
        approvalId: executedApprovalId,
        spanId: context.spanId,
        eventIds: context.eventIds,
        error: {
          code: "obligation_not_discharged",
          message: redactionResult.message,
          retryable: false
        }
      });
    }

    const parsedRedactedOutput = definition.outputSchema.safeParse(
      redactionResult.output
    );
    if (!parsedRedactedOutput.success) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: cacheLookup.cacheStatus,
        cache: cacheLookup.cache,
        traceId,
        adapterVersion: definition.adapter.version,
        decisionHash: policyVerdict.decisionHash,
        approvalId: executedApprovalId,
        spanId: context.spanId,
        eventIds: context.eventIds,
        error: {
          code: "output_invalid",
          message: `Redacted output failed schema validation: ${formatZodIssues(parsedRedactedOutput.error)}`,
          retryable: false
        }
      });
    }

    const redactedOutput = parsedRedactedOutput.data;
    const resultHash = hashValue(redactedOutput);
    const cache = await this.writeCacheEntry({
      lookup: cacheLookup,
      output: redactedOutput,
      resultHash,
      adapterVersion: definition.adapter.version,
      redactionSummary: redactionResult.summary
    });

    // Stages 10 and 11: construct provenance and parse the result schema.
    return buildToolResult({
      toolCallId: createToolCallId(),
      status: "success",
      toolId: definition.id,
      toolVersion: definition.version,
      argsHash,
      resultHash,
      cacheStatus: cacheLookup.cacheStatus,
      cache,
      traceId,
      adapterVersion: definition.adapter.version,
      decisionHash: policyVerdict.decisionHash,
      approvalId: executedApprovalId,
      spanId: context.spanId,
      eventIds: context.eventIds,
      redactionSummary: redactionResult.summary,
      output: redactedOutput
    });
  }

  private async executeAdapter(input: {
    definition: CapabilityDefinition;
    args: unknown;
    request: ToolCallRequest;
    context: ToolCallContext;
    policyVerdict: PolicyVerdict;
    traceId: string;
  }) {
    const tierConstraints = deriveTierConstraints(input.definition);
    const limits = computeLimits(
      input.definition,
      input.args,
      input.policyVerdict,
      tierConstraints
    );
    const startedAt = Date.now();

    if (tierConstraints.execution === "unsupported") {
      return adapterFailure(
        "unsupported_isolation_tier",
        tierConstraints.unsupportedReason ??
          `Capability ${input.definition.id} cannot execute in isolation tier ${tierConstraints.isolationTier}.`,
        false,
        startedAt
      );
    }

    try {
      return await withAdapterDeadline(
        input.definition.adapter.execute({
          args: input.args,
          runContext: {
            runId: input.context.runId ?? this.runId,
            phase: input.request.requestedBy.phase,
            cwd: input.context.cwd ?? this.workspaceRoot,
            workspaceRoot: this.workspaceRoot,
            traceId: input.traceId
          },
          limits
        }),
        limits.timeoutMs,
        startedAt
      );
    } catch (error) {
      return adapterFailureFromUnknown(error, startedAt);
    }
  }

  private async lookupCachedResult(input: {
    definition: CapabilityDefinition;
    args: unknown;
    context: ToolCallContext;
  }): Promise<CacheLookupResult> {
    if (input.definition.cache.enabled !== true) {
      return {
        status: "bypass",
        cacheStatus: "bypass"
      };
    }

    const keyInputs = buildCacheKeyInputs(input);
    const key = deriveCacheKey(keyInputs);
    const baseCache: ToolCacheProvenance = {
      status: "miss",
      key,
      keyInputs
    };

    let entry: ToolResultCacheEntry | undefined;
    try {
      entry = await this.cacheStore.get(key);
    } catch (error) {
      return {
        status: "bypass",
        cacheStatus: "bypass",
        cache: {
          ...baseCache,
          status: "bypass",
          invalidationReason: cacheReason("cache_get_error", error)
        }
      };
    }

    if (entry === undefined) {
      return {
        status: "miss",
        cacheStatus: "miss",
        key,
        keyInputs,
        cache: baseCache
      };
    }

    const keyMatch = entry.key === key;
    const keyInputsMatch = hashValue(entry.keyInputs) === hashValue(keyInputs);
    if (!keyMatch || !keyInputsMatch) {
      return {
        status: "bypass",
        cacheStatus: "bypass",
        cache: {
          ...baseCache,
          status: "bypass",
          invalidationReason: "cache_key_mismatch"
        }
      };
    }

    const parsedOutput = input.definition.outputSchema.safeParse(entry.output);
    if (!parsedOutput.success) {
      return {
        status: "bypass",
        cacheStatus: "bypass",
        cache: {
          ...baseCache,
          status: "bypass",
          invalidationReason: `cache_output_invalid: ${formatZodIssues(parsedOutput.error)}`
        }
      };
    }

    const output = parsedOutput.data;
    const resultHash = hashValue(output);
    if (entry.resultHash !== resultHash) {
      return {
        status: "bypass",
        cacheStatus: "bypass",
        cache: {
          ...baseCache,
          status: "bypass",
          invalidationReason: "cache_result_hash_mismatch"
        }
      };
    }

    return {
      status: "hit",
      cacheStatus: "hit",
      entry,
      output,
      resultHash,
      cache: {
        ...baseCache,
        status: "hit",
        entryCreatedAt: entry.createdAt
      }
    };
  }

  private async writeCacheEntry(input: {
    lookup: CacheLookupResult;
    output: unknown;
    resultHash: string;
    adapterVersion: string;
    redactionSummary?: RedactionSummary | undefined;
  }) {
    if (input.lookup.status !== "miss") {
      return input.lookup.cache;
    }

    const entry: ToolResultCacheEntry = {
      key: input.lookup.key,
      keyInputs: input.lookup.keyInputs,
      output: input.output,
      resultHash: input.resultHash,
      adapterVersion: input.adapterVersion,
      createdAt: new Date().toISOString()
    };

    if (input.redactionSummary !== undefined) {
      entry.redactionSummary = input.redactionSummary;
    }

    try {
      await this.cacheStore.set(entry);
      return input.lookup.cache;
    } catch (error) {
      return {
        ...input.lookup.cache,
        writeError: cacheReason("cache_set_error", error)
      };
    }
  }
}

type CacheLookupResult =
  | {
      status: "bypass";
      cacheStatus: "bypass";
      cache?: ToolCacheProvenance | undefined;
    }
  | {
      status: "miss";
      cacheStatus: "miss";
      key: string;
      keyInputs: ToolCacheKeyInputs;
      cache: ToolCacheProvenance;
    }
  | {
      status: "hit";
      cacheStatus: "hit";
      entry: ToolResultCacheEntry;
      output: unknown;
      resultHash: string;
      cache: ToolCacheProvenance;
    };

function buildCacheKeyInputs(input: {
  definition: CapabilityDefinition;
  args: unknown;
  context: ToolCallContext;
}): ToolCacheKeyInputs {
  const sourceHashes = sourceHashesFromContext(input.context);
  const modelVersion = modelVersionFromContext(input.context);
  const keyInputs: ToolCacheKeyInputs = {
    toolId: input.definition.id,
    toolVersion: input.definition.version,
    argsHash: hashValue(input.args),
    harnessSpecHash: harnessSpecHashFromContext(input.context)
  };

  if (sourceHashes !== undefined) {
    keyInputs.sourceHashes = sourceHashes;
  }

  if (modelVersion !== undefined) {
    keyInputs.modelVersion = modelVersion;
  }

  return keyInputs;
}

function deriveCacheKey(keyInputs: ToolCacheKeyInputs) {
  return hashValue(keyInputs);
}

function sourceHashesFromContext(context: ToolCallContext) {
  return (
    normalizedStringRecord(context.cache?.sourceHashes) ??
    normalizedStringRecord(readProperty(context.snapshots?.sourceTrust, "sourceHashes"))
  );
}

function harnessSpecHashFromContext(context: ToolCallContext) {
  return (
    context.cache?.harnessSpecHash ??
    readNestedString(context.snapshots?.runState, ["harness", "specHash"]) ??
    hashValue({ absent: "harnessSpecHash" })
  );
}

function modelVersionFromContext(context: ToolCallContext) {
  return (
    nonEmptyStringOrUndefined(context.cache?.modelVersion) ??
    nonEmptyStringOrUndefined(readProperty(context.snapshots?.sourceTrust, "modelVersion"))
  );
}

function normalizedStringRecord(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length > 0) {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readNestedString(value: unknown, path: readonly string[]) {
  let current = value;

  for (const segment of path) {
    current = readProperty(current, segment);
  }

  return nonEmptyStringOrUndefined(current);
}

function nonEmptyStringOrUndefined(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cacheReason(prefix: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : "Cache operation failed.";

  return `${prefix}: ${sanitizeErrorMessage(message)}`;
}

async function withAdapterDeadline(
  adapterPromise: Promise<AdapterExecutionResult>,
  timeoutMs: number,
  startedAt: number
) {
  let timeoutId: unknown;
  const timeoutPromise = new Promise<AdapterExecutionResult>((resolveTimeout) => {
    timeoutId = setTimeout(() => {
      resolveTimeout(
        adapterFailure(
          "timeout",
          `Tool adapter exceeded ${timeoutMs}ms timeout.`,
          true,
          startedAt
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([adapterPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function approvalIdFromVerdict(verdict: PolicyVerdict) {
  return verdict.approvalId ?? "approval_required";
}

function approvalRequiredMessage(
  verdict: PolicyVerdict,
  approvalId: string
) {
  const reasons = verdict.reasons.join("; ");

  return reasons.length > 0
    ? `${reasons} Approval ${approvalId} is required.`
    : `Policy requires approval ${approvalId}.`;
}

function findApprovalDecision(context: ToolCallContext, approvalId: string) {
  return approvalDecisionsFromContext(context).find(
    (decision) => decision.approvalId === approvalId
  );
}

function satisfiedApprovalIdFromVerdict(
  verdict: PolicyVerdict,
  context: ToolCallContext
) {
  if (verdict.status !== "allow") {
    return undefined;
  }

  return approvalDecisionsFromContext(context)
    .filter(
      (decision) =>
        decision.decision === "approved" ||
        decision.decision === "approved_with_changes"
    )
    .find((decision) =>
      verdict.matchedRules.some(
        (rule) => rule.ruleId === `approval.${decision.approvalId}.approved`
      )
    )?.approvalId;
}

function approvalDecisionsFromContext(context: ToolCallContext) {
  const approvals = context.snapshots?.approvals;

  if (Array.isArray(approvals)) {
    return approvals.filter(isApprovalDecisionLike);
  }

  if (isRecord(approvals) && Array.isArray(approvals.decisions)) {
    return approvals.decisions.filter(isApprovalDecisionLike);
  }

  return [];
}

function isApprovalDecisionLike(value: unknown): value is {
  approvalId: string;
  decision: "approved" | "rejected" | "approved_with_changes";
  expiresAt?: string;
} {
  return (
    isRecord(value) &&
    typeof value.approvalId === "string" &&
    (value.decision === "approved" ||
      value.decision === "rejected" ||
      value.decision === "approved_with_changes")
  );
}

function isApprovalDeadlineElapsed(
  context: ToolCallContext,
  decision:
    | {
        expiresAt?: string;
      }
    | undefined
) {
  return [context.approvalDeadlineAt, decision?.expiresAt].some((deadline) =>
    isElapsedDeadline(deadline)
  );
}

function isElapsedDeadline(deadline: string | number | Date | undefined) {
  if (deadline === undefined) {
    return false;
  }

  const deadlineMs =
    deadline instanceof Date
      ? deadline.getTime()
      : typeof deadline === "number"
        ? deadline
        : Date.parse(deadline);

  return Number.isFinite(deadlineMs) && deadlineMs <= Date.now();
}

export function createToolBroker(options: ToolBrokerOptions) {
  return new ToolBroker(options);
}

const NORMALIZATION_OUTPUT_SCHEMA_KINDS = [
  "model",
  "embeddings",
  "memory",
  "mcp"
] as const satisfies readonly CapabilityKind[];

function assertValidCapabilityDefinition(definition: CapabilityDefinition) {
  const parsedDefinition = CapabilityDefinitionSchema.safeParse(definition);

  if (!parsedDefinition.success) {
    if (isTierlessKindFailure(definition)) {
      throw new ToolBrokerError(
        "tierless_kind",
        tierlessKindMessage(definition)
      );
    }

    if (isMissingOutputSchemaFailure(definition)) {
      throw new ToolBrokerError(
        "missing_output_schema",
        missingOutputSchemaMessage(definition)
      );
    }

    if (isMissingIsolationTierFailure(definition)) {
      throw new ToolBrokerError(
        "missing_isolation_tier",
        missingIsolationTierMessage(definition)
      );
    }

    throw new ToolBrokerError(
      "invalid_definition",
      formatZodIssues(parsedDefinition.error)
    );
  }

  const expectedIsolationTier = isolationTierForKind(definition.kind);
  if (definition.isolationTier !== expectedIsolationTier) {
    throw new ToolBrokerError(
      "missing_isolation_tier",
      `Capability ${definition.id} must declare isolation tier ${expectedIsolationTier} for kind ${definition.kind}.`
    );
  }

  if (definition.adapter.kind !== definition.kind) {
    throw new ToolBrokerError(
      "adapter_kind_mismatch",
      `Capability ${definition.id} declares kind ${definition.kind} but adapter ${definition.adapter.id} declares kind ${definition.adapter.kind}.`
    );
  }

  if (
    requiresNormalizationOutputSchema(definition.kind) &&
    !isZodType(definition.outputSchema)
  ) {
    throw new ToolBrokerError(
      "missing_output_schema",
      missingOutputSchemaMessage(definition)
    );
  }
}

function isTierlessKindFailure(definition: unknown) {
  if (!isRecord(definition)) {
    return false;
  }

  const kind = definition.kind;
  return typeof kind === "string" && !hasIsolationTierForKind(kind);
}

function isMissingOutputSchemaFailure(definition: unknown) {
  if (!isRecord(definition)) {
    return false;
  }

  const kind = definition.kind;
  return (
    typeof kind === "string" &&
    isNormalizationOutputSchemaKind(kind) &&
    !isZodType(definition.outputSchema)
  );
}

function isMissingIsolationTierFailure(definition: unknown) {
  if (!isRecord(definition)) {
    return false;
  }

  const kind = definition.kind;
  if (typeof kind === "string" && !hasIsolationTierForKind(kind)) {
    return true;
  }

  const isolationTier = definition.isolationTier;
  if (!isIsolationTier(isolationTier)) {
    return true;
  }

  return (
    typeof kind === "string" &&
    hasIsolationTierForKind(kind) &&
    isolationTier !== isolationTierForKind(kind)
  );
}

function missingOutputSchemaMessage(definition: unknown) {
  const id = readStringProperty(definition, "id") ?? "unknown";
  const kind = readStringProperty(definition, "kind") ?? "unknown";
  return `Capability ${id} (${kind}) must declare a real output schema.`;
}

function missingIsolationTierMessage(definition: unknown) {
  const id = readStringProperty(definition, "id") ?? "unknown";
  const kind = readStringProperty(definition, "kind") ?? "unknown";
  return `Capability ${id} must declare the registered isolation tier for kind ${kind}.`;
}

function tierlessKindMessage(definition: unknown) {
  const id = readStringProperty(definition, "id") ?? "unknown";
  const kind = readStringProperty(definition, "kind") ?? "unknown";
  return `Capability ${id} declares kind ${kind} with no registered isolation tier.`;
}

function requiresNormalizationOutputSchema(kind: CapabilityKind) {
  return (
    NORMALIZATION_OUTPUT_SCHEMA_KINDS as readonly CapabilityKind[]
  ).includes(kind);
}

function isNormalizationOutputSchemaKind(
  kind: string
): kind is (typeof NORMALIZATION_OUTPUT_SCHEMA_KINDS)[number] {
  return (
    NORMALIZATION_OUTPUT_SCHEMA_KINDS as readonly string[]
  ).includes(kind);
}

function hasIsolationTierForKind(kind: string): kind is CapabilityKind {
  return Object.prototype.hasOwnProperty.call(
    CAPABILITY_KIND_ISOLATION_TIERS,
    kind
  );
}

function isIsolationTier(value: unknown): value is IsolationTier {
  return (
    typeof value === "number" &&
    (ISOLATION_TIERS as readonly number[]).includes(value)
  );
}

function isZodType(value: unknown): value is ZodTypeAny {
  return value instanceof z.ZodType;
}

export function createFsListAdapter(): CapabilityAdapter {
  return {
    id: "adapters/filesystem/list",
    version: FILESYSTEM_ADAPTER_VERSION,
    kind: "filesystem",
    async execute(input) {
      const startedAt = Date.now();

      try {
        const args = FsListInputSchema.parse(input.args);
        const target = await resolveExistingWorkspaceTarget({
          workspaceRoot: input.runContext.workspaceRoot,
          cwd: input.runContext.cwd,
          path: args.path
        });
        const targetStats = await stat(target.absolutePath);

        if (!targetStats.isDirectory()) {
          return adapterFailure(
            "not_directory",
            `Path ${args.path} is not a directory.`,
            false,
            startedAt
          );
        }

        const entries = (await readdir(target.absolutePath, {
          withFileTypes: true
        }))
          .map((entry): FsListEntry => {
            const entryAbsolutePath = resolve(target.absolutePath, entry.name);

            return {
              name: entry.name,
              path: toWorkspacePath(target.workspaceRoot, entryAbsolutePath),
              type: direntType(entry)
            };
          })
          .sort((left, right) => left.path.localeCompare(right.path));

        return {
          status: "success",
          output: {
            path: target.relativePath,
            entries
          },
          metrics: {
            durationMs: Date.now() - startedAt
          }
        };
      } catch (error) {
        return adapterFailureFromUnknown(error, startedAt);
      }
    }
  };
}

export function createFsReadAdapter(): CapabilityAdapter {
  return {
    id: "adapters/filesystem/read",
    version: FILESYSTEM_ADAPTER_VERSION,
    kind: "filesystem",
    async execute(input) {
      const startedAt = Date.now();

      try {
        const args = FsReadInputSchema.parse(input.args);
        const target = await resolveExistingWorkspaceTarget({
          workspaceRoot: input.runContext.workspaceRoot,
          cwd: input.runContext.cwd,
          path: args.path
        });
        const targetStats = await stat(target.absolutePath);

        if (!targetStats.isFile()) {
          return adapterFailure(
            "not_file",
            `Path ${args.path} is not a regular file.`,
            false,
            startedAt
          );
        }

        const maxBytes = input.limits.maxBytes ?? DEFAULT_FS_READ_MAX_BYTES;
        const readLimit = Math.min(targetStats.size, maxBytes + 1);
        const buffer = Buffer.alloc(readLimit);
        const handle = await open(target.absolutePath, "r");
        let bytesRead = 0;

        try {
          const readResult = await handle.read(buffer, 0, readLimit, 0);
          bytesRead = readResult.bytesRead;
        } finally {
          await handle.close();
        }

        const returnedBytes = Math.min(bytesRead, maxBytes);
        const truncated = bytesRead > maxBytes || targetStats.size > maxBytes;
        const output: FsReadOutput = {
          path: target.relativePath,
          content: buffer.subarray(0, returnedBytes).toString("utf8"),
          encoding: "utf8",
          bytesRead: returnedBytes,
          truncated
        };

        return {
          status: "success",
          output,
          metrics: {
            bytesRead: returnedBytes,
            durationMs: Date.now() - startedAt
          }
        };
      } catch (error) {
        return adapterFailureFromUnknown(error, startedAt);
      }
    }
  };
}

export type ToolBrokerErrorCode =
  | "duplicate_tool"
  | "path_outside_workspace"
  | "cwd_outside_workspace"
  | "not_found"
  | "invalid_definition"
  | "tierless_kind"
  | "missing_isolation_tier"
  | "missing_output_schema"
  | "adapter_kind_mismatch";

export class ToolBrokerError extends Error {
  readonly code: ToolBrokerErrorCode;

  constructor(code: ToolBrokerErrorCode, message: string) {
    super(message);
    this.name = "ToolBrokerError";
    this.code = code;
  }
}

function buildPolicyRequest(input: {
  request: ToolCallRequest;
  args: unknown;
  definition: CapabilityDefinition;
  context: ToolCallContext;
  runId: string;
}): PolicyRequest {
  const request: PolicyRequest = {
    requestId: input.request.idempotencyKey,
    runId: input.runId,
    phase: input.request.requestedBy.phase,
    action: {
      kind: "tool_call",
      toolId: input.definition.id,
      risk: input.definition.risk,
      args: recordFromUnknown(input.args),
      requestedScopes: input.definition.requestedScopes
    }
  };

  if (input.context.runMode !== undefined) {
    request.runMode = input.context.runMode;
  }

  if (input.context.snapshots !== undefined) {
    request.snapshots = input.context.snapshots;
  }

  return request;
}

export function computeLimits(
  definition: CapabilityDefinition,
  args: unknown,
  verdict: PolicyVerdict,
  tierConstraints: TierConstraintSet = deriveTierConstraints(definition)
): AdapterExecutionLimits {
  const timeoutCandidates = [
    definition.limits.timeoutMs,
    readPositiveNumber(args, "timeoutMs"),
    readPolicyPositiveNumber(verdict, "timeoutMs"),
    tierConstraints.deadlineMs
  ].filter((value): value is number => value !== undefined);
  const limits: AdapterExecutionLimits = {
    timeoutMs:
      timeoutCandidates.length > 0
        ? Math.min(...timeoutCandidates)
        : DEFAULT_TOOL_TIMEOUT_MS
  };
  const maxByteCandidates = [
    definition.limits.maxBytes,
    readPositiveNumber(args, "maxBytes"),
    readPolicyPositiveNumber(verdict, "maxBytes"),
    tierConstraints.maxBytes
  ].filter((value): value is number => value !== undefined);
  const maxTokenCandidates = [
    definition.limits.maxTokens,
    readPositiveNumber(args, "maxTokens"),
    readPolicyPositiveNumber(verdict, "maxTokens"),
    tierConstraints.maxTokens
  ].filter((value): value is number => value !== undefined);

  if (maxByteCandidates.length > 0) {
    limits.maxBytes = Math.min(...maxByteCandidates);
  }

  if (maxTokenCandidates.length > 0) {
    limits.maxTokens = Math.min(...maxTokenCandidates);
  }

  return limits;
}

export function deriveTierConstraints(
  definition: CapabilityDefinition
): TierConstraintSet {
  const isolationTier = isolationTierForKind(definition.kind);

  if (!isIsolationTier(isolationTier)) {
    throw new ToolBrokerError(
      "tierless_kind",
      tierlessKindMessage(definition)
    );
  }

  switch (isolationTier) {
    case 0: {
      const constraintSet: TierConstraintSet = {
        isolationTier,
        deadlineMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: DEFAULT_FS_READ_MAX_BYTES,
        networkAllowlist: "deny_all",
        subprocess: "forbidden",
        writeConfinement: "workspace_readonly",
        execution:
          definition.kind === "filesystem" ? "sanctioned" : "unsupported"
      };

      if (definition.kind !== "filesystem") {
        constraintSet.unsupportedReason = `Capability ${definition.id} kind ${definition.kind} is tier ${isolationTier}, but only filesystem adapters are sanctioned in-process.`;
      }

      return constraintSet;
    }
    case 1:
      return {
        isolationTier,
        deadlineMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: DEFAULT_FS_READ_MAX_BYTES,
        maxTokens: 8_192,
        networkAllowlist: "deny_all",
        subprocess: "forbidden",
        writeConfinement: "none",
        execution: "unsupported",
        unsupportedReason: `Capability ${definition.id} requires semantic/model tier ${isolationTier}, which has no sanctioned in-repo adapter runner yet.`
      };
    case 2:
      return {
        isolationTier,
        deadlineMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: DEFAULT_FS_READ_MAX_BYTES,
        networkAllowlist: "deny_all",
        subprocess: "forbidden",
        writeConfinement: "workspace_staged",
        execution: "unsupported",
        unsupportedReason: `Capability ${definition.id} requires mutating-local tier ${isolationTier}, which has no sanctioned in-repo adapter runner yet.`
      };
    case 3:
      return {
        isolationTier,
        deadlineMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: DEFAULT_FS_READ_MAX_BYTES,
        networkAllowlist: "deny_all",
        subprocess: "sandboxed",
        writeConfinement: "workspace_staged",
        execution: "unsupported",
        unsupportedReason: `Capability ${definition.id} requires process/shell tier ${isolationTier}, which has no sanctioned sandbox runner yet.`
      };
    case 4:
      return {
        isolationTier,
        deadlineMs: DEFAULT_TOOL_TIMEOUT_MS,
        maxBytes: DEFAULT_FS_READ_MAX_BYTES,
        networkAllowlist: [],
        subprocess: "sandboxed",
        writeConfinement: "none",
        execution: "unsupported",
        unsupportedReason: `Capability ${definition.id} requires external-network tier ${isolationTier}, which has no sanctioned sandbox runner yet.`
      };
  }
}

function readPolicyPositiveNumber(verdict: PolicyVerdict, kind: string) {
  const values = verdict.constraints
    .filter((constraint) => constraint.kind === kind)
    .map((constraint) => constraint.value)
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        Number.isFinite(value)
    );

  return values.length > 0 ? Math.min(...values) : undefined;
}

function readPositiveNumber(value: unknown, key: string) {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate > 0 &&
    Number.isFinite(candidate)
    ? candidate
    : undefined;
}

type PolicyObligation = PolicyVerdict["obligations"][number];
type BrokerRelevantObligationKind = "redact" | "mark_external_source";
type RedactionSelector =
  | {
      kind: "path";
      value: string;
    }
  | {
      kind: "field";
      value: string;
    };
type RedactionRecord = {
  path: string;
  classification: string;
  hash: string;
};
type DischargedObligation = {
  kind: BrokerRelevantObligationKind;
  sourceRuleId: string;
  selector?: string | undefined;
  externalSource?: string | undefined;
};
type RedactionSummary = {
  redactedCount: number;
  redactions: RedactionRecord[];
  dischargedObligations: DischargedObligation[];
};
type RedactionResult =
  | {
      ok: true;
      output: unknown;
      summary?: RedactionSummary | undefined;
    }
  | {
      ok: false;
      message: string;
    };

const HASH_REFERENCE_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SENSITIVE_KEY_PATTERN =
  /(api.?key|access.?token|refresh.?token|auth.?token|token|secret|password|passwd|credential|authorization|client.?secret|private.?key|database.?url|connection.?string)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk_(?:live|test)_[A-Za-z0-9_=-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
] as const;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|authorization|client[_-]?secret|database[_-]?url|connection[_-]?string)(\s*[:=]\s*)([^\s,;]+)/gi;

function redactOutput(
  value: unknown,
  obligations: readonly PolicyObligation[]
): RedactionResult {
  const redactObligations = obligations.filter(
    (obligation) => obligation.kind === "redact"
  );
  const externalSourceObligations = obligations.filter(
    (obligation) => obligation.kind === "mark_external_source"
  );
  const selectorEntries = redactObligations.flatMap((obligation) =>
    selectorsFromRedactObligation(obligation).map((selector) => ({
      obligation,
      selector
    }))
  );
  const selectorMatches = new Map<string, number>();

  for (const entry of selectorEntries) {
    selectorMatches.set(selectorKey(entry.selector), 0);
  }

  const redactions: RedactionRecord[] = [];
  const output = redactValue({
    value,
    path: [],
    key: undefined,
    selectorEntries,
    selectorMatches,
    redactions
  });

  const missingSelectors = [...selectorMatches.entries()]
    .filter(([, count]) => count === 0)
    .map(([selector]) => selector);
  if (missingSelectors.length > 0) {
    return {
      ok: false,
      message: `Redaction obligation selectors were not discharged: ${missingSelectors.join(", ")}.`
    };
  }

  const dischargedObligations = [
    ...dischargedRedactObligations(redactObligations),
    ...externalSourceObligations.map((obligation): DischargedObligation => ({
      kind: "mark_external_source",
      sourceRuleId: obligation.sourceRuleId,
      externalSource: sanitizedExternalSourceMarker(obligation)
    }))
  ].sort(compareDischargedObligations);

  const summary =
    redactions.length > 0 || dischargedObligations.length > 0
      ? {
          redactedCount: redactions.length,
          redactions,
          dischargedObligations
        }
      : undefined;

  return {
    ok: true,
    output,
    summary
  };
}

function redactValue(input: {
  value: unknown;
  path: readonly string[];
  key: string | undefined;
  selectorEntries: readonly {
    obligation: PolicyObligation;
    selector: RedactionSelector;
  }[];
  selectorMatches: Map<string, number>;
  redactions: RedactionRecord[];
}): unknown {
  if (typeof input.value === "string") {
    const selectedBy = matchingSelectors(
      input.path,
      input.key,
      input.selectorEntries
    );
    const classification =
      selectedBy.length > 0
        ? "policy_redact"
        : classifySensitiveString(input.key, input.value);

    if (classification === undefined || isHashReference(input.value)) {
      return input.value;
    }

    const hash = hashValue(input.value);
    const path = formatPath(input.path);

    for (const entry of selectedBy) {
      const key = selectorKey(entry.selector);
      input.selectorMatches.set(
        key,
        (input.selectorMatches.get(key) ?? 0) + 1
      );
    }

    input.redactions.push({
      path,
      classification,
      hash
    });
    return hash;
  }

  if (Array.isArray(input.value)) {
    return input.value.map((item, index) =>
      redactValue({
        ...input,
        value: item,
        path: [...input.path, String(index)],
        key: String(index)
      })
    );
  }

  if (isRecord(input.value)) {
    const redacted: Record<string, unknown> = {};

    for (const key of Object.keys(input.value).sort()) {
      redacted[key] = redactValue({
        ...input,
        value: input.value[key],
        path: [...input.path, key],
        key
      });
    }

    return redacted;
  }

  return input.value;
}

function classifySensitiveString(key: string | undefined, value: string) {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
    return "secret";
  }

  return containsSecretPattern(value) ? "secret" : undefined;
}

function containsSecretPattern(value: string) {
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function matchingSelectors(
  path: readonly string[],
  key: string | undefined,
  selectorEntries: readonly {
    obligation: PolicyObligation;
    selector: RedactionSelector;
  }[]
) {
  return selectorEntries.filter((entry) => {
    if (entry.selector.kind === "field") {
      return key === entry.selector.value;
    }

    return selectorMatchesPath(entry.selector.value, formatPath(path));
  });
}

function selectorMatchesPath(selector: string, path: string) {
  return (
    selector === path ||
    (path.length > selector.length && path.startsWith(`${selector}.`))
  );
}

function selectorsFromRedactObligation(
  obligation: PolicyObligation
): RedactionSelector[] {
  const params = obligation.params;
  if (!isRecord(params)) {
    return [];
  }

  return [
    ...stringValues(params.path).map(pathSelector),
    ...stringValues(params.paths).map(pathSelector),
    ...stringValues(params.selector).map(pathSelector),
    ...selectorValues(params.selectors),
    ...stringValues(params.field).map(fieldSelector),
    ...stringValues(params.fields).map(fieldSelector),
    ...stringValues(params.key).map(fieldSelector),
    ...stringValues(params.keys).map(fieldSelector)
  ].filter(uniqueSelector);
}

function selectorValues(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry): RedactionSelector[] => {
        if (typeof entry === "string") {
          return [pathSelector(entry)];
        }

        if (isRecord(entry)) {
          return [
            ...stringValues(entry.path).map(pathSelector),
            ...stringValues(entry.field).map(fieldSelector),
            ...stringValues(entry.key).map(fieldSelector)
          ];
        }

        return [];
      })
      .filter(uniqueSelector);
  }

  return stringValues(value).map(pathSelector);
}

function stringValues(value: unknown) {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return [];
}

function pathSelector(value: string): RedactionSelector {
  return {
    kind: "path",
    value: normalizeSelectorPath(value)
  };
}

function fieldSelector(value: string): RedactionSelector {
  return {
    kind: "field",
    value
  };
}

function normalizeSelectorPath(value: string) {
  return value.replace(/^\$\.?/, "").replace(/^\./, "");
}

function uniqueSelector(
  selector: RedactionSelector,
  index: number,
  selectors: RedactionSelector[]
) {
  return (
    selector.value.length > 0 &&
    selectors.findIndex(
      (candidate) =>
        candidate.kind === selector.kind && candidate.value === selector.value
    ) === index
  );
}

function dischargedRedactObligations(
  obligations: readonly PolicyObligation[]
): DischargedObligation[] {
  return obligations.flatMap((obligation) => {
    const selectors = selectorsFromRedactObligation(obligation);

    if (selectors.length === 0) {
      return [
        {
          kind: "redact" as const,
          sourceRuleId: obligation.sourceRuleId
        }
      ];
    }

    return selectors.map((selector) => ({
      kind: "redact" as const,
      sourceRuleId: obligation.sourceRuleId,
      selector: selectorKey(selector)
    }));
  });
}

function sanitizedExternalSourceMarker(obligation: PolicyObligation) {
  const params = obligation.params;
  if (!isRecord(params)) {
    return undefined;
  }

  const marker =
    firstString(params.source) ??
    firstString(params.sourceRef) ??
    firstString(params.externalSource) ??
    firstString(params.uri) ??
    firstString(params.url) ??
    firstString(params.serverId);

  return marker === undefined ? undefined : sanitizeErrorMessage(marker);
}

function firstString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareDischargedObligations(
  left: DischargedObligation,
  right: DischargedObligation
) {
  return stableStringify(left).localeCompare(stableStringify(right));
}

function selectorKey(selector: RedactionSelector) {
  return selector.kind === "path" ? selector.value : `*.${selector.value}`;
}

function formatPath(path: readonly string[]) {
  return path.length === 0 ? "value" : path.join(".");
}

function isHashReference(value: string) {
  return HASH_REFERENCE_PATTERN.test(value);
}

export function sanitizeErrorMessage(message: string) {
  let sanitized = message.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string, separator: string, rawValue: string) =>
      `${key}${separator}${isHashReference(rawValue) ? rawValue : hashValue(rawValue)}`
  );

  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, (rawValue) => hashValue(rawValue));
  }

  return sanitized;
}

function buildToolResult(input: {
  toolCallId: string;
  status: ToolCallResult["status"];
  toolId: string;
  toolVersion: string;
  argsHash: string;
  resultHash?: string;
  cacheStatus: CacheStatus;
  cache?: ToolCacheProvenance | undefined;
  traceId: string;
  adapterVersion?: string;
  decisionHash?: string | undefined;
  approvalId?: string | undefined;
  spanId?: string | undefined;
  eventIds?: string[] | undefined;
  redactionSummary?: RedactionSummary | undefined;
  output?: unknown;
  error?: AdapterError;
}): ToolCallResult {
  const provenance: Record<string, unknown> = {
    toolId: input.toolId,
    toolVersion: input.toolVersion,
    argsHash: input.argsHash,
    cacheStatus: input.cacheStatus,
    traceId: input.traceId
  };

  if (input.resultHash !== undefined) {
    provenance.resultHash = input.resultHash;
  }

  if (input.adapterVersion !== undefined) {
    provenance.adapterVersion = input.adapterVersion;
  }

  if (input.decisionHash !== undefined) {
    provenance.decisionHash = input.decisionHash;
  }

  if (input.approvalId !== undefined) {
    provenance.approvalId = input.approvalId;
  }

  if (input.spanId !== undefined) {
    provenance.spanId = input.spanId;
  }

  if (input.eventIds !== undefined) {
    provenance.eventIds = input.eventIds;
  }

  if (input.redactionSummary !== undefined) {
    provenance.redactionSummary = input.redactionSummary;
  }

  if (input.cache !== undefined) {
    provenance.cache = input.cache;
  }

  const result: Record<string, unknown> = {
    toolCallId: input.toolCallId,
    status: input.status,
    provenance
  };

  if (input.output !== undefined) {
    result.output = input.output;
  }

  if (input.error !== undefined) {
    result.error = {
      ...input.error,
      message: sanitizeErrorMessage(input.error.message)
    };
  }

  return ToolCallResultSchema.parse(result);
}

type WorkspaceTarget = {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
};

async function resolveExistingWorkspaceTarget(input: {
  workspaceRoot: string;
  cwd: string;
  path: string;
}): Promise<WorkspaceTarget> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const cwd = resolvePathInsideWorkspace(realWorkspaceRoot, input.cwd);
  const targetPath = resolvePathInsideWorkspace(cwd, input.path);

  assertInsideWorkspace(realWorkspaceRoot, cwd, "cwd_outside_workspace");
  assertInsideWorkspace(realWorkspaceRoot, targetPath, "path_outside_workspace");

  let realTargetPath: string;
  try {
    realTargetPath = await realpath(targetPath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ToolBrokerError("not_found", `Path ${input.path} does not exist.`);
    }

    throw error;
  }

  assertInsideWorkspace(
    realWorkspaceRoot,
    realTargetPath,
    "path_outside_workspace"
  );

  return {
    workspaceRoot: realWorkspaceRoot,
    absolutePath: realTargetPath,
    relativePath: toWorkspacePath(realWorkspaceRoot, realTargetPath)
  };
}

function resolvePathInsideWorkspace(base: string, path: string) {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function assertInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
  code: Extract<
    ToolBrokerErrorCode,
    "path_outside_workspace" | "cwd_outside_workspace"
  >
) {
  if (!isPathInside(workspaceRoot, targetPath)) {
    throw new ToolBrokerError(code, "Path resolves outside the configured workspace.");
  }
}

function isPathInside(workspaceRoot: string, targetPath: string) {
  const relativePath = relative(workspaceRoot, targetPath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function toWorkspacePath(workspaceRoot: string, targetPath: string) {
  const relativePath = relative(workspaceRoot, targetPath);

  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}

function direntType(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FsListEntry["type"] {
  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isFile()) {
    return "file";
  }

  if (entry.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}

function adapterFailure(
  code: string,
  message: string,
  retryable: boolean,
  startedAt?: number
): AdapterExecutionResult {
  const result: AdapterExecutionResult = {
    status: "failed",
    error: {
      code,
      message: sanitizeErrorMessage(message),
      retryable
    }
  };

  if (startedAt !== undefined) {
    result.metrics = {
      durationMs: Date.now() - startedAt
    };
  }

  return result;
}

function adapterFailureFromUnknown(
  error: unknown,
  startedAt?: number
): AdapterExecutionResult {
  if (error instanceof ToolBrokerError) {
    return adapterFailure(error.code, error.message, false, startedAt);
  }

  if (isNodeErrorCode(error, "ENOENT")) {
    return adapterFailure("not_found", "Path does not exist.", false, startedAt);
  }

  if (isNodeErrorCode(error, "EACCES")) {
    return adapterFailure("permission_denied", "Permission denied.", false, startedAt);
  }

  return adapterFailure(
    "adapter_error",
    error instanceof Error ? error.message : "Adapter execution failed.",
    false,
    startedAt
  );
}

function formatZodIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function createToolCallId() {
  return `tool_${randomUUID()}`;
}

export function hashValue(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value)) ?? "undefined";
}

function cloneCacheEntry(
  entry: ToolResultCacheEntry | undefined
): ToolResultCacheEntry | undefined {
  if (entry === undefined) {
    return undefined;
  }

  const cloned: ToolResultCacheEntry = {
    ...entry,
    keyInputs: cloneJsonValue(entry.keyInputs),
    output: cloneJsonValue(entry.output)
  };

  if (entry.redactionSummary !== undefined) {
    cloned.redactionSummary = cloneJsonValue(entry.redactionSummary);
  }

  return cloned;
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? value : (JSON.parse(serialized) as T);
  } catch {
    return value;
  }
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStable);
  }

  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const normalizedValue = normalizeStable(value[key]);

      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
    }

    return normalized;
  }

  return value;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readProperty(value: unknown, property: string): unknown {
  return isRecord(value) ? value[property] : undefined;
}

function readStringProperty(value: unknown, property: string) {
  const propertyValue = readProperty(value, property);
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
