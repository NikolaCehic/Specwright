import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getRunStorePaths } from "@specwright/run-store";
import type {
  CacheStatus,
  RuntimeEvent,
  RuntimeEventType,
  ToolCallStatus
} from "@specwright/schemas";

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

export type TraceAttributionField =
  | "runtimeVersion"
  | "harnessSpecHash"
  | "hostAdapter";

export type CoverageRuleStatus = "active" | "pending";

export type CoverageGapReason =
  | "missing_span"
  | "missing_metadata"
  | "missing_event_link"
  | "unattributed_trace"
  | "span_event_disagreement";

export type CoverageRule = {
  eventType: RuntimeEventType;
  requiredSpanKind: TraceSpanKind;
  requiredMetadataKeys: readonly string[];
  requiresEventIdLink: boolean;
  status: CoverageRuleStatus;
};

export type CoverageGap = {
  reason: CoverageGapReason;
  message: string;
  eventId?: string;
  eventType?: RuntimeEventType;
  eventSequence?: number;
  requiredSpanKind?: TraceSpanKind;
  spanId?: string;
  spanKind?: TraceSpanKind;
  field?: TraceAttributionField;
  missingMetadataKeys?: string[];
};

export type CoverageVerdict = {
  complete: boolean;
  attributed: boolean;
  gaps: CoverageGap[];
};

export type GetCoverageVerdictOptions = {
  trace: TraceFile;
  events: readonly RuntimeEvent[];
};

const TOOL_REQUIRED_METADATA = [
  "toolId",
  "toolVersion",
  "toolCallId",
  "toolStatus",
  "cacheStatus",
  "policyStatus"
] as const;

const POLICY_REQUIRED_METADATA = [
  "policyStatus",
  "decisionHash",
  "requestHash",
  "policyBundleHash",
  "decidingLayer",
  "matchedRuleIds"
] as const;

const APPROVAL_REQUIRED_METADATA = ["approvalId", "policyStatus"] as const;

export const MANDATORY_COVERAGE_RULES = [
  {
    eventType: "harness.loaded",
    requiredSpanKind: "harness.load",
    requiredMetadataKeys: ["specHash"],
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "phase.entered",
    requiredSpanKind: "phase",
    requiredMetadataKeys: ["phaseId"],
    requiresEventIdLink: true,
    status: "active"
  },
  {
    eventType: "phase.transitioned",
    requiredSpanKind: "phase",
    requiredMetadataKeys: ["phaseId"],
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "tool.requested",
    requiredSpanKind: "tool",
    requiredMetadataKeys: TOOL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "active"
  },
  {
    eventType: "tool.authorized",
    requiredSpanKind: "tool",
    requiredMetadataKeys: TOOL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "tool.completed",
    requiredSpanKind: "tool",
    requiredMetadataKeys: TOOL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "active"
  },
  {
    eventType: "tool.denied",
    requiredSpanKind: "tool",
    requiredMetadataKeys: TOOL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "active"
  },
  {
    eventType: "tool.completed",
    requiredSpanKind: "cache",
    requiredMetadataKeys: ["cacheStatus"],
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "tool.denied",
    requiredSpanKind: "cache",
    requiredMetadataKeys: ["cacheStatus"],
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "policy.evaluated",
    requiredSpanKind: "policy",
    requiredMetadataKeys: POLICY_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "eval.completed",
    requiredSpanKind: "eval",
    requiredMetadataKeys: ["evalId", "phaseId"],
    requiresEventIdLink: true,
    status: "active"
  },
  {
    eventType: "gate.evaluated",
    requiredSpanKind: "gate",
    requiredMetadataKeys: ["gateId", "phaseId", "instruction"],
    requiresEventIdLink: true,
    status: "active"
  },
  {
    eventType: "decision.recorded",
    requiredSpanKind: "approval",
    requiredMetadataKeys: APPROVAL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "human.input_requested",
    requiredSpanKind: "approval",
    requiredMetadataKeys: APPROVAL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "pending"
  },
  {
    eventType: "human.answer_recorded",
    requiredSpanKind: "approval",
    requiredMetadataKeys: APPROVAL_REQUIRED_METADATA,
    requiresEventIdLink: true,
    status: "pending"
  }
] satisfies readonly CoverageRule[];

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

export async function readTraceForAudit(
  options: ReadTraceOptions
): Promise<TraceFile> {
  const trace = await readTrace(options);

  assertTraceAttributed(trace);
  assertCoverageMetadataComplete(trace);

  return trace;
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

export function assertTraceAttributed(trace: TraceFile): asserts trace is TraceFile & {
  runtimeVersion: string;
  harnessSpecHash: string;
  hostAdapter: string;
} {
  const missingFields = missingAttributionFields(trace);

  if (missingFields.length > 0) {
    throw new TraceRecorderError(
      "invalid_trace",
      `Trace file is missing required attribution field ${missingFields.join(", ")}`
    );
  }
}

export function getCoverageVerdict({
  trace,
  events
}: GetCoverageVerdictOptions): CoverageVerdict {
  const normalizedTrace = normalizeTraceFile(trace, trace.runId);
  const gaps: CoverageGap[] = missingAttributionFields(normalizedTrace).map(
    (field) => ({
      reason: "unattributed_trace",
      field,
      message: `Trace file is missing required attribution field ${field}`
    })
  );

  for (const event of stableEvents(events)) {
    for (const rule of rulesForEvent(event.type)) {
      gaps.push(...coverageGapsForEvent(normalizedTrace, event, rule));
    }
  }

  gaps.push(...spanEventDisagreementGaps(normalizedTrace, events));

  const sortedGaps = sortCoverageGaps(dedupeCoverageGaps(gaps));
  const attributed = missingAttributionFields(normalizedTrace).length === 0;

  return {
    complete: attributed && sortedGaps.length === 0,
    attributed,
    gaps: sortedGaps
  };
}

function assertCoverageMetadataComplete(trace: TraceFile) {
  const normalized = normalizeTraceFile(trace, trace.runId);

  for (const span of normalized.spans) {
    const missingKeys = missingMetadataKeys(
      span.metadata,
      requiredMetadataKeysForSpanKind(span.kind)
    );

    if (missingKeys.length > 0) {
      throw new TraceRecorderError(
        "invalid_trace",
        `Trace span ${span.spanId} (${span.kind}) is missing required metadata ${missingKeys.join(", ")}`
      );
    }
  }
}

function missingAttributionFields(trace: TraceFile): TraceAttributionField[] {
  return (["runtimeVersion", "harnessSpecHash", "hostAdapter"] as const).filter(
    (field) => !hasMetadataValue(trace[field])
  );
}

function rulesForEvent(type: RuntimeEventType) {
  return activeCoverageRules().filter((rule) => rule.eventType === type);
}

function stableEvents(events: readonly RuntimeEvent[]) {
  return [...events].sort((left, right) => {
    const bySequence = left.sequence - right.sequence;

    if (bySequence !== 0) {
      return bySequence;
    }

    return left.id.localeCompare(right.id);
  });
}

function coverageGapsForEvent(
  trace: TraceFile,
  event: RuntimeEvent,
  rule: CoverageRule
): CoverageGap[] {
  const spansOfKind = trace.spans.filter(
    (span) => span.kind === rule.requiredSpanKind
  );
  const matchingSpans = rule.requiresEventIdLink
    ? spansOfKind.filter((span) => span.eventIds?.includes(event.id) ?? false)
    : spansOfKind;

  if (matchingSpans.length === 0) {
    return [
      spansOfKind.length === 0
        ? coverageGap({
            reason: "missing_span",
            event,
            rule,
            message: `Event ${event.id} (${event.type}) requires a ${rule.requiredSpanKind} span`
          })
        : coverageGap({
            reason: "missing_event_link",
            event,
            rule,
            message: `Event ${event.id} (${event.type}) requires a linked ${rule.requiredSpanKind} span eventIds entry`
          })
    ];
  }

  const gaps: CoverageGap[] = [];

  for (const span of matchingSpans) {
    const missingKeys = missingMetadataKeys(
      span.metadata,
      rule.requiredMetadataKeys
    );

    if (missingKeys.length > 0) {
      gaps.push(
        coverageGap({
          reason: "missing_metadata",
          event,
          rule,
          span,
          missingMetadataKeys: missingKeys,
          message: `Span ${span.spanId} (${span.kind}) is missing required metadata ${missingKeys.join(", ")} for event ${event.id}`
        })
      );
    }

    const expectedStatuses = expectedStatusesForEvent(event, rule);

    if (
      expectedStatuses.length > 0 &&
      !expectedStatuses.includes(span.status)
    ) {
      gaps.push(
        coverageGap({
          reason: "span_event_disagreement",
          event,
          rule,
          span,
          message: `Span ${span.spanId} status ${span.status} disagrees with event ${event.id} (${event.type}); expected ${expectedStatuses.join(" or ")}`
        })
      );
    }
  }

  return gaps;
}

function coverageGap(input: {
  reason: CoverageGapReason;
  event: RuntimeEvent;
  rule: CoverageRule;
  message: string;
  span?: TraceSpan | undefined;
  missingMetadataKeys?: string[] | undefined;
}): CoverageGap {
  return {
    reason: input.reason,
    eventId: input.event.id,
    eventType: input.event.type,
    eventSequence: input.event.sequence,
    requiredSpanKind: input.rule.requiredSpanKind,
    ...(input.span === undefined
      ? {}
      : {
          spanId: input.span.spanId,
          spanKind: input.span.kind
        }),
    ...(input.missingMetadataKeys === undefined
      ? {}
      : { missingMetadataKeys: input.missingMetadataKeys }),
    message: input.message
  };
}

function requiredMetadataKeysForSpanKind(kind: TraceSpanKind) {
  return uniqueStrings(
    activeCoverageRules()
      .filter((rule) => rule.requiredSpanKind === kind)
      .flatMap((rule) => [...rule.requiredMetadataKeys])
  );
}

function activeCoverageRules() {
  return MANDATORY_COVERAGE_RULES.filter((rule) => rule.status === "active");
}

function missingMetadataKeys(
  metadata: TraceSpanMetadata,
  requiredKeys: readonly string[]
) {
  return requiredKeys.filter((key) => !hasMetadataValue(metadata[key]));
}

function hasMetadataValue(value: unknown) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function expectedStatusesForEvent(
  event: RuntimeEvent,
  rule: CoverageRule
): TraceSpanStatus[] {
  switch (event.type) {
    case "harness.loaded":
    case "phase.entered":
    case "phase.transitioned":
      return ["success"];
    case "tool.completed":
      if (rule.requiredSpanKind === "cache") {
        return [event.payload.result.provenance.cacheStatus];
      }

      return [event.payload.result.status];
    case "tool.denied":
      if (rule.requiredSpanKind === "cache") {
        return event.payload.result === undefined
          ? []
          : [event.payload.result.provenance.cacheStatus];
      }

      return ["denied"];
    case "policy.evaluated":
      return [policyStatusToSpanStatus(event.payload.status)];
    case "eval.completed":
      return [event.payload.verdict.status];
    case "gate.evaluated":
      return [event.payload.verdict.status];
    case "decision.recorded":
      return approvalDecisionToSpanStatus(event.payload.decision?.decision);
    case "human.input_requested":
      return ["approval_required"];
    case "human.answer_recorded":
      return ["success"];
    default:
      return [];
  }
}

function policyStatusToSpanStatus(status: "allow" | "deny" | "approval_required") {
  switch (status) {
    case "allow":
      return "success";
    case "deny":
      return "denied";
    case "approval_required":
      return "approval_required";
  }
}

function approvalDecisionToSpanStatus(
  decision: "approved" | "approved_with_changes" | "rejected" | undefined
): TraceSpanStatus[] {
  switch (decision) {
    case "approved":
    case "approved_with_changes":
      return ["success"];
    case "rejected":
      return ["denied"];
    default:
      return [];
  }
}

function spanEventDisagreementGaps(
  trace: TraceFile,
  events: readonly RuntimeEvent[]
) {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const gaps: CoverageGap[] = [];

  for (const span of trace.spans) {
    for (const eventId of span.eventIds ?? []) {
      if (!eventsById.has(eventId)) {
        gaps.push({
          reason: "span_event_disagreement",
          spanId: span.spanId,
          spanKind: span.kind,
          requiredSpanKind: span.kind,
          message: `Span ${span.spanId} links to unknown event ${eventId}`
        });
      }
    }

    if (span.kind !== "tool") {
      continue;
    }

    const linkedEvents = (span.eventIds ?? [])
      .map((eventId) => eventsById.get(eventId))
      .filter((event): event is RuntimeEvent => event !== undefined);

    if (span.status === "denied") {
      if (!linkedEvents.some((event) => event.type === "tool.denied")) {
        gaps.push(toolStatusDisagreementGap(span, "tool.denied"));
      }
      continue;
    }

    if (
      span.status === "success" ||
      span.status === "failed" ||
      span.status === "approval_required"
    ) {
      const completedEvent = linkedEvents.find(
        (event) => event.type === "tool.completed"
      );

      if (completedEvent === undefined) {
        gaps.push(toolStatusDisagreementGap(span, "tool.completed"));
      } else if (completedEvent.payload.result.status !== span.status) {
        gaps.push({
          reason: "span_event_disagreement",
          eventId: completedEvent.id,
          eventType: completedEvent.type,
          eventSequence: completedEvent.sequence,
          requiredSpanKind: "tool",
          spanId: span.spanId,
          spanKind: span.kind,
          message: `Span ${span.spanId} status ${span.status} disagrees with event ${completedEvent.id} (${completedEvent.type}); expected ${completedEvent.payload.result.status}`
        });
      }
    }
  }

  return gaps;
}

function toolStatusDisagreementGap(
  span: TraceSpan,
  requiredEventType: "tool.completed" | "tool.denied"
): CoverageGap {
  return {
    reason: "span_event_disagreement",
    requiredSpanKind: "tool",
    spanId: span.spanId,
    spanKind: span.kind,
    message: `Span ${span.spanId} status ${span.status} requires a linked ${requiredEventType} event`
  };
}

function dedupeCoverageGaps(gaps: readonly CoverageGap[]) {
  const seen = new Set<string>();
  const deduped: CoverageGap[] = [];

  for (const gap of gaps) {
    const key = JSON.stringify(gap);

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(gap);
    }
  }

  return deduped;
}

function sortCoverageGaps(gaps: readonly CoverageGap[]) {
  return [...gaps].sort((left, right) => {
    const leftSequence = left.eventSequence ?? -1;
    const rightSequence = right.eventSequence ?? -1;
    const bySequence = leftSequence - rightSequence;

    if (bySequence !== 0) {
      return bySequence;
    }

    return [
      compareStrings(left.eventId, right.eventId),
      compareStrings(left.reason, right.reason),
      compareStrings(left.requiredSpanKind, right.requiredSpanKind),
      compareStrings(left.spanId, right.spanId),
      compareStrings(left.field, right.field),
      compareStrings(
        left.missingMetadataKeys?.join(","),
        right.missingMetadataKeys?.join(",")
      ),
      compareStrings(left.message, right.message)
    ].find((comparison) => comparison !== 0) ?? 0;
  });
}

function compareStrings(left: string | undefined, right: string | undefined) {
  return (left ?? "").localeCompare(right ?? "");
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
