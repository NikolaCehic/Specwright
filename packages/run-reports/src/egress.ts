import { createHash } from "node:crypto";
import {
  DEFAULT_REDACTION_PROFILE,
  type RedactionEgressMode,
  type RedactionGrant,
  type RedactionProfile
} from "@specwright/run-store";
import {
  RedactionClassSchema,
  redactionClassAtLeast,
  type RedactionClass
} from "@specwright/schemas";

export const EGRESS_SINKS = [
  "report",
  "trace-export",
  "metrics",
  "mcp-resource"
] as const;

export type EgressSink = (typeof EGRESS_SINKS)[number];

export type EgressErrorCode =
  | "unscoped_egress"
  | "cross_tenant_egress"
  | "unlabeled_restricted_field"
  | "invalid_egress_request";

export type RedactionDecisionAction =
  | "expose"
  | "hash_and_structure"
  | "restrict";

export type EgressRequest = {
  tenantScope: string;
  sink: EgressSink;
  requester?: string | undefined;
  actor?: string | undefined;
  requestedAt?: Date | string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  subjectRefs?: string[] | undefined;
};

export type RedactedShape =
  | { type: "array"; length: number }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "number" }
  | { type: "object"; fields: string[] }
  | { type: "string"; length: number }
  | { type: "unknown" };

export type RedactedEgressValue = {
  redacted: true;
  redactionClass: RedactionClass;
  decision: Exclude<RedactionDecisionAction, "expose">;
  hash: string;
  contentHash: string;
  shape: RedactedShape;
  reasonCode?: EgressErrorCode | undefined;
};

export type RedactionDecision = {
  action: RedactionDecisionAction;
  redactionClass?: RedactionClass | undefined;
  reasonCode?: EgressErrorCode | undefined;
};

export type EgressAuditRecord = {
  recordKind: "egress_audit";
  action: "reject" | "restrict";
  reasonCode: EgressErrorCode;
  tenantScope?: string | undefined;
  requestedTenantScope?: string | undefined;
  sink: EgressSink | string;
  requester?: string | undefined;
  actor?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  subjectRefs: string[];
  subjectHashes: string[];
  timestamp: string;
  message: string;
};

export type EgressRestrictionRecord = {
  path: string;
  reasonCode: EgressErrorCode;
  hash: string;
  shape: RedactedShape;
  redactionClass: RedactionClass;
};

export type EgressSuccess<TValue> = {
  ok: true;
  value: TValue;
  tenantScope: string;
  sink: EgressSink;
  auditRecords: EgressAuditRecord[];
  restrictions: EgressRestrictionRecord[];
};

export type EgressFailure = {
  ok: false;
  error: EgressError;
  tenantScope?: string | undefined;
  sink?: EgressSink | undefined;
  auditRecords: EgressAuditRecord[];
  restrictions: EgressRestrictionRecord[];
};

export type EgressResult<TValue> = EgressSuccess<TValue> | EgressFailure;

export type EnforceEgressOptions = {
  profile?: RedactionProfile | undefined;
  grant?: RedactionGrant | undefined;
  mode?: RedactionEgressMode | undefined;
};

export class EgressError extends Error {
  readonly code: EgressErrorCode;
  readonly auditRecords: EgressAuditRecord[];

  constructor(
    code: EgressErrorCode,
    message: string,
    auditRecords: EgressAuditRecord[] = []
  ) {
    super(message);
    this.name = "EgressError";
    this.code = code;
    this.auditRecords = auditRecords;
  }
}

type EgressRequestInput = {
  tenantScope?: unknown;
  sink?: unknown;
  requester?: unknown;
  actor?: unknown;
  requestedAt?: unknown;
  runId?: unknown;
  traceId?: unknown;
  subjectRefs?: unknown;
};

type NormalizedEgressRequest = {
  tenantScope: string;
  sink: EgressSink;
  requester?: string | undefined;
  actor?: string | undefined;
  requestedAt?: Date | string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  subjectRefs: string[];
};

type NormalizedRedactionProfile = {
  id: string;
  fieldClasses: Record<string, RedactionClass>;
  defaultClass?: RedactionClass | undefined;
};

type RedactionWalkContext = {
  profile: NormalizedRedactionProfile;
  mode: RedactionEgressMode;
  rawGranted: boolean;
  request: NormalizedEgressRequest;
  path: readonly string[];
  ancestors: readonly Record<string, unknown>[];
  auditRecords: EgressAuditRecord[];
  restrictions: EgressRestrictionRecord[];
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

const SOURCE_REF_VALUE_KEYS = new Set([
  "content",
  "locator",
  "path",
  "text",
  "uri",
  "value"
]);

const KNOWN_EGRESS_FIELD_NAMES = new Set([
  "actionId",
  "adapterVersion",
  "algo",
  "args",
  "argsHash",
  "artifact",
  "artifactId",
  "artifacts",
  "artifactType",
  "authority",
  "budgets",
  "cacheStatus",
  "captureToolCallId",
  "causationId",
  "class",
  "confidence",
  "content",
  "contentHash",
  "contractId",
  "contractVersion",
  "correlationId",
  "createdBy",
  "decision",
  "decisionHash",
  "durationMs",
  "egress",
  "endedAt",
  "evalFileVerdicts",
  "evalId",
  "evaluatedAt",
  "evaluator",
  "evidence",
  "evidenceRefs",
  "eventIds",
  "events",
  "externalTrustPolicy",
  "fields",
  "fileRef",
  "findings",
  "from",
  "fromPhase",
  "gateId",
  "gates",
  "hash",
  "harness",
  "harnessId",
  "host",
  "id",
  "idempotencyKey",
  "initialPhase",
  "input",
  "instruction",
  "integrity",
  "kind",
  "length",
  "locator",
  "metadata",
  "name",
  "obligations",
  "output",
  "parentSpanId",
  "path",
  "payload",
  "phase",
  "phaseId",
  "phases",
  "policies",
  "policyStatus",
  "prevHash",
  "profile",
  "producedBy",
  "provenance",
  "prompts",
  "reason",
  "reasons",
  "redacted",
  "redactedAt",
  "redactionClass",
  "redactionPolicy",
  "ref",
  "request",
  "requestedBy",
  "result",
  "resultHash",
  "runId",
  "schemaHash",
  "sequence",
  "severity",
  "shape",
  "sink",
  "sourceRefs",
  "spanId",
  "spans",
  "specHash",
  "startedAt",
  "status",
  "task",
  "targetRef",
  "tenantId",
  "tenantScope",
  "timestamp",
  "toolCallId",
  "toolId",
  "toolStatus",
  "tools",
  "toolVersion",
  "to",
  "toPhase",
  "trace",
  "traceId",
  "type",
  "unknownReason",
  "uri",
  "verdict",
  "version"
]);

export function enforceEgress<TValue>(
  value: TValue,
  request: EgressRequest | EgressRequestInput,
  options: EnforceEgressOptions = {}
): EgressResult<TValue> {
  const normalizedRequest = normalizeEgressRequest(request);

  if (normalizedRequest instanceof EgressError) {
    return rejection(value, request, normalizedRequest.code, normalizedRequest.message);
  }

  const observedTenants = collectTenantScopes(value);
  const mismatchedTenants = observedTenants.filter(
    (tenant) => tenant !== normalizedRequest.tenantScope
  );

  if (mismatchedTenants.length > 0) {
    return rejection(
      value,
      normalizedRequest,
      "cross_tenant_egress",
      `Egress tenant scope ${normalizedRequest.tenantScope} does not match observed tenant scope ${mismatchedTenants[0]}`
    );
  }

  const context: RedactionWalkContext = {
    profile: normalizeRedactionProfile(
      options.profile ?? DEFAULT_REDACTION_PROFILE
    ),
    mode: options.mode ?? "redacted",
    rawGranted: hasAuditRawGrant(options.grant),
    request: normalizedRequest,
    path: [],
    ancestors: [],
    auditRecords: [],
    restrictions: []
  };
  const redacted = redactValue(value, context) as TValue;

  return {
    ok: true,
    value: redacted,
    tenantScope: normalizedRequest.tenantScope,
    sink: normalizedRequest.sink,
    auditRecords: context.auditRecords,
    restrictions: context.restrictions
  };
}

export function assertEgressAllowed<TValue>(
  result: EgressResult<TValue>
): EgressSuccess<TValue> {
  if (!result.ok) {
    throw result.error;
  }

  return result;
}

export function decideRedaction(input: {
  value: unknown;
  sink: EgressSink | string;
  fieldPath?: string | undefined;
  redactionClass?: unknown;
  sensitive?: boolean | undefined;
}): RedactionDecision {
  if (!isEgressSink(input.sink)) {
    return {
      action: "restrict",
      redactionClass: "restricted",
      reasonCode: "invalid_egress_request"
    };
  }

  if (input.redactionClass === undefined) {
    return {
      action: "restrict",
      redactionClass: "restricted",
      reasonCode: "unlabeled_restricted_field"
    };
  }

  const parsed = RedactionClassSchema.safeParse(input.redactionClass);

  if (!parsed.success) {
    return {
      action: "restrict",
      redactionClass: "restricted",
      reasonCode: "unlabeled_restricted_field"
    };
  }

  if (redactionClassAtLeast(parsed.data, "restricted")) {
    return {
      action: "hash_and_structure",
      redactionClass: parsed.data
    };
  }

  return {
    action: "expose",
    redactionClass: parsed.data
  };
}

export function stableEgressJson(value: unknown) {
  return canonicalJsonStringify(value);
}

export function deterministicContentHash(value: unknown) {
  const digest = createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");

  return `sha256:${digest}`;
}

export function redactedShape(value: unknown): RedactedShape {
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

export function collectTenantScopes(value: unknown): string[] {
  const tenants = new Set<string>();
  collectTenantScopesInto(value, tenants);

  return [...tenants].sort();
}

function rejection<TValue>(
  value: TValue,
  request: EgressRequestInput,
  code: EgressErrorCode,
  message: string
): EgressFailure {
  const auditRecords = [
    auditRecord({
      action: "reject",
      code,
      message,
      request,
      value,
      path: []
    })
  ];
  const error = new EgressError(code, message, auditRecords);

  return {
    ok: false,
    error,
    auditRecords,
    restrictions: []
  };
}

function normalizeEgressRequest(
  request: EgressRequest | EgressRequestInput
): NormalizedEgressRequest | EgressError {
  const sink = request.sink;

  if (!isEgressSink(sink)) {
    return new EgressError(
      "invalid_egress_request",
      "Egress sink must be report, trace-export, metrics, or mcp-resource"
    );
  }

  const tenantScope =
    typeof request.tenantScope === "string" ? request.tenantScope.trim() : "";

  if (tenantScope.length === 0) {
    return new EgressError(
      "unscoped_egress",
      "Egress request requires a non-empty tenantScope"
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
      : {}),
    ...(stringValue(request.runId) === undefined
      ? {}
      : { runId: stringValue(request.runId) }),
    ...(stringValue(request.traceId) === undefined
      ? {}
      : { traceId: stringValue(request.traceId) }),
    subjectRefs: Array.isArray(request.subjectRefs)
      ? request.subjectRefs.filter(
          (subject): subject is string =>
            typeof subject === "string" && subject.length > 0
        )
      : []
  };
}

function isEgressSink(value: unknown): value is EgressSink {
  return typeof value === "string" && EGRESS_SINKS.includes(value as EgressSink);
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
    id: profile.id,
    fieldClasses,
    ...(profile.defaultClass === undefined
      ? {}
      : { defaultClass: RedactionClassSchema.parse(profile.defaultClass) })
  };
}

function hasAuditRawGrant(grant: RedactionGrant | undefined) {
  return grant === "audit_raw" || grant?.class === "audit_raw";
}

function redactValue(value: unknown, context: RedactionWalkContext): unknown {
  const classification = classifyPath(value, context);
  const redactionControlled =
    classification !== undefined || isRedactionControlledField(value, context.path);

  if (!redactionControlled) {
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

  const decision = decideRedaction({
    value,
    sink: context.request.sink,
    fieldPath: pathLabel(context.path),
    redactionClass: classification
  });

  if (decision.action !== "expose") {
    if (decision.action === "hash_and_structure" && context.mode === "raw" && context.rawGranted) {
      return cloneJsonValue(value);
    }

    const redacted = redactedHashReference(
      value,
      decision.redactionClass ?? "restricted",
      decision.action,
      context,
      decision.reasonCode
    );

    if (decision.action === "restrict") {
      const restriction: EgressRestrictionRecord = {
        path: pathLabel(context.path),
        reasonCode: decision.reasonCode ?? "unlabeled_restricted_field",
        hash: redacted.hash,
        shape: redacted.shape,
        redactionClass: redacted.redactionClass
      };

      context.restrictions.push(restriction);
      context.auditRecords.push(
        auditRecord({
          action: "restrict",
          code: restriction.reasonCode,
          message: `Restricted unlabeled or indeterminate egress field ${restriction.path}`,
          request: context.request,
          value,
          path: context.path,
          hash: redacted.hash
        })
      );
    }

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
  context: RedactionWalkContext
): RedactionClass | undefined {
  const key = context.path.at(-1);
  const profileClass = classFromProfile(context.profile, context.path);

  if (profileClass !== undefined) {
    return profileClass;
  }

  const policyClass = classFromNearestPolicy(context);

  if (policyClass !== undefined) {
    return policyClass;
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

function classFromNearestPolicy(
  context: RedactionWalkContext
): RedactionClass | undefined {
  const key = context.path.at(-1);

  if (key === undefined) {
    return undefined;
  }

  for (const ancestor of context.ancestors) {
    const sourceRefClass = RedactionClassSchema.safeParse(
      ancestor.redactionClass
    );

    if (sourceRefClass.success && SOURCE_REF_VALUE_KEYS.has(key)) {
      return sourceRefClass.data;
    }

    const policy = parseRedactionPolicy(ancestor.redactionPolicy);

    if (policy === undefined) {
      continue;
    }

    if (typeof policy === "string") {
      return shouldPolicyApplyToKey(key) ? policy : undefined;
    }

    const direct = policy[key];

    if (direct !== undefined) {
      return direct;
    }
  }

  return undefined;
}

function parseRedactionPolicy(value: unknown): RedactionClass | Record<string, RedactionClass> | undefined {
  const classValue = RedactionClassSchema.safeParse(value);

  if (classValue.success) {
    return classValue.data;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const parsed: Record<string, RedactionClass> = {};

  for (const key of Object.keys(value).sort()) {
    const classForKey = RedactionClassSchema.safeParse(value[key]);

    if (!classForKey.success) {
      return undefined;
    }

    parsed[key] = classForKey.data;
  }

  return parsed;
}

function isRedactionControlledField(value: unknown, path: readonly string[]) {
  const key = path.at(-1);
  const parentKey = path.at(-2);

  if (parentKey === "sourceRefs" && typeof value === "string") {
    return true;
  }

  if (
    key === undefined ||
    value === undefined ||
    value === null ||
    /^\d+$/.test(key)
  ) {
    return false;
  }

  return isSecretBearingKey(key) || !KNOWN_EGRESS_FIELD_NAMES.has(key);
}

function shouldPolicyApplyToKey(key: string) {
  return SECRET_BEARING_FIELD_NAMES.has(key);
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

function redactedHashReference(
  value: unknown,
  redactionClass: RedactionClass,
  decision: Exclude<RedactionDecisionAction, "expose">,
  context: RedactionWalkContext,
  reasonCode: EgressErrorCode | undefined
): RedactedEgressValue {
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

function resolveHashReference(context: RedactionWalkContext) {
  const hashKeys = hashKeysForPath(context.path);

  for (const ancestor of context.ancestors) {
    for (const hashKey of hashKeys) {
      const direct = stringFromRecord(ancestor, hashKey);

      if (direct !== undefined) {
        return direct;
      }

      const provenance = recordValue(ancestor.provenance);
      const provenanceHash = stringFromRecord(provenance, hashKey);

      if (provenanceHash !== undefined) {
        return provenanceHash;
      }

      const fileRef = recordValue(ancestor.fileRef);
      const fileRefHash = stringFromRecord(fileRef, hashKey);

      if (fileRefHash !== undefined) {
        return fileRefHash;
      }
    }

    const deepHash = findHashReference(ancestor, hashKeys);

    if (deepHash !== undefined) {
      return deepHash;
    }
  }

  return undefined;
}

function hashKeysForPath(path: readonly string[]) {
  const key = path.at(-1);

  if (key === "args") {
    return ["argsHash"];
  }

  if (key === "output" || key === "result") {
    return ["resultHash", "contentHash"];
  }

  return ["contentHash"];
}

function findHashReference(
  value: unknown,
  hashKeys: readonly string[]
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found: string | undefined = findHashReference(item, hashKeys);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const hashKey of hashKeys) {
    const direct = stringFromRecord(value, hashKey);

    if (direct !== undefined) {
      return direct;
    }
  }

  for (const key of Object.keys(value).sort()) {
    const found: string | undefined = findHashReference(value[key], hashKeys);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function auditRecord(input: {
  action: "reject" | "restrict";
  code: EgressErrorCode;
  message: string;
  request: EgressRequestInput;
  value: unknown;
  path: readonly string[];
  hash?: string | undefined;
}): EgressAuditRecord {
  const subjectHash = input.hash ?? deterministicContentHash(input.value);
  const tenantScope = stringValue(input.request.tenantScope);
  const requester = stringValue(input.request.requester);
  const actor = stringValue(input.request.actor);
  const runId = stringValue(input.request.runId) ?? runIdFromValue(input.value);
  const traceId =
    stringValue(input.request.traceId) ?? traceIdFromValue(input.value);

  return {
    recordKind: "egress_audit",
    action: input.action,
    reasonCode: input.code,
    ...(tenantScope === undefined ? {} : { tenantScope }),
    ...(tenantScope === undefined ? {} : { requestedTenantScope: tenantScope }),
    sink: stringValue(input.request.sink) ?? "unknown",
    ...(requester === undefined ? {} : { requester }),
    ...(actor === undefined ? {} : { actor }),
    ...(runId === undefined ? {} : { runId }),
    ...(traceId === undefined ? {} : { traceId }),
    subjectRefs: uniqueStrings([
      ...subjectRefsFromRequest(input.request),
      input.path.length === 0 ? "projection" : `path:${pathLabel(input.path)}`
    ]),
    subjectHashes: [subjectHash],
    timestamp: normalizeTimestamp(input.request.requestedAt),
    message: input.message
  };
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

function subjectRefsFromRequest(request: EgressRequestInput) {
  if (!Array.isArray(request.subjectRefs)) {
    return [];
  }

  return request.subjectRefs.filter(
    (subject): subject is string => typeof subject === "string" && subject.length > 0
  );
}

function runIdFromValue(value: unknown): string | undefined {
  if (isRecord(value)) {
    return stringValue(value.runId);
  }

  return undefined;
}

function traceIdFromValue(value: unknown): string | undefined {
  if (isRecord(value)) {
    return stringValue(value.traceId);
  }

  return undefined;
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

function recordValue(value: unknown) {
  return isRecord(value) ? value : {};
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

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
