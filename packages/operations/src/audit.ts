import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendJsonLine, RUN_STORE_DIR } from "@specwright/run-store";
import { z } from "zod";

export const OPERATION_AUDIT_RECORD_VERSION = 1;
export const OPERATION_AUDIT_DIR = "ops-audit";

const nonEmptyString = z.string().min(1);
const tenantId = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/);
const isoTimestamp = z.string().datetime({ offset: true });

const OperationJsonValueSchema: z.ZodType<OperationJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(OperationJsonValueSchema),
    z.record(OperationJsonValueSchema)
  ])
);

export const OperationAuditActionSchema = z.enum([
  "tenant_job_rejected",
  "tenant_job_completed",
  "cross_tenant_query_rejected",
  "cross_tenant_query",
  "release_promotion_rejected",
  "release_promotion",
  "release_rollback_rejected",
  "release_rollback"
]);

export const OperationAuditOutcomeSchema = z.enum([
  "allowed",
  "denied",
  "promoted",
  "rolled_back",
  "blocked"
]);

export const OperationAuditRecordSchema = z
  .object({
    recordVersion: z.literal(OPERATION_AUDIT_RECORD_VERSION),
    recordKind: z.literal("operations_audit"),
    recordId: nonEmptyString,
    action: OperationAuditActionSchema,
    outcome: OperationAuditOutcomeSchema,
    tenant: tenantId,
    actor: nonEmptyString,
    timestamp: isoTimestamp,
    reasonCode: nonEmptyString,
    targetTenants: z.array(tenantId).min(1),
    approver: nonEmptyString.optional(),
    approvers: z.array(nonEmptyString).min(1).optional(),
    releaseId: nonEmptyString.optional(),
    deployedVersion: nonEmptyString.optional(),
    candidateVersion: nonEmptyString.optional(),
    toVersion: nonEmptyString.optional(),
    compatibilityClass: nonEmptyString.optional(),
    gateStatus: z.enum(["promotable", "blocked"]).optional(),
    replayOutcome: z.enum(["passed", "failed"]).optional(),
    decisionHash: nonEmptyString.optional(),
    runIds: z.array(nonEmptyString).optional(),
    subjectRefs: z.array(nonEmptyString).min(1),
    subjectHashes: z.array(nonEmptyString).min(1),
    redactionClass: z.literal("operator"),
    metadata: z.record(OperationJsonValueSchema).optional()
  })
  .strict()
  .superRefine((record, context) => {
    if (!record.targetTenants.includes(record.tenant)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "operation audit targetTenants must include tenant"
      });
    }
  });

export type OperationJsonValue =
  | string
  | number
  | boolean
  | null
  | OperationJsonValue[]
  | { [key: string]: OperationJsonValue };

export type OperationAuditAction = z.infer<typeof OperationAuditActionSchema>;
export type OperationAuditOutcome = z.infer<typeof OperationAuditOutcomeSchema>;
export type OperationAuditRecord = z.infer<typeof OperationAuditRecordSchema>;

export type BuildOperationAuditRecordInput = {
  action: OperationAuditAction;
  outcome: OperationAuditOutcome;
  tenant: string;
  actor: string;
  timestamp: string;
  reasonCode: string;
  targetTenants?: string[] | undefined;
  approver?: string | undefined;
  approvers?: string[] | undefined;
  releaseId?: string | undefined;
  deployedVersion?: string | undefined;
  candidateVersion?: string | undefined;
  toVersion?: string | undefined;
  compatibilityClass?: string | undefined;
  gateStatus?: "promotable" | "blocked" | undefined;
  replayOutcome?: "passed" | "failed" | undefined;
  decisionHash?: string | undefined;
  runIds?: string[] | undefined;
  subjectRefs: string[];
  subjectHashes?: string[] | undefined;
  metadata?: Record<string, OperationJsonValue> | undefined;
  recordId?: string | undefined;
};

export type AppendOperationAuditRecordOptions = {
  rootDir?: string | undefined;
  record: OperationAuditRecord;
};

export type ReadOperationAuditRecordsOptions = {
  rootDir?: string | undefined;
  tenant: string;
};

export function buildOperationAuditRecord(
  input: BuildOperationAuditRecordInput
): OperationAuditRecord {
  const subjectHashes =
    input.subjectHashes ?? input.subjectRefs.map((ref) => hashOperationCanonical(ref));
  const record = {
    recordVersion: OPERATION_AUDIT_RECORD_VERSION,
    recordKind: "operations_audit",
    recordId: input.recordId ?? randomUUID(),
    action: input.action,
    outcome: input.outcome,
    tenant: input.tenant,
    actor: input.actor,
    timestamp: input.timestamp,
    reasonCode: input.reasonCode,
    targetTenants: stableUnique(input.targetTenants ?? [input.tenant]),
    ...(input.approver === undefined ? {} : { approver: input.approver }),
    ...(input.approvers === undefined
      ? {}
      : { approvers: stableUnique(input.approvers) }),
    ...(input.releaseId === undefined ? {} : { releaseId: input.releaseId }),
    ...(input.deployedVersion === undefined
      ? {}
      : { deployedVersion: input.deployedVersion }),
    ...(input.candidateVersion === undefined
      ? {}
      : { candidateVersion: input.candidateVersion }),
    ...(input.toVersion === undefined ? {} : { toVersion: input.toVersion }),
    ...(input.compatibilityClass === undefined
      ? {}
      : { compatibilityClass: input.compatibilityClass }),
    ...(input.gateStatus === undefined ? {} : { gateStatus: input.gateStatus }),
    ...(input.replayOutcome === undefined
      ? {}
      : { replayOutcome: input.replayOutcome }),
    ...(input.decisionHash === undefined
      ? {}
      : { decisionHash: input.decisionHash }),
    ...(input.runIds === undefined ? {} : { runIds: stableUnique(input.runIds) }),
    subjectRefs: stableUnique(input.subjectRefs),
    subjectHashes: stableUnique(subjectHashes),
    redactionClass: "operator",
    ...(input.metadata === undefined ? {} : { metadata: input.metadata })
  };

  return OperationAuditRecordSchema.parse(record);
}

export async function appendOperationAuditRecord(
  options: AppendOperationAuditRecordOptions
): Promise<OperationAuditRecord> {
  const record = OperationAuditRecordSchema.parse(options.record);
  const path = operationAuditPath({
    rootDir: options.rootDir,
    tenant: record.tenant
  });

  await mkdir(dirname(path), { recursive: true });
  await appendJsonLine(path, record);

  return record;
}

export async function readOperationAuditRecords(
  options: ReadOperationAuditRecordsOptions
): Promise<OperationAuditRecord[]> {
  const path = operationAuditPath(options);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => OperationAuditRecordSchema.parse(JSON.parse(line) as unknown));
}

export function operationAuditPath(options: {
  rootDir?: string | undefined;
  tenant: string;
}): string {
  const parsedTenant = tenantId.parse(options.tenant);

  return join(
    options.rootDir ?? ".",
    RUN_STORE_DIR,
    OPERATION_AUDIT_DIR,
    `${parsedTenant}.jsonl`
  );
}

export function hashOperationCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableOperationJson(value)).digest("hex")}`;
}

export function stableOperationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      const entry = record[key];

      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }

    return out;
  }

  return value;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isNodeError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
