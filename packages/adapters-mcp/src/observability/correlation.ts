import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readEvents } from "@specwright/run-store";
import { readTrace, type TraceSpan } from "@specwright/trace-recorder";
import type { RuntimeEvent } from "@specwright/schemas";
import {
  readAllMcpAuditRecords,
  readMcpAuditRecords
} from "../audit/writer";
import type { McpAuditRecord } from "../audit/schemas";

export type McpClock = () => Date | string;

export type McpIdFactory = {
  mcpRequestId(): string;
  sessionId(): string;
  spanId(): string;
  recordId(): string;
  gapId(): string;
};

export type McpCorrelationFactory = {
  now(): string;
  mcpRequestId(): string;
  sessionId(): string;
  spanId(): string;
  recordId(): string;
  gapId(): string;
};

export type ResolveMcpCorrelationInput =
  | {
      rootDir?: string | undefined;
      mcpRequestId: string;
    }
  | {
      rootDir?: string | undefined;
      traceId: string;
    }
  | {
      rootDir?: string | undefined;
      runId: string;
    }
  | {
      rootDir?: string | undefined;
      eventId: string;
    };

export type McpCorrelationResolution = {
  mcpRequestIds: string[];
  traceIds: string[];
  runIds: string[];
  eventIds: string[];
  sessionIds: string[];
  clientIds: string[];
  subjectIds: string[];
};

export const defaultMcpIdFactory: McpIdFactory = {
  mcpRequestId() {
    return `mcp_req_${randomUUID()}`;
  },
  sessionId() {
    return `mcp_sess_${randomUUID()}`;
  },
  spanId() {
    return `mcp_span_${randomUUID()}`;
  },
  recordId() {
    return `mcp_audit_${randomUUID()}`;
  },
  gapId() {
    return `mcp_gap_${randomUUID()}`;
  }
};

export function createMcpCorrelationFactory(input: {
  clock?: McpClock | undefined;
  idFactory?: Partial<McpIdFactory> | undefined;
} = {}): McpCorrelationFactory {
  const clock = input.clock ?? (() => new Date());
  const ids = {
    ...defaultMcpIdFactory,
    ...(input.idFactory ?? {})
  };

  return {
    now() {
      const value = clock();
      return value instanceof Date ? value.toISOString() : value;
    },
    mcpRequestId: ids.mcpRequestId,
    sessionId: ids.sessionId,
    spanId: ids.spanId,
    recordId: ids.recordId,
    gapId: ids.gapId
  };
}

export function hashMcpArgs(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function sessionTraceRunId(sessionId: string) {
  return `mcp-session-${safeIdSegment(sessionId)}`;
}

export async function resolveMcpCorrelation(
  input: ResolveMcpCorrelationInput
): Promise<McpCorrelationResolution> {
  const rootDir = input.rootDir;
  const resolution = emptyResolution();
  const seed = seedFromInput(input);
  const allowRunWideExpansion = seed.kind === "runId";

  addSeed(resolution, seed);

  const auditRecords = await readAllMcpAuditRecords(rootDir);
  expandFromAuditRecords(resolution, auditRecords, {
    allowRunWideExpansion
  });

  const runIdsToRead =
    resolution.runIds.size > 0
      ? [...resolution.runIds]
      : seed.kind === "runId"
        ? [seed.value]
        : await discoverRunIds(rootDir);

  const traces = await readTraceFiles(rootDir, runIdsToRead);
  expandFromTraceSpans(resolution, traces.flatMap((trace) => trace.spans), {
    allowRunWideExpansion
  });

  const events = await readRuntimeEvents(rootDir, runIdsToRead);
  expandFromEvents(resolution, events, {
    allowRunWideExpansion
  });

  expandFromAuditRecords(resolution, auditRecords, {
    allowRunWideExpansion
  });

  return sortResolution(resolution);
}

export async function readMcpCorrelationAuditRecords(input: {
  rootDir?: string | undefined;
  runId?: string | undefined;
}) {
  return readMcpAuditRecords({
    rootDir: input.rootDir,
    runId: input.runId,
    includeIndex: true
  });
}

function expandFromAuditRecords(
  resolution: MutableResolution,
  records: readonly McpAuditRecord[],
  options: {
    allowRunWideExpansion: boolean;
  }
) {
  let changed = true;

  while (changed) {
    changed = false;

    for (const record of records) {
      if (!recordMatchesResolution(record, resolution, options)) {
        continue;
      }

      changed = addAuditRecord(resolution, record) || changed;
    }
  }
}

function expandFromTraceSpans(
  resolution: MutableResolution,
  spans: readonly TraceSpan[],
  options: {
    allowRunWideExpansion: boolean;
  }
) {
  let changed = true;

  while (changed) {
    changed = false;

    for (const span of spans) {
      const metadataRequestId = readMetadataString(span.metadata, "mcpRequestId");
      const matchesTraceId = resolution.traceIds.has(span.traceId);
      const matches =
        matchesTraceId ||
        (options.allowRunWideExpansion && resolution.runIds.has(span.runId)) ||
        (metadataRequestId !== undefined &&
          resolution.mcpRequestIds.has(metadataRequestId)) ||
        (span.eventIds ?? []).some((eventId) => resolution.eventIds.has(eventId));

      if (!matches) {
        continue;
      }

      changed = addValue(resolution.runIds, span.runId) || changed;
      if (matchesTraceId || options.allowRunWideExpansion) {
        changed = addValue(resolution.traceIds, span.traceId) || changed;
      }

      if (metadataRequestId !== undefined) {
        changed = addValue(resolution.mcpRequestIds, metadataRequestId) || changed;
      }

      for (const eventId of span.eventIds ?? []) {
        changed = addValue(resolution.eventIds, eventId) || changed;
      }
    }
  }
}

function expandFromEvents(
  resolution: MutableResolution,
  events: readonly RuntimeEvent[],
  options: {
    allowRunWideExpansion: boolean;
  }
) {
  let changed = true;

  while (changed) {
    changed = false;

    for (const event of events) {
      const matches =
        (options.allowRunWideExpansion && resolution.runIds.has(event.runId)) ||
        resolution.traceIds.has(event.traceId) ||
        resolution.eventIds.has(event.id);

      if (!matches) {
        continue;
      }

      changed = addValue(resolution.runIds, event.runId) || changed;
      changed = addValue(resolution.traceIds, event.traceId) || changed;
      changed = addValue(resolution.eventIds, event.id) || changed;
    }
  }
}

function addAuditRecord(
  resolution: MutableResolution,
  record: McpAuditRecord
) {
  let changed = false;

  if (record.sessionId !== undefined) {
    changed = addValue(resolution.sessionIds, record.sessionId) || changed;
  }

  changed =
    addValue(resolution.clientIds, record.principal?.clientId) || changed;
  changed =
    addValue(resolution.subjectIds, record.principal?.subjectId) || changed;

  if ("mcpRequestId" in record) {
    changed = addValue(resolution.mcpRequestIds, record.mcpRequestId) || changed;
  }

  if ("runId" in record) {
    changed = addValue(resolution.runIds, record.runId) || changed;
  }

  if ("traceId" in record) {
    changed = addValue(resolution.traceIds, record.traceId) || changed;
  }

  if ("eventIds" in record && record.eventIds !== undefined) {
    for (const eventId of record.eventIds) {
      changed = addValue(resolution.eventIds, eventId) || changed;
    }
  }

  if (record.type === "mcp.session.opened") {
    changed = addValue(resolution.clientIds, record.clientId) || changed;
    changed = addValue(resolution.subjectIds, record.subjectId) || changed;
  }

  return changed;
}

function recordMatchesResolution(
  record: McpAuditRecord,
  resolution: MutableResolution,
  options: {
    allowRunWideExpansion: boolean;
  }
) {
  return (
    ("mcpRequestId" in record &&
      record.mcpRequestId !== undefined &&
      resolution.mcpRequestIds.has(record.mcpRequestId)) ||
    ("runId" in record &&
      record.runId !== undefined &&
      options.allowRunWideExpansion &&
      resolution.runIds.has(record.runId)) ||
    ("traceId" in record &&
      record.traceId !== undefined &&
      resolution.traceIds.has(record.traceId)) ||
    ("eventIds" in record &&
      record.eventIds !== undefined &&
      record.eventIds.some((eventId) => resolution.eventIds.has(eventId)))
  );
}

async function readTraceFiles(
  rootDir: string | undefined,
  runIds: readonly string[]
) {
  const traces = [];

  for (const runId of runIds) {
    try {
      traces.push(
        await readTrace({
          rootDir,
          runId
        })
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return traces;
}

async function readRuntimeEvents(
  rootDir: string | undefined,
  runIds: readonly string[]
) {
  const events: RuntimeEvent[] = [];

  for (const runId of runIds) {
    try {
      events.push(
        ...(await readEvents({
          rootDir,
          runId
        }))
      );
    } catch (error) {
      if (!isExpectedMissingRunError(error)) {
        throw error;
      }
    }
  }

  return events;
}

async function discoverRunIds(rootDir?: string | undefined) {
  const runsDir = join(resolve(rootDir ?? "."), ".archetype", "runs");

  try {
    return await readdir(runsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function seedFromInput(input: ResolveMcpCorrelationInput) {
  if ("mcpRequestId" in input) {
    return {
      kind: "mcpRequestId" as const,
      value: input.mcpRequestId
    };
  }

  if ("traceId" in input) {
    return {
      kind: "traceId" as const,
      value: input.traceId
    };
  }

  if ("runId" in input) {
    return {
      kind: "runId" as const,
      value: input.runId
    };
  }

  return {
    kind: "eventId" as const,
    value: input.eventId
  };
}

function addSeed(
  resolution: MutableResolution,
  seed: ReturnType<typeof seedFromInput>
) {
  switch (seed.kind) {
    case "mcpRequestId":
      addValue(resolution.mcpRequestIds, seed.value);
      return;
    case "traceId":
      addValue(resolution.traceIds, seed.value);
      return;
    case "runId":
      addValue(resolution.runIds, seed.value);
      return;
    case "eventId":
      addValue(resolution.eventIds, seed.value);
      return;
    default:
      assertNever(seed);
  }
}

type MutableResolution = {
  mcpRequestIds: Set<string>;
  traceIds: Set<string>;
  runIds: Set<string>;
  eventIds: Set<string>;
  sessionIds: Set<string>;
  clientIds: Set<string>;
  subjectIds: Set<string>;
};

function emptyResolution(): MutableResolution {
  return {
    mcpRequestIds: new Set(),
    traceIds: new Set(),
    runIds: new Set(),
    eventIds: new Set(),
    sessionIds: new Set(),
    clientIds: new Set(),
    subjectIds: new Set()
  };
}

function sortResolution(
  resolution: MutableResolution
): McpCorrelationResolution {
  return {
    mcpRequestIds: [...resolution.mcpRequestIds].sort(),
    traceIds: [...resolution.traceIds].sort(),
    runIds: [...resolution.runIds].sort(),
    eventIds: [...resolution.eventIds].sort(),
    sessionIds: [...resolution.sessionIds].sort(),
    clientIds: [...resolution.clientIds].sort(),
    subjectIds: [...resolution.subjectIds].sort()
  };
}

function addValue(target: Set<string>, value: string | undefined) {
  if (value === undefined || value.length === 0 || target.has(value)) {
    return false;
  }

  target.add(value);
  return true;
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string
) {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function safeIdSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function isExpectedMissingRunError(error: unknown) {
  if (!isNodeError(error)) {
    return false;
  }

  return (
    error.code === "ENOENT" ||
    error.code === "missing_events" ||
    error.code === "unknown_version"
  );
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled correlation seed ${(value as { kind?: string }).kind}`);
}
