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
};

export type ToolCallContext = {
  runId?: string;
  cwd?: string;
  traceId?: string;
  runMode?: string;
  policyBundle?: FixturePolicyBundle | readonly FixturePolicyBundle[];
  snapshots?: PolicyRequest["snapshots"];
};

export class ToolBroker {
  private readonly workspaceRoot: string;
  private readonly runId: string;
  private readonly registry: CapabilityRegistry;
  private readonly policyBundle?:
    | FixturePolicyBundle
    | readonly FixturePolicyBundle[];
  private readonly policyEngine: PolicyEvaluator;

  constructor(options: ToolBrokerOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.runId = options.runId ?? "run_unspecified";
    this.registry = options.registry ?? createDefaultCapabilityRegistry();
    this.policyEngine = options.policyEngine ?? evaluatePolicy;

    if (options.policyBundle !== undefined) {
      this.policyBundle = options.policyBundle;
    }
  }

  async callTool(
    requestLike: ToolCallRequest | unknown,
    context: ToolCallContext = {}
  ): Promise<ToolCallResult> {
    const parsedRequest = ToolCallRequestSchema.safeParse(requestLike);
    const traceId = context.traceId ?? `trace_${randomUUID()}`;
    const requestedToolId = readStringProperty(requestLike, "toolId") ?? "unknown";
    const rawArgs = readProperty(requestLike, "args");
    const unresolvedArgsHash = hashValue(rawArgs);

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
        error: {
          code: "policy_denied",
          message: policyVerdict.reasons.join("; ") || "Policy denied tool call.",
          retryable: false
        }
      });
    }

    if (policyVerdict.status === "approval_required") {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "approval_required",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        error: {
          code: "approval_required",
          message:
            policyVerdict.reasons.join("; ") ||
            `Policy requires approval ${policyVerdict.approvalId}.`,
          retryable: false
        }
      });
    }

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
        cacheStatus: "bypass",
        traceId,
        error: adapterResult.error
      });
    }

    const parsedOutput = definition.outputSchema.safeParse(adapterResult.output);
    if (!parsedOutput.success) {
      return buildToolResult({
        toolCallId: createToolCallId(),
        status: "failed",
        toolId: definition.id,
        toolVersion: definition.version,
        argsHash,
        cacheStatus: "bypass",
        traceId,
        error: {
          code: "output_invalid",
          message: formatZodIssues(parsedOutput.error),
          retryable: false
        }
      });
    }

    const output = parsedOutput.data;

    return buildToolResult({
      toolCallId: createToolCallId(),
      status: "success",
      toolId: definition.id,
      toolVersion: definition.version,
      argsHash,
      resultHash: hashValue(output),
      cacheStatus: "bypass",
      traceId,
      output
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
    try {
      return await input.definition.adapter.execute({
        args: input.args,
        runContext: {
          runId: input.context.runId ?? this.runId,
          phase: input.request.requestedBy.phase,
          cwd: input.context.cwd ?? this.workspaceRoot,
          workspaceRoot: this.workspaceRoot,
          traceId: input.traceId
        },
        limits: computeLimits(input.definition, input.args, input.policyVerdict)
      });
    } catch (error) {
      return adapterFailureFromUnknown(error);
    }
  }
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

function computeLimits(
  definition: CapabilityDefinition,
  args: unknown,
  verdict: PolicyVerdict
): AdapterExecutionLimits {
  const limits: AdapterExecutionLimits = {
    timeoutMs: definition.limits.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  };
  const maxByteCandidates = [
    definition.limits.maxBytes,
    readPositiveNumber(args, "maxBytes"),
    readPolicyMaxBytes(verdict)
  ].filter((value): value is number => value !== undefined);

  if (maxByteCandidates.length > 0) {
    limits.maxBytes = Math.min(...maxByteCandidates);
  }

  return limits;
}

function readPolicyMaxBytes(verdict: PolicyVerdict) {
  const maxBytes = verdict.constraints
    .filter((constraint) => constraint.kind === "maxBytes")
    .map((constraint) => constraint.value)
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        Number.isFinite(value)
    );

  return maxBytes.length > 0 ? Math.min(...maxBytes) : undefined;
}

function readPositiveNumber(value: unknown, key: string) {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  return typeof candidate === "number" && candidate > 0 ? candidate : undefined;
}

function buildToolResult(input: {
  toolCallId: string;
  status: ToolCallResult["status"];
  toolId: string;
  toolVersion: string;
  argsHash: string;
  resultHash?: string;
  cacheStatus: CacheStatus;
  traceId: string;
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

  const result: Record<string, unknown> = {
    toolCallId: input.toolCallId,
    status: input.status,
    provenance
  };

  if (input.output !== undefined) {
    result.output = input.output;
  }

  if (input.error !== undefined) {
    result.error = input.error;
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
      message,
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
