import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateRunReport, RUN_REPORTS_VERSION } from "@specwright/run-reports";
import {
  RUN_STORE_DIR,
  materializeRunState,
  readEvents
} from "@specwright/run-store";
import { z } from "zod";
import {
  type CompatibilityChangeDescriptor,
  CompatibilityChangeDescriptorSchema,
  CompatibilityClassSchema,
  classifyCompatibility,
  isCompatibilityClassPromotable,
  type CompatibilityClass
} from "./compatibility";
import {
  appendOperationAuditRecord,
  buildOperationAuditRecord,
  hashOperationCanonical,
  stableOperationJson,
  type OperationAuditRecord
} from "./audit";
import {
  TenantScopeSchema,
  type TenantScope
} from "./tenancy";

export const OPERATIONS_RELEASE_STATE_VERSION = 1;
export const OPERATIONS_RELEASE_DIR = "ops-releases";

const nonEmptyString = z.string().min(1);
const tenantId = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/);
const isoTimestamp = z.string().datetime({ offset: true });
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const ReleaseApprovalSchema = z
  .object({
    approvalId: nonEmptyString,
    principal: nonEmptyString,
    approvedAt: isoTimestamp,
    decision: z.enum(["approved", "rejected"]).default("approved"),
    expiresAt: isoTimestamp.optional()
  })
  .strict()
  .superRefine((approval, context) => {
    if (
      approval.expiresAt !== undefined &&
      Date.parse(approval.expiresAt) < Date.parse(approval.approvedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "approval expiresAt must be >= approvedAt"
      });
    }
  });

export const HistoricalReplayFixtureSchema = z
  .object({
    fixtureId: nonEmptyString,
    rootDir: nonEmptyString,
    runId: nonEmptyString,
    recordedVersion: semver,
    allowedMissingInputs: z.array(nonEmptyString).optional()
  })
  .strict();

export const EvaluateReleaseOptionsSchema = z
  .object({
    rootDir: nonEmptyString.optional(),
    releaseId: nonEmptyString,
    candidateVersion: semver,
    deployedVersion: semver,
    targetTenant: TenantScopeSchema,
    tenantTier: z.enum(["development", "staging", "production"]),
    changes: z.array(CompatibilityChangeDescriptorSchema),
    fixtures: z.array(HistoricalReplayFixtureSchema).min(1),
    requestedAt: isoTimestamp
  })
  .strict();

export const ReleaseStateSchema = z
  .object({
    recordVersion: z.literal(OPERATIONS_RELEASE_STATE_VERSION),
    tenant: tenantId,
    deploymentMode: TenantScopeSchema.shape.deploymentMode,
    releaseId: nonEmptyString,
    deployedVersion: semver,
    previousVersion: semver.optional(),
    compatibilityClass: CompatibilityClassSchema,
    promotedAt: isoTimestamp,
    actor: nonEmptyString,
    approvalId: nonEmptyString.optional(),
    decisionHash: nonEmptyString,
    rollbackOf: semver.optional()
  })
  .strict();

export const ReplayFixtureResultSchema = z
  .object({
    fixtureId: nonEmptyString,
    runId: nonEmptyString,
    recordedVersion: semver,
    candidateVersion: semver,
    status: z.enum(["passed", "failed"]),
    eventCount: z.number().int().nonnegative(),
    stateStatus: nonEmptyString.optional(),
    reportVersion: nonEmptyString,
    reconciliationVerdict: z.enum(["consistent", "gap", "mismatch"]).optional(),
    missingInputs: z.array(nonEmptyString),
    failureReason: nonEmptyString.optional()
  })
  .strict();

export const ReleaseVerdictSchema = z
  .object({
    releaseId: nonEmptyString,
    targetTenant: TenantScopeSchema,
    tenantTier: z.enum(["development", "staging", "production"]),
    deployedVersion: semver,
    candidateVersion: semver,
    compatibilityClass: CompatibilityClassSchema,
    status: z.enum(["promotable", "blocked"]),
    blockReasons: z.array(nonEmptyString),
    replayResults: z.array(ReplayFixtureResultSchema),
    decisionHash: nonEmptyString,
    requestedAt: isoTimestamp
  })
  .strict();

export type ReleaseApproval = z.infer<typeof ReleaseApprovalSchema>;
export type HistoricalReplayFixture = z.infer<typeof HistoricalReplayFixtureSchema>;
export type EvaluateReleaseOptions = z.infer<typeof EvaluateReleaseOptionsSchema>;
export type ReleaseState = z.infer<typeof ReleaseStateSchema>;
export type ReplayFixtureResult = z.infer<typeof ReplayFixtureResultSchema>;
export type ReleaseVerdict = z.infer<typeof ReleaseVerdictSchema>;

export type ReleaseErrorCode =
  | "invalid_release_request"
  | "incompatible_release"
  | "replay_failed"
  | "approval_required";

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  readonly auditRecords: OperationAuditRecord[];

  constructor(
    code: ReleaseErrorCode,
    message: string,
    auditRecords: OperationAuditRecord[] = [],
    cause?: unknown
  ) {
    super(message);
    this.name = "ReleaseError";
    this.code = code;
    this.auditRecords = auditRecords;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type PromoteReleaseOptions = {
  rootDir?: string | undefined;
  verdict: ReleaseVerdict;
  actor: string;
  approval?: ReleaseApproval | undefined;
  promotedAt: Date | string;
};

export type RollbackReleaseOptions = {
  rootDir?: string | undefined;
  targetTenant: TenantScope;
  toVersion: string;
  actor: string;
  approval?: ReleaseApproval | undefined;
  rolledBackAt: Date | string;
  reason: string;
  releaseId?: string | undefined;
};

const DEFAULT_ALLOWED_MISSING_INPUTS_BY_VERSION: Record<string, string[]> = {
  "0.1.0": ["artifacts/index.jsonl", "evidence/index.jsonl", "evals/*.json"]
};

export async function evaluateRelease(
  options: EvaluateReleaseOptions
): Promise<ReleaseVerdict> {
  const parsed = EvaluateReleaseOptionsSchema.parse(options);
  const compatibility = classifyCompatibility({
    candidateVersion: parsed.candidateVersion,
    deployedVersion: parsed.deployedVersion,
    changes: parsed.changes
  });
  const replayResults: ReplayFixtureResult[] = [];

  for (const fixture of parsed.fixtures) {
    replayResults.push(
      await runHistoricalReplayFixture({
        fixture,
        candidateVersion: parsed.candidateVersion,
        targetTenant: parsed.targetTenant
      })
    );
  }

  const blockReasons = [
    ...(!isCompatibilityClassPromotable(compatibility.compatibilityClass)
      ? [`incompatible:${compatibility.compatibilityClass}`]
      : []),
    ...replayResults
      .filter((result) => result.status === "failed")
      .map((result) => `replay_failed:${result.fixtureId}`)
  ];
  const status = blockReasons.length === 0 ? "promotable" : "blocked";
  const hashBody = {
    releaseId: parsed.releaseId,
    targetTenant: parsed.targetTenant.tenantId,
    tenantTier: parsed.tenantTier,
    deployedVersion: parsed.deployedVersion,
    candidateVersion: parsed.candidateVersion,
    compatibilityClass: compatibility.compatibilityClass,
    changes: stableChanges(parsed.changes),
    replayResults: stableReplayResults(replayResults),
    blockReasons
  };

  return ReleaseVerdictSchema.parse({
    releaseId: parsed.releaseId,
    targetTenant: parsed.targetTenant,
    tenantTier: parsed.tenantTier,
    deployedVersion: parsed.deployedVersion,
    candidateVersion: parsed.candidateVersion,
    compatibilityClass: compatibility.compatibilityClass,
    status,
    blockReasons,
    replayResults: stableReplayResults(replayResults),
    decisionHash: hashOperationCanonical(hashBody),
    requestedAt: parsed.requestedAt
  });
}

export async function runHistoricalReplayFixture(options: {
  fixture: HistoricalReplayFixture;
  candidateVersion: string;
  targetTenant: TenantScope;
}): Promise<ReplayFixtureResult> {
  const fixture = HistoricalReplayFixtureSchema.parse(options.fixture);

  try {
    const events = await readEvents({
      rootDir: fixture.rootDir,
      runId: fixture.runId
    });
    const state = await materializeRunState({
      rootDir: fixture.rootDir,
      runId: fixture.runId
    });
    const report = await generateRunReport({
      rootDir: fixture.rootDir,
      runId: fixture.runId,
      tenantScope: options.targetTenant.tenantId
    });
    const allowedMissingInputs =
      fixture.allowedMissingInputs ??
      DEFAULT_ALLOWED_MISSING_INPUTS_BY_VERSION[fixture.recordedVersion] ??
      [];
    const unexpectedMissingInputs = report.missingInputs.filter(
      (input: string) => !allowedMissingInputs.includes(input)
    );
    const reconciliationVerdict = report.reconciliation?.verdict;
    const passed =
      reconciliationVerdict === "consistent" &&
      unexpectedMissingInputs.length === 0;

    return {
      fixtureId: fixture.fixtureId,
      runId: fixture.runId,
      recordedVersion: fixture.recordedVersion,
      candidateVersion: options.candidateVersion,
      status: passed ? "passed" : "failed",
      eventCount: events.length,
      stateStatus: state.status,
      reportVersion: RUN_REPORTS_VERSION,
      reconciliationVerdict,
      missingInputs: [...report.missingInputs].sort(),
      ...(passed
        ? {}
        : {
            failureReason: [
              reconciliationVerdict === "consistent"
                ? undefined
                : `reconciliation:${reconciliationVerdict ?? "missing"}`,
              unexpectedMissingInputs.length === 0
                ? undefined
                : `missing:${unexpectedMissingInputs.join(",")}`
            ]
              .filter(Boolean)
              .join(";")
          })
    };
  } catch (error) {
    return {
      fixtureId: fixture.fixtureId,
      runId: fixture.runId,
      recordedVersion: fixture.recordedVersion,
      candidateVersion: options.candidateVersion,
      status: "failed",
      eventCount: 0,
      reportVersion: RUN_REPORTS_VERSION,
      missingInputs: [],
      failureReason: error instanceof Error ? error.message : "unknown replay error"
    };
  }
}

export async function promoteRelease(
  options: PromoteReleaseOptions
): Promise<ReleaseState> {
  const timestamp = toIso(options.promotedAt);
  const verdict = ReleaseVerdictSchema.parse(options.verdict);
  const tenant = verdict.targetTenant.tenantId;
  const hardBlockReasons = hardReleaseBlockReasons(verdict);

  if (hardBlockReasons.length > 0) {
    const audit = releaseAuditRecord({
      action: "release_promotion_rejected",
      outcome: "blocked",
      tenant,
      actor: options.actor,
      timestamp,
      reasonCode: hardBlockReasons.some((reason) =>
        reason.startsWith("replay_failed:")
      )
        ? "replay_failed"
        : "incompatible_release",
      verdict: {
        ...verdict,
        status: "blocked",
        blockReasons: hardBlockReasons
      }
    });

    await appendOperationAuditRecord({
      rootDir: options.rootDir,
      record: audit
    });

    throw new ReleaseError(
      audit.reasonCode === "replay_failed"
        ? "replay_failed"
        : "incompatible_release",
      "Blocked release verdict cannot be promoted",
      [audit]
    );
  }

  if (
    verdict.tenantTier === "production" &&
    !isActiveApproval(options.approval, timestamp)
  ) {
    const audit = releaseAuditRecord({
      action: "release_promotion_rejected",
      outcome: "denied",
      tenant,
      actor: options.actor,
      timestamp,
      reasonCode: "approval_required",
      verdict
    });

    await appendOperationAuditRecord({
      rootDir: options.rootDir,
      record: audit
    });

    throw new ReleaseError(
      "approval_required",
      "Production release promotion requires an active approval",
      [audit]
    );
  }

  const approval = options.approval;
  const audit = releaseAuditRecord({
    action: "release_promotion",
    outcome: "promoted",
    tenant,
    actor: options.actor,
    timestamp,
    reasonCode: "release_promoted",
    verdict,
    approval
  });

  await appendOperationAuditRecord({
    rootDir: options.rootDir,
    record: audit
  });

  const state = ReleaseStateSchema.parse({
    recordVersion: OPERATIONS_RELEASE_STATE_VERSION,
    tenant,
    deploymentMode: verdict.targetTenant.deploymentMode,
    releaseId: verdict.releaseId,
    deployedVersion: verdict.candidateVersion,
    previousVersion: verdict.deployedVersion,
    compatibilityClass: verdict.compatibilityClass,
    promotedAt: timestamp,
    actor: options.actor,
    ...(approval === undefined ? {} : { approvalId: approval.approvalId }),
    decisionHash: verdict.decisionHash
  });

  await writeReleaseState({
    rootDir: options.rootDir,
    state
  });

  return state;
}

export async function rollbackRelease(
  options: RollbackReleaseOptions
): Promise<ReleaseState> {
  const scope = TenantScopeSchema.parse(options.targetTenant);
  const timestamp = toIso(options.rolledBackAt);
  const current = await readTenantReleaseState({
    rootDir: options.rootDir,
    tenant: scope.tenantId
  });
  const verdict = {
    releaseId: options.releaseId ?? `rollback-${scope.tenantId}-${timestamp}`,
    targetTenant: scope,
    tenantTier: "production",
    deployedVersion: current?.deployedVersion ?? options.toVersion,
    candidateVersion: options.toVersion,
    compatibilityClass: "patch-compatible",
    status: "promotable",
    blockReasons: [],
    replayResults: [],
    decisionHash: hashOperationCanonical({
      tenant: scope.tenantId,
      toVersion: options.toVersion,
      timestamp,
      reason: options.reason
    }),
    requestedAt: timestamp
  } satisfies ReleaseVerdict;

  if (!isActiveApproval(options.approval, timestamp)) {
    const audit = releaseAuditRecord({
      action: "release_rollback_rejected",
      outcome: "denied",
      tenant: scope.tenantId,
      actor: options.actor,
      timestamp,
      reasonCode: "approval_required",
      verdict
    });

    await appendOperationAuditRecord({
      rootDir: options.rootDir,
      record: audit
    });

    throw new ReleaseError(
      "approval_required",
      "Rollback requires an active approval",
      [audit]
    );
  }

  const approval = options.approval;
  const audit = releaseAuditRecord({
    action: "release_rollback",
    outcome: "rolled_back",
    tenant: scope.tenantId,
    actor: options.actor,
    timestamp,
    reasonCode: "release_rolled_back",
    verdict,
    approval,
    toVersion: options.toVersion
  });

  await appendOperationAuditRecord({
    rootDir: options.rootDir,
    record: audit
  });

  const state = ReleaseStateSchema.parse({
    recordVersion: OPERATIONS_RELEASE_STATE_VERSION,
    tenant: scope.tenantId,
    deploymentMode: scope.deploymentMode,
    releaseId: verdict.releaseId,
    deployedVersion: options.toVersion,
    ...(current === undefined ? {} : { previousVersion: current.deployedVersion }),
    compatibilityClass: "patch-compatible",
    promotedAt: timestamp,
    actor: options.actor,
    approvalId: approval?.approvalId,
    decisionHash: verdict.decisionHash,
    rollbackOf: current?.deployedVersion
  });

  await writeReleaseState({
    rootDir: options.rootDir,
    state
  });

  return state;
}

export async function readTenantReleaseState(options: {
  rootDir?: string | undefined;
  tenant: string;
}): Promise<ReleaseState | undefined> {
  try {
    const raw = await readFile(releaseStatePath(options), "utf8");

    return ReleaseStateSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export function releaseStatePath(options: {
  rootDir?: string | undefined;
  tenant: string;
}) {
  const parsedTenant = tenantId.parse(options.tenant);

  return join(
    options.rootDir ?? ".",
    RUN_STORE_DIR,
    OPERATIONS_RELEASE_DIR,
    `${parsedTenant}.json`
  );
}

function releaseAuditRecord(input: {
  action: OperationAuditRecord["action"];
  outcome: OperationAuditRecord["outcome"];
  tenant: string;
  actor: string;
  timestamp: string;
  reasonCode: string;
  verdict: ReleaseVerdict;
  approval?: ReleaseApproval | undefined;
  toVersion?: string | undefined;
}) {
  return buildOperationAuditRecord({
    action: input.action,
    outcome: input.outcome,
    tenant: input.tenant,
    actor: input.actor,
    timestamp: input.timestamp,
    reasonCode: input.reasonCode,
    releaseId: input.verdict.releaseId,
    deployedVersion: input.verdict.deployedVersion,
    candidateVersion: input.verdict.candidateVersion,
    ...(input.toVersion === undefined ? {} : { toVersion: input.toVersion }),
    compatibilityClass: input.verdict.compatibilityClass,
    gateStatus: input.verdict.status,
    replayOutcome: input.verdict.replayResults.every(
      (result) => result.status === "passed"
    )
      ? "passed"
      : "failed",
    decisionHash: input.verdict.decisionHash,
    runIds: input.verdict.replayResults.map((result) => result.runId),
    ...(input.approval === undefined
      ? {}
      : {
          approver: input.approval.principal,
          approvers: [input.approval.principal]
        }),
    subjectRefs: [
      `release:${input.verdict.releaseId}`,
      `tenant:${input.tenant}`,
      `version:${input.verdict.candidateVersion}`
    ],
    metadata: {
      blockReasons: input.verdict.blockReasons,
      tenantTier: input.verdict.tenantTier
    }
  });
}

async function writeReleaseState(options: {
  rootDir?: string | undefined;
  state: ReleaseState;
}) {
  const path = releaseStatePath({
    rootDir: options.rootDir,
    tenant: options.state.tenant
  });
  const tempPath = `${path}.${hashOperationCanonical(options.state).slice(7, 15)}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${stableOperationJson(options.state)}\n`, {
    flag: "w"
  });
  await rename(tempPath, path);
}

function isActiveApproval(
  approval: ReleaseApproval | undefined,
  now: string
): approval is ReleaseApproval {
  if (approval === undefined) {
    return false;
  }

  const parsed = ReleaseApprovalSchema.safeParse(approval);

  return (
    parsed.success &&
    parsed.data.decision === "approved" &&
    Date.parse(parsed.data.approvedAt) <= Date.parse(now) &&
    (parsed.data.expiresAt === undefined ||
      Date.parse(parsed.data.expiresAt) > Date.parse(now))
  );
}

function stableChanges(changes: readonly CompatibilityChangeDescriptor[]) {
  return [...changes].sort((left, right) => left.changeId.localeCompare(right.changeId));
}

function stableReplayResults(
  results: readonly ReplayFixtureResult[]
): ReplayFixtureResult[] {
  return [...results].sort((left, right) =>
    left.fixtureId.localeCompare(right.fixtureId)
  );
}

function hardReleaseBlockReasons(verdict: ReleaseVerdict): string[] {
  return [
    ...verdict.blockReasons,
    ...(!isCompatibilityClassPromotable(verdict.compatibilityClass)
      ? [`incompatible:${verdict.compatibilityClass}`]
      : []),
    ...verdict.replayResults
      .filter((result) => result.status === "failed")
      .map((result) => `replay_failed:${result.fixtureId}`),
    ...(verdict.status === "blocked" && verdict.blockReasons.length === 0
      ? ["blocked:unspecified"]
      : [])
  ].filter((reason, index, reasons) => reasons.indexOf(reason) === index);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isNodeError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

export type { CompatibilityClass };
