import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  CacheStatusSchema,
  type CacheStatus,
  type HarnessSnapshot
} from "@specwright/schemas";
import { z } from "zod";
import type {
  CompatibilityAdmission,
  DependencyResolution,
  GrantEvaluation,
  ResolvedDependency,
  SourceFile,
  TrustVerdict
} from "./index";
import type {
  HarnessLoaderAuditEvent,
  HarnessRedactionHashReference
} from "./events";

const nonEmptyString = z.string().min(1);
const isoDateTimeString = z.string().datetime({ offset: true });
const sha256String = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected sha256:<64 lowercase hex chars>");
const metadataSchema = z.record(z.string(), z.unknown());

export const HARNESS_LOADER_VALIDATOR_BUILD_ID =
  "@specwright/harness-loader@0.0.0";

export const HarnessProvenanceDataClassSchema = z.enum([
  "authoritative",
  "derived_projection",
  "cached",
  "human_decision",
  "external_observation",
  "unknown"
]);
export type HarnessProvenanceDataClass = z.infer<
  typeof HarnessProvenanceDataClassSchema
>;

const UnknownProvenanceValueSchema = z
  .object({
    status: z.literal("unknown"),
    dataClass: z.literal("unknown"),
    reason: nonEmptyString
  })
  .strict();
export type UnknownProvenanceValue = z.infer<
  typeof UnknownProvenanceValueSchema
>;

const KnownStringProvenanceValueSchema = z
  .object({
    status: z.literal("known"),
    value: nonEmptyString,
    dataClass: HarnessProvenanceDataClassSchema
  })
  .strict();

const StringProvenanceValueSchema = z.union([
  KnownStringProvenanceValueSchema,
  UnknownProvenanceValueSchema
]);
export type StringProvenanceValue = z.infer<
  typeof StringProvenanceValueSchema
>;

const ResolvedDependencyProvenanceSchema = z
  .object({
    name: nonEmptyString,
    version: nonEmptyString,
    contentHash: sha256String,
    trustTier: nonEmptyString.optional(),
    dataClass: z.literal("authoritative")
  })
  .strict();

const TrustProvenanceSummarySchema = z
  .object({
    publisherId: StringProvenanceValueSchema,
    signingKeyId: StringProvenanceValueSchema,
    signatureRef: StringProvenanceValueSchema,
    trustStoreVersion: StringProvenanceValueSchema,
    dataClass: HarnessProvenanceDataClassSchema
  })
  .strict();

const CapabilityGrantProvenanceSchema = z
  .object({
    ref: StringProvenanceValueSchema,
    detail: metadataSchema.optional(),
    dataClass: HarnessProvenanceDataClassSchema
  })
  .strict();

const CompatibilityDecisionProvenanceSchema = z
  .object({
    ref: StringProvenanceValueSchema,
    detail: metadataSchema.optional(),
    dataClass: HarnessProvenanceDataClassSchema
  })
  .strict();

const RedactionProvenanceSchema = z
  .object({
    redactionProfile: StringProvenanceValueSchema,
    hashReferences: z.array(
      z
        .object({
          fieldPath: nonEmptyString,
          hashReference: sha256String,
          originalClass: nonEmptyString.optional()
        })
        .strict()
    ),
    dataClass: HarnessProvenanceDataClassSchema
  })
  .strict();

const ArtifactAssetHashSchema = z
  .object({
    id: nonEmptyString,
    version: nonEmptyString,
    path: nonEmptyString,
    contentHash: sha256String,
    dataClass: z.literal("derived_projection")
  })
  .strict();

const PromptAssetHashSchema = z
  .object({
    id: nonEmptyString,
    path: nonEmptyString,
    contentHash: sha256String,
    dataClass: z.literal("authoritative")
  })
  .strict();

export const HarnessLoadProvenanceSchema = z
  .object({
    harnessId: nonEmptyString,
    version: nonEmptyString,
    schemaVersion: nonEmptyString,
    specHash: sha256String,
    registryRef: StringProvenanceValueSchema,
    trust: TrustProvenanceSummarySchema,
    resolvedDependencies: z.array(ResolvedDependencyProvenanceSchema),
    capabilityGrant: CapabilityGrantProvenanceSchema,
    compatibilityDecision: CompatibilityDecisionProvenanceSchema,
    validatorBuildId: nonEmptyString,
    loadedAt: isoDateTimeString,
    loadedBy: StringProvenanceValueSchema,
    cacheStatus: CacheStatusSchema,
    redaction: RedactionProvenanceSchema,
    assets: z
      .object({
        artifactSchemas: z.array(ArtifactAssetHashSchema),
        prompts: z.array(PromptAssetHashSchema)
      })
      .strict(),
    sourceFiles: z.array(
      z
        .object({
          path: nonEmptyString,
          byteCount: z.number().int().nonnegative(),
          contentHash: sha256String,
          dataClass: z.literal("external_observation")
        })
        .strict()
    ),
    dataClasses: z
      .object({
        specHash: z.literal("authoritative"),
        frozenSnapshot: z.literal("authoritative"),
        signedAttestation: HarnessProvenanceDataClassSchema,
        dependencyGraph: z.literal("derived_projection"),
        orderedDefinitions: z.literal("derived_projection"),
        cacheStatus: HarnessProvenanceDataClassSchema,
        compatibilityDecision: HarnessProvenanceDataClassSchema,
        capabilityGrant: HarnessProvenanceDataClassSchema,
        registryBytes: z.literal("external_observation")
      })
      .strict()
  })
  .strict();

export type HarnessLoadProvenance = z.infer<
  typeof HarnessLoadProvenanceSchema
>;

export type AssembleHarnessLoadProvenanceOptions = {
  snapshot: HarnessSnapshot;
  dependencies: DependencyResolution;
  grant: GrantEvaluation;
  compatibility: CompatibilityAdmission;
  sourceFiles: readonly SourceFile[];
  trust?: TrustVerdict | undefined;
  registryRef?: string | undefined;
  loadedBy?: string | undefined;
  cacheStatus?: CacheStatus | undefined;
  validatorBuildId?: string | undefined;
  redactionProfile?: string | undefined;
  redactionHashReferences?: readonly HarnessRedactionHashReference[] | undefined;
};

export function assembleHarnessLoadProvenance(
  options: AssembleHarnessLoadProvenanceOptions
): HarnessLoadProvenance {
  const provenance = HarnessLoadProvenanceSchema.parse({
    harnessId: options.snapshot.id,
    version: options.snapshot.version,
    schemaVersion: options.snapshot.schemaVersion,
    specHash: options.snapshot.specHash,
    registryRef: knownOrUnknown(
      options.registryRef,
      "external_observation",
      "registry ref was not supplied"
    ),
    trust: trustProvenance(options.trust),
    resolvedDependencies: options.dependencies.resolved.map((dependency) => ({
      ...dependency,
      dataClass: "authoritative"
    })),
    capabilityGrant: capabilityGrantProvenance(options.grant),
    compatibilityDecision: compatibilityDecisionProvenance(
      options.compatibility
    ),
    validatorBuildId:
      options.validatorBuildId ?? HARNESS_LOADER_VALIDATOR_BUILD_ID,
    loadedAt: options.snapshot.loadedAt,
    loadedBy: knownOrUnknown(
      options.loadedBy,
      "human_decision",
      "loadedBy was not supplied"
    ),
    cacheStatus: options.cacheStatus ?? "bypass",
    redaction: {
      redactionProfile: knownOrUnknown(
        options.redactionProfile,
        "derived_projection",
        "no redaction profile was applied"
      ),
      hashReferences: [...(options.redactionHashReferences ?? [])],
      dataClass:
        options.redactionHashReferences !== undefined &&
        options.redactionHashReferences.length > 0
          ? "derived_projection"
          : "unknown"
    },
    assets: {
      artifactSchemas: options.snapshot.artifacts.map((artifact) => ({
        id: artifact.id,
        version: artifact.version,
        path: artifact.path,
        contentHash: stableHash(artifact.schema),
        dataClass: "derived_projection"
      })),
      prompts: options.snapshot.prompts.map((prompt) => ({
        id: prompt.id,
        path: prompt.path,
        contentHash: prompt.contentHash,
        dataClass: "authoritative"
      }))
    },
    sourceFiles: options.sourceFiles.map((file) => ({
      path: file.relativePath,
      byteCount: Buffer.from(file.raw, "utf8").length,
      contentHash: hashString(file.raw),
      dataClass: "external_observation"
    })),
    dataClasses: {
      specHash: "authoritative",
      frozenSnapshot: "authoritative",
      signedAttestation:
        options.trust === undefined ? "unknown" : "authoritative",
      dependencyGraph: "derived_projection",
      orderedDefinitions: "derived_projection",
      cacheStatus: options.cacheStatus === "hit" ? "cached" : "derived_projection",
      compatibilityDecision:
        options.compatibility.loaderBehavior === "migrate"
          ? "human_decision"
          : "derived_projection",
      capabilityGrant:
        options.grant.grant === undefined ? "unknown" : "human_decision",
      registryBytes: "external_observation"
    }
  });

  return provenance;
}

export function hashHarnessLoadProvenance(
  provenance: HarnessLoadProvenance
) {
  return stableHash(HarnessLoadProvenanceSchema.parse(provenance));
}

export type RedactionCoverageInput = {
  hashReferences: readonly HarnessRedactionHashReference[];
  events: readonly HarnessLoaderAuditEvent[];
};

export function assertRedactionEventsCoverSubstitutions(
  input: RedactionCoverageInput
) {
  if (input.hashReferences.length === 0) {
    return;
  }

  const recorded = new Set<string>();

  for (const event of input.events) {
    if (event.type !== "harness.redaction.applied") {
      continue;
    }

    const payload = event.payload as {
      hashReferences: HarnessRedactionHashReference[];
    };

    for (const reference of payload.hashReferences) {
      recorded.add(redactionReferenceKey(reference));
    }
  }

  const missing = input.hashReferences.filter(
    (reference) => !recorded.has(redactionReferenceKey(reference))
  );

  if (missing.length > 0) {
    throw new HarnessLoadProvenanceError(
      "silent_redaction",
      "Redaction hash references were present without a matching harness.redaction.applied event",
      {
        missing
      }
    );
  }
}

export type HarnessRunAuditability =
  | {
      status: "auditable";
      anchorType: "harness.snapshot.frozen" | "harness.loaded";
      specHash: string;
    }
  | {
      status: "non_auditable";
      reason: "missing_harness_snapshot_anchor" | "spec_hash_mismatch";
      specHash: string;
    };

export function assessHarnessRunAuditability(input: {
  specHash: string;
  events: readonly { type: string; payload: unknown }[];
}): HarnessRunAuditability {
  for (const event of input.events) {
    if (
      event.type === "harness.snapshot.frozen" &&
      isRecord(event.payload) &&
      event.payload.specHash === input.specHash
    ) {
      return {
        status: "auditable",
        anchorType: "harness.snapshot.frozen",
        specHash: input.specHash
      };
    }

    if (
      event.type === "harness.loaded" &&
      isRecord(event.payload) &&
      isRecord(event.payload.harness) &&
      event.payload.harness.specHash === input.specHash
    ) {
      return {
        status: "auditable",
        anchorType: "harness.loaded",
        specHash: input.specHash
      };
    }
  }

  const sawOtherAnchor = input.events.some((event) => {
    if (event.type === "harness.snapshot.frozen" && isRecord(event.payload)) {
      return typeof event.payload.specHash === "string";
    }

    if (
      event.type === "harness.loaded" &&
      isRecord(event.payload) &&
      isRecord(event.payload.harness)
    ) {
      return typeof event.payload.harness.specHash === "string";
    }

    return false;
  });

  return {
    status: "non_auditable",
    reason: sawOtherAnchor ? "spec_hash_mismatch" : "missing_harness_snapshot_anchor",
    specHash: input.specHash
  };
}

export type SpecHashDriftSignal =
  | {
      status: "stable";
      packageId: string;
      version: string;
      observedSpecHashes: string[];
    }
  | {
      status: "drift";
      packageId: string;
      version: string;
      previousSpecHashes: string[];
      observedSpecHash: string;
      dataClass: "external_observation";
    };

export class SpecHashDriftLedger {
  private readonly observed = new Map<string, Set<string>>();

  observe(input: {
    packageId: string;
    version: string;
    specHash: string;
  }): SpecHashDriftSignal {
    const key = `${input.packageId}@${input.version}`;
    const hashes = this.observed.get(key) ?? new Set<string>();
    const previous = [...hashes].sort();

    hashes.add(input.specHash);
    this.observed.set(key, hashes);

    if (previous.length > 0 && !previous.includes(input.specHash)) {
      return {
        status: "drift",
        packageId: input.packageId,
        version: input.version,
        previousSpecHashes: previous,
        observedSpecHash: input.specHash,
        dataClass: "external_observation"
      };
    }

    return {
      status: "stable",
      packageId: input.packageId,
      version: input.version,
      observedSpecHashes: [...hashes].sort()
    };
  }
}

export function createSpecHashDriftLedger() {
  return new SpecHashDriftLedger();
}

export type HarnessLoadProvenanceErrorCode =
  | "invalid_provenance"
  | "silent_redaction";

export class HarnessLoadProvenanceError extends Error {
  readonly code: HarnessLoadProvenanceErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: HarnessLoadProvenanceErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HarnessLoadProvenanceError";
    this.code = code;
    this.details = details;
  }
}

function trustProvenance(trust: TrustVerdict | undefined) {
  if (trust === undefined) {
    return {
      publisherId: unknown("trust verification was not configured"),
      signingKeyId: unknown("trust verification was not configured"),
      signatureRef: unknown("trust verification was not configured"),
      trustStoreVersion: unknown("trust verification was not configured"),
      dataClass: "unknown"
    };
  }

  return {
    publisherId: known(trust.publisherId, "authoritative"),
    signingKeyId: known(trust.signingKeyId, "authoritative"),
    signatureRef: known(trust.signatureRef, "authoritative"),
    trustStoreVersion: known(trust.trustStoreVersion, "authoritative"),
    dataClass: "authoritative"
  };
}

function capabilityGrantProvenance(grant: GrantEvaluation) {
  if (grant.grant === undefined) {
    return {
      ref: unknown("capability grant was not resolved"),
      dataClass: "unknown"
    };
  }

  return {
    ref: known(grant.grant.grantId, "human_decision"),
    detail: grant as unknown as Record<string, unknown>,
    dataClass: "human_decision"
  };
}

function compatibilityDecisionProvenance(admission: CompatibilityAdmission) {
  return {
    ref: known(
      `${admission.matrixId}:${admission.matrixRowId}`,
      "derived_projection"
    ),
    detail: admission as unknown as Record<string, unknown>,
    dataClass:
      admission.loaderBehavior === "migrate"
        ? "human_decision"
        : "derived_projection"
  };
}

function knownOrUnknown(
  value: string | undefined,
  dataClass: Exclude<HarnessProvenanceDataClass, "unknown">,
  reason: string
) {
  return value === undefined ? unknown(reason) : known(value, dataClass);
}

function known(
  value: string,
  dataClass: Exclude<HarnessProvenanceDataClass, "unknown">
) {
  return {
    status: "known" as const,
    value,
    dataClass
  };
}

function unknown(reason: string): UnknownProvenanceValue {
  return {
    status: "unknown",
    dataClass: "unknown",
    reason
  };
}

function stableHash(value: unknown) {
  return hashString(stableStringify(value));
}

function hashString(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function redactionReferenceKey(reference: HarnessRedactionHashReference) {
  return `${reference.fieldPath}\0${reference.hashReference}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
