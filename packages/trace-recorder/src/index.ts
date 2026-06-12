import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getRunStorePaths } from "@specwright/run-store";
import type { CacheStatus, ToolCallStatus } from "@specwright/schemas";

export const TRACE_RECORDER_VERSION = "0.1.0";

export type TraceSpanKind =
  | "phase"
  | "tool"
  | "mcp"
  | "policy"
  | "eval"
  | "gate"
  | "approval"
  | "cache"
  | "harness.load"
  | "harness.fetch"
  | "harness.verify_trust"
  | "harness.parse"
  | "harness.validate"
  | "harness.resolve_deps"
  | "harness.compatibility"
  | "harness.grant_check"
  | "harness.freeze";

export type TraceSpanStatus =
  | "success"
  | "failed"
  | "denied"
  | "approval_required"
  | "pass"
  | "fail"
  | "needs_review"
  | "skipped"
  | "hit"
  | "miss"
  | "bypass";

export type TraceSpanMetadata = Record<string, unknown> & {
  phaseId?: string;
  toolId?: string;
  toolVersion?: string;
  toolCallId?: string;
  toolStatus?: ToolCallStatus;
  evalId?: string;
  gateId?: string;
  approvalId?: string;
  cacheStatus?: CacheStatus;
  policyStatus?: string;
  decisionHash?: string;
  requestHash?: string;
  policyBundleHash?: string;
  decidingLayer?: string;
  matchedRuleIds?: string[];
  errorCode?: string;
  packageId?: string;
  requestedVersion?: string;
  resolvedPin?: string;
  registryRef?: string;
  specHash?: string;
  contentDigest?: string;
  byteCount?: number;
  sourceUri?: string;
  transport?: string;
  resultStatus?: string;
  definitionCounts?: Record<string, number>;
  fileCount?: number;
  fileListDigest?: string;
  publisherId?: string;
  signingKeyId?: string;
  signatureAlgorithm?: string;
  trustStoreVersion?: string;
  trustVerdict?: string;
  dependencyIds?: string[];
  resolvedVersions?: string[];
  pinnedHashes?: string[];
  unpinnedCount?: number;
  runtimeVersion?: string;
  fromVersion?: string;
  toVersion?: string;
  compatibilityClass?: string;
  compatibilityDecision?: string;
  requestedCapabilities?: string[];
  grantedScopes?: string[];
  deniedCapabilities?: string[];
  attestationId?: string;
};

export type TraceSpan = {
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  name: string;
  status: TraceSpanStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  eventIds?: string[];
  metadata: TraceSpanMetadata;
};

export type TraceFile = {
  runId: string;
  traceId: string;
  runtimeVersion?: string;
  harnessSpecHash?: string;
  hostAdapter?: string;
  spans: TraceSpan[];
  metadata: Record<string, unknown>;
};

export type TraceRecorderOptions = {
  rootDir?: string | undefined;
  runId: string;
  traceId?: string | undefined;
  runtimeVersion?: string | undefined;
  harnessSpecHash?: string | undefined;
  hostAdapter?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type TraceSpanInput = {
  spanId?: string | undefined;
  parentSpanId?: string | undefined;
  kind: TraceSpanKind;
  name: string;
  status: TraceSpanStatus;
  startedAt?: Date | string | undefined;
  endedAt?: Date | string | undefined;
  durationMs?: number | undefined;
  eventIds?: string[] | undefined;
  metadata?: TraceSpanMetadata | undefined;
};

export type ReadTraceOptions = {
  rootDir?: string | undefined;
  runId: string;
};

export type WriteTraceOptions = ReadTraceOptions & {
  trace: TraceFile;
};

export type RecordTraceSpanOptions = TraceRecorderOptions & {
  span: TraceSpanInput;
};

export class TraceRecorder {
  readonly rootDir: string | undefined;
  readonly runId: string;
  readonly traceId: string | undefined;
  readonly runtimeVersion: string | undefined;
  readonly harnessSpecHash: string | undefined;
  readonly hostAdapter: string | undefined;
  readonly metadata: Record<string, unknown> | undefined;

  constructor(options: TraceRecorderOptions) {
    this.rootDir = options.rootDir;
    this.runId = options.runId;
    this.traceId = options.traceId;
    this.runtimeVersion = options.runtimeVersion;
    this.harnessSpecHash = options.harnessSpecHash;
    this.hostAdapter = options.hostAdapter;
    this.metadata = options.metadata;
  }

  async recordSpan(span: TraceSpanInput): Promise<TraceSpan> {
    return recordTraceSpan({
      rootDir: this.rootDir,
      runId: this.runId,
      traceId: this.traceId,
      runtimeVersion: this.runtimeVersion,
      harnessSpecHash: this.harnessSpecHash,
      hostAdapter: this.hostAdapter,
      metadata: this.metadata,
      span
    });
  }

  async read(): Promise<TraceFile> {
    return readTrace({
      rootDir: this.rootDir,
      runId: this.runId
    });
  }
}

export function createTraceRecorder(options: TraceRecorderOptions) {
  return new TraceRecorder(options);
}

export function getTracePath(options: ReadTraceOptions) {
  return getRunStorePaths(options.rootDir, options.runId).tracePath;
}

export async function readTrace(options: ReadTraceOptions): Promise<TraceFile> {
  const raw = await readFile(getTracePath(options), "utf8");
  const parsed = parseTraceFile(JSON.parse(raw) as unknown, options.runId);

  return parsed;
}

export async function writeTrace(options: WriteTraceOptions): Promise<TraceFile> {
  const trace = normalizeTraceFile(options.trace, options.runId);
  const path = getTracePath(options);

  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, trace);

  return trace;
}

export async function recordTraceSpan(
  options: RecordTraceSpanOptions
): Promise<TraceSpan> {
  const existing = await readTraceOrDefault(options);
  const span = normalizeTraceSpan({
    runId: existing.runId,
    traceId: existing.traceId,
    input: options.span
  });
  const next = mergeTraceMetadata(existing, options);

  next.spans = [...next.spans, span];

  await writeTrace({
    rootDir: options.rootDir,
    runId: options.runId,
    trace: next
  });

  return span;
}

function mergeTraceMetadata(
  trace: TraceFile,
  options: TraceRecorderOptions
): TraceFile {
  return {
    ...trace,
    ...(options.runtimeVersion === undefined
      ? {}
      : { runtimeVersion: options.runtimeVersion }),
    ...(options.harnessSpecHash === undefined
      ? {}
      : { harnessSpecHash: options.harnessSpecHash }),
    ...(options.hostAdapter === undefined
      ? {}
      : { hostAdapter: options.hostAdapter }),
    metadata: {
      ...trace.metadata,
      ...(options.metadata ?? {})
    }
  };
}

async function readTraceOrDefault(
  options: TraceRecorderOptions
): Promise<TraceFile> {
  try {
    return await readTrace(options);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    runId: options.runId,
    traceId: options.traceId ?? randomUUID(),
    ...(options.runtimeVersion === undefined
      ? {}
      : { runtimeVersion: options.runtimeVersion }),
    ...(options.harnessSpecHash === undefined
      ? {}
      : { harnessSpecHash: options.harnessSpecHash }),
    ...(options.hostAdapter === undefined
      ? {}
      : { hostAdapter: options.hostAdapter }),
    spans: [],
    metadata: options.metadata ?? {}
  };
}

function parseTraceFile(value: unknown, expectedRunId: string): TraceFile {
  if (!isRecord(value)) {
    throw new TraceRecorderError("invalid_trace", "Trace file must be an object");
  }

  const runId = nonEmpty(value.runId, "runId");
  const traceId = nonEmpty(value.traceId, "traceId");

  if (runId !== expectedRunId) {
    throw new TraceRecorderError(
      "invalid_trace",
      `Trace runId ${runId} did not match expected runId ${expectedRunId}`
    );
  }

  const spans = Array.isArray(value.spans)
    ? value.spans.map((span, index) => parseTraceSpan(span, index, runId, traceId))
    : [];

  return {
    runId,
    traceId,
    ...(typeof value.runtimeVersion === "string"
      ? { runtimeVersion: value.runtimeVersion }
      : {}),
    ...(typeof value.harnessSpecHash === "string"
      ? { harnessSpecHash: value.harnessSpecHash }
      : {}),
    ...(typeof value.hostAdapter === "string"
      ? { hostAdapter: value.hostAdapter }
      : {}),
    spans,
    metadata: isRecord(value.metadata) ? value.metadata : {}
  };
}

function parseTraceSpan(
  value: unknown,
  index: number,
  runId: string,
  traceId: string
): TraceSpan {
  if (!isRecord(value)) {
    throw new TraceRecorderError(
      "invalid_trace",
      `Trace span ${index + 1} must be an object`
    );
  }

  const span = normalizeTraceSpan({
    runId,
    traceId,
    input: {
      spanId: nonEmpty(value.spanId, "spanId"),
      parentSpanId:
        value.parentSpanId === undefined
          ? undefined
          : nonEmpty(value.parentSpanId, "parentSpanId"),
      kind: parseSpanKind(value.kind),
      name: nonEmpty(value.name, "name"),
      status: parseSpanStatus(value.status),
      startedAt: nonEmpty(value.startedAt, "startedAt"),
      endedAt:
        value.endedAt === undefined
          ? undefined
          : nonEmpty(value.endedAt, "endedAt"),
      durationMs:
        typeof value.durationMs === "number" ? value.durationMs : undefined,
      eventIds: parseOptionalStringArray(value.eventIds, "eventIds"),
      metadata: isRecord(value.metadata) ? value.metadata : {}
    }
  });

  if (value.runId !== runId || value.traceId !== traceId) {
    throw new TraceRecorderError(
      "invalid_trace",
      `Trace span ${span.spanId} must use the file runId and traceId`
    );
  }

  return span;
}

function normalizeTraceFile(trace: TraceFile, expectedRunId: string): TraceFile {
  const normalized = parseTraceFile(trace, expectedRunId);

  return {
    ...normalized,
    spans: normalized.spans.map((span) =>
      normalizeTraceSpan({
        runId: normalized.runId,
        traceId: normalized.traceId,
        input: span
      })
    )
  };
}

function normalizeTraceSpan(input: {
  runId: string;
  traceId: string;
  input: TraceSpanInput;
}): TraceSpan {
  const startedAt = normalizeTimestamp(input.input.startedAt);
  const endedAt =
    input.input.endedAt === undefined
      ? undefined
      : normalizeTimestamp(input.input.endedAt);
  const durationMs =
    input.input.durationMs ??
    (endedAt === undefined
      ? undefined
      : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)));

  return {
    runId: input.runId,
    traceId: input.traceId,
    spanId: input.input.spanId ?? randomUUID(),
    ...(input.input.parentSpanId === undefined
      ? {}
      : { parentSpanId: input.input.parentSpanId }),
    kind: input.input.kind,
    name: input.input.name,
    status: input.input.status,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(input.input.eventIds === undefined
      ? {}
      : { eventIds: uniqueStrings(input.input.eventIds) }),
    metadata: input.input.metadata ?? {}
  };
}

export type TraceRecorderErrorCode = "invalid_trace";

export class TraceRecorderError extends Error {
  readonly code: TraceRecorderErrorCode;

  constructor(code: TraceRecorderErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TraceRecorderError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx"
  });
  await rename(tempPath, path);
}

function parseSpanKind(value: unknown): TraceSpanKind {
  if (
    value === "phase" ||
    value === "tool" ||
    value === "mcp" ||
    value === "policy" ||
    value === "eval" ||
    value === "gate" ||
    value === "approval" ||
    value === "cache" ||
    value === "harness.load" ||
    value === "harness.fetch" ||
    value === "harness.verify_trust" ||
    value === "harness.parse" ||
    value === "harness.validate" ||
    value === "harness.resolve_deps" ||
    value === "harness.compatibility" ||
    value === "harness.grant_check" ||
    value === "harness.freeze"
  ) {
    return value;
  }

  throw new TraceRecorderError("invalid_trace", "Trace span kind is invalid");
}

function parseSpanStatus(value: unknown): TraceSpanStatus {
  if (
    value === "success" ||
    value === "failed" ||
    value === "denied" ||
    value === "approval_required" ||
    value === "pass" ||
    value === "fail" ||
    value === "needs_review" ||
    value === "skipped" ||
    value === "hit" ||
    value === "miss" ||
    value === "bypass"
  ) {
    return value;
  }

  throw new TraceRecorderError("invalid_trace", "Trace span status is invalid");
}

function parseOptionalStringArray(value: unknown, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TraceRecorderError(
      "invalid_trace",
      `${label} must be an array of non-empty strings`
    );
  }

  return value;
}

function normalizeTimestamp(timestamp: Date | string | undefined) {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function nonEmpty(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceRecorderError(
      "invalid_trace",
      `${label} must be a non-empty string`
    );
  }

  return value;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}
