import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readEvents, getRunStorePaths } from "@specwright/run-store";
import {
  readTrace,
  TRACE_RECORDER_VERSION,
  type TraceFile
} from "@specwright/trace-recorder";
import type { RuntimeEvent } from "@specwright/schemas";
import { readMcpAuditRecords } from "./writer";
import {
  MCP_PROVENANCE_GAP_AUDIT_TYPE,
  type McpAuditRecord
} from "./schemas";

export type BuildMcpAuditExportOptions = {
  rootDir?: string | undefined;
  runId: string;
  generatedBy: string;
  generatedAt?: Date | string | undefined;
  contractRegistryVersion?: string | undefined;
  migrationNotes?: readonly string[] | undefined;
};

export type McpAuditExportBundle = {
  exportId: string;
  generatedAt: string;
  generatedBy: string;
  runIds: [string];
  contractRegistryVersion: string;
  includedEventRange: {
    runId: string;
    firstSequence?: number | undefined;
    lastSequence?: number | undefined;
    firstEventId?: string | undefined;
    lastEventId?: string | undefined;
    eventCount: number;
    eventHashes: Array<{
      eventId: string;
      sequence: number;
      hash?: string | undefined;
      prevHash?: string | undefined;
    }>;
  };
  runtimeEvents: RuntimeEvent[];
  trace: TraceFile | null;
  mcpAuditRecords: McpAuditRecord[];
  principals: Array<{
    clientId?: string | undefined;
    subjectId?: string | undefined;
    tenantId?: string | undefined;
    grantedScopes?: string[] | undefined;
  }>;
  redactionProfiles: Array<{
    mcpRequestId: string;
    resourceUri: string;
    redactionProfile: string;
    fieldsRedactedCount: number;
  }>;
  externalInvocations: Array<{
    mcpRequestId: string;
    serverId: string;
    pinnedVersion: string;
    toolName: string;
    argsHash: string;
    resultHash: string;
    traceId: string;
    trustClass: "external_observation";
  }>;
  versions: {
    adapterAuditSchema: string;
    traceRecorder: string;
    runStorePackage?: unknown;
  };
  migrationNotes: string[];
  missingOptionalProjections: string[];
  provenanceGaps: Array<{
    code: "provenance_gap";
    reason: string;
    mcpRequestId?: string | undefined;
    runId?: string | undefined;
    eventIds?: string[] | undefined;
  }>;
  integrityHash: string;
};

export async function buildMcpAuditExport(
  options: BuildMcpAuditExportOptions
): Promise<McpAuditExportBundle> {
  const [events, auditRecords, trace, runStorePackage] = await Promise.all([
    readEvents({
      rootDir: options.rootDir,
      runId: options.runId
    }),
    readMcpAuditRecords({
      rootDir: options.rootDir,
      runId: options.runId,
      includeIndex: true
    }),
    readTraceOrNull(options.rootDir, options.runId),
    readRunStoreVersionOrNull(options.rootDir, options.runId)
  ]);
  const generatedAt = normalizeTimestamp(options.generatedAt);
  const baseBundle = {
    exportId: `mcp_audit_export_${randomUUID()}`,
    generatedAt,
    generatedBy: options.generatedBy,
    runIds: [options.runId] as [string],
    contractRegistryVersion:
      options.contractRegistryVersion ?? "specwright.contracts.current",
    includedEventRange: eventRangeFor(options.runId, events),
    runtimeEvents: events,
    trace,
    mcpAuditRecords: auditRecords,
    principals: principalsFromAudit(auditRecords),
    redactionProfiles: redactionProfilesFromAudit(auditRecords),
    externalInvocations: externalInvocationsFromAudit(auditRecords),
    versions: {
      adapterAuditSchema: "specwright.mcp.audit.v1",
      traceRecorder: TRACE_RECORDER_VERSION,
      ...(runStorePackage === null ? {} : { runStorePackage })
    },
    migrationNotes: [
      ...(options.migrationNotes ?? []),
      ...(await readMigrationNotes(options.rootDir, options.runId))
    ],
    missingOptionalProjections:
      trace === null ? ["trace"] : [],
    provenanceGaps: provenanceGapsFor({
      runId: options.runId,
      events,
      trace,
      auditRecords
    })
  } satisfies Omit<McpAuditExportBundle, "integrityHash">;

  return {
    ...baseBundle,
    integrityHash: integrityHash(baseBundle)
  };
}

function eventRangeFor(runId: string, events: readonly RuntimeEvent[]) {
  const first = events[0];
  const last = events[events.length - 1];

  return {
    runId,
    ...(first === undefined ? {} : { firstSequence: first.sequence }),
    ...(last === undefined ? {} : { lastSequence: last.sequence }),
    ...(first === undefined ? {} : { firstEventId: first.id }),
    ...(last === undefined ? {} : { lastEventId: last.id }),
    eventCount: events.length,
    eventHashes: events.map((event) => ({
      eventId: event.id,
      sequence: event.sequence,
      ...(event.integrity?.hash === undefined
        ? {}
        : { hash: event.integrity.hash }),
      ...(event.integrity?.prevHash === undefined
        ? {}
        : { prevHash: event.integrity.prevHash })
    }))
  };
}

function principalsFromAudit(records: readonly McpAuditRecord[]) {
  const principals = new Map<string, NonNullable<McpAuditRecord["principal"]>>();

  for (const record of records) {
    if (record.principal === undefined) {
      continue;
    }

    principals.set(JSON.stringify(record.principal), record.principal);
  }

  return [...principals.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function redactionProfilesFromAudit(records: readonly McpAuditRecord[]) {
  return records.flatMap((record) =>
    record.type === "mcp.resource.read"
      ? [
          {
            mcpRequestId: record.mcpRequestId,
            resourceUri: record.resourceUri,
            redactionProfile: record.redactionProfile,
            fieldsRedactedCount: record.fieldsRedactedCount
          }
        ]
      : []
  );
}

function externalInvocationsFromAudit(records: readonly McpAuditRecord[]) {
  return records.flatMap((record) =>
    record.type === "mcp.external.invoked"
      ? [
          {
            mcpRequestId: record.mcpRequestId,
            serverId: record.serverId,
            pinnedVersion: record.pinnedVersion,
            toolName: record.toolName,
            argsHash: record.argsHash,
            resultHash: record.resultHash,
            traceId: record.traceId,
            trustClass: record.trustClass
          }
        ]
      : []
  );
}

function provenanceGapsFor(input: {
  runId: string;
  events: readonly RuntimeEvent[];
  trace: TraceFile | null;
  auditRecords: readonly McpAuditRecord[];
}) {
  const gaps: McpAuditExportBundle["provenanceGaps"] = [];
  const requestPrincipalById = new Map<string, boolean>();
  const mcpSpanRequestIds = new Set<string>();
  const eventIdSet = new Set(input.events.map((event) => event.id));
  const hasMcpRequestRecord = input.auditRecords.some(
    (record) => record.type === "mcp.request.received"
  );
  const hasMcpActionRecord = input.auditRecords.some(
    (record) => record.type === "mcp.action.dispatched"
  );
  const hasVerifiedAuditPrincipal = input.auditRecords.some(hasVerifiedPrincipal);
  const hasMcpParentSpan =
    input.trace?.spans.some(
      (span) => span.kind === "mcp" && span.parentSpanId === undefined
    ) ?? false;

  for (const record of input.auditRecords) {
    if ("mcpRequestId" in record && record.mcpRequestId !== undefined) {
      requestPrincipalById.set(
        record.mcpRequestId,
        requestPrincipalById.get(record.mcpRequestId) === true ||
          hasVerifiedPrincipal(record)
      );
    }

    if (record.type === MCP_PROVENANCE_GAP_AUDIT_TYPE) {
      gaps.push({
        code: "provenance_gap",
        reason: record.reason,
        ...(record.mcpRequestId === undefined
          ? {}
          : { mcpRequestId: record.mcpRequestId }),
        ...(record.runId === undefined ? {} : { runId: record.runId }),
        ...(record.eventIds === undefined ? {} : { eventIds: record.eventIds })
      });
    }
  }

  for (const span of input.trace?.spans ?? []) {
    if (span.kind !== "mcp") {
      continue;
    }

    const requestId = span.metadata.mcpRequestId;

    if (typeof requestId === "string") {
      mcpSpanRequestIds.add(requestId);
    }
  }

  if (
    isMcpOriginatedRun(input.events) &&
    (!hasMcpRequestRecord ||
      !hasMcpActionRecord ||
      !hasMcpParentSpan ||
      !hasVerifiedAuditPrincipal)
  ) {
    gaps.push({
      code: "provenance_gap",
      reason:
        "MCP-originated run has no complete durable MCP audit, span, and principal trail.",
      runId: input.runId,
      eventIds: input.events.map((event) => event.id)
    });
  }

  for (const record of input.auditRecords) {
    if (record.type !== "mcp.action.dispatched") {
      continue;
    }

    if (!record.eventIds.every((eventId) => eventIdSet.has(eventId))) {
      gaps.push({
        code: "provenance_gap",
        reason: "MCP action audit record references runtime events absent from the export range.",
        mcpRequestId: record.mcpRequestId,
        runId: record.runId,
        eventIds: record.eventIds
      });
    }

    if (requestPrincipalById.get(record.mcpRequestId) !== true) {
      gaps.push({
        code: "provenance_gap",
        reason: "MCP-originated action has no verified principal in durable audit records.",
        mcpRequestId: record.mcpRequestId,
        runId: record.runId,
        eventIds: record.eventIds
      });
    }

    if (!mcpSpanRequestIds.has(record.mcpRequestId)) {
      gaps.push({
        code: "provenance_gap",
        reason: "MCP-originated action has no matching mcp parent span.",
        mcpRequestId: record.mcpRequestId,
        runId: record.runId,
        eventIds: record.eventIds
      });
    }
  }

  return gaps;
}

function hasVerifiedPrincipal(record: McpAuditRecord) {
  return (
    record.principal?.clientId !== undefined &&
    record.principal.subjectId !== undefined &&
    record.principal.tenantId !== undefined
  );
}

function isMcpOriginatedRun(events: readonly RuntimeEvent[]) {
  return events.some((event) => {
    if (event.type !== "run.started" || !isRecord(event.payload)) {
      return false;
    }

    const input = event.payload.input;

    if (!isRecord(input)) {
      return false;
    }

    const host = input.host;

    return isRecord(host) && host.kind === "mcp";
  });
}

async function readTraceOrNull(rootDir: string | undefined, runId: string) {
  try {
    return await readTrace({
      rootDir,
      runId
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readRunStoreVersionOrNull(
  rootDir: string | undefined,
  runId: string
) {
  try {
    return JSON.parse(
      await readFile(getRunStorePaths(rootDir, runId).versionPath, "utf8")
    ) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readMigrationNotes(rootDir: string | undefined, runId: string) {
  try {
    const raw = await readFile(
      getRunStorePaths(rootDir, runId).migrationsPath,
      "utf8"
    );

    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim());
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function integrityHash(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  const text = JSON.stringify(canonicalJsonValue(value));

  if (text === undefined) {
    return "undefined";
  }

  return text;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }

  if (typeof value !== "object" || value === null || value instanceof Date) {
    return value;
  }

  const output: Record<string, unknown> = {};

  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record).sort()) {
    const child = record[key];

    if (child !== undefined) {
      output[key] = canonicalJsonValue(child);
    }
  }

  return output;
}

function normalizeTimestamp(timestamp: Date | string | undefined) {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
