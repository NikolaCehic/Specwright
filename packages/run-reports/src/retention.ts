import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  RETENTION_RECORD_CLASSES,
  RUN_PACKAGE_RECORD_TOMBSTONE_VERSION,
  RetentionRecordClassSchema,
  RunPackageRecordTombstoneSchema,
  appendJsonLine,
  classifyRunPackageRecords,
  enumerateRunPackageNamespace,
  writeRunPackageRecordTombstone,
  type RetentionRecordClass,
  type RunPackageRecordClassification,
  type RunPackageRecordTombstone,
  type RunPackageRetentionClassification
} from "@specwright/run-store";

export const RETENTION_AUDIT_RECORD_VERSION = 1;
export const RETENTION_AUDIT_DIR = "operations-retention";
export const RETENTION_AUDIT_FILE = "audit.jsonl";

const DAY_MS = 24 * 60 * 60 * 1000;
const nonEmptyString = z.string().min(1);
const isoTimestamp = z.string().datetime({ offset: true });

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

export const RetentionPolicyEntrySchema = z
  .object({
    tenant: nonEmptyString,
    recordClass: RetentionRecordClassSchema,
    windowDays: z.number().int().nonnegative(),
    destroyingActionRetentionDays: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.recordClass === "audit" &&
      entry.destroyingActionRetentionDays < entry.windowDays
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "audit destroyingActionRetentionDays must be >= ordinary windowDays"
      });
    }
  });

export const RetentionPolicySchema = z
  .object({
    entries: z.array(RetentionPolicyEntrySchema).min(1)
  })
  .strict();

export const RetentionLegalHoldSchema = z
  .object({
    holdId: nonEmptyString,
    tenant: nonEmptyString,
    reason: nonEmptyString,
    placedAt: isoTimestamp,
    releasedAt: isoTimestamp.optional(),
    runIds: z.array(nonEmptyString).min(1).optional(),
    recordClasses: z.array(RetentionRecordClassSchema).min(1).optional()
  })
  .strict()
  .superRefine((hold, context) => {
    if (
      hold.releasedAt !== undefined &&
      Date.parse(hold.releasedAt) < Date.parse(hold.placedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "legal hold releasedAt must be >= placedAt"
      });
    }
  });

export const RetentionApprovalSchema = z
  .object({
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

export const RetentionErasureTargetSchema = z
  .object({
    runId: nonEmptyString,
    recordClass: RetentionRecordClassSchema
  })
  .strict();

export const RetentionErasureRequestSchema = z
  .object({
    requestId: nonEmptyString,
    requestedBy: nonEmptyString,
    target: RetentionErasureTargetSchema,
    reason: nonEmptyString
  })
  .strict();

const RetentionAuditOutcomeSchema = z.enum([
  "erased",
  "noop_already_tombstoned",
  "refused_unscoped",
  "refused_single_control",
  "refused_legal_hold",
  "refused_not_eligible",
  "refused_not_erasable",
  "refused_invalid_request"
]);

export const RetentionGovernanceAuditRecordSchema = z
  .object({
    recordVersion: z.literal(RETENTION_AUDIT_RECORD_VERSION),
    recordKind: z.literal("retention_governance_audit"),
    recordId: nonEmptyString,
    tenant: nonEmptyString,
    action: z.enum(["retention_scan", "retention_erasure"]),
    outcome: RetentionAuditOutcomeSchema,
    failureClass: z.union([z.literal(2), z.literal(6), z.literal(12)]).optional(),
    requestId: nonEmptyString,
    actor: nonEmptyString,
    runId: nonEmptyString.optional(),
    recordClass: RetentionRecordClassSchema.optional(),
    timestamp: isoTimestamp,
    reason: nonEmptyString,
    approvers: z.array(nonEmptyString).optional(),
    scope: z
      .object({
        tenant: nonEmptyString,
        runId: nonEmptyString.optional(),
        recordClass: RetentionRecordClassSchema.optional()
      })
      .strict(),
    tombstoneRef: nonEmptyString.optional(),
    policyWindowDays: z.number().int().nonnegative().optional(),
    retainedUntil: isoTimestamp.optional(),
    destroyingAction: z.boolean(),
    redactionClass: z.literal("operator"),
    subjectRefs: z.array(nonEmptyString).min(1),
    subjectHashes: z.array(nonEmptyString).min(1),
    metadata: z.record(RetentionJsonValueSchema).optional()
  })
  .strict();

export type RetentionJsonValue =
  | string
  | number
  | boolean
  | null
  | RetentionJsonValue[]
  | { [key: string]: RetentionJsonValue };

export type RetentionPolicyEntry = z.infer<typeof RetentionPolicyEntrySchema>;
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;
export type RetentionLegalHold = z.infer<typeof RetentionLegalHoldSchema>;
export type RetentionApproval = z.infer<typeof RetentionApprovalSchema>;
export type RetentionErasureRequest = z.infer<
  typeof RetentionErasureRequestSchema
>;
export type RetentionGovernanceAuditRecord = z.infer<
  typeof RetentionGovernanceAuditRecordSchema
>;
export type RetentionAuditOutcome = z.infer<
  typeof RetentionAuditOutcomeSchema
>;

export type RetentionGovernanceErrorCode =
  | "invalid_policy"
  | "invalid_request"
  | "unscoped_request"
  | "single_control_refused"
  | "legal_hold_active"
  | "record_class_not_erasable"
  | "retention_not_eligible"
  | "tombstone_collision";

export class RetentionGovernanceError extends Error {
  readonly code: RetentionGovernanceErrorCode;
  readonly auditRecords: RetentionGovernanceAuditRecord[];

  constructor(
    code: RetentionGovernanceErrorCode,
    message: string,
    auditRecords: RetentionGovernanceAuditRecord[] = [],
    cause?: unknown
  ) {
    super(message);
    this.name = "RetentionGovernanceError";
    this.code = code;
    this.auditRecords = auditRecords;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type ScanRetentionOptions = {
  rootDir?: string | undefined;
  tenant: string;
  policy: RetentionPolicy;
  legalHolds?: readonly RetentionLegalHold[] | undefined;
  now: Date | string;
};

export type RetentionEligibility = {
  tenant: string;
  runId: string;
  recordClass: RetentionRecordClass;
  path?: string | undefined;
  reason: "window_expired" | "destroying_action_audit_window_expired";
  eligibleAt: string;
  lastRelevantTimestamp: string;
  policyWindowDays: number;
  suppressedByLegalHold: boolean;
  legalHoldIds: string[];
  erasable: boolean;
  authoritative: boolean;
  tombstoned: boolean;
  auditRecordId?: string | undefined;
};

export type ScanRetentionResult = {
  tenant: string;
  rootDir: string;
  runsDir: string;
  now: string;
  policyEntries: RetentionPolicyEntry[];
  classifications: RunPackageRetentionClassification[];
  eligibility: RetentionEligibility[];
};

export type EraseUnderGovernanceOptions = {
  rootDir?: string | undefined;
  tenant: string;
  request: RetentionErasureRequest;
  approvals: readonly RetentionApproval[];
  policy: RetentionPolicy;
  legalHolds?: readonly RetentionLegalHold[] | undefined;
  now: Date | string;
};

export type EraseUnderGovernanceResult = {
  tenant: string;
  request: RetentionErasureRequest;
  outcome: Extract<
    RetentionAuditOutcome,
    "erased" | "noop_already_tombstoned"
  >;
  tombstone?: RunPackageRecordTombstone | undefined;
  tombstonePath?: string | undefined;
  auditRecords: RetentionGovernanceAuditRecord[];
};

type PolicyByClass = Map<RetentionRecordClass, RetentionPolicyEntry>;

export async function scanRetention(
  options: ScanRetentionOptions
): Promise<ScanRetentionResult> {
  const now = normalizeTimestamp(options.now);
  const tenant = options.tenant.trim();

  if (tenant.length === 0) {
    const auditRecord = buildAuditRecord({
      action: "retention_scan",
      outcome: "refused_unscoped",
      failureClass: 2,
      tenant: "unscoped",
      requestId: "scan:unscoped",
      actor: "retention-scan",
      timestamp: now,
      reason: "Retention scan requires a non-empty tenant scope.",
      destroyingAction: false
    });

    throw new RetentionGovernanceError(
      "unscoped_request",
      "Retention scan requires a non-empty tenant scope.",
      [auditRecord]
    );
  }

  const policyByClass = policyForTenant(options.policy, tenant);
  const legalHolds = parseLegalHolds(options.legalHolds ?? []);
  const namespace = await enumerateRunPackageNamespace({
    rootDir: options.rootDir
  });
  const classifications: RunPackageRetentionClassification[] = [];
  const eligibility: RetentionEligibility[] = [];

  for (const runId of namespace.runIds) {
    const classification = await classifyRunPackageRecords({
      rootDir: options.rootDir,
      runId
    });

    classifications.push(classification);

    for (const record of classification.records) {
      const item = eligibilityForRecord({
        tenant,
        record,
        policy: policyByClass.get(record.recordClass),
        legalHolds,
        now
      });

      if (item !== undefined) {
        eligibility.push(item);
      }
    }
  }

  eligibility.push(
    ...(await auditEligibility({
      rootDir: options.rootDir,
      tenant,
      policy: policyByClass.get("audit"),
      now
    }))
  );

  return {
    tenant,
    rootDir: namespace.rootDir,
    runsDir: namespace.runsDir,
    now,
    policyEntries: [...policyByClass.values()].sort((left, right) =>
      left.recordClass.localeCompare(right.recordClass)
    ),
    classifications: classifications.sort((left, right) =>
      left.runId.localeCompare(right.runId)
    ),
    eligibility: eligibility.sort(compareEligibility)
  };
}

export async function eraseUnderGovernance(
  options: EraseUnderGovernanceOptions
): Promise<EraseUnderGovernanceResult> {
  const now = normalizeTimestamp(options.now);
  const tenant = options.tenant.trim();
  const parsedRequest = RetentionErasureRequestSchema.safeParse(
    options.request
  );
  const requestForAudit =
    parsedRequest.success === true ? parsedRequest.data : undefined;
  const actor = requestForAudit?.requestedBy ?? "retention-erasure";

  if (tenant.length === 0) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_unscoped",
        failureClass: 2,
        tenant: "unscoped",
        requestId: requestForAudit?.requestId ?? "erasure:unscoped",
        actor,
        timestamp: now,
        reason: "Retention erasure requires a non-empty tenant scope.",
        destroyingAction: false
      })
    );

    throw new RetentionGovernanceError(
      "unscoped_request",
      "Retention erasure requires a non-empty tenant scope.",
      [auditRecord]
    );
  }

  if (!parsedRequest.success) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_invalid_request",
        tenant,
        requestId: "erasure:invalid-request",
        actor,
        timestamp: now,
        reason: "Retention erasure request failed schema validation.",
        destroyingAction: false
      })
    );

    throw new RetentionGovernanceError(
      "invalid_request",
      "Retention erasure request failed schema validation.",
      [auditRecord],
      parsedRequest.error
    );
  }

  const request = parsedRequest.data;
  const policyByClass = policyForTenant(options.policy, tenant);
  const policy = policyByClass.get(request.target.recordClass);

  if (policy === undefined) {
    throw new RetentionGovernanceError(
      "invalid_policy",
      `No retention policy for ${tenant}/${request.target.recordClass}`
    );
  }

  const approvals = parseApprovals(options.approvals);
  const approvedPrincipals = activeApprovingPrincipals(approvals, now);

  if (approvedPrincipals.length < 2) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_single_control",
        failureClass: 6,
        tenant,
        requestId: request.requestId,
        actor: request.requestedBy,
        runId: request.target.runId,
        recordClass: request.target.recordClass,
        timestamp: now,
        reason: "Retention erasure requires two distinct active approvals.",
        destroyingAction: false,
        approvers: approvedPrincipals
      })
    );

    throw new RetentionGovernanceError(
      "single_control_refused",
      "Retention erasure requires two distinct active approvals.",
      [auditRecord]
    );
  }

  const legalHolds = parseLegalHolds(options.legalHolds ?? []);
  const activeHold = firstActiveLegalHold({
    tenant,
    runId: request.target.runId,
    recordClass: request.target.recordClass,
    legalHolds,
    now
  });

  if (activeHold !== undefined) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_legal_hold",
        failureClass: 12,
        tenant,
        requestId: request.requestId,
        actor: request.requestedBy,
        runId: request.target.runId,
        recordClass: request.target.recordClass,
        timestamp: now,
        reason: `Active legal hold ${activeHold.holdId} blocks erasure: ${activeHold.reason}`,
        destroyingAction: false,
        approvers: approvedPrincipals,
        metadata: {
          legalHoldId: activeHold.holdId
        }
      })
    );

    throw new RetentionGovernanceError(
      "legal_hold_active",
      `Active legal hold ${activeHold.holdId} blocks erasure.`,
      [auditRecord]
    );
  }

  const classification = await classifyRunPackageRecords({
    rootDir: options.rootDir,
    runId: request.target.runId
  });
  const record = classification.records.find(
    (candidate) => candidate.recordClass === request.target.recordClass
  );

  if (record === undefined || !record.erasable) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_not_erasable",
        tenant,
        requestId: request.requestId,
        actor: request.requestedBy,
        runId: request.target.runId,
        recordClass: request.target.recordClass,
        timestamp: now,
        reason: `Record class ${request.target.recordClass} is not erasable.`,
        destroyingAction: false,
        approvers: approvedPrincipals
      })
    );

    throw new RetentionGovernanceError(
      "record_class_not_erasable",
      `Record class ${request.target.recordClass} is not erasable.`,
      [auditRecord]
    );
  }

  if (record.tombstone !== undefined) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "noop_already_tombstoned",
        tenant,
        requestId: request.requestId,
        actor: request.requestedBy,
        runId: request.target.runId,
        recordClass: request.target.recordClass,
        timestamp: now,
        reason: "Target record class is already tombstoned.",
        destroyingAction: true,
        approvers: approvedPrincipals,
        policy,
        tombstoneRef: record.path
      })
    );

    return {
      tenant,
      request,
      outcome: "noop_already_tombstoned",
      tombstone: record.tombstone,
      tombstonePath: record.path,
      auditRecords: [auditRecord]
    };
  }

  const scan = await scanRetention({
    rootDir: options.rootDir,
    tenant,
    policy: options.policy,
    legalHolds,
    now
  });
  const eligible = scan.eligibility.find(
    (item) =>
      item.runId === request.target.runId &&
      item.recordClass === request.target.recordClass &&
      !item.suppressedByLegalHold
  );

  if (eligible === undefined) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_not_eligible",
        tenant,
        requestId: request.requestId,
        actor: request.requestedBy,
        runId: request.target.runId,
        recordClass: request.target.recordClass,
        timestamp: now,
        reason: "Target record class is not eligible under the active policy.",
        destroyingAction: false,
        approvers: approvedPrincipals
      })
    );

    throw new RetentionGovernanceError(
      "retention_not_eligible",
      "Target record class is not eligible under the active policy.",
      [auditRecord]
    );
  }

  const tombstone = RunPackageRecordTombstoneSchema.parse({
    tombstoneVersion: RUN_PACKAGE_RECORD_TOMBSTONE_VERSION,
    recordKind: "ops.retention.record_class_tombstone",
    tenant,
    runId: request.target.runId,
    recordClass: request.target.recordClass,
    scope: {
      tenant,
      runId: request.target.runId,
      recordClass: request.target.recordClass
    },
    approvers: [approvedPrincipals[0], approvedPrincipals[1]],
    erasedAt: now,
    reason: request.reason,
    requestId: request.requestId,
    policyWindowDays: policy.windowDays
  });
  let written: Awaited<ReturnType<typeof writeRunPackageRecordTombstone>>;

  try {
    written = await writeRunPackageRecordTombstone({
      rootDir: options.rootDir,
      runId: request.target.runId,
      recordClass: request.target.recordClass,
      tombstone
    });
  } catch (error) {
    const auditRecord = await appendRetentionAuditRecord(
      options.rootDir,
      buildAuditRecord({
        action: "retention_erasure",
        outcome: "refused_legal_hold",
        failureClass: 12,
        tenant,
        requestId: request.requestId,
        actor: request.requestedBy,
        runId: request.target.runId,
        recordClass: request.target.recordClass,
        timestamp: now,
        reason: "Tombstone collision or write precondition failed.",
        destroyingAction: false,
        approvers: approvedPrincipals,
        metadata: {
          error: errorMessage(error)
        }
      })
    );

    throw new RetentionGovernanceError(
      "tombstone_collision",
      "Tombstone collision or write precondition failed.",
      [auditRecord],
      error
    );
  }

  const auditRecord = await appendRetentionAuditRecord(
    options.rootDir,
    buildAuditRecord({
      action: "retention_erasure",
      outcome:
        written.status === "written" ? "erased" : "noop_already_tombstoned",
      tenant,
      requestId: request.requestId,
      actor: request.requestedBy,
      runId: request.target.runId,
      recordClass: request.target.recordClass,
      timestamp: now,
      reason: request.reason,
      destroyingAction: true,
      approvers: approvedPrincipals,
      policy,
      tombstoneRef: written.path,
      metadata: {
        priorContentHash: written.priorContentHash
      }
    })
  );

  return {
    tenant,
    request,
    outcome: written.status === "written" ? "erased" : "noop_already_tombstoned",
    tombstone: written.tombstone,
    tombstonePath: written.path,
    auditRecords: [auditRecord]
  };
}

export async function readRetentionAuditRecords(options: {
  rootDir?: string | undefined;
  tenant?: string | undefined;
} = {}): Promise<RetentionGovernanceAuditRecord[]> {
  const raw = await readOptionalUtf8(retentionAuditPath(options.rootDir));
  const lines = jsonlLines(raw);
  const records: RetentionGovernanceAuditRecord[] = [];

  for (const [index, line] of lines.entries()) {
    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw new RetentionGovernanceError(
        "invalid_request",
        `Retention audit record at line ${index + 1} is invalid JSON.`,
        [],
        error
      );
    }

    const record = RetentionGovernanceAuditRecordSchema.safeParse(parsedJson);

    if (!record.success) {
      throw new RetentionGovernanceError(
        "invalid_request",
        `Retention audit record at line ${index + 1} failed schema validation.`,
        [],
        record.error
      );
    }

    if (options.tenant === undefined || record.data.tenant === options.tenant) {
      records.push(record.data);
    }
  }

  return records;
}

async function appendRetentionAuditRecord(
  rootDir: string | undefined,
  record: RetentionGovernanceAuditRecord
) {
  const parsed = RetentionGovernanceAuditRecordSchema.parse(record);

  await mkdir(retentionAuditDir(rootDir), { recursive: true });
  await appendJsonLine(retentionAuditPath(rootDir), parsed);

  return parsed;
}

function policyForTenant(
  policy: RetentionPolicy,
  tenant: string
): PolicyByClass {
  const parsed = RetentionPolicySchema.safeParse(policy);

  if (!parsed.success) {
    throw new RetentionGovernanceError(
      "invalid_policy",
      "Retention policy failed schema validation.",
      [],
      parsed.error
    );
  }

  const byClass: PolicyByClass = new Map();

  for (const entry of parsed.data.entries) {
    if (entry.tenant !== tenant) {
      continue;
    }

    if (byClass.has(entry.recordClass)) {
      throw new RetentionGovernanceError(
        "invalid_policy",
        `Retention policy has duplicate ${tenant}/${entry.recordClass} entries.`
      );
    }

    byClass.set(entry.recordClass, entry);
  }

  const missing = RETENTION_RECORD_CLASSES.filter(
    (recordClass) => !byClass.has(recordClass)
  );

  if (missing.length > 0) {
    throw new RetentionGovernanceError(
      "invalid_policy",
      `Retention policy for ${tenant} is missing record classes: ${missing.join(", ")}.`
    );
  }

  return byClass;
}

function eligibilityForRecord(input: {
  tenant: string;
  record: RunPackageRecordClassification;
  policy: RetentionPolicyEntry | undefined;
  legalHolds: readonly RetentionLegalHold[];
  now: string;
}): RetentionEligibility | undefined {
  if (
    input.policy === undefined ||
    !input.record.present ||
    input.record.tombstoned ||
    !input.record.erasable ||
    input.record.lastRelevantTimestamp === undefined
  ) {
    return undefined;
  }

  const eligibleAt = addDays(
    input.record.lastRelevantTimestamp,
    input.policy.windowDays
  );

  if (Date.parse(input.now) < Date.parse(eligibleAt)) {
    return undefined;
  }

  const holds = activeLegalHoldsFor({
    tenant: input.tenant,
    runId: input.record.runId,
    recordClass: input.record.recordClass,
    legalHolds: input.legalHolds,
    now: input.now
  });

  return {
    tenant: input.tenant,
    runId: input.record.runId,
    recordClass: input.record.recordClass,
    path: input.record.path,
    reason: "window_expired",
    eligibleAt,
    lastRelevantTimestamp: input.record.lastRelevantTimestamp,
    policyWindowDays: input.policy.windowDays,
    suppressedByLegalHold: holds.length > 0,
    legalHoldIds: holds.map((hold) => hold.holdId).sort(),
    erasable: input.record.erasable,
    authoritative: input.record.authoritative,
    tombstoned: input.record.tombstoned
  };
}

async function auditEligibility(input: {
  rootDir?: string | undefined;
  tenant: string;
  policy: RetentionPolicyEntry | undefined;
  now: string;
}) {
  if (input.policy === undefined) {
    return [];
  }

  const records = await readRetentionAuditRecords({
    rootDir: input.rootDir,
    tenant: input.tenant
  });
  const eligibility: RetentionEligibility[] = [];

  for (const record of records) {
    if (!record.destroyingAction) {
      continue;
    }

    const retainedUntil = addDays(
      record.timestamp,
      input.policy.destroyingActionRetentionDays
    );

    if (Date.parse(input.now) < Date.parse(retainedUntil)) {
      continue;
    }

    eligibility.push({
      tenant: input.tenant,
      runId: record.runId ?? "operations-audit",
      recordClass: "audit",
      reason: "destroying_action_audit_window_expired",
      eligibleAt: retainedUntil,
      lastRelevantTimestamp: record.timestamp,
      policyWindowDays: input.policy.destroyingActionRetentionDays,
      suppressedByLegalHold: false,
      legalHoldIds: [],
      erasable: false,
      authoritative: false,
      tombstoned: false,
      auditRecordId: record.recordId
    });
  }

  return eligibility;
}

function parseApprovals(
  approvals: readonly RetentionApproval[]
): RetentionApproval[] {
  return approvals.map((approval) => RetentionApprovalSchema.parse(approval));
}

function activeApprovingPrincipals(
  approvals: readonly RetentionApproval[],
  now: string
) {
  const principals = new Set<string>();

  for (const approval of approvals) {
    if (approval.decision !== "approved") {
      continue;
    }

    if (Date.parse(approval.approvedAt) > Date.parse(now)) {
      continue;
    }

    if (
      approval.expiresAt !== undefined &&
      Date.parse(approval.expiresAt) < Date.parse(now)
    ) {
      continue;
    }

    principals.add(approval.principal);
  }

  return [...principals].sort();
}

function parseLegalHolds(
  legalHolds: readonly RetentionLegalHold[]
): RetentionLegalHold[] {
  return legalHolds.map((hold) => RetentionLegalHoldSchema.parse(hold));
}

function activeLegalHoldsFor(input: {
  tenant: string;
  runId: string;
  recordClass: RetentionRecordClass;
  legalHolds: readonly RetentionLegalHold[];
  now: string;
}) {
  return input.legalHolds.filter((hold) =>
    legalHoldIntersects({
      hold,
      tenant: input.tenant,
      runId: input.runId,
      recordClass: input.recordClass,
      now: input.now
    })
  );
}

function firstActiveLegalHold(input: {
  tenant: string;
  runId: string;
  recordClass: RetentionRecordClass;
  legalHolds: readonly RetentionLegalHold[];
  now: string;
}) {
  return activeLegalHoldsFor(input).sort((left, right) =>
    left.holdId.localeCompare(right.holdId)
  )[0];
}

function legalHoldIntersects(input: {
  hold: RetentionLegalHold;
  tenant: string;
  runId: string;
  recordClass: RetentionRecordClass;
  now: string;
}) {
  if (input.hold.tenant !== input.tenant) {
    return false;
  }

  const nowMs = Date.parse(input.now);

  if (Date.parse(input.hold.placedAt) > nowMs) {
    return false;
  }

  if (
    input.hold.releasedAt !== undefined &&
    Date.parse(input.hold.releasedAt) <= nowMs
  ) {
    return false;
  }

  if (
    input.hold.runIds !== undefined &&
    !input.hold.runIds.includes(input.runId)
  ) {
    return false;
  }

  return (
    input.hold.recordClasses === undefined ||
    input.hold.recordClasses.includes(input.recordClass)
  );
}

function buildAuditRecord(input: {
  action: RetentionGovernanceAuditRecord["action"];
  outcome: RetentionAuditOutcome;
  failureClass?: 2 | 6 | 12 | undefined;
  tenant: string;
  requestId: string;
  actor: string;
  runId?: string | undefined;
  recordClass?: RetentionRecordClass | undefined;
  timestamp: string;
  reason: string;
  destroyingAction: boolean;
  approvers?: readonly string[] | undefined;
  policy?: RetentionPolicyEntry | undefined;
  tombstoneRef?: string | undefined;
  metadata?: Record<string, RetentionJsonValue> | undefined;
}): RetentionGovernanceAuditRecord {
  const scope = {
    tenant: input.tenant,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.recordClass === undefined
      ? {}
      : { recordClass: input.recordClass })
  };
  const retainedUntil =
    input.policy === undefined
      ? undefined
      : addDays(
          input.timestamp,
          input.destroyingAction
            ? input.policy.destroyingActionRetentionDays
            : input.policy.windowDays
        );
  const subject = {
    action: input.action,
    outcome: input.outcome,
    tenant: input.tenant,
    requestId: input.requestId,
    runId: input.runId,
    recordClass: input.recordClass,
    timestamp: input.timestamp,
    tombstoneRef: input.tombstoneRef
  };

  return RetentionGovernanceAuditRecordSchema.parse({
    recordVersion: RETENTION_AUDIT_RECORD_VERSION,
    recordKind: "retention_governance_audit",
    recordId: randomUUID(),
    tenant: input.tenant,
    action: input.action,
    outcome: input.outcome,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: input.failureClass }),
    requestId: input.requestId,
    actor: input.actor,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.recordClass === undefined
      ? {}
      : { recordClass: input.recordClass }),
    timestamp: input.timestamp,
    reason: input.reason,
    ...(input.approvers === undefined
      ? {}
      : { approvers: [...input.approvers].sort() }),
    scope,
    ...(input.tombstoneRef === undefined
      ? {}
      : { tombstoneRef: input.tombstoneRef }),
    ...(input.policy === undefined
      ? {}
      : { policyWindowDays: input.policy.windowDays }),
    ...(retainedUntil === undefined ? {} : { retainedUntil }),
    destroyingAction: input.destroyingAction,
    redactionClass: "operator",
    subjectRefs: [
      `tenant:${input.tenant}`,
      `request:${input.requestId}`,
      ...(input.runId === undefined ? [] : [`run:${input.runId}`]),
      ...(input.recordClass === undefined
        ? []
        : [`record-class:${input.recordClass}`])
    ],
    subjectHashes: [hashRetentionCanonical(subject)],
    ...(input.metadata === undefined ? {} : { metadata: input.metadata })
  });
}

function compareEligibility(
  left: RetentionEligibility,
  right: RetentionEligibility
) {
  return (
    left.runId.localeCompare(right.runId) ||
    left.recordClass.localeCompare(right.recordClass) ||
    (left.auditRecordId ?? "").localeCompare(right.auditRecordId ?? "")
  );
}

function retentionAuditDir(rootDir: string | undefined) {
  return join(resolve(rootDir ?? "."), ".archetype", RETENTION_AUDIT_DIR);
}

function retentionAuditPath(rootDir: string | undefined) {
  return join(retentionAuditDir(rootDir), RETENTION_AUDIT_FILE);
}

async function readOptionalUtf8(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function jsonlLines(raw: string) {
  if (raw.length === 0) {
    return [];
  }

  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function addDays(timestamp: string, days: number) {
  return new Date(Date.parse(timestamp) + days * DAY_MS).toISOString();
}

function normalizeTimestamp(timestamp: Date | string) {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function hashRetentionCanonical(value: unknown) {
  const digest = createHash("sha256")
    .update(JSON.stringify(normalizeStable(value)))
    .digest("hex");

  return `sha256:${digest}`;
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStable(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, normalizeStable(value[key])])
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown retention error";
}
