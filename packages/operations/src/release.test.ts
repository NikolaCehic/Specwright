import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  createRun,
  getRunStorePaths,
  type HarnessSnapshot
} from "@specwright/run-store";
import type { RunInput } from "@specwright/schemas";
import { recordTraceSpan } from "@specwright/trace-recorder";
import {
  ReleaseError,
  evaluateRelease,
  promoteRelease,
  readOperationAuditRecords,
  readTenantReleaseState,
  rollbackRelease,
  tenantRootDir,
  type ReleaseApproval,
  type TenantScope
} from "./index";

const tenant = {
  tenantId: "tenant-a",
  deploymentMode: "hosted-multi-tenant",
  actor: "release-operator",
  roles: ["release"]
} satisfies TenantScope;

const runInput = {
  task: "Replay a historical governed run",
  harnessId: "default",
  host: {
    kind: "cli"
  }
} satisfies RunInput;

const harness = {
  id: "default",
  version: "0.0.0",
  specHash: "sha256:operations-release"
} satisfies HarnessSnapshot;

const approval = {
  approvalId: "approval-release-1",
  principal: "release-approver",
  approvedAt: "2026-06-12T11:55:00.000Z",
  decision: "approved",
  expiresAt: "2026-06-12T12:30:00.000Z"
} satisfies ReleaseApproval;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-operations-release-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("release compatibility gate", () => {
  test("promotes compatible releases with audit, deterministic replay, and untouched ledgers", async () => {
    const tenantRoot = tenantRootDir(rootDir, tenant.tenantId);
    await createAuditableRun(tenantRoot, "run-promotable");
    const paths = getRunStorePaths(tenantRoot, "run-promotable");
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeDecisions = await readFile(paths.decisionsPath, "utf8");

    const verdict = await evaluateRelease({
      rootDir,
      releaseId: "release-0.1.1",
      deployedVersion: "0.1.0",
      candidateVersion: "0.1.1",
      targetTenant: tenant,
      tenantTier: "production",
      requestedAt: "2026-06-12T12:00:00.000Z",
      changes: [
        {
          changeId: "optional-release-metadata",
          kind: "optional-span-metadata",
          description: "Attach optional release metadata to operation spans"
        }
      ],
      fixtures: [
        {
          fixtureId: "fixture-promotable",
          rootDir: tenantRoot,
          runId: "run-promotable",
          recordedVersion: "0.1.0"
        }
      ]
    });
    const repeated = await evaluateRelease({
      rootDir,
      releaseId: "release-0.1.1",
      deployedVersion: "0.1.0",
      candidateVersion: "0.1.1",
      targetTenant: tenant,
      tenantTier: "production",
      requestedAt: "2026-06-12T12:00:00.000Z",
      changes: [
        {
          changeId: "optional-release-metadata",
          kind: "optional-span-metadata",
          description: "Attach optional release metadata to operation spans"
        }
      ],
      fixtures: [
        {
          fixtureId: "fixture-promotable",
          rootDir: tenantRoot,
          runId: "run-promotable",
          recordedVersion: "0.1.0"
        }
      ]
    });

    expect(verdict.status).toBe("promotable");
    expect(verdict.replayResults).toContainEqual(
      expect.objectContaining({
        fixtureId: "fixture-promotable",
        status: "passed",
        reconciliationVerdict: "consistent"
      })
    );
    expect(verdict.decisionHash).toBe(repeated.decisionHash);

    const promoted = await promoteRelease({
      rootDir,
      verdict,
      approval,
      actor: "release-operator",
      promotedAt: "2026-06-12T12:01:00.000Z"
    });
    const state = await readTenantReleaseState({
      rootDir,
      tenant: tenant.tenantId
    });
    const audit = await readOperationAuditRecords({
      rootDir,
      tenant: tenant.tenantId
    });

    expect(promoted.deployedVersion).toBe("0.1.1");
    expect(state?.deployedVersion).toBe("0.1.1");
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "release_promotion",
        outcome: "promoted",
        releaseId: "release-0.1.1",
        compatibilityClass: "additive-compatible",
        gateStatus: "promotable",
        replayOutcome: "passed",
        approver: "release-approver"
      })
    );

    await rollbackRelease({
      rootDir,
      targetTenant: tenant,
      toVersion: "0.1.0",
      approval,
      actor: "release-operator",
      rolledBackAt: "2026-06-12T12:02:00.000Z",
      reason: "tabletop rollback"
    });
    const rolledBack = await readTenantReleaseState({
      rootDir,
      tenant: tenant.tenantId
    });

    expect(rolledBack?.deployedVersion).toBe("0.1.0");
    expect(await readFile(paths.eventsPath, "utf8")).toBe(beforeEvents);
    expect(await readFile(paths.decisionsPath, "utf8")).toBe(beforeDecisions);
  });

  test("blocks replay failures and incompatible releases, and rejects rollback without approval", async () => {
    const tenantRoot = tenantRootDir(rootDir, tenant.tenantId);
    await createAuditableRun(tenantRoot, "run-good");
    await createRunWithoutTrace(tenantRoot, "run-missing-trace");

    const replayBlocked = await evaluateRelease({
      rootDir,
      releaseId: "release-replay-blocked",
      deployedVersion: "0.1.0",
      candidateVersion: "0.1.1",
      targetTenant: tenant,
      tenantTier: "production",
      requestedAt: "2026-06-12T12:00:00.000Z",
      changes: [],
      fixtures: [
        {
          fixtureId: "fixture-missing-trace",
          rootDir: tenantRoot,
          runId: "run-missing-trace",
          recordedVersion: "0.1.0"
        }
      ]
    });
    const incompatible = await evaluateRelease({
      rootDir,
      releaseId: "release-breaking",
      deployedVersion: "0.1.0",
      candidateVersion: "1.0.0",
      targetTenant: tenant,
      tenantTier: "production",
      requestedAt: "2026-06-12T12:00:00.000Z",
      changes: [
        {
          changeId: "weaken-tenant-boundary",
          kind: "tenancy-isolation-weakening",
          description: "Allow unscoped release jobs"
        }
      ],
      fixtures: [
        {
          fixtureId: "fixture-good",
          rootDir: tenantRoot,
          runId: "run-good",
          recordedVersion: "0.1.0"
        }
      ]
    });
    const replayPromoteError = await captureError(() =>
      promoteRelease({
        rootDir,
        verdict: replayBlocked,
        approval,
        actor: "release-operator",
        promotedAt: "2026-06-12T12:01:00.000Z"
      })
    );
    const incompatiblePromoteError = await captureError(() =>
      promoteRelease({
        rootDir,
        verdict: incompatible,
        approval,
        actor: "release-operator",
        promotedAt: "2026-06-12T12:01:00.000Z"
      })
    );
    const rollbackError = await captureError(() =>
      rollbackRelease({
        rootDir,
        targetTenant: tenant,
        toVersion: "0.1.0",
        actor: "release-operator",
        rolledBackAt: "2026-06-12T12:02:00.000Z",
        reason: "missing approval"
      })
    );
    const forgedPromotableError = await captureError(() =>
      promoteRelease({
        rootDir,
        verdict: {
          ...incompatible,
          status: "promotable",
          blockReasons: []
        },
        approval,
        actor: "release-operator",
        promotedAt: "2026-06-12T12:03:00.000Z"
      })
    );
    const audit = await readOperationAuditRecords({
      rootDir,
      tenant: tenant.tenantId
    });

    expect(replayBlocked).toMatchObject({
      status: "blocked",
      blockReasons: ["replay_failed:fixture-missing-trace"]
    });
    expect(incompatible).toMatchObject({
      status: "blocked",
      compatibilityClass: "breaking",
      blockReasons: ["incompatible:breaking"]
    });
    expect(replayPromoteError).toBeInstanceOf(ReleaseError);
    expect((replayPromoteError as ReleaseError).code).toBe("replay_failed");
    expect(incompatiblePromoteError).toBeInstanceOf(ReleaseError);
    expect((incompatiblePromoteError as ReleaseError).code).toBe(
      "incompatible_release"
    );
    expect(rollbackError).toBeInstanceOf(ReleaseError);
    expect((rollbackError as ReleaseError).code).toBe("approval_required");
    expect(forgedPromotableError).toBeInstanceOf(ReleaseError);
    expect((forgedPromotableError as ReleaseError).code).toBe(
      "incompatible_release"
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "release_promotion_rejected",
        reasonCode: "replay_failed"
      })
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "release_promotion_rejected",
        reasonCode: "incompatible_release"
      })
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "release_rollback_rejected",
        reasonCode: "approval_required"
      })
    );
  });
});

async function createAuditableRun(root: string, runId: string) {
  await createRun({
    rootDir: root,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    timestamp: "2026-06-01T00:00:00.000Z"
  });
  const phase = await appendEvent({
    rootDir: root,
    runId,
    type: "phase.entered",
    payload: {
      phase: "planning"
    },
    timestamp: "2026-06-01T00:00:01.000Z"
  });

  await appendEvent({
    rootDir: root,
    runId,
    type: "run.completed",
    payload: {
      reason: "done"
    },
    timestamp: "2026-06-01T00:00:02.000Z"
  });
  await recordTraceSpan({
    rootDir: root,
    runId,
    traceId: `trace-${runId}`,
    runtimeVersion: "0.1.0",
    harnessSpecHash: harness.specHash,
    hostAdapter: "cli",
    span: {
      kind: "phase",
      name: "phase.planning",
      status: "success",
      startedAt: "2026-06-01T00:00:01.000Z",
      durationMs: 1,
      eventIds: [phase.event.id],
      metadata: {
        phaseId: "planning"
      }
    }
  });
}

async function createRunWithoutTrace(root: string, runId: string) {
  await createRun({
    rootDir: root,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    timestamp: "2026-06-01T00:00:00.000Z"
  });
  await appendEvent({
    rootDir: root,
    runId,
    type: "phase.entered",
    payload: {
      phase: "planning"
    },
    timestamp: "2026-06-01T00:00:01.000Z"
  });
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
