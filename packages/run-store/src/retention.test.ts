import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEvent,
  archiveRun,
  classifyRunPackageRecords,
  computeRetentionState,
  createRun,
  enumerateRunPackageNamespace,
  getArchivedRunStorePaths,
  getRunStorePaths,
  hardDeleteRun,
  materializeRunState,
  placeLegalHold,
  RUN_PACKAGE_RECORD_TOMBSTONE_VERSION,
  RunPackageRecordTombstoneSchema,
  readAdministrationLog,
  readEvents,
  recordApproval,
  restoreRun,
  RunStoreError,
  runScopeForRun,
  sealRun,
  verifyRunIntegrity,
  writeRunPackageRecordTombstone,
  type AdministrationOperation,
  type AdministrationRunScope,
  type HarnessSnapshot,
  type RetentionDescriptor
} from "./index";
import { RunStateSchema, type RunInput, type RunState } from "@specwright/schemas";

const runInput = {
  task: "Retain a terminal package",
  harnessId: "default",
  host: {
    kind: "cli"
  }
} satisfies RunInput;

const harness = {
  id: "default",
  version: "0.0.0",
  specHash: "sha256:retention"
} satisfies HarnessSnapshot;

const eligibleDescriptor = {
  descriptorId: "retention-test-eligible",
  retentionClass: "retention-test",
  archiveAfterMs: 1_000,
  expireAfterMs: 10_000
} satisfies RetentionDescriptor;

const expiredDescriptor = {
  descriptorId: "retention-test-expired",
  retentionClass: "retention-test",
  archiveAfterMs: 1_000,
  expireAfterMs: 2_000
} satisfies RetentionDescriptor;

const sealedAt = "2026-06-01T00:00:00.000Z";
const archiveEligibleAt = "2026-06-01T00:00:02.000Z";
const expiredAt = "2026-06-01T00:00:03.000Z";
const fixtureRunId = "fixture-retention-eligible";
const fixturesDir = fileURLToPath(
  new URL("../fixtures/retention/", import.meta.url)
);

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-run-store-retention-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("run package retention lifecycle", () => {
  test("terminal runs seal, non-terminal runs refuse, and sealing is idempotent", async () => {
    await createRun({
      rootDir,
      runId: "run-seal-refuses-running",
      traceId: "trace-run-seal-refuses-running",
      input: runInput,
      harness,
      timestamp: "2026-06-01T00:00:00.000Z"
    });

    const nonTerminalError = await captureError(() =>
      sealRun({
        rootDir,
        runId: "run-seal-refuses-running",
        sealedAt
      })
    );

    expectRunStoreError(nonTerminalError, "not_terminal");

    await createTerminalRun("run-seal-completed");
    const sealed = await sealRun({
      rootDir,
      runId: "run-seal-completed",
      sealedAt,
      recordId: "seal-completed-record"
    });
    const repeated = await sealRun({
      rootDir,
      runId: "run-seal-completed",
      sealedAt
    });
    const paths = getRunStorePaths(rootDir, "run-seal-completed");
    const sealRecord = JSON.parse(await readFile(paths.sealPath, "utf8"));
    const marker = JSON.parse(await readFile(paths.readMostlyPath, "utf8"));
    const records = await readAdministrationLog({ rootDir });

    expect(sealed.idempotent).toBe(false);
    expect(repeated.idempotent).toBe(true);
    expect(sealRecord).toMatchObject({
      runId: "run-seal-completed",
      sealedAt,
      sealedStatus: "completed",
      integrityHead: sealed.record.integrityHead
    });
    expect(marker).toMatchObject({
      runId: "run-seal-completed",
      readMostly: true,
      integrityHead: sealed.record.integrityHead
    });
    expect(records.filter((record) => record.operation === "retention_seal"))
      .toHaveLength(1);
  });

  test("sealed append fails before writing event bytes", async () => {
    await createSealedTerminalRun("run-sealed-append");
    const paths = getRunStorePaths(rootDir, "run-sealed-append");
    const beforeEvents = await readFile(paths.eventsPath, "utf8");

    const error = await captureError(() =>
      appendEvent({
        rootDir,
        runId: "run-sealed-append",
        type: "phase.entered",
        payload: {
          phase: "too-late"
        }
      })
    );
    const afterEvents = await readFile(paths.eventsPath, "utf8");

    expectRunStoreError(error, "run_sealed");
    expect(afterEvents).toBe(beforeEvents);
  });

  test("retention state uses the injected clock and active legal holds dominate", async () => {
    await createSealedTerminalRun("run-retention-state");

    expect(
      await computeRetentionState({
        rootDir,
        runId: "run-retention-state",
        descriptor: eligibleDescriptor,
        now: "2026-06-01T00:00:00.500Z"
      })
    ).toMatchObject({
      status: "sealed"
    });
    expect(
      await computeRetentionState({
        rootDir,
        runId: "run-retention-state",
        descriptor: eligibleDescriptor,
        now: archiveEligibleAt
      })
    ).toMatchObject({
      status: "archive_eligible"
    });

    await placeLegalHold({
      rootDir,
      runId: "run-retention-state",
      holdId: "hold-retention-state",
      placedBy: "operator-a",
      reason: "legal review",
      placedAt: "2026-06-01T00:00:01.000Z"
    });

    expect(
      await computeRetentionState({
        rootDir,
        runId: "run-retention-state",
        descriptor: expiredDescriptor,
        now: expiredAt
      })
    ).toMatchObject({
      status: "held"
    });
  });

  test("legal hold blocks archive and hard delete, records conflicts, and preserves bytes", async () => {
    const runId = "run-held-retention";
    await createSealedTerminalRun(runId);
    await placeLegalHold({
      rootDir,
      runId,
      holdId: "hold-litigation",
      placedBy: "operator-a",
      reason: "litigation hold",
      placedAt: "2026-06-01T00:00:01.000Z"
    });
    const runScope = await runScopeForRun({ rootDir, runId });
    const before = await packageBytes(runId);

    await approve("approval-held-archive", "archive", runScope);
    const archiveError = await captureError(() =>
      archiveRun({
        rootDir,
        runId,
        actor: "operator-a",
        approvalId: "approval-held-archive",
        descriptor: eligibleDescriptor,
        now: archiveEligibleAt,
        recordIds: {
          denial: "held-archive-denial"
        }
      })
    );

    await approve("approval-held-delete", "hard_delete", runScope);
    const deleteError = await captureError(() =>
      hardDeleteRun({
        rootDir,
        runId,
        actor: "operator-a",
        approvalId: "approval-held-delete",
        descriptor: expiredDescriptor,
        now: expiredAt,
        recordIds: {
          denial: "held-delete-denial"
        }
      })
    );
    const after = await packageBytes(runId);
    const denialRecords = (await readAdministrationLog({ rootDir })).filter(
      (record) => record.recordKind === "denial"
    );

    expectRunStoreError(archiveError, "legal_hold_active");
    expectRunStoreError(deleteError, "legal_hold_active");
    expect(after).toEqual(before);
    expect(denialRecords.map((record) => record.result.code)).toEqual([
      "legal_hold_active",
      "legal_hold_active"
    ]);
  });

  test("archive requires approval, then preserves events bytes, leaves tombstone, audits, and restores deterministically", async () => {
    await copyFixtureRun(fixtureRunId);
    const expected = await readExpectedState(fixtureRunId);
    const paths = getRunStorePaths(rootDir, fixtureRunId);
    const archivePaths = getArchivedRunStorePaths(rootDir, fixtureRunId);
    await sealRun({
      rootDir,
      runId: fixtureRunId,
      sealedAt,
      recordId: "fixture-seal-record"
    });
    const runScope = await runScopeForRun({ rootDir, runId: fixtureRunId });
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");

    const approvalError = await captureError(() =>
      archiveRun({
        rootDir,
        runId: fixtureRunId,
        actor: "operator-a",
        descriptor: eligibleDescriptor,
        now: archiveEligibleAt
      })
    );

    expectRunStoreError(approvalError, "approval_required");
    expect(await readFile(paths.eventsPath, "utf8")).toBe(beforeEvents);
    expect(await readFile(paths.statePath, "utf8")).toBe(beforeState);

    await approve("approval-archive-fixture", "archive", runScope);
    const archived = await archiveRun({
      rootDir,
      runId: fixtureRunId,
      actor: "operator-a",
      approvalId: "approval-archive-fixture",
      descriptor: eligibleDescriptor,
      now: archiveEligibleAt,
      archivedAt: archiveEligibleAt,
      recordIds: {
        preOperation: "archive-fixture-pre",
        postOperation: "archive-fixture-post"
      }
    });
    const tombstone = JSON.parse(await readFile(paths.tombstonePath, "utf8"));
    const archivedEvents = await readFile(archivePaths.eventsPath, "utf8");
    const recordsAfterArchive = await readAdministrationLog({ rootDir });

    expect(archived.value.eventsHashBefore).toBe(hashBytes(beforeEvents));
    expect(archived.value.eventsHashAfter).toBe(hashBytes(beforeEvents));
    expect(archivedEvents).toBe(beforeEvents);
    expect(tombstone).toMatchObject({
      runId: fixtureRunId,
      integrityHead: archived.value.manifest.integrityHead
    });
    expect(recordsAfterArchive.some((record) =>
      record.operation === "archive" &&
      record.recordKind === "post_operation" &&
      record.result.status === "success"
    )).toBe(true);

    const restored = await restoreRun({
      rootDir,
      runId: fixtureRunId,
      actor: "operator-a",
      expectedState: expected,
      restoredAt: "2026-06-01T00:00:03.000Z",
      recordId: "restore-fixture-record"
    });
    const restoredIntegrity = await verifyRunIntegrity({ rootDir, runId: fixtureRunId });
    const firstReplay = await materializeRunState({ rootDir, runId: fixtureRunId });
    const secondReplay = await materializeRunState({ rootDir, runId: fixtureRunId });

    expect(restored.state).toEqual(expected);
    expect(restoredIntegrity).toMatchObject({
      status: "verified",
      headHash: archived.value.manifest.integrityHead
    });
    expect(JSON.stringify(firstReplay, null, 2)).toBe(
      JSON.stringify(secondReplay, null, 2)
    );
    expect(firstReplay).toEqual(expected);
  });

  test("hard delete requires approval, refuses non-expired runs, and deletes expired unheld packages with durable audit", async () => {
    const runId = "run-hard-delete-retention";
    await createSealedTerminalRun(runId);
    const runScope = await runScopeForRun({ rootDir, runId });
    const paths = getRunStorePaths(rootDir, runId);
    const before = await packageBytes(runId);

    const approvalError = await captureError(() =>
      hardDeleteRun({
        rootDir,
        runId,
        actor: "operator-a",
        descriptor: expiredDescriptor,
        now: expiredAt
      })
    );

    expectRunStoreError(approvalError, "approval_required");
    expect(await packageBytes(runId)).toEqual(before);

    await approve("approval-delete-too-early", "hard_delete", runScope);
    const tooEarlyError = await captureError(() =>
      hardDeleteRun({
        rootDir,
        runId,
        actor: "operator-a",
        approvalId: "approval-delete-too-early",
        descriptor: expiredDescriptor,
        now: "2026-06-01T00:00:01.500Z"
      })
    );

    expectRunStoreError(tooEarlyError, "retention_not_expired");
    expect(await packageBytes(runId)).toEqual(before);

    await approve("approval-delete-expired", "hard_delete", runScope);
    const deleted = await hardDeleteRun({
      rootDir,
      runId,
      actor: "operator-a",
      approvalId: "approval-delete-expired",
      descriptor: expiredDescriptor,
      now: expiredAt,
      recordIds: {
        preOperation: "hard-delete-retention-pre",
        postOperation: "hard-delete-retention-post"
      }
    });
    const readDeleted = await captureError(() => readEvents({ rootDir, runId }));
    const records = await readAdministrationLog({ rootDir });

    expect(deleted.value.deletedRunDir).toBe(paths.runDir);
    expectRunStoreError(readDeleted, "missing_events");
    expect(records.some((record) =>
      record.operation === "hard_delete" &&
      record.recordKind === "pre_operation" &&
      record.recordId === "hard-delete-retention-pre"
    )).toBe(true);
    expect(records.some((record) =>
      record.operation === "hard_delete" &&
      record.recordKind === "post_operation" &&
      record.recordId === "hard-delete-retention-post"
    )).toBe(true);
  });

  test("archive replay mismatch failure preserves original events and state bytes", async () => {
    const runId = "run-archive-replay-mismatch";
    await createSealedTerminalRun(runId);
    const runScope = await runScopeForRun({ rootDir, runId });
    const paths = getRunStorePaths(rootDir, runId);
    const before = await packageBytes(runId);
    const seal = JSON.parse(await readFile(paths.sealPath, "utf8"));

    await writeFile(
      paths.sealPath,
      `${JSON.stringify(
        {
          ...seal,
          state: {
            ...seal.state,
            phase: "mismatched-seal-state"
          }
        },
        null,
        2
      )}\n`
    );

    await approve("approval-replay-mismatch", "archive", runScope);
    const error = await captureError(() =>
      archiveRun({
        rootDir,
        runId,
        actor: "operator-a",
        approvalId: "approval-replay-mismatch",
        descriptor: eligibleDescriptor,
        now: archiveEligibleAt
      })
    );
    const after = await packageBytes(runId);
    const archivePaths = getArchivedRunStorePaths(rootDir, runId);

    expectRunStoreError(error, "invalid_projection");
    expect(after).toEqual(before);
    expect(await optionalFile(paths.tombstonePath)).toBeUndefined();
    expect(await optionalFile(archivePaths.eventsPath)).toBeUndefined();
  });

  test("classifies governed record classes and tombstones derived records without touching authoritative ledgers", async () => {
    const runId = "run-record-class-tombstone";
    await createTerminalRun(runId);
    const paths = getRunStorePaths(rootDir, runId);
    await writeFile(paths.summaryPath, "# Retention summary\n", "utf8");
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeDecisions = await readFile(paths.decisionsPath, "utf8");

    const namespace = await enumerateRunPackageNamespace({ rootDir });
    const beforeClassification = await classifyRunPackageRecords({
      rootDir,
      runId
    });
    const tombstone = RunPackageRecordTombstoneSchema.parse({
      tombstoneVersion: RUN_PACKAGE_RECORD_TOMBSTONE_VERSION,
      recordKind: "ops.retention.record_class_tombstone",
      tenant: "tenant-a",
      runId,
      recordClass: "traces",
      scope: {
        tenant: "tenant-a",
        runId,
        recordClass: "traces"
      },
      approvers: ["operator-a", "operator-b"],
      erasedAt: "2026-06-12T12:00:00.000Z",
      reason: "retention window expired",
      requestId: "erase-trace-record-class",
      policyWindowDays: 1
    });

    const written = await writeRunPackageRecordTombstone({
      rootDir,
      runId,
      recordClass: "traces",
      tombstone
    });
    const repeated = await writeRunPackageRecordTombstone({
      rootDir,
      runId,
      recordClass: "traces",
      tombstone: written.tombstone
    });
    const afterClassification = await classifyRunPackageRecords({
      rootDir,
      runId
    });
    const traceTombstone = JSON.parse(
      await readFile(paths.tracePath, "utf8")
    ) as unknown;

    expect(namespace.runIds).toContain(runId);
    expect(beforeClassification.records.map((record) => record.recordClass)).toEqual([
      "events",
      "decisions",
      "traces",
      "reports",
      "metrics",
      "audit"
    ]);
    expect(
      beforeClassification.records.find((record) => record.recordClass === "events")
    ).toMatchObject({
      authoritative: true,
      erasable: false,
      present: true
    });
    expect(
      beforeClassification.records.find((record) => record.recordClass === "traces")
    ).toMatchObject({
      authoritative: false,
      erasable: true,
      present: true,
      tombstoned: false
    });
    expect(written.status).toBe("written");
    expect(repeated.status).toBe("noop_already_tombstoned");
    expect(traceTombstone).toMatchObject({
      recordKind: "ops.retention.record_class_tombstone",
      recordClass: "traces",
      priorContentHash: written.priorContentHash
    });
    expect(
      afterClassification.records.find((record) => record.recordClass === "traces")
    ).toMatchObject({
      tombstoned: true
    });
    expect(await readFile(paths.eventsPath, "utf8")).toBe(beforeEvents);
    expect(await readFile(paths.decisionsPath, "utf8")).toBe(beforeDecisions);
  });
});

async function createTerminalRun(runId: string): Promise<RunState> {
  await createRun({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    timestamp: "2026-06-01T00:00:00.000Z"
  });
  const completed = await appendEvent({
    rootDir,
    runId,
    type: "run.completed",
    payload: {
      reason: "done"
    },
    timestamp: "2026-06-01T00:00:01.000Z"
  });

  return completed.state;
}

async function createSealedTerminalRun(runId: string) {
  await createTerminalRun(runId);
  await sealRun({
    rootDir,
    runId,
    sealedAt
  });
}

async function approve(
  approvalId: string,
  operation: AdministrationOperation,
  runScope: AdministrationRunScope
) {
  return recordApproval({
    rootDir,
    approvalId,
    operation,
    runScope,
    requestedBy: "operator-a",
    approvedBy: "operator-b",
    timestamp: "2026-06-01T00:00:01.000Z"
  });
}

async function copyFixtureRun(runId: string) {
  const paths = getRunStorePaths(rootDir, runId);
  await mkdir(paths.runsDir, { recursive: true });
  await copyDirectoryRecursive(join(fixturesDir, runId), paths.runDir);
}

async function readExpectedState(runId: string) {
  const state = JSON.parse(
    await readFile(join(fixturesDir, runId, "expected-state.json"), "utf8")
  ) as unknown;

  return RunStateSchema.parse(state);
}

async function packageBytes(runId: string) {
  const paths = getRunStorePaths(rootDir, runId);

  return {
    events: await readFile(paths.eventsPath, "utf8"),
    state: await readFile(paths.statePath, "utf8")
  };
}

async function optionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
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

function hashBytes(bytes: string) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function expectRunStoreError(error: unknown, code: RunStoreError["code"]) {
  expect(error).toBeInstanceOf(RunStoreError);
  expect((error as RunStoreError).code).toBe(code);
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
