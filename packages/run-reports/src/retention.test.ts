import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETENTION_RECORD_CLASSES,
  appendEvent,
  createRun,
  getRunStorePaths,
  type HarnessSnapshot
} from "@specwright/run-store";
import type { RunInput } from "@specwright/schemas";
import { recordTraceSpan } from "@specwright/trace-recorder";
import {
  RetentionGovernanceError,
  eraseUnderGovernance,
  readRetentionAuditRecords,
  scanRetention,
  writeRunReport,
  type RetentionApproval,
  type RetentionLegalHold,
  type RetentionPolicy
} from "./index";

const runInput = {
  task: "Retain a governed run package",
  harnessId: "default",
  host: {
    kind: "cli"
  }
} satisfies RunInput;

const harness = {
  id: "default",
  version: "0.0.0",
  specHash: "sha256:retention-governance"
} satisfies HarnessSnapshot;

const tenant = "tenant-a";
const staleStartedAt = "2026-06-01T00:00:00.000Z";
const staleCompletedAt = "2026-06-01T00:00:02.000Z";
const retentionNow = "2026-06-12T12:00:00.000Z";

const policy = {
  entries: RETENTION_RECORD_CLASSES.map((recordClass) => ({
    tenant,
    recordClass,
    windowDays: recordClass === "audit" ? 0 : 1,
    destroyingActionRetentionDays: 365
  }))
} satisfies RetentionPolicy;

const validApprovals = [
  {
    principal: "operator-a",
    approvedAt: "2026-06-12T11:55:00.000Z",
    decision: "approved"
  },
  {
    principal: "operator-b",
    approvedAt: "2026-06-12T11:56:00.000Z",
    decision: "approved"
  }
] satisfies RetentionApproval[];

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-retention-governance-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("retention governance", () => {
  test("scans deterministically, idempotently, and only within the supplied namespace", async () => {
    await createGovernedRun("run-stale-a");
    await createGovernedRun("run-stale-b");
    const otherRoot = await mkdtemp(join(tmpdir(), "specwright-other-tenant-"));

    try {
      await createGovernedRun("run-other-tenant", otherRoot);

      const first = await scanRetention({
        rootDir,
        tenant,
        policy,
        now: retentionNow
      });
      const second = await scanRetention({
        rootDir,
        tenant,
        policy,
        now: retentionNow
      });

      expect(first).toEqual(second);
      expect(first.classifications.map((item) => item.runId)).toEqual([
        "run-stale-a",
        "run-stale-b"
      ]);
      expect(first.eligibility.map((item) => `${item.runId}:${item.recordClass}`))
        .toEqual([
          "run-stale-a:reports",
          "run-stale-a:traces",
          "run-stale-b:reports",
          "run-stale-b:traces"
        ]);
      expect(JSON.stringify(first.eligibility)).toBe(
        JSON.stringify(second.eligibility)
      );
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("refuses unscoped scan and erasure with denial audit records", async () => {
    await createGovernedRun("run-unscoped");
    const scanError = await captureError(() =>
      scanRetention({
        rootDir,
        tenant: "",
        policy,
        now: retentionNow
      })
    );
    const eraseError = await captureError(() =>
      eraseUnderGovernance({
        rootDir,
        tenant: "",
        request: erasureRequest("run-unscoped", "traces", "erase-unscoped"),
        approvals: validApprovals,
        policy,
        now: retentionNow
      })
    );

    expectRetentionError(scanError, "unscoped_request");
    expectRetentionError(eraseError, "unscoped_request");
    expect((scanError as RetentionGovernanceError).auditRecords[0]).toMatchObject({
      outcome: "refused_unscoped",
      failureClass: 2
    });
    expect((eraseError as RetentionGovernanceError).auditRecords[0]).toMatchObject({
      outcome: "refused_unscoped",
      failureClass: 2
    });
  });

  test("active legal hold suppresses scan eligibility, refuses erasure, audits conflict, and preserves bytes", async () => {
    const runId = "run-held";
    await createGovernedRun(runId);
    const paths = getRunStorePaths(rootDir, runId);
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeDecisions = await readFile(paths.decisionsPath, "utf8");
    const beforeTrace = await readFile(paths.tracePath, "utf8");
    const legalHolds = [
      {
        holdId: "hold-litigation",
        tenant,
        runIds: [runId],
        recordClasses: ["traces"],
        reason: "litigation hold",
        placedAt: "2026-06-10T00:00:00.000Z"
      }
    ] satisfies RetentionLegalHold[];

    const scan = await scanRetention({
      rootDir,
      tenant,
      policy,
      legalHolds,
      now: retentionNow
    });
    const error = await captureError(() =>
      eraseUnderGovernance({
        rootDir,
        tenant,
        request: erasureRequest(runId, "traces", "erase-held"),
        approvals: validApprovals,
        policy,
        legalHolds,
        now: retentionNow
      })
    );

    expect(
      scan.eligibility.find((item) => item.runId === runId && item.recordClass === "traces")
    ).toMatchObject({
      suppressedByLegalHold: true,
      legalHoldIds: ["hold-litigation"]
    });
    expectRetentionError(error, "legal_hold_active");
    expect((error as RetentionGovernanceError).auditRecords[0]).toMatchObject({
      outcome: "refused_legal_hold",
      failureClass: 12
    });
    expect(await readFile(paths.eventsPath, "utf8")).toBe(beforeEvents);
    expect(await readFile(paths.decisionsPath, "utf8")).toBe(beforeDecisions);
    expect(await readFile(paths.tracePath, "utf8")).toBe(beforeTrace);
  });

  test("single-control and expired approvals are refused and audited", async () => {
    await createGovernedRun("run-single-control");
    const error = await captureError(() =>
      eraseUnderGovernance({
        rootDir,
        tenant,
        request: erasureRequest("run-single-control", "traces", "erase-single"),
        approvals: [
          {
            principal: "operator-a",
            approvedAt: "2026-06-12T11:55:00.000Z",
            decision: "approved"
          },
          {
            principal: "operator-b",
            approvedAt: "2026-06-01T00:00:00.000Z",
            decision: "approved",
            expiresAt: "2026-06-02T00:00:00.000Z"
          }
        ],
        policy,
        now: retentionNow
      })
    );

    expectRetentionError(error, "single_control_refused");
    expect((error as RetentionGovernanceError).auditRecords[0]).toMatchObject({
      outcome: "refused_single_control",
      failureClass: 6
    });
  });

  test("future-dated approvals do not satisfy dual control", async () => {
    await createGovernedRun("run-future-approval");
    const error = await captureError(() =>
      eraseUnderGovernance({
        rootDir,
        tenant,
        request: erasureRequest("run-future-approval", "traces", "erase-future"),
        approvals: [
          {
            principal: "operator-a",
            approvedAt: "2026-06-13T00:00:00.000Z",
            decision: "approved"
          },
          {
            principal: "operator-b",
            approvedAt: "2026-06-13T00:01:00.000Z",
            decision: "approved"
          }
        ],
        policy,
        now: retentionNow
      })
    );

    expectRetentionError(error, "single_control_refused");
    expect((error as RetentionGovernanceError).auditRecords[0]).toMatchObject({
      outcome: "refused_single_control",
      failureClass: 6
    });
  });

  test("dual-control erasure writes tombstone evidence, emits audit, and never rewrites authoritative ledgers", async () => {
    const runId = "run-erased";
    await createGovernedRun(runId);
    const paths = getRunStorePaths(rootDir, runId);
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeDecisions = await readFile(paths.decisionsPath, "utf8");

    const erased = await eraseUnderGovernance({
      rootDir,
      tenant,
      request: erasureRequest(runId, "traces", "erase-traces"),
      approvals: validApprovals,
      policy,
      now: retentionNow
    });
    const tombstoneBytes = await readFile(paths.tracePath, "utf8");
    const tombstone = JSON.parse(tombstoneBytes) as Record<string, unknown>;
    const auditRecords = await readRetentionAuditRecords({ rootDir, tenant });
    const scanAfterErase = await scanRetention({
      rootDir,
      tenant,
      policy,
      now: retentionNow
    });
    const repeated = await eraseUnderGovernance({
      rootDir,
      tenant,
      request: erasureRequest(runId, "traces", "erase-traces-repeat"),
      approvals: validApprovals,
      policy,
      now: "2026-06-12T12:05:00.000Z"
    });

    expect(erased.outcome).toBe("erased");
    expect(tombstone).toMatchObject({
      recordKind: "ops.retention.record_class_tombstone",
      tenant,
      runId,
      recordClass: "traces",
      approvers: ["operator-a", "operator-b"],
      reason: "delete expired restricted trace projection"
    });
    expect(tombstoneBytes).not.toContain("sk_live_retention_packet_05");
    expect(await readFile(paths.eventsPath, "utf8")).toBe(beforeEvents);
    expect(await readFile(paths.decisionsPath, "utf8")).toBe(beforeDecisions);
    expect(auditRecords.some((record) =>
      record.outcome === "erased" &&
      record.destroyingAction &&
      record.retainedUntil === "2027-06-12T12:00:00.000Z"
    )).toBe(true);
    expect(scanAfterErase.eligibility.some((item) =>
      item.recordClass === "audit" &&
      item.runId === runId
    )).toBe(false);
    expect(repeated.outcome).toBe("noop_already_tombstoned");
    expect(repeated.tombstone).toEqual(erased.tombstone);
  });
});

async function createGovernedRun(runId: string, targetRoot = rootDir) {
  await createRun({
    rootDir: targetRoot,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    timestamp: staleStartedAt
  });
  await appendEvent({
    rootDir: targetRoot,
    runId,
    type: "phase.entered",
    payload: {
      phase: "retention"
    },
    timestamp: "2026-06-01T00:00:01.000Z"
  });
  await appendEvent({
    rootDir: targetRoot,
    runId,
    type: "run.completed",
    payload: {
      reason: "done"
    },
    timestamp: staleCompletedAt
  });
  await recordTraceSpan({
    rootDir: targetRoot,
    runId,
    span: {
      kind: "tool",
      name: "tool.fs.read",
      status: "success",
      startedAt: "2026-06-01T00:00:01.000Z",
      durationMs: 5,
      eventIds: [],
      metadata: {
        toolId: "fs.read",
        toolCallId: `tool-${runId}`,
        phaseId: "retention",
        cacheStatus: "bypass",
        policyStatus: "allow",
        output: "sk_live_retention_packet_05"
      }
    }
  });
  await writeRunReport({
    rootDir: targetRoot,
    runId,
    tenantScope: tenant
  });
}

function erasureRequest(
  runId: string,
  recordClass: "traces" | "reports",
  requestId: string
) {
  return {
    requestId,
    requestedBy: "operator-requester",
    target: {
      runId,
      recordClass
    },
    reason: `delete expired restricted ${recordClass === "traces" ? "trace projection" : "report projection"}`
  };
}

function expectRetentionError(
  error: unknown,
  code: RetentionGovernanceError["code"]
) {
  expect(error).toBeInstanceOf(RetentionGovernanceError);
  expect((error as RetentionGovernanceError).code).toBe(code);
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
