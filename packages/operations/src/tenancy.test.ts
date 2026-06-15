import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TenancyError,
  crossTenantQuery,
  readOperationAuditRecords,
  runTenantScopedJob,
  tenantRootDir,
  type TenantScope
} from "./index";

const tenantA = {
  tenantId: "tenant-a",
  deploymentMode: "hosted-multi-tenant",
  actor: "operator-a",
  roles: ["operator"]
} satisfies TenantScope;

const tenantB = {
  tenantId: "tenant-b",
  deploymentMode: "hosted-multi-tenant",
  actor: "operator-a",
  roles: ["operator"]
} satisfies TenantScope;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-operations-tenancy-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("tenant partitioning", () => {
  test("rejects unscoped jobs, does not broaden, and audits the rejection", async () => {
    const error = await captureError(() =>
      runTenantScopedJob({
        rootDir,
        runId: "run-a",
        jobKind: "report_generation",
        actor: "operator-a",
        requestedAt: "2026-06-12T12:00:00.000Z",
        operation: async () => "should-not-run"
      })
    );
    const audit = await readOperationAuditRecords({
      rootDir,
      tenant: "unscoped"
    });

    expect(error).toBeInstanceOf(TenancyError);
    expect((error as TenancyError).code).toBe("unscoped_job");
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "tenant_job_rejected",
        outcome: "denied",
        reasonCode: "unscoped_job"
      })
    );
  });

  test("treats empty tenant ids as unscoped instead of broadening", async () => {
    const error = await captureError(() =>
      runTenantScopedJob({
        rootDir,
        tenantScope: {
          tenantId: "",
          deploymentMode: "hosted-multi-tenant"
        },
        runId: "run-a",
        jobKind: "retention_scan",
        actor: "operator-a",
        requestedAt: "2026-06-12T12:00:00.000Z",
        operation: async () => "should-not-run"
      })
    );

    expect(error).toBeInstanceOf(TenancyError);
    expect((error as TenancyError).code).toBe("unscoped_job");
  });

  test("partitions scoped jobs into the tenant namespace", async () => {
    const result = await runTenantScopedJob({
      rootDir,
      tenantScope: tenantA,
      runId: "run-a",
      jobKind: "report_generation",
      actor: "operator-a",
      requestedAt: "2026-06-12T12:00:00.000Z",
      operation: async ({ partition }) => partition.paths.runDir
    });

    expect(result.partition.rootDir).toBe(tenantRootDir(rootDir, "tenant-a"));
    expect(result.result).toContain(
      join("tenants", "tenant-a", ".specwright", "runs", "run-a")
    );
    expect(result.auditRecords[0]).toMatchObject({
      action: "tenant_job_completed",
      tenant: "tenant-a"
    });
  });

  test("cross-tenant access requires governance grant and audits both denial and success", async () => {
    const denied = await captureError(() =>
      crossTenantQuery({
        rootDir,
        tenantScopes: [tenantA, tenantB],
        actor: "operator-a",
        queryId: "fleet-health",
        requestedAt: "2026-06-12T12:00:00.000Z",
        redactedSeries: []
      })
    );

    expect(denied).toBeInstanceOf(TenancyError);
    expect((denied as TenancyError).code).toBe("cross_tenant_denied");

    const allowed = await crossTenantQuery({
      rootDir,
      tenantScopes: [tenantB, tenantA],
      actor: "operator-a",
      queryId: "fleet-health",
      requestedAt: "2026-06-12T12:00:00.000Z",
      grant: {
        role: "governance",
        actor: "operator-a",
        approvers: ["governor-a", "governor-b"],
        grantedAt: "2026-06-12T11:55:00.000Z",
        expiresAt: "2026-06-12T12:30:00.000Z",
        reason: "tenant-isolation tabletop"
      },
      redactedSeries: [
        {
          tenantId: "tenant-b",
          metricId: "reconciled-runs",
          value: 1,
          redactionClass: "operator",
          source: "redacted_aggregate",
          subjectHash: "sha256:tenant-b-series"
        },
        {
          tenantId: "tenant-a",
          metricId: "reconciled-runs",
          value: 2,
          redactionClass: "operator",
          source: "redacted_aggregate",
          subjectHash: "sha256:tenant-a-series"
        }
      ]
    });
    const tenantAAudit = await readOperationAuditRecords({
      rootDir,
      tenant: "tenant-a"
    });
    const tenantBAudit = await readOperationAuditRecords({
      rootDir,
      tenant: "tenant-b"
    });

    expect(allowed.targetTenants).toEqual(["tenant-a", "tenant-b"]);
    expect(allowed.series.map((item) => item.tenantId)).toEqual([
      "tenant-a",
      "tenant-b"
    ]);
    expect(JSON.stringify(allowed.series)).not.toContain("secret");
    expect(tenantAAudit).toContainEqual(
      expect.objectContaining({
        action: "cross_tenant_query_rejected",
        reasonCode: "cross_tenant_denied"
      })
    );
    expect(tenantAAudit).toContainEqual(
      expect.objectContaining({
        action: "cross_tenant_query",
        outcome: "allowed",
        approvers: ["governor-a", "governor-b"]
      })
    );
    expect(tenantBAudit).toContainEqual(
      expect.objectContaining({
        action: "cross_tenant_query",
        outcome: "allowed"
      })
    );
  });

  test("restricted cross-tenant aggregates are refused and audited", async () => {
    const error = await captureError(() =>
      crossTenantQuery({
        rootDir,
        tenantScopes: [tenantA, tenantB],
        actor: "operator-a",
        queryId: "raw-fleet-health",
        requestedAt: "2026-06-12T12:00:00.000Z",
        grant: {
          role: "governance",
          actor: "operator-a",
          approvers: ["governor-a", "governor-b"],
          grantedAt: "2026-06-12T11:55:00.000Z",
          reason: "attempt raw aggregate"
        },
        redactedSeries: [
          {
            tenantId: "tenant-a",
            metricId: "raw-secret-count",
            value: 1,
            redactionClass: "restricted",
            source: "redacted_aggregate",
            subjectHash: "sha256:tenant-a-series"
          }
        ]
      })
    );
    const audit = await readOperationAuditRecords({
      rootDir,
      tenant: "tenant-a"
    });

    expect(error).toBeInstanceOf(TenancyError);
    expect((error as TenancyError).code).toBe("invalid_tenant_aggregate");
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "cross_tenant_query_rejected",
        reasonCode: "invalid_tenant_aggregate"
      })
    );
  });

  test("governance grants are bound to the querying actor", async () => {
    const error = await captureError(() =>
      crossTenantQuery({
        rootDir,
        tenantScopes: [tenantA, tenantB],
        actor: "operator-a",
        queryId: "grant-reuse",
        requestedAt: "2026-06-12T12:00:00.000Z",
        grant: {
          role: "governance",
          actor: "operator-b",
          approvers: ["governor-a", "governor-b"],
          grantedAt: "2026-06-12T11:55:00.000Z",
          reason: "grant belongs to another operator"
        },
        redactedSeries: [
          {
            tenantId: "tenant-a",
            metricId: "reconciled-runs",
            value: 1,
            redactionClass: "operator",
            source: "redacted_aggregate",
            subjectHash: "sha256:tenant-a-series"
          }
        ]
      })
    );
    const audit = await readOperationAuditRecords({
      rootDir,
      tenant: "tenant-a"
    });

    expect(error).toBeInstanceOf(TenancyError);
    expect((error as TenancyError).code).toBe("cross_tenant_denied");
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "cross_tenant_query_rejected",
        reasonCode: "cross_tenant_denied"
      })
    );
  });
});

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
