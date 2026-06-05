declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
  };
}

import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
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
import {
  appendAdministrationRecord,
  runScopeForRun,
  withDualControl,
  type AdministrationProfileOrDescriptor,
  type AdministrationRecord,
  type AdministrationRunScope,
  type LegalHoldDeclaration,
  type WithDualControlRecordIds,
  type WithDualControlResult,
  type WithDualControlTimestamps
} from "./administration";

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
export const SEAL_FILE = "seal.json";
export const READ_MOSTLY_FILE = "read-mostly.json";
export const RETENTION_FILE = "retention.json";
export const LEGAL_HOLDS_FILE = "legal-holds.jsonl";
export const TOMBSTONE_FILE = "archive.tombstone.json";
export const ARCHIVE_MANIFEST_FILE = "archive.manifest.json";
export const ARCHIVE_DIR = "archives";
export const ARCHIVE_RUNS_DIR = "runs";
export const ARCHIVE_STAGE_DIR = ".stage";
export const RUN_STATE_CHECKPOINT_VERSION = 1;
export const CHECKPOINT_INTERVAL = 128;
export const RUN_PACKAGE_VERSION_RECORD_VERSION = 1;
export const MIGRATION_RECORD_VERSION = 1;
export const SEAL_RECORD_VERSION = 1;
export const READ_MOSTLY_MARKER_VERSION = 1;
export const LEGAL_HOLD_RECORD_VERSION = 1;
export const ARCHIVE_MANIFEST_VERSION = 1;
export const TOMBSTONE_VERSION = 1;
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
  | "not_terminal"
  | "raw_read_denied"
  | "retention_not_expired"
  | "run_exists"
  | "run_sealed"
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
  sealPath: string;
  readMostlyPath: string;
  retentionPath: string;
  legalHoldsPath: string;
  tombstonePath: string;
  archiveDir: string;
  archiveRunsDir: string;
  archiveStageDir: string;
  archiveRunDir: string;
  archiveManifestPath: string;
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

const retentionNonEmptyString = z.string().min(1);
const retentionIsoTimestamp = z.string().datetime({ offset: true });
const RetentionJsonValueSchema: z.ZodType<RetentionJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(RetentionJsonValueSchema),
    z.record(RetentionJsonValueSchema)
  ])
);

export const SealRecordSchema = z
  .object({
    recordVersion: z.literal(SEAL_RECORD_VERSION),
    runId: retentionNonEmptyString,
    sealedAt: retentionIsoTimestamp,
    sealedStatus: z.enum(["completed", "failed"]),
    integrityHead: retentionNonEmptyString,
    eventCount: z.number().int().positive(),
    stateHash: retentionNonEmptyString,
    state: RunStateSchema
  })
  .strict();

export const ReadMostlyMarkerSchema = z
  .object({
    recordVersion: z.literal(READ_MOSTLY_MARKER_VERSION),
    runId: retentionNonEmptyString,
    sealedAt: retentionIsoTimestamp,
    sealRecordPath: retentionNonEmptyString,
    integrityHead: retentionNonEmptyString,
    readMostly: z.literal(true)
  })
  .strict();

export const RetentionDescriptorSchema = z
  .object({
    descriptorId: retentionNonEmptyString.optional(),
    retentionClass: retentionNonEmptyString,
    archiveAfterMs: z.number().int().nonnegative().optional(),
    archiveEligibleAt: retentionIsoTimestamp.optional(),
    expireAfterMs: z.number().int().nonnegative().optional(),
    expiresAt: retentionIsoTimestamp.optional(),
    metadata: z.record(RetentionJsonValueSchema).optional()
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.archiveAfterMs === undefined &&
      descriptor.archiveEligibleAt === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "retention descriptor must provide archiveAfterMs or archiveEligibleAt"
      });
    }

    if (
      descriptor.archiveAfterMs !== undefined &&
      descriptor.archiveEligibleAt !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "retention descriptor must not provide both archiveAfterMs and archiveEligibleAt"
      });
    }

    if (
      descriptor.expireAfterMs === undefined &&
      descriptor.expiresAt === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "retention descriptor must provide expireAfterMs or expiresAt"
      });
    }

    if (
      descriptor.expireAfterMs !== undefined &&
      descriptor.expiresAt !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "retention descriptor must not provide both expireAfterMs and expiresAt"
      });
    }

    if (
      descriptor.archiveAfterMs !== undefined &&
      descriptor.expireAfterMs !== undefined &&
      descriptor.expireAfterMs < descriptor.archiveAfterMs
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expireAfterMs must be greater than or equal to archiveAfterMs"
      });
    }

    if (
      descriptor.archiveEligibleAt !== undefined &&
      descriptor.expiresAt !== undefined &&
      Date.parse(descriptor.expiresAt) < Date.parse(descriptor.archiveEligibleAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be greater than or equal to archiveEligibleAt"
      });
    }
  });

export const LegalHoldRecordSchema = z
  .object({
    recordVersion: z.literal(LEGAL_HOLD_RECORD_VERSION),
    holdId: retentionNonEmptyString,
    runId: retentionNonEmptyString,
    placedAt: retentionIsoTimestamp,
    placedBy: retentionNonEmptyString,
    reason: retentionNonEmptyString,
    releasedAt: retentionIsoTimestamp.optional(),
    releasedBy: retentionNonEmptyString.optional(),
    releaseReason: retentionNonEmptyString.optional(),
    metadata: z.record(RetentionJsonValueSchema).optional()
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.releasedAt === undefined) !==
      (record.releasedBy === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "releasedAt and releasedBy must be recorded together"
      });
    }

    if (
      record.releasedAt !== undefined &&
      Date.parse(record.releasedAt) < Date.parse(record.placedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "releasedAt must be greater than or equal to placedAt"
      });
    }
  });

export const ArchiveManifestSchema = z
  .object({
    manifestVersion: z.literal(ARCHIVE_MANIFEST_VERSION),
    runId: retentionNonEmptyString,
    archivedAt: retentionIsoTimestamp,
    sealedAt: retentionIsoTimestamp,
    sealedStatus: z.enum(["completed", "failed"]),
    integrityHead: retentionNonEmptyString,
    eventCount: z.number().int().positive(),
    eventsHash: retentionNonEmptyString,
    stateHash: retentionNonEmptyString,
    sourceRunDir: retentionNonEmptyString,
    archiveRunDir: retentionNonEmptyString,
    archiveManifestPath: retentionNonEmptyString,
    tombstonePath: retentionNonEmptyString,
    retentionDescriptor: RetentionDescriptorSchema
  })
  .strict();

export const TombstoneSchema = z
  .object({
    tombstoneVersion: z.literal(TOMBSTONE_VERSION),
    runId: retentionNonEmptyString,
    archivedAt: retentionIsoTimestamp,
    archiveRunDir: retentionNonEmptyString,
    archiveManifestPath: retentionNonEmptyString,
    integrityHead: retentionNonEmptyString,
    eventCount: z.number().int().positive(),
    sealedAt: retentionIsoTimestamp,
    retentionClass: retentionNonEmptyString
  })
  .strict();

export type RetentionJsonValue =
  | string
  | number
  | boolean
  | null
  | RetentionJsonValue[]
  | { [key: string]: RetentionJsonValue };

export type SealRecord = z.infer<typeof SealRecordSchema>;
export type ReadMostlyMarker = z.infer<typeof ReadMostlyMarkerSchema>;
export type RetentionDescriptor = z.infer<typeof RetentionDescriptorSchema>;
export type LegalHoldRecord = z.infer<typeof LegalHoldRecordSchema>;
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;
export type Tombstone = z.infer<typeof TombstoneSchema>;

export type RetentionState =
  | {
      status: "unsealed";
      runId: string;
      activeLegalHolds: LegalHoldRecord[];
    }
  | {
      status: "held";
      runId: string;
      seal: SealRecord;
      archiveEligibleAt: string;
      expiresAt: string;
      activeLegalHolds: LegalHoldRecord[];
    }
  | {
      status: "sealed";
      runId: string;
      seal: SealRecord;
      archiveEligibleAt: string;
      expiresAt: string;
      activeLegalHolds: [];
    }
  | {
      status: "archive_eligible";
      runId: string;
      seal: SealRecord;
      archiveEligibleAt: string;
      expiresAt: string;
      activeLegalHolds: [];
    }
  | {
      status: "expired";
      runId: string;
      seal: SealRecord;
      archiveEligibleAt: string;
      expiresAt: string;
      activeLegalHolds: [];
    };

export type SealRunOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  actor?: string | undefined;
  sealedAt?: Date | string | undefined;
  recordId?: string | undefined;
};

export type SealRunResult = {
  runId: string;
  record: SealRecord;
  marker: ReadMostlyMarker;
  administrationRecord?: AdministrationRecord;
  idempotent: boolean;
};

export type ComputeRetentionStateOptions = {
  rootDir?: string | undefined;
  runId: string;
  descriptor: RetentionDescriptor;
  now?: Date | string | undefined;
};

export type PlaceLegalHoldOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  holdId?: string | undefined;
  placedBy: string;
  reason: string;
  placedAt?: Date | string | undefined;
  metadata?: Record<string, RetentionJsonValue> | undefined;
  recordId?: string | undefined;
};

export type ReleaseLegalHoldOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  holdId: string;
  releasedBy: string;
  releasedAt?: Date | string | undefined;
  releaseReason?: string | undefined;
  recordId?: string | undefined;
};

export type ArchiveRunOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  actor: string;
  approvalId?: string | undefined;
  descriptor: RetentionDescriptor;
  archivedAt?: Date | string | undefined;
  now?: Date | string | undefined;
  runScope?: AdministrationRunScope | undefined;
  profileOrDescriptor?: AdministrationProfileOrDescriptor | undefined;
  recordIds?: WithDualControlRecordIds | undefined;
  timestamps?: WithDualControlTimestamps | undefined;
};

export type ArchiveRunResult = WithDualControlResult<{
  runId: string;
  archiveRunDir: string;
  tombstonePath: string;
  manifest: ArchiveManifest;
  tombstone: Tombstone;
  eventsHashBefore: string;
  eventsHashAfter: string;
}>;

export type RestoreRunOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  actor?: string | undefined;
  restoredAt?: Date | string | undefined;
  expectedState?: RunState | undefined;
  recordId?: string | undefined;
};

export type RestoreRunResult = {
  runId: string;
  restoredRunDir: string;
  manifest: ArchiveManifest;
  state: RunState;
  deterministicReplayHash: string;
  administrationRecord?: AdministrationRecord;
};

export type HardDeleteRunOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  actor: string;
  approvalId?: string | undefined;
  descriptor: RetentionDescriptor;
  now?: Date | string | undefined;
  runScope?: AdministrationRunScope | undefined;
  profileOrDescriptor?: AdministrationProfileOrDescriptor | undefined;
  recordIds?: WithDualControlRecordIds | undefined;
  timestamps?: WithDualControlTimestamps | undefined;
};

export type HardDeleteRunResult = WithDualControlResult<{
  deletedRunDir: string;
  deletedArchiveRunDir?: string;
}>;

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
  const archiveDir = join(absoluteRoot, RUN_STORE_DIR, ARCHIVE_DIR);
  const archiveRunsDir = join(archiveDir, ARCHIVE_RUNS_DIR);
  const archiveRunDir = join(archiveRunsDir, safeRunId);

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
    sealPath: join(runDir, SEAL_FILE),
    readMostlyPath: join(runDir, READ_MOSTLY_FILE),
    retentionPath: join(runDir, RETENTION_FILE),
    legalHoldsPath: join(runDir, LEGAL_HOLDS_FILE),
    tombstonePath: join(runDir, TOMBSTONE_FILE),
    archiveDir,
    archiveRunsDir,
    archiveStageDir: join(archiveDir, ARCHIVE_STAGE_DIR),
    archiveRunDir,
    archiveManifestPath: join(archiveRunDir, ARCHIVE_MANIFEST_FILE),
    evalsDir: join(runDir, "evals"),
    summaryPath: join(runDir, SUMMARY_FILE)
  } satisfies RunStorePaths;
}

export function getArchivedRunStorePaths(
  rootDir: string | undefined,
  runId: string
) {
  const livePaths = getRunStorePaths(rootDir, runId);

  return runStorePathsForRunDir({
    rootDir: livePaths.rootDir,
    runsDir: livePaths.archiveRunsDir,
    runDir: livePaths.archiveRunDir,
    runId
  });
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

  if (await hasReadMostlyMarker(paths)) {
    throw new RunStoreError(
      "run_sealed",
      `Run ${runId} is sealed and refuses further event appends`
    );
  }

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

export async function sealRun(options: SealRunOptions): Promise<SealRunResult> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const existingSeal = await readSealRecord(paths, runId);

  if (existingSeal !== undefined) {
    const marker = await ensureReadMostlyMarker(paths, existingSeal);

    return {
      runId,
      record: existingSeal,
      marker,
      idempotent: true
    };
  }

  const state = await materializeRunState({
    rootDir: options.rootDir,
    runId
  });

  if (state.status !== "completed" && state.status !== "failed") {
    throw new RunStoreError(
      "not_terminal",
      `Run ${runId} cannot be sealed while status is ${state.status}`
    );
  }

  const integrity = verifiedIntegrityOrThrow(
    runId,
    await verifyRunIntegrity({
      rootDir: options.rootDir,
      runId
    })
  );
  const sealedAt = normalizeTimestamp(options.sealedAt);
  const record = parseSealRecord({
    recordVersion: SEAL_RECORD_VERSION,
    runId,
    sealedAt,
    sealedStatus: state.status,
    integrityHead: integrity.headHash,
    eventCount: integrity.eventCount,
    stateHash: hashStableJson(state),
    state
  });
  const marker = parseReadMostlyMarker({
    recordVersion: READ_MOSTLY_MARKER_VERSION,
    runId,
    sealedAt,
    sealRecordPath: paths.sealPath,
    integrityHead: integrity.headHash,
    readMostly: true
  });

  try {
    await writeJsonAtomic(paths.sealPath, record);
    await writeJsonAtomic(paths.readMostlyPath, marker);
    const administrationRecord = await appendLifecycleAdministrationRecord({
      rootDir: options.rootDir,
      tenantId: options.tenantId,
      runId,
      operation: "retention_seal",
      actor: options.actor ?? "run-store",
      recordId: options.recordId,
      timestamp: sealedAt,
      runScope: runScopeFromEventCount(runId, integrity.eventCount),
      profileOrDescriptor: {
        reason: "terminal run sealed"
      },
      integrityBefore: integritySnapshotFromVerdict(runId, integrity),
      integrityAfter: integritySnapshotFromVerdict(runId, integrity),
      result: {
        status: "success"
      }
    });

    return {
      runId,
      record,
      marker,
      administrationRecord,
      idempotent: false
    };
  } catch (error) {
    await Promise.all([
      rm(paths.sealPath, { force: true }),
      rm(paths.readMostlyPath, { force: true })
    ]);

    throw error;
  }
}

export async function computeRetentionState(
  options: ComputeRetentionStateOptions
): Promise<RetentionState> {
  const runId = assertSafeRunId(options.runId);
  const descriptor = parseRetentionDescriptor(options.descriptor);
  const paths = getRunStorePaths(options.rootDir, runId);
  const seal =
    (await readSealRecord(paths, runId)) ??
    (await readSealRecord(getArchivedRunStorePaths(options.rootDir, runId), runId));
  const activeLegalHolds = activeLegalHoldRecords(
    await readLegalHoldRecordsForRun({
      rootDir: options.rootDir,
      runId
    })
  );

  if (seal === undefined) {
    return {
      status: "unsealed",
      runId,
      activeLegalHolds
    };
  }

  const { archiveEligibleAt, expiresAt } = retentionTimestamps(
    seal,
    descriptor
  );

  if (activeLegalHolds.length > 0) {
    return {
      status: "held",
      runId,
      seal,
      archiveEligibleAt,
      expiresAt,
      activeLegalHolds
    };
  }

  const nowMs = Date.parse(normalizeTimestamp(options.now));

  if (nowMs >= Date.parse(expiresAt)) {
    return {
      status: "expired",
      runId,
      seal,
      archiveEligibleAt,
      expiresAt,
      activeLegalHolds: []
    };
  }

  if (nowMs >= Date.parse(archiveEligibleAt)) {
    return {
      status: "archive_eligible",
      runId,
      seal,
      archiveEligibleAt,
      expiresAt,
      activeLegalHolds: []
    };
  }

  return {
    status: "sealed",
    runId,
    seal,
    archiveEligibleAt,
    expiresAt,
    activeLegalHolds: []
  };
}

export async function placeLegalHold(
  options: PlaceLegalHoldOptions
): Promise<LegalHoldRecord> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const record = parseLegalHoldRecord({
    recordVersion: LEGAL_HOLD_RECORD_VERSION,
    holdId: options.holdId ?? randomUUID(),
    runId,
    placedAt: normalizeTimestamp(options.placedAt),
    placedBy: options.placedBy,
    reason: options.reason,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  });
  const runScope = await runScopeForRetentionRun({
    rootDir: options.rootDir,
    runId
  });

  await mkdir(paths.runDir, { recursive: true });
  await appendJsonLine(paths.legalHoldsPath, record);
  await appendLifecycleAdministrationRecord({
    rootDir: options.rootDir,
    tenantId: options.tenantId,
    runId,
    operation: "legal_hold_place",
    actor: options.placedBy,
    recordId: options.recordId,
    timestamp: record.placedAt,
    runScope,
    profileOrDescriptor: {
      reason: record.reason
    },
    result: {
      status: "success"
    }
  });

  return record;
}

export async function releaseLegalHold(
  options: ReleaseLegalHoldOptions
): Promise<LegalHoldRecord> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const activeHold = activeLegalHoldRecords(
    await readLegalHoldRecordsForRun({
      rootDir: options.rootDir,
      runId
    })
  ).find((record) => record.holdId === options.holdId);

  if (activeHold === undefined) {
    throw new RunStoreError(
      "invalid_projection",
      `No active legal hold ${options.holdId} exists for run ${runId}`
    );
  }

  const releasedAt = normalizeTimestamp(options.releasedAt);
  const record = parseLegalHoldRecord({
    ...activeHold,
    releasedAt,
    releasedBy: options.releasedBy,
    ...(options.releaseReason === undefined
      ? {}
      : { releaseReason: options.releaseReason })
  });
  const runScope = await runScopeForRetentionRun({
    rootDir: options.rootDir,
    runId
  });

  await appendJsonLine(paths.legalHoldsPath, record);
  await appendLifecycleAdministrationRecord({
    rootDir: options.rootDir,
    tenantId: options.tenantId,
    runId,
    operation: "legal_hold_release",
    actor: options.releasedBy,
    recordId: options.recordId,
    timestamp: releasedAt,
    runScope,
    profileOrDescriptor: {
      reason: record.releaseReason ?? `released ${record.holdId}`
    },
    result: {
      status: "success"
    }
  });

  return record;
}

export async function archiveRun(
  options: ArchiveRunOptions
): Promise<ArchiveRunResult> {
  const runId = assertSafeRunId(options.runId);
  const descriptor = parseRetentionDescriptor(options.descriptor);
  const activeHolds = activeLegalHoldRecords(
    await readLegalHoldRecordsForRun({
      rootDir: options.rootDir,
      runId
    })
  );
  const legalHold = legalHoldDeclaration(activeHolds);
  const runScope =
    options.runScope ??
    (await runScopeForRetentionRun({
      rootDir: options.rootDir,
      runId
    }));
  const archivedAt = normalizeTimestamp(options.archivedAt ?? options.now);

  return withDualControl({
    rootDir: options.rootDir,
    operation: "archive",
    actor: options.actor,
    runScope,
    profileOrDescriptor:
      options.profileOrDescriptor ?? descriptorToAdministrationProfile(descriptor),
    timestamp: archivedAt,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.approvalId === undefined
      ? {}
      : { approvalId: options.approvalId }),
    ...(legalHold === undefined ? {} : { legalHold }),
    ...(options.recordIds === undefined ? {} : { recordIds: options.recordIds }),
    ...(options.timestamps === undefined
      ? {}
      : { timestamps: options.timestamps }),
    execute: () =>
      executeArchiveRun({
        rootDir: options.rootDir,
        runId,
        descriptor,
        archivedAt,
        now: options.now ?? archivedAt
      })
  });
}

export async function restoreRun(
  options: RestoreRunOptions
): Promise<RestoreRunResult> {
  const runId = assertSafeRunId(options.runId);
  const livePaths = getRunStorePaths(options.rootDir, runId);
  const archivePaths = getArchivedRunStorePaths(options.rootDir, runId);
  const manifest = await readArchiveManifest(archivePaths, runId);
  const stageDir = join(
    livePaths.runsDir,
    `${runId}.restore.${randomUUID()}.tmp`
  );
  let liveBackupDir: string | undefined;

  try {
    await copyDirectoryRecursive(archivePaths.runDir, stageDir);
    const stagePaths = runStorePathsForRunDir({
      rootDir: livePaths.rootDir,
      runsDir: livePaths.runsDir,
      runDir: stageDir,
      runId
    });
    const stageManifest = await readArchiveManifest(stagePaths, runId);
    const seal = await requireSealRecord(stagePaths, runId);
    const integrity = verifiedIntegrityOrThrow(
      runId,
      await verifyRunIntegrityAtPaths(stagePaths, runId)
    );

    if (
      integrity.headHash !== manifest.integrityHead ||
      stageManifest.integrityHead !== manifest.integrityHead ||
      seal.integrityHead !== manifest.integrityHead
    ) {
      throw new RunStoreError(
        "integrity_broken",
        `Archived run ${runId} integrity head does not match its seal/manifest`
      );
    }

    const firstReplay = await rebuildStateForPackageAtPaths(stagePaths, runId);
    const secondReplay = await rebuildStateForPackageAtPaths(stagePaths, runId);

    if (stableJson(firstReplay) !== stableJson(secondReplay)) {
      throw new RunStoreError(
        "invalid_projection",
        `Archived run ${runId} replay is not deterministic`
      );
    }

    if (
      options.expectedState !== undefined &&
      stableJson(firstReplay) !== stableJson(options.expectedState)
    ) {
      throw new RunStoreError(
        "invalid_projection",
        `Archived run ${runId} replay does not match expected RunState`
      );
    }

    await rm(stagePaths.tombstonePath, { force: true });
    await writeProjection(stagePaths, firstReplay);
    liveBackupDir = await replaceLiveRunDirectory(livePaths, stageDir);
    await rm(liveBackupDir, { recursive: true, force: true });
    liveBackupDir = undefined;

    const restoredFirst = await materializeRunState({
      rootDir: options.rootDir,
      runId
    });
    const restoredSecond = await materializeRunState({
      rootDir: options.rootDir,
      runId
    });

    if (stableJson(restoredFirst) !== stableJson(restoredSecond)) {
      throw new RunStoreError(
        "invalid_projection",
        `Restored run ${runId} replay is not deterministic`
      );
    }

    const administrationRecord = await appendLifecycleAdministrationRecord({
      rootDir: options.rootDir,
      tenantId: options.tenantId,
      runId,
      operation: "restore",
      actor: options.actor ?? "run-store",
      recordId: options.recordId,
      timestamp: normalizeTimestamp(options.restoredAt),
      runScope: runScopeFromEventCount(runId, manifest.eventCount),
      profileOrDescriptor: {
        archiveTarget: manifest.archiveRunDir,
        reason: "restored archived run package"
      },
      integrityBefore: integritySnapshotFromVerdict(runId, integrity),
      integrityAfter: integritySnapshotFromVerdict(
        runId,
        verifiedIntegrityOrThrow(
          runId,
          await verifyRunIntegrity({
            rootDir: options.rootDir,
            runId
          })
        )
      ),
      result: {
        status: "success"
      }
    });

    return {
      runId,
      restoredRunDir: livePaths.runDir,
      manifest,
      state: restoredFirst,
      deterministicReplayHash: hashStableJson(restoredFirst),
      administrationRecord
    };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });

    if (liveBackupDir !== undefined) {
      await restoreLiveRunDirectory(livePaths, liveBackupDir);
    }

    throw error;
  }
}

export async function hardDeleteRun(
  options: HardDeleteRunOptions
): Promise<HardDeleteRunResult> {
  const runId = assertSafeRunId(options.runId);
  const descriptor = parseRetentionDescriptor(options.descriptor);
  const livePaths = getRunStorePaths(options.rootDir, runId);
  const activeHolds = activeLegalHoldRecords(
    await readLegalHoldRecordsForRun({
      rootDir: options.rootDir,
      runId
    })
  );
  const legalHold = legalHoldDeclaration(activeHolds);
  const runScope =
    options.runScope ??
    (await runScopeForRetentionRun({
      rootDir: options.rootDir,
      runId
    }));

  return withDualControl({
    rootDir: options.rootDir,
    operation: "hard_delete",
    actor: options.actor,
    runScope,
    profileOrDescriptor:
      options.profileOrDescriptor ?? descriptorToAdministrationProfile(descriptor),
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.approvalId === undefined
      ? {}
      : { approvalId: options.approvalId }),
    ...(legalHold === undefined ? {} : { legalHold }),
    ...(options.recordIds === undefined ? {} : { recordIds: options.recordIds }),
    ...(options.timestamps === undefined
      ? {}
      : { timestamps: options.timestamps }),
    execute: async () => {
      const retention = await computeRetentionState({
        rootDir: options.rootDir,
        runId,
        descriptor,
        now: options.now
      });

      if (retention.status === "held") {
        throw new RunStoreError(
          "legal_hold_active",
          `Active legal hold blocks hard delete for run ${runId}`
        );
      }

      if (retention.status !== "expired") {
        throw new RunStoreError(
          "retention_not_expired",
          `Run ${runId} is not expired for retention class ${descriptor.retentionClass}`
        );
      }

      await rm(livePaths.runDir, { recursive: true, force: true });
      await rm(livePaths.archiveRunDir, { recursive: true, force: true });

      return {
        deletedRunDir: livePaths.runDir,
        deletedArchiveRunDir: livePaths.archiveRunDir
      };
    }
  });
}

function runStorePathsForRunDir(input: {
  rootDir: string;
  runsDir: string;
  runDir: string;
  runId: string;
}): RunStorePaths {
  const safeRunId = assertSafeRunId(input.runId);
  const archiveDir = join(input.rootDir, RUN_STORE_DIR, ARCHIVE_DIR);
  const archiveRunsDir = join(archiveDir, ARCHIVE_RUNS_DIR);
  const archiveRunDir = join(archiveRunsDir, safeRunId);

  return {
    rootDir: input.rootDir,
    runsDir: input.runsDir,
    runDir: input.runDir,
    eventsPath: join(input.runDir, EVENTS_FILE),
    statePath: join(input.runDir, STATE_FILE),
    tracePath: join(input.runDir, TRACE_FILE),
    decisionsPath: join(input.runDir, DECISIONS_FILE),
    artifactsDir: join(input.runDir, "artifacts"),
    evidenceDir: join(input.runDir, "evidence"),
    cacheDir: join(input.runDir, "cache"),
    checkpointPath: join(input.runDir, "cache", CHECKPOINT_FILE),
    versionPath: join(input.runDir, RUN_PACKAGE_VERSION_FILE),
    migrationsPath: join(input.runDir, MIGRATIONS_FILE),
    sealPath: join(input.runDir, SEAL_FILE),
    readMostlyPath: join(input.runDir, READ_MOSTLY_FILE),
    retentionPath: join(input.runDir, RETENTION_FILE),
    legalHoldsPath: join(input.runDir, LEGAL_HOLDS_FILE),
    tombstonePath: join(input.runDir, TOMBSTONE_FILE),
    archiveDir,
    archiveRunsDir,
    archiveStageDir: join(archiveDir, ARCHIVE_STAGE_DIR),
    archiveRunDir,
    archiveManifestPath: join(input.runDir, ARCHIVE_MANIFEST_FILE),
    evalsDir: join(input.runDir, "evals"),
    summaryPath: join(input.runDir, SUMMARY_FILE)
  };
}

async function hasReadMostlyMarker(paths: RunStorePaths) {
  try {
    await readFile(paths.readMostlyPath, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function ensureReadMostlyMarker(
  paths: RunStorePaths,
  seal: SealRecord
) {
  const existing = await readReadMostlyMarker(paths);

  if (existing !== undefined) {
    return existing;
  }

  const marker = parseReadMostlyMarker({
    recordVersion: READ_MOSTLY_MARKER_VERSION,
    runId: seal.runId,
    sealedAt: seal.sealedAt,
    sealRecordPath: paths.sealPath,
    integrityHead: seal.integrityHead,
    readMostly: true
  });

  await writeJsonAtomic(paths.readMostlyPath, marker);

  return marker;
}

async function readReadMostlyMarker(paths: RunStorePaths) {
  const raw = await readOptionalFile(paths.readMostlyPath);

  if (raw === undefined) {
    return undefined;
  }

  return parseReadMostlyMarker(parseJsonSidecar(raw, paths.readMostlyPath));
}

async function readSealRecord(paths: RunStorePaths, runId: string) {
  const raw = await readOptionalFile(paths.sealPath);

  if (raw === undefined) {
    return undefined;
  }

  const record = parseSealRecord(parseJsonSidecar(raw, paths.sealPath));

  if (record.runId !== runId) {
    throw new RunStoreError(
      "invalid_projection",
      `Seal record at ${paths.sealPath} belongs to ${record.runId}, expected ${runId}`
    );
  }

  return record;
}

async function requireSealRecord(paths: RunStorePaths, runId: string) {
  const record = await readSealRecord(paths, runId);

  if (record === undefined) {
    throw new RunStoreError(
      "invalid_projection",
      `Run ${runId} has no seal record at ${paths.sealPath}`
    );
  }

  return record;
}

function parseSealRecord(value: unknown) {
  const parsed = SealRecordSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Seal record does not match run-store retention schema",
      parsed.error
    );
  }

  return parsed.data;
}

function parseReadMostlyMarker(value: unknown) {
  const parsed = ReadMostlyMarkerSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Read-mostly marker does not match run-store retention schema",
      parsed.error
    );
  }

  return parsed.data;
}

function parseRetentionDescriptor(value: unknown) {
  const parsed = RetentionDescriptorSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Retention descriptor does not match run-store retention schema",
      parsed.error
    );
  }

  return parsed.data;
}

function parseLegalHoldRecord(value: unknown) {
  const parsed = LegalHoldRecordSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Legal-hold record does not match run-store retention schema",
      parsed.error
    );
  }

  return parsed.data;
}

function parseArchiveManifest(value: unknown) {
  const parsed = ArchiveManifestSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Archive manifest does not match run-store retention schema",
      parsed.error
    );
  }

  return parsed.data;
}

function parseTombstone(value: unknown) {
  const parsed = TombstoneSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Archive tombstone does not match run-store retention schema",
      parsed.error
    );
  }

  return parsed.data;
}

async function readArchiveManifest(paths: RunStorePaths, runId: string) {
  const raw = await readOptionalFile(paths.archiveManifestPath);

  if (raw === undefined) {
    throw new RunStoreError(
      "missing_events",
      `Missing archive manifest for run ${runId}`
    );
  }

  const manifest = parseArchiveManifest(
    parseJsonSidecar(raw, paths.archiveManifestPath)
  );

  if (manifest.runId !== runId) {
    throw new RunStoreError(
      "invalid_projection",
      `Archive manifest belongs to ${manifest.runId}, expected ${runId}`
    );
  }

  return manifest;
}

async function readTombstone(paths: RunStorePaths, runId: string) {
  const raw = await readOptionalFile(paths.tombstonePath);

  if (raw === undefined) {
    return undefined;
  }

  const tombstone = parseTombstone(parseJsonSidecar(raw, paths.tombstonePath));

  if (tombstone.runId !== runId) {
    throw new RunStoreError(
      "invalid_projection",
      `Archive tombstone belongs to ${tombstone.runId}, expected ${runId}`
    );
  }

  return tombstone;
}

async function readLegalHoldRecordsForRun(options: {
  rootDir?: string | undefined;
  runId: string;
}) {
  const runId = assertSafeRunId(options.runId);
  const livePaths = getRunStorePaths(options.rootDir, runId);
  const archivePaths = getArchivedRunStorePaths(options.rootDir, runId);
  const [liveRecords, archivedRecords] = await Promise.all([
    readLegalHoldRecordLog(livePaths.legalHoldsPath, runId),
    readLegalHoldRecordLog(archivePaths.legalHoldsPath, runId)
  ]);
  const seen = new Set<string>();
  const records: LegalHoldRecord[] = [];

  for (const record of [...archivedRecords, ...liveRecords]) {
    const key = `${record.holdId}:${record.placedAt}:${
      record.releasedAt ?? "active"
    }`;

    if (!seen.has(key)) {
      seen.add(key);
      records.push(record);
    }
  }

  return records;
}

async function readLegalHoldRecordLog(path: string, expectedRunId: string) {
  const raw = await readOptionalFile(path);

  if (raw === undefined || raw.length === 0) {
    return [];
  }

  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((line, index) => {
    if (line.trim() === "") {
      throw new RunStoreError(
        "invalid_projection",
        `Blank legal-hold record at line ${index + 1}`
      );
    }

    const record = parseLegalHoldRecord(parseJsonSidecar(line, path));

    if (record.runId !== expectedRunId) {
      throw new RunStoreError(
        "invalid_projection",
        `Legal-hold record at line ${index + 1} belongs to ${record.runId}, expected ${expectedRunId}`
      );
    }

    return record;
  });
}

function activeLegalHoldRecords(records: readonly LegalHoldRecord[]) {
  const latestByHold = new Map<string, LegalHoldRecord>();

  for (const record of records) {
    const prior = latestByHold.get(record.holdId);

    if (
      prior === undefined ||
      Date.parse(record.releasedAt ?? record.placedAt) >=
        Date.parse(prior.releasedAt ?? prior.placedAt)
    ) {
      latestByHold.set(record.holdId, record);
    }
  }

  return [...latestByHold.values()]
    .filter((record) => record.releasedAt === undefined)
    .sort((left, right) => left.holdId.localeCompare(right.holdId));
}

function legalHoldDeclaration(
  activeHolds: readonly LegalHoldRecord[]
): LegalHoldDeclaration | undefined {
  if (activeHolds.length === 0) {
    return undefined;
  }

  return {
    active: true,
    reason: activeHolds.map((hold) => hold.reason).join("; "),
    runIds: [...new Set(activeHolds.map((hold) => hold.runId))].sort()
  };
}

function retentionTimestamps(
  seal: SealRecord,
  descriptor: RetentionDescriptor
) {
  const sealedAtMs = Date.parse(seal.sealedAt);
  const archiveEligibleAt =
    descriptor.archiveEligibleAt ??
    new Date(sealedAtMs + (descriptor.archiveAfterMs ?? 0)).toISOString();
  const expiresAt =
    descriptor.expiresAt ??
    new Date(sealedAtMs + (descriptor.expireAfterMs ?? 0)).toISOString();

  if (Date.parse(expiresAt) < Date.parse(archiveEligibleAt)) {
    throw new RunStoreError(
      "invalid_projection",
      "Retention descriptor expiry precedes archive eligibility"
    );
  }

  return {
    archiveEligibleAt,
    expiresAt
  };
}

function verifiedIntegrityOrThrow(
  runId: string,
  verdict: RunIntegrityVerdict
): Extract<RunIntegrityVerdict, { status: "verified" }> {
  if (verdict.status === "verified") {
    return verdict;
  }

  if (verdict.status === "broken") {
    throw integrityBrokenError(runId, verdict);
  }

  throw new RunStoreError(
    "integrity_broken",
    `Run ${runId} must carry a verified integrity chain`
  );
}

function integritySnapshotFromVerdict(
  runId: string,
  verdict: RunIntegrityVerdict
) {
  if (verdict.status === "verified") {
    return {
      runHeads: [
        {
          runId,
          status: "verified" as const,
          eventCount: verdict.eventCount,
          headHash: verdict.headHash
        }
      ]
    };
  }

  if (verdict.status === "unchained") {
    return {
      runHeads: [
        {
          runId,
          status: "unchained" as const,
          eventCount: verdict.eventCount
        }
      ]
    };
  }

  return {
    runHeads: [
      {
        runId,
        status: "broken" as const,
        eventCount: verdict.eventCount,
        brokenAtSequence: verdict.brokenAtSequence,
        code: verdict.code,
        detail: verdict.detail
      }
    ]
  };
}

function runScopeFromEventCount(
  runId: string,
  eventCount: number
): AdministrationRunScope {
  return {
    runIds: [runId],
    eventRange: {
      startSequence: 0,
      endSequence: Math.max(0, eventCount - 1)
    }
  };
}

async function runScopeForRetentionRun(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<AdministrationRunScope> {
  const runId = assertSafeRunId(options.runId);
  const livePaths = getRunStorePaths(options.rootDir, runId);
  const archivePaths = getArchivedRunStorePaths(options.rootDir, runId);
  const liveSeal = await readSealRecord(livePaths, runId);

  if (liveSeal !== undefined) {
    return runScopeFromEventCount(runId, liveSeal.eventCount);
  }

  const tombstone = await readTombstone(livePaths, runId);

  if (tombstone !== undefined) {
    return runScopeFromEventCount(runId, tombstone.eventCount);
  }

  const archivedSeal = await readSealRecord(archivePaths, runId);

  if (archivedSeal !== undefined) {
    return runScopeFromEventCount(runId, archivedSeal.eventCount);
  }

  return runScopeForRun({
    rootDir: options.rootDir,
    runId
  });
}

async function appendLifecycleAdministrationRecord(options: {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  runId: string;
  operation: AdministrationRecord["operation"];
  actor: string;
  recordId?: string | undefined;
  timestamp: string;
  runScope: AdministrationRunScope;
  profileOrDescriptor?: AdministrationProfileOrDescriptor | undefined;
  integrityBefore?: AdministrationRecord["integrityBefore"];
  integrityAfter?: AdministrationRecord["integrityAfter"];
  result: AdministrationRecord["result"];
}) {
  const recordId = options.recordId ?? randomUUID();

  return appendAdministrationRecord({
    rootDir: options.rootDir,
    tenantId: options.tenantId,
    record: {
      recordId,
      recordKind: options.result.status === "failure" ? "denial" : "post_operation",
      operation: options.operation,
      actor: options.actor,
      approvalRef: {
        approvalId: `not-gated:${options.operation}:${recordId}`,
        requestedBy: options.actor,
        approvedBy: "run-store-administration",
        decision: "approved"
      },
      runScope: options.runScope,
      ...(options.profileOrDescriptor === undefined
        ? {}
        : { profileOrDescriptor: options.profileOrDescriptor }),
      ...(options.integrityBefore === undefined
        ? {}
        : { integrityBefore: options.integrityBefore }),
      ...(options.integrityAfter === undefined
        ? {}
        : { integrityAfter: options.integrityAfter }),
      result: options.result,
      timestamp: options.timestamp
    }
  });
}

function descriptorToAdministrationProfile(
  descriptor: RetentionDescriptor
): AdministrationProfileOrDescriptor {
  return {
    ...(descriptor.descriptorId === undefined
      ? {}
      : { descriptorId: descriptor.descriptorId }),
    retentionClass: descriptor.retentionClass,
    metadata: {
      archiveAfterMs: descriptor.archiveAfterMs ?? null,
      archiveEligibleAt: descriptor.archiveEligibleAt ?? null,
      expireAfterMs: descriptor.expireAfterMs ?? null,
      expiresAt: descriptor.expiresAt ?? null,
      ...(descriptor.metadata === undefined ? {} : descriptor.metadata)
    }
  };
}

async function verifyRunIntegrityAtPaths(
  paths: RunStorePaths,
  runId: string
) {
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

async function rebuildStateForPackageAtPaths(
  paths: RunStorePaths,
  runId: string
) {
  await assertReadablePackageVersion(paths);
  const raw = await readRequiredFile(
    paths.eventsPath,
    "missing_events",
    `Missing event log for run ${runId}`
  );
  const events = parseEventLog(raw, runId);
  const integrity = verifyRawEventLogIntegrity(raw, runId);

  if (integrity.status === "broken") {
    throw integrityBrokenError(runId, integrity);
  }

  return (
    await rebuildStateForPackage({
      paths,
      runId,
      events,
      integrity
    })
  ).state;
}

async function executeArchiveRun(input: {
  rootDir?: string | undefined;
  runId: string;
  descriptor: RetentionDescriptor;
  archivedAt: string;
  now: Date | string;
}) {
  const livePaths = getRunStorePaths(input.rootDir, input.runId);
  const archivePaths = getArchivedRunStorePaths(input.rootDir, input.runId);
  const stageDir = join(
    livePaths.archiveStageDir,
    `${input.runId}.${randomUUID()}.tmp`
  );
  const stagePaths = runStorePathsForRunDir({
    rootDir: livePaths.rootDir,
    runsDir: livePaths.archiveRunsDir,
    runDir: stageDir,
    runId: input.runId
  });
  let archiveCommitted = false;
  let liveBackupDir: string | undefined;

  try {
    const retention = await computeRetentionState({
      rootDir: input.rootDir,
      runId: input.runId,
      descriptor: input.descriptor,
      now: input.now
    });

    if (retention.status === "held") {
      throw new RunStoreError(
        "legal_hold_active",
        `Active legal hold blocks archive for run ${input.runId}`
      );
    }

    if (
      retention.status !== "archive_eligible" &&
      retention.status !== "expired"
    ) {
      throw new RunStoreError(
        "retention_not_expired",
        `Run ${input.runId} is not archive-eligible for retention class ${input.descriptor.retentionClass}`
      );
    }

    if ((await readOptionalFile(archivePaths.archiveManifestPath)) !== undefined) {
      throw new RunStoreError(
        "run_exists",
        `Archive package already exists for run ${input.runId}`
      );
    }

    const seal = await requireSealRecord(livePaths, input.runId);
    const liveIntegrity = verifiedIntegrityOrThrow(
      input.runId,
      await verifyRunIntegrity({
        rootDir: input.rootDir,
        runId: input.runId
      })
    );

    if (liveIntegrity.headHash !== seal.integrityHead) {
      throw new RunStoreError(
        "integrity_broken",
        `Run ${input.runId} integrity head no longer matches the seal record`
      );
    }

    const liveState = await materializeRunState({
      rootDir: input.rootDir,
      runId: input.runId
    });

    if (stableJson(liveState) !== stableJson(seal.state)) {
      throw new RunStoreError(
        "invalid_projection",
        `Run ${input.runId} projection no longer matches its sealed state`
      );
    }

    const sourceEvents = await readFile(livePaths.eventsPath, "utf8");
    const sourceState = await readFile(livePaths.statePath, "utf8");
    const eventsHashBefore = hashRawBytes(sourceEvents);
    const stateHash = hashRawBytes(sourceState);

    await mkdir(livePaths.archiveStageDir, { recursive: true });
    await copyDirectoryRecursive(livePaths.runDir, stageDir);

    const manifest = parseArchiveManifest({
      manifestVersion: ARCHIVE_MANIFEST_VERSION,
      runId: input.runId,
      archivedAt: input.archivedAt,
      sealedAt: seal.sealedAt,
      sealedStatus: seal.sealedStatus,
      integrityHead: seal.integrityHead,
      eventCount: seal.eventCount,
      eventsHash: eventsHashBefore,
      stateHash,
      sourceRunDir: livePaths.runDir,
      archiveRunDir: archivePaths.runDir,
      archiveManifestPath: archivePaths.archiveManifestPath,
      tombstonePath: livePaths.tombstonePath,
      retentionDescriptor: input.descriptor
    });
    const tombstone = parseTombstone({
      tombstoneVersion: TOMBSTONE_VERSION,
      runId: input.runId,
      archivedAt: input.archivedAt,
      archiveRunDir: archivePaths.runDir,
      archiveManifestPath: archivePaths.archiveManifestPath,
      integrityHead: seal.integrityHead,
      eventCount: seal.eventCount,
      sealedAt: seal.sealedAt,
      retentionClass: input.descriptor.retentionClass
    });

    await writeJsonAtomic(stagePaths.archiveManifestPath, manifest);

    const stagedIntegrity = verifiedIntegrityOrThrow(
      input.runId,
      await verifyRunIntegrityAtPaths(stagePaths, input.runId)
    );

    if (stagedIntegrity.headHash !== seal.integrityHead) {
      throw new RunStoreError(
        "integrity_broken",
        `Staged archive for run ${input.runId} does not match the seal integrity head`
      );
    }

    const stagedFirstReplay = await rebuildStateForPackageAtPaths(
      stagePaths,
      input.runId
    );
    const stagedSecondReplay = await rebuildStateForPackageAtPaths(
      stagePaths,
      input.runId
    );

    if (
      stableJson(stagedFirstReplay) !== stableJson(stagedSecondReplay) ||
      stableJson(stagedFirstReplay) !== stableJson(seal.state)
    ) {
      throw new RunStoreError(
        "invalid_projection",
        `Staged archive for run ${input.runId} does not replay to the sealed state`
      );
    }

    const archivedEvents = await readFile(stagePaths.eventsPath, "utf8");
    const eventsHashAfter = hashRawBytes(archivedEvents);

    if (sourceEvents !== archivedEvents || eventsHashAfter !== eventsHashBefore) {
      throw new RunStoreError(
        "integrity_broken",
        `Staged archive for run ${input.runId} changed events.jsonl bytes`
      );
    }

    await mkdir(livePaths.archiveRunsDir, { recursive: true });
    await rename(stageDir, archivePaths.runDir);
    archiveCommitted = true;
    liveBackupDir = await replaceLiveWithTombstone(livePaths, tombstone);
    await rm(liveBackupDir, { recursive: true, force: true });
    liveBackupDir = undefined;

    return {
      runId: input.runId,
      archiveRunDir: archivePaths.runDir,
      tombstonePath: livePaths.tombstonePath,
      manifest,
      tombstone,
      eventsHashBefore,
      eventsHashAfter
    };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });

    if (liveBackupDir !== undefined) {
      await restoreLiveRunDirectory(livePaths, liveBackupDir);
    }

    if (archiveCommitted) {
      await rm(archivePaths.runDir, { recursive: true, force: true });
    }

    throw error;
  }
}

async function replaceLiveWithTombstone(
  paths: RunStorePaths,
  tombstone: Tombstone
) {
  const tempDir = join(paths.runsDir, `${tombstone.runId}.tombstone.${randomUUID()}.tmp`);
  const backupDir = join(paths.runsDir, `${tombstone.runId}.live.${randomUUID()}.bak`);

  await mkdir(paths.runsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await writeJsonAtomic(join(tempDir, TOMBSTONE_FILE), tombstone);
  await rename(paths.runDir, backupDir);

  try {
    await rename(tempDir, paths.runDir);
  } catch (error) {
    await rename(backupDir, paths.runDir);
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return backupDir;
}

async function replaceLiveRunDirectory(paths: RunStorePaths, stageDir: string) {
  const backupDir = join(paths.runsDir, `${assertSafeRunIdFromPath(paths.runDir)}.restore.${randomUUID()}.bak`);

  await mkdir(paths.runsDir, { recursive: true });

  try {
    await rename(paths.runDir, backupDir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }

    await rename(stageDir, paths.runDir);
    return backupDir;
  }

  try {
    await rename(stageDir, paths.runDir);
  } catch (error) {
    await rename(backupDir, paths.runDir);
    throw error;
  }

  return backupDir;
}

async function restoreLiveRunDirectory(
  paths: RunStorePaths,
  backupDir: string
) {
  await rm(paths.runDir, { recursive: true, force: true });

  try {
    await rename(backupDir, paths.runDir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function copyDirectoryRecursive(sourceDir: string, targetDir: string) {
  await mkdir(targetDir, { recursive: true });

  for (const entry of await readdir(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const stats = await lstat(sourcePath);

    if (stats.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }

    if (stats.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

function assertSafeRunIdFromPath(path: string) {
  return assertSafeRunId(path.split(/[/\\]/).at(-1) ?? "");
}

function parseJsonSidecar(raw: string, path: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RunStoreError(
      "invalid_projection",
      `Sidecar at ${path} is not valid JSON`,
      error
    );
  }
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
