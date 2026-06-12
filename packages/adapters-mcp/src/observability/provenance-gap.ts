import {
  MCP_AUDIT_SCHEMA_VERSION,
  MCP_PROVENANCE_GAP_AUDIT_TYPE,
  type McpAuditPrincipal,
  type McpProvenanceGap
} from "../audit/schemas";
import type { McpAuditWriter } from "../audit/writer";

export const MCP_PROVENANCE_GAP_CODE = "provenance_gap" as const;

export type McpProvenanceGapError = {
  code: typeof MCP_PROVENANCE_GAP_CODE;
  message: string;
  retryable: true;
  operatorAction: string;
};

export type McpProvenanceGapMarkerInput = {
  recordId: string;
  gapId: string;
  timestamp: string;
  sessionId?: string | undefined;
  mcpRequestId?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  eventIds?: readonly string[] | undefined;
  operation: string;
  stage: string;
  reason: string;
  partialWrites: readonly string[];
  principal?: McpAuditPrincipal | undefined;
};

export type McpProvenanceGapMarkerResult =
  | {
      status: "written";
      record: McpProvenanceGap;
    }
  | {
      status: "failed";
      error: unknown;
    };

export function createProvenanceGapError(
  reason = "MCP provenance could not be recorded durably."
): McpProvenanceGapError {
  return {
    code: MCP_PROVENANCE_GAP_CODE,
    message:
      "The runtime operation could not be reported as successful because its MCP provenance record is incomplete.",
    retryable: true,
    operatorAction: `Operator must reconcile the run from the authoritative event log before retrying. ${reason}`
  };
}

export async function writeProvenanceGapMarker(
  writer: McpAuditWriter,
  input: McpProvenanceGapMarkerInput
): Promise<McpProvenanceGapMarkerResult> {
  const record: McpProvenanceGap = {
    schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
    recordId: input.recordId,
    type: MCP_PROVENANCE_GAP_AUDIT_TYPE,
    timestamp: input.timestamp,
    gapId: input.gapId,
    operation: input.operation,
    stage: input.stage,
    reason: input.reason,
    partialWrites: [...input.partialWrites],
    retryable: true,
    operatorAction:
      "Inspect storage health, replay from the runtime event log, and keep the gap visible in audit export.",
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.mcpRequestId === undefined
      ? {}
      : { mcpRequestId: input.mcpRequestId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.eventIds === undefined ? {} : { eventIds: [...input.eventIds] }),
    ...(input.principal === undefined ? {} : { principal: input.principal })
  };

  try {
    const written = await writer.write(record);

    if (written.type !== MCP_PROVENANCE_GAP_AUDIT_TYPE) {
      throw new Error("Provenance gap writer returned a different audit record type.");
    }

    return {
      status: "written",
      record: written
    };
  } catch (error) {
    return {
      status: "failed",
      error
    };
  }
}
