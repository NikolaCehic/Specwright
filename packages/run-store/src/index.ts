declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
  };
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApprovalRequestSchema,
  ArtifactRefSchema,
  HumanQuestionSchema,
  RedactionClassSchema,
  RunInputSchema,
  RunStateSchema,
  RuntimeEventSchema,
  redactionClassAtLeast,
  runtimeEventContractForType,
  type ApprovalRequest,
  type ArtifactRef,
  type HumanQuestion,
  type RedactionClass,
  type RedactionPolicy,
  type RunInput,
  type RunState,
  type RuntimeEvent,
  type RuntimeEventIntegrity
} from "@specwright/schemas";

export const RUN_STORE_DIR = ".archetype";
export const RUNS_DIR = "runs";
export const EVENTS_FILE = "events.jsonl";
export const STATE_FILE = "state.json";
export const TRACE_FILE = "trace.json";
export const DECISIONS_FILE = "decisions.jsonl";
export const SUMMARY_FILE = "summary.md";
export const CHECKPOINT_FILE = "state.checkpoint.json";
export const RUN_PACKAGE_VERSION_FILE = "run.version.json";
export const MIGRATIONS_FILE = "migrations.jsonl";
export const RUN_STATE_CHECKPOINT_VERSION = 1;
export const CHECKPOINT_INTERVAL = 128;
export const RUN_PACKAGE_VERSION_RECORD_VERSION = 1;
export const MIGRATION_RECORD_VERSION = 1;
export const MIGRATION_RECORD_HASH_PREFIX = "sha256:";
export const MIGRATION_RECORD_GENESIS_SEED = `${MIGRATION_RECORD_HASH_PREFIX}${"0".repeat(64)}`;
export const RUN_STORE_BASELINE_VERSION = {
  packageLayoutVersion: "specwright.run-package.v0",
  ledgerFormatVersion: "specwright.ledger.plain-jsonl.v0",
  projectionVersion: "specwright.reducer.baseline.v0",
  snapshotFormatVersion: "specwright.snapshot.none.v0",
  backendAdapterVersion: "specwright.backend.file.v0"
} as const;
export const RUN_STORE_CURRENT_VERSION = {
  packageLayoutVersion: "specwright.run-package.v1",
  ledgerFormatVersion: "specwright.ledger.integrity-jsonl.v1",
  projectionVersion: "specwright.reducer.current.v1",
  snapshotFormatVersion: "specwright.snapshot.checkpoint.v1",
  backendAdapterVersion: "specwright.backend.file.v1"
} as const;
export const RUN_STORE_CURRENT_REDUCER_ID =
  RUN_STORE_CURRENT_VERSION.projectionVersion;
export const RUN_STORE_BASELINE_REDUCER_ID =
  RUN_STORE_BASELINE_VERSION.projectionVersion;
export const RUN_STORE_TOOL_ARTIFACT_ADDITIVE_REDUCER_ID =
  "specwright.reducer.tool-artifact-additive.v1";

export type RunStoreErrorCode =
  | "approval_mismatch"
  | "approval_required"
  | "corrupt_event"
  | "corrupt_audit"
  | "dual_control_violation"
  | "invalid_event"
  | "invalid_event_payload"
  | "integrity_broken"
  | "invalid_projection"
  | "invalid_run_id"
  | "invalid_sequence"
  | "legal_hold_active"
  | "migration_failed"
  | "missing_events"
  | "raw_read_denied"
  | "run_exists"
  | "run_not_started"
  | "unclassified_field"
  | "unknown_version"
  | "unknown_event_contract"
  | "unsupported_event_version";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;

  constructor(code: RunStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type RunStorePaths = {
  rootDir: string;
  runsDir: string;
  runDir: string;
  eventsPath: string;
  statePath: string;
  tracePath: string;
  decisionsPath: string;
  artifactsDir: string;
  evidenceDir: string;
  cacheDir: string;
  checkpointPath: string;
  versionPath: string;
  migrationsPath: string;
  evalsDir: string;
  summaryPath: string;
};

export type HarnessSnapshot = RunState["harness"];

export type CreateRunOptions = {
  rootDir?: string | undefined;
  runId?: string;
  traceId?: string;
  input: RunInput;
  harness: HarnessSnapshot;
  initialPhase?: string;
  initialBudgets?: RunState["budgets"];
  timestamp?: Date | string;
};

export type RunStartedPayload = {
  input: RunInput;
  harness: HarnessSnapshot;
  initialPhase: string;
  budgets: RunState["budgets"];
};

export type AppendEventOptions<TPayload = unknown> = {
  rootDir?: string | undefined;
  runId: string;
  type: string;
  payload: TPayload;
  id?: string;
  traceId?: string;
  causationId?: string;
  correlationId?: string;
  timestamp?: Date | string;
};

export type CreateRunResult = {
  runId: string;
  paths: RunStorePaths;
  event: RuntimeEvent;
  state: RunState;
};

export type AppendEventResult = {
  event: RuntimeEvent;
  state: RunState;
};

export type RunStateCheckpoint = {
  checkpointVersion: number;
  runId: string;
  coveredSequence: number;
  coveredLastEventId: string;
  state: RunState;
  coveredHeadHash?: string;
};

export type RebuildFromCheckpointResult = {
  state: RunState;
  usedCheckpoint: boolean;
  reducedEventCount: number;
};

export type RunPackageVersion = {
  packageLayoutVersion: string;
  ledgerFormatVersion: string;
  projectionVersion: string;
  snapshotFormatVersion: string;
  backendAdapterVersion: string;
};

export type RunPackageVersionRecord = {
  recordVersion: typeof RUN_PACKAGE_VERSION_RECORD_VERSION;
  version: RunPackageVersion;
  migrationId?: string;
  migrationNote?: string;
};

export type MigrationCompatibilityClass =
  | "patch-compatible"
  | "additive-projection"
  | "additive-layout"
  | "forward-compatible"
  | "backward-compatible"
  | "migration-required"
  | "breaking";

export type MigrationIntegritySummary =
  | {
      status: "verified";
      eventCount: number;
      headHash: string;
    }
  | {
      status: "unchained";
      eventCount: number;
    };

export type MigrationSequenceRange = {
  from: number;
  to: number;
};

export type MigrationRecord = {
  recordVersion: typeof MIGRATION_RECORD_VERSION;
  sequence: number;
  runId: string;
  migrationId: string;
  fromVersion: RunPackageVersion;
  toVersion: RunPackageVersion;
  compatibilityClass: MigrationCompatibilityClass;
  dataLoss: boolean;
  compatibilityReducerId: string;
  coveredSequenceRange: MigrationSequenceRange | null;
  migrationNote: string;
  integrityBefore: MigrationIntegritySummary;
  integrityAfter: MigrationIntegritySummary;
  createdAt: string;
  approvalRef?: string;
  prevRecordHash: string;
  recordHash: string;
};

export type MigrationReducer = (state: RunState, event: RuntimeEvent) => void;

export type MigrationEventMapperInput = {
  rawEvent: Record<string, unknown>;
  line: string;
  index: number;
  expectedRunId: string;
  parseError: RunStoreError;
};

export type MigrationEventMapper = (
  input: MigrationEventMapperInput
) => RuntimeEvent;

export type MigrationDescriptor = {
  migrationId: string;
  fromVersion: RunPackageVersion;
  toVersion: RunPackageVersion;
  compatibilityClass: MigrationCompatibilityClass;
  dataLoss: boolean;
  migrationNote: string;
  compatibilityReducerId: string;
  compatibilityReducer: MigrationReducer;
  requiresApproval?: boolean;
  mapEvent?: MigrationEventMapper;
};

export type MigrateRunPackageOptions = {
  rootDir?: string | undefined;
  runId: string;
  descriptor: MigrationDescriptor;
  expectedState?: RunState;
  migratedAt?: Date | string;
  approvalRef?: string;
};

export type MigrationResult =
  | {
      status: "migrated";
      runId: string;
      fromVersion: RunPackageVersion;
      toVersion: RunPackageVersion;
      record: MigrationRecord;
      state: RunState;
      eventsHashBefore: string;
      eventsHashAfter: string;
      deterministicReplayHash: string;
    }
  | {
      status: "skipped_already_current";
      runId: string;
      version: RunPackageVersion;
    };

export type MigrationCohortRunResult =
  | MigrationResult
  | {
      status: "failed";
      runId: string;
      code: RunStoreErrorCode;
      message: string;
      pointer?: {
        sequence: number;
      };
    };

export type MigrationCohortResult = {
  descriptor: MigrationDescriptor;
  results: MigrationCohortRunResult[];
};

const MIGRATION_COMPATIBILITY_CLASSES = new Set<MigrationCompatibilityClass>([
  "patch-compatible",
  "additive-projection",
  "additive-layout",
  "forward-compatible",
  "backward-compatible",
  "migration-required",
  "breaking"
]);

export type RedactedHashReference = {
  redacted: true;
  redactionClass: RedactionClass;
  hash: string;
};

export type RedactionEgressMode = "redacted" | "raw";

export type RedactionGrant =
  | "audit_raw"
  | {
      class: "audit_raw";
      actor?: string;
      reason?: string;
    };

/*
 * Local consuming profile until packages/schemas owns a full RedactionProfile
 * contract. The classes themselves are parsed with RedactionClassSchema from
 * @specwright/schemas; this type is deliberately only the run-store read
 * consumer shape authorized by Scope 02 Packet 03.
 */
export type RedactionProfile = {
  id: string;
  fieldClasses: Record<string, RedactionClass>;
  defaultClass?: RedactionClass;
};

export type RedactForEgressOptions = {
  profile?: RedactionProfile;
  grant?: RedactionGrant;
  mode?: RedactionEgressMode;
};

export type ReadRunStateOptions = {
  rootDir?: string | undefined;
  runId: string;
  profile?: RedactionProfile;
  grant?: RedactionGrant;
  mode?: RedactionEgressMode;
};

export const EVENT_INTEGRITY_ALGO = "sha256";
export const EVENT_INTEGRITY_HASH_PREFIX = `${EVENT_INTEGRITY_ALGO}:`;
export const EVENT_INTEGRITY_GENESIS_SEED = `${EVENT_INTEGRITY_HASH_PREFIX}${"0".repeat(64)}`;

export const DEFAULT_REDACTION_PROFILE = {
  id: "default-redacted-egress",
  fieldClasses: {
    "artifact.fileRef.uri": "restricted",
    "artifact.uri": "restricted",
    "artifacts.*.fileRef.uri": "restricted",
    "artifacts.*.uri": "restricted",
    "content": "restricted",
    "evidence.sourceRefs.*.locator": "restricted",
    "evidence.sourceRefs.*.path": "restricted",
    "evidence.sourceRefs.*.uri": "restricted",
    "fileRef.uri": "restricted",
    "metadata.args": "restricted",
    "metadata.output": "restricted",
    "metadata.result": "restricted",
    "payload.evidence.sourceRefs.*.locator": "restricted",
    "payload.evidence.sourceRefs.*.path": "restricted",
    "payload.evidence.sourceRefs.*.uri": "restricted",
    "payload.request.args": "restricted",
    "payload.result.output": "restricted",
    "payload.result.result": "restricted",
    "request.args": "restricted",
    "result.output": "restricted",
    "result.result": "restricted",
    "sourceRefs.*.locator": "restricted",
    "sourceRefs.*.path": "restricted",
    "sourceRefs.*.uri": "restricted",
    "spans.*.metadata.args": "restricted",
    "spans.*.metadata.output": "restricted",
    "spans.*.metadata.result": "restricted"
  }
} satisfies RedactionProfile;

export type RunIntegrityDefectCode =
  | RunStoreErrorCode
  | "integrity_algo_mismatch"
  | "integrity_hash_mismatch"
  | "integrity_missing"
  | "integrity_partial_chain"
  | "integrity_prev_hash_mismatch";

export type RunIntegrityVerdict =
  | {
      status: "verified";
      eventCount: number;
      headHash: string;
    }
  | {
      status: "unchained";
      eventCount: number;
    }
  | {
      status: "broken";
      eventCount: number;
      brokenAtSequence: number;
      code: RunIntegrityDefectCode;
      detail: string;
    };

export function getRunStorePaths(rootDir: string | undefined, runId: string) {
  const safeRunId = assertSafeRunId(runId);
  const absoluteRoot = resolve(rootDir ?? ".");
  const runsDir = join(absoluteRoot, RUN_STORE_DIR, RUNS_DIR);
  const runDir = join(runsDir, safeRunId);

  return {
    rootDir: absoluteRoot,
    runsDir,
    runDir,
    eventsPath: join(runDir, EVENTS_FILE),
    statePath: join(runDir, STATE_FILE),
    tracePath: join(runDir, TRACE_FILE),
    decisionsPath: join(runDir, DECISIONS_FILE),
    artifactsDir: join(runDir, "artifacts"),
    evidenceDir: join(runDir, "evidence"),
    cacheDir: join(runDir, "cache"),
    checkpointPath: join(runDir, "cache", CHECKPOINT_FILE),
    versionPath: join(runDir, RUN_PACKAGE_VERSION_FILE),
    migrationsPath: join(runDir, MIGRATIONS_FILE),
    evalsDir: join(runDir, "evals"),
    summaryPath: join(runDir, SUMMARY_FILE)
  } satisfies RunStorePaths;
}

export async function createRun(
  options: CreateRunOptions
): Promise<CreateRunResult> {
  const runId = assertSafeRunId(options.runId ?? randomUUID());
  const traceId = nonEmpty(options.traceId, "traceId") ?? randomUUID();
  const input = RunInputSchema.parse(options.input);
  const harness = assertHarnessSnapshot(options.harness);
  const initialPhase =
    nonEmpty(options.initialPhase, "initialPhase") ?? "created";
  const budgets = RunStateSchema.shape.budgets.parse(
    options.initialBudgets ?? {}
  );
  const paths = getRunStorePaths(options.rootDir, runId);

  await mkdir(paths.runsDir, { recursive: true });
  await createRunDirectory(paths);

  await Promise.all([
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.evidenceDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.evalsDir, { recursive: true })
  ]);
  await Promise.all([
    writeFile(paths.eventsPath, "", { flag: "wx" }),
    writeFile(paths.decisionsPath, "", { flag: "wx" }),
    writeJsonAtomic(paths.tracePath, {
      runId,
      traceId
    }),
    writeFile(paths.summaryPath, "", { flag: "wx" })
  ]);

  const payload: RunStartedPayload = {
    input,
    harness,
    initialPhase,
    budgets
  };
  const event = withIntegrity(
    buildEvent({
      runId,
      type: "run.started",
      payload,
      traceId,
      timestamp: options.timestamp,
      sequence: 0
    }),
    EVENT_INTEGRITY_GENESIS_SEED
  );
  const state = projectRunState([event]);

  await appendJsonLine(paths.eventsPath, event);
  await writeProjection(paths, state);
  await writePackageVersion(paths, {
    recordVersion: RUN_PACKAGE_VERSION_RECORD_VERSION,
    version: RUN_STORE_CURRENT_VERSION
  });

  return {
    runId,
    paths,
    event,
    state
  };
}

export async function appendEvent<TPayload>(
  options: AppendEventOptions<TPayload>
): Promise<AppendEventResult> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const existingEvents = await readEvents({
    rootDir: options.rootDir,
    runId
  });
  const existingIntegrity = verifyParsedRunIntegrity(existingEvents);

  if (existingIntegrity.status === "broken") {
    throw integrityBrokenError(runId, existingIntegrity);
  }

  const lastEvent = existingEvents.at(-1);
  const builtEvent = buildEvent({
    id: options.id,
    runId,
    type: options.type,
    payload: options.payload,
    traceId: options.traceId ?? lastEvent?.traceId,
    causationId: options.causationId,
    correlationId: options.correlationId,
    timestamp: options.timestamp,
    sequence: existingEvents.length
  });
  const event =
    existingIntegrity.status === "verified"
      ? withIntegrity(builtEvent, existingIntegrity.headHash)
      : builtEvent;
  const events = [...existingEvents, event];
  const updatedIntegrity = verifyParsedRunIntegrity(events);
  const { state } = await rebuildStateForPackage({
    paths,
    runId,
    events,
    integrity: updatedIntegrity
  });

  await appendJsonLine(paths.eventsPath, event);
  await writeProjection(paths, state);
  await refreshCheckpointAfterAppend(paths, events, updatedIntegrity, state);

  return {
    event,
    state
  };
}

export async function readEvents(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RuntimeEvent[]> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  let raw: string;

  await assertReadablePackageVersion(paths);

  try {
    raw = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    throw new RunStoreError(
      "missing_events",
      `Missing event log for run ${runId}`,
      error
    );
  }

  return parseEventLog(raw, runId);
}

export async function verifyRunIntegrity(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RunIntegrityVerdict> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  let raw: string;

  try {
    raw = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    return brokenIntegrityVerdict({
      eventCount: 0,
      brokenAtSequence: 0,
      code: "missing_events",
      detail: `Missing event log for run ${runId}`,
      cause: error
    });
  }

  return verifyRawEventLogIntegrity(raw, runId);
}

export function parseEventLog(raw: string, expectedRunId?: string) {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((line, index) => parseEventLine(line, index, expectedRunId));
}

function verifyRawEventLogIntegrity(
  raw: string,
  expectedRunId: string
): RunIntegrityVerdict {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const events: RuntimeEvent[] = [];

  for (const [index, line] of lines.entries()) {
    try {
      events.push(parseEventLine(line, index, expectedRunId));
    } catch (error) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: index,
        code: error instanceof RunStoreError ? error.code : "corrupt_event",
        detail:
          error instanceof Error
            ? error.message
            : `Invalid event at sequence ${index}`,
        cause: error
      });
    }
  }

  return verifyParsedRunIntegrity(events);
}

export async function materializeRunState(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RunState> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const rebuilt = await rebuildFromCheckpoint({
    rootDir: options.rootDir,
    runId
  });

  await writeProjection(paths, rebuilt.state);

  return rebuilt.state;
}

export const replayRunState = materializeRunState;

export async function readRunState(
  options: ReadRunStateOptions
): Promise<unknown> {
  const state = await materializeRunState({
    rootDir: options.rootDir,
    runId: options.runId
  });

  return redactForEgress(state, {
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    ...(options.grant === undefined ? {} : { grant: options.grant }),
    ...(options.mode === undefined ? {} : { mode: options.mode })
  });
}

export async function detectPackageVersion(
  input:
    | RunStorePaths
    | {
        rootDir?: string | undefined;
        runId: string;
      }
): Promise<RunPackageVersion> {
  const paths = isRunStorePaths(input)
    ? input
    : getRunStorePaths(input.rootDir, input.runId);
  let raw: string;

  try {
    raw = await readFile(paths.versionPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return RUN_STORE_BASELINE_VERSION;
    }

    throw new RunStoreError(
      "unknown_version",
      `Cannot read run package version marker at ${paths.versionPath}`,
      error
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RunStoreError(
      "unknown_version",
      `Run package version marker at ${paths.versionPath} is not valid JSON`,
      error
    );
  }

  const record = parseRunPackageVersionRecord(parsed);

  if (record === undefined) {
    throw new RunStoreError(
      "unknown_version",
      `Run package version marker at ${paths.versionPath} is malformed`
    );
  }

  return record.version;
}

export function validateMigrationDescriptor(
  descriptor: MigrationDescriptor
): MigrationDescriptor {
  if (!isRecord(descriptor)) {
    throw new RunStoreError(
      "migration_failed",
      "Migration descriptor must be an object"
    );
  }

  requireNonEmptyString(descriptor.migrationId, "migrationId");
  requireNonEmptyString(descriptor.migrationNote, "migrationNote");
  requireNonEmptyString(
    descriptor.compatibilityReducerId,
    "compatibilityReducerId"
  );
  assertRunPackageVersion(descriptor.fromVersion, "fromVersion");
  assertRunPackageVersion(descriptor.toVersion, "toVersion");

  if (!MIGRATION_COMPATIBILITY_CLASSES.has(descriptor.compatibilityClass)) {
    throw new RunStoreError(
      "migration_failed",
      `Unsupported migration compatibility class ${String(
        descriptor.compatibilityClass
      )}`
    );
  }

  if (typeof descriptor.dataLoss !== "boolean") {
    throw new RunStoreError(
      "migration_failed",
      "Migration descriptor dataLoss must be boolean"
    );
  }

  if (typeof descriptor.compatibilityReducer !== "function") {
    throw new RunStoreError(
      "migration_failed",
      "Migration descriptor must declare a compatibility reducer"
    );
  }

  if (
    (descriptor.dataLoss || descriptor.compatibilityClass === "breaking") &&
    descriptor.requiresApproval !== true
  ) {
    throw new RunStoreError(
      "migration_failed",
      "Data-loss or breaking migrations must require approval metadata"
    );
  }

  if (!isKnownRunPackageVersion(descriptor.fromVersion)) {
    throw new RunStoreError(
      "unknown_version",
      "Migration descriptor fromVersion is not registered"
    );
  }

  if (!versionsEqual(descriptor.toVersion, RUN_STORE_CURRENT_VERSION)) {
    throw new RunStoreError(
      "unknown_version",
      "Migration descriptor toVersion must target the current run-store version"
    );
  }

  return descriptor;
}

export async function migrateRunPackage(
  options: MigrateRunPackageOptions
): Promise<MigrationResult> {
  const descriptor = validateMigrationDescriptor(options.descriptor);
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const temporaryPaths: string[] = [];
  const originalEventsBytes = await readRequiredFile(
    paths.eventsPath,
    "missing_events",
    `Missing event log for run ${runId}`
  );
  const originalStateBytes = await readOptionalFile(paths.statePath);
  const originalVersionBytes = await readOptionalFile(paths.versionPath);
  const originalMigrationsBytes = await readOptionalFile(paths.migrationsPath);
  const eventsHashBefore = hashRawBytes(originalEventsBytes);

  try {
    const detectedVersion = await detectPackageVersion(paths);

    if (versionsEqual(detectedVersion, descriptor.toVersion)) {
      return {
        status: "skipped_already_current",
        runId,
        version: detectedVersion
      };
    }

    if (!versionsEqual(detectedVersion, descriptor.fromVersion)) {
      throw new RunStoreError(
        "unknown_version",
        `Run ${runId} has version ${versionLabel(
          detectedVersion
        )}; descriptor ${descriptor.migrationId} migrates ${versionLabel(
          descriptor.fromVersion
        )}`
      );
    }

    if (
      descriptor.requiresApproval === true &&
      requireNonEmptyString(options.approvalRef, "approvalRef") === undefined
    ) {
      throw new RunStoreError(
        "migration_failed",
        `Migration ${descriptor.migrationId} requires approval metadata`
      );
    }

    const events = parseHistoricalEventLogForMigration(
      originalEventsBytes,
      runId,
      descriptor
    );
    const integrityBefore = verifyParsedRunIntegrity(events);

    if (integrityBefore.status === "broken") {
      throw integrityBrokenError(runId, integrityBefore);
    }

    const state = projectRunStateWithReducer(
      events,
      descriptor.compatibilityReducer
    );
    const integrityAfter = verifyParsedRunIntegrity(events);

    if (integrityAfter.status === "broken") {
      throw integrityBrokenError(runId, integrityAfter);
    }

    const existingRecords = parseMigrationRecordLog(
      originalMigrationsBytes ?? "",
      runId
    );
    const migrationRecord = buildMigrationRecord({
      descriptor,
      runId,
      sequence: existingRecords.length,
      eventCount: events.length,
      integrityBefore: integritySummary(integrityBefore),
      integrityAfter: integritySummary(integrityAfter),
      createdAt: normalizeTimestamp(options.migratedAt),
      prevRecordHash:
        existingRecords.at(-1)?.recordHash ?? MIGRATION_RECORD_GENESIS_SEED,
      approvalRef: options.approvalRef
    });
    const nextMigrationsBytes = appendMigrationRecordBytes(
      originalMigrationsBytes ?? "",
      migrationRecord
    );
    const versionRecord: RunPackageVersionRecord = {
      recordVersion: RUN_PACKAGE_VERSION_RECORD_VERSION,
      version: descriptor.toVersion,
      migrationId: descriptor.migrationId,
      migrationNote: descriptor.migrationNote
    };

    await stageAndRenameJson(
      paths.migrationsPath,
      nextMigrationsBytes,
      temporaryPaths
    );
    await stageAndRenameJson(
      paths.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      temporaryPaths
    );
    await stageAndRenameJson(
      paths.versionPath,
      `${JSON.stringify(versionRecord, null, 2)}\n`,
      temporaryPaths
    );

    const eventsHashAfter = hashRawBytes(await readFile(paths.eventsPath, "utf8"));

    if (eventsHashAfter !== eventsHashBefore) {
      throw new RunStoreError(
        "migration_failed",
        `Migration ${descriptor.migrationId} changed authoritative events.jsonl bytes`
      );
    }

    const firstReplay = await materializeRunState({
      rootDir: options.rootDir,
      runId
    });
    const secondReplay = await materializeRunState({
      rootDir: options.rootDir,
      runId
    });
    const deterministicReplayHash = hashStableJson(firstReplay);

    if (stableJson(firstReplay) !== stableJson(secondReplay)) {
      throw new RunStoreError(
        "migration_failed",
        `Migration ${descriptor.migrationId} replay is not deterministic`
      );
    }

    if (
      options.expectedState !== undefined &&
      stableJson(firstReplay) !== stableJson(options.expectedState)
    ) {
      throw new RunStoreError(
        "migration_failed",
        `Migration ${descriptor.migrationId} replay does not match expected RunState`
      );
    }

    return {
      status: "migrated",
      runId,
      fromVersion: descriptor.fromVersion,
      toVersion: descriptor.toVersion,
      record: migrationRecord,
      state: firstReplay,
      eventsHashBefore,
      eventsHashAfter,
      deterministicReplayHash
    };
  } catch (error) {
    await restoreMigrationOutputs({
      paths,
      temporaryPaths,
      originalStateBytes,
      originalVersionBytes,
      originalMigrationsBytes
    });

    throw error;
  }
}

export async function migrateCohort(options: {
  rootDir?: string | undefined;
  runIds: readonly string[];
  descriptor: MigrationDescriptor;
  expectedStates?: Record<string, RunState>;
  migratedAt?: Date | string;
  approvalRef?: string;
}): Promise<MigrationCohortResult> {
  const descriptor = validateMigrationDescriptor(options.descriptor);
  const results: MigrationCohortRunResult[] = [];

  for (const runId of options.runIds) {
    try {
      const migrateOptions: MigrateRunPackageOptions = {
        rootDir: options.rootDir,
        runId,
        descriptor,
        ...(options.expectedStates?.[runId] === undefined
          ? {}
          : { expectedState: options.expectedStates[runId] }),
        ...(options.migratedAt === undefined
          ? {}
          : { migratedAt: options.migratedAt }),
        ...(options.approvalRef === undefined
          ? {}
          : { approvalRef: options.approvalRef })
      };

      results.push(
        await migrateRunPackage(migrateOptions)
      );
    } catch (error) {
      const pointer = migrationPointer(error);

      results.push({
        status: "failed",
        runId,
        code: error instanceof RunStoreError ? error.code : "migration_failed",
        message:
          error instanceof Error
            ? error.message
            : `Migration failed for run ${runId}`,
        ...(pointer === undefined ? {} : { pointer })
      });
    }
  }

  return {
    descriptor,
    results
  };
}

export function redactForEgress(
  value: unknown,
  options: RedactForEgressOptions = {}
): unknown {
  const profile = normalizeRedactionProfile(
    options.profile ?? DEFAULT_REDACTION_PROFILE
  );
  const mode = options.mode ?? "redacted";
  const rawGranted = hasAuditRawGrant(options.grant);

  if (mode === "raw" && !rawGranted) {
    throw new RunStoreError(
      "raw_read_denied",
      "Raw run-store egress requires an audit_raw grant"
    );
  }

  return redactValue(value, {
    profile,
    mode,
    rawGranted,
    path: [],
    ancestors: []
  });
}

export async function rebuildFromCheckpoint(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RebuildFromCheckpointResult> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const integrity = await verifyRunIntegrity({
    rootDir: options.rootDir,
    runId
  });

  if (integrity.status === "broken") {
    throw integrityBrokenError(runId, integrity);
  }

  const events = await readEvents({
    rootDir: options.rootDir,
    runId
  });

  return rebuildStateForPackage({
    paths,
    runId,
    events,
    integrity
  });
}

export async function writeCheckpoint(
  paths: RunStorePaths,
  checkpoint: RunStateCheckpoint
) {
  const parsed = parseCheckpointRecord(checkpoint);

  if (parsed === undefined) {
    throw new RunStoreError(
      "invalid_projection",
      "Run state checkpoint does not match checkpoint requirements"
    );
  }

  await mkdir(paths.cacheDir, { recursive: true });
  await writeJsonAtomic(paths.checkpointPath, parsed);
}

export async function readCheckpoint(
  paths: RunStorePaths
): Promise<RunStateCheckpoint | undefined> {
  let raw: string;

  try {
    raw = await readFile(paths.checkpointPath, "utf8");
  } catch {
    return undefined;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }

  return parseCheckpointRecord(parsedJson);
}

export function projectRunState(events: readonly RuntimeEvent[]): RunState {
  return projectRunStateWithReducer(events, reduceEvent);
}

function projectRunStateWithReducer(
  events: readonly RuntimeEvent[],
  reducer: MigrationReducer
): RunState {
  if (events.length === 0) {
    throw new RunStoreError(
      "run_not_started",
      "Cannot project run state without events"
    );
  }

  validateEventSequence(events);

  const started = events[0];

  if (started === undefined || started.type !== "run.started") {
    throw new RunStoreError(
      "run_not_started",
      "The first run event must be run.started"
    );
  }

  const startedPayload = parseRunStartedPayload(started.payload);
  const runId = started.runId;
  const state: RunState = {
    runId,
    status: "running",
    phase: startedPayload.initialPhase,
    harness: startedPayload.harness,
    budgets: startedPayload.budgets,
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    lastEventId: started.id
  };

  for (const event of events) {
    if (event.runId !== runId) {
      throw new RunStoreError(
        "invalid_event",
        `Event ${event.id} belongs to ${event.runId}, expected ${runId}`
      );
    }

    reducer(state, event);
    state.lastEventId = event.id;
  }

  const parsed = RunStateSchema.safeParse(state);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Projected run state does not match RunState schema",
      parsed.error
    );
  }

  return parsed.data;
}

async function rebuildStateForPackage(input: {
  paths: RunStorePaths;
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: RunIntegrityVerdict;
}): Promise<RebuildFromCheckpointResult> {
  const reducer = await selectProjectionReducerForPackage(input.paths);

  if (reducer.reducerId !== RUN_STORE_CURRENT_REDUCER_ID) {
    return {
      state: projectRunStateWithReducer(input.events, reducer.reduce),
      usedCheckpoint: false,
      reducedEventCount: input.events.length
    };
  }

  return rebuildStateFromCheckpoint(input);
}

async function rebuildStateFromCheckpoint(input: {
  paths: RunStorePaths;
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: RunIntegrityVerdict;
}): Promise<RebuildFromCheckpointResult> {
  if (input.integrity.status === "broken") {
    throw integrityBrokenError(input.runId, input.integrity);
  }

  const checkpoint = await readCheckpoint(input.paths);
  const checkpointState = rebuildFromTrustedCheckpoint({
    runId: input.runId,
    events: input.events,
    integrity: input.integrity,
    checkpoint
  });

  if (checkpointState !== undefined) {
    return checkpointState;
  }

  return {
    state: projectRunState(input.events),
    usedCheckpoint: false,
    reducedEventCount: input.events.length
  };
}

function rebuildFromTrustedCheckpoint(input: {
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: Exclude<RunIntegrityVerdict, { status: "broken" }>;
  checkpoint: RunStateCheckpoint | undefined;
}): RebuildFromCheckpointResult | undefined {
  const { checkpoint } = input;

  if (
    checkpoint === undefined ||
    !checkpointMatchesLedger({
      runId: input.runId,
      events: input.events,
      integrity: input.integrity,
      checkpoint
    })
  ) {
    return undefined;
  }

  const state = cloneRunState(checkpoint.state);
  const tail = input.events.slice(checkpoint.coveredSequence + 1);

  /*
   * Correctness basis for checkpointing:
   * reduceEvent is pure over the prior RunState and the next event, and its
   * collection updates are idempotent-by-key. A checkpoint is therefore only a
   * cached prefix projection; replaying the verified tail must yield the same
   * result as reducing the complete ledger from sequence zero.
   */
  for (const event of tail) {
    if (event.runId !== input.runId) {
      return undefined;
    }

    reduceEvent(state, event);
    state.lastEventId = event.id;
  }

  const parsed = RunStateSchema.safeParse(state);

  if (!parsed.success) {
    return undefined;
  }

  return {
    state: parsed.data,
    usedCheckpoint: true,
    reducedEventCount: tail.length
  };
}

function checkpointMatchesLedger(input: {
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: Exclude<RunIntegrityVerdict, { status: "broken" }>;
  checkpoint: RunStateCheckpoint;
}) {
  const { checkpoint, events, integrity } = input;

  if (checkpoint.runId !== input.runId || checkpoint.state.runId !== input.runId) {
    return false;
  }

  if (checkpoint.coveredSequence >= events.length) {
    return false;
  }

  const coveredEvent = events[checkpoint.coveredSequence];

  if (
    coveredEvent === undefined ||
    coveredEvent.id !== checkpoint.coveredLastEventId
  ) {
    return false;
  }

  if (integrity.status === "verified") {
    return (
      coveredEvent.integrity !== undefined &&
      checkpoint.coveredHeadHash === coveredEvent.integrity.hash
    );
  }

  return checkpoint.coveredHeadHash === undefined;
}

async function refreshCheckpointAfterAppend(
  paths: RunStorePaths,
  events: readonly RuntimeEvent[],
  integrity: RunIntegrityVerdict,
  state: RunState
) {
  const coveredSequence = events.length - 1;

  if (
    coveredSequence < 0 ||
    coveredSequence % CHECKPOINT_INTERVAL !== 0 ||
    integrity.status === "broken"
  ) {
    return;
  }

  const coveredEvent = events[coveredSequence];

  if (coveredEvent === undefined) {
    return;
  }

  const checkpoint: RunStateCheckpoint = {
    checkpointVersion: RUN_STATE_CHECKPOINT_VERSION,
    runId: coveredEvent.runId,
    coveredSequence,
    coveredLastEventId: coveredEvent.id,
    state,
    ...(integrity.status === "verified"
      ? { coveredHeadHash: integrity.headHash }
      : {})
  };

  try {
    await writeCheckpoint(paths, checkpoint);
  } catch {
    return;
  }
}

function parseCheckpointRecord(value: unknown): RunStateCheckpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.checkpointVersion !== RUN_STATE_CHECKPOINT_VERSION) {
    return undefined;
  }

  if (typeof value.runId !== "string" || value.runId.length === 0) {
    return undefined;
  }

  if (
    typeof value.coveredSequence !== "number" ||
    !Number.isInteger(value.coveredSequence) ||
    value.coveredSequence < 0
  ) {
    return undefined;
  }

  if (
    typeof value.coveredLastEventId !== "string" ||
    value.coveredLastEventId.length === 0
  ) {
    return undefined;
  }

  if (
    value.coveredHeadHash !== undefined &&
    (typeof value.coveredHeadHash !== "string" ||
      value.coveredHeadHash.length === 0)
  ) {
    return undefined;
  }

  const state = RunStateSchema.safeParse(value.state);

  if (
    !state.success ||
    state.data.runId !== value.runId ||
    state.data.lastEventId !== value.coveredLastEventId
  ) {
    return undefined;
  }

  return {
    checkpointVersion: RUN_STATE_CHECKPOINT_VERSION,
    runId: value.runId,
    coveredSequence: value.coveredSequence,
    coveredLastEventId: value.coveredLastEventId,
    state: state.data,
    ...(value.coveredHeadHash === undefined
      ? {}
      : { coveredHeadHash: value.coveredHeadHash })
  };
}

async function assertReadablePackageVersion(paths: RunStorePaths) {
  const version = await detectPackageVersion(paths);

  if (!isKnownRunPackageVersion(version)) {
    throw new RunStoreError(
      "unknown_version",
      `Run package version ${versionLabel(version)} is not registered`
    );
  }
}

async function selectProjectionReducerForPackage(paths: RunStorePaths): Promise<{
  reducerId: string;
  reduce: MigrationReducer;
}> {
  const version = await detectPackageVersion(paths);

  if (!isKnownRunPackageVersion(version)) {
    throw new RunStoreError(
      "unknown_version",
      `Run package version ${versionLabel(version)} is not registered`
    );
  }

  if (!versionsEqual(version, RUN_STORE_CURRENT_VERSION)) {
    return {
      reducerId: RUN_STORE_CURRENT_REDUCER_ID,
      reduce: reduceEvent
    };
  }

  const records = await readMigrationRecords(paths);
  const reducerId =
    records.at(-1)?.compatibilityReducerId ?? RUN_STORE_CURRENT_REDUCER_ID;
  const reducer = compatibilityReducerById(reducerId);

  if (reducer === undefined) {
    throw new RunStoreError(
      "unknown_version",
      `No registered compatibility reducer ${reducerId}`
    );
  }

  return {
    reducerId,
    reduce: reducer
  };
}

function compatibilityReducerById(
  reducerId: string
): MigrationReducer | undefined {
  switch (reducerId) {
    case RUN_STORE_CURRENT_REDUCER_ID:
    case RUN_STORE_BASELINE_REDUCER_ID:
      return reduceEvent;
    case RUN_STORE_TOOL_ARTIFACT_ADDITIVE_REDUCER_ID:
      return reduceToolCompletedArtifacts;
    default:
      return undefined;
  }
}

function reduceToolCompletedArtifacts(state: RunState, event: RuntimeEvent) {
  reduceEvent(state, event);

  if (event.type !== "tool.completed" || !isRecord(event.payload)) {
    return;
  }

  const result = recordValue(event.payload.result);
  const output = recordValue(result.output);
  const artifact = parseNestedArtifact(output);

  if (artifact !== undefined) {
    state.artifacts = upsertByKey(state.artifacts, artifact, "artifactId");
  }
}

async function readMigrationRecords(
  paths: RunStorePaths
): Promise<MigrationRecord[]> {
  const raw = await readOptionalFile(paths.migrationsPath);

  return parseMigrationRecordLog(raw ?? "", undefined);
}

function parseMigrationRecordLog(
  raw: string,
  expectedRunId: string | undefined
) {
  if (raw.length === 0) {
    return [];
  }

  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const records: MigrationRecord[] = [];
  let prevRecordHash = MIGRATION_RECORD_GENESIS_SEED;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      throw new RunStoreError(
        "migration_failed",
        `Blank migration record at line ${index + 1}`
      );
    }

    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw new RunStoreError(
        "migration_failed",
        `Invalid JSON at migration record line ${index + 1}`,
        error
      );
    }

    const record = parseMigrationRecord(parsedJson);

    if (record === undefined) {
      throw new RunStoreError(
        "migration_failed",
        `Invalid migration record at line ${index + 1}`
      );
    }

    if (record.sequence !== index) {
      throw new RunStoreError(
        "migration_failed",
        `Migration record ${record.migrationId} has sequence ${record.sequence}, expected ${index}`
      );
    }

    if (expectedRunId !== undefined && record.runId !== expectedRunId) {
      throw new RunStoreError(
        "migration_failed",
        `Migration record ${record.migrationId} belongs to ${record.runId}, expected ${expectedRunId}`
      );
    }

    if (record.prevRecordHash !== prevRecordHash) {
      throw new RunStoreError(
        "migration_failed",
        `Migration record ${record.migrationId} prevRecordHash does not match the prior record`
      );
    }

    const expectedHash = hashMigrationRecordContent(record);

    if (record.recordHash !== expectedHash) {
      throw new RunStoreError(
        "migration_failed",
        `Migration record ${record.migrationId} hash does not match its content`
      );
    }

    records.push(record);
    prevRecordHash = record.recordHash;
  }

  return records;
}

function parseMigrationRecord(value: unknown): MigrationRecord | undefined {
  if (!isRecord(value) || value.recordVersion !== MIGRATION_RECORD_VERSION) {
    return undefined;
  }

  const runId =
    typeof value.runId === "string" && value.runId.length > 0
      ? value.runId
      : undefined;
  const migrationId =
    typeof value.migrationId === "string" && value.migrationId.length > 0
      ? value.migrationId
      : undefined;
  const compatibilityClass = MIGRATION_COMPATIBILITY_CLASSES.has(
    value.compatibilityClass as MigrationCompatibilityClass
  )
    ? (value.compatibilityClass as MigrationCompatibilityClass)
    : undefined;
  const fromVersion = isRunPackageVersion(value.fromVersion)
    ? value.fromVersion
    : undefined;
  const toVersion = isRunPackageVersion(value.toVersion)
    ? value.toVersion
    : undefined;
  const coveredSequenceRange = parseMigrationSequenceRange(
    value.coveredSequenceRange
  );
  const integrityBefore = parseMigrationIntegritySummary(value.integrityBefore);
  const integrityAfter = parseMigrationIntegritySummary(value.integrityAfter);

  if (
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 0 ||
    runId === undefined ||
    migrationId === undefined ||
    fromVersion === undefined ||
    toVersion === undefined ||
    compatibilityClass === undefined ||
    typeof value.dataLoss !== "boolean" ||
    typeof value.compatibilityReducerId !== "string" ||
    value.compatibilityReducerId.length === 0 ||
    coveredSequenceRange === undefined ||
    typeof value.migrationNote !== "string" ||
    value.migrationNote.length === 0 ||
    integrityBefore === undefined ||
    integrityAfter === undefined ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0 ||
    (value.approvalRef !== undefined &&
      (typeof value.approvalRef !== "string" || value.approvalRef.length === 0)) ||
    typeof value.prevRecordHash !== "string" ||
    value.prevRecordHash.length === 0 ||
    typeof value.recordHash !== "string" ||
    value.recordHash.length === 0
  ) {
    return undefined;
  }

  return {
    recordVersion: MIGRATION_RECORD_VERSION,
    sequence: value.sequence,
    runId,
    migrationId,
    fromVersion,
    toVersion,
    compatibilityClass,
    dataLoss: value.dataLoss,
    compatibilityReducerId: value.compatibilityReducerId,
    coveredSequenceRange,
    migrationNote: value.migrationNote,
    integrityBefore,
    integrityAfter,
    createdAt: value.createdAt,
    ...(value.approvalRef === undefined
      ? {}
      : { approvalRef: value.approvalRef }),
    prevRecordHash: value.prevRecordHash,
    recordHash: value.recordHash
  };
}

function parseMigrationSequenceRange(
  value: unknown
): MigrationSequenceRange | null | undefined {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.from !== "number" ||
    typeof value.to !== "number" ||
    !Number.isInteger(value.from) ||
    !Number.isInteger(value.to) ||
    value.from < 0 ||
    value.to < value.from
  ) {
    return undefined;
  }

  return {
    from: value.from,
    to: value.to
  };
}

function parseMigrationIntegritySummary(
  value: unknown
): MigrationIntegritySummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.status === "verified" &&
    typeof value.eventCount === "number" &&
    Number.isInteger(value.eventCount) &&
    value.eventCount >= 0 &&
    typeof value.headHash === "string" &&
    value.headHash.length > 0
  ) {
    return {
      status: "verified",
      eventCount: value.eventCount,
      headHash: value.headHash
    };
  }

  if (
    value.status === "unchained" &&
    typeof value.eventCount === "number" &&
    Number.isInteger(value.eventCount) &&
    value.eventCount >= 0
  ) {
    return {
      status: "unchained",
      eventCount: value.eventCount
    };
  }

  return undefined;
}

function buildMigrationRecord(input: {
  descriptor: MigrationDescriptor;
  runId: string;
  sequence: number;
  eventCount: number;
  integrityBefore: MigrationIntegritySummary;
  integrityAfter: MigrationIntegritySummary;
  createdAt: string;
  prevRecordHash: string;
  approvalRef?: string | undefined;
}): MigrationRecord {
  const recordWithoutHash: Omit<MigrationRecord, "recordHash"> = {
    recordVersion: MIGRATION_RECORD_VERSION,
    sequence: input.sequence,
    runId: input.runId,
    migrationId: input.descriptor.migrationId,
    fromVersion: input.descriptor.fromVersion,
    toVersion: input.descriptor.toVersion,
    compatibilityClass: input.descriptor.compatibilityClass,
    dataLoss: input.descriptor.dataLoss,
    compatibilityReducerId: input.descriptor.compatibilityReducerId,
    coveredSequenceRange:
      input.eventCount === 0 ? null : { from: 0, to: input.eventCount - 1 },
    migrationNote: input.descriptor.migrationNote,
    integrityBefore: input.integrityBefore,
    integrityAfter: input.integrityAfter,
    createdAt: input.createdAt,
    ...(input.approvalRef === undefined ? {} : { approvalRef: input.approvalRef }),
    prevRecordHash: input.prevRecordHash
  };
  const record = {
    ...recordWithoutHash,
    recordHash: hashMigrationRecordContent(recordWithoutHash)
  };
  const parsed = parseMigrationRecord(record);

  if (parsed === undefined) {
    throw new RunStoreError(
      "migration_failed",
      `Migration record ${input.descriptor.migrationId} does not validate`
    );
  }

  return parsed;
}

function hashMigrationRecordContent(
  record: Omit<MigrationRecord, "recordHash"> | MigrationRecord
) {
  const { recordHash, ...content } = record as MigrationRecord;
  void recordHash;
  const digest = createHash("sha256")
    .update(canonicalJsonStringify(content))
    .digest("hex");

  return `${MIGRATION_RECORD_HASH_PREFIX}${digest}`;
}

function appendMigrationRecordBytes(raw: string, record: MigrationRecord) {
  parseMigrationRecordLog(raw, record.runId);

  const prefix = raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}\n`;

  return `${prefix}${JSON.stringify(record)}\n`;
}

function integritySummary(
  verdict: Exclude<RunIntegrityVerdict, { status: "broken" }>
): MigrationIntegritySummary {
  return verdict.status === "verified"
    ? {
        status: "verified",
        eventCount: verdict.eventCount,
        headHash: verdict.headHash
      }
    : {
        status: "unchained",
        eventCount: verdict.eventCount
      };
}

function parseHistoricalEventLogForMigration(
  raw: string,
  expectedRunId: string,
  descriptor: MigrationDescriptor
) {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((line, index) =>
    parseHistoricalEventLineForMigration(
      line,
      index,
      expectedRunId,
      descriptor
    )
  );
}

function parseHistoricalEventLineForMigration(
  line: string,
  index: number,
  expectedRunId: string,
  descriptor: MigrationDescriptor
): RuntimeEvent {
  if (line.trim() === "") {
    throw new RunStoreError(
      "corrupt_event",
      `Blank JSONL event at line ${index + 1}`
    );
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(line) as unknown;
  } catch (error) {
    throw new RunStoreError(
      "corrupt_event",
      `Invalid JSON at event log line ${index + 1}`,
      error
    );
  }

  assertHistoricalEnvelope(parsedJson, index, expectedRunId);

  try {
    return parseEventLine(line, index, expectedRunId);
  } catch (error) {
    const parseError =
      error instanceof RunStoreError
        ? error
        : new RunStoreError(
            "invalid_event",
            `Invalid historical event at line ${index + 1}`,
            error
          );

    if (!isMappableHistoricalEventError(parseError)) {
      throw parseError;
    }

    if (descriptor.mapEvent === undefined) {
      throw new RunStoreError(
        "invalid_event",
        `Historical event at line ${index + 1} is incompatible and descriptor ${descriptor.migrationId} declares no mapping`,
        parseError
      );
    }

    const mapped = descriptor.mapEvent({
      rawEvent: parsedJson,
      line,
      index,
      expectedRunId,
      parseError
    });
    const parsedMapped = RuntimeEventSchema.safeParse(mapped);

    if (!parsedMapped.success) {
      throw new RunStoreError(
        hasPayloadIssue(parsedMapped.error) ? "invalid_event_payload" : "invalid_event",
        `Descriptor ${descriptor.migrationId} mapped event at line ${index + 1} to an invalid current event`,
        parsedMapped.error
      );
    }

    if (parsedMapped.data.runId !== expectedRunId) {
      throw new RunStoreError(
        "invalid_event",
        `Mapped event at line ${index + 1} belongs to ${parsedMapped.data.runId}, expected ${expectedRunId}`
      );
    }

    if (parsedMapped.data.sequence !== index) {
      throw new RunStoreError(
        "invalid_sequence",
        `Mapped event at line ${index + 1} has sequence ${parsedMapped.data.sequence}, expected ${index}`
      );
    }

    return parsedMapped.data;
  }
}

function assertHistoricalEnvelope(
  value: unknown,
  index: number,
  expectedRunId: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} must be an object`
    );
  }

  if (value.runId !== expectedRunId) {
    throw new RunStoreError(
      "invalid_event",
      `Event at line ${index + 1} belongs to ${String(
        value.runId
      )}, expected ${expectedRunId}`
    );
  }

  if (value.sequence !== index) {
    throw new RunStoreError(
      "invalid_sequence",
      `Event at line ${index + 1} has sequence ${String(
        value.sequence
      )}, expected ${index}`
    );
  }
}

function isMappableHistoricalEventError(error: RunStoreError) {
  return [
    "invalid_event",
    "invalid_event_payload",
    "unknown_event_contract",
    "unsupported_event_version"
  ].includes(error.code);
}

async function writePackageVersion(
  paths: RunStorePaths,
  record: RunPackageVersionRecord
) {
  await writeJsonAtomic(paths.versionPath, record);
}

function parseRunPackageVersionRecord(
  value: unknown
): RunPackageVersionRecord | undefined {
  if (!isRecord(value) || value.recordVersion !== RUN_PACKAGE_VERSION_RECORD_VERSION) {
    return undefined;
  }

  const version = isRunPackageVersion(value.version)
    ? value.version
    : undefined;

  if (
    version === undefined ||
    (value.migrationId !== undefined &&
      (typeof value.migrationId !== "string" || value.migrationId.length === 0)) ||
    (value.migrationNote !== undefined &&
      (typeof value.migrationNote !== "string" ||
        value.migrationNote.length === 0))
  ) {
    return undefined;
  }

  return {
    recordVersion: RUN_PACKAGE_VERSION_RECORD_VERSION,
    version,
    ...(value.migrationId === undefined ? {} : { migrationId: value.migrationId }),
    ...(value.migrationNote === undefined
      ? {}
      : { migrationNote: value.migrationNote })
  };
}

function assertRunPackageVersion(value: unknown, label: string) {
  if (!isRunPackageVersion(value)) {
    throw new RunStoreError(
      "migration_failed",
      `Migration descriptor ${label} is not a valid run package version`
    );
  }
}

function isRunPackageVersion(value: unknown): value is RunPackageVersion {
  return (
    isRecord(value) &&
    typeof value.packageLayoutVersion === "string" &&
    value.packageLayoutVersion.length > 0 &&
    typeof value.ledgerFormatVersion === "string" &&
    value.ledgerFormatVersion.length > 0 &&
    typeof value.projectionVersion === "string" &&
    value.projectionVersion.length > 0 &&
    typeof value.snapshotFormatVersion === "string" &&
    value.snapshotFormatVersion.length > 0 &&
    typeof value.backendAdapterVersion === "string" &&
    value.backendAdapterVersion.length > 0
  );
}

function isKnownRunPackageVersion(version: RunPackageVersion) {
  return (
    versionsEqual(version, RUN_STORE_BASELINE_VERSION) ||
    versionsEqual(version, RUN_STORE_CURRENT_VERSION)
  );
}

function versionsEqual(left: RunPackageVersion, right: RunPackageVersion) {
  return (
    left.packageLayoutVersion === right.packageLayoutVersion &&
    left.ledgerFormatVersion === right.ledgerFormatVersion &&
    left.projectionVersion === right.projectionVersion &&
    left.snapshotFormatVersion === right.snapshotFormatVersion &&
    left.backendAdapterVersion === right.backendAdapterVersion
  );
}

function versionLabel(version: RunPackageVersion) {
  return [
    version.packageLayoutVersion,
    version.ledgerFormatVersion,
    version.projectionVersion,
    version.snapshotFormatVersion,
    version.backendAdapterVersion
  ].join(" / ");
}

function isRunStorePaths(value: unknown): value is RunStorePaths {
  return isRecord(value) && typeof value.versionPath === "string";
}

async function readRequiredFile(
  path: string,
  code: RunStoreErrorCode,
  message: string
) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new RunStoreError(code, message, error);
  }
}

async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function stageAndRenameJson(
  path: string,
  bytes: string,
  temporaryPaths: string[]
) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  temporaryPaths.push(tempPath);
  await writeFile(tempPath, bytes, { flag: "wx" });
  await rename(tempPath, path);
}

async function restoreMigrationOutputs(input: {
  paths: RunStorePaths;
  temporaryPaths: readonly string[];
  originalStateBytes: string | undefined;
  originalVersionBytes: string | undefined;
  originalMigrationsBytes: string | undefined;
}) {
  await Promise.all(
    input.temporaryPaths.map((path) => rm(path, { force: true }))
  );
  await restoreFile(input.paths.statePath, input.originalStateBytes);
  await restoreFile(input.paths.versionPath, input.originalVersionBytes);
  await restoreFile(input.paths.migrationsPath, input.originalMigrationsBytes);
}

async function restoreFile(path: string, bytes: string | undefined) {
  if (bytes === undefined) {
    await rm(path, { force: true });
    return;
  }

  await writeFile(path, bytes);
}

function migrationPointer(error: unknown) {
  if (error instanceof RunStoreError && isRecord(error.cause)) {
    const sequence = error.cause.brokenAtSequence;

    if (
      typeof sequence === "number" &&
      Number.isInteger(sequence) &&
      sequence >= 0
    ) {
      return {
        sequence
      };
    }
  }

  return undefined;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashStableJson(value: unknown) {
  return hashRawBytes(stableJson(value));
}

function hashRawBytes(bytes: string) {
  const digest = createHash("sha256").update(bytes).digest("hex");

  return `sha256:${digest}`;
}

function requireNonEmptyString(value: unknown, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new RunStoreError(
      "migration_failed",
      `Migration descriptor ${label} must be a non-empty string`
    );
  }

  return value;
}

function cloneRunState(state: RunState): RunState {
  return RunStateSchema.parse(JSON.parse(JSON.stringify(state)) as unknown);
}

function reduceEvent(state: RunState, event: RuntimeEvent) {
  switch (event.type) {
    case "run.started":
      return;
    case "phase.entered":
    case "phase.transitioned": {
      const phase = getPayloadString(event.payload, [
        "phase",
        "toPhase",
        "to"
      ]);

      if (phase !== undefined) {
        state.phase = phase;
      }

      return;
    }
    case "artifact.recorded": {
      const artifact = parseNestedArtifact(event.payload);

      if (artifact !== undefined) {
        state.artifacts = upsertByKey(
          state.artifacts,
          artifact,
          "artifactId"
        );
      }

      return;
    }
    case "human.input_requested": {
      const question = parseNestedQuestion(event.payload);

      if (question !== undefined) {
        state.pendingQuestions = upsertByKey(
          state.pendingQuestions,
          question,
          "questionId"
        );
      }

      return;
    }
    case "human.answer_recorded": {
      const questionId = getPayloadString(event.payload, [
        "questionId",
        "humanQuestionId"
      ]);

      if (questionId !== undefined) {
        state.pendingQuestions = state.pendingQuestions.filter(
          (question) => question.questionId !== questionId
        );
      }

      return;
    }
    case "policy.evaluated": {
      const approval = parseNestedApprovalRequest(event.payload);

      if (approval !== undefined) {
        state.pendingApprovals = upsertByKey(
          state.pendingApprovals,
          approval,
          "approvalId"
        );
      }

      return;
    }
    case "tool.authorized":
    case "tool.denied":
    case "decision.recorded": {
      const approvalId = getPayloadString(event.payload, ["approvalId"]);

      if (approvalId !== undefined) {
        state.pendingApprovals = state.pendingApprovals.filter(
          (approval) => approval.approvalId !== approvalId
        );
      }

      return;
    }
    case "run.completed":
      state.status = "completed";
      return;
    case "run.failed":
      state.status = "failed";
      return;
    default:
      return;
  }
}

function parseEventLine(
  line: string,
  index: number,
  expectedRunId: string | undefined
) {
  if (line.trim() === "") {
    throw new RunStoreError(
      "corrupt_event",
      `Blank JSONL event at line ${index + 1}`
    );
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(line) as unknown;
  } catch (error) {
    throw new RunStoreError(
      "corrupt_event",
      `Invalid JSON at event log line ${index + 1}`,
      error
    );
  }

  const event = parseRuntimeEvent(parsedJson, index);

  if (!("payload" in event)) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} is missing payload`
    );
  }

  if (expectedRunId !== undefined && event.runId !== expectedRunId) {
    throw new RunStoreError(
      "invalid_event",
      `Event at line ${index + 1} belongs to ${event.runId}, expected ${expectedRunId}`
    );
  }

  if (event.sequence !== index) {
    throw new RunStoreError(
      "invalid_sequence",
      `Event at line ${index + 1} has sequence ${event.sequence}, expected ${index}`
    );
  }

  return event;
}

function validateEventSequence(events: readonly RuntimeEvent[]) {
  events.forEach((event, index) => {
    if (event.sequence !== index) {
      throw new RunStoreError(
        "invalid_sequence",
        `Event ${event.id} has sequence ${event.sequence}, expected ${index}`
      );
    }
  });
}

function verifyParsedRunIntegrity(
  events: readonly RuntimeEvent[]
): RunIntegrityVerdict {
  if (events.length === 0) {
    return brokenIntegrityVerdict({
      eventCount: 0,
      brokenAtSequence: 0,
      code: "run_not_started",
      detail: "Cannot verify integrity without events"
    });
  }

  const firstChainedIndex = events.findIndex(
    (event) => event.integrity !== undefined
  );

  if (firstChainedIndex === -1) {
    return {
      status: "unchained",
      eventCount: events.length
    };
  }

  if (firstChainedIndex > 0) {
    return brokenIntegrityVerdict({
      eventCount: events.length,
      brokenAtSequence: firstChainedIndex,
      code: "integrity_partial_chain",
      detail:
        "Ledger carries integrity after an unchained legacy prefix; partial chains are not trusted"
    });
  }

  let expectedPrevHash = EVENT_INTEGRITY_GENESIS_SEED;
  let headHash = EVENT_INTEGRITY_GENESIS_SEED;

  for (const event of events) {
    const integrity = event.integrity;

    if (integrity === undefined) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_missing",
        detail: `Event ${event.sequence} is missing integrity metadata`
      });
    }

    if (integrity.algo !== EVENT_INTEGRITY_ALGO) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_algo_mismatch",
        detail: `Event ${event.sequence} uses integrity algorithm ${integrity.algo}, expected ${EVENT_INTEGRITY_ALGO}`
      });
    }

    if (integrity.prevHash !== expectedPrevHash) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_prev_hash_mismatch",
        detail: `Event ${event.sequence} prevHash ${integrity.prevHash} does not match expected ${expectedPrevHash}`
      });
    }

    const expectedHash = hashEventContent(event);

    if (integrity.hash !== expectedHash) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_hash_mismatch",
        detail: `Event ${event.sequence} hash ${integrity.hash} does not match recomputed ${expectedHash}`
      });
    }

    expectedPrevHash = integrity.hash;
    headHash = integrity.hash;
  }

  return {
    status: "verified",
    eventCount: events.length,
    headHash
  };
}

function withIntegrity(
  event: RuntimeEvent,
  prevHash: string
): RuntimeEvent {
  const parsed = RuntimeEventSchema.safeParse({
    ...event,
    integrity: computeIntegrity(event, prevHash)
  });

  if (!parsed.success) {
    throw new RunStoreError(
      hasPayloadIssue(parsed.error) ? "invalid_event_payload" : "invalid_event",
      "Runtime event integrity envelope is invalid",
      parsed.error
    );
  }

  return parsed.data;
}

export function computeIntegrity(
  event: RuntimeEvent,
  prevHash: string
): RuntimeEventIntegrity {
  return {
    algo: EVENT_INTEGRITY_ALGO,
    hash: hashEventContent(event),
    prevHash
  };
}

export function hashEventContent(event: RuntimeEvent) {
  const digest = createHash(EVENT_INTEGRITY_ALGO)
    .update(canonicalizeEventContent(event))
    .digest("hex");

  return `${EVENT_INTEGRITY_HASH_PREFIX}${digest}`;
}

export function canonicalizeEventContent(event: RuntimeEvent) {
  const content = {
    id: event.id,
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    sequence: event.sequence,
    traceId: event.traceId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    ...(event.correlationId === undefined
      ? {}
      : { correlationId: event.correlationId }),
    payload: event.payload
  };

  /*
   * Stability contract for event integrity:
   * - genesis prevHash is EVENT_INTEGRITY_GENESIS_SEED
   *   (sha256: followed by 64 zeroes)
   * - the digest input is canonical JSON over the authoritative event content
   * - the integrity field and contract metadata are excluded from the digest
   * - object keys are sorted recursively; array order is preserved
   * - JSON values are normalized through JSON.stringify/parse before sorting so
   *   the hash matches the durable JSONL bytes after a write/read round trip
   */
  return canonicalJsonStringify(content);
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

function brokenIntegrityVerdict(input: {
  eventCount: number;
  brokenAtSequence: number;
  code: RunIntegrityDefectCode;
  detail: string;
  cause?: unknown;
}): RunIntegrityVerdict {
  void input.cause;

  return {
    status: "broken",
    eventCount: input.eventCount,
    brokenAtSequence: input.brokenAtSequence,
    code: input.code,
    detail: input.detail
  };
}

function integrityBrokenError(runId: string, verdict: RunIntegrityVerdict) {
  if (verdict.status !== "broken") {
    throw new Error("Expected a broken integrity verdict");
  }

  return new RunStoreError(
    "integrity_broken",
    `Run ${runId} event ledger integrity is broken at sequence ${verdict.brokenAtSequence}: ${verdict.detail}`,
    verdict
  );
}

type NormalizedRedactionProfile = {
  id: string;
  fieldClasses: Record<string, RedactionClass>;
  defaultClass?: RedactionClass;
};

type RedactionWalkContext = {
  profile: NormalizedRedactionProfile;
  mode: RedactionEgressMode;
  rawGranted: boolean;
  path: readonly string[];
  ancestors: readonly Record<string, unknown>[];
};

const SECRET_BEARING_FIELD_NAMES = new Set([
  "args",
  "content",
  "output",
  "secret",
  "sourceText",
  "text"
]);

function normalizeRedactionProfile(
  profile: RedactionProfile
): NormalizedRedactionProfile {
  if (typeof profile.id !== "string" || profile.id.length === 0) {
    throw new RunStoreError(
      "unclassified_field",
      "Redaction profile id must be a non-empty string"
    );
  }

  const fieldClasses: Record<string, RedactionClass> = {};

  for (const key of Object.keys(profile.fieldClasses).sort()) {
    const value = profile.fieldClasses[key];

    if (value === undefined) {
      continue;
    }

    fieldClasses[key] = RedactionClassSchema.parse(value);
  }

  const defaultClass =
    profile.defaultClass === undefined
      ? undefined
      : RedactionClassSchema.parse(profile.defaultClass);

  return {
    id: profile.id,
    fieldClasses,
    ...(defaultClass === undefined ? {} : { defaultClass })
  };
}

function hasAuditRawGrant(grant: RedactionGrant | undefined) {
  return grant === "audit_raw" || grant?.class === "audit_raw";
}

function redactValue(value: unknown, context: RedactionWalkContext): unknown {
  const classification = classifyPath(value, context);

  if (
    classification !== undefined &&
    redactionClassAtLeast(classification, "restricted")
  ) {
    if (context.mode === "raw" && context.rawGranted) {
      return cloneJsonValue(value);
    }

    return redactedHashReference(value, classification, context);
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
    const defaultClass = context.profile.defaultClass;

    if (defaultClass !== undefined) {
      return defaultClass;
    }

    throw new RunStoreError(
      "unclassified_field",
      `Secret-bearing field ${pathLabel(context.path)} has no redaction classification`
    );
  }

  return undefined;
}

function classFromProfile(
  profile: NormalizedRedactionProfile,
  path: readonly string[]
) {
  const candidates = pathCandidates(path);

  for (const candidate of candidates) {
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

    if (
      sourceRefClass.success &&
      ["content", "locator", "path", "text", "uri", "value"].includes(key)
    ) {
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

function parseRedactionPolicy(value: unknown): RedactionPolicy | undefined {
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

function shouldPolicyApplyToKey(key: string) {
  return SECRET_BEARING_FIELD_NAMES.has(key) || key === "claim";
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
  context: RedactionWalkContext
): RedactedHashReference {
  return {
    redacted: true,
    redactionClass,
    hash: resolveHashReference(context) ?? hashRestrictedValue(value)
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

function hashRestrictedValue(value: unknown) {
  const digest = createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex");

  return `sha256:${digest}`;
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

function pathLabel(path: readonly string[]) {
  return path.length === 0 ? "<root>" : path.join(".");
}

function parseRuntimeEvent(value: unknown, index: number) {
  if (!isRecord(value)) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} must be an object`
    );
  }

  const type = value.type;

  if (typeof type !== "string" || type.length === 0) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} is missing type`
    );
  }

  const contract = runtimeEventContractForType(type);

  if (contract === undefined) {
    throw new RunStoreError(
      "unknown_event_contract",
      `Unknown runtime event contract ${type} at line ${index + 1}`
    );
  }

  if (
    value.contractVersion !== undefined &&
    value.contractVersion !== contract.contractVersion
  ) {
    throw new RunStoreError(
      "unsupported_event_version",
      `Unsupported runtime event contract version ${String(
        value.contractVersion
      )} for ${type} at line ${index + 1}`
    );
  }

  const parsedEvent = RuntimeEventSchema.safeParse(value);

  if (!parsedEvent.success) {
    throw new RunStoreError(
      hasPayloadIssue(parsedEvent.error) ? "invalid_event_payload" : "invalid_event",
      `Invalid runtime event at line ${index + 1}`,
      parsedEvent.error
    );
  }

  return parsedEvent.data;
}

function parseRunStartedPayload(payload: unknown): RunStartedPayload {
  if (!isRecord(payload)) {
    throw new RunStoreError(
      "invalid_event",
      "run.started payload must be an object"
    );
  }

  const input = RunInputSchema.parse(payload.input);
  const harness = assertHarnessSnapshot(payload.harness);
  const initialPhase =
    nonEmpty(payload.initialPhase, "initialPhase") ?? "created";
  const budgets = isRecord(payload.budgets) ? payload.budgets : {};

  return {
    input,
    harness,
    initialPhase,
    budgets
  };
}

function parseNestedArtifact(payload: unknown): ArtifactRef | undefined {
  const candidates = getPayloadCandidates(payload, [
    "artifact",
    "artifactRef",
    "ref"
  ]);

  for (const candidate of candidates) {
    const parsed = ArtifactRefSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function parseNestedQuestion(payload: unknown): HumanQuestion | undefined {
  const candidates = getPayloadCandidates(payload, ["question", "humanQuestion"]);

  for (const candidate of candidates) {
    const parsed = HumanQuestionSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function parseNestedApprovalRequest(
  payload: unknown
): ApprovalRequest | undefined {
  const candidates = getPayloadCandidates(payload, [
    "approval",
    "approvalRequest"
  ]);

  for (const candidate of candidates) {
    const parsed = ApprovalRequestSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function getPayloadCandidates(payload: unknown, nestedKeys: string[]) {
  const candidates: unknown[] = [payload];

  if (isRecord(payload)) {
    for (const key of nestedKeys) {
      candidates.push(payload[key]);
    }
  }

  return candidates;
}

function getPayloadString(payload: unknown, keys: string[]) {
  if (!isRecord(payload)) {
    return undefined;
  }

  for (const key of keys) {
    const value = payload[key];

    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function upsertByKey<TItem extends Record<TKey, string>, TKey extends string>(
  items: readonly TItem[],
  item: TItem,
  key: TKey
) {
  const next = items.filter((current) => current[key] !== item[key]);
  next.push(item);
  return next;
}

function buildEvent<TPayload>(input: {
  id?: string | undefined;
  runId: string;
  type: string;
  payload: TPayload;
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  timestamp?: Date | string | undefined;
  sequence: number;
}): RuntimeEvent {
  const traceId = nonEmpty(input.traceId, "traceId");
  const type = nonEmpty(input.type, "type") ?? "";
  const contract = runtimeEventContractForType(type);

  if (traceId === undefined) {
    throw new RunStoreError(
      "invalid_event",
      "A traceId is required for the first run event"
    );
  }

  if (contract === undefined) {
    throw new RunStoreError(
      "unknown_event_contract",
      `Unknown runtime event contract ${type}`
    );
  }

  const event = {
    id: nonEmpty(input.id, "id") ?? randomUUID(),
    runId: assertSafeRunId(input.runId),
    type,
    timestamp: normalizeTimestamp(input.timestamp),
    sequence: input.sequence,
    traceId,
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    schemaHash: contract.schemaHash,
    ...(input.causationId === undefined
      ? {}
      : { causationId: nonEmpty(input.causationId, "causationId") }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: nonEmpty(input.correlationId, "correlationId") }),
    payload: input.payload
  };
  const parsed = RuntimeEventSchema.safeParse(event);

  if (!parsed.success) {
    throw new RunStoreError(
      hasPayloadIssue(parsed.error) ? "invalid_event_payload" : "invalid_event",
      "Runtime event envelope is invalid",
      parsed.error
    );
  }

  return parsed.data;
}

async function createRunDirectory(paths: RunStorePaths) {
  try {
    await mkdir(paths.runDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new RunStoreError(
        "run_exists",
        `Run directory already exists at ${paths.runDir}`,
        error
      );
    }

    throw error;
  }
}

export async function appendJsonLine(path: string, value: unknown) {
  const file = await open(path, "a");

  try {
    await file.appendFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeProjection(paths: RunStorePaths, state: RunState) {
  await writeJsonAtomic(paths.statePath, state);
}

export async function writeJsonAtomic(path: string, value: unknown) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx"
  });
  await rename(tempPath, path);
}

function assertHarnessSnapshot(value: unknown): HarnessSnapshot {
  if (!isRecord(value)) {
    throw new RunStoreError("invalid_event", "Harness snapshot is required");
  }

  const harness = {
    id: nonEmpty(value.id, "harness.id") ?? "",
    version: nonEmpty(value.version, "harness.version") ?? "",
    specHash: nonEmpty(value.specHash, "harness.specHash") ?? ""
  };

  const parsed = RunStateSchema.shape.harness.safeParse(harness);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_event",
      "Harness snapshot must include id, version, and specHash",
      parsed.error
    );
  }

  return parsed.data;
}

function assertSafeRunId(runId: string) {
  const value = nonEmpty(runId, "runId");

  if (
    value === undefined ||
    /[/\\]/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new RunStoreError(
      "invalid_run_id",
      "Run ID must be a non-empty path segment"
    );
  }

  return value;
}

function nonEmpty(value: unknown, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new RunStoreError("invalid_event", `${label} must be a non-empty string`);
  }

  return value;
}

function normalizeTimestamp(timestamp: Date | string | undefined) {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}

function hasPayloadIssue(error: { issues: readonly { path: readonly unknown[] }[] }) {
  return error.issues.some((issue) => issue.path[0] === "payload");
}

export * from "./administration";
