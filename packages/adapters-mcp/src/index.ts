import { createHash } from "node:crypto";
import type { RuntimeApi, RuntimeToolCallOptions } from "@specwright/runtime";
import {
  ArtifactRecordSchema,
  EvalVerdictSchema,
  EvidenceRecordSchema,
  HarnessSnapshotSchema,
  RedactionClassSchema,
  RunInputSchema,
  RunStateSchema,
  RuntimeEventSchema,
  ToolCallRequestSchema,
  ToolCallResultSchema,
  redactionClassAtLeast,
  type RedactionClass,
  type RuntimeEvent,
  type ToolCallResult
} from "@specwright/schemas";
import { z, type ZodError, type ZodTypeAny } from "zod";
import {
  MCP_AUDIT_SCHEMA_VERSION,
  type McpActionDispatched,
  type McpAuditPrincipal,
  type McpAuditRecord,
  type McpExternalInvoked,
  type McpRequestReceived,
  type McpResourceRead
} from "./audit/schemas";
import {
  createMcpAuditWriter,
  type McpAuditWriter
} from "./audit/writer";
import {
  createMcpCorrelationFactory,
  hashMcpArgs,
  sessionTraceRunId,
  type McpClock,
  type McpCorrelationFactory,
  type McpIdFactory
} from "./observability/correlation";
import {
  McpMetricsRegistry,
  recordMcpApprovalRequiredMetric,
  recordMcpDenialMetric,
  recordMcpExternalMetric,
  recordMcpRedactionMetric,
  recordMcpRequestMetric,
  recordMcpStaleStateMetric,
  setMcpActiveSessionsMetric
} from "./observability/metrics";
import {
  MCP_PROVENANCE_GAP_CODE,
  createProvenanceGapError,
  writeProvenanceGapMarker
} from "./observability/provenance-gap";
import {
  createMcpSpanWriter,
  mcpSpanStatusForOutcome,
  type McpSpanWriter
} from "./observability/spans";

export {
  MCP_AUDIT_SCHEMA_VERSION,
  MCP_PROVENANCE_GAP_AUDIT_TYPE,
  McpActionDeniedSchema,
  McpActionDispatchedSchema,
  McpAuditPrincipalSchema,
  McpAuditRecordSchema,
  McpAuditRecordTypeSchema,
  McpAuditToolProvenanceSchema,
  McpExternalInvokedSchema,
  McpProvenanceGapSchema,
  McpRequestReceivedSchema,
  McpResourceReadSchema,
  McpRunModeSchema,
  McpSessionClosedSchema,
  McpSessionOpenedSchema,
  parseMcpAuditRecord,
  safeParseMcpAuditRecord,
  type McpActionDenied,
  type McpAuditRecord,
  type McpAuditRecordType,
  type McpAuditToolProvenance,
  type McpExternalInvoked,
  type McpProvenanceGap,
  type McpRequestReceived,
  type McpResourceRead,
  type McpSessionClosed,
  type McpSessionOpened
} from "./audit/schemas";
export {
  MCP_AUDIT_DIR,
  MCP_AUDIT_FILE,
  MCP_AUDIT_INDEX_FILE,
  MCP_AUDIT_SESSIONS_DIR,
  McpAuditWriteError,
  appendMcpAuditRecord,
  createMcpAuditWriter,
  getMcpAuditIndexPath,
  getMcpAuditRoot,
  getMcpRunAuditPath,
  getMcpSessionAuditPath,
  readAllMcpAuditRecords,
  readMcpAuditRecords,
  type McpAuditWriter,
  type McpAuditWriterOptions,
  type McpAuditWriteErrorCode,
  type ReadMcpAuditRecordsOptions
} from "./audit/writer";
export {
  buildMcpAuditExport,
  type BuildMcpAuditExportOptions,
  type McpAuditExportBundle
} from "./audit/export";
export * from "./observability";
export {
  EXTERNAL_MCP_CAPABILITY_ID_PREFIX,
  ExternalMcpManifestError,
  ExternalMcpServerManifestSchema,
  ExternalMcpTenantManifestSchema,
  ExternalMcpToolManifestSchema,
  assertExternalMcpEndpointAllowlisted,
  assertExternalMcpPhaseAllowed,
  externalMcpCapabilityId,
  findAllowedExternalMcpTool,
  findExternalMcpServer,
  isEndpointAllowlisted,
  parseExternalMcpManifest,
  type ExternalMcpManifestErrorCode,
  type ExternalMcpServerManifest,
  type ExternalMcpTenantManifest,
  type ExternalMcpToolManifest
} from "./external-manifest";
export {
  type CreateExternalMcpCapabilityAdapterOptions,
  type ExternalMcpTransport,
  type ExternalMcpTransportRequest,
  type ExternalMcpTransportResult
} from "./external-capability-adapter";
export {
  createExternalMcpCapabilityDefinitions,
  type CreateExternalMcpCapabilityDefinitionsOptions
} from "./external-capability";
export {
  EXTERNAL_MCP_OBSERVATION_CLASS,
  EXTERNAL_MCP_OBSERVATION_EVIDENCE_CLASS,
  EXTERNAL_MCP_OBSERVATION_SOURCE_AUTHORITY,
  ExternalMcpObservationSchema,
  classifyExternalMcpObservation,
  classifyExternalMcpToolResult,
  externalMcpAdapterResultFromOutput,
  externalMcpObservedOutputSchema,
  type ExternalMcpObservation,
  type ExternalMcpObservedOutput
} from "./external-observation";
export {
  ExternalMcpQuarantineState,
  createExternalMcpQuarantineState,
  externalMcpQuarantineKey,
  type ExternalMcpQuarantineKey,
  type ExternalMcpQuarantineRecord,
  type ExternalMcpQuarantineStateOptions,
  type ExternalMcpQuarantineTrigger
} from "./external-quarantine";
export {
  createExternalMcpBrokerFactory,
  registerExternalMcpCapabilities,
  withExternalMcpBrokerCapabilities,
  type CreateExternalMcpBrokerFactoryOptions,
  type RegisterExternalMcpCapabilitiesOptions
} from "./register-external-capabilities";
export { mcpPacket04OpenContractItems } from "./external-open-contracts";

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
} | (McpErrorResponse & { tools: [] });

export type McpToolsCallRequest = {
  name: string;
  arguments?: unknown;
  credential?: unknown;
  subject?: unknown;
  requestedScopes?: readonly string[] | undefined;
};

export type McpContentBlock = {
  type: "json";
  json: unknown;
};

export type McpToolError = {
  contractId: "specwright.mcp.error.v1";
  code: string;
  message: string;
  retryable: boolean;
  operatorAction: string;
  issues?: McpValidationIssue[] | undefined;
  approvalId?: string | undefined;
};

type McpToolErrorInput = Omit<
  McpToolError,
  "contractId" | "operatorAction"
> & {
  operatorAction?: string | undefined;
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

export type McpClientRunMode = "autonomous" | "assisted" | "read_only";

export type ClientPrincipal = z.infer<typeof ClientPrincipalSchema>;

export type SubjectClaim = z.infer<typeof SubjectClaimSchema>;

export type SubjectEntitlements = z.infer<typeof SubjectEntitlementsSchema>;

export type AuthorizationContext = z.infer<typeof AuthorizationContextSchema>;

export type McpTransportCredentialRequest = {
  credential?: unknown;
  subject?: unknown;
  requestedScopes?: readonly string[] | undefined;
};

export type ClientCredentialVerifier = (
  credential: unknown
) => ClientPrincipal | unknown;

export type SubjectVerifier = (
  claim: SubjectClaim,
  principal: ClientPrincipal
) =>
  | SubjectEntitlements
  | null
  | false
  | Promise<SubjectEntitlements | null | false>;

export type McpTenantReference =
  | {
      kind: "run";
      runId: string;
    }
  | {
      kind: "resource";
      uri: string;
      runId?: string | undefined;
    }
  | {
      kind: "tool";
      name: string;
      runId?: string | undefined;
    };

export type McpTenantResolver = (
  reference: McpTenantReference,
  principal: ClientPrincipal
) => string | undefined | Promise<string | undefined>;

export type McpSecureAuthOptions = {
  mode: "authenticated";
  credentialVerifier?: ClientCredentialVerifier | undefined;
  subjectVerifier?: SubjectVerifier | undefined;
  requireSubject?: boolean | undefined;
  policyBundle?: unknown;
  tenantResolver?: McpTenantResolver | undefined;
};

export type McpDisabledAuthOptions = {
  mode?: "disabled" | undefined;
};

export type McpAuthOptions =
  | McpSecureAuthOptions
  | McpDisabledAuthOptions;

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
  credential?: unknown;
  subject?: unknown;
  requestedScopes?: readonly string[] | undefined;
};

export type McpResourcesListResponse = {
  resources: McpResourceDescriptor[];
} | (McpErrorResponse & { resources: [] });

export type McpResourcesReadRequest = {
  uri: string;
  options?: z.infer<typeof lookupOptionsSchema> | undefined;
  credential?: unknown;
  subject?: unknown;
  requestedScopes?: readonly string[] | undefined;
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
  surface: "tool_result" | "resource" | "prompt" | "error";
  principal?: McpClientPrincipal | undefined;
  clientPrincipal?: ClientPrincipal | undefined;
  subject?: SubjectEntitlements | undefined;
  resource?: McpResourceDescriptor | undefined;
  uri?: string | undefined;
  toolName?: string | undefined;
  promptName?: string | undefined;
  errorCode?: string | undefined;
  classes: readonly string[];
  metadata?: McpResourceFreshnessMetadata | undefined;
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
} | (McpErrorResponse & { prompts: [] });

export type McpPromptsGetRequest = {
  name: string;
  credential?: unknown;
  subject?: unknown;
  requestedScopes?: readonly string[] | undefined;
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

export type MaybePromise<T> = T | Promise<T>;

export type McpObservabilitySessionOptions = {
  sessionId?: string | undefined;
  clientId: string;
  subjectId: string;
  tenantId: string;
  grantedScopes: readonly string[];
  runMode: McpClientRunMode;
  transport: string;
  protocolVersion: string;
};

export type McpObservabilityOptions = {
  rootDir?: string | undefined;
  session?: McpObservabilitySessionOptions | undefined;
  auditWriter?: McpAuditWriter | undefined;
  markerWriter?: McpAuditWriter | undefined;
  spanWriter?: McpSpanWriter | undefined;
  metrics?: McpMetricsRegistry | undefined;
  clock?: McpClock | undefined;
  idFactory?: Partial<McpIdFactory> | undefined;
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
const scopeNameSchema = nonEmptyString;
const runModeSchema = z.enum(["autonomous", "assisted", "read_only"]);

export const ClientPrincipalSchema = z
  .object({
    clientId: nonEmptyString,
    tenantId: nonEmptyString,
    grantedScopes: z.array(scopeNameSchema),
    runMode: runModeSchema
  })
  .strict();

export const SubjectClaimSchema = z
  .object({
    subjectId: nonEmptyString,
    tenantId: nonEmptyString.optional(),
    claimRef: nonEmptyString.optional(),
    issuedBy: nonEmptyString.optional()
  })
  .strict();

export const SubjectEntitlementsSchema = z
  .object({
    subjectId: nonEmptyString,
    tenantId: nonEmptyString,
    scopes: z.array(scopeNameSchema),
    sourceTrust: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const RedactionClassBoundarySchema = RedactionClassSchema;

export const AuthorizationContextSchema = z
  .object({
    clientPrincipal: ClientPrincipalSchema,
    subject: SubjectEntitlementsSchema.optional(),
    requestedScopes: z.array(scopeNameSchema),
    effectiveScopes: z.array(scopeNameSchema),
    toolContext: z
      .object({
        runMode: runModeSchema,
        policyBundle: z.unknown().optional(),
        snapshots: z
          .object({
            sourceTrust: z.record(z.string(), z.unknown()).optional()
          })
          .strict()
          .optional()
      })
      .strict()
  })
  .strict();

const credentialRequestSchema = z
  .object({
    credential: z.unknown().optional(),
    subject: z.unknown().optional(),
    requestedScopes: z.array(scopeNameSchema).optional()
  })
  .strict();

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

const toolsCallRequestSchema = z
  .object({
    name: nonEmptyString,
    arguments: z.unknown().optional(),
    credential: z.unknown().optional(),
    subject: z.unknown().optional(),
    requestedScopes: z.array(scopeNameSchema).optional()
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
    options: lookupOptionsSchema.optional(),
    credential: z.unknown().optional(),
    subject: z.unknown().optional(),
    requestedScopes: z.array(scopeNameSchema).optional()
  })
  .strict();
const resourcesListRequestSchema = z
  .object({
    principal: z.record(z.string(), z.unknown()).optional(),
    credential: z.unknown().optional(),
    subject: z.unknown().optional(),
    requestedScopes: z.array(scopeNameSchema).optional()
  })
  .strict();
const promptsGetRequestSchema = z
  .object({
    name: nonEmptyString,
    credential: z.unknown().optional(),
    subject: z.unknown().optional(),
    requestedScopes: z.array(scopeNameSchema).optional()
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

export const mcpPacket03OpenContractItems = [
  "RuntimeApi does not expose a tenant ownership read for run/resource references; authenticated MCP mode can enforce a configured tenantResolver but otherwise cannot prove cross-tenant ownership without inventing runtime behavior."
] as const;

export const mcpToolBindings = [
  enabledBinding({
    name: "specwright_start_run",
    description: "Start a Specwright run through RuntimeApi.startRun.",
    runtimeOperation: "startRun",
    mutates: true,
    inputParser: RunInputSchema,
    inputSchemaRef: "RunInputSchema",
    outputSchemaRef: "RuntimeApi.RunHandle",
    requiredScopes: ["run:start"]
  }),
  enabledBinding({
    name: "specwright_get_run",
    description: "Read the current run projection through RuntimeApi.getRun.",
    runtimeOperation: "getRun",
    mutates: false,
    inputParser: getRunArgumentsSchema,
    inputSchemaRef: "RuntimeApi.getRun.arguments",
    outputSchemaRef: "RunStateSchema",
    requiredScopes: ["run:read"]
  }),
  enabledBinding({
    name: "specwright_get_events",
    description: "Read runtime events through RuntimeApi.getEvents.",
    runtimeOperation: "getEvents",
    mutates: false,
    inputParser: getEventsArgumentsSchema,
    inputSchemaRef: "RuntimeApi.getEvents.arguments",
    outputSchemaRef: "RuntimeEventSchema[]",
    requiredScopes: ["run:read"]
  }),
  enabledBinding({
    name: "specwright_replay",
    description: "Replay a run through RuntimeApi.replay.",
    runtimeOperation: "replay",
    mutates: false,
    inputParser: replayArgumentsSchema,
    inputSchemaRef: "RuntimeApi.replay.arguments",
    outputSchemaRef: "RuntimeApi.ReplayResult",
    requiredScopes: ["run:read"]
  }),
  enabledBinding({
    name: "specwright_call_tool",
    description: "Call a runtime-mediated capability through RuntimeApi.callTool.",
    runtimeOperation: "callTool",
    mutates: true,
    inputParser: callToolArgumentsSchema,
    inputSchemaRef: "RuntimeApi.callTool.arguments",
    outputSchemaRef: "ToolCallResultSchema",
    requiredScopes: ["tool:call"]
  }),
  enabledBinding({
    name: "specwright_run_eval",
    description: "Run an eval through RuntimeApi.runEval.",
    runtimeOperation: "runEval",
    mutates: true,
    inputParser: runEvalArgumentsSchema,
    inputSchemaRef: "RuntimeApi.runEval.arguments",
    outputSchemaRef: "EvalVerdictSchema",
    requiredScopes: ["eval:run"]
  }),
  enabledBinding({
    name: "specwright_record_evidence",
    description: "Record evidence through RuntimeApi.recordEvidence.",
    runtimeOperation: "recordEvidence",
    mutates: true,
    inputParser: recordEvidenceArgumentsSchema,
    inputSchemaRef: "RuntimeApi.recordEvidence.arguments",
    outputSchemaRef: "EvidenceRecordSchema",
    requiredScopes: ["evidence:write"]
  }),
  enabledBinding({
    name: "specwright_record_artifact",
    description: "Record an artifact through RuntimeApi.recordArtifact.",
    runtimeOperation: "recordArtifact",
    mutates: true,
    inputParser: recordArtifactArgumentsSchema,
    inputSchemaRef: "RuntimeApi.recordArtifact.arguments.ArtifactRecordInput",
    outputSchemaRef: "ArtifactRecordSchema",
    requiredScopes: ["artifact:write"]
  }),
  enabledBinding({
    name: "specwright_evaluate_gate",
    description: "Evaluate a lifecycle gate through RuntimeApi.evaluateGate.",
    runtimeOperation: "evaluateGate",
    mutates: true,
    inputParser: evaluateGateArgumentsSchema,
    inputSchemaRef: "RuntimeApi.evaluateGate.arguments",
    outputSchemaRef: "GateEvaluationResult",
    requiredScopes: ["gate:evaluate"]
  }),
  enabledBinding({
    name: "specwright_generate_report",
    description: "Generate a derived run report through RuntimeApi.generateReport.",
    runtimeOperation: "generateReport",
    mutates: false,
    inputParser: generateReportArgumentsSchema,
    inputSchemaRef: "RuntimeApi.generateReport.arguments",
    outputSchemaRef: "RunReport",
    requiredScopes: ["report:read"]
  }),
  enabledBinding({
    name: "specwright_write_report",
    description: "Write a run report through RuntimeApi.writeRunReport.",
    runtimeOperation: "writeRunReport",
    mutates: true,
    inputParser: writeReportArgumentsSchema,
    inputSchemaRef: "RuntimeApi.writeRunReport.arguments",
    outputSchemaRef: "RunReport",
    requiredScopes: ["report:write"]
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
    list(request?: McpTransportCredentialRequest): MaybePromise<McpToolsListResponse>;
    call(request: McpToolsCallRequest): Promise<McpToolsCallResponse>;
  };
  resources: {
    list(request?: McpResourcesListRequest): MaybePromise<McpResourcesListResponse>;
    read(request: McpResourcesReadRequest): Promise<McpResourcesReadResponse>;
  };
  prompts: {
    list(request?: McpTransportCredentialRequest): MaybePromise<McpPromptsListResponse>;
    get(request: McpPromptsGetRequest): MaybePromise<McpPromptsGetResponse>;
  };
  observability?: {
    openSession(): Promise<void>;
    closeSession(): Promise<void>;
    metrics(): McpMetricsRegistry | undefined;
  } | undefined;
  dispatch(request: McpProtocolRequest): Promise<McpProtocolResponse>;
};

export function createMcpAdapter(
  runtime: RuntimeApi,
  options: {
    catalog?: McpCatalog | readonly McpToolBinding[] | undefined;
    resourceCatalog?: McpResourceCatalog | readonly McpResourceBinding[] | undefined;
    promptCatalog?: McpPromptCatalog | readonly McpPromptBinding[] | undefined;
    applyEgressRedaction?: McpEgressRedaction | undefined;
    auth?: McpAuthOptions | undefined;
    observability?: McpObservabilityOptions | undefined;
  } = {}
): McpAdapter {
  const catalog = normalizeCatalog(options.catalog);
  const resourceCatalog = normalizeResourceCatalog(options.resourceCatalog);
  const promptCatalog = normalizePromptCatalog(options.promptCatalog);
  const redact = options.applyEgressRedaction ?? applyEgressRedaction;
  const security = normalizeMcpSecurity(options.auth);
  const observability = normalizeMcpObservability(options.observability);

  const adapter: McpAdapter = {
    tools: {
      list(request = {}) {
        return listMcpTools(catalog, request, security, observability);
      },
      async call(request) {
        return callMcpTool(
          runtime,
          catalog,
          request,
          redact,
          security,
          observability
        );
      }
    },
    resources: {
      list(request = {}) {
        return listMcpResources(resourceCatalog, request, security, observability);
      },
      async read(request) {
        return readMcpResource(
          runtime,
          resourceCatalog,
          request,
          redact,
          security,
          observability
        );
      }
    },
    prompts: {
      list(request = {}) {
        return listMcpPrompts(
          promptCatalog,
          catalog,
          request,
          security,
          observability
        );
      },
      get(request) {
        return getMcpPrompt(
          promptCatalog,
          catalog,
          request,
          redact,
          security,
          observability
        );
      }
    },
    async dispatch(request) {
      return dispatchMcpRequest(
        runtime,
        catalog,
        resourceCatalog,
        promptCatalog,
        redact,
        security,
        observability,
        request
      );
    }
  };

  if (observability !== undefined) {
    adapter.observability = {
      openSession() {
        return openMcpObservedSession(observability);
      },
      closeSession() {
        return closeMcpObservedSession(observability);
      },
      metrics() {
        return observability.metrics;
      }
    };
  }

  return adapter;
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
      gatedRuntimeOperationNames.has(String(binding.runtimeOperation))
    ) {
      throw new McpCatalogError(
        "gated_runtime_operation_enabled",
        `Runtime operation ${String(binding.runtimeOperation)} is gated and cannot be enabled.`
      );
    }

    if (binding.enabled) {
      if (!runtimeOperationNameSet.has(String(binding.runtimeOperation))) {
        throw new McpCatalogError(
          "unknown_runtime_operation",
          `Runtime operation ${String(binding.runtimeOperation)} is not exported by RuntimeApi.`
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

export function applyEgressRedaction(
  payload: unknown,
  context: McpEgressRedactionContext
): unknown {
  return redactEgressValue(payload, {
    surface: context.surface,
    path: [],
    inheritedClass: undefined,
    egressClasses: context.classes
  }).value;
}

type NormalizedMcpSecurity =
  | {
      mode: "disabled";
    }
  | {
      mode: "authenticated";
      credentialVerifier?: ClientCredentialVerifier | undefined;
      subjectVerifier?: SubjectVerifier | undefined;
      requireSubject: boolean;
      policyBundle?: unknown;
      tenantResolver?: McpTenantResolver | undefined;
    };

type NormalizedMcpObservability = {
  rootDir?: string | undefined;
  session: {
    sessionId: string;
    clientId: string;
    subjectId: string;
    tenantId: string;
    grantedScopes: readonly string[];
    runMode: McpClientRunMode;
    transport: string;
    protocolVersion: string;
  };
  auditWriter: McpAuditWriter;
  markerWriter: McpAuditWriter;
  spanWriter: McpSpanWriter;
  metrics?: McpMetricsRegistry | undefined;
  correlation: McpCorrelationFactory;
  opened: boolean;
  requestCount: number;
  denialCount: number;
  openedAt?: string | undefined;
};

type AuthorizationResult =
  | {
      kind: "disabled";
    }
  | {
      kind: "authenticated";
      context: AuthorizationContext;
    }
  | {
      kind: "error";
      response: McpErrorResponse;
    };

function normalizeMcpSecurity(
  options: McpAuthOptions | undefined
): NormalizedMcpSecurity {
  if (options?.mode !== "authenticated") {
    return {
      mode: "disabled"
    };
  }

  return {
    mode: "authenticated",
    credentialVerifier: options.credentialVerifier,
    subjectVerifier: options.subjectVerifier,
    requireSubject: options.requireSubject ?? true,
    policyBundle: options.policyBundle,
    tenantResolver: options.tenantResolver
  };
}

function normalizeMcpObservability(
  options: McpObservabilityOptions | undefined
): NormalizedMcpObservability | undefined {
  if (options === undefined) {
    return undefined;
  }

  const correlation = createMcpCorrelationFactory({
    clock: options.clock,
    idFactory: options.idFactory
  });
  const sessionId = options.session?.sessionId ?? correlation.sessionId();
  const writer =
    options.auditWriter ??
    createMcpAuditWriter({
      rootDir: options.rootDir
    });

  return {
    rootDir: options.rootDir,
    session: {
      sessionId,
      clientId: options.session?.clientId ?? "client.unspecified",
      subjectId: options.session?.subjectId ?? "subject.unspecified",
      tenantId: options.session?.tenantId ?? "tenant.unspecified",
      grantedScopes: options.session?.grantedScopes ?? [],
      runMode: options.session?.runMode ?? "assisted",
      transport: options.session?.transport ?? "unknown",
      protocolVersion: options.session?.protocolVersion ?? "unknown"
    },
    auditWriter: writer,
    markerWriter: options.markerWriter ?? writer,
    spanWriter:
      options.spanWriter ??
      createMcpSpanWriter({
        rootDir: options.rootDir
      }),
    metrics: options.metrics,
    correlation,
    opened: false,
    requestCount: 0,
    denialCount: 0
  };
}

async function openMcpObservedSession(observability: NormalizedMcpObservability) {
  if (observability.opened) {
    return;
  }

  const timestamp = observability.correlation.now();
  observability.opened = true;
  observability.openedAt = timestamp;
  setMcpActiveSessionsMetric({
    metrics: observability.metrics,
    tenantId: observability.session.tenantId,
    value: 1
  });

  await observability.auditWriter.write({
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: observability.correlation.recordId(),
    type: "mcp.session.opened",
    timestamp,
    sessionId: observability.session.sessionId,
    clientId: observability.session.clientId,
    subjectId: observability.session.subjectId,
    tenantId: observability.session.tenantId,
    grantedScopes: [...observability.session.grantedScopes],
    runMode: observability.session.runMode,
    transport: observability.session.transport,
    protocolVersion: observability.session.protocolVersion,
    principal: principalForSession(observability)
  });
}

async function closeMcpObservedSession(
  observability: NormalizedMcpObservability
) {
  const timestamp = observability.correlation.now();
  const openedAt = observability.openedAt ?? timestamp;
  observability.opened = false;
  setMcpActiveSessionsMetric({
    metrics: observability.metrics,
    tenantId: observability.session.tenantId,
    value: 0
  });

  await observability.auditWriter.write({
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: observability.correlation.recordId(),
    type: "mcp.session.closed",
    timestamp,
    sessionId: observability.session.sessionId,
    clientId: observability.session.clientId,
    subjectId: observability.session.subjectId,
    tenantId: observability.session.tenantId,
    durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(openedAt)),
    requestCount: observability.requestCount,
    denialCount: observability.denialCount,
    principal: principalForSession(observability)
  });
}

type ObservedRequest = {
  mcpRequestId: string;
  spanId: string;
  startedAt: string;
  operation: string;
  target: string;
  argsHash: string;
  principal: McpAuditPrincipal;
};

async function beginObservedRequest(input: {
  observability: NormalizedMcpObservability;
  operation: string;
  target: string;
  args: unknown;
  principal?: McpAuditPrincipal | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  idempotencyKey?: string | undefined;
  expectedLastEventId?: string | undefined;
}): Promise<ObservedRequest> {
  const observed = {
    mcpRequestId: input.observability.correlation.mcpRequestId(),
    spanId: input.observability.correlation.spanId(),
    startedAt: input.observability.correlation.now(),
    operation: input.operation,
    target: input.target,
    argsHash: hashMcpArgs(input.args),
    principal: input.principal ?? principalForSession(input.observability)
  };
  const record: McpRequestReceived = {
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: input.observability.correlation.recordId(),
    type: "mcp.request.received",
    timestamp: observed.startedAt,
    sessionId: input.observability.session.sessionId,
    mcpRequestId: observed.mcpRequestId,
    operation: input.operation,
    target: input.target,
    argsHash: observed.argsHash,
    principal: observed.principal,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey }),
    ...(input.expectedLastEventId === undefined
      ? {}
      : { expectedLastEventId: input.expectedLastEventId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId })
  };

  await input.observability.auditWriter.write(record);
  input.observability.requestCount += 1;

  return observed;
}

async function observeReadOnlyOperation<TResponse extends McpProtocolResponse>(
  input: {
    observability: NormalizedMcpObservability;
    operation: string;
    target: string;
    args: unknown;
    runId?: string | undefined;
    perform(): TResponse | Promise<TResponse>;
    resourceAudit?:
      | ((response: TResponse, observed: ObservedRequest) => McpResourceRead | undefined)
      | undefined;
  }
): Promise<TResponse> {
  let observed: ObservedRequest;
  const failures: string[] = [];

  try {
    observed = await beginObservedRequest({
      observability: input.observability,
      operation: input.operation,
      target: input.target,
      args: input.args,
      runId: input.runId
    });
  } catch (error) {
    failures.push(`request_audit:${messageFromUnknown(error)}`);
    observed = {
      mcpRequestId: input.observability.correlation.mcpRequestId(),
      spanId: input.observability.correlation.spanId(),
      startedAt: input.observability.correlation.now(),
      operation: input.operation,
      target: input.target,
      argsHash: hashMcpArgs(input.args),
      principal: principalForSession(input.observability)
    };
  }

  const response = await input.perform();
  const endedAt = input.observability.correlation.now();
  const responseError = isMcpErrorResponse(response)
    ? response.error.code
    : undefined;

  if (responseError !== undefined) {
    try {
      await recordObservedDenial({
        observability: input.observability,
        observed,
        code: responseError,
        gate: "adapter",
        target: input.target
      });
    } catch (error) {
      failures.push(`denial_audit:${messageFromUnknown(error)}`);
    }
  }

  const resourceRecord = input.resourceAudit?.(response, observed);

  if (resourceRecord !== undefined) {
    try {
      await input.observability.auditWriter.write(resourceRecord);
      recordMcpRedactionMetric({
        metrics: input.observability.metrics,
        redactionProfile: resourceRecord.redactionProfile,
        resourceUri: resourceRecord.resourceUri,
        count: resourceRecord.fieldsRedactedCount
      });
    } catch (error) {
      failures.push(`resource_audit:${messageFromUnknown(error)}`);
    }
  }

  try {
    await input.observability.spanWriter.recordParentSpan({
      rootDir: input.observability.rootDir,
      runId: input.runId ?? sessionTraceRunId(input.observability.session.sessionId),
      spanId: observed.spanId,
      name: `mcp.${input.operation}`,
      status: mcpSpanStatusForOutcome({
        isError: responseError !== undefined,
        code: responseError
      }),
      startedAt: observed.startedAt,
      endedAt,
      eventIds: [],
      metadata: {
        mcpRequestId: observed.mcpRequestId,
        clientId: observed.principal.clientId,
        subjectId: observed.principal.subjectId,
        tenantId: observed.principal.tenantId,
        runId: input.runId,
        target: input.target
      }
    });
  } catch (error) {
    failures.push(`span:${messageFromUnknown(error)}`);
  }

  if (failures.length > 0) {
    const marker = await markObservedProvenanceGap({
      observability: input.observability,
      observed,
      runId: input.runId,
      operation: input.operation,
      stage: "read_observation",
      reason: failures.join("; "),
      partialWrites: failures
    });

    if (marker.status !== "written") {
      return readOnlyProvenanceGapResponse(
        input.operation,
        createProvenanceGapError(messageFromUnknown(marker.error))
      ) as TResponse;
    }
  }

  recordMcpRequestMetric({
    metrics: input.observability.metrics,
    operation: input.operation,
    clientId: observed.principal.clientId,
    outcome: responseError ?? "success",
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(observed.startedAt))
  });

  return response;
}

async function recordObservedDenial(input: {
  observability: NormalizedMcpObservability;
  observed: ObservedRequest;
  code: string;
  gate: string;
  target?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  policyDecisionRef?: string | undefined;
}) {
  input.observability.denialCount += 1;
  recordMcpDenialMetric({
    metrics: input.observability.metrics,
    denialCode: input.code,
    gate: input.gate,
    clientId: input.observed.principal.clientId
  });

  if (input.code === "approval_required") {
    recordMcpApprovalRequiredMetric({
      metrics: input.observability.metrics,
      toolName: input.target,
      clientId: input.observed.principal.clientId
    });
  }

  if (input.code === "stale_state") {
    recordMcpStaleStateMetric({
      metrics: input.observability.metrics,
      toolName: input.target
    });
  }

  await input.observability.auditWriter.write({
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: input.observability.correlation.recordId(),
    type: "mcp.action.denied",
    timestamp: input.observability.correlation.now(),
    sessionId: input.observability.session.sessionId,
    mcpRequestId: input.observed.mcpRequestId,
    denialCode: input.code,
    gate: input.gate,
    policyDecisionRef:
      input.policyDecisionRef ?? policyDecisionRefForObservedDenial(input),
    principal: input.observed.principal,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId })
  });
}

async function markObservedProvenanceGap(input: {
  observability: NormalizedMcpObservability;
  observed: ObservedRequest;
  runId?: string | undefined;
  traceId?: string | undefined;
  eventIds?: readonly string[] | undefined;
  operation: string;
  stage: string;
  reason: string;
  partialWrites: readonly string[];
}) {
  return writeProvenanceGapMarker(input.observability.markerWriter, {
    recordId: input.observability.correlation.recordId(),
    gapId: input.observability.correlation.gapId(),
    timestamp: input.observability.correlation.now(),
    sessionId: input.observability.session.sessionId,
    mcpRequestId: input.observed.mcpRequestId,
    runId: input.runId,
    traceId: input.traceId,
    eventIds: input.eventIds,
    operation: input.operation,
    stage: input.stage,
    reason: input.reason,
    partialWrites: input.partialWrites,
    principal: input.observed.principal
  });
}

function principalForSession(
  observability: NormalizedMcpObservability
): McpAuditPrincipal {
  return {
    clientId: observability.session.clientId,
    subjectId: observability.session.subjectId,
    tenantId: observability.session.tenantId,
    grantedScopes: [...observability.session.grantedScopes]
  };
}

function principalForAuthorization(
  observability: NormalizedMcpObservability,
  authorization: AuthorizationResult
): McpAuditPrincipal {
  if (authorization.kind !== "authenticated") {
    return principalForSession(observability);
  }

  return {
    clientId: authorization.context.clientPrincipal.clientId,
    subjectId: authorization.context.subject?.subjectId,
    tenantId: authorization.context.clientPrincipal.tenantId,
    grantedScopes: authorization.context.clientPrincipal.grantedScopes
  };
}

function authorizeSync(input: {
  security: NormalizedMcpSecurity;
  request: McpTransportCredentialRequest;
  requestedScopes: readonly string[];
  requireSubject: false;
}): AuthorizationResult {
  if (input.security.mode === "disabled") {
    return {
      kind: "disabled"
    };
  }

  const principal = authenticateClient(input.security, input.request);

  if (principal.kind === "error") {
    return principal;
  }

  const context = composeAuthorizationContext({
    security: input.security,
    principal: principal.principal,
    subject: undefined,
    requestedScopes: input.request.requestedScopes === undefined
      ? input.requestedScopes
      : [...input.requestedScopes, ...input.request.requestedScopes]
  });

  if (context.kind === "error") {
    return context;
  }

  return {
    kind: "authenticated",
    context: context.context
  };
}

async function authorizeAsync(input: {
  security: NormalizedMcpSecurity;
  request: McpTransportCredentialRequest;
  requestedScopes: readonly string[];
  requireSubject: boolean;
  tenantReference?: McpTenantReference | undefined;
}): Promise<AuthorizationResult> {
  if (input.security.mode === "disabled") {
    return {
      kind: "disabled"
    };
  }

  const principal = authenticateClient(input.security, input.request);

  if (principal.kind === "error") {
    return principal;
  }

  const tenant = await assertTenantScope(
    input.security,
    input.tenantReference,
    principal.principal
  );

  if (tenant.kind === "error") {
    return tenant;
  }

  const subject =
    input.requireSubject || input.security.requireSubject
      ? await verifySubject(input.security, input.request, principal.principal)
      : {
          kind: "optional_absent" as const
        };

  if (subject.kind === "error") {
    return subject;
  }

  const context = composeAuthorizationContext({
    security: input.security,
    principal: principal.principal,
    subject:
      subject.kind === "verified" ? subject.subjectEntitlements : undefined,
    requestedScopes: input.request.requestedScopes === undefined
      ? input.requestedScopes
      : [...input.requestedScopes, ...input.request.requestedScopes]
  });

  if (context.kind === "error") {
    return context;
  }

  return {
    kind: "authenticated",
    context: context.context
  };
}

function authenticateClient(
  security: Extract<NormalizedMcpSecurity, { mode: "authenticated" }>,
  request: McpTransportCredentialRequest
):
  | {
      kind: "authenticated";
      principal: ClientPrincipal;
    }
  | {
      kind: "error";
      response: McpErrorResponse;
    } {
  const envelope = credentialRequestSchema.safeParse({
    credential: request.credential,
    subject: request.subject,
    requestedScopes: request.requestedScopes
  });

  if (!envelope.success) {
    return {
      kind: "error",
      response: validationErrorResponse(envelope.error)
    };
  }

  if (security.credentialVerifier === undefined) {
    return authError(
      "incomplete_authorization_context",
      "Authenticated MCP mode requires a configured credential verifier."
    );
  }

  if (envelope.data.credential === undefined) {
    return authError(
      "unauthenticated",
      "Missing MCP transport credential."
    );
  }

  let verified: unknown;

  try {
    verified = security.credentialVerifier(envelope.data.credential);
  } catch {
    return authError("unauthenticated", "MCP transport credential is invalid.");
  }

  if (isPromiseLike(verified)) {
    return authError(
      "incomplete_authorization_context",
      "MCP credential verification must complete before synchronous catalog authorization."
    );
  }

  const parsed = ClientPrincipalSchema.safeParse(verified);

  if (!parsed.success) {
    return authError("unauthenticated", "MCP transport credential is invalid.");
  }

  return {
    kind: "authenticated",
    principal: parsed.data
  };
}

async function verifySubject(
  security: Extract<NormalizedMcpSecurity, { mode: "authenticated" }>,
  request: McpTransportCredentialRequest,
  principal: ClientPrincipal
): Promise<
  | {
      kind: "verified";
      subjectEntitlements: SubjectEntitlements;
    }
  | {
      kind: "error";
      response: McpErrorResponse;
    }
> {
  if (security.subjectVerifier === undefined) {
    return authError(
      "incomplete_authorization_context",
      "Authenticated MCP actions require a configured subject verifier."
    );
  }

  if (request.subject === undefined) {
    return authError(
      "subject_unverifiable",
      "Missing propagated subject claim."
    );
  }

  const claim = SubjectClaimSchema.safeParse(request.subject);

  if (!claim.success) {
    return authError(
      "subject_unverifiable",
      "Propagated subject claim is malformed."
    );
  }

  if (
    claim.data.tenantId !== undefined &&
    claim.data.tenantId !== principal.tenantId
  ) {
    return authError(
      "subject_unverifiable",
      "Propagated subject claim is not valid for this tenant."
    );
  }

  let verified: SubjectEntitlements | null | false;

  try {
    verified = await security.subjectVerifier(claim.data, principal);
  } catch {
    return authError(
      "subject_unverifiable",
      "Propagated subject claim could not be verified."
    );
  }

  if (verified === null || verified === false) {
    return authError(
      "subject_unverifiable",
      "Propagated subject claim could not be verified."
    );
  }

  const entitlements = SubjectEntitlementsSchema.safeParse(verified);

  if (!entitlements.success) {
    return authError(
      "subject_unverifiable",
      "Propagated subject entitlements are malformed."
    );
  }

  if (
    entitlements.data.subjectId !== claim.data.subjectId ||
    entitlements.data.tenantId !== principal.tenantId
  ) {
    return authError(
      "subject_unverifiable",
      "Propagated subject entitlements do not match the verified principal."
    );
  }

  return {
    kind: "verified",
    subjectEntitlements: entitlements.data
  };
}

async function assertTenantScope(
  security: Extract<NormalizedMcpSecurity, { mode: "authenticated" }>,
  reference: McpTenantReference | undefined,
  principal: ClientPrincipal
): Promise<
  | {
      kind: "ok";
    }
  | {
      kind: "error";
      response: McpErrorResponse;
    }
> {
  if (reference === undefined || security.tenantResolver === undefined) {
    return {
      kind: "ok"
    };
  }

  let ownerTenantId: string | undefined;

  try {
    ownerTenantId = await security.tenantResolver(reference, principal);
  } catch {
    return authError(
      "tenant_mismatch",
      "Requested reference is not available to the authenticated principal."
    );
  }

  if (ownerTenantId !== undefined && ownerTenantId !== principal.tenantId) {
    return authError(
      "tenant_mismatch",
      "Requested reference is not available to the authenticated principal."
    );
  }

  return {
    kind: "ok"
  };
}

function composeAuthorizationContext(input: {
  security: Extract<NormalizedMcpSecurity, { mode: "authenticated" }>;
  principal: ClientPrincipal;
  subject: SubjectEntitlements | undefined;
  requestedScopes: readonly string[];
}):
  | {
      kind: "ok";
      context: AuthorizationContext;
    }
  | {
      kind: "error";
      response: McpErrorResponse;
    } {
  const requestedScopes = uniqueSortedScopes(input.requestedScopes);
  const subjectScopes = input.subject?.scopes ?? input.principal.grantedScopes;
  const effectiveScopes = intersectScopes(
    input.principal.grantedScopes,
    subjectScopes
  );

  if (!scopesAreSubset(requestedScopes, effectiveScopes)) {
    return authError(
      "scope_exceeded",
      "Requested scopes exceed the authenticated client and subject intersection."
    );
  }

  const sourceTrust = {
    ...(input.subject?.sourceTrust ?? {}),
    mcp: {
      clientId: input.principal.clientId,
      tenantId: input.principal.tenantId,
      grantedScopes: uniqueSortedScopes(input.principal.grantedScopes),
      subjectId: input.subject?.subjectId,
      subjectScopes: input.subject?.scopes,
      requestedScopes,
      effectiveScopes
    }
  };
  const contextLike = {
    clientPrincipal: input.principal,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    requestedScopes,
    effectiveScopes,
    toolContext: {
      runMode: input.principal.runMode,
      ...(input.security.policyBundle === undefined
        ? {}
        : { policyBundle: input.security.policyBundle }),
      snapshots: {
        sourceTrust
      }
    }
  };
  const parsed = AuthorizationContextSchema.safeParse(contextLike);

  if (!parsed.success) {
    return authError(
      "incomplete_authorization_context",
      "MCP authorization context could not be constructed."
    );
  }

  return {
    kind: "ok",
    context: parsed.data
  };
}

function intersectScopes(
  clientScopes: readonly string[],
  subjectScopes: readonly string[]
) {
  const subjectScopeSet = new Set(subjectScopes);
  return uniqueSortedScopes(clientScopes.filter((scope) => subjectScopeSet.has(scope)));
}

function uniqueSortedScopes(scopes: readonly string[]) {
  return [...new Set(scopes)].sort();
}

function scopesAreSubset(
  requestedScopes: readonly string[],
  effectiveScopes: readonly string[]
) {
  const effectiveScopeSet = new Set(effectiveScopes);
  return requestedScopes.every((scope) => effectiveScopeSet.has(scope));
}

function authError(code: string, message: string): {
  kind: "error";
  response: McpErrorResponse;
} {
  return {
    kind: "error",
    response: errorResponse({
      code,
      message,
      retryable: false,
      operatorAction: operatorActionForCode(code)
    })
  };
}

function requiredScopesForResource(
  binding: McpResourceBinding
): readonly string[] {
  return binding.id === "harness-spec" ? ["harness:read"] : ["run:read"];
}

function tenantReferenceForRuntimeArgs(
  binding: EnabledMcpToolBinding,
  args: unknown
): McpTenantReference | undefined {
  const runId = readStringProperty(args, "runId");

  if (runId === undefined) {
    return undefined;
  }

  return {
    kind: "tool",
    name: binding.name,
    runId
  };
}

type ParsedCallToolOptions = {
  rootDir?: string | undefined;
  cwd?: string | undefined;
  traceId?: string | undefined;
  toolContext?: Record<string, unknown> | undefined;
} | undefined;

function bindToolContext(
  options: ParsedCallToolOptions,
  authorization: AuthorizationContext | undefined
): RuntimeToolCallOptions | undefined {
  if (authorization === undefined) {
    return options;
  }

  return {
    ...(options?.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.traceId === undefined ? {} : { traceId: options.traceId }),
    toolContext: authorization.toolContext as RuntimeToolCallOptions["toolContext"]
  };
}

function listMcpTools(
  catalog: McpCatalog,
  request: McpTransportCredentialRequest,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined
): MaybePromise<McpToolsListResponse> {
  if (observability !== undefined) {
    return observeReadOnlyOperation({
      observability,
      operation: "tools/list",
      target: "tools",
      args: request,
      perform: () => listMcpTools(catalog, request, security, undefined)
    });
  }

  const authorization = authorizeSync({
    security,
    request,
    requestedScopes: [],
    requireSubject: false
  });

  if (authorization.kind === "error") {
    return {
      ...authorization.response,
      tools: []
    };
  }

  const bindings =
    authorization.kind === "disabled"
      ? catalog.enabledBindings
      : catalog.enabledBindings.filter((binding) =>
          scopesAreSubset(binding.requiredScopes ?? [], authorization.context.effectiveScopes)
        );

  return {
    tools: bindings.map(descriptorForBinding)
  };
}

function listMcpResources(
  catalog: McpResourceCatalog,
  request: McpResourcesListRequest,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined
): MaybePromise<McpResourcesListResponse> {
  if (observability !== undefined) {
    return observeReadOnlyOperation({
      observability,
      operation: "resources/list",
      target: "resources",
      args: request,
      perform: () => listMcpResources(catalog, request, security, undefined)
    });
  }

  const parsedRequest = resourcesListRequestSchema.safeParse(request);

  if (!parsedRequest.success) {
    return {
      ...validationErrorResponse(parsedRequest.error),
      resources: []
    };
  }

  const authorization = authorizeSync({
    security,
    request: parsedRequest.data,
    requestedScopes: [],
    requireSubject: false
  });

  if (authorization.kind === "error") {
    return {
      ...authorization.response,
      resources: []
    };
  }

  const bindings = filterResourcesForPrincipal(
    parsedRequest.data.principal as McpClientPrincipal | undefined,
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
  redact: McpEgressRedaction,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined
): Promise<McpResourcesReadResponse> {
  if (observability !== undefined) {
    const uri = isRecord(request) && typeof request.uri === "string"
      ? request.uri
      : "unknown";
    const runId = runIdFromResourceUri(uri);

    return observeReadOnlyOperation({
      observability,
      operation: "resources/read",
      target: uri,
      args: request,
      runId,
      perform: () =>
        readMcpResource(runtime, catalog, request, redact, security, undefined),
      resourceAudit(response, observed) {
        if (response.isError) {
          return undefined;
        }

        const redactionProfile = [
          response.metadata.authorityClass,
          response.metadata.payloadSchemaRef
        ].join(":");
        return {
          schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
          recordId: observability.correlation.recordId(),
          type: "mcp.resource.read",
          timestamp: observability.correlation.now(),
          sessionId: observability.session.sessionId,
          mcpRequestId: observed.mcpRequestId,
          resourceUri: response.uri,
          redactionProfile,
          fieldsRedactedCount: countHashReferences(response.contents[0].text),
          bytesProjected: response.contents[0].text.length,
          principal: observed.principal,
          ...(runId === undefined ? {} : { runId })
        };
      }
    });
  }

  const parsedRequest = resourcesReadRequestSchema.safeParse(request);

  if (!parsedRequest.success) {
    return validationErrorResponse(parsedRequest.error);
  }

  const matched = matchResourceUri(parsedRequest.data.uri, catalog);

  if (isMcpErrorResponse(matched)) {
    return matched;
  }

  const authorization = await authorizeAsync({
    security,
    request: parsedRequest.data,
    requestedScopes: requiredScopesForResource(matched.binding),
    requireSubject: true,
    tenantReference:
      matched.runId === undefined
        ? undefined
        : {
            kind: "resource",
            uri: parsedRequest.data.uri,
            runId: matched.runId
          }
  });

  if (authorization.kind === "error") {
    return authorization.response;
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
      surface: "resource",
      resource,
      uri: parsedRequest.data.uri,
      clientPrincipal:
        authorization.kind === "authenticated"
          ? authorization.context.clientPrincipal
          : undefined,
      subject:
        authorization.kind === "authenticated"
          ? authorization.context.subject
          : undefined,
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

function listMcpPrompts(
  catalog: McpPromptCatalog,
  toolCatalog: McpCatalog,
  request: McpTransportCredentialRequest,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined
): MaybePromise<McpPromptsListResponse> {
  if (observability !== undefined) {
    return observeReadOnlyOperation({
      observability,
      operation: "prompts/list",
      target: "prompts",
      args: request,
      perform: () =>
        listMcpPrompts(catalog, toolCatalog, request, security, undefined)
    });
  }

  const authorization = authorizeSync({
    security,
    request,
    requestedScopes: [],
    requireSubject: false
  });

  if (authorization.kind === "error") {
    return {
      ...authorization.response,
      prompts: []
    };
  }

  const bindings =
    authorization.kind === "authenticated"
      ? catalog.bindings.filter((binding) => {
          const tool = toolCatalog.byName.get(binding.toolName);

          return (
            tool !== undefined &&
            (!tool.enabled ||
              scopesAreSubset(
                tool.requiredScopes ?? [],
                authorization.context.effectiveScopes
              ))
          );
        })
      : catalog.bindings;

  return {
    prompts: bindings.map((binding) => ({
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
  request: McpPromptsGetRequest,
  redact: McpEgressRedaction,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined
): MaybePromise<McpPromptsGetResponse> {
  if (observability !== undefined) {
    const target = isRecord(request) && typeof request.name === "string"
      ? request.name
      : "unknown";

    return observeReadOnlyOperation({
      observability,
      operation: "prompts/get",
      target,
      args: request,
      perform: () =>
        getMcpPrompt(catalog, toolCatalog, request, redact, security, undefined)
    });
  }

  const parsedRequest = promptsGetRequestSchema.safeParse(request);

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

  const authorization = authorizeSync({
    security,
    request: parsedRequest.data,
    requestedScopes: [
      ...(tool.requiredScopes ?? []),
      ...(parsedRequest.data.requestedScopes ?? [])
    ],
    requireSubject: false
  });

  if (authorization.kind === "error") {
    return authorization.response;
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
  const response: McpPromptsGetResponse = {
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

  return redactPromptResponseSync(response, redact, {
    surface: "prompt",
    promptName: binding.name,
    clientPrincipal:
      authorization.kind === "authenticated"
        ? authorization.context.clientPrincipal
        : undefined,
    subject:
      authorization.kind === "authenticated"
        ? authorization.context.subject
        : undefined,
    classes: ["prompt", binding.name]
  });
}

async function dispatchMcpRequest(
  runtime: RuntimeApi,
  catalog: McpCatalog,
  resourceCatalog: McpResourceCatalog,
  promptCatalog: McpPromptCatalog,
  redact: McpEgressRedaction,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined,
  request: McpProtocolRequest
): Promise<McpProtocolResponse> {
  const parsedRequest = protocolRequestSchema.safeParse(request);

  if (!parsedRequest.success) {
    const response = validationErrorResponse(parsedRequest.error);

    if (observability === undefined) {
      return response;
    }

    return observeReadOnlyOperation({
      observability,
      operation: "protocol/invalid",
      target: "invalid",
      args: request,
      perform: () => response
    });
  }

  switch (parsedRequest.data.method) {
    case "tools/list":
      return listMcpTools(
        catalog,
        isRecord(parsedRequest.data.params)
          ? (parsedRequest.data.params as McpTransportCredentialRequest)
          : {},
        security,
        observability
      );
    case "tools/call":
      return callMcpTool(
        runtime,
        catalog,
        parsedRequest.data.params as McpToolsCallRequest,
        redact,
        security,
        observability
      );
    case "resources/list":
      return listMcpResources(
        resourceCatalog,
        isRecord(parsedRequest.data.params)
          ? (parsedRequest.data.params as McpResourcesListRequest)
          : {},
        security,
        observability
      );
    case "resources/read":
      return readMcpResource(
        runtime,
        resourceCatalog,
        parsedRequest.data.params as McpResourcesReadRequest,
        redact,
        security,
        observability
      );
    case "prompts/list":
      return listMcpPrompts(
        promptCatalog,
        catalog,
        isRecord(parsedRequest.data.params)
          ? (parsedRequest.data.params as McpTransportCredentialRequest)
          : {},
        security,
        observability
      );
    case "prompts/get":
      return getMcpPrompt(
        promptCatalog,
        catalog,
        parsedRequest.data.params as McpPromptsGetRequest,
        redact,
        security,
        observability
      );
    default:
      const response = errorResponse({
        code: "method_not_found",
        message: `MCP method ${parsedRequest.data.method} is not registered.`,
        retryable: false
      });

      if (observability === undefined) {
        return response;
      }

      return observeReadOnlyOperation({
        observability,
        operation: parsedRequest.data.method,
        target: parsedRequest.data.method,
        args: parsedRequest.data.params ?? {},
        perform: () => response
      });
  }
}

async function callMcpTool(
  runtime: RuntimeApi,
  catalog: McpCatalog,
  request: McpToolsCallRequest,
  redact: McpEgressRedaction,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability | undefined
): Promise<McpToolsCallResponse> {
  if (observability !== undefined) {
    return callMcpToolObserved(
      runtime,
      catalog,
      request,
      redact,
      security,
      observability
    );
  }

  const parsedRequest = toolsCallRequestSchema.safeParse(request);

  if (!parsedRequest.success) {
    return validationErrorResponse(parsedRequest.error);
  }

  const binding = catalog.byName.get(parsedRequest.data.name);

  if (binding === undefined) {
    return errorResponse({
      code: "method_not_found",
      message: `MCP tool ${parsedRequest.data.name} is not registered.`,
      retryable: false
    });
  }

  if (!binding.enabled) {
    return errorResponse({
      code: "invalid_request",
      message: `MCP tool ${parsedRequest.data.name} is disabled.`,
      retryable: false
    });
  }

  const parsed = binding.inputParser.safeParse(parsedRequest.data.arguments ?? {});

  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  const authorization = await authorizeAsync({
    security,
    request: parsedRequest.data,
    requestedScopes: [
      ...(binding.requiredScopes ?? []),
      ...(parsedRequest.data.requestedScopes ?? [])
    ],
    requireSubject: true,
    tenantReference: tenantReferenceForRuntimeArgs(binding, parsed.data)
  });

  if (authorization.kind === "error") {
    return redactToolResponseIfNeeded(
      authorization.response,
      redact,
      redactionContextForTool({
        binding,
        authorization,
        errorCode: authorization.response.error.code
      })
    );
  }

  try {
    const result = await invokeRuntime(
      runtime,
      binding.runtimeOperation,
      parsed.data,
      authorization.kind === "authenticated" ? authorization.context : undefined
    );

    return await redactToolResponseIfNeeded(
      resultForRuntimeValue(result),
      redact,
      redactionContextForTool({
        binding,
        authorization
      })
    );
  } catch (error) {
    if (isZodError(error)) {
      return validationErrorResponse(error);
    }

    return redactToolResponseIfNeeded(
      errorResponse({
        code: "invalid_request",
        message: error instanceof Error ? error.message : "Runtime call failed.",
        retryable: false
      }),
      redact,
      redactionContextForTool({
        binding,
        authorization,
        errorCode: "invalid_request"
      })
    );
  }
}

async function callMcpToolObserved(
  runtime: RuntimeApi,
  catalog: McpCatalog,
  request: McpToolsCallRequest,
  redact: McpEgressRedaction,
  security: NormalizedMcpSecurity,
  observability: NormalizedMcpObservability
): Promise<McpToolsCallResponse> {
  const parsedRequest = toolsCallRequestSchema.safeParse(request);
  const target = isRecord(request) && typeof request.name === "string"
    ? request.name
    : "unknown";

  if (!parsedRequest.success) {
    return observeToolCallFailure({
      observability,
      operation: "tools/call",
      target,
      args: request,
      response: validationErrorResponse(parsedRequest.error)
    });
  }

  const binding = catalog.byName.get(parsedRequest.data.name);

  if (binding === undefined) {
    return observeToolCallFailure({
      observability,
      operation: "tools/call",
      target: parsedRequest.data.name,
      args: parsedRequest.data.arguments ?? {},
      response: errorResponse({
        code: "method_not_found",
        message: `MCP tool ${parsedRequest.data.name} is not registered.`,
        retryable: false
      })
    });
  }

  if (!binding.enabled) {
    return observeToolCallFailure({
      observability,
      operation: "tools/call",
      target: parsedRequest.data.name,
      args: parsedRequest.data.arguments ?? {},
      response: errorResponse({
        code: "invalid_request",
        message: `MCP tool ${parsedRequest.data.name} is disabled.`,
        retryable: false
      })
    });
  }

  const parsed = binding.inputParser.safeParse(parsedRequest.data.arguments ?? {});

  if (!parsed.success) {
    return observeToolCallFailure({
      observability,
      operation: "tools/call",
      target: binding.name,
      args: parsedRequest.data.arguments ?? {},
      response: validationErrorResponse(parsed.error),
      mutates: binding.mutates
    });
  }

  const authorization = await authorizeAsync({
    security,
    request: parsedRequest.data,
    requestedScopes: [
      ...(binding.requiredScopes ?? []),
      ...(parsedRequest.data.requestedScopes ?? [])
    ],
    requireSubject: true,
    tenantReference: tenantReferenceForRuntimeArgs(binding, parsed.data)
  });
  const principal = principalForAuthorization(observability, authorization);
  const runId = runIdForRuntimeArgs(binding.runtimeOperation, parsed.data);
  const rootDir = rootDirForRuntimeArgs(binding.runtimeOperation, parsed.data);

  if (authorization.kind === "error") {
    const response = await redactToolResponseIfNeeded(
      authorization.response,
      redact,
      redactionContextForTool({
        binding,
        authorization,
        errorCode: authorization.response.error.code
      })
    );

    return observeToolCallFailure({
      observability,
      operation: "tools/call",
      target: binding.name,
      args: parsed.data,
      response,
      mutates: binding.mutates,
      runId,
      principal
    });
  }

  let observed: ObservedRequest;

  try {
    observed = await beginObservedRequest({
      observability,
      operation: "tools/call",
      target: binding.name,
      args: parsed.data,
      principal,
      runId,
      idempotencyKey: idempotencyKeyForRuntimeArgs(
        binding.runtimeOperation,
        parsed.data
      ),
      expectedLastEventId: expectedLastEventIdForRuntimeArgs(parsed.data)
    });
  } catch (error) {
    if (binding.mutates) {
      return provenanceGapResponse(
        createProvenanceGapError(messageFromUnknown(error))
      );
    }

    observed = {
      mcpRequestId: observability.correlation.mcpRequestId(),
      spanId: observability.correlation.spanId(),
      startedAt: observability.correlation.now(),
      operation: "tools/call",
      target: binding.name,
      argsHash: hashMcpArgs(parsed.data),
      principal
    };
  }

  const beforeEvents =
    binding.mutates && runId !== undefined
      ? await readEventsSafely(runtime, runId, rootDir)
      : [];

  let runtimeResult: unknown;

  try {
    runtimeResult = await invokeRuntime(
      runtime,
      binding.runtimeOperation,
      parsed.data,
      authorization.kind === "authenticated" ? authorization.context : undefined
    );
  } catch (error) {
    const response = isZodError(error)
      ? validationErrorResponse(error)
      : await redactToolResponseIfNeeded(
          errorResponse({
            code: "invalid_request",
            message:
              error instanceof Error ? error.message : "Runtime call failed.",
            retryable: false
          }),
          redact,
          redactionContextForTool({
            binding,
            authorization,
            errorCode: "invalid_request"
          })
        );

    await completeObservedToolCall({
      observability,
      observed,
      binding,
      response,
      runId,
      rootDir,
      eventIds: [],
      traceId: undefined,
      runtimeResult: undefined,
      failClosed: false
    });
    return response;
  }

  const actualRunId = runIdForRuntimeResult(runtimeResult) ?? runId;
  const actualRootDir = rootDirForRuntimeResult(runtimeResult) ?? rootDir;
  const afterEventsResult =
    actualRunId === undefined
      ? eventReadSuccess([])
      : await readEventsResult(runtime, actualRunId, actualRootDir);
  const afterEvents =
    afterEventsResult.status === "success" ? afterEventsResult.events : [];
  const eventIds = eventIdsForRuntimeResult(
    runtimeResult,
    beforeEvents,
    afterEvents
  );
  const traceId =
    traceIdForRuntimeResult(runtimeResult) ??
    traceIdForEventIds(afterEvents, eventIds);
  const response = await redactToolResponseIfNeeded(
    resultForRuntimeValue(runtimeResult),
    redact,
    redactionContextForTool({
      binding,
      authorization
    })
  );

  const completed = await completeObservedToolCall({
    observability,
    observed,
    binding,
    response,
    runId: actualRunId,
    rootDir: actualRootDir,
    eventIds,
    traceId,
    runtimeResult,
    eventCorrelationFailure:
      afterEventsResult.status === "failed"
        ? `event_read:${messageFromUnknown(afterEventsResult.error)}`
        : undefined,
    failClosed: binding.mutates
  });

  return completed ?? response;
}

async function observeToolCallFailure(input: {
  observability: NormalizedMcpObservability;
  operation: string;
  target: string;
  args: unknown;
  response: McpToolsCallResponse;
  mutates?: boolean | undefined;
  runId?: string | undefined;
  principal?: McpAuditPrincipal | undefined;
}) {
  const failures: string[] = [];
  let observed: ObservedRequest;

  try {
    observed = await beginObservedRequest({
      observability: input.observability,
      operation: input.operation,
      target: input.target,
      args: input.args,
      principal: input.principal,
      runId: input.runId
    });
  } catch (error) {
    if (input.mutates) {
      return provenanceGapResponse(
        createProvenanceGapError(messageFromUnknown(error))
      );
    }

    failures.push(`request_audit:${messageFromUnknown(error)}`);
    observed = {
      mcpRequestId: input.observability.correlation.mcpRequestId(),
      spanId: input.observability.correlation.spanId(),
      startedAt: input.observability.correlation.now(),
      operation: input.operation,
      target: input.target,
      argsHash: hashMcpArgs(input.args),
      principal: input.principal ?? principalForSession(input.observability)
    };
  }

  const code = input.response.isError ? input.response.error.code : "success";

  if (input.response.isError) {
    try {
      await recordObservedDenial({
        observability: input.observability,
        observed,
        code,
        gate: "adapter",
        target: input.target,
        runId: input.runId
      });
    } catch (error) {
      failures.push(`denial_audit:${messageFromUnknown(error)}`);
    }
  }

  try {
    await input.observability.spanWriter.recordParentSpan({
      rootDir: input.observability.rootDir,
      runId: input.runId ?? sessionTraceRunId(input.observability.session.sessionId),
      spanId: observed.spanId,
      name: `mcp.${input.operation}.${input.target}`,
      status: mcpSpanStatusForOutcome({
        isError: input.response.isError,
        code
      }),
      startedAt: observed.startedAt,
      endedAt: input.observability.correlation.now(),
      eventIds: [],
      metadata: {
        mcpRequestId: observed.mcpRequestId,
        clientId: observed.principal.clientId,
        subjectId: observed.principal.subjectId,
        tenantId: observed.principal.tenantId,
        runId: input.runId,
        toolName: input.target
      }
    });
  } catch (error) {
    failures.push(`span:${messageFromUnknown(error)}`);
  }

  if (failures.length > 0) {
    await markObservedProvenanceGap({
      observability: input.observability,
      observed,
      runId: input.runId,
      operation: input.operation,
      stage: "tool_denial_observation",
      reason: failures.join("; "),
      partialWrites: failures
    });
  }

  recordMcpRequestMetric({
    metrics: input.observability.metrics,
    operation: input.operation,
    toolName: input.target,
    clientId: observed.principal.clientId,
    outcome: code,
    durationMs: Math.max(
      0,
      Date.parse(input.observability.correlation.now()) -
        Date.parse(observed.startedAt)
    )
  });

  return input.response;
}

async function completeObservedToolCall(input: {
  observability: NormalizedMcpObservability;
  observed: ObservedRequest;
  binding: EnabledMcpToolBinding;
  response: McpToolsCallResponse;
  runId?: string | undefined;
  rootDir?: string | undefined;
  eventIds: readonly string[];
  traceId?: string | undefined;
  runtimeResult: unknown;
  eventCorrelationFailure?: string | undefined;
  failClosed: boolean;
}): Promise<McpToolsCallResponse | undefined> {
  const failures: string[] = [];
  const endedAt = input.observability.correlation.now();
  const code = input.response.isError ? input.response.error.code : "success";
  const toolResult = parseToolCallResult(input.runtimeResult);
  const actionEventIds = nonEmptyArray(input.eventIds);
  const mutationEventCorrelationFailure =
    input.failClosed && !input.response.isError && actionEventIds === undefined
      ? input.eventCorrelationFailure ??
        "event_correlation:missing_runtime_event_ids"
      : input.eventCorrelationFailure;
  if (mutationEventCorrelationFailure !== undefined) {
    failures.push(mutationEventCorrelationFailure);
  }
  const actionRecord =
    mutationEventCorrelationFailure !== undefined ||
    input.runId === undefined ||
    input.traceId === undefined ||
    actionEventIds === undefined
      ? undefined
      : actionDispatchedRecordFor({
          observability: input.observability,
          observed: input.observed,
          binding: input.binding,
          runId: input.runId,
          eventIds: actionEventIds,
          traceId: input.traceId,
          toolResult
        });

  if (actionRecord !== undefined) {
    try {
      await input.observability.auditWriter.write(actionRecord);
    } catch (error) {
      failures.push(`action_audit:${messageFromUnknown(error)}`);
    }
  } else if (input.failClosed) {
    failures.push("action_audit:missing_run_or_trace_correlation");
  }

  if (input.response.isError) {
    try {
      await recordObservedDenial({
        observability: input.observability,
        observed: input.observed,
        code,
        gate: runtimeDenialGateForCode(code),
        target: input.binding.name,
        runId: input.runId,
        traceId: input.traceId,
        policyDecisionRef: toolResult?.provenance.decisionHash
      });
    } catch (error) {
      failures.push(`denial_audit:${messageFromUnknown(error)}`);
    }
  }

  const externalRecord = externalInvokedRecordFor({
    observability: input.observability,
    observed: input.observed,
    runId: input.runId,
    toolResult,
    runtimeResult: input.runtimeResult
  });

  if (externalRecord !== undefined) {
    try {
      await input.observability.auditWriter.write(externalRecord);
      recordMcpExternalMetric({
        metrics: input.observability.metrics,
        serverId: externalRecord.serverId,
        version: externalRecord.pinnedVersion,
        outcome: input.response.isError ? code : "success",
        errorCode: input.response.isError ? code : undefined
      });
    } catch (error) {
      failures.push(`external_audit:${messageFromUnknown(error)}`);
    }
  }

  try {
    await input.observability.spanWriter.recordParentSpan({
      rootDir: input.rootDir ?? input.observability.rootDir,
      runId: input.runId ?? sessionTraceRunId(input.observability.session.sessionId),
      traceId: input.traceId,
      spanId: input.observed.spanId,
      name: `mcp.tools/call.${input.binding.name}`,
      status: mcpSpanStatusForOutcome({
        isError: input.response.isError,
        code
      }),
      startedAt: input.observed.startedAt,
      endedAt,
      eventIds: input.eventIds,
      metadata: {
        mcpRequestId: input.observed.mcpRequestId,
        clientId: input.observed.principal.clientId,
        subjectId: input.observed.principal.subjectId,
        tenantId: input.observed.principal.tenantId,
        runId: input.runId,
        toolName: input.binding.name,
        runtimeOperation: input.binding.runtimeOperation,
        traceId: input.traceId,
        toolProvenance: toolResult?.provenance
      }
    });

    if (input.runId !== undefined && input.eventIds.length > 0) {
      await input.observability.spanWriter.linkChildSpans({
        rootDir: input.rootDir ?? input.observability.rootDir,
        runId: input.runId,
        parentSpanId: input.observed.spanId,
        eventIds: input.eventIds
      });
    }
  } catch (error) {
    failures.push(`span:${messageFromUnknown(error)}`);
  }

  if (failures.length > 0) {
    await markObservedProvenanceGap({
      observability: input.observability,
      observed: input.observed,
      runId: input.runId,
      traceId: input.traceId,
      eventIds: input.eventIds,
      operation: "tools/call",
      stage: "runtime_dispatch_observation",
      reason: failures.join("; "),
      partialWrites: failures
    });

    if (input.failClosed) {
      return provenanceGapResponse(
        createProvenanceGapError(failures.join("; "))
      );
    }
  }

  recordMcpRequestMetric({
    metrics: input.observability.metrics,
    operation: "tools/call",
    toolName: input.binding.name,
    clientId: input.observed.principal.clientId,
    outcome: code,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(input.observed.startedAt))
  });

  return undefined;
}

async function invokeRuntime(
  runtime: RuntimeApi,
  operation: RuntimeOperationName,
  args: unknown,
  authorization?: AuthorizationContext | undefined
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
      return runtime.callTool(
        parsed.runId,
        parsed.request,
        bindToolContext(parsed.options as ParsedCallToolOptions, authorization)
      );
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
      assertNever(operation as never);
  }
}

function runIdForRuntimeArgs(
  operation: RuntimeOperationName,
  args: unknown
): string | undefined {
  if (operation === "startRun") {
    return undefined;
  }

  return readStringProperty(args, "runId");
}

function rootDirForRuntimeArgs(
  operation: RuntimeOperationName,
  args: unknown
): string | undefined {
  if (operation === "startRun") {
    return readStringProperty(args, "cwd");
  }

  const options = recordValue(readProperty(args, "options"));
  return readStringProperty(options, "rootDir");
}

function idempotencyKeyForRuntimeArgs(
  operation: RuntimeOperationName,
  args: unknown
) {
  if (operation !== "callTool") {
    return undefined;
  }

  return readStringProperty(recordValue(readProperty(args, "request")), "idempotencyKey");
}

function expectedLastEventIdForRuntimeArgs(args: unknown) {
  return readStringProperty(args, "expectedLastEventId");
}

function runIdForRuntimeResult(result: unknown) {
  const direct = readStringProperty(result, "runId");

  if (direct !== undefined) {
    return direct;
  }

  return readStringProperty(recordValue(readProperty(result, "state")), "runId");
}

function rootDirForRuntimeResult(result: unknown) {
  const paths = recordValue(readProperty(result, "paths"));
  return readStringProperty(paths, "rootDir");
}

async function readEventsSafely(
  runtime: RuntimeApi,
  runId: string,
  rootDir?: string | undefined
): Promise<RuntimeEvent[]> {
  const result = await readEventsResult(runtime, runId, rootDir);

  return result.status === "success" ? result.events : [];
}

function eventReadSuccess(events: RuntimeEvent[]): EventReadResult {
  return {
    status: "success",
    events
  };
}

type EventReadResult =
  | {
      status: "success";
      events: RuntimeEvent[];
    }
  | {
      status: "failed";
      error: unknown;
    };

async function readEventsResult(
  runtime: RuntimeApi,
  runId: string,
  rootDir?: string | undefined
): Promise<EventReadResult> {
  try {
    return eventReadSuccess(
      await runtime.getEvents(
        runId,
        rootDir === undefined ? undefined : { rootDir }
      )
    );
  } catch (error) {
    return {
      status: "failed",
      error
    };
  }
}

function eventIdsForRuntimeResult(
  result: unknown,
  beforeEvents: readonly RuntimeEvent[],
  afterEvents: readonly RuntimeEvent[]
) {
  const toolResult = parseToolCallResult(result);
  const fromProvenance = toolResult?.provenance.eventIds;

  if (fromProvenance !== undefined) {
    return fromProvenance;
  }

  if (isRecord(result) && Array.isArray(result.events)) {
    return result.events
      .map((event) => RuntimeEventSchema.safeParse(event))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data.id);
  }

  const beforeIds = new Set(beforeEvents.map((event) => event.id));
  const delta = afterEvents.filter((event) => !beforeIds.has(event.id));

  return delta.map((event) => event.id);
}

function traceIdForRuntimeResult(result: unknown) {
  return parseToolCallResult(result)?.provenance.traceId;
}

function traceIdForEventIds(
  events: readonly RuntimeEvent[],
  eventIds: readonly string[]
) {
  const eventIdSet = new Set(eventIds);

  return events.find((event) => eventIdSet.has(event.id))?.traceId;
}

function parseToolCallResult(result: unknown): ToolCallResult | undefined {
  const parsed = ToolCallResultSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

function actionDispatchedRecordFor(input: {
  observability: NormalizedMcpObservability;
  observed: ObservedRequest;
  binding: EnabledMcpToolBinding;
  runId: string;
  eventIds: readonly [string, ...string[]];
  traceId: string;
  toolResult: ToolCallResult | undefined;
}): McpActionDispatched {
  return {
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: input.observability.correlation.recordId(),
    type: "mcp.action.dispatched",
    timestamp: input.observability.correlation.now(),
    sessionId: input.observability.session.sessionId,
    mcpRequestId: input.observed.mcpRequestId,
    runId: input.runId,
    runtimeOperation: String(input.binding.runtimeOperation),
    eventIds: [...input.eventIds],
    traceId: input.traceId,
    toolName: input.binding.name,
    principal: input.observed.principal,
    ...(input.toolResult === undefined
      ? {}
      : { toolProvenance: input.toolResult.provenance })
  };
}

function nonEmptyArray<T>(values: readonly T[]): [T, ...T[]] | undefined {
  const [first, ...rest] = values;

  return first === undefined ? undefined : [first, ...rest];
}

function externalInvokedRecordFor(input: {
  observability: NormalizedMcpObservability;
  observed: ObservedRequest;
  runId?: string | undefined;
  toolResult: ToolCallResult | undefined;
  runtimeResult: unknown;
}): McpExternalInvoked | undefined {
  const observation = externalObservationFromRuntimeResult(input.runtimeResult);

  if (observation === undefined || input.toolResult === undefined) {
    return undefined;
  }

  return {
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: input.observability.correlation.recordId(),
    type: "mcp.external.invoked",
    timestamp: input.observability.correlation.now(),
    sessionId: input.observability.session.sessionId,
    mcpRequestId: input.observed.mcpRequestId,
    serverId: observation.serverId,
    pinnedVersion: observation.pinnedVersion,
    toolName: observation.toolName,
    argsHash: observation.argsHash,
    resultHash: observation.resultHash,
    traceId: input.toolResult.provenance.traceId,
    trustClass: "external_observation",
    principal: input.observed.principal,
    ...(input.runId === undefined ? {} : { runId: input.runId })
  };
}

function externalObservationFromRuntimeResult(result: unknown) {
  const direct = recordValue(readProperty(result, "externalObservation"));

  if (
    direct.class === "external_observation" &&
    typeof direct.serverId === "string" &&
    typeof direct.pinnedVersion === "string" &&
    typeof direct.toolName === "string" &&
    typeof direct.argsHash === "string" &&
    typeof direct.resultHash === "string"
  ) {
    return {
      serverId: direct.serverId,
      pinnedVersion: direct.pinnedVersion,
      toolName: direct.toolName,
      argsHash: direct.argsHash,
      resultHash: direct.resultHash
    };
  }

  const output = recordValue(readProperty(result, "output"));
  const nested = recordValue(output.externalObservation);

  if (
    nested.class === "external_observation" &&
    typeof nested.serverId === "string" &&
    typeof nested.pinnedVersion === "string" &&
    typeof nested.toolName === "string" &&
    typeof nested.argsHash === "string" &&
    typeof nested.resultHash === "string"
  ) {
    return {
      serverId: nested.serverId,
      pinnedVersion: nested.pinnedVersion,
      toolName: nested.toolName,
      argsHash: nested.argsHash,
      resultHash: nested.resultHash
    };
  }

  return undefined;
}

function runtimeDenialGateForCode(code: string) {
  if (code === "policy_denied" || code === "policy_error") {
    return "PolicyVerdict";
  }

  if (code === "approval_required") {
    return "approval";
  }

  return "runtime";
}

function provenanceGapResponse(error: ReturnType<typeof createProvenanceGapError>) {
  return errorResponse({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    operatorAction: error.operatorAction
  });
}

function readOnlyProvenanceGapResponse(
  operation: string,
  error: ReturnType<typeof createProvenanceGapError>
): McpProtocolResponse {
  const response = provenanceGapResponse(error);

  switch (operation) {
    case "tools/list":
      return {
        ...response,
        tools: []
      };
    case "resources/list":
      return {
        ...response,
        resources: []
      };
    case "prompts/list":
      return {
        ...response,
        prompts: []
      };
    default:
      return response;
  }
}

function policyDecisionRefForObservedDenial(input: {
  observed: ObservedRequest;
  code: string;
  gate: string;
  target?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
}) {
  return `sha256:mcp-denial:${createHash("sha256")
    .update(
      canonicalJsonText({
        mcpRequestId: input.observed.mcpRequestId,
        argsHash: input.observed.argsHash,
        operation: input.observed.operation,
        code: input.code,
        gate: input.gate,
        target: input.target,
        runId: input.runId,
        traceId: input.traceId,
        principal: input.observed.principal
      })
    )
    .digest("hex")}`;
}

function runIdFromResourceUri(uri: string) {
  const match = /^specwright:\/\/runs\/([^/]+)\//.exec(uri);
  return match?.[1];
}

function countHashReferences(value: string) {
  return value.match(/sha256:/g)?.length ?? 0;
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function messageFromUnknown(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
          code: result.error?.code ?? "policy_denied",
          message: result.error?.message ?? "Policy denied tool call.",
          retryable: result.error?.retryable ?? false
        },
        payload
      );
    case "approval_required":
      return errorResponse(
        {
          code: result.error?.code ?? "approval_required",
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
      assertNever(result.status as never);
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
      const events = runtimeEventArraySchema.parse(replayed.events);

      return {
        payload: evalVerdictsFromEvents(events),
        metadata: eventFreshness(events)
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
  error: McpToolErrorInput,
  payload?: unknown
): McpErrorResponse {
  const safeError = safeMcpError(error);

  return {
    isError: true,
    error: safeError,
    content: [
      {
        type: "json",
        json: payload === undefined ? { error: safeError } : payload
      }
    ]
  };
}

function safeMcpError(error: McpToolErrorInput): McpToolError {
  return {
    contractId: "specwright.mcp.error.v1",
    code: sanitizeErrorCode(error.code),
    message: sanitizeErrorMessage(error.message),
    retryable: error.retryable,
    operatorAction: sanitizeErrorMessage(
      error.operatorAction ?? operatorActionForCode(error.code)
    ),
    ...(error.issues === undefined
      ? {}
      : {
          issues: error.issues.map((issue) => ({
            path: sanitizeErrorMessage(issue.path),
            message: sanitizeErrorMessage(issue.message)
          }))
        }),
    ...(error.approvalId === undefined ? {} : { approvalId: error.approvalId })
  };
}

function sanitizeErrorCode(code: string) {
  return /^[a-z0-9_.:-]+$/i.test(code) ? code : "invalid_request";
}

function sanitizeErrorMessage(message: string) {
  const withoutStack = message
    .split("\n")
    .filter((line) => !/^\s*at\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutSecrets = withoutStack
    .replace(
      /\b(?:sk|pk|sess|tok|key|secret|password|credential|authorization)[-_a-z0-9]*[:=][^\s"'`]+/gi,
      (value) => hashReference(value)
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, (value) => hashReference(value))
    .replace(
      /(^|[\s(["'])\/(?:Users|private|var|tmp|Volumes|workspace|runs-root|[^/\s"'`]+)(?:\/[^\s"'`)<>,;]+)+/g,
      (value, prefix: string) => `${prefix}${hashReference(value.trim())}`
    );

  return withoutSecrets.length === 0 ? "Request failed safely." : withoutSecrets;
}

function operatorActionForCode(code: string) {
  switch (code) {
    case "unauthenticated":
      return "Provide a valid MCP transport credential.";
    case "subject_unverifiable":
      return "Re-authenticate the propagated subject and retry.";
    case "scope_exceeded":
      return "Request only scopes granted to both the client and subject.";
    case "tenant_mismatch":
      return "Use a reference that belongs to the authenticated tenant.";
    case "approval_required":
      return "Obtain the required runtime approval before retrying.";
    case "policy_denied":
      return "Change the request or policy input; the runtime denied it.";
    case "incomplete_authorization_context":
      return "Configure the MCP adapter authentication context before retrying.";
    default:
      return "Inspect the request contract and retry with valid inputs.";
  }
}

async function redactToolResponseIfNeeded(
  response: McpToolsCallResponse,
  redact: McpEgressRedaction,
  context: McpEgressRedactionContext
): Promise<McpToolsCallResponse> {
  const redacted = await redact(response, context);

  return redacted as McpToolsCallResponse;
}

function redactPromptResponseSync(
  response: McpPromptsGetResponse,
  redact: McpEgressRedaction,
  context: McpEgressRedactionContext
): McpPromptsGetResponse {
  const redacted = redact(response, context);

  if (isPromiseLike(redacted)) {
    return errorResponse({
      code: "incomplete_authorization_context",
      message: "Prompt redaction must be synchronous for the prompts/get surface.",
      retryable: false
    });
  }

  return redacted as McpPromptsGetResponse;
}

function redactionContextForTool(input: {
  binding: EnabledMcpToolBinding;
  authorization: AuthorizationResult;
  errorCode?: string | undefined;
}): McpEgressRedactionContext {
  return {
    surface: input.errorCode === undefined ? "tool_result" : "error",
    toolName: input.binding.name,
    clientPrincipal:
      input.authorization.kind === "authenticated"
        ? input.authorization.context.clientPrincipal
        : undefined,
    subject:
      input.authorization.kind === "authenticated"
        ? input.authorization.context.subject
        : undefined,
    errorCode: input.errorCode,
    classes: [
      input.binding.outputSchemaRef,
      ...(input.binding.requiredScopes ?? [])
    ]
  };
}

type RedactionWalkContext = {
  surface: McpEgressRedactionContext["surface"];
  path: readonly string[];
  inheritedClass: RedactionClass | undefined;
  egressClasses: readonly string[];
};

type RedactionWalkResult = {
  value: unknown;
  changed: boolean;
};

const trustLabelKeys = new Set([
  "authority",
  "cacheStatus",
  "claimLevel",
  "class",
  "confidence",
  "createdBy",
  "decisionHash",
  "evidenceRefs",
  "externalOrigin",
  "externalTrustPolicy",
  "generated",
  "generatedStatus",
  "importantClaims",
  "metadata",
  "producedBy",
  "provenance",
  "redactionClass",
  "redactionPolicy",
  "sourceAuthority",
  "sourceRefs"
]);

const dataBearingKeys = new Set([
  "args",
  "arguments",
  "claim",
  "content",
  "locator",
  "markdown",
  "message",
  "output",
  "path",
  "raw",
  "summaryPath",
  "text",
  "uri",
  "value"
]);

const sensitiveKeyPattern =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;

const mcpRestrictedEgressPathPatterns = [
  ["payload", "request", "args"],
  ["payload", "result", "output"],
  ["request", "args"],
  ["result", "output"],
  ["output"],
  ["content", "*", "json", "output"],
  ["content", "*", "json", "payload", "request", "args"],
  ["content", "*", "json", "payload", "result", "output"],
  ["content", "*", "json", "request", "args"],
  ["content", "*", "json", "result", "output"],
  ["content", "*", "json", "error", "message"],
  ["action", "arguments"],
  ["content", "*", "json", "action", "arguments"],
  ["messages", "*", "content", "text"]
] as const satisfies readonly (readonly string[])[];

const mcpRestrictedContainerPathPatterns = [
  ["payload", "request", "args"],
  ["payload", "result", "output"],
  ["request", "args"],
  ["result", "output"],
  ["output"],
  ["content", "*", "json", "output"],
  ["content", "*", "json", "payload", "request", "args"],
  ["content", "*", "json", "payload", "result", "output"],
  ["content", "*", "json", "request", "args"],
  ["content", "*", "json", "result", "output"],
  ["action", "arguments"],
  ["content", "*", "json", "action", "arguments"]
] as const satisfies readonly (readonly string[])[];

function redactEgressValue(
  value: unknown,
  context: RedactionWalkContext
): RedactionWalkResult {
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item, index) => {
      const child = redactEgressValue(item, {
        ...context,
        path: [...context.path, String(index)]
      });

      changed ||= child.changed;
      return child.value;
    });

    return {
      value: changed ? output : value,
      changed
    };
  }

  if (!isRecord(value)) {
    if (typeof value === "string" && context.surface === "error") {
      const sanitized = sanitizeErrorMessage(value);

      if (sanitized !== value) {
        return {
          value: sanitized,
          changed: true
        };
      }
    }

    if (isRestrictedClass(context.inheritedClass)) {
      return {
        value: hashReference(value),
        changed: true
      };
    }

    if (typeof value === "string" && isAbsoluteHostPath(value)) {
      return {
        value: hashReference(value),
        changed: true
      };
    }

    return {
      value,
      changed: false
    };
  }

  const objectClass =
    redactionClassFromUnknown(value.redactionPolicy) ??
    redactionClassFromUnknown(value.redactionClass) ??
    context.inheritedClass;
  let changed = false;
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(value)) {
    const childValue = value[key];

    if (childValue === undefined) {
      continue;
    }

    const childClass = redactionClassForChild(value, key, objectClass, context);

    if (shouldHashField(key, childValue, childClass)) {
      output[key] = hashReference(childValue);
      changed = true;
      continue;
    }

    const child = redactEgressValue(childValue, {
      surface: context.surface,
      path: [...context.path, key],
      inheritedClass: childClass,
      egressClasses: context.egressClasses
    });

    output[key] = child.value;
    changed ||= child.changed;
  }

  return {
    value: changed ? output : value,
    changed
  };
}

function redactionClassForChild(
  parent: Record<string, unknown>,
  key: string,
  objectClass: RedactionClass | undefined,
  context: RedactionWalkContext
): RedactionClass | undefined {
  const childPath = [...context.path, key];
  const policyClass = redactionClassFromPolicy(parent.redactionPolicy, key, [
    ...childPath
  ]);

  if (policyClass !== undefined) {
    return policyClass;
  }

  if (isContractRestrictedPath(childPath, context)) {
    return "restricted";
  }

  if (sensitiveKeyPattern.test(key)) {
    return "secret";
  }

  if (trustLabelKeys.has(key)) {
    return key === "metadata" ? objectClass : undefined;
  }

  if (isRestrictedClass(objectClass)) {
    return objectClass;
  }

  if (typeof parent[key] === "string" && isAbsoluteHostPath(parent[key])) {
    return "restricted";
  }

  return undefined;
}

function shouldHashField(
  key: string,
  value: unknown,
  redactionClass: RedactionClass | undefined
) {
  if (!isRestrictedClass(redactionClass)) {
    return false;
  }

  if (trustLabelKeys.has(key) && key !== "metadata") {
    return false;
  }

  if (key === "arguments" && isRecord(value)) {
    return false;
  }

  if (dataBearingKeys.has(key) || sensitiveKeyPattern.test(key)) {
    return true;
  }

  return !isRecord(value) && !Array.isArray(value);
}

function isContractRestrictedPath(
  path: readonly string[],
  context: RedactionWalkContext
) {
  if (!mcpEgressProfileApplies(context)) {
    return false;
  }

  return (
    pathMatchesAnyPattern(path, mcpRestrictedEgressPathPatterns) ||
    pathIsDescendantOfAnyPattern(path, mcpRestrictedContainerPathPatterns)
  );
}

function mcpEgressProfileApplies(context: RedactionWalkContext) {
  if (context.egressClasses.length === 0) {
    return true;
  }

  return context.egressClasses.some((entry) =>
    /ToolCallResult|RuntimeEvent|RunState|RunReport|Prompt|Error|Schema|runtime-owned|authoritative|derived|tool:|run:|prompt/i.test(
      entry
    )
  );
}

function pathMatchesAnyPattern(
  path: readonly string[],
  patterns: readonly (readonly string[])[]
) {
  const candidates = redactionPathCandidates(path);

  return candidates.some((candidate) =>
    patterns.some((pattern) => pathMatchesPattern(candidate, pattern))
  );
}

function pathIsDescendantOfAnyPattern(
  path: readonly string[],
  patterns: readonly (readonly string[])[]
) {
  const candidates = redactionPathCandidates(path);

  return candidates.some((candidate) =>
    patterns.some(
      (pattern) =>
        candidate.length > pattern.length &&
        pathMatchesPattern(candidate.slice(0, pattern.length), pattern)
    )
  );
}

function pathMatchesPattern(
  path: readonly string[],
  pattern: readonly string[]
) {
  if (path.length !== pattern.length) {
    return false;
  }

  return pattern.every(
    (segment, index) => segment === "*" || segment === path[index]
  );
}

function redactionPathCandidates(path: readonly string[]) {
  const withoutArrayIndexes = path.filter((segment) => !/^\d+$/.test(segment));

  return [path, withoutArrayIndexes];
}

function redactionClassFromPolicy(
  policy: unknown,
  key: string,
  path: readonly string[]
): RedactionClass | undefined {
  const direct = redactionClassFromUnknown(policy);

  if (direct !== undefined) {
    return direct;
  }

  if (!isRecord(policy)) {
    return undefined;
  }

  const candidates = [
    key,
    path.join("."),
    path.slice(-2).join(".")
  ];

  for (const candidate of candidates) {
    const parsed = redactionClassFromUnknown(policy[candidate]);

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function redactionClassFromUnknown(value: unknown): RedactionClass | undefined {
  const parsed = RedactionClassBoundarySchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function isRestrictedClass(
  redactionClass: RedactionClass | undefined
): redactionClass is RedactionClass {
  return (
    redactionClass !== undefined &&
    redactionClassAtLeast(redactionClass, "restricted")
  );
}

function hashReference(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(stableHashInput(value))
    .digest("hex")}`;
}

function stableHashInput(value: unknown) {
  const text = JSON.stringify(canonicalJsonValue(value));

  return text ?? String(value);
}

function isAbsoluteHostPath(value: unknown) {
  return (
    typeof value === "string" &&
    /^\/(?:Users|private|var|tmp|Volumes|workspace|runs-root)\//.test(value)
  );
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
  requiredScopes?: readonly string[] | undefined;
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
    requiredScopes: input.requiredScopes ?? []
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}

void RunStateSchema;
void RuntimeEventSchema;
void EvalVerdictSchema;
