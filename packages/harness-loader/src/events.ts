import { randomUUID } from "node:crypto";
import {
  CacheStatusSchema,
  runtimeEventSchema,
  type CacheStatus,
  type RuntimeEvent
} from "@specwright/schemas";
import { z } from "zod";
import type { HarnessLoaderErrorCode } from "./errors";

const nonEmptyString = z.string().min(1);
const isoDateTimeString = z.string().datetime({ offset: true });
const sha256String = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected sha256:<64 lowercase hex chars>");
const metadataSchema = z.record(z.string(), z.unknown());

export const HARNESS_LOADER_EVENT_TYPES = [
  "harness.load.requested",
  "harness.trust.verified",
  "harness.trust.rejected",
  "harness.validated",
  "harness.validation.failed",
  "harness.dependencies.pinned",
  "harness.compatibility.decided",
  "harness.grant.evaluated",
  "harness.snapshot.frozen",
  "harness.security.failed",
  "harness.load.denied",
  "harness.redaction.applied"
] as const;

export type HarnessLoaderEventType = (typeof HARNESS_LOADER_EVENT_TYPES)[number];

const HarnessLoaderErrorCodeSchema = z.enum([
  "cache_poisoned",
  "compatibility_denied",
  "dependency_unresolved",
  "duplicate_id",
  "grant_denied",
  "invalid_artifact_schema",
  "invalid_definition",
  "invalid_graph",
  "invalid_lifecycle_transition",
  "invalid_loaded_at",
  "invalid_manifest",
  "invalid_prompt",
  "missing_harness_manifest",
  "missing_reference",
  "parse_error",
  "promotion_unapproved",
  "resource_limit_exceeded",
  "trust_rejected",
  "unsupported_schema_version",
  "version_immutable",
  "version_not_resolvable"
] satisfies [HarnessLoaderErrorCode, ...HarnessLoaderErrorCode[]]);

const retryabilitySchema = z.enum(["retryable", "not_retryable", "operator_action"]);

const definitionCountsSchema = z
  .object({
    phases: z.number().int().nonnegative(),
    gates: z.number().int().nonnegative(),
    policies: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    evals: z.number().int().nonnegative(),
    roles: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative()
  })
  .strict();

const capabilitySurfaceSchema = z
  .object({
    tools: z.array(nonEmptyString),
    requireApproval: z.array(nonEmptyString),
    toolDefinitions: z.array(nonEmptyString),
    policyEffects: z.array(nonEmptyString),
    policyLayers: z.array(nonEmptyString),
    runtimeInvariantToolIds: z.array(nonEmptyString)
  })
  .strict();

const grantSummarySchema = z
  .object({
    grantId: nonEmptyString,
    packageId: nonEmptyString,
    versionRange: nonEmptyString.optional(),
    versionPins: z.array(nonEmptyString).optional(),
    issuer: z
      .object({
        registryId: nonEmptyString,
        authorityId: nonEmptyString
      })
      .strict()
  })
  .strict();

const resolvedDependencySchema = z
  .object({
    name: nonEmptyString,
    version: nonEmptyString,
    contentHash: sha256String,
    trustTier: nonEmptyString.optional()
  })
  .strict();

const redactionHashReferenceSchema = z
  .object({
    fieldPath: nonEmptyString,
    hashReference: sha256String,
    originalClass: nonEmptyString.optional()
  })
  .strict();

const requestedPayloadSchema = z
  .object({
    packageDir: nonEmptyString,
    packageId: nonEmptyString.optional(),
    requestedVersion: nonEmptyString.optional(),
    requestedBy: nonEmptyString.optional(),
    runId: nonEmptyString.optional(),
    traceId: nonEmptyString
  })
  .strict();

const trustVerifiedPayloadSchema = z
  .object({
    packageId: nonEmptyString.optional(),
    version: nonEmptyString.optional(),
    publisherId: nonEmptyString,
    signingKeyId: nonEmptyString,
    algorithm: nonEmptyString,
    signatureRef: nonEmptyString,
    trustStoreVersion: nonEmptyString,
    specHash: sha256String,
    verdict: z.literal("verified")
  })
  .strict();

const trustRejectedPayloadSchema = z
  .object({
    packageId: nonEmptyString.optional(),
    version: nonEmptyString.optional(),
    publisherId: nonEmptyString.optional(),
    signingKeyId: nonEmptyString.optional(),
    reasonCode: nonEmptyString,
    trustStoreVersion: nonEmptyString.optional(),
    failClosed: z.literal(true),
    retryability: retryabilitySchema,
    details: metadataSchema.optional()
  })
  .strict();

const validatedPayloadSchema = z
  .object({
    packageId: nonEmptyString,
    version: nonEmptyString,
    schemaVersion: nonEmptyString,
    definitionCounts: definitionCountsSchema,
    validatorBuildId: nonEmptyString
  })
  .strict();

const validationFailedPayloadSchema = z
  .object({
    errorCode: HarnessLoaderErrorCodeSchema,
    targetFile: nonEmptyString.optional(),
    targetId: nonEmptyString.optional(),
    message: nonEmptyString,
    retryability: retryabilitySchema,
    severity: z.enum(["error", "critical"]),
    details: metadataSchema.optional()
  })
  .strict();

const dependenciesPinnedPayloadSchema = z
  .object({
    packageId: nonEmptyString,
    version: nonEmptyString,
    specHash: sha256String,
    dependencies: z.array(resolvedDependencySchema)
  })
  .strict();

const compatibilityDecidedPayloadSchema = z
  .object({
    packageId: nonEmptyString,
    version: nonEmptyString,
    matrixId: nonEmptyString,
    matrixRowId: nonEmptyString,
    runtimeVersion: nonEmptyString,
    declaredSchemaVersion: nonEmptyString,
    targetSchemaVersion: nonEmptyString,
    compatibilityClass: nonEmptyString,
    decision: z.enum(["load", "migrate", "denied"]),
    approvalRef: nonEmptyString.optional(),
    migration: metadataSchema.optional()
  })
  .strict();

const grantEvaluatedPayloadSchema = z
  .object({
    packageId: nonEmptyString,
    version: nonEmptyString,
    verdict: z.enum(["allowed", "denied"]),
    requested: capabilitySurfaceSchema,
    granted: capabilitySurfaceSchema,
    overGrant: capabilitySurfaceSchema,
    grant: grantSummarySchema.optional(),
    deniedCapabilities: z.array(nonEmptyString),
    denialReason: nonEmptyString.optional(),
    failClosed: z.literal(true).optional()
  })
  .strict();

const snapshotFrozenPayloadSchema = z
  .object({
    packageId: nonEmptyString,
    version: nonEmptyString,
    schemaVersion: nonEmptyString,
    specHash: sha256String,
    loadedAt: isoDateTimeString,
    cacheStatus: CacheStatusSchema,
    attestationId: nonEmptyString,
    provenanceSummary: z
      .object({
        provenanceHash: sha256String,
        registryRef: nonEmptyString,
        validatorBuildId: nonEmptyString,
        resolvedDependencyCount: z.number().int().nonnegative(),
        redactionCount: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

const securityFailedPayloadSchema = z
  .object({
    errorCode: HarnessLoaderErrorCodeSchema,
    stage: nonEmptyString,
    message: nonEmptyString,
    reason: nonEmptyString,
    failClosed: z.literal(true),
    retryability: retryabilitySchema,
    severity: z.enum(["high", "critical"]),
    details: metadataSchema.optional()
  })
  .strict();

const loadDeniedPayloadSchema = z
  .object({
    errorCode: HarnessLoaderErrorCodeSchema,
    stage: nonEmptyString,
    message: nonEmptyString,
    reason: nonEmptyString.optional(),
    failClosed: z.literal(true),
    retryability: retryabilitySchema,
    details: metadataSchema.optional()
  })
  .strict();

const redactionAppliedPayloadSchema = z
  .object({
    packageId: nonEmptyString,
    version: nonEmptyString,
    specHash: sha256String,
    redactedFieldPaths: z.array(nonEmptyString),
    redactionProfile: nonEmptyString,
    hashReferences: z.array(redactionHashReferenceSchema)
  })
  .strict()
  .refine(
    (payload) => payload.redactedFieldPaths.length === payload.hashReferences.length,
    "Each redacted field path must have one hash reference"
  );

export const HarnessLoadRequestedEventSchema = envelopeSchema(
  "harness.load.requested",
  requestedPayloadSchema
);
export const HarnessTrustVerifiedAuditEventSchema = envelopeSchema(
  "harness.trust.verified",
  trustVerifiedPayloadSchema
);
export const HarnessTrustRejectedAuditEventSchema = envelopeSchema(
  "harness.trust.rejected",
  trustRejectedPayloadSchema
);
export const HarnessValidatedEventSchema = envelopeSchema(
  "harness.validated",
  validatedPayloadSchema
);
export const HarnessValidationFailedEventSchema = envelopeSchema(
  "harness.validation.failed",
  validationFailedPayloadSchema
);
export const HarnessDependenciesPinnedAuditEventSchema = envelopeSchema(
  "harness.dependencies.pinned",
  dependenciesPinnedPayloadSchema
);
export const HarnessCompatibilityDecidedEventSchema = envelopeSchema(
  "harness.compatibility.decided",
  compatibilityDecidedPayloadSchema
);
export const HarnessGrantEvaluatedAuditEventSchema = envelopeSchema(
  "harness.grant.evaluated",
  grantEvaluatedPayloadSchema
);
export const HarnessSnapshotFrozenEventSchema = envelopeSchema(
  "harness.snapshot.frozen",
  snapshotFrozenPayloadSchema
);
export const HarnessSecurityFailedAuditEventSchema = envelopeSchema(
  "harness.security.failed",
  securityFailedPayloadSchema
);
export const HarnessLoadDeniedEventSchema = envelopeSchema(
  "harness.load.denied",
  loadDeniedPayloadSchema
);
export const HarnessRedactionAppliedEventSchema = envelopeSchema(
  "harness.redaction.applied",
  redactionAppliedPayloadSchema
);

export const HarnessLoaderAuditEventSchema = z.discriminatedUnion("type", [
  HarnessLoadRequestedEventSchema,
  HarnessTrustVerifiedAuditEventSchema,
  HarnessTrustRejectedAuditEventSchema,
  HarnessValidatedEventSchema,
  HarnessValidationFailedEventSchema,
  HarnessDependenciesPinnedAuditEventSchema,
  HarnessCompatibilityDecidedEventSchema,
  HarnessGrantEvaluatedAuditEventSchema,
  HarnessSnapshotFrozenEventSchema,
  HarnessSecurityFailedAuditEventSchema,
  HarnessLoadDeniedEventSchema,
  HarnessRedactionAppliedEventSchema
]);

export type HarnessLoaderAuditEvent = z.infer<
  typeof HarnessLoaderAuditEventSchema
>;
export type HarnessLoaderAuditEventPayload = HarnessLoaderAuditEvent["payload"];
export type HarnessDefinitionCounts = z.infer<typeof definitionCountsSchema>;
export type HarnessRedactionHashReference = z.infer<
  typeof redactionHashReferenceSchema
>;

export type BuildHarnessLoaderAuditEventInput<TPayload> = {
  type: HarnessLoaderEventType;
  payload: TPayload;
  runId: string;
  traceId: string;
  sequence: number;
  id?: string;
  timestamp?: Date | string;
  causationId?: string;
  correlationId?: string;
};

export function buildHarnessLoaderAuditEvent<TPayload>(
  input: BuildHarnessLoaderAuditEventInput<TPayload>
): HarnessLoaderAuditEvent {
  return HarnessLoaderAuditEventSchema.parse({
    id: input.id ?? randomUUID(),
    runId: input.runId,
    type: input.type,
    timestamp: normalizeTimestamp(input.timestamp),
    sequence: input.sequence,
    traceId: input.traceId,
    ...(input.causationId === undefined
      ? {}
      : { causationId: input.causationId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    payload: input.payload
  });
}

export function assertHarnessLoaderAuditEvent(
  event: unknown
): HarnessLoaderAuditEvent {
  return HarnessLoaderAuditEventSchema.parse(event);
}

export function cacheStatusOrDefault(value: CacheStatus | undefined): CacheStatus {
  return value ?? "bypass";
}

function envelopeSchema<TPayloadSchema extends z.ZodTypeAny>(
  type: HarnessLoaderEventType,
  payloadSchema: TPayloadSchema
) {
  return runtimeEventSchema(payloadSchema)
    .extend({
      type: z.literal(type)
    })
    .strict();
}

function normalizeTimestamp(timestamp: Date | string | undefined) {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}
