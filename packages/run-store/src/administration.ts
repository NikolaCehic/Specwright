import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ApprovalDecisionValueSchema,
  ApprovalRequestSchema
} from "@specwright/schemas";
import {
  RUN_STORE_DIR,
  RunStoreError,
  appendJsonLine,
  getRunStorePaths,
  verifyRunIntegrity,
  writeJsonAtomic,
  type RunIntegrityVerdict,
  type RunStoreErrorCode
} from "./index";

export const ADMINISTRATION_DIR = "administration";
export const ADMINISTRATION_AUDIT_FILE = "audit.jsonl";
export const ADMINISTRATION_APPROVALS_FILE = "approvals.jsonl";
export const ADMINISTRATION_AUDIT_ALGO = "sha256";
export const ADMINISTRATION_AUDIT_HASH_PREFIX = `${ADMINISTRATION_AUDIT_ALGO}:`;
export const ADMINISTRATION_AUDIT_GENESIS_SEED = `${ADMINISTRATION_AUDIT_HASH_PREFIX}${"0".repeat(64)}`;

const nonEmptyString = z.string().min(1);
const isoTimestamp = z.string().datetime({ offset: true });

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema)
  ])
);

export const AdministrationOperationSchema = z.enum([
  "quarantine",
  "projection_rebuild",
  "redaction_sweep",
  "retention_seal",
  "archive",
  "hard_delete",
  "migration_apply",
  "audit_export",
  "quarantine_release"
]);

export const AdministrationRecordKindSchema = z.enum([
  "pre_operation",
  "post_operation",
  "denial"
]);

export const AdministrationEventRangeSchema = z
  .object({
    startSequence: z.number().int().nonnegative(),
    endSequence: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((range, context) => {
    if (range.endSequence < range.startSequence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "event range endSequence must be >= startSequence"
      });
    }
  });

export const AdministrationRunScopeSchema = z
  .object({
    runIds: z.array(nonEmptyString).min(1),
    eventRange: AdministrationEventRangeSchema
  })
  .strict()
  .superRefine((scope, context) => {
    if (new Set(scope.runIds).size !== scope.runIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "run scope runIds must be unique"
      });
    }
  });

export const AdministrationProfileOrDescriptorSchema = z
  .object({
    profileId: nonEmptyString.optional(),
    descriptorId: nonEmptyString.optional(),
    retentionClass: nonEmptyString.optional(),
    archiveTarget: nonEmptyString.optional(),
    reason: nonEmptyString.optional(),
    metadata: z.record(JsonValueSchema).optional()
  })
  .strict();

export const AdministrationIntegrityRunHeadSchema = z
  .object({
    runId: nonEmptyString,
    status: z.enum(["verified", "unchained", "broken"]),
    eventCount: z.number().int().nonnegative(),
    headHash: nonEmptyString.optional(),
    brokenAtSequence: z.number().int().nonnegative().optional(),
    code: nonEmptyString.optional(),
    detail: nonEmptyString.optional()
  })
  .strict();

export const AdministrationIntegritySnapshotSchema = z
  .object({
    runHeads: z.array(AdministrationIntegrityRunHeadSchema).min(1)
  })
  .strict();

export const RunStoreErrorCodeSchema = z.enum([
  "approval_mismatch",
  "approval_required",
  "corrupt_event",
  "corrupt_audit",
  "dual_control_violation",
  "invalid_event",
  "invalid_event_payload",
  "integrity_broken",
  "invalid_projection",
  "invalid_run_id",
  "invalid_sequence",
  "legal_hold_active",
  "missing_events",
  "raw_read_denied",
  "run_exists",
  "run_not_started",
  "unclassified_field",
  "unknown_event_contract",
  "unsupported_event_version"
]);

export const AdministrationResultSchema = z
  .object({
    status: z.enum(["success", "failure"]),
    code: RunStoreErrorCodeSchema.optional(),
    message: nonEmptyString.optional()
  })
  .strict();

export const AdministrationApprovalRefSchema = z
  .object({
    approvalId: nonEmptyString,
    requestedBy: nonEmptyString,
    approvedBy: nonEmptyString,
    decision: ApprovalDecisionValueSchema
  })
  .strict();

export const AdministrationAuditIntegritySchema = z
  .object({
    algo: z.literal(ADMINISTRATION_AUDIT_ALGO),
    prevHash: nonEmptyString,
    hash: nonEmptyString
  })
  .strict();

export const AdministrationRecordSchema = z
  .object({
    recordId: nonEmptyString,
    tenantId: nonEmptyString,
    sequence: z.number().int().nonnegative(),
    recordKind: AdministrationRecordKindSchema,
    operation: AdministrationOperationSchema,
    actor: nonEmptyString,
    approvalRef: AdministrationApprovalRefSchema,
    runScope: AdministrationRunScopeSchema,
    profileOrDescriptor: AdministrationProfileOrDescriptorSchema.optional(),
    integrityBefore: AdministrationIntegritySnapshotSchema.optional(),
    integrityAfter: AdministrationIntegritySnapshotSchema.optional(),
    result: AdministrationResultSchema,
    timestamp: isoTimestamp,
    auditIntegrity: AdministrationAuditIntegritySchema
  })
  .strict();

export const DualControlApprovalSchema = ApprovalRequestSchema.extend({
  operation: AdministrationOperationSchema,
  runScope: AdministrationRunScopeSchema,
  requestedBy: nonEmptyString,
  approvedBy: nonEmptyString,
  decision: ApprovalDecisionValueSchema,
  timestamp: isoTimestamp
}).strict();

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AdministrationOperation = z.infer<
  typeof AdministrationOperationSchema
>;
export type AdministrationRecordKind = z.infer<
  typeof AdministrationRecordKindSchema
>;
export type AdministrationEventRange = z.infer<
  typeof AdministrationEventRangeSchema
>;
export type AdministrationRunScope = z.infer<
  typeof AdministrationRunScopeSchema
>;
export type AdministrationProfileOrDescriptor = z.infer<
  typeof AdministrationProfileOrDescriptorSchema
>;
export type AdministrationIntegritySnapshot = z.infer<
  typeof AdministrationIntegritySnapshotSchema
>;
export type AdministrationResult = z.infer<typeof AdministrationResultSchema>;
export type AdministrationRecord = z.infer<typeof AdministrationRecordSchema>;
export type DualControlApproval = z.infer<typeof DualControlApprovalSchema>;

export type AdministrationPaths = {
  rootDir: string;
  tenantId: string;
  administrationDir: string;
  auditPath: string;
  approvalsPath: string;
};

export type AdministrationLogVerification =
  | {
      status: "verified";
      recordCount: number;
      headHash: string;
    }
  | {
      status: `broken-at-sequence-${number}`;
      recordCount: number;
      brokenAtSequence: number;
      detail: string;
    };

export type AppendAdministrationRecordInput = Omit<
  AdministrationRecord,
  "tenantId" | "sequence" | "auditIntegrity"
>;

export type RecordApprovalOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  approvalId: string;
  operation: AdministrationOperation;
  runScope: AdministrationRunScope;
  requestedBy: string;
  approvedBy: string;
  decision?: DualControlApproval["decision"];
  timestamp?: Date | string;
  reason?: string;
  subjectRef?: string;
  requestedAction?: string;
  riskSummary?: string;
  policyVerdictRef?: string;
  constraints?: Record<string, unknown>;
  requiredFor?: string;
  metadata?: Record<string, unknown>;
};

export type AssertDualControlOptions = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  operation: AdministrationOperation;
  actor: string;
  approvalId?: string | undefined;
  runScope: AdministrationRunScope;
};

export type LegalHoldDeclaration = {
  active: boolean;
  reason?: string;
  runIds?: readonly string[];
};

export type WithDualControlRecordIds = {
  preOperation?: string;
  postOperation?: string;
  denial?: string;
};

export type WithDualControlTimestamps = {
  preOperation?: Date | string;
  postOperation?: Date | string;
  denial?: Date | string;
};

export type WithDualControlOptions<TResult> = {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  operation: AdministrationOperation;
  actor: string;
  approvalId?: string | undefined;
  runScope: AdministrationRunScope;
  profileOrDescriptor?: AdministrationProfileOrDescriptor;
  legalHold?: LegalHoldDeclaration;
  timestamp?: Date | string;
  recordIds?: WithDualControlRecordIds;
  timestamps?: WithDualControlTimestamps;
  execute: () => Promise<TResult> | TResult;
};

export type WithDualControlResult<TResult> = {
  value: TResult;
  approval: DualControlApproval;
  records: AdministrationRecord[];
};

export type HardDeleteRunOptions = Omit<
  WithDualControlOptions<{ deletedRunDir: string }>,
  "operation" | "runScope" | "execute"
> & {
  runId: string;
  runScope?: AdministrationRunScope;
};

export type AuditExportBundle = {
  bundleVersion: 1;
  bundleId: string;
  exportedAt: string;
  tenantId: string;
  runScope: AdministrationRunScope;
  runIntegrity: AdministrationIntegritySnapshot;
  administrationLogVerification: AdministrationLogVerification;
  administrationRecords: AdministrationRecord[];
};

export type ExportAuditBundleOptions = Omit<
  WithDualControlOptions<AuditExportBundle>,
  "operation" | "runScope" | "execute"
> & {
  runId: string;
  runScope?: AdministrationRunScope;
  bundleId?: string;
  exportedAt?: Date | string;
  outputPath?: string;
};

export type ExportAuditBundleResult = {
  bundle: AuditExportBundle;
  bytes: string;
  approval: DualControlApproval;
  records: AdministrationRecord[];
};

export const ADMINISTRATION_OPERATIONS =
  AdministrationOperationSchema.options;

export function getAdministrationPaths(
  rootDir: string | undefined,
  tenantId?: string | undefined
): AdministrationPaths {
  const absoluteRoot = resolve(rootDir ?? ".");
  const administrationDir = join(
    absoluteRoot,
    RUN_STORE_DIR,
    ADMINISTRATION_DIR
  );

  return {
    rootDir: absoluteRoot,
    tenantId: tenantId ?? tenantIdFromRoot(absoluteRoot),
    administrationDir,
    auditPath: join(administrationDir, ADMINISTRATION_AUDIT_FILE),
    approvalsPath: join(administrationDir, ADMINISTRATION_APPROVALS_FILE)
  };
}

export async function recordApproval(
  options: RecordApprovalOptions
): Promise<DualControlApproval> {
  const paths = getAdministrationPaths(options.rootDir, options.tenantId);
  const candidate = {
    approvalId: options.approvalId,
    operation: options.operation,
    runScope: normalizeRunScope(options.runScope),
    requestedBy: options.requestedBy,
    approvedBy: options.approvedBy,
    decision: options.decision ?? "approved",
    timestamp: normalizeTimestamp(options.timestamp),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.subjectRef === undefined
      ? {}
      : { subjectRef: options.subjectRef }),
    ...(options.requestedAction === undefined
      ? {}
      : { requestedAction: options.requestedAction }),
    ...(options.riskSummary === undefined
      ? {}
      : { riskSummary: options.riskSummary }),
    ...(options.policyVerdictRef === undefined
      ? {}
      : { policyVerdictRef: options.policyVerdictRef }),
    ...(options.constraints === undefined
      ? {}
      : { constraints: options.constraints }),
    ...(options.requiredFor === undefined
      ? {}
      : { requiredFor: options.requiredFor }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  };
  const approval = DualControlApprovalSchema.safeParse(candidate);

  if (!approval.success) {
    throw new RunStoreError(
      "corrupt_audit",
      "Dual-control approval does not match the administration approval schema",
      approval.error
    );
  }

  await mkdir(paths.administrationDir, { recursive: true });
  await appendJsonLine(paths.approvalsPath, approval.data);

  return approval.data;
}

export async function readApprovalLog(options: {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
}): Promise<DualControlApproval[]> {
  const paths = getAdministrationPaths(options.rootDir, options.tenantId);
  const raw = await readUtf8IfExists(paths.approvalsPath);
  const lines = jsonlLines(raw);
  const approvals: DualControlApproval[] = [];

  for (const [index, line] of lines.entries()) {
    const parsedJson = parseJsonLine(line, index, "approval");
    const approval = DualControlApprovalSchema.safeParse(parsedJson);

    if (!approval.success) {
      throw new RunStoreError(
        "corrupt_audit",
        `Approval record at line ${index + 1} failed schema validation`,
        approval.error
      );
    }

    approvals.push(approval.data);
  }

  return approvals;
}

export async function appendAdministrationRecord(options: {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  record: AppendAdministrationRecordInput;
}): Promise<AdministrationRecord> {
  const paths = getAdministrationPaths(options.rootDir, options.tenantId);
  const parsedLog = await parseAdministrationLog(paths);

  if (parsedLog.verification.status !== "verified") {
    throw corruptAuditError(parsedLog.verification);
  }

  const sequence = parsedLog.records.length;
  const prevHash = parsedLog.verification.headHash;
  const candidate = {
    ...options.record,
    tenantId: paths.tenantId,
    sequence,
    auditIntegrity: {
      algo: "sha256" as const,
      prevHash,
      hash: ""
    }
  };
  const chained = {
    ...candidate,
    auditIntegrity: {
      ...candidate.auditIntegrity,
      hash: hashAdministrationRecordContent(candidate)
    }
  };
  const record = AdministrationRecordSchema.safeParse(chained);

  if (!record.success) {
    throw new RunStoreError(
      "corrupt_audit",
      "Administration record does not match the audit schema",
      record.error
    );
  }

  await mkdir(paths.administrationDir, { recursive: true });
  await appendJsonLine(paths.auditPath, record.data);

  return record.data;
}

export async function readAdministrationLog(options: {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
}): Promise<AdministrationRecord[]> {
  const paths = getAdministrationPaths(options.rootDir, options.tenantId);
  const parsedLog = await parseAdministrationLog(paths);

  if (parsedLog.verification.status !== "verified") {
    throw corruptAuditError(parsedLog.verification);
  }

  return parsedLog.records;
}

export async function verifyAdministrationLog(options: {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
}): Promise<AdministrationLogVerification> {
  const paths = getAdministrationPaths(options.rootDir, options.tenantId);
  const parsedLog = await parseAdministrationLog(paths);

  return parsedLog.verification;
}

export async function assertDualControl(
  options: AssertDualControlOptions
): Promise<DualControlApproval> {
  const runScope = normalizeRunScope(options.runScope);
  const records = await readAdministrationLog({
    rootDir: options.rootDir,
    tenantId: options.tenantId
  });

  if (options.approvalId === undefined) {
    throw new RunStoreError(
      "approval_required",
      `${options.operation} requires a recorded dual-control approval`
    );
  }

  const approvals = await readApprovalLog({
    rootDir: options.rootDir,
    tenantId: options.tenantId
  });
  const approval = approvals.find(
    (candidate) => candidate.approvalId === options.approvalId
  );

  if (approval === undefined || approval.decision !== "approved") {
    throw new RunStoreError(
      "approval_required",
      `${options.operation} requires a recorded approved dual-control approval`
    );
  }

  if (
    approval.operation !== options.operation ||
    approval.requestedBy !== options.actor ||
    !sameRunScope(approval.runScope, runScope)
  ) {
    throw new RunStoreError(
      "approval_mismatch",
      `Approval ${approval.approvalId} does not match ${options.operation} for the requested run scope`
    );
  }

  if (
    approval.approvedBy === approval.requestedBy ||
    approval.approvedBy === options.actor
  ) {
    throw new RunStoreError(
      "dual_control_violation",
      `Approval ${approval.approvalId} must be recorded by a distinct approving actor`
    );
  }

  if (
    records.some(
      (record) => record.approvalRef.approvalId === approval.approvalId
    )
  ) {
    throw new RunStoreError(
      "approval_required",
      `Approval ${approval.approvalId} has already been consumed by an administration record`
    );
  }

  return approval;
}

export async function withDualControl<TResult>(
  options: WithDualControlOptions<TResult>
): Promise<WithDualControlResult<TResult>> {
  const runScope = normalizeRunScope(options.runScope);
  const integrityBefore = await collectRunIntegrity({
    rootDir: options.rootDir,
    runScope
  });
  const approval = await assertDualControl({
    rootDir: options.rootDir,
    tenantId: options.tenantId,
    operation: options.operation,
    actor: options.actor,
    approvalId: options.approvalId,
    runScope
  });

  if (legalHoldBlocks(options.operation, runScope, options.legalHold)) {
    const denial = await appendOperationRecord({
      rootDir: options.rootDir,
      tenantId: options.tenantId,
      recordKind: "denial",
      recordId: recordIdFor(options.recordIds, "denial"),
      timestamp: timestampFor(options, "denial"),
      operation: options.operation,
      actor: options.actor,
      approval,
      runScope,
      profileOrDescriptor: options.profileOrDescriptor,
      integrityBefore,
      integrityAfter: integrityBefore,
      result: {
        status: "failure",
        code: "legal_hold_active",
        message: legalHoldMessage(options.legalHold)
      }
    });

    throw new RunStoreError(
      "legal_hold_active",
      `Active legal hold blocks ${options.operation}; administration record ${denial.recordId} captured the denial`
    );
  }

  const preRecord = await appendOperationRecord({
    rootDir: options.rootDir,
    tenantId: options.tenantId,
    recordKind: "pre_operation",
    recordId: recordIdFor(options.recordIds, "preOperation"),
    timestamp: timestampFor(options, "preOperation"),
    operation: options.operation,
    actor: options.actor,
    approval,
    runScope,
    profileOrDescriptor: options.profileOrDescriptor,
    integrityBefore,
    result: {
      status: "success"
    }
  });

  try {
    const value = await options.execute();
    const integrityAfter = await collectRunIntegrity({
      rootDir: options.rootDir,
      runScope
    });
    const postRecord = await appendOperationRecord({
      rootDir: options.rootDir,
      tenantId: options.tenantId,
      recordKind: "post_operation",
      recordId: recordIdFor(options.recordIds, "postOperation"),
      timestamp: timestampFor(options, "postOperation"),
      operation: options.operation,
      actor: options.actor,
      approval,
      runScope,
      profileOrDescriptor: options.profileOrDescriptor,
      integrityBefore,
      integrityAfter,
      result: {
        status: "success"
      }
    });

    return {
      value,
      approval,
      records: [preRecord, postRecord]
    };
  } catch (error) {
    const integrityAfter = await collectRunIntegrity({
      rootDir: options.rootDir,
      runScope
    });
    const failureRecord = await appendOperationRecord({
      rootDir: options.rootDir,
      tenantId: options.tenantId,
      recordKind: "post_operation",
      recordId: recordIdFor(options.recordIds, "postOperation"),
      timestamp: timestampFor(options, "postOperation"),
      operation: options.operation,
      actor: options.actor,
      approval,
      runScope,
      profileOrDescriptor: options.profileOrDescriptor,
      integrityBefore,
      integrityAfter,
      result: failureResult(error)
    });

    if (error instanceof RunStoreError) {
      Object.assign(error, {
        administrationRecordId: failureRecord.recordId
      });
    }

    throw error;
  }
}

export async function hardDeleteRun(
  options: HardDeleteRunOptions
): Promise<WithDualControlResult<{ deletedRunDir: string }>> {
  const paths = getRunStorePaths(options.rootDir, options.runId);
  const runScope =
    options.runScope ??
    (await runScopeForRun({
      rootDir: options.rootDir,
      runId: options.runId
    }));

  return withDualControl({
    ...options,
    operation: "hard_delete",
    runScope,
    execute: async () => {
      await rm(paths.runDir, { recursive: true, force: true });

      return {
        deletedRunDir: paths.runDir
      };
    }
  });
}

export async function exportAuditBundle(
  options: ExportAuditBundleOptions
): Promise<ExportAuditBundleResult> {
  const runScope =
    options.runScope ??
    (await runScopeForRun({
      rootDir: options.rootDir,
      runId: options.runId
    }));
  const paths = getAdministrationPaths(options.rootDir, options.tenantId);
  const exportedAt = normalizeTimestamp(options.exportedAt ?? options.timestamp);
  const gated = await withDualControl({
    ...options,
    operation: "audit_export",
    runScope,
    execute: async () => {
      const [records, verification, runIntegrity] = await Promise.all([
        readAdministrationLog({
          rootDir: options.rootDir,
          tenantId: options.tenantId
        }),
        verifyAdministrationLog({
          rootDir: options.rootDir,
          tenantId: options.tenantId
        }),
        collectRunIntegrity({
          rootDir: options.rootDir,
          runScope
        })
      ]);
      const bundle: AuditExportBundle = {
        bundleVersion: 1,
        bundleId: options.bundleId ?? randomUUID(),
        exportedAt,
        tenantId: paths.tenantId,
        runScope,
        runIntegrity,
        administrationLogVerification: verification,
        administrationRecords: records.filter((record) =>
          runScopesIntersect(record.runScope, runScope)
        )
      };

      if (options.outputPath !== undefined) {
        await writeJsonAtomic(options.outputPath, bundle);
      }

      return bundle;
    }
  });

  return {
    bundle: gated.value,
    bytes: `${canonicalJsonStringify(gated.value)}\n`,
    approval: gated.approval,
    records: gated.records
  };
}

export async function runScopeForRun(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<AdministrationRunScope> {
  const verdict = await verifyRunIntegrity({
    rootDir: options.rootDir,
    runId: options.runId
  });
  const endSequence = Math.max(0, verdict.eventCount - 1);

  return normalizeRunScope({
    runIds: [options.runId],
    eventRange: {
      startSequence: 0,
      endSequence
    }
  });
}

async function appendOperationRecord(options: {
  rootDir?: string | undefined;
  tenantId?: string | undefined;
  recordKind: AdministrationRecordKind;
  recordId: string;
  timestamp: string;
  operation: AdministrationOperation;
  actor: string;
  approval: DualControlApproval;
  runScope: AdministrationRunScope;
  profileOrDescriptor?: AdministrationProfileOrDescriptor | undefined;
  integrityBefore?: AdministrationIntegritySnapshot | undefined;
  integrityAfter?: AdministrationIntegritySnapshot | undefined;
  result: AdministrationResult;
}) {
  return appendAdministrationRecord({
    rootDir: options.rootDir,
    tenantId: options.tenantId,
    record: {
      recordId: options.recordId,
      recordKind: options.recordKind,
      operation: options.operation,
      actor: options.actor,
      approvalRef: {
        approvalId: options.approval.approvalId,
        requestedBy: options.approval.requestedBy,
        approvedBy: options.approval.approvedBy,
        decision: options.approval.decision
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

async function collectRunIntegrity(options: {
  rootDir?: string | undefined;
  runScope: AdministrationRunScope;
}): Promise<AdministrationIntegritySnapshot> {
  const runHeads = await Promise.all(
    options.runScope.runIds.map(async (runId) =>
      integrityHeadFromVerdict(
        runId,
        await verifyRunIntegrity({
          rootDir: options.rootDir,
          runId
        })
      )
    )
  );
  const snapshot = AdministrationIntegritySnapshotSchema.safeParse({
    runHeads
  });

  if (!snapshot.success) {
    throw new RunStoreError(
      "corrupt_audit",
      "Run integrity snapshot does not match administration schema",
      snapshot.error
    );
  }

  return snapshot.data;
}

function integrityHeadFromVerdict(
  runId: string,
  verdict: RunIntegrityVerdict
): AdministrationIntegritySnapshot["runHeads"][number] {
  switch (verdict.status) {
    case "verified":
      return {
        runId,
        status: "verified",
        eventCount: verdict.eventCount,
        headHash: verdict.headHash
      };
    case "unchained":
      return {
        runId,
        status: "unchained",
        eventCount: verdict.eventCount
      };
    case "broken":
      return {
        runId,
        status: "broken",
        eventCount: verdict.eventCount,
        brokenAtSequence: verdict.brokenAtSequence,
        code: verdict.code,
        detail: verdict.detail
      };
  }
}

async function parseAdministrationLog(paths: AdministrationPaths): Promise<{
  records: AdministrationRecord[];
  verification: AdministrationLogVerification;
}> {
  const raw = await readUtf8IfExists(paths.auditPath);
  const lines = jsonlLines(raw);
  const records: AdministrationRecord[] = [];
  let expectedPrevHash = ADMINISTRATION_AUDIT_GENESIS_SEED;

  for (const [index, line] of lines.entries()) {
    let parsedJson: unknown;

    try {
      parsedJson = parseJsonLine(line, index, "administration audit");
    } catch (error) {
      return brokenAdministrationLog(index, records.length, error);
    }

    const record = AdministrationRecordSchema.safeParse(parsedJson);

    if (!record.success) {
      return brokenAdministrationLog(index, records.length, record.error);
    }

    if (record.data.tenantId !== paths.tenantId) {
      return brokenAdministrationLog(
        index,
        records.length,
        `Record tenant ${record.data.tenantId} does not match ${paths.tenantId}`
      );
    }

    if (record.data.sequence !== index) {
      return brokenAdministrationLog(
        index,
        records.length,
        `Record sequence ${record.data.sequence} does not match line index ${index}`
      );
    }

    if (record.data.auditIntegrity.prevHash !== expectedPrevHash) {
      return brokenAdministrationLog(
        index,
        records.length,
        `Record ${index} prevHash ${record.data.auditIntegrity.prevHash} does not match expected ${expectedPrevHash}`
      );
    }

    const expectedHash = hashAdministrationRecordContent(record.data);

    if (record.data.auditIntegrity.hash !== expectedHash) {
      return brokenAdministrationLog(
        index,
        records.length,
        `Record ${index} hash ${record.data.auditIntegrity.hash} does not match recomputed ${expectedHash}`
      );
    }

    records.push(record.data);
    expectedPrevHash = record.data.auditIntegrity.hash;
  }

  return {
    records,
    verification: {
      status: "verified",
      recordCount: records.length,
      headHash: expectedPrevHash
    }
  };
}

function brokenAdministrationLog(
  brokenAtSequence: number,
  recordCount: number,
  cause: unknown
): {
  records: AdministrationRecord[];
  verification: AdministrationLogVerification;
} {
  return {
    records: [],
    verification: {
      status: `broken-at-sequence-${brokenAtSequence}`,
      recordCount,
      brokenAtSequence,
      detail:
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : `Administration audit is broken at sequence ${brokenAtSequence}`
    }
  };
}

function corruptAuditError(verification: AdministrationLogVerification) {
  if (verification.status === "verified") {
    return new RunStoreError(
      "corrupt_audit",
      "Administration audit verification unexpectedly failed"
    );
  }

  return new RunStoreError(
    "corrupt_audit",
    `Administration audit verification reported ${verification.status}: ${verification.detail}`
  );
}

function hashAdministrationRecordContent(
  record: AdministrationRecord | {
    auditIntegrity: AdministrationRecord["auditIntegrity"];
    [key: string]: unknown;
  }
) {
  const { auditIntegrity: _auditIntegrity, ...content } = record;
  const digest = createHash(ADMINISTRATION_AUDIT_ALGO)
    .update(canonicalJsonStringify(content))
    .digest("hex");

  return `${ADMINISTRATION_AUDIT_HASH_PREFIX}${digest}`;
}

function normalizeRunScope(scope: AdministrationRunScope): AdministrationRunScope {
  const runScope = AdministrationRunScopeSchema.safeParse({
    runIds: [...scope.runIds].sort(),
    eventRange: scope.eventRange
  });

  if (!runScope.success) {
    throw new RunStoreError(
      "corrupt_audit",
      "Administration run scope does not match schema",
      runScope.error
    );
  }

  for (const runId of runScope.data.runIds) {
    getRunStorePaths(undefined, runId);
  }

  return runScope.data;
}

function sameRunScope(
  left: AdministrationRunScope,
  right: AdministrationRunScope
) {
  return (
    canonicalJsonStringify(normalizeRunScope(left)) ===
    canonicalJsonStringify(normalizeRunScope(right))
  );
}

function runScopesIntersect(
  left: AdministrationRunScope,
  right: AdministrationRunScope
) {
  const rightRunIds = new Set(right.runIds);

  return left.runIds.some((runId) => rightRunIds.has(runId));
}

function recordIdFor(
  recordIds: WithDualControlRecordIds | undefined,
  key: keyof WithDualControlRecordIds
) {
  return recordIds?.[key] ?? randomUUID();
}

function timestampFor(
  options: Pick<WithDualControlOptions<unknown>, "timestamp" | "timestamps">,
  key: keyof WithDualControlTimestamps
) {
  return normalizeTimestamp(options.timestamps?.[key] ?? options.timestamp);
}

function normalizeTimestamp(timestamp: Date | string | undefined) {
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }

  return timestamp ?? new Date().toISOString();
}

function tenantIdFromRoot(rootDir: string) {
  const digest = createHash(ADMINISTRATION_AUDIT_ALGO)
    .update(resolve(rootDir))
    .digest("hex");

  return `root:${digest}`;
}

function legalHoldBlocks(
  operation: AdministrationOperation,
  runScope: AdministrationRunScope,
  legalHold: LegalHoldDeclaration | undefined
) {
  if (
    legalHold?.active !== true ||
    (operation !== "hard_delete" && operation !== "archive")
  ) {
    return false;
  }

  if (legalHold.runIds === undefined || legalHold.runIds.length === 0) {
    return true;
  }

  const heldRunIds = new Set(legalHold.runIds);

  return runScope.runIds.some((runId) => heldRunIds.has(runId));
}

function legalHoldMessage(legalHold: LegalHoldDeclaration | undefined) {
  return legalHold?.reason ?? "active legal hold";
}

function failureResult(error: unknown): AdministrationResult {
  if (error instanceof RunStoreError) {
    return {
      status: "failure",
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof Error && error.message.length > 0) {
    return {
      status: "failure",
      message: error.message
    };
  }

  return {
    status: "failure",
    message: "operation failed"
  };
}

function parseJsonLine(line: string, index: number, label: string) {
  if (line.trim() === "") {
    throw new RunStoreError(
      "corrupt_audit",
      `Blank JSONL ${label} record at line ${index + 1}`
    );
  }

  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new RunStoreError(
      "corrupt_audit",
      `Invalid JSON at ${label} line ${index + 1}`,
      error
    );
  }
}

function jsonlLines(raw: string) {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

async function readUtf8IfExists(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}
