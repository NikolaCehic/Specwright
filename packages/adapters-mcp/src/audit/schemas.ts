import { z } from "zod";

const nonEmptyString = z.string().min(1);
const timestampString = z.string().datetime({ offset: true });
const optionalStringArray = z.array(nonEmptyString).optional();

export const MCP_AUDIT_SCHEMA_VERSION = "specwright.mcp.audit.v1" as const;
export const MCP_PROVENANCE_GAP_AUDIT_TYPE = "mcp.provenance_gap" as const;

export const McpAuditRecordTypeSchema = z.enum([
  "mcp.session.opened",
  "mcp.session.closed",
  "mcp.request.received",
  "mcp.action.dispatched",
  "mcp.action.denied",
  "mcp.resource.read",
  "mcp.external.invoked",
  MCP_PROVENANCE_GAP_AUDIT_TYPE
]);

export const McpRunModeSchema = z.enum([
  "autonomous",
  "assisted",
  "read_only"
]);

export const McpAuditPrincipalSchema = z
  .object({
    clientId: nonEmptyString.optional(),
    subjectId: nonEmptyString.optional(),
    tenantId: nonEmptyString.optional(),
    grantedScopes: z.array(nonEmptyString).optional()
  })
  .strict();

export const McpAuditToolProvenanceSchema = z
  .object({
    toolId: nonEmptyString,
    toolVersion: nonEmptyString,
    argsHash: nonEmptyString,
    resultHash: nonEmptyString.optional(),
    cacheStatus: z.enum(["hit", "miss", "bypass"]),
    traceId: nonEmptyString,
    adapterVersion: nonEmptyString.optional(),
    decisionHash: nonEmptyString.optional(),
    approvalId: nonEmptyString.optional(),
    spanId: nonEmptyString.optional(),
    eventIds: optionalStringArray,
    redactionSummary: z.record(z.string(), z.unknown()).optional(),
    cache: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const auditBaseFields = {
  schemaVersion: z.literal(MCP_AUDIT_SCHEMA_VERSION),
  recordId: nonEmptyString,
  timestamp: timestampString,
  sessionId: nonEmptyString.optional(),
  principal: McpAuditPrincipalSchema.optional()
};

export const McpSessionOpenedSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.session.opened"),
    sessionId: nonEmptyString,
    clientId: nonEmptyString,
    subjectId: nonEmptyString,
    tenantId: nonEmptyString,
    grantedScopes: z.array(nonEmptyString),
    runMode: McpRunModeSchema,
    transport: nonEmptyString,
    protocolVersion: nonEmptyString
  })
  .strict();

export const McpSessionClosedSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.session.closed"),
    sessionId: nonEmptyString,
    clientId: nonEmptyString,
    subjectId: nonEmptyString.optional(),
    tenantId: nonEmptyString.optional(),
    durationMs: z.number().nonnegative(),
    requestCount: z.number().int().nonnegative(),
    denialCount: z.number().int().nonnegative()
  })
  .strict();

export const McpRequestReceivedSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.request.received"),
    mcpRequestId: nonEmptyString,
    operation: nonEmptyString,
    target: nonEmptyString,
    argsHash: nonEmptyString,
    idempotencyKey: nonEmptyString.optional(),
    expectedLastEventId: nonEmptyString.optional(),
    runId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional()
  })
  .strict();

export const McpActionDispatchedSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.action.dispatched"),
    mcpRequestId: nonEmptyString,
    runId: nonEmptyString,
    runtimeOperation: nonEmptyString,
    eventIds: z.array(nonEmptyString).nonempty(),
    traceId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    resourceUri: nonEmptyString.optional(),
    promptId: nonEmptyString.optional(),
    toolProvenance: McpAuditToolProvenanceSchema.optional(),
    externalObservation: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const McpActionDeniedSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.action.denied"),
    mcpRequestId: nonEmptyString,
    denialCode: nonEmptyString,
    gate: nonEmptyString,
    policyDecisionRef: nonEmptyString,
    runId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    target: nonEmptyString.optional()
  })
  .strict();

export const McpResourceReadSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.resource.read"),
    mcpRequestId: nonEmptyString,
    resourceUri: nonEmptyString,
    redactionProfile: nonEmptyString,
    fieldsRedactedCount: z.number().int().nonnegative(),
    bytesProjected: z.number().int().nonnegative().optional(),
    runId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional()
  })
  .strict();

export const McpExternalInvokedSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal("mcp.external.invoked"),
    mcpRequestId: nonEmptyString,
    serverId: nonEmptyString,
    pinnedVersion: nonEmptyString,
    toolName: nonEmptyString,
    argsHash: nonEmptyString,
    resultHash: nonEmptyString,
    traceId: nonEmptyString,
    trustClass: z.literal("external_observation"),
    runId: nonEmptyString.optional()
  })
  .strict();

export const McpProvenanceGapSchema = z
  .object({
    ...auditBaseFields,
    type: z.literal(MCP_PROVENANCE_GAP_AUDIT_TYPE),
    gapId: nonEmptyString,
    mcpRequestId: nonEmptyString.optional(),
    runId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    eventIds: optionalStringArray,
    operation: nonEmptyString,
    stage: nonEmptyString,
    reason: nonEmptyString,
    partialWrites: z.array(nonEmptyString),
    retryable: z.literal(true),
    operatorAction: nonEmptyString
  })
  .strict();

export const McpAuditRecordSchema = z.discriminatedUnion("type", [
  McpSessionOpenedSchema,
  McpSessionClosedSchema,
  McpRequestReceivedSchema,
  McpActionDispatchedSchema,
  McpActionDeniedSchema,
  McpResourceReadSchema,
  McpExternalInvokedSchema,
  McpProvenanceGapSchema
]);

export type McpAuditRecordType = z.infer<typeof McpAuditRecordTypeSchema>;
export type McpAuditRecord = z.infer<typeof McpAuditRecordSchema>;
export type McpAuditPrincipal = z.infer<typeof McpAuditPrincipalSchema>;
export type McpAuditToolProvenance = z.infer<
  typeof McpAuditToolProvenanceSchema
>;
export type McpSessionOpened = z.infer<typeof McpSessionOpenedSchema>;
export type McpSessionClosed = z.infer<typeof McpSessionClosedSchema>;
export type McpRequestReceived = z.infer<typeof McpRequestReceivedSchema>;
export type McpActionDispatched = z.infer<typeof McpActionDispatchedSchema>;
export type McpActionDenied = z.infer<typeof McpActionDeniedSchema>;
export type McpResourceRead = z.infer<typeof McpResourceReadSchema>;
export type McpExternalInvoked = z.infer<typeof McpExternalInvokedSchema>;
export type McpProvenanceGap = z.infer<typeof McpProvenanceGapSchema>;

export function parseMcpAuditRecord(value: unknown): McpAuditRecord {
  const parsed = McpAuditRecordSchema.safeParse(value);

  if (!parsed.success) {
    throw parsed.error;
  }

  return parsed.data;
}

export function safeParseMcpAuditRecord(value: unknown) {
  return McpAuditRecordSchema.safeParse(value);
}
