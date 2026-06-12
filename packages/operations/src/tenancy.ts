import { join } from "node:path";
import { getRunStorePaths, RUN_STORE_DIR, type RunStorePaths } from "@specwright/run-store";
import {
  RedactionClassSchema,
  redactionClassAtLeast,
  type RedactionClass
} from "@specwright/schemas";
import { z } from "zod";
import {
  appendOperationAuditRecord,
  buildOperationAuditRecord,
  hashOperationCanonical,
  type OperationAuditRecord,
  type OperationJsonValue
} from "./audit";

export const DEPLOYMENT_MODES = [
  "embedded-single-tenant",
  "hosted-multi-tenant",
  "air-gapped-regulated"
] as const;

const nonEmptyString = z.string().min(1);
const tenantId = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/);
const isoTimestamp = z.string().datetime({ offset: true });

export const DeploymentModeSchema = z.enum(DEPLOYMENT_MODES);

export const TenantScopeSchema = z
  .object({
    tenantId,
    deploymentMode: DeploymentModeSchema,
    actor: nonEmptyString.optional(),
    roles: z.array(nonEmptyString).optional()
  })
  .strict();

export const GovernanceGrantSchema = z
  .object({
    role: z.literal("governance"),
    actor: nonEmptyString,
    approvers: z.tuple([nonEmptyString, nonEmptyString]),
    grantedAt: isoTimestamp,
    expiresAt: isoTimestamp.optional(),
    reason: nonEmptyString
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.approvers[0] === grant.approvers[1]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governance grant approvers must be distinct"
      });
    }

    if (
      grant.expiresAt !== undefined &&
      Date.parse(grant.expiresAt) < Date.parse(grant.grantedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "governance grant expiresAt must be >= grantedAt"
      });
    }
  });

export const TenantTaggedSeriesSchema = z
  .object({
    tenantId,
    metricId: nonEmptyString,
    value: z.number(),
    redactionClass: RedactionClassSchema,
    source: z.literal("redacted_aggregate"),
    subjectHash: nonEmptyString,
    sourceEventRange: z
      .object({
        firstSequence: z.number().int().nonnegative(),
        lastSequence: z.number().int().nonnegative(),
        eventCount: z.number().int().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((series, context) => {
    if (redactionClassAtLeast(series.redactionClass, "restricted")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cross-tenant aggregates must be already redacted"
      });
    }
  });

export type TenantScope = z.infer<typeof TenantScopeSchema>;
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;
export type GovernanceGrant = z.infer<typeof GovernanceGrantSchema>;
export type TenantTaggedSeries = z.infer<typeof TenantTaggedSeriesSchema>;

export type TenancyErrorCode =
  | "unscoped_job"
  | "invalid_tenant_scope"
  | "cross_tenant_denied"
  | "invalid_governance_grant"
  | "invalid_tenant_aggregate";

export class TenancyError extends Error {
  readonly code: TenancyErrorCode;
  readonly auditRecords: OperationAuditRecord[];

  constructor(
    code: TenancyErrorCode,
    message: string,
    auditRecords: OperationAuditRecord[] = [],
    cause?: unknown
  ) {
    super(message);
    this.name = "TenancyError";
    this.code = code;
    this.auditRecords = auditRecords;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type TenantPartition = {
  tenantId: string;
  rootDir: string;
  runsDir: string;
  runId: string;
  paths: RunStorePaths;
};

export type RequireTenantScopeOptions = {
  tenantScope?: unknown;
  jobKind?: string | undefined;
  actor?: string | undefined;
  requestedAt?: Date | string | undefined;
};

export type PartitionByTenantOptions = {
  rootDir?: string | undefined;
  tenantScope: TenantScope;
  runId: string;
};

export type RunTenantScopedJobOptions<TResult> = {
  rootDir?: string | undefined;
  tenantScope?: unknown;
  runId: string;
  jobKind: string;
  actor: string;
  requestedAt: Date | string;
  operation: (input: {
    tenantScope: TenantScope;
    partition: TenantPartition;
  }) => Promise<TResult>;
};

export type RunTenantScopedJobResult<TResult> = {
  tenantScope: TenantScope;
  partition: TenantPartition;
  result: TResult;
  auditRecords: OperationAuditRecord[];
};

export type CrossTenantQueryOptions = {
  rootDir?: string | undefined;
  tenantScopes: readonly TenantScope[];
  grant?: unknown;
  actor: string;
  queryId: string;
  requestedAt: Date | string;
  redactedSeries: readonly unknown[];
};

export type CrossTenantQueryResult = {
  targetTenants: string[];
  series: TenantTaggedSeries[];
  auditRecords: OperationAuditRecord[];
};

export function requireTenantScope(options: RequireTenantScopeOptions): TenantScope {
  const parsed = TenantScopeSchema.safeParse(options.tenantScope);

  if (!parsed.success) {
    const code = isEmptyTenantScope(options.tenantScope)
      ? "unscoped_job"
      : "invalid_tenant_scope";
    throw new TenancyError(
      code,
      `Operational job ${options.jobKind ?? "unknown"} requires a non-empty tenant scope`,
      [
        tenantAuditRecord({
          action: "tenant_job_rejected",
          outcome: "denied",
          tenant: "unscoped",
          actor: options.actor ?? "unknown",
          timestamp: toIso(options.requestedAt ?? new Date(0).toISOString()),
          reasonCode: code,
          subjectRefs: [`job:${options.jobKind ?? "unknown"}`]
        })
      ],
      parsed.error
    );
  }

  return parsed.data;
}

export function tenantRootDir(rootDir: string | undefined, tenant: string): string {
  const parsedTenant = tenantId.parse(tenant);

  return join(rootDir ?? ".", "tenants", parsedTenant);
}

export function partitionByTenant(options: PartitionByTenantOptions): TenantPartition {
  const scope = TenantScopeSchema.parse(options.tenantScope);
  const tenantRoot = tenantRootDir(options.rootDir, scope.tenantId);
  const paths = getRunStorePaths(tenantRoot, options.runId);

  return {
    tenantId: scope.tenantId,
    rootDir: tenantRoot,
    runsDir: join(tenantRoot, RUN_STORE_DIR, "runs"),
    runId: options.runId,
    paths
  };
}

export async function runTenantScopedJob<TResult>(
  options: RunTenantScopedJobOptions<TResult>
): Promise<RunTenantScopedJobResult<TResult>> {
  let scope: TenantScope;

  try {
    scope = requireTenantScope(options);
  } catch (error) {
    if (error instanceof TenancyError) {
      await appendAuditRecords(options.rootDir, error.auditRecords);
    }

    throw error;
  }

  const partition = partitionByTenant({
    rootDir: options.rootDir,
    tenantScope: scope,
    runId: options.runId
  });
  const result = await options.operation({
    tenantScope: scope,
    partition
  });
  const audit = tenantAuditRecord({
    action: "tenant_job_completed",
    outcome: "allowed",
    tenant: scope.tenantId,
    actor: options.actor,
    timestamp: toIso(options.requestedAt),
    reasonCode: "tenant_scoped_job",
    subjectRefs: [`job:${options.jobKind}`, `run:${options.runId}`],
    metadata: {
      deploymentMode: scope.deploymentMode
    }
  });

  await appendOperationAuditRecord({
    rootDir: options.rootDir,
    record: audit
  });

  return {
    tenantScope: scope,
    partition,
    result,
    auditRecords: [audit]
  };
}

export async function crossTenantQuery(
  options: CrossTenantQueryOptions
): Promise<CrossTenantQueryResult> {
  const parsedScopes = z.array(TenantScopeSchema).min(2).safeParse(options.tenantScopes);
  const timestamp = toIso(options.requestedAt);

  if (!parsedScopes.success) {
    const audit = tenantAuditRecord({
      action: "cross_tenant_query_rejected",
      outcome: "denied",
      tenant: "unscoped",
      actor: options.actor,
      timestamp,
      reasonCode: "invalid_tenant_scope",
      subjectRefs: [`cross-tenant-query:${options.queryId}`]
    });

    await appendOperationAuditRecord({
      rootDir: options.rootDir,
      record: audit
    });

    throw new TenancyError(
      "cross_tenant_denied",
      "Cross-tenant query requires at least two valid tenant scopes",
      [audit],
      parsedScopes.error
    );
  }

  const scopes = parsedScopes.data;
  const targetTenants = stableUnique(scopes.map((scope) => scope.tenantId));

  if (targetTenants.length < 2) {
    const audit = tenantAuditRecord({
      action: "cross_tenant_query_rejected",
      outcome: "denied",
      tenant: targetTenants[0] ?? "unscoped",
      targetTenants: targetTenants.length === 0 ? ["unscoped"] : targetTenants,
      actor: options.actor,
      timestamp,
      reasonCode: "cross_tenant_denied",
      subjectRefs: [`cross-tenant-query:${options.queryId}`]
    });

    await appendOperationAuditRecord({
      rootDir: options.rootDir,
      record: audit
    });

    throw new TenancyError(
      "cross_tenant_denied",
      "Cross-tenant query requires at least two distinct target tenants",
      [audit]
    );
  }

  const grant = GovernanceGrantSchema.safeParse(options.grant);

  if (
    !grant.success ||
    grant.data.actor !== options.actor ||
    Date.parse(grant.data.grantedAt) > Date.parse(timestamp) ||
    (grant.data.expiresAt !== undefined &&
      Date.parse(grant.data.expiresAt) <= Date.parse(timestamp))
  ) {
    const auditRecords = targetTenants.map((tenant) =>
      tenantAuditRecord({
        action: "cross_tenant_query_rejected",
        outcome: "denied",
        tenant,
        targetTenants,
        actor: options.actor,
        timestamp,
        reasonCode: "cross_tenant_denied",
        subjectRefs: [`cross-tenant-query:${options.queryId}`]
      })
    );

    await appendAuditRecords(options.rootDir, auditRecords);

    throw new TenancyError(
      "cross_tenant_denied",
      "Cross-tenant query requires an active governance grant with two distinct approvers",
      auditRecords,
      grant.success ? undefined : grant.error
    );
  }

  const parsedSeries = z.array(TenantTaggedSeriesSchema).safeParse(options.redactedSeries);

  if (!parsedSeries.success) {
    const auditRecords = targetTenants.map((tenant) =>
      tenantAuditRecord({
        action: "cross_tenant_query_rejected",
        outcome: "denied",
        tenant,
        targetTenants,
        actor: options.actor,
        timestamp,
        reasonCode: "invalid_tenant_aggregate",
        subjectRefs: [`cross-tenant-query:${options.queryId}`]
      })
    );

    await appendAuditRecords(options.rootDir, auditRecords);

    throw new TenancyError(
      "invalid_tenant_aggregate",
      "Cross-tenant query accepts only already-redacted tenant-tagged aggregates",
      auditRecords,
      parsedSeries.error
    );
  }

  const series = parsedSeries.data;
  const illegalTenant = series.find(
    (item) => !targetTenants.includes(item.tenantId)
  );

  if (illegalTenant !== undefined) {
    const auditRecords = targetTenants.map((tenant) =>
      tenantAuditRecord({
        action: "cross_tenant_query_rejected",
        outcome: "denied",
        tenant,
        targetTenants,
        actor: options.actor,
        timestamp,
        reasonCode: "cross_tenant_denied",
        subjectRefs: [
          `cross-tenant-query:${options.queryId}`,
          `tenant:${illegalTenant.tenantId}`
        ]
      })
    );

    await appendAuditRecords(options.rootDir, auditRecords);

    throw new TenancyError(
      "cross_tenant_denied",
      `Cross-tenant aggregate included unauthorized tenant ${illegalTenant.tenantId}`,
      auditRecords
    );
  }

  const sortedSeries = [...series].sort((left, right) =>
    `${left.tenantId}\u0000${left.metricId}`.localeCompare(
      `${right.tenantId}\u0000${right.metricId}`
    )
  );
  const auditRecords = targetTenants.map((tenant) =>
    tenantAuditRecord({
      action: "cross_tenant_query",
      outcome: "allowed",
      tenant,
      targetTenants,
      actor: options.actor,
      timestamp,
      reasonCode: "governance_cross_tenant_query",
      approvers: grant.data.approvers,
      subjectRefs: [`cross-tenant-query:${options.queryId}`],
      metadata: {
        seriesCount: sortedSeries.length,
        grantReason: grant.data.reason
      }
    })
  );

  await appendAuditRecords(options.rootDir, auditRecords);

  return {
    targetTenants,
    series: sortedSeries,
    auditRecords
  };
}

function tenantAuditRecord(input: {
  action: OperationAuditRecord["action"];
  outcome: OperationAuditRecord["outcome"];
  tenant: string;
  actor: string;
  timestamp: string;
  reasonCode: string;
  targetTenants?: string[] | undefined;
  approvers?: readonly [string, string] | string[] | undefined;
  subjectRefs: string[];
  metadata?: Record<string, OperationJsonValue> | undefined;
}) {
  return buildOperationAuditRecord({
    ...input,
    targetTenants: input.targetTenants ?? [input.tenant],
    approvers: input.approvers === undefined ? undefined : [...input.approvers],
    subjectHashes: input.subjectRefs.map((ref) => hashOperationCanonical(ref))
  });
}

async function appendAuditRecords(
  rootDir: string | undefined,
  records: readonly OperationAuditRecord[]
) {
  for (const record of records) {
    await appendOperationAuditRecord({
      rootDir,
      record
    });
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isEmptyTenantScope(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }

  if (typeof value === "object" && value !== null && "tenantId" in value) {
    const tenant = (value as { tenantId?: unknown }).tenantId;

    return typeof tenant === "string" && tenant.trim().length === 0;
  }

  return false;
}

export type { RedactionClass };
