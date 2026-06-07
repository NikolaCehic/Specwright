import { createHash, randomUUID } from "node:crypto";
import type { CacheStatus, RuntimeEvent } from "@specwright/schemas";
import {
  HarnessLoaderError,
  computeSpecHash,
  loadHarnessPackageWithRecord,
  type HarnessDependencyEvent,
  type HarnessGrantEvent,
  type HarnessLoadRecord,
  type HarnessLoadStageKind,
  type HarnessLoadStageObserver,
  type HarnessLoaderErrorCode,
  type HarnessTrustEvent,
  type LoadHarnessPackageOptions,
  type ResolvedDependency,
  type SourceFile
} from "./index";
import {
  buildHarnessLoaderAuditEvent,
  cacheStatusOrDefault,
  type HarnessDefinitionCounts,
  type HarnessLoaderAuditEvent,
  type HarnessRedactionHashReference
} from "./events";
import {
  HARNESS_LOADER_VALIDATOR_BUILD_ID,
  HarnessLoadProvenanceError,
  assembleHarnessLoadProvenance,
  assertRedactionEventsCoverSubstitutions,
  hashHarnessLoadProvenance,
  type HarnessLoadProvenance,
  type SpecHashDriftLedger,
  type SpecHashDriftSignal
} from "./provenance";

export type HarnessTraceSpanInput = {
  spanId?: string;
  parentSpanId?: string;
  kind: "harness.load" | HarnessLoadStageKind;
  name: string;
  status: "success" | "failed" | "denied" | "skipped";
  startedAt?: Date | string;
  endedAt?: Date | string;
  durationMs?: number;
  eventIds?: string[];
  metadata?: Record<string, unknown>;
};

export type HarnessTraceRecorderLike = {
  recordSpan(span: HarnessTraceSpanInput): Promise<unknown> | unknown;
};

export type HarnessObservedRunContext = {
  rootDir?: string | undefined;
  runId: string;
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
};

export type HarnessRedactionRecording = {
  profile: string;
  hashReferences: readonly HarnessRedactionHashReference[];
};

export type LoadHarnessPackageObservedOptions = LoadHarnessPackageOptions & {
  runContext?: HarnessObservedRunContext | undefined;
  traceRecorder?: HarnessTraceRecorderLike | undefined;
  onAuditEvent?(event: HarnessLoaderAuditEvent): void | Promise<void>;
  now?(): Date | string;
  cacheStatus?: CacheStatus | undefined;
  registryRef?: string | undefined;
  loadedBy?: string | undefined;
  validatorBuildId?: string | undefined;
  redaction?: HarnessRedactionRecording | undefined;
  driftLedger?: SpecHashDriftLedger | undefined;
  appendRunStoreAnchor?: boolean | undefined;
};

export type LoadHarnessPackageObservedResult = {
  record: HarnessLoadRecord;
  provenance: HarnessLoadProvenance;
  auditEvents: HarnessLoaderAuditEvent[];
  traceId: string;
  runId: string;
  drift: SpecHashDriftSignal | undefined;
  runStoreAnchorEvent: RuntimeEvent | undefined;
};

type Clock = () => string;

type AuditEmitter = {
  runId: string;
  traceId: string;
  events: HarnessLoaderAuditEvent[];
  emit(
    type: HarnessLoaderAuditEvent["type"],
    payload: HarnessLoaderAuditEvent["payload"]
  ): Promise<HarnessLoaderAuditEvent>;
};

const GOVERNANCE_DENIAL_CODES = new Set<HarnessLoaderErrorCode>([
  "compatibility_denied",
  "dependency_unresolved",
  "grant_denied",
  "trust_rejected"
]);

export async function loadHarnessPackageObserved(
  input: string | LoadHarnessPackageObservedOptions
): Promise<LoadHarnessPackageObservedResult> {
  const options = normalizeObservedOptions(input);
  const clock = observedClock(options);
  const runId = options.runContext?.runId ?? `harness-load-${randomUUID()}`;
  const traceId = options.runContext?.traceId ?? `trace-${randomUUID()}`;
  const rootSpanId = `span-harness-load-${randomUUID()}`;
  const packageDir = options.packageDir;
  const audit = createAuditEmitter({
    options,
    runId,
    traceId,
    clock
  });
  const stageObserver = createStageObserver({
    options,
    traceId,
    runId,
    rootSpanId,
    clock
  });
  const startedAt = clock();
  let record: HarnessLoadRecord | undefined;

  await audit.emit("harness.load.requested", {
    packageDir,
    traceId,
    ...(options.loadedBy === undefined ? {} : { requestedBy: options.loadedBy }),
    ...(options.runContext?.runId === undefined
      ? {}
      : { runId: options.runContext.runId })
  });

  try {
    record = await loadHarnessPackageWithRecord({
      ...options,
      onLoadStage: stageObserver,
      onTrustEvent: async (event) => {
        await options.onTrustEvent?.(event);
        await emitTrustAuditEvent(audit, event);
      },
      onGrantEvent: async (event) => {
        await options.onGrantEvent?.(event);
        await emitGrantAuditEvent(audit, event);
      },
      onDependencyEvent: async (event) => {
        await options.onDependencyEvent?.(event);
        await emitDependencyAuditEvent(audit, event);
      }
    });

    verifySpecHash(
      record.snapshot,
      record.loadedFiles,
      record.dependencies.resolved
    );
    await emitSuccessEvents(audit, options, record);

    const redactionHashReferences = options.redaction?.hashReferences ?? [];
    const provenance = assembleHarnessLoadProvenance({
      snapshot: record.snapshot,
      dependencies: record.dependencies,
      grant: record.grant,
      compatibility: record.compatibility,
      sourceFiles: record.loadedFiles,
      trust: record.trust,
      registryRef: options.registryRef ?? packageDir,
      loadedBy: options.loadedBy,
      cacheStatus: cacheStatusOrDefault(options.cacheStatus),
      validatorBuildId:
        options.validatorBuildId ?? HARNESS_LOADER_VALIDATOR_BUILD_ID,
      redactionProfile: options.redaction?.profile,
      redactionHashReferences
    });
    const provenanceHash = hashHarnessLoadProvenance(provenance);

    if (redactionHashReferences.length > 0) {
      await audit.emit("harness.redaction.applied", {
        packageId: record.snapshot.id,
        version: record.snapshot.version,
        specHash: record.snapshot.specHash,
        redactedFieldPaths: redactionHashReferences.map(
          (reference) => reference.fieldPath
        ),
        redactionProfile: options.redaction?.profile ?? "unknown",
        hashReferences: [...redactionHashReferences]
      });
    }

    assertRedactionEventsCoverSubstitutions({
      hashReferences: redactionHashReferences,
      events: audit.events
    });

    await audit.emit("harness.snapshot.frozen", {
      packageId: record.snapshot.id,
      version: record.snapshot.version,
      schemaVersion: record.snapshot.schemaVersion,
      specHash: record.snapshot.specHash,
      loadedAt: record.snapshot.loadedAt,
      cacheStatus: cacheStatusOrDefault(options.cacheStatus),
      attestationId: attestationId(record),
      provenanceSummary: {
        provenanceHash,
        registryRef: options.registryRef ?? packageDir,
        validatorBuildId:
          options.validatorBuildId ?? HARNESS_LOADER_VALIDATOR_BUILD_ID,
        resolvedDependencyCount: record.dependencies.resolved.length,
        redactionCount: redactionHashReferences.length
      }
    });

    const runStoreAnchorEvent = await appendRunStoreAnchorIfConfigured(
      options,
      traceId,
      clock,
      record
    );
    const drift = options.driftLedger?.observe({
      packageId: record.snapshot.id,
      version: record.snapshot.version,
      specHash: record.snapshot.specHash
    });

    await recordRootSpan({
      options,
      runId,
      traceId,
      rootSpanId,
      startedAt,
      endedAt: clock(),
      status: "success",
      eventIds: audit.events.map((event) => event.id),
      metadata: {
        packageId: record.snapshot.id,
        requestedVersion: record.snapshot.version,
        resolvedPin: record.snapshot.version,
        registryRef: options.registryRef ?? packageDir,
        resultStatus: "success",
        specHash: record.snapshot.specHash,
        cacheStatus: cacheStatusOrDefault(options.cacheStatus),
        definitionCounts: definitionCounts(record),
        driftStatus: drift?.status ?? "not_checked"
      }
    });

    return {
      record,
      provenance,
      auditEvents: [...audit.events],
      traceId,
      runId,
      drift,
      runStoreAnchorEvent
    };
  } catch (error) {
    const loaderError = error instanceof HarnessLoaderError ? error : undefined;
    const endedAt = clock();
    const errorCode = loaderError?.code;

    if (loaderError !== undefined && isValidationErrorCode(loaderError.code)) {
      await audit.emit("harness.validation.failed", {
        errorCode: loaderError.code,
        message: loaderError.message,
        retryability: retryabilityForCode(loaderError.code),
        severity:
          loaderError.code === "parse_error" ? "critical" : "error",
        ...(loaderError.details === undefined
          ? {}
          : { details: loaderError.details })
      });
    }

    if (loaderError !== undefined) {
      if (isSecurityFailure(loaderError)) {
        await audit.emit("harness.security.failed", {
          errorCode: loaderError.code,
          stage: stageForErrorCode(loaderError.code),
          message: loaderError.message,
          reason: loaderError.reason ?? loaderError.code,
          failClosed: true,
          retryability: retryabilityForCode(loaderError.code),
          severity: securitySeverity(loaderError),
          ...(loaderError.details === undefined
            ? {}
            : { details: loaderError.details })
        });
      }

      await audit.emit("harness.load.denied", {
        errorCode: loaderError.code,
        stage: stageForErrorCode(loaderError.code),
        message: loaderError.message,
        failClosed: true,
        retryability: retryabilityForCode(loaderError.code),
        ...(loaderError.reason === undefined ? {} : { reason: loaderError.reason }),
        ...(loaderError.details === undefined
          ? {}
          : { details: loaderError.details })
      });
    }

    await recordRootSpan({
      options,
      runId,
      traceId,
      rootSpanId,
      startedAt,
      endedAt,
      status:
        errorCode !== undefined && GOVERNANCE_DENIAL_CODES.has(errorCode)
          ? "denied"
          : "failed",
      eventIds: audit.events.map((event) => event.id),
      metadata: {
        registryRef: options.registryRef ?? packageDir,
        resultStatus: "failed",
        ...(errorCode === undefined ? {} : { errorCode }),
        message: error instanceof Error ? error.message : String(error)
      }
    });

    throw error;
  }
}

export function verifySpecHash(
  snapshot: { specHash: string },
  files: readonly SourceFile[],
  dependencies: readonly ResolvedDependency[] = []
) {
  const actual = computeSpecHash(files, dependencies);

  if (actual !== snapshot.specHash) {
    throw new HarnessLoadProvenanceError(
      "invalid_provenance",
      `Snapshot specHash ${snapshot.specHash} did not match recomputed ${actual}`,
      {
        expected: snapshot.specHash,
        actual
      }
    );
  }
}

function normalizeObservedOptions(
  input: string | LoadHarnessPackageObservedOptions
): LoadHarnessPackageObservedOptions {
  return typeof input === "string" ? { packageDir: input } : input;
}

function observedClock(options: LoadHarnessPackageObservedOptions): Clock {
  return () => {
    const value = options.now?.() ?? new Date();

    return value instanceof Date ? value.toISOString() : value;
  };
}

function createAuditEmitter(input: {
  options: LoadHarnessPackageObservedOptions;
  runId: string;
  traceId: string;
  clock: Clock;
}): AuditEmitter {
  let sequence = 0;
  const events: HarnessLoaderAuditEvent[] = [];

  return {
    runId: input.runId,
    traceId: input.traceId,
    events,
    async emit(type, payload) {
      const event = buildHarnessLoaderAuditEvent({
        type,
        payload,
        runId: input.runId,
        traceId: input.traceId,
        sequence,
        timestamp: input.clock(),
        ...(input.options.runContext?.causationId === undefined
          ? {}
          : { causationId: input.options.runContext.causationId }),
        ...(input.options.runContext?.correlationId === undefined
          ? {}
          : { correlationId: input.options.runContext.correlationId })
      });

      sequence += 1;
      events.push(event);
      await input.options.onAuditEvent?.(event);

      return event;
    }
  };
}

function createStageObserver(input: {
  options: LoadHarnessPackageObservedOptions;
  traceId: string;
  runId: string;
  rootSpanId: string;
  clock: Clock;
}): HarnessLoadStageObserver {
  const callerObserver = input.options.onLoadStage;

  return async (stage, metadata, operation) => {
    const startedAt = input.clock();

    try {
      const value = await (callerObserver === undefined
        ? operation()
        : callerObserver(stage, metadata, operation));
      const endedAt = input.clock();

      await input.options.traceRecorder?.recordSpan({
        spanId: `span-${stage}-${randomUUID()}`,
        parentSpanId: input.rootSpanId,
        kind: stage,
        name: stage,
        status: "success",
        startedAt,
        endedAt,
        metadata: stageMetadata(
          stage,
          {
            ...metadata,
            runId: input.runId,
            traceId: input.traceId
          },
          value
        )
      });

      return value;
    } catch (error) {
      const endedAt = input.clock();
      const loaderError = error instanceof HarnessLoaderError ? error : undefined;

      await input.options.traceRecorder?.recordSpan({
        spanId: `span-${stage}-${randomUUID()}`,
        parentSpanId: input.rootSpanId,
        kind: stage,
        name: stage,
        status:
          loaderError !== undefined && GOVERNANCE_DENIAL_CODES.has(loaderError.code)
            ? "denied"
            : "failed",
        startedAt,
        endedAt,
        metadata: {
          ...metadata,
          runId: input.runId,
          traceId: input.traceId,
          ...(loaderError === undefined ? {} : { errorCode: loaderError.code }),
          message: error instanceof Error ? error.message : String(error)
        }
      });

      throw error;
    }
  };
}

async function emitSuccessEvents(
  audit: AuditEmitter,
  options: LoadHarnessPackageObservedOptions,
  record: HarnessLoadRecord
) {
  if (record.trust !== undefined && !hasEvent(audit, "harness.trust.verified")) {
    await audit.emit("harness.trust.verified", {
      packageId: record.snapshot.id,
      version: record.snapshot.version,
      publisherId: record.trust.publisherId,
      signingKeyId: record.trust.signingKeyId,
      algorithm: record.trust.algorithm,
      signatureRef: record.trust.signatureRef,
      trustStoreVersion: record.trust.trustStoreVersion,
      specHash: record.trust.specHash,
      verdict: "verified"
    });
  }

  await audit.emit("harness.validated", {
    packageId: record.snapshot.id,
    version: record.snapshot.version,
    schemaVersion: record.snapshot.schemaVersion,
    definitionCounts: definitionCounts(record),
    validatorBuildId:
      options.validatorBuildId ?? HARNESS_LOADER_VALIDATOR_BUILD_ID
  });

  if (!hasEvent(audit, "harness.dependencies.pinned")) {
    await audit.emit("harness.dependencies.pinned", {
      packageId: record.snapshot.id,
      version: record.snapshot.version,
      specHash: record.snapshot.specHash,
      dependencies: record.dependencies.resolved
    });
  }

  await audit.emit("harness.compatibility.decided", {
    packageId: record.snapshot.id,
    version: record.snapshot.version,
    matrixId: record.compatibility.matrixId,
    matrixRowId: record.compatibility.matrixRowId,
    runtimeVersion: record.compatibility.runtimeVersion,
    declaredSchemaVersion: record.compatibility.declaredSchemaVersion,
    targetSchemaVersion: record.compatibility.targetSchemaVersion,
    compatibilityClass: record.compatibility.compatibilityClass,
    decision: record.compatibility.loaderBehavior,
    ...(record.compatibility.migration === undefined
      ? {}
      : { migration: record.compatibility.migration })
  });

  if (!hasEvent(audit, "harness.grant.evaluated")) {
    await audit.emit("harness.grant.evaluated", grantPayload(record));
  }
}

async function emitTrustAuditEvent(
  audit: AuditEmitter,
  event: HarnessTrustEvent
) {
  if (event.type === "harness.trust.verified") {
    await audit.emit("harness.trust.verified", {
      publisherId: event.payload.publisherId,
      signingKeyId: event.payload.signingKeyId,
      algorithm: event.payload.algorithm,
      signatureRef: event.payload.signatureRef,
      trustStoreVersion: event.payload.trustStoreVersion,
      specHash: event.payload.specHash,
      verdict: event.payload.verdict
    });
    return;
  }

  await audit.emit("harness.trust.rejected", {
    reasonCode: event.payload.reason,
    failClosed: true,
    retryability: "operator_action",
    ...(event.payload.publisherId === undefined
      ? {}
      : { publisherId: event.payload.publisherId }),
    ...(event.payload.signingKeyId === undefined
      ? {}
      : { signingKeyId: event.payload.signingKeyId }),
    ...(event.payload.trustStoreVersion === undefined
      ? {}
      : { trustStoreVersion: event.payload.trustStoreVersion }),
    ...(event.payload.details === undefined ? {} : { details: event.payload.details })
  });
}

async function emitGrantAuditEvent(
  audit: AuditEmitter,
  event: HarnessGrantEvent
) {
  await audit.emit("harness.grant.evaluated", event.payload);
}

async function emitDependencyAuditEvent(
  audit: AuditEmitter,
  event: HarnessDependencyEvent
) {
  await audit.emit("harness.dependencies.pinned", event.payload);
}

async function appendRunStoreAnchorIfConfigured(
  options: LoadHarnessPackageObservedOptions,
  traceId: string,
  clock: Clock,
  record: HarnessLoadRecord
) {
  if (
    options.runContext === undefined ||
    options.appendRunStoreAnchor === false
  ) {
    return undefined;
  }

  const appendEvent = await loadRunStoreAppendEvent();
  const appended = await appendEvent({
    ...(options.runContext.rootDir === undefined
      ? {}
      : { rootDir: options.runContext.rootDir }),
    runId: options.runContext.runId,
    type: "harness.loaded",
    traceId,
    ...(options.runContext.causationId === undefined
      ? {}
      : { causationId: options.runContext.causationId }),
    ...(options.runContext.correlationId === undefined
      ? {}
      : { correlationId: options.runContext.correlationId }),
    timestamp: clock(),
    payload: {
      harness: record.snapshot
    }
  });

  return appended.event;
}

type RunStoreAppendEvent = <TPayload>(options: {
  rootDir?: string;
  runId: string;
  type: string;
  payload: TPayload;
  id?: string;
  traceId?: string;
  causationId?: string;
  correlationId?: string;
  timestamp?: Date | string;
}) => Promise<{ event: RuntimeEvent }>;

async function loadRunStoreAppendEvent(): Promise<RunStoreAppendEvent> {
  const moduleName = "@specwright/run-store";
  const runStoreModule = (await import(moduleName)) as {
    appendEvent?: RunStoreAppendEvent;
  };

  if (runStoreModule.appendEvent === undefined) {
    throw new HarnessLoadProvenanceError(
      "invalid_provenance",
      "Run-store appendEvent was not available for harness.loaded anchoring"
    );
  }

  return runStoreModule.appendEvent;
}

async function recordRootSpan(input: {
  options: LoadHarnessPackageObservedOptions;
  runId: string;
  traceId: string;
  rootSpanId: string;
  startedAt: string;
  endedAt: string;
  status: "success" | "failed" | "denied";
  eventIds: string[];
  metadata: Record<string, unknown>;
}) {
  await input.options.traceRecorder?.recordSpan({
    spanId: input.rootSpanId,
    kind: "harness.load",
    name: "harness.load",
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    eventIds: input.eventIds,
    metadata: {
      ...input.metadata,
      runId: input.runId,
      traceId: input.traceId
    }
  });
}

function stageMetadata(
  stage: HarnessLoadStageKind,
  metadata: Record<string, unknown>,
  value: unknown
) {
  const base = {
    ...metadata
  };

  if (stage === "harness.fetch" && isFetchedResult(value)) {
    return {
      ...base,
      fileCount: value.loadedFiles.length,
      byteCount: value.loadedFiles.reduce((total, file) => total + file.raw.length, 0),
      fileListDigest: hashString(
        value.loadedFiles.map((file) => file.relativePath).sort().join("\0")
      ),
      contentDigest: hashString(
        value.loadedFiles
          .map((file) => `${file.relativePath}\0${file.raw}`)
          .sort()
          .join("\0")
      ),
      cacheStatus: "bypass"
    };
  }

  if (stage === "harness.compatibility" && isCompatibilityResult(value)) {
    return {
      ...base,
      runtimeVersion: value.admission.runtimeVersion,
      fromVersion: value.admission.declaredSchemaVersion,
      toVersion: value.admission.targetSchemaVersion,
      compatibilityClass: value.admission.compatibilityClass,
      compatibilityDecision: value.admission.loaderBehavior
    };
  }

  if (stage === "harness.verify_trust" && isTrustVerdict(value)) {
    return {
      ...base,
      publisherId: value.publisherId,
      signingKeyId: value.signingKeyId,
      signatureAlgorithm: value.algorithm,
      trustStoreVersion: value.trustStoreVersion,
      trustVerdict: value.status
    };
  }

  if (stage === "harness.resolve_deps" && isDependencyResolution(value)) {
    return {
      ...base,
      dependencyIds: value.resolved.map((dependency) => dependency.name),
      resolvedVersions: value.resolved.map((dependency) => dependency.version),
      pinnedHashes: value.resolved.map((dependency) => dependency.contentHash),
      unpinnedCount: 0
    };
  }

  if (stage === "harness.grant_check" && isGrantEvaluation(value)) {
    return {
      ...base,
      requestedCapabilities: flattenCapabilitySurface(value.requested),
      grantedScopes: flattenCapabilitySurface(value.grantedCapabilities),
      deniedCapabilities: value.deniedCapabilities
    };
  }

  if (stage === "harness.freeze" && isFreezeResult(value)) {
    return {
      ...base,
      specHash: value.specHash,
      attestationId: `attestation:${value.specHash}`
    };
  }

  return base;
}

function grantPayload(record: HarnessLoadRecord) {
  return {
    packageId: record.snapshot.id,
    version: record.snapshot.version,
    verdict: record.grant.granted ? ("allowed" as const) : ("denied" as const),
    requested: record.grant.requested,
    granted: record.grant.grantedCapabilities,
    overGrant: record.grant.overGrant,
    ...(record.grant.grant === undefined ? {} : { grant: record.grant.grant }),
    deniedCapabilities: record.grant.deniedCapabilities,
    ...(record.grant.denialReason === undefined
      ? {}
      : { denialReason: record.grant.denialReason }),
    ...(record.grant.granted ? {} : { failClosed: true as const })
  };
}

function definitionCounts(record: HarnessLoadRecord): HarnessDefinitionCounts {
  return {
    phases: record.snapshot.phases.length,
    gates: record.snapshot.gates.length,
    policies: record.snapshot.policies.length,
    tools: record.snapshot.tools.length,
    artifacts: record.snapshot.artifacts.length,
    evals: record.snapshot.evals.length,
    roles: record.snapshot.roles.length,
    prompts: record.snapshot.prompts.length
  };
}

function attestationId(record: HarnessLoadRecord) {
  return record.trust?.signatureRef ?? `attestation:${record.snapshot.specHash}`;
}

function hasEvent(audit: AuditEmitter, type: HarnessLoaderAuditEvent["type"]) {
  return audit.events.some((event) => event.type === type);
}

function isValidationErrorCode(code: HarnessLoaderErrorCode) {
  return !GOVERNANCE_DENIAL_CODES.has(code);
}

function isSecurityFailure(error: HarnessLoaderError) {
  return (
    error.code === "trust_rejected" ||
    error.code === "grant_denied" ||
    error.code === "cache_poisoned" ||
    (error.code === "parse_error" && error.reason === "path_escape") ||
    (error.code === "invalid_artifact_schema" &&
      error.reason === "remote_ref_denied")
  );
}

function securitySeverity(error: HarnessLoaderError) {
  return error.code === "parse_error" ||
    error.code === "invalid_artifact_schema" ||
    error.code === "cache_poisoned"
    ? ("critical" as const)
    : ("high" as const);
}

function stageForErrorCode(code: HarnessLoaderErrorCode): HarnessLoadStageKind {
  switch (code) {
    case "compatibility_denied":
    case "unsupported_schema_version":
      return "harness.compatibility";
    case "dependency_unresolved":
      return "harness.resolve_deps";
    case "grant_denied":
      return "harness.grant_check";
    case "trust_rejected":
      return "harness.verify_trust";
    case "resource_limit_exceeded":
      return "harness.fetch";
    case "cache_poisoned":
    case "version_not_resolvable":
      return "harness.freeze";
    case "invalid_lifecycle_transition":
    case "promotion_unapproved":
    case "version_immutable":
      return "harness.validate";
    case "invalid_loaded_at":
      return "harness.freeze";
    case "missing_harness_manifest":
      return "harness.fetch";
    case "invalid_manifest":
    case "invalid_artifact_schema":
    case "invalid_definition":
    case "invalid_prompt":
    case "parse_error":
      return "harness.parse";
    case "duplicate_id":
    case "invalid_graph":
    case "missing_reference":
      return "harness.validate";
  }
}

function retryabilityForCode(code: HarnessLoaderErrorCode) {
  switch (code) {
    case "parse_error":
    case "missing_harness_manifest":
      return "retryable";
    default:
      return "operator_action";
  }
}

function flattenCapabilitySurface(surface: {
  tools: readonly string[];
  requireApproval: readonly string[];
  toolDefinitions: readonly string[];
  policyEffects: readonly string[];
  policyLayers: readonly string[];
  runtimeInvariantToolIds: readonly string[];
}) {
  return [
    ...surface.tools.map((value) => `tool:${value}`),
    ...surface.requireApproval.map((value) => `approval:${value}`),
    ...surface.toolDefinitions.map((value) => `toolDefinition:${value}`),
    ...surface.policyEffects.map((value) => `policyEffect:${value}`),
    ...surface.policyLayers.map((value) => `policyLayer:${value}`),
    ...surface.runtimeInvariantToolIds.map(
      (value) => `runtimeInvariantTool:${value}`
    )
  ];
}

function hashString(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isFetchedResult(value: unknown): value is { loadedFiles: SourceFile[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.loadedFiles) &&
    value.loadedFiles.every(
      (file) =>
        isRecord(file) &&
        typeof file.relativePath === "string" &&
        typeof file.raw === "string"
    )
  );
}

function isCompatibilityResult(value: unknown): value is {
  admission: {
    runtimeVersion: string;
    declaredSchemaVersion: string;
    targetSchemaVersion: string;
    compatibilityClass: string;
    loaderBehavior: string;
  };
} {
  return isRecord(value) && isRecord(value.admission);
}

function isTrustVerdict(value: unknown): value is {
  status: string;
  publisherId: string;
  signingKeyId: string;
  algorithm: string;
  trustStoreVersion: string;
} {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    typeof value.publisherId === "string" &&
    typeof value.signingKeyId === "string" &&
    typeof value.algorithm === "string" &&
    typeof value.trustStoreVersion === "string"
  );
}

function isDependencyResolution(value: unknown): value is {
  resolved: Array<{ name: string; version: string; contentHash: string }>;
} {
  return isRecord(value) && Array.isArray(value.resolved);
}

function isGrantEvaluation(value: unknown): value is {
  requested: Parameters<typeof flattenCapabilitySurface>[0];
  grantedCapabilities: Parameters<typeof flattenCapabilitySurface>[0];
  deniedCapabilities: string[];
} {
  return (
    isRecord(value) &&
    isRecord(value.requested) &&
    isRecord(value.grantedCapabilities) &&
    Array.isArray(value.deniedCapabilities)
  );
}

function isFreezeResult(value: unknown): value is { specHash: string } {
  return isRecord(value) && typeof value.specHash === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
