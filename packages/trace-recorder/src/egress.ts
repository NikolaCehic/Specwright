import { createHash } from "node:crypto";
import {
  DEFAULT_REDACTION_PROFILE,
  type RedactionProfile
} from "@specwright/run-store";
import {
  RedactionClassSchema,
  redactionClassAtLeast,
  type RedactionClass
} from "@specwright/schemas";
import type { TraceFile, TraceSpanMetadata } from "./index";

export const TRACE_EGRESS_SINKS = [
  "report",
  "trace-export",
  "metrics",
  "mcp-resource"
] as const;

export type TraceEgressSink = (typeof TRACE_EGRESS_SINKS)[number];

export type TraceEgressErrorCode =
  | "unscoped_egress"
  | "cross_tenant_egress"
  | "unlabeled_restricted_field"
  | "invalid_egress_request";

export type TraceEgressRequest = {
  tenantScope: string;
  sink: TraceEgressSink;
  requester?: string | undefined;
  actor?: string | undefined;
  requestedAt?: Date | string | undefined;
};

export type TraceRedactedShape =
  | { type: "array"; length: number }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "number" }
  | { type: "object"; fields: string[] }
  | { type: "string"; length: number }
  | { type: "unknown" };

export type TraceRedactedValue = {
  redacted: true;
  redactionClass: RedactionClass;
  decision: "hash_and_structure" | "restrict";
  hash: string;
  contentHash: string;
  shape: TraceRedactedShape;
  reasonCode?: TraceEgressErrorCode | undefined;
};

export type TraceEgressAuditRecord = {
  recordKind: "egress_audit";
  action: "reject" | "restrict";
  reasonCode: TraceEgressErrorCode;
  tenantScope?: string | undefined;
  requestedTenantScope?: string | undefined;
  sink: TraceEgressSink | string;
  requester?: string | undefined;
  actor?: string | undefined;
  runId: string;
  traceId: string;
  subjectRefs: string[];
  subjectHashes: string[];
  timestamp: string;
  message: string;
};

export type TraceEgressRestriction = {
  path: string;
  reasonCode: TraceEgressErrorCode;
  hash: string;
  shape: TraceRedactedShape;
  redactionClass: RedactionClass;
};

export type TraceEgressResult = {
  trace: TraceFile;
  tenantScope: string;
  sink: TraceEgressSink;
  auditRecords: TraceEgressAuditRecord[];
  restrictions: TraceEgressRestriction[];
};

export class TraceEgressError extends Error {
  readonly code: TraceEgressErrorCode;
  readonly auditRecords: TraceEgressAuditRecord[];

  constructor(
    code: TraceEgressErrorCode,
    message: string,
    auditRecords: TraceEgressAuditRecord[] = []
  ) {
    super(message);
    this.name = "TraceEgressError";
    this.code = code;
    this.auditRecords = auditRecords;
  }
}

type TraceEgressRequestInput = {
  tenantScope?: unknown;
  sink?: unknown;
  requester?: unknown;
  actor?: unknown;
  requestedAt?: unknown;
};

type NormalizedTraceEgressRequest = {
  tenantScope: string;
  sink: TraceEgressSink;
  requester?: string | undefined;
  actor?: string | undefined;
  requestedAt?: Date | string | undefined;
};

type RedactionContext = {
  request: NormalizedTraceEgressRequest;
  trace: TraceFile;
  profile: NormalizedRedactionProfile;
  auditRecords: TraceEgressAuditRecord[];
  restrictions: TraceEgressRestriction[];
  path: readonly string[];
  ancestors: readonly Record<string, unknown>[];
};

type NormalizedRedactionProfile = {
  fieldClasses: Record<string, RedactionClass>;
  defaultClass?: RedactionClass | undefined;
};

const SECRET_BEARING_FIELD_NAMES = new Set([
  "args",
  "claim",
  "content",
  "output",
  "secret",
  "sourceText",
  "text"
]);

const KNOWN_TRACE_EGRESS_FIELD_NAMES = new Set([
  "actor",
  "approvalId",
  "args",
  "argsHash",
  "attestationId",
  "byteCount",
  "cacheStatus",
  "clientId",
  "compatibilityClass",
  "compatibilityDecision",
  "content",
  "contentDigest",
  "contentHash",
  "decision",
  "decisionHash",
  "decidingLayer",
  "definitionCounts",
  "deniedCapabilities",
  "dependencyIds",
  "durationMs",
  "egress",
  "endedAt",
  "errorCode",
  "eventIds",
  "fields",
  "fileCount",
  "fileListDigest",
  "fromVersion",
  "gateId",
  "grantedScopes",
  "hash",
  "harnessSpecHash",
  "hostAdapter",
  "kind",
  "length",
  "matchedRuleIds",
  "mcpRequestId",
  "metadata",
  "name",
  "output",
  "packageId",
  "parentSpanId",
  "phase",
  "phaseId",
  "pinnedHashes",
  "policyBundleHash",
  "policyStatus",
  "publisherId",
  "reasonCode",
  "redacted",
  "redactedAt",
  "redactionClass",
  "registryRef",
  "requestHash",
  "requestedCapabilities",
  "requestedVersion",
  "resolvedPin",
  "resolvedVersions",
  "result",
  "resultHash",
  "resultStatus",
  "runtimeOperation",
  "runtimeVersion",
  "runId",
  "shape",
  "signatureAlgorithm",
  "signedAt",
  "signingKeyId",
  "sink",
  "sourceText",
  "sourceUri",
  "spanId",
  "spans",
  "specHash",
  "startedAt",
  "status",
  "subjectId",
  "tenantId",
  "tenantScope",
  "toolCallId",
  "toolId",
  "toolName",
  "toolStatus",
  "toolVersion",
  "toVersion",
  "traceId",
  "transport",
  "trustStoreVersion",
  "trustVerdict",
  "type",
  "unpinnedCount"
]);

export function redactTraceForEgress(
  trace: TraceFile,
  request: TraceEgressRequest | TraceEgressRequestInput,
  options: { profile?: RedactionProfile | undefined } = {}
): TraceEgressResult {
  const normalizedRequest = normalizeTraceEgressRequest(request);

  if (normalizedRequest instanceof TraceEgressError) {
    throw traceRejection(trace, request, normalizedRequest.code, normalizedRequest.message);
  }

  const observedTenants = collectTenantScopes(trace);
  const mismatchedTenant = observedTenants.find(
    (tenant) => tenant !== normalizedRequest.tenantScope
  );

  if (mismatchedTenant !== undefined) {
    throw traceRejection(
      trace,
      normalizedRequest,
      "cross_tenant_egress",
      `Trace egress tenant scope ${normalizedRequest.tenantScope} does not match observed tenant scope ${mismatchedTenant}`
    );
  }

  const context: RedactionContext = {
    request: normalizedRequest,
    trace,
    profile: normalizeRedactionProfile(options.profile ?? DEFAULT_REDACTION_PROFILE),
    auditRecords: [],
    restrictions: [],
    path: [],
    ancestors: []
  };
  const metadata = redactMetadata(trace.metadata, {
    ...context,
    path: ["metadata"]
  });
  const traceExport: TraceFile = {
    ...trace,
    spans: trace.spans.map((span, index) => ({
      ...span,
      metadata: redactMetadata(span.metadata, {
        ...context,
        path: ["spans", String(index), "metadata"],
        ancestors: [span.metadata]
      })
    })),
    metadata: {
      ...metadata,
      tenantId: normalizedRequest.tenantScope,
      egress: {
        tenantScope: normalizedRequest.tenantScope,
        sink: normalizedRequest.sink,
        runId: trace.runId,
        traceId: trace.traceId,
        redactedAt: normalizeTimestamp(normalizedRequest.requestedAt)
      }
    }
  };

  return {
    trace: traceExport,
    tenantScope: normalizedRequest.tenantScope,
    sink: normalizedRequest.sink,
    auditRecords: context.auditRecords,
    restrictions: context.restrictions
  };
}

function normalizeTraceEgressRequest(
  request: TraceEgressRequest | TraceEgressRequestInput
): NormalizedTraceEgressRequest | TraceEgressError {
  const sink = request.sink;

  if (!isTraceEgressSink(sink)) {
    return new TraceEgressError(
      "invalid_egress_request",
      "Trace egress sink must be report, trace-export, metrics, or mcp-resource"
    );
  }

  const tenantScope =
    typeof request.tenantScope === "string" ? request.tenantScope.trim() : "";

  if (tenantScope.length === 0) {
    return new TraceEgressError(
      "unscoped_egress",
      "Trace egress requires a non-empty tenantScope"
    );
  }

  return {
    tenantScope,
    sink,
    ...(stringValue(request.requester) === undefined
      ? {}
      : { requester: stringValue(request.requester) }),
    ...(stringValue(request.actor) === undefined
      ? {}
      : { actor: stringValue(request.actor) }),
    ...(request.requestedAt instanceof Date || typeof request.requestedAt === "string"
      ? { requestedAt: request.requestedAt }
      : {})
  };
}

function traceRejection(
  trace: TraceFile,
  request: TraceEgressRequestInput,
  code: TraceEgressErrorCode,
  message: string
) {
  const auditRecords = [
    auditRecord({
      action: "reject",
      code,
      message,
      request,
      trace,
      path: [],
      value: trace
    })
  ];

  return new TraceEgressError(code, message, auditRecords);
}

function redactMetadata(
  metadata: Record<string, unknown>,
  context: RedactionContext
): TraceSpanMetadata {
  const redacted = redactValue(metadata, {
    ...context,
    ancestors: [metadata, ...context.ancestors]
  });

  return isRecord(redacted) ? redacted : {};
}

function redactValue(value: unknown, context: RedactionContext): unknown {
  const classification = classifyPath(value, context);
  const redactionControlled =
    classification !== undefined || isRedactionControlledField(value, context.path);

  if (classification !== undefined && redactionClassAtLeast(classification, "restricted")) {
    return redactedHashReference(value, classification, "hash_and_structure", context);
  }

  if (classification === undefined && redactionControlled) {
    const redacted = redactedHashReference(
      value,
      "restricted",
      "restrict",
      context,
      "unlabeled_restricted_field"
    );
    const restriction = {
      path: pathLabel(context.path),
      reasonCode: "unlabeled_restricted_field" as const,
      hash: redacted.hash,
      shape: redacted.shape,
      redactionClass: redacted.redactionClass
    };

    context.restrictions.push(restriction);
    context.auditRecords.push(
      auditRecord({
        action: "restrict",
        code: restriction.reasonCode,
        message: `Restricted unlabeled trace metadata field ${restriction.path}`,
        request: context.request,
        trace: context.trace,
        path: context.path,
        value,
        hash: redacted.hash
      })
    );

    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(item, {
        ...context,
        path: [...context.path, String(index)]
      })
    );
  }

  if (!isRecord(value)) {
    return cloneJsonValue(value);
  }

  const next: Record<string, unknown> = {};
  const childContext = {
    ...context,
    ancestors: [value, ...context.ancestors]
  };

  for (const key of Object.keys(value).sort()) {
    next[key] = redactValue(value[key], {
      ...childContext,
      path: [...context.path, key]
    });
  }

  return next;
}

function classifyPath(
  value: unknown,
  context: RedactionContext
): RedactionClass | undefined {
  const key = context.path.at(-1);
  const profileClass = classFromProfile(context.profile, context.path);

  if (profileClass !== undefined) {
    return profileClass;
  }

  if (
    key !== undefined &&
    isSecretBearingKey(key) &&
    value !== undefined &&
    value !== null
  ) {
    return context.profile.defaultClass;
  }

  return undefined;
}

function classFromProfile(
  profile: NormalizedRedactionProfile,
  path: readonly string[]
) {
  for (const candidate of pathCandidates(path)) {
    const classified = profile.fieldClasses[candidate];

    if (classified !== undefined) {
      return classified;
    }
  }

  return undefined;
}

function normalizeRedactionProfile(
  profile: RedactionProfile
): NormalizedRedactionProfile {
  const fieldClasses: Record<string, RedactionClass> = {};

  for (const key of Object.keys(profile.fieldClasses).sort()) {
    const value = profile.fieldClasses[key];

    if (value === undefined) {
      continue;
    }

    fieldClasses[key] = RedactionClassSchema.parse(value);
  }

  return {
    fieldClasses,
    ...(profile.defaultClass === undefined
      ? {}
      : { defaultClass: RedactionClassSchema.parse(profile.defaultClass) })
  };
}

function redactedHashReference(
  value: unknown,
  redactionClass: RedactionClass,
  decision: TraceRedactedValue["decision"],
  context: RedactionContext,
  reasonCode?: TraceEgressErrorCode | undefined
): TraceRedactedValue {
  const hash = resolveHashReference(context) ?? deterministicContentHash(value);

  return {
    redacted: true,
    redactionClass,
    decision,
    hash,
    contentHash: hash,
    shape: redactedShape(value),
    ...(reasonCode === undefined ? {} : { reasonCode })
  };
}

function resolveHashReference(context: RedactionContext) {
  const key = context.path.at(-1);
  const hashKeys =
    key === "args"
      ? ["argsHash"]
      : key === "output" || key === "result"
        ? ["resultHash", "contentHash"]
        : ["contentHash"];

  for (const ancestor of context.ancestors) {
    for (const hashKey of hashKeys) {
      const direct = stringFromRecord(ancestor, hashKey);

      if (direct !== undefined) {
        return direct;
      }
    }
  }

  return undefined;
}

function auditRecord(input: {
  action: "reject" | "restrict";
  code: TraceEgressErrorCode;
  message: string;
  request: TraceEgressRequestInput;
  trace: TraceFile;
  path: readonly string[];
  value: unknown;
  hash?: string | undefined;
}): TraceEgressAuditRecord {
  const tenantScope = stringValue(input.request.tenantScope);
  const requester = stringValue(input.request.requester);
  const actor = stringValue(input.request.actor);

  return {
    recordKind: "egress_audit",
    action: input.action,
    reasonCode: input.code,
    ...(tenantScope === undefined ? {} : { tenantScope }),
    ...(tenantScope === undefined ? {} : { requestedTenantScope: tenantScope }),
    sink: stringValue(input.request.sink) ?? "unknown",
    ...(requester === undefined ? {} : { requester }),
    ...(actor === undefined ? {} : { actor }),
    runId: input.trace.runId,
    traceId: input.trace.traceId,
    subjectRefs: [input.path.length === 0 ? "trace" : `path:${pathLabel(input.path)}`],
    subjectHashes: [input.hash ?? deterministicContentHash(input.value)],
    timestamp: normalizeTimestamp(input.request.requestedAt),
    message: input.message
  };
}

function collectTenantScopes(value: unknown): string[] {
  const tenants = new Set<string>();
  collectTenantScopesInto(value, tenants);

  return [...tenants].sort();
}

function collectTenantScopesInto(value: unknown, tenants: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTenantScopesInto(item, tenants);
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of Object.keys(value).sort()) {
    const child = value[key];

    if ((key === "tenantId" || key === "tenantScope") && typeof child === "string" && child.length > 0) {
      tenants.add(child);
    }

    collectTenantScopesInto(child, tenants);
  }
}

function isTraceEgressSink(value: unknown): value is TraceEgressSink {
  return typeof value === "string" && TRACE_EGRESS_SINKS.includes(value as TraceEgressSink);
}

function isRedactionControlledField(value: unknown, path: readonly string[]) {
  const key = path.at(-1);

  if (
    key === undefined ||
    value === undefined ||
    value === null ||
    /^\d+$/.test(key)
  ) {
    return false;
  }

  return isSecretBearingKey(key) || !KNOWN_TRACE_EGRESS_FIELD_NAMES.has(key);
}

function isSecretBearingKey(key: string) {
  return SECRET_BEARING_FIELD_NAMES.has(key) || /secret/i.test(key);
}

function pathCandidates(path: readonly string[]) {
  const normalized = path.map((segment) =>
    /^\d+$/.test(segment) ? "*" : segment
  );
  const candidates: string[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    candidates.push(normalized.slice(index).join("."));
  }

  return candidates;
}

function deterministicContentHash(value: unknown) {
  const digest = createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");

  return `sha256:${digest}`;
}

function redactedShape(value: unknown): TraceRedactedShape {
  if (value === null) {
    return { type: "null" };
  }

  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }

  switch (typeof value) {
    case "boolean":
      return { type: "boolean" };
    case "number":
      return { type: "number" };
    case "object":
      return { type: "object", fields: Object.keys(value).sort() };
    case "string":
      return { type: "string", length: value.length };
    default:
      return { type: "unknown" };
  }
}

function canonicalJsonStringify(value: unknown) {
  return JSON.stringify(sortJsonValue(normalizeJsonValue(value)));
}

function normalizeJsonValue(value: unknown) {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    return null;
  }

  return JSON.parse(serialized) as unknown;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }

  return value;
}

function cloneJsonValue(value: unknown) {
  return normalizeJsonValue(value);
}

function normalizeTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return new Date().toISOString();
}

function stringFromRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pathLabel(path: readonly string[]) {
  return path.length === 0 ? "<root>" : path.join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
