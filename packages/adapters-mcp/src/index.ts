import type { RuntimeApi } from "@specwright/runtime";
import {
  ArtifactRecordSchema,
  EvalVerdictSchema,
  EvidenceRecordSchema,
  RunInputSchema,
  RunStateSchema,
  RuntimeEventSchema,
  ToolCallRequestSchema,
  ToolCallResultSchema
} from "@specwright/schemas";
import { z, type ZodError, type ZodTypeAny } from "zod";

export type RuntimeOperationName = keyof RuntimeApi;

export type McpToolStability = "stable" | "experimental";

export type McpToolInputSchemaRef = {
  schemaRef: string;
  description: string;
};

export type EnabledMcpToolBinding = {
  name: string;
  description: string;
  runtimeOperation: RuntimeOperationName;
  mutates: boolean;
  stability: McpToolStability;
  enabled: true;
  inputParser: ZodTypeAny;
  inputSchema: McpToolInputSchemaRef;
  outputSchemaRef: string;
  requiredScopes?: readonly string[] | undefined;
};

export type DisabledMcpToolBinding = {
  name: string;
  description: string;
  runtimeOperation?: string | undefined;
  mutates: boolean;
  stability: McpToolStability;
  enabled: false;
  inputParser: ZodTypeAny;
  inputSchema: McpToolInputSchemaRef;
  outputSchemaRef: string;
  requiredScopes?: readonly string[] | undefined;
};

export type McpToolBinding = EnabledMcpToolBinding | DisabledMcpToolBinding;

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: McpToolInputSchemaRef;
  mutates: boolean;
  stability: McpToolStability;
  outputSchemaRef: string;
  metadata: {
    runtimeOperation: RuntimeOperationName;
    requiredScopes: readonly string[];
  };
};

export type McpToolsListResponse = {
  tools: McpToolDescriptor[];
};

export type McpToolsCallRequest = {
  name: string;
  arguments?: unknown;
};

export type McpContentBlock = {
  type: "json";
  json: unknown;
};

export type McpToolError = {
  code: string;
  message: string;
  retryable: boolean;
  issues?: McpValidationIssue[] | undefined;
  approvalId?: string | undefined;
};

export type McpToolsCallResponse =
  | {
      isError: false;
      result: unknown;
      content: [McpContentBlock];
    }
  | {
      isError: true;
      error: McpToolError;
      content: [McpContentBlock];
    };

export type McpValidationIssue = {
  path: string;
  message: string;
};

export class McpCatalogError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpCatalogError";
    this.code = code;
  }
}

export type McpCatalog = {
  readonly bindings: readonly McpToolBinding[];
  readonly enabledBindings: readonly EnabledMcpToolBinding[];
  readonly disabledBindings: readonly DisabledMcpToolBinding[];
  readonly byName: ReadonlyMap<string, McpToolBinding>;
};

const nonEmptyString = z.string().min(1);

const runtimeOperationNames = [
  "startRun",
  "getRun",
  "getEvents",
  "replay",
  "callTool",
  "runEval",
  "recordEvidence",
  "recordArtifact",
  "evaluateGate",
  "generateReport",
  "writeRunReport"
] as const satisfies readonly RuntimeOperationName[];

const runtimeOperationNameSet = new Set<string>(runtimeOperationNames);
const gatedToolNames = new Set([
  "specwright_get_next_action",
  "specwright_answer_question",
  "specwright_record_approval"
]);
const gatedRuntimeOperationNames = new Set([
  "getNextAction",
  "recordHumanAnswer",
  "recordApproval"
]);

const lookupOptionsSchema = z
  .object({
    rootDir: nonEmptyString.optional()
  })
  .strict();

const stringOrObjectRequestSchema = z.union([
  nonEmptyString,
  z.record(z.string(), z.unknown())
]);

const getRunArgumentsSchema = runLookupArgumentsSchema();
const getEventsArgumentsSchema = runLookupArgumentsSchema();
const replayArgumentsSchema = runLookupArgumentsSchema();
const generateReportArgumentsSchema = runLookupArgumentsSchema();
const writeReportArgumentsSchema = runLookupArgumentsSchema();

const callToolArgumentsSchema = z
  .object({
    runId: nonEmptyString,
    request: ToolCallRequestSchema,
    options: z
      .object({
        rootDir: nonEmptyString.optional(),
        cwd: nonEmptyString.optional(),
        traceId: nonEmptyString.optional(),
        toolContext: z.record(z.string(), z.unknown()).optional()
      })
      .strict()
      .optional()
  })
  .strict();

const runEvalArgumentsSchema = z
  .object({
    runId: nonEmptyString,
    request: stringOrObjectRequestSchema,
    options: lookupOptionsSchema.optional()
  })
  .strict();

const recordEvidenceArgumentsSchema = z
  .object({
    runId: nonEmptyString,
    record: EvidenceRecordSchema,
    options: lookupOptionsSchema.optional()
  })
  .strict();

const recordArtifactArgumentsSchema = z
  .object({
    runId: nonEmptyString,
    record: artifactRecordInputSchema(),
    options: lookupOptionsSchema.optional()
  })
  .strict();

const evaluateGateArgumentsSchema = z
  .object({
    runId: nonEmptyString,
    request: stringOrObjectRequestSchema,
    options: lookupOptionsSchema.optional()
  })
  .strict();

const disabledArgumentsSchema = z.object({}).passthrough();

export const mcpToolBindings = [
  enabledBinding({
    name: "specwright_start_run",
    description: "Start a Specwright run through RuntimeApi.startRun.",
    runtimeOperation: "startRun",
    mutates: true,
    inputParser: RunInputSchema,
    inputSchemaRef: "RunInputSchema",
    outputSchemaRef: "RuntimeApi.RunHandle"
  }),
  enabledBinding({
    name: "specwright_get_run",
    description: "Read the current run projection through RuntimeApi.getRun.",
    runtimeOperation: "getRun",
    mutates: false,
    inputParser: getRunArgumentsSchema,
    inputSchemaRef: "RuntimeApi.getRun.arguments",
    outputSchemaRef: "RunStateSchema"
  }),
  enabledBinding({
    name: "specwright_get_events",
    description: "Read runtime events through RuntimeApi.getEvents.",
    runtimeOperation: "getEvents",
    mutates: false,
    inputParser: getEventsArgumentsSchema,
    inputSchemaRef: "RuntimeApi.getEvents.arguments",
    outputSchemaRef: "RuntimeEventSchema[]"
  }),
  enabledBinding({
    name: "specwright_replay",
    description: "Replay a run through RuntimeApi.replay.",
    runtimeOperation: "replay",
    mutates: false,
    inputParser: replayArgumentsSchema,
    inputSchemaRef: "RuntimeApi.replay.arguments",
    outputSchemaRef: "RuntimeApi.ReplayResult"
  }),
  enabledBinding({
    name: "specwright_call_tool",
    description: "Call a runtime-mediated capability through RuntimeApi.callTool.",
    runtimeOperation: "callTool",
    mutates: true,
    inputParser: callToolArgumentsSchema,
    inputSchemaRef: "RuntimeApi.callTool.arguments",
    outputSchemaRef: "ToolCallResultSchema"
  }),
  enabledBinding({
    name: "specwright_run_eval",
    description: "Run an eval through RuntimeApi.runEval.",
    runtimeOperation: "runEval",
    mutates: true,
    inputParser: runEvalArgumentsSchema,
    inputSchemaRef: "RuntimeApi.runEval.arguments",
    outputSchemaRef: "EvalVerdictSchema"
  }),
  enabledBinding({
    name: "specwright_record_evidence",
    description: "Record evidence through RuntimeApi.recordEvidence.",
    runtimeOperation: "recordEvidence",
    mutates: true,
    inputParser: recordEvidenceArgumentsSchema,
    inputSchemaRef: "RuntimeApi.recordEvidence.arguments",
    outputSchemaRef: "EvidenceRecordSchema"
  }),
  enabledBinding({
    name: "specwright_record_artifact",
    description: "Record an artifact through RuntimeApi.recordArtifact.",
    runtimeOperation: "recordArtifact",
    mutates: true,
    inputParser: recordArtifactArgumentsSchema,
    inputSchemaRef: "RuntimeApi.recordArtifact.arguments.ArtifactRecordInput",
    outputSchemaRef: "ArtifactRecordSchema"
  }),
  enabledBinding({
    name: "specwright_evaluate_gate",
    description: "Evaluate a lifecycle gate through RuntimeApi.evaluateGate.",
    runtimeOperation: "evaluateGate",
    mutates: true,
    inputParser: evaluateGateArgumentsSchema,
    inputSchemaRef: "RuntimeApi.evaluateGate.arguments",
    outputSchemaRef: "GateEvaluationResult"
  }),
  enabledBinding({
    name: "specwright_generate_report",
    description: "Generate a derived run report through RuntimeApi.generateReport.",
    runtimeOperation: "generateReport",
    mutates: false,
    inputParser: generateReportArgumentsSchema,
    inputSchemaRef: "RuntimeApi.generateReport.arguments",
    outputSchemaRef: "RunReport"
  }),
  enabledBinding({
    name: "specwright_write_report",
    description: "Write a run report through RuntimeApi.writeRunReport.",
    runtimeOperation: "writeRunReport",
    mutates: true,
    inputParser: writeReportArgumentsSchema,
    inputSchemaRef: "RuntimeApi.writeRunReport.arguments",
    outputSchemaRef: "RunReport"
  }),
  disabledBinding({
    name: "specwright_get_next_action",
    description: "Disabled boundary item for a future RuntimeApi.getNextAction projection.",
    runtimeOperation: "getNextAction",
    mutates: false
  }),
  disabledBinding({
    name: "specwright_answer_question",
    description: "Disabled boundary item for a future RuntimeApi.recordHumanAnswer mutation.",
    runtimeOperation: "recordHumanAnswer",
    mutates: true
  }),
  disabledBinding({
    name: "specwright_record_approval",
    description: "Disabled boundary item for a future RuntimeApi.recordApproval mutation.",
    runtimeOperation: "recordApproval",
    mutates: true
  })
] as const satisfies readonly McpToolBinding[];

export const defaultMcpCatalog = registerMcpCatalog(mcpToolBindings);

export type McpAdapter = {
  tools: {
    list(): McpToolsListResponse;
    call(request: McpToolsCallRequest): Promise<McpToolsCallResponse>;
  };
};

export function createMcpAdapter(
  runtime: RuntimeApi,
  options: { catalog?: McpCatalog | readonly McpToolBinding[] } = {}
): McpAdapter {
  const catalog = normalizeCatalog(options.catalog);

  return {
    tools: {
      list() {
        return {
          tools: catalog.enabledBindings.map(descriptorForBinding)
        };
      },
      async call(request) {
        return callMcpTool(runtime, catalog, request);
      }
    }
  };
}

export const createMcpServer = createMcpAdapter;

export function registerMcpTool(
  bindings: readonly McpToolBinding[],
  binding: McpToolBinding | Record<string, unknown>
): McpCatalog {
  return registerMcpCatalog([...bindings, binding as McpToolBinding]);
}

export function registerMcpCatalog(
  bindings: readonly McpToolBinding[]
): McpCatalog {
  const byName = new Map<string, McpToolBinding>();
  const enabledBindings: EnabledMcpToolBinding[] = [];
  const disabledBindings: DisabledMcpToolBinding[] = [];

  for (const binding of bindings) {
    assertValidBindingShape(binding);

    if (byName.has(binding.name)) {
      if (binding.enabled && gatedToolNames.has(binding.name)) {
        throw new McpCatalogError(
          "gated_tool_enabled",
          `MCP tool ${binding.name} is gated and cannot be enabled.`
        );
      }

      throw new McpCatalogError(
        "duplicate_tool_name",
        `MCP tool ${binding.name} is already registered.`
      );
    }

    if (binding.enabled && gatedToolNames.has(binding.name)) {
      throw new McpCatalogError(
        "gated_tool_enabled",
        `MCP tool ${binding.name} is gated and cannot be enabled.`
      );
    }

    if (
      binding.enabled &&
      gatedRuntimeOperationNames.has(binding.runtimeOperation)
    ) {
      throw new McpCatalogError(
        "gated_runtime_operation_enabled",
        `Runtime operation ${binding.runtimeOperation} is gated and cannot be enabled.`
      );
    }

    if (binding.enabled) {
      if (!runtimeOperationNameSet.has(binding.runtimeOperation)) {
        throw new McpCatalogError(
          "unknown_runtime_operation",
          `Runtime operation ${binding.runtimeOperation} is not exported by RuntimeApi.`
        );
      }

      enabledBindings.push(binding);
    } else {
      disabledBindings.push(binding);
    }

    byName.set(binding.name, binding);
  }

  return {
    bindings: [...bindings],
    enabledBindings: enabledBindings.sort(compareBindingsByName),
    disabledBindings: disabledBindings.sort(compareBindingsByName),
    byName
  };
}

async function callMcpTool(
  runtime: RuntimeApi,
  catalog: McpCatalog,
  request: McpToolsCallRequest
): Promise<McpToolsCallResponse> {
  const binding = catalog.byName.get(request.name);

  if (binding === undefined) {
    return errorResponse({
      code: "method_not_found",
      message: `MCP tool ${request.name} is not registered.`,
      retryable: false
    });
  }

  if (!binding.enabled) {
    return errorResponse({
      code: "invalid_request",
      message: `MCP tool ${request.name} is disabled.`,
      retryable: false
    });
  }

  const parsed = binding.inputParser.safeParse(request.arguments ?? {});

  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  try {
    const result = await invokeRuntime(runtime, binding.runtimeOperation, parsed.data);

    return resultForRuntimeValue(result);
  } catch (error) {
    if (isZodError(error)) {
      return validationErrorResponse(error);
    }

    return errorResponse({
      code: "invalid_request",
      message: error instanceof Error ? error.message : "Runtime call failed.",
      retryable: false
    });
  }
}

async function invokeRuntime(
  runtime: RuntimeApi,
  operation: RuntimeOperationName,
  args: unknown
): Promise<unknown> {
  switch (operation) {
    case "startRun":
      return runtime.startRun(RunInputSchema.parse(args));
    case "getRun": {
      const parsed = getRunArgumentsSchema.parse(args);
      return runtime.getRun(parsed.runId, parsed.options);
    }
    case "getEvents": {
      const parsed = getEventsArgumentsSchema.parse(args);
      return runtime.getEvents(parsed.runId, parsed.options);
    }
    case "replay": {
      const parsed = replayArgumentsSchema.parse(args);
      return runtime.replay(parsed.runId, parsed.options);
    }
    case "callTool": {
      const parsed = callToolArgumentsSchema.parse(args);
      return runtime.callTool(parsed.runId, parsed.request, parsed.options);
    }
    case "runEval": {
      const parsed = runEvalArgumentsSchema.parse(args);
      return runtime.runEval(
        parsed.runId,
        parsed.request as Parameters<RuntimeApi["runEval"]>[1],
        parsed.options
      );
    }
    case "recordEvidence": {
      const parsed = recordEvidenceArgumentsSchema.parse(args);
      return runtime.recordEvidence(parsed.runId, parsed.record, parsed.options);
    }
    case "recordArtifact": {
      const parsed = recordArtifactArgumentsSchema.parse(args);
      return runtime.recordArtifact(
        parsed.runId,
        parsed.record as Parameters<RuntimeApi["recordArtifact"]>[1],
        parsed.options
      );
    }
    case "evaluateGate": {
      const parsed = evaluateGateArgumentsSchema.parse(args);
      return runtime.evaluateGate(
        parsed.runId,
        parsed.request as Parameters<RuntimeApi["evaluateGate"]>[1],
        parsed.options
      );
    }
    case "generateReport": {
      const parsed = generateReportArgumentsSchema.parse(args);
      return runtime.generateReport(parsed.runId, parsed.options);
    }
    case "writeRunReport": {
      const parsed = writeReportArgumentsSchema.parse(args);
      return runtime.writeRunReport(parsed.runId, parsed.options);
    }
    default:
      assertNever(operation);
  }
}

function resultForRuntimeValue(result: unknown): McpToolsCallResponse {
  const parsedToolResult = ToolCallResultSchema.safeParse(result);

  if (parsedToolResult.success) {
    return resultForToolCallResult(parsedToolResult.data, result);
  }

  return successResponse(result);
}

function resultForToolCallResult(
  result: z.infer<typeof ToolCallResultSchema>,
  payload: unknown
): McpToolsCallResponse {
  switch (result.status) {
    case "success":
      return successResponse(payload);
    case "denied":
      return errorResponse(
        {
          code: "policy_denied",
          message: result.error?.message ?? "Policy denied tool call.",
          retryable: result.error?.retryable ?? false
        },
        payload
      );
    case "approval_required":
      return errorResponse(
        {
          code: "approval_required",
          message: result.error?.message ?? "Approval is required before execution.",
          retryable: result.error?.retryable ?? false,
          approvalId: result.provenance.approvalId
        },
        payload
      );
    case "failed":
      return errorResponse(
        {
          code: result.error?.code ?? "tool_failed",
          message: result.error?.message ?? "Runtime tool call failed.",
          retryable: result.error?.retryable ?? false
        },
        payload
      );
    default:
      assertNever(result.status);
  }
}

function normalizeCatalog(
  catalog: McpCatalog | readonly McpToolBinding[] | undefined
): McpCatalog {
  if (catalog === undefined) {
    return defaultMcpCatalog;
  }

  if (isMcpCatalog(catalog)) {
    return catalog;
  }

  return registerMcpCatalog(catalog);
}

function isMcpCatalog(value: unknown): value is McpCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    "enabledBindings" in value &&
    "disabledBindings" in value &&
    "byName" in value
  );
}

function successResponse(result: unknown): McpToolsCallResponse {
  return {
    isError: false,
    result,
    content: [
      {
        type: "json",
        json: result
      }
    ]
  };
}

function errorResponse(
  error: McpToolError,
  payload: unknown = { error }
): McpToolsCallResponse {
  return {
    isError: true,
    error,
    content: [
      {
        type: "json",
        json: payload
      }
    ]
  };
}

function validationErrorResponse(error: ZodError): McpToolsCallResponse {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));

  return errorResponse({
    code: "invalid_request",
    message: issues
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; "),
    retryable: false,
    issues
  });
}

function runLookupArgumentsSchema() {
  return z
    .object({
      runId: nonEmptyString,
      options: lookupOptionsSchema.optional()
    })
    .strict();
}

function artifactRecordInputSchema() {
  return z
    .unknown()
    .superRefine((value, context) => {
      if (!isRecord(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expected artifact record object."
        });
        return;
      }

      const validationCandidate = {
        ...value,
        metadata: value.metadata ?? {},
        redactionPolicy: value.redactionPolicy ?? "operator"
      };
      const parsed = ArtifactRecordSchema.safeParse(validationCandidate);

      if (parsed.success) {
        return;
      }

      for (const issue of parsed.error.issues) {
        context.addIssue(issue);
      }
    })
    .transform(
      (value) => value as Parameters<RuntimeApi["recordArtifact"]>[1]
    );
}

function enabledBinding(input: {
  name: string;
  description: string;
  runtimeOperation: RuntimeOperationName;
  mutates: boolean;
  inputParser: ZodTypeAny;
  inputSchemaRef: string;
  outputSchemaRef: string;
}): EnabledMcpToolBinding {
  return {
    name: input.name,
    description: input.description,
    runtimeOperation: input.runtimeOperation,
    mutates: input.mutates,
    stability: "stable",
    enabled: true,
    inputParser: input.inputParser,
    inputSchema: schemaRef(input.inputSchemaRef),
    outputSchemaRef: input.outputSchemaRef,
    requiredScopes: []
  };
}

function disabledBinding(input: {
  name: string;
  description: string;
  runtimeOperation: string;
  mutates: boolean;
}): DisabledMcpToolBinding {
  return {
    name: input.name,
    description: input.description,
    runtimeOperation: input.runtimeOperation,
    mutates: input.mutates,
    stability: "experimental",
    enabled: false,
    inputParser: disabledArgumentsSchema,
    inputSchema: schemaRef(`${input.runtimeOperation}.disabled`),
    outputSchemaRef: `${input.runtimeOperation}.disabled`,
    requiredScopes: []
  };
}

function schemaRef(name: string): McpToolInputSchemaRef {
  return {
    schemaRef: `specwright://${name}`,
    description: `Arguments are validated by ${name}.`
  };
}

function descriptorForBinding(binding: EnabledMcpToolBinding): McpToolDescriptor {
  return {
    name: binding.name,
    description: binding.description,
    inputSchema: binding.inputSchema,
    mutates: binding.mutates,
    stability: binding.stability,
    outputSchemaRef: binding.outputSchemaRef,
    metadata: {
      runtimeOperation: binding.runtimeOperation,
      requiredScopes: binding.requiredScopes ?? []
    }
  };
}

function assertValidBindingShape(binding: McpToolBinding) {
  if (typeof binding.name !== "string" || binding.name.length === 0) {
    throw new McpCatalogError("invalid_tool_name", "MCP tools require a non-empty name.");
  }

  const runtimeOperation = (binding as { runtimeOperation?: unknown }).runtimeOperation;

  if (binding.enabled && runtimeOperation === undefined) {
    throw new McpCatalogError(
      "missing_runtime_operation",
      `Enabled MCP tool ${binding.name} must map to one RuntimeApi operation.`
    );
  }

  if (Array.isArray(runtimeOperation)) {
    throw new McpCatalogError(
      "multiple_runtime_operations",
      `MCP tool ${binding.name} maps to multiple RuntimeApi operations.`
    );
  }

  if (runtimeOperation !== undefined && typeof runtimeOperation !== "string") {
    throw new McpCatalogError(
      "invalid_runtime_operation",
      `MCP tool ${binding.name} has an invalid runtime operation.`
    );
  }
}

function compareBindingsByName(left: McpToolBinding, right: McpToolBinding) {
  return left.name.localeCompare(right.name);
}

function isZodError(error: unknown): error is ZodError {
  return error instanceof z.ZodError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}

void RunStateSchema;
void RuntimeEventSchema;
void EvalVerdictSchema;
