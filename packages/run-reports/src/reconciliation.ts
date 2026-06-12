import type { RuntimeEvent, RuntimeEventType } from "@specwright/schemas";
import {
  MANDATORY_COVERAGE_RULES,
  type CoverageRule,
  type TraceFile,
  type TraceSpan,
  type TraceSpanStatus
} from "@specwright/trace-recorder";
import {
  computeIntegrityMetrics,
  type IntegrityMetric,
  type SourceEventRange
} from "./integrity-metrics";

export type ReconciliationVerdict = "consistent" | "gap" | "mismatch";

export type MandatoryCoverageStatus = "linked" | "missing" | "unlinkable";

export type MandatoryCoverageRecord = {
  status: MandatoryCoverageStatus;
  eventId?: string | undefined;
  eventType?: RuntimeEventType | undefined;
  eventSequence?: number | undefined;
  requiredSpanKind: CoverageRule["requiredSpanKind"];
  requiredMetadataKeys: string[];
  spanId?: string | undefined;
  spanKind?: TraceSpan["kind"] | undefined;
  missingMetadataKeys?: string[] | undefined;
};

export type ReconciliationGapKind =
  | "missing_trace"
  | "missing_coverage"
  | "missing_metadata"
  | "missing_span_event_link"
  | "unlinkable_span_event";

export type ReconciliationGap = {
  kind: ReconciliationGapKind;
  message: string;
  eventId?: string | undefined;
  eventType?: RuntimeEventType | undefined;
  eventSequence?: number | undefined;
  spanId?: string | undefined;
  spanKind?: TraceSpan["kind"] | undefined;
  unknownEventId?: string | undefined;
  requiredSpanKind?: CoverageRule["requiredSpanKind"] | undefined;
  missingMetadataKeys?: string[] | undefined;
};

export type ReconciliationMismatch = {
  kind: "span_event_status_disagreement";
  message: string;
  eventId: string;
  eventType: RuntimeEventType;
  eventSequence: number;
  spanId: string;
  spanKind: TraceSpan["kind"];
  assertedSpanStatus?: TraceSpan["status"] | undefined;
  observedSpanStatus: TraceSpan["status"];
  authoritativeEventStatus: string;
  requiredAuthoritativeEventType?: RuntimeEventType | undefined;
  linkedAuthoritativeEventTypes?: RuntimeEventType[] | undefined;
};

export type ReconciliationResult = {
  verdict: ReconciliationVerdict;
  sourceEventRange: SourceEventRange;
  mandatoryCoverage: MandatoryCoverageRecord[];
  gaps: ReconciliationGap[];
  mismatches: ReconciliationMismatch[];
  integrityMetrics: IntegrityMetric[];
  missingInputs: string[];
};

export type ReconcileEventsAndTraceInput = {
  events: readonly RuntimeEvent[];
  trace?: TraceFile | undefined;
  missingInputs: readonly string[];
  schemaValidationFailures?: number | undefined;
};

type LinkedKey = `${string}\u0000${string}`;

type EventIndex = {
  byId: Map<string, RuntimeEvent>;
  byType: Map<RuntimeEventType, RuntimeEvent[]>;
};

export function reconcileEventsAndTrace(
  input: ReconcileEventsAndTraceInput
): ReconciliationResult {
  const events = stableEvents(input.events);
  const trace = input.trace;
  const eventIndex = eventIndexFromEvents(events);
  const sourceEventRange = sourceEventRangeFromEvents(events);
  const mandatoryCoverage: MandatoryCoverageRecord[] = [];
  const gaps: ReconciliationGap[] = [];
  const mismatches: ReconciliationMismatch[] = [];

  if (trace === undefined) {
    gaps.push({
      kind: "missing_trace",
      message: "Missing trace.json prevents trace-to-event attestation."
    });
  } else {
    for (const unlinked of missingRequiredEventLinkSpans(trace)) {
      mandatoryCoverage.push({
        status: "unlinkable",
        requiredSpanKind: unlinked.span.kind,
        requiredMetadataKeys: unlinked.requiredMetadataKeys,
        spanId: unlinked.span.spanId,
        spanKind: unlinked.span.kind
      });
      gaps.push({
        kind: "missing_span_event_link",
        message: `Span ${unlinked.span.spanId} (${unlinked.span.kind}) is missing required eventIds links.`,
        spanId: unlinked.span.spanId,
        spanKind: unlinked.span.kind,
        requiredSpanKind: unlinked.span.kind
      });
    }

    for (const unlinkable of unlinkableSpanEvents(trace, eventIndex.byId)) {
      mandatoryCoverage.push({
        status: "unlinkable",
        requiredSpanKind: unlinkable.span.kind,
        requiredMetadataKeys: [],
        spanId: unlinkable.span.spanId,
        spanKind: unlinkable.span.kind
      });
      gaps.push({
        kind: "unlinkable_span_event",
        message: `Span ${unlinkable.span.spanId} links to unknown event ${unlinkable.eventId}.`,
        spanId: unlinkable.span.spanId,
        spanKind: unlinkable.span.kind,
        unknownEventId: unlinkable.eventId,
        requiredSpanKind: unlinkable.span.kind
      });
    }

    mismatches.push(...toolOutcomeMismatches(trace, eventIndex.byId));
  }

  for (const rule of activeCoverageRules()) {
    for (const event of eventIndex.byType.get(rule.eventType) ?? []) {
      if (trace === undefined) {
        mandatoryCoverage.push(missingCoverageRecord(event, rule));
        gaps.push(missingCoverageGap(event, rule));
        continue;
      }

      const matchingSpans = spansMatchingRule(trace, event, rule);

      if (matchingSpans.length === 0) {
        mandatoryCoverage.push(missingCoverageRecord(event, rule));
        gaps.push(missingCoverageGap(event, rule));
        continue;
      }

      for (const span of matchingSpans) {
        const missingMetadataKeys = missingMetadata(
          span,
          rule.requiredMetadataKeys
        );
        const coverageRecord: MandatoryCoverageRecord = {
          status: "linked",
          eventId: event.id,
          eventType: event.type,
          eventSequence: event.sequence,
          requiredSpanKind: rule.requiredSpanKind,
          requiredMetadataKeys: [...rule.requiredMetadataKeys].sort(),
          spanId: span.spanId,
          spanKind: span.kind,
          ...(missingMetadataKeys.length === 0
            ? {}
            : { missingMetadataKeys })
        };

        mandatoryCoverage.push(coverageRecord);

        if (missingMetadataKeys.length > 0) {
          gaps.push({
            kind: "missing_metadata",
            message: `Span ${span.spanId} is missing metadata ${missingMetadataKeys.join(", ")} for event ${event.id}.`,
            eventId: event.id,
            eventType: event.type,
            eventSequence: event.sequence,
            spanId: span.spanId,
            spanKind: span.kind,
            requiredSpanKind: rule.requiredSpanKind,
            missingMetadataKeys
          });
        }

        const mismatch = statusMismatch(event, span);

        if (mismatch !== undefined) {
          mismatches.push(mismatch);
        }
      }
    }
  }

  const sortedCoverage = sortMandatoryCoverage(mandatoryCoverage);
  const sortedGaps = sortGaps(dedupeByJson(gaps));
  const sortedMismatches = sortMismatches(dedupeByJson(mismatches));
  const mismatchKeys = new Set(
    sortedMismatches.map((mismatch) => linkedKey(mismatch.eventId, mismatch.spanId))
  );
  const consistentTraceEventLinks = sortedCoverage.filter(
    (record) =>
      record.status === "linked" &&
      record.eventId !== undefined &&
      record.spanId !== undefined &&
      record.missingMetadataKeys === undefined &&
      !mismatchKeys.has(linkedKey(record.eventId, record.spanId))
  ).length;
  const totalTraceEventLinks = sortedCoverage.length;
  const integrityMetrics = computeIntegrityMetrics({
    sourceEventRange,
    consistentTraceEventLinks,
    totalTraceEventLinks,
    missingInputs: input.missingInputs,
    schemaValidationFailures: input.schemaValidationFailures,
    tenantId: tenantIdFromEvents(events)
  });
  const missingTraceInput = input.missingInputs.includes("trace.json");
  const verdict =
    sortedMismatches.length > 0
      ? "mismatch"
      : sortedGaps.length > 0 || missingTraceInput
        ? "gap"
        : "consistent";

  return {
    verdict,
    sourceEventRange,
    mandatoryCoverage: sortedCoverage,
    gaps: sortedGaps,
    mismatches: sortedMismatches,
    integrityMetrics,
    missingInputs: [...input.missingInputs].sort()
  };
}

export function sourceEventRangeFromEvents(
  events: readonly RuntimeEvent[]
): SourceEventRange {
  if (events.length === 0) {
    return {
      firstSequence: 0,
      lastSequence: -1,
      eventCount: 0
    };
  }

  const sequences = events.map((event) => event.sequence);

  return {
    firstSequence: Math.min(...sequences),
    lastSequence: Math.max(...sequences),
    eventCount: events.length
  };
}

function eventIndexFromEvents(events: readonly RuntimeEvent[]): EventIndex {
  const byId = new Map<string, RuntimeEvent>();
  const byType = new Map<RuntimeEventType, RuntimeEvent[]>();

  for (const event of events) {
    byId.set(event.id, event);
    byType.set(event.type, [...(byType.get(event.type) ?? []), event]);
  }

  return { byId, byType };
}

function activeCoverageRules() {
  return MANDATORY_COVERAGE_RULES.filter(
    (rule) => rule.status === "active"
  );
}

function spansMatchingRule(
  trace: TraceFile,
  event: RuntimeEvent,
  rule: CoverageRule
) {
  return stableSpans(trace.spans).filter(
    (span) =>
      span.kind === rule.requiredSpanKind &&
      (!rule.requiresEventIdLink || (span.eventIds?.includes(event.id) ?? false))
  );
}

function missingRequiredEventLinkSpans(trace: TraceFile) {
  return stableSpans(trace.spans).flatMap((span) => {
    const linkRules = activeCoverageRules().filter(
      (rule) =>
        rule.requiresEventIdLink && rule.requiredSpanKind === span.kind
    );

    if (linkRules.length === 0 || (span.eventIds?.length ?? 0) > 0) {
      return [];
    }

    return [
      {
        span,
        requiredMetadataKeys: uniqueStrings(
          linkRules.flatMap((rule) => [...rule.requiredMetadataKeys])
        ).sort()
      }
    ];
  });
}

function unlinkableSpanEvents(
  trace: TraceFile,
  eventById: ReadonlyMap<string, RuntimeEvent>
) {
  return stableSpans(trace.spans).flatMap((span) =>
    [...(span.eventIds ?? [])]
      .filter((eventId) => !eventById.has(eventId))
      .sort()
      .map((eventId) => ({ span, eventId }))
  );
}

function missingCoverageRecord(
  event: RuntimeEvent,
  rule: CoverageRule
): MandatoryCoverageRecord {
  return {
    status: "missing",
    eventId: event.id,
    eventType: event.type,
    eventSequence: event.sequence,
    requiredSpanKind: rule.requiredSpanKind,
    requiredMetadataKeys: [...rule.requiredMetadataKeys].sort()
  };
}

function missingCoverageGap(
  event: RuntimeEvent,
  rule: CoverageRule
): ReconciliationGap {
  return {
    kind: "missing_coverage",
    message: `Event ${event.id} (${event.type}) lacks linked ${rule.requiredSpanKind} trace coverage.`,
    eventId: event.id,
    eventType: event.type,
    eventSequence: event.sequence,
    requiredSpanKind: rule.requiredSpanKind
  };
}

function missingMetadata(span: TraceSpan, requiredKeys: readonly string[]) {
  return [...requiredKeys]
    .filter((key) => !hasMetadataValue(span.metadata[key]))
    .sort();
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

function statusMismatch(
  event: RuntimeEvent,
  span: TraceSpan
): ReconciliationMismatch | undefined {
  const expectedStatus = expectedStatusForEvent(event);

  if (expectedStatus === undefined || span.status === expectedStatus) {
    return undefined;
  }

  return {
    kind: "span_event_status_disagreement",
    message: `Span ${span.spanId} status ${span.status} disagrees with authoritative event ${event.id} (${event.type}) status ${expectedStatus}.`,
    eventId: event.id,
    eventType: event.type,
    eventSequence: event.sequence,
    spanId: span.spanId,
    spanKind: span.kind,
    assertedSpanStatus: span.status,
    observedSpanStatus: span.status,
    authoritativeEventStatus: expectedStatus
  };
}

function toolOutcomeMismatches(
  trace: TraceFile,
  eventById: ReadonlyMap<string, RuntimeEvent>
): ReconciliationMismatch[] {
  return stableSpans(trace.spans).flatMap((span) => {
    if (span.kind !== "tool") {
      return [];
    }

    const expectation = expectedToolOutcomeForSpan(span);

    if (expectation === undefined) {
      return [];
    }

    const linkedEvents = (span.eventIds ?? [])
      .map((eventId) => eventById.get(eventId))
      .filter((event): event is RuntimeEvent => event !== undefined)
      .sort(compareEvents);
    const linkedOutcomeEvents = linkedEvents.filter(isToolOutcomeEvent);

    if (
      linkedOutcomeEvents.some(
        (event) =>
          event.type === expectation.eventType &&
          expectedStatusForEvent(event) === expectation.status
      )
    ) {
      return [];
    }

    if (linkedOutcomeEvents.length > 0 || linkedEvents.length === 0) {
      return [];
    }

    const anchorEvent = linkedEvents[0];

    if (anchorEvent === undefined) {
      return [];
    }

    return [
      {
        kind: "span_event_status_disagreement" as const,
        message: `Span ${span.spanId} asserts ${span.status} but linked authoritative events do not include ${expectation.eventType} with status ${expectation.status}.`,
        eventId: anchorEvent.id,
        eventType: anchorEvent.type,
        eventSequence: anchorEvent.sequence,
        spanId: span.spanId,
        spanKind: span.kind,
        assertedSpanStatus: span.status,
        observedSpanStatus: span.status,
        authoritativeEventStatus: `missing ${expectation.eventType}:${expectation.status}`,
        requiredAuthoritativeEventType: expectation.eventType,
        linkedAuthoritativeEventTypes: linkedOutcomeEvents.map((event) => event.type)
      }
    ];
  });
}

function expectedToolOutcomeForSpan(
  span: TraceSpan
): { eventType: "tool.completed" | "tool.denied"; status: TraceSpanStatus } | undefined {
  switch (span.status) {
    case "denied":
      return { eventType: "tool.denied", status: "denied" };
    case "failed":
    case "success":
      return { eventType: "tool.completed", status: span.status };
    default:
      return undefined;
  }
}

function isToolOutcomeEvent(
  event: RuntimeEvent
): event is RuntimeEvent & { type: "tool.completed" | "tool.denied" } {
  return event.type === "tool.completed" || event.type === "tool.denied";
}

function expectedStatusForEvent(event: RuntimeEvent): TraceSpanStatus | undefined {
  const payload = recordFromUnknown(event.payload);

  switch (event.type) {
    case "phase.entered":
    case "phase.transitioned":
      return "success";
    case "tool.completed":
      return stringValue(recordFromUnknown(payload.result).status) as
        | TraceSpanStatus
        | undefined;
    case "tool.denied":
      return "denied";
    case "eval.completed":
      return stringValue(recordFromUnknown(payload.verdict).status) as
        | TraceSpanStatus
        | undefined;
    case "gate.evaluated":
      return stringValue(recordFromUnknown(payload.verdict).status) as
        | TraceSpanStatus
        | undefined;
    default:
      return undefined;
  }
}

function stableEvents(events: readonly RuntimeEvent[]) {
  return [...events].sort((left, right) => {
    return compareEvents(left, right);
  });
}

function compareEvents(left: RuntimeEvent, right: RuntimeEvent) {
  const sequence = left.sequence - right.sequence;

  if (sequence !== 0) {
    return sequence;
  }

  return left.id.localeCompare(right.id);
}

function stableSpans(spans: readonly TraceSpan[]) {
  return [...spans].sort((left, right) => {
    const startedAt = left.startedAt.localeCompare(right.startedAt);

    if (startedAt !== 0) {
      return startedAt;
    }

    return left.spanId.localeCompare(right.spanId);
  });
}

function sortMandatoryCoverage(records: readonly MandatoryCoverageRecord[]) {
  return [...records].sort((left, right) =>
    [
      compareOptionalNumber(left.eventSequence, right.eventSequence),
      compareOptionalString(left.eventType, right.eventType),
      compareOptionalString(left.eventId, right.eventId),
      left.requiredSpanKind.localeCompare(right.requiredSpanKind),
      compareOptionalString(left.spanId, right.spanId),
      left.status.localeCompare(right.status)
    ].find((value) => value !== 0) ?? 0
  );
}

function sortGaps(gaps: readonly ReconciliationGap[]) {
  return [...gaps].sort((left, right) =>
    [
      compareOptionalNumber(left.eventSequence, right.eventSequence),
      left.kind.localeCompare(right.kind),
      compareOptionalString(left.eventType, right.eventType),
      compareOptionalString(left.eventId, right.eventId),
      compareOptionalString(left.spanId, right.spanId),
      compareOptionalString(left.unknownEventId, right.unknownEventId)
    ].find((value) => value !== 0) ?? 0
  );
}

function sortMismatches(mismatches: readonly ReconciliationMismatch[]) {
  return [...mismatches].sort((left, right) =>
    [
      left.eventSequence - right.eventSequence,
      left.eventType.localeCompare(right.eventType),
      left.eventId.localeCompare(right.eventId),
      left.spanId.localeCompare(right.spanId)
    ].find((value) => value !== 0) ?? 0
  );
}

function dedupeByJson<T>(items: readonly T[]) {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    const key = JSON.stringify(item);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(item);
  }

  return output;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function linkedKey(eventId: string, spanId: string): LinkedKey {
  return `${eventId}\u0000${spanId}`;
}

function tenantIdFromEvents(events: readonly RuntimeEvent[]) {
  for (const event of events) {
    const tenantId =
      stringValue(recordFromUnknown(event).tenantId) ??
      stringValue(recordFromUnknown(event.payload).tenantId);

    if (tenantId !== undefined) {
      return tenantId;
    }
  }

  return undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareOptionalString(left: string | undefined, right: string | undefined) {
  return (left ?? "").localeCompare(right ?? "");
}

function compareOptionalNumber(left: number | undefined, right: number | undefined) {
  return (left ?? -1) - (right ?? -1);
}
