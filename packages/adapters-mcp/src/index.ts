import type { RuntimeApi } from "@specwright/runtime";
import {
  ArtifactRecordSchema,
  EvalVerdictSchema,
  EvidenceRecordSchema,
  HarnessSnapshotSchema,
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

export type McpErrorResponse = {
  isError: true;
  error: McpToolError;
  content: [McpContentBlock];
};

export type McpToolsCallResponse =
  | {
      isError: false;
      result: unknown;
      content: [McpContentBlock];
    }
  | McpErrorResponse;

export type McpClientPrincipal = {
  id?: string | undefined;
  source?: string | undefined;
  assuranceLevel?: string | undefined;
  roles?: readonly string[] | undefined;
  tenantId?: string | undefined;
  [key: string]: unknown;
};

export type McpResourceAuthorityClass =
  | "derived projection"
  | "authoritative read-through"
  | "runtime-owned";

export type McpResourceReadKind =
  | "runtime-read"
  | "event-derived-projection"
  | "replay-derived-projection"
  | "open-contract";

export type McpResourceRuntimeRead =
  | "getRun"
  | "getEvents"
  | "replay"
  | "generateReport";

export type McpResourceBinding = {
  id: string;
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
  authorityClass: McpResourceAuthorityClass;
  readKind: McpResourceReadKind;
  runtimeRead?: McpResourceRuntimeRead | undefined;
  projection: string;
  payloadSchemaRef: string;
  payloadParser: ZodTypeAny;
  openContractItem?: string | undefined;
};

export type McpResourceDescriptor = {
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
  metadata: {
    authorityClass: McpResourceAuthorityClass;
    readKind: McpResourceReadKind;
    runtimeRead?: McpResourceRuntimeRead | undefined;
    projection: string;
    payloadSchemaRef: string;
    openContractItem?: string | undefined;
  };
};

export type McpResourceCatalog = {
  readonly bindings: readonly McpResourceBinding[];
  readonly byTemplate: ReadonlyMap<string, McpResourceBinding>;
};

export type McpResourcesListRequest = {
  principal?: McpClientPrincipal | undefined;
};

export type McpResourcesListResponse = {
  resources: McpResourceDescriptor[];
};

export type McpResourcesReadRequest = {
  uri: string;
  options?: z.infer<typeof lookupOptionsSchema> | undefined;
};

export type McpResourceFreshnessMetadata = {
  authorityClass: McpResourceAuthorityClass;
  readKind: McpResourceReadKind;
  runtimeRead?: McpResourceRuntimeRead | undefined;
  projection: string;
  payloadSchemaRef: string;
  lastEventId?: string | undefined;
  lastEventSequence?: number | undefined;
  sourceEventId?: string | undefined;
  sourceEventSequence?: number | undefined;
};

export type McpResourceContent = {
  uri: string;
  mimeType: string;
  text: string;
  metadata: McpResourceFreshnessMetadata;
};

export type McpResourcesReadResponse =
  | {
      isError: false;
      uri: string;
      payload: unknown;
      contents: [McpResourceContent];
      metadata: McpResourceFreshnessMetadata;
    }
  | McpErrorResponse;

export type McpEgressRedactionContext = {
  principal?: McpClientPrincipal | undefined;
  resource: McpResourceDescriptor;
  uri: string;
  classes: readonly string[];
  metadata: McpResourceFreshnessMetadata;
};

export type McpEgressRedaction = (
  payload: unknown,
  context: McpEgressRedactionContext
) => unknown | Promise<unknown>;

export type RuntimeActionDescriptor = z.infer<
  typeof RuntimeActionDescriptorSchema
>;

export type McpPromptBinding = {
  name: string;
  title: string;
  description: string;
  guidance: string;
  toolName: string;
  argumentTemplate: Record<string, unknown>;
};

export type McpPromptDescriptor = {
  name: string;
  title: string;
  description: string;
  metadata: {
    toolName: string;
  };
};

export type McpPromptCatalog = {
  readonly bindings: readonly McpPromptBinding[];
  readonly byName: ReadonlyMap<string, McpPromptBinding>;
};

export type McpPromptsListResponse = {
  prompts: McpPromptDescriptor[];
};

export type McpPromptsGetRequest = {
  name: string;
};

export type McpPromptMessage = {
  role: "user";
  content: {
    type: "text";
    text: string;
  };
};

export type McpPromptsGetResponse =
  | {
      isError: false;
      name: string;
      description: string;
      messages: [McpPromptMessage];
      action: RuntimeActionDescriptor;
      content: [McpContentBlock];
    }
  | McpErrorResponse;

export type McpProtocolRequest = {
  method: string;
  params?: unknown;
};

export type McpProtocolResponse =
  | McpToolsListResponse
  | McpToolsCallResponse
  | McpResourcesListResponse
  | McpResourcesReadResponse
  | McpPromptsListResponse
  | McpPromptsGetResponse
  | McpErrorResponse;

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

const runtimeEventArraySchema = z.array(RuntimeEventSchema);
const evidenceRecordArraySchema = z.array(EvidenceRecordSchema);
const evalVerdictArraySchema = z.array(EvalVerdictSchema);
const replayResultSchema = z
  .object({
    state: RunStateSchema,
    events: runtimeEventArraySchema
  })
  .strict();
const runReportSchema = z
  .object({
    runId: nonEmptyString,
    summaryPath: nonEmptyString,
    markdown: z.string(),
    missingInputs: z.array(nonEmptyString)
  })
  .strict();
const traceEventProjectionSchema = z
  .object({
    eventId: nonEmptyString,
    eventType: nonEmptyString,
    sequence: z.number().int().nonnegative(),
    timestamp: z.string().datetime({ offset: true }),
    traceId: nonEmptyString,
    causationId: nonEmptyString.optional(),
    correlationId: nonEmptyString.optional()
  })
  .strict();
const traceProjectionSchema = z
  .object({
    runId: nonEmptyString,
    lastEventId: nonEmptyString.optional(),
    lastEventSequence: z.number().int().nonnegative().optional(),
    events: z.array(traceEventProjectionSchema)
  })
  .strict();
const resourcesReadRequestSchema = z
  .object({
    uri: nonEmptyString,
    options: lookupOptionsSchema.optional()
  })
  .strict();
const protocolRequestSchema = z
  .object({
    method: nonEmptyString,
    params: z.unknown().optional()
  })
  .strict();

export const mcpResourceBindings = [
  resourceBinding({
    id: "run-state",
    uriTemplate: "specwright://runs/<run-id>/state",
    title: "Run State",
    description: "Derived run-state projection from RuntimeApi.getRun.",
    authorityClass: "derived projection",
    readKind: "runtime-read",
    runtimeRead: "getRun",
    projection: "RuntimeApi.getRun",
    payloadSchemaRef: "RunStateSchema",
    payloadParser: RunStateSchema
  }),
  resourceBinding({
    id: "run-events",
    uriTemplate: "specwright://runs/<run-id>/events",
    title: "Run Events",
    description: "Authoritative append-only runtime events from RuntimeApi.getEvents.",
    authorityClass: "authoritative read-through",
    readKind: "runtime-read",
    runtimeRead: "getEvents",
    projection: "RuntimeApi.getEvents",
    payloadSchemaRef: "RuntimeEventSchema[]",
    payloadParser: runtimeEventArraySchema
  }),
  resourceBinding({
    id: "run-artifact",
    uriTemplate: "specwright://runs/<run-id>/artifacts/<artifact-id>",
    title: "Artifact Record",
    description:
      "Runtime-owned artifact record projected from a single event read when the event log carries a full record.",
    authorityClass: "runtime-owned",
    readKind: "event-derived-projection",
    runtimeRead: "getEvents",
    projection: "RuntimeApi.getEvents -> ArtifactRecord event projection",
    payloadSchemaRef: "ArtifactRecordSchema",
    payloadParser: ArtifactRecordSchema,
    openContractItem:
      "RuntimeApi does not export an artifact read; artifact.recorded events currently carry ArtifactRef only, so full records are available only when a runtime event carries a schema-valid ArtifactRecord."
  }),
  resourceBinding({
    id: "run-evidence",
    uriTemplate: "specwright://runs/<run-id>/evidence",
    title: "Evidence Records",
    description: "Runtime-owned evidence records projected from evidence.recorded events.",
    authorityClass: "runtime-owned",
    readKind: "event-derived-projection",
    runtimeRead: "getEvents",
    projection: "RuntimeApi.getEvents -> evidence.recorded payloads",
    payloadSchemaRef: "EvidenceRecordSchema[]",
    payloadParser: evidenceRecordArraySchema
  }),
  resourceBinding({
    id: "run-evals",
    uriTemplate: "specwright://runs/<run-id>/evals",
    title: "Eval Verdicts",
    description: "Eval verdicts projected from RuntimeApi.replay events.",
    authorityClass: "derived projection",
    readKind: "replay-derived-projection",
    runtimeRead: "replay",
    projection: "RuntimeApi.replay -> eval.completed verdicts",
    payloadSchemaRef: "EvalVerdictSchema[]",
    payloadParser: evalVerdictArraySchema
  }),
  resourceBinding({
    id: "run-trace",
    uriTemplate: "specwright://runs/<run-id>/trace",
    title: "Trace Projection",
    description:
      "Adapter-local trace/provenance projection derived from runtime event trace identifiers.",
    authorityClass: "derived projection",
    readKind: "event-derived-projection",
    runtimeRead: "getEvents",
    projection: "RuntimeApi.getEvents -> event trace metadata",
    payloadSchemaRef: "McpTraceProjectionSchema",
    payloadParser: traceProjectionSchema,
    openContractItem:
      "RuntimeApi does not export a trace read; this packet exposes an event-derived provenance projection rather than trace-recorder trace.json contents."
  }),
  resourceBinding({
    id: "run-report",
    uriTemplate: "specwright://runs/<run-id>/report",
    title: "Run Report",
    description: "Derived run report from RuntimeApi.generateReport.",
    authorityClass: "derived projection",
    readKind: "runtime-read",
    runtimeRead: "generateReport",
    projection: "RuntimeApi.generateReport",
    payloadSchemaRef: "AdapterLocalRunReportSchema",
    payloadParser: runReportSchema,
    openContractItem:
      "RunReportSchema is not exported by @specwright/schemas; this packet validates RuntimeApi.generateReport with an adapter-local strict schema matching @specwright/run-reports."
  }),
  resourceBinding({
    id: "harness-spec",
    uriTemplate: "specwright://harnesses/<harness-id>/spec",
    title: "Harness Spec",
    description: "Harness snapshot contract reserved for a future RuntimeApi harness read.",
    authorityClass: "runtime-owned",
    readKind: "open-contract",
    projection: "No RuntimeApi harness read is exported for harness-only URIs.",
    payloadSchemaRef: "HarnessSnapshotSchema",
    payloadParser: HarnessSnapshotSchema,
    openContractItem:
      "RuntimeApi exposes harness snapshots only through run-scoped start/replay events; specwright://harnesses/<harness-id>/spec has no run id and no exported runtime read."
  })
] as const satisfies readonly McpResourceBinding[];

export const defaultMcpResourceCatalog = registerMcpResourceCatalog(
  mcpResourceBindings
);

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

const prohibitedRuntimeActionToolNames = new Set([
  "generate_entire_app",
  "make_design_better",
  "fix_everything",
  "create_contract_magically",
  "specwright_generate_entire_app",
  "specwright_make_design_better",
  "specwright_fix_everything",
  "specwright_create_contract_magically"
]);
const enabledRuntimeActionToolNames = new Set(
  defaultMcpCatalog.enabledBindings.map((binding) => binding.name)
);

export const RuntimeActionDescriptorSchema = z
  .object({
    tool: nonEmptyString.refine(
      (tool) =>
        enabledRuntimeActionToolNames.has(tool) &&
        !prohibitedRuntimeActionToolNames.has(tool),
      "Runtime action descriptors must reference an enabled Packet-1 MCP tool."
    ),
    arguments: z.record(z.string(), z.unknown()),
    mutates: z.boolean(),
    requiredScopes: z.array(nonEmptyString).optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (containsInlineExecution(descriptor.arguments)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arguments"],
        message: "Runtime action descriptors cannot embed inline execution."
      });
    }
  });

export const mcpPromptBindings = [
  promptBinding({
    name: "specwright_start_frontend_contract",
    title: "Start Frontend Contract",
    description: "Prepare a runtime-backed start-run action for frontend contract work.",
    guidance:
      "Create a Specwright run by calling the named tool with the completed run-input arguments. The prompt does not start the run.",
    toolName: "specwright_start_run",
    argumentTemplate: {
      task: "{{task}}",
      cwd: "{{workspaceRoot}}",
      harnessId: "frontend-contract",
      host: {
        kind: "mcp",
        version: "{{clientVersion}}"
      },
      metadata: {
        prompt: "specwright_start_frontend_contract"
      }
    }
  }),
  promptBinding({
    name: "specwright_review_failed_eval",
    title: "Review Failed Eval",
    description: "Prepare a runtime-backed eval action for reviewing a failed target.",
    guidance:
      "Call the named tool after filling in the run id, eval request, and lookup options. The prompt does not run the eval.",
    toolName: "specwright_run_eval",
    argumentTemplate: {
      runId: "{{runId}}",
      request: {
        evalId: "{{evalId}}",
        input: {
          artifacts: "{{artifactRefs}}",
          evidence: "{{evidenceRefs}}"
        }
      },
      options: {
        rootDir: "{{rootDir}}"
      }
    }
  }),
  promptBinding({
    name: "specwright_explain_next_action",
    title: "Explain Next Action",
    description:
      "Prepare a stable report-read action for explaining current run status without synthesizing gated next-action behavior.",
    guidance:
      "Call the named read tool to generate a run report, then explain the next action from that runtime-derived report. The prompt does not compute getNextAction.",
    toolName: "specwright_generate_report",
    argumentTemplate: {
      runId: "{{runId}}",
      options: {
        rootDir: "{{rootDir}}"
      }
    }
  })
] as const satisfies readonly McpPromptBinding[];

export const defaultMcpPromptCatalog = registerMcpPromptCatalog(
  mcpPromptBindings
);

export type McpAdapter = {
  tools: {
    list(): McpToolsListResponse;
    call(request: McpToolsCallRequest): Promise<McpToolsCallResponse>;
  };
  resources: {
    list(request?: McpResourcesListRequest): McpResourcesListResponse;
    read(request: McpResourcesReadRequest): Promise<McpResourcesReadResponse>;
  };
  prompts: {
    list(): McpPromptsListResponse;
    get(request: McpPromptsGetRequest): McpPromptsGetResponse;
  };
  dispatch(request: McpProtocolRequest): Promise<McpProtocolResponse>;
};

export function createMcpAdapter(
  runtime: RuntimeApi,
  options: {
    catalog?: McpCatalog | readonly McpToolBinding[] | undefined;
    resourceCatalog?: McpResourceCatalog | readonly McpResourceBinding[] | undefined;
    promptCatalog?: McpPromptCatalog | readonly McpPromptBinding[] | undefined;
    applyEgressRedaction?: McpEgressRedaction | undefined;
  } = {}
): McpAdapter {
  const catalog = normalizeCatalog(options.catalog);
  const resourceCatalog = normalizeResourceCatalog(options.resourceCatalog);
  const promptCatalog = normalizePromptCatalog(options.promptCatalog);
  const redact = options.applyEgressRedaction ?? applyEgressRedaction;

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
    },
    resources: {
      list(request = {}) {
        return listMcpResources(resourceCatalog, request);
      },
      async read(request) {
        return readMcpResource(runtime, resourceCatalog, request, redact);
      }
    },
    prompts: {
      list() {
        return listMcpPrompts(promptCatalog);
      },
      get(request) {
        return getMcpPrompt(promptCatalog, catalog, request);
      }
    },
    async dispatch(request) {
      return dispatchMcpRequest(runtime, catalog, resourceCatalog, promptCatalog, redact, request);
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

export function registerMcpResourceCatalog(
  bindings: readonly McpResourceBinding[]
): McpResourceCatalog {
  const byTemplate = new Map<string, McpResourceBinding>();
  const ids = new Set<string>();

  for (const binding of bindings) {
    if (binding.id.length === 0) {
      throw new McpCatalogError(
        "invalid_resource_id",
        "MCP resources require a non-empty id."
      );
    }

    if (ids.has(binding.id)) {
      throw new McpCatalogError(
        "duplicate_resource_id",
        `MCP resource ${binding.id} is already registered.`
      );
    }

    if (byTemplate.has(binding.uriTemplate)) {
      throw new McpCatalogError(
        "duplicate_resource_template",
        `MCP resource template ${binding.uriTemplate} is already registered.`
      );
    }

    ids.add(binding.id);
    byTemplate.set(binding.uriTemplate, binding);
  }

  return {
    bindings: [...bindings],
    byTemplate
  };
}

export function registerMcpPromptCatalog(
  bindings: readonly McpPromptBinding[]
): McpPromptCatalog {
  const byName = new Map<string, McpPromptBinding>();

  for (const binding of bindings) {
    if (binding.name.length === 0) {
      throw new McpCatalogError(
        "invalid_prompt_name",
        "MCP prompts require a non-empty name."
      );
    }

    if (byName.has(binding.name)) {
      throw new McpCatalogError(
        "duplicate_prompt_name",
        `MCP prompt ${binding.name} is already registered.`
      );
    }

    assertPromptToolName(binding.toolName);
    byName.set(binding.name, binding);
  }

  return {
    bindings: [...bindings],
    byName
  };
}

export function filterResourcesForPrincipal(
  principal: McpClientPrincipal | undefined,
  bindings: readonly McpResourceBinding[]
): readonly McpResourceBinding[] {
  void principal;
  return bindings;
}

export async function applyEgressRedaction(
  payload: unknown,
  context: McpEgressRedactionContext
): Promise<unknown> {
  void context;
  return payload;
}

function listMcpResources(
  catalog: McpResourceCatalog,
  request: McpResourcesListRequest
): McpResourcesListResponse {
  const bindings = filterResourcesForPrincipal(
    request.principal,
    catalog.bindings
  );

  return {
    resources: bindings.map(descriptorForResource)
  };
}

async function readMcpResource(
  runtime: RuntimeApi,
  catalog: McpResourceCatalog,
  request: McpResourcesReadRequest,
  redact: McpEgressRedaction
): Promise<McpResourcesReadResponse> {
  const parsedRequest = resourcesReadRequestSchema.safeParse(request);

  if (!parsedRequest.success) {
    return validationErrorResponse(parsedRequest.error);
  }

  const matched = matchResourceUri(parsedRequest.data.uri, catalog);

  if (isMcpErrorResponse(matched)) {
    return matched;
  }

  try {
    const read = await projectResourcePayload(
      runtime,
      matched,
      parsedRequest.data.options
    );
    const parsedPayload = matched.binding.payloadParser.safeParse(read.payload);

    if (!parsedPayload.success) {
      return validationErrorResponse(parsedPayload.error);
    }

    const metadata = resourceFreshnessMetadata(matched.binding, read.metadata);
    const resource = descriptorForResource(matched.binding);
    const redacted = await redact(parsedPayload.data, {
      resource,
      uri: parsedRequest.data.uri,
      classes: redactionClassesForResource(matched.binding),
      metadata
    });
    const text = canonicalJsonText(redacted);
    const payload = JSON.parse(text) as unknown;

    return {
      isError: false,
      uri: parsedRequest.data.uri,
      payload,
      contents: [
        {
          uri: parsedRequest.data.uri,
          mimeType: matched.binding.mimeType,
          text,
          metadata
        }
      ],
      metadata
    };
  } catch (error) {
    if (isZodError(error)) {
      return validationErrorResponse(error);
    }

    if (error instanceof McpResourceReadError) {
      return errorResponse({
        code: error.code,
        message: error.message,
        retryable: false
      });
    }

    return errorResponse({
      code: "invalid_request",
      message: error instanceof Error ? error.message : "Resource read failed.",
      retryable: false
    });
  }
}

function listMcpPrompts(catalog: McpPromptCatalog): McpPromptsListResponse {
  return {
    prompts: catalog.bindings.map((binding) => ({
      name: binding.name,
      title: binding.title,
      description: binding.description,
      metadata: {
        toolName: binding.toolName
      }
    }))
  };
}

function getMcpPrompt(
  catalog: McpPromptCatalog,
  toolCatalog: McpCatalog,
  request: McpPromptsGetRequest
): McpPromptsGetResponse {
  const parsedRequest = z
    .object({
      name: nonEmptyString
    })
    .strict()
    .safeParse(request);

  if (!parsedRequest.success) {
    return validationErrorResponse(parsedRequest.error);
  }

  const binding = catalog.byName.get(parsedRequest.data.name);

  if (binding === undefined) {
    return errorResponse({
      code: "method_not_found",
      message: `MCP prompt ${parsedRequest.data.name} is not registered.`,
      retryable: false
    });
  }

  const tool = toolCatalog.byName.get(binding.toolName);

  if (tool === undefined || !tool.enabled) {
    return errorResponse({
      code: "invalid_request",
      message: `MCP prompt ${binding.name} references an unavailable tool.`,
      retryable: false
    });
  }

  const action = RuntimeActionDescriptorSchema.parse({
    tool: binding.toolName,
    arguments: binding.argumentTemplate,
    mutates: tool.mutates,
    requiredScopes: tool.requiredScopes ?? []
  });
  const messages: [McpPromptMessage] = [
    {
      role: "user",
      content: {
        type: "text",
        text: binding.guidance
      }
    }
  ];

  return {
    isError: false,
    name: binding.name,
    description: binding.description,
    messages,
    action,
    content: [
      {
        type: "json",
        json: {
          messages,
          action
        }
      }
    ]
  };
}

async function dispatchMcpRequest(
  runtime: RuntimeApi,
  catalog: McpCatalog,
  resourceCatalog: McpResourceCatalog,
  promptCatalog: McpPromptCatalog,
  redact: McpEgressRedaction,
  request: McpProtocolRequest
): Promise<McpProtocolResponse> {
  const parsedRequest = protocolRequestSchema.safeParse(request);

  if (!parsedRequest.success) {
    return validationErrorResponse(parsedRequest.error);
  }

  switch (parsedRequest.data.method) {
    case "tools/list":
      return {
        tools: catalog.enabledBindings.map(descriptorForBinding)
      };
    case "tools/call":
      return callMcpTool(
        runtime,
        catalog,
        parsedRequest.data.params as McpToolsCallRequest
      );
    case "resources/list":
      return listMcpResources(
        resourceCatalog,
        isRecord(parsedRequest.data.params)
          ? (parsedRequest.data.params as McpResourcesListRequest)
          : {}
      );
    case "resources/read":
      return readMcpResource(
        runtime,
        resourceCatalog,
        parsedRequest.data.params as McpResourcesReadRequest,
        redact
      );
    case "prompts/list":
      return listMcpPrompts(promptCatalog);
    case "prompts/get":
      return getMcpPrompt(
        promptCatalog,
        catalog,
        parsedRequest.data.params as McpPromptsGetRequest
      );
    default:
      return errorResponse({
        code: "method_not_found",
        message: `MCP method ${parsedRequest.data.method} is not registered.`,
        retryable: false
      });
  }
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

function normalizeResourceCatalog(
  catalog: McpResourceCatalog | readonly McpResourceBinding[] | undefined
): McpResourceCatalog {
  if (catalog === undefined) {
    return defaultMcpResourceCatalog;
  }

  if (isMcpResourceCatalog(catalog)) {
    return catalog;
  }

  return registerMcpResourceCatalog(catalog);
}

function isMcpResourceCatalog(value: unknown): value is McpResourceCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    "bindings" in value &&
    "byTemplate" in value
  );
}

function normalizePromptCatalog(
  catalog: McpPromptCatalog | readonly McpPromptBinding[] | undefined
): McpPromptCatalog {
  if (catalog === undefined) {
    return defaultMcpPromptCatalog;
  }

  if (isMcpPromptCatalog(catalog)) {
    return catalog;
  }

  return registerMcpPromptCatalog(catalog);
}

function isMcpPromptCatalog(value: unknown): value is McpPromptCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    "bindings" in value &&
    "byName" in value
  );
}

type MatchedResource = {
  binding: McpResourceBinding;
  runId?: string | undefined;
  artifactId?: string | undefined;
  harnessId?: string | undefined;
};

type ResourceProjection = {
  payload: unknown;
  metadata: Partial<McpResourceFreshnessMetadata>;
};

class McpResourceReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpResourceReadError";
    this.code = code;
  }
}

function matchResourceUri(
  uri: string,
  catalog: McpResourceCatalog
): MatchedResource | McpErrorResponse {
  const segments = strictSpecwrightSegments(uri);

  if (segments instanceof McpResourceReadError) {
    return errorResponse({
      code: segments.code,
      message: segments.message,
      retryable: false
    });
  }

  if (segments[0] === "runs") {
    const runId = segments[1];

    if (segments.length === 3 && runId !== undefined) {
      const leaf = segments[2];
      const templateByLeaf: Record<string, string> = {
        state: "specwright://runs/<run-id>/state",
        events: "specwright://runs/<run-id>/events",
        evidence: "specwright://runs/<run-id>/evidence",
        evals: "specwright://runs/<run-id>/evals",
        trace: "specwright://runs/<run-id>/trace",
        report: "specwright://runs/<run-id>/report"
      };
      const template = templateByLeaf[leaf ?? ""];

      if (template !== undefined) {
        const binding = catalog.byTemplate.get(template);

        if (binding !== undefined) {
          return {
            binding,
            runId
          };
        }
      }
    }

    if (
      segments.length === 4 &&
      runId !== undefined &&
      segments[2] === "artifacts"
    ) {
      const binding = catalog.byTemplate.get(
        "specwright://runs/<run-id>/artifacts/<artifact-id>"
      );
      const artifactId = segments[3];

      if (binding !== undefined && artifactId !== undefined) {
        return {
          binding,
          runId,
          artifactId
        };
      }
    }
  }

  if (segments[0] === "harnesses" && segments.length === 3) {
    const binding = catalog.byTemplate.get(
      "specwright://harnesses/<harness-id>/spec"
    );
    const harnessId = segments[1];

    if (binding !== undefined && harnessId !== undefined && segments[2] === "spec") {
      return {
        binding,
        harnessId
      };
    }
  }

  return errorResponse({
    code: "method_not_found",
    message: `MCP resource URI ${uri} is not in the closed resource catalog.`,
    retryable: false
  });
}

function strictSpecwrightSegments(uri: string): string[] | McpResourceReadError {
  const scheme = "specwright://";

  if (!uri.startsWith(scheme)) {
    return new McpResourceReadError(
      "invalid_request",
      "MCP resource URI must use the specwright:// scheme."
    );
  }

  const rest = uri.slice(scheme.length);

  if (rest.length === 0 || rest.includes("?") || rest.includes("#")) {
    return new McpResourceReadError(
      "invalid_request",
      "MCP resource URI must not be empty or include query/fragment data."
    );
  }

  const segments = rest.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    return new McpResourceReadError(
      "invalid_request",
      "MCP resource URI must not contain empty path segments."
    );
  }

  return segments;
}

async function projectResourcePayload(
  runtime: RuntimeApi,
  matched: MatchedResource,
  options: z.infer<typeof lookupOptionsSchema> | undefined
): Promise<ResourceProjection> {
  switch (matched.binding.id) {
    case "run-state": {
      const payload = await runtime.getRun(requireRunId(matched), options);
      const lastEventId = readStringProperty(payload, "lastEventId");

      return {
        payload,
        metadata: {
          ...(lastEventId === undefined ? {} : { lastEventId })
        }
      };
    }
    case "run-events": {
      const events = runtimeEventArraySchema.parse(
        await runtime.getEvents(requireRunId(matched), options)
      );

      return {
        payload: events,
        metadata: eventFreshness(events)
      };
    }
    case "run-artifact": {
      const events = runtimeEventArraySchema.parse(
        await runtime.getEvents(requireRunId(matched), options)
      );
      const projected = artifactRecordFromEvents(
        events,
        requireArtifactId(matched)
      );

      if (projected === undefined) {
        throw new McpResourceReadError(
          "invalid_request",
          `Artifact ${requireArtifactId(matched)} was not available as a schema-valid runtime event projection.`
        );
      }

      return {
        payload: projected.artifact,
        metadata: {
          ...eventFreshness(events),
          sourceEventId: projected.event.id,
          sourceEventSequence: projected.event.sequence
        }
      };
    }
    case "run-evidence": {
      const events = runtimeEventArraySchema.parse(
        await runtime.getEvents(requireRunId(matched), options)
      );

      return {
        payload: evidenceRecordsFromEvents(events),
        metadata: eventFreshness(events)
      };
    }
    case "run-evals": {
      const replayed = replayResultSchema.parse(
        await runtime.replay(requireRunId(matched), options)
      );

      return {
        payload: evalVerdictsFromEvents(replayed.events),
        metadata: eventFreshness(replayed.events)
      };
    }
    case "run-trace": {
      const runId = requireRunId(matched);
      const events = runtimeEventArraySchema.parse(
        await runtime.getEvents(runId, options)
      );

      return {
        payload: traceProjectionFromEvents(runId, events),
        metadata: eventFreshness(events)
      };
    }
    case "run-report":
      return {
        payload: await runtime.generateReport(requireRunId(matched), options),
        metadata: {}
      };
    case "harness-spec":
      throw new McpResourceReadError(
        "invalid_request",
        matched.binding.openContractItem ??
          "Harness spec read is not exported by RuntimeApi."
      );
    default:
      throw new McpResourceReadError(
        "method_not_found",
        `MCP resource binding ${matched.binding.id} is not implemented.`
      );
  }
}

function evidenceRecordsFromEvents(
  events: readonly z.infer<typeof RuntimeEventSchema>[]
) {
  return events.flatMap((event) =>
    event.type === "evidence.recorded" ? [event.payload.evidence] : []
  );
}

function evalVerdictsFromEvents(
  events: readonly z.infer<typeof RuntimeEventSchema>[]
) {
  const verdicts = new Map<string, z.infer<typeof EvalVerdictSchema>>();

  for (const event of events) {
    if (event.type === "eval.completed") {
      verdicts.set(event.payload.verdict.evalId, event.payload.verdict);
    }
  }

  return [...verdicts.values()];
}

function artifactRecordFromEvents(
  events: readonly z.infer<typeof RuntimeEventSchema>[],
  artifactId: string
):
  | {
      artifact: z.infer<typeof ArtifactRecordSchema>;
      event: z.infer<typeof RuntimeEventSchema>;
    }
  | undefined {
  for (const event of events) {
    for (const candidate of artifactCandidatesFromEvent(event)) {
      const parsed = ArtifactRecordSchema.safeParse(candidate);

      if (parsed.success && parsed.data.artifactId === artifactId) {
        return {
          artifact: parsed.data,
          event
        };
      }
    }
  }

  return undefined;
}

function artifactCandidatesFromEvent(
  event: z.infer<typeof RuntimeEventSchema>
): unknown[] {
  const payload = recordValue(event.payload);
  const candidates = [
    payload.artifact,
    payload.artifactRecord,
    payload.record
  ];

  if (event.type === "tool.completed") {
    const result = recordValue(payload.result);
    const output = recordValue(result.output);
    candidates.push(
      result.output,
      output.artifact,
      output.artifactRecord,
      output.record
    );
  }

  return candidates.filter((candidate) => candidate !== undefined);
}

function traceProjectionFromEvents(
  runId: string,
  events: readonly z.infer<typeof RuntimeEventSchema>[]
) {
  const freshness = eventFreshness(events);

  return {
    runId,
    ...(freshness.lastEventId === undefined
      ? {}
      : { lastEventId: freshness.lastEventId }),
    ...(freshness.lastEventSequence === undefined
      ? {}
      : { lastEventSequence: freshness.lastEventSequence }),
    events: events.map((event) => ({
      eventId: event.id,
      eventType: event.type,
      sequence: event.sequence,
      timestamp: event.timestamp,
      traceId: event.traceId,
      ...(event.causationId === undefined
        ? {}
        : { causationId: event.causationId }),
      ...(event.correlationId === undefined
        ? {}
        : { correlationId: event.correlationId })
    }))
  };
}

function eventFreshness(
  events: readonly z.infer<typeof RuntimeEventSchema>[]
): Partial<McpResourceFreshnessMetadata> {
  const lastEvent = events[events.length - 1];

  if (lastEvent === undefined) {
    return {};
  }

  return {
    lastEventId: lastEvent.id,
    lastEventSequence: lastEvent.sequence
  };
}

function resourceFreshnessMetadata(
  binding: McpResourceBinding,
  metadata: Partial<McpResourceFreshnessMetadata>
): McpResourceFreshnessMetadata {
  return {
    authorityClass: binding.authorityClass,
    readKind: binding.readKind,
    ...(binding.runtimeRead === undefined
      ? {}
      : { runtimeRead: binding.runtimeRead }),
    projection: binding.projection,
    payloadSchemaRef: binding.payloadSchemaRef,
    ...metadata
  };
}

function descriptorForResource(
  binding: McpResourceBinding
): McpResourceDescriptor {
  return {
    uriTemplate: binding.uriTemplate,
    title: binding.title,
    description: binding.description,
    mimeType: binding.mimeType,
    metadata: {
      authorityClass: binding.authorityClass,
      readKind: binding.readKind,
      ...(binding.runtimeRead === undefined
        ? {}
        : { runtimeRead: binding.runtimeRead }),
      projection: binding.projection,
      payloadSchemaRef: binding.payloadSchemaRef,
      ...(binding.openContractItem === undefined
        ? {}
        : { openContractItem: binding.openContractItem })
    }
  };
}

function redactionClassesForResource(
  binding: McpResourceBinding
): readonly string[] {
  return [binding.authorityClass, binding.payloadSchemaRef];
}

function requireRunId(matched: MatchedResource) {
  if (matched.runId === undefined) {
    throw new McpResourceReadError(
      "invalid_request",
      `MCP resource ${matched.binding.uriTemplate} requires a run id.`
    );
  }

  return matched.runId;
}

function requireArtifactId(matched: MatchedResource) {
  if (matched.artifactId === undefined) {
    throw new McpResourceReadError(
      "invalid_request",
      `MCP resource ${matched.binding.uriTemplate} requires an artifact id.`
    );
  }

  return matched.artifactId;
}

function readStringProperty(value: unknown, key: string) {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function canonicalJsonText(value: unknown) {
  const text = JSON.stringify(canonicalJsonValue(value));

  if (text === undefined) {
    throw new McpResourceReadError(
      "invalid_request",
      "Resource payload was not JSON serializable."
    );
  }

  return text;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort()) {
    const child = value[key];

    if (child !== undefined) {
      output[key] = canonicalJsonValue(child);
    }
  }

  return output;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isMcpErrorResponse(value: unknown): value is McpErrorResponse {
  return isRecord(value) && value.isError === true && "error" in value;
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
): McpErrorResponse {
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

function validationErrorResponse(error: ZodError): McpErrorResponse {
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

function resourceBinding(
  input: Omit<McpResourceBinding, "mimeType"> & {
    mimeType?: string | undefined;
  }
): McpResourceBinding {
  return {
    ...input,
    mimeType: input.mimeType ?? "application/json"
  };
}

function promptBinding(input: McpPromptBinding): McpPromptBinding {
  assertPromptToolName(input.toolName);

  return input;
}

function assertPromptToolName(toolName: string) {
  if (prohibitedRuntimeActionToolNames.has(toolName)) {
    throw new McpCatalogError(
      "magic_prompt_tool",
      `MCP prompt tool ${toolName} is prohibited.`
    );
  }

  if (!enabledRuntimeActionToolNames.has(toolName)) {
    throw new McpCatalogError(
      "unknown_prompt_tool",
      `MCP prompt tool ${toolName} is not in the enabled Packet-1 catalog.`
    );
  }
}

function containsInlineExecution(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsInlineExecution);
  }

  if (!isRecord(value)) {
    return false;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "execute" ||
      key === "executor" ||
      key === "runtimeOperation" ||
      key === "capabilityExecution"
    ) {
      return true;
    }

    if (containsInlineExecution(child)) {
      return true;
    }
  }

  return false;
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
