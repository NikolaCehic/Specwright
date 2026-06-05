import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_STORE_BASELINE_VERSION,
  RUN_STORE_CURRENT_VERSION,
  RUN_STORE_TOOL_ARTIFACT_ADDITIVE_REDUCER_ID,
  RunStoreError,
  getRunStorePaths,
  materializeRunState,
  migrateCohort,
  migrateRunPackage,
  type MigrationDescriptor
} from "./index";
import { RunStateSchema, type RunState, type RuntimeEvent } from "@specwright/schemas";

const fixturesDir = fileURLToPath(
  new URL("../fixtures/migration/", import.meta.url)
);

const additiveRunId = "fixture-migration-additive";
const incompatibleRunId = "fixture-migration-incompatible";
const brokenIntegrityRunId = "fixture-migration-broken-integrity";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-run-store-migration-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("run package migration", () => {
  test("applies a declared descriptor to an older fixture cohort and verifies expected state", async () => {
    await copyFixtureRun(additiveRunId);
    const expected = await readExpectedState(additiveRunId);

    const cohort = await migrateCohort({
      rootDir,
      runIds: [additiveRunId],
      descriptor: additiveProjectionDescriptor,
      expectedStates: {
        [additiveRunId]: expected
      },
      migratedAt: "2026-06-01T00:00:00.000Z"
    });

    expect(cohort.results).toHaveLength(1);
    expect(cohort.results[0]?.status).toBe("migrated");

    const result = cohort.results[0];

    if (result?.status !== "migrated") {
      throw new Error("Expected migrated cohort result");
    }

    expect(result.fromVersion).toEqual(RUN_STORE_BASELINE_VERSION);
    expect(result.toVersion).toEqual(RUN_STORE_CURRENT_VERSION);
    expect(result.record).toMatchObject({
      migrationId: additiveProjectionDescriptor.migrationId,
      compatibilityClass: "additive-projection",
      compatibilityReducerId: RUN_STORE_TOOL_ARTIFACT_ADDITIVE_REDUCER_ID,
      integrityBefore: {
        status: "unchained",
        eventCount: 4
      },
      integrityAfter: {
        status: "unchained",
        eventCount: 4
      },
      coveredSequenceRange: {
        from: 0,
        to: 3
      }
    });
    expect(result.state).toEqual(expected);
    expect(RunStateSchema.safeParse(result.state).success).toBe(true);

    const paths = getRunStorePaths(rootDir, additiveRunId);
    const versionRecord = JSON.parse(await readFile(paths.versionPath, "utf8"));
    const migrationRecord = JSON.parse(
      (await readFile(paths.migrationsPath, "utf8")).trim()
    );

    expect(versionRecord.version).toEqual(RUN_STORE_CURRENT_VERSION);
    expect(versionRecord.migrationId).toBe(
      additiveProjectionDescriptor.migrationId
    );
    expect(migrationRecord.migrationId).toBe(
      additiveProjectionDescriptor.migrationId
    );
  });

  test("keeps authoritative events bytes unchanged after successful migration", async () => {
    await copyFixtureRun(additiveRunId);
    const expected = await readExpectedState(additiveRunId);
    const paths = getRunStorePaths(rootDir, additiveRunId);
    const beforeEvents = await readFile(paths.eventsPath, "utf8");

    const result = await migrateRunPackage({
      rootDir,
      runId: additiveRunId,
      descriptor: additiveProjectionDescriptor,
      expectedState: expected,
      migratedAt: "2026-06-01T00:00:00.000Z"
    });
    const afterEvents = await readFile(paths.eventsPath, "utf8");

    expect(result.status).toBe("migrated");
    expect(hashBytes(afterEvents)).toBe(hashBytes(beforeEvents));
    expect(afterEvents).toBe(beforeEvents);
  });

  test("failed migration preserves original events and state and writes no partial sidecars", async () => {
    await copyFixtureRun(brokenIntegrityRunId);
    const paths = getRunStorePaths(rootDir, brokenIntegrityRunId);
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");

    const error = await captureError(() =>
      migrateRunPackage({
        rootDir,
        runId: brokenIntegrityRunId,
        descriptor: additiveProjectionDescriptor,
        migratedAt: "2026-06-01T00:00:00.000Z"
      })
    );
    const afterEvents = await readFile(paths.eventsPath, "utf8");
    const afterState = await readFile(paths.statePath, "utf8");

    expectRunStoreError(error, "integrity_broken");
    expect(hashBytes(afterEvents)).toBe(hashBytes(beforeEvents));
    expect(hashBytes(afterState)).toBe(hashBytes(beforeState));
    expect(await optionalFile(paths.versionPath)).toBeUndefined();
    expect(await optionalFile(paths.migrationsPath)).toBeUndefined();
  });

  test("migrated packages replay deterministically twice and equal checked-in expected state", async () => {
    await copyFixtureRun(additiveRunId);
    const expected = await readExpectedState(additiveRunId);

    await migrateRunPackage({
      rootDir,
      runId: additiveRunId,
      descriptor: additiveProjectionDescriptor,
      expectedState: expected,
      migratedAt: "2026-06-01T00:00:00.000Z"
    });

    const first = await materializeRunState({
      rootDir,
      runId: additiveRunId
    });
    const second = await materializeRunState({
      rootDir,
      runId: additiveRunId
    });

    expect(JSON.stringify(first, null, 2)).toBe(
      JSON.stringify(second, null, 2)
    );
    expect(first).toEqual(expected);
    expect(RunStateSchema.safeParse(first).success).toBe(true);
  });

  test("schema-incompatible historical events without a declared mapping fail closed", async () => {
    await copyFixtureRun(incompatibleRunId);
    const paths = getRunStorePaths(rootDir, incompatibleRunId);
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");

    const error = await captureError(() =>
      migrateRunPackage({
        rootDir,
        runId: incompatibleRunId,
        descriptor: additiveProjectionDescriptor,
        migratedAt: "2026-06-01T00:00:00.000Z"
      })
    );
    const afterEvents = await readFile(paths.eventsPath, "utf8");
    const afterState = await readFile(paths.statePath, "utf8");

    expectRunStoreError(error, "invalid_event");
    expect(afterEvents).toBe(beforeEvents);
    expect(afterState).toBe(beforeState);
    expect(await optionalFile(paths.migrationsPath)).toBeUndefined();
  });

  test("unknown run package versions refuse silent interpretation", async () => {
    await copyFixtureRun(additiveRunId);
    const paths = getRunStorePaths(rootDir, additiveRunId);
    const beforeEvents = await readFile(paths.eventsPath, "utf8");
    const beforeState = await readFile(paths.statePath, "utf8");

    await writeFile(
      paths.versionPath,
      `${JSON.stringify(
        {
          recordVersion: 1,
          version: {
            packageLayoutVersion: "specwright.run-package.future",
            ledgerFormatVersion: "specwright.ledger.future",
            projectionVersion: "specwright.reducer.future",
            snapshotFormatVersion: "specwright.snapshot.future",
            backendAdapterVersion: "specwright.backend.future"
          }
        },
        null,
        2
      )}\n`
    );

    const error = await captureError(() =>
      migrateRunPackage({
        rootDir,
        runId: additiveRunId,
        descriptor: additiveProjectionDescriptor,
        migratedAt: "2026-06-01T00:00:00.000Z"
      })
    );

    expectRunStoreError(error, "unknown_version");
    expect(await readFile(paths.eventsPath, "utf8")).toBe(beforeEvents);
    expect(await readFile(paths.statePath, "utf8")).toBe(beforeState);
    expect(await optionalFile(paths.migrationsPath)).toBeUndefined();
  });
});

const additiveProjectionDescriptor = {
  migrationId: "scope-02-packet-05-additive-tool-artifact",
  fromVersion: RUN_STORE_BASELINE_VERSION,
  toVersion: RUN_STORE_CURRENT_VERSION,
  compatibilityClass: "additive-projection",
  dataLoss: false,
  migrationNote:
    "Project tool.completed artifact outputs into RunState artifacts for migrated baseline packages.",
  compatibilityReducerId: RUN_STORE_TOOL_ARTIFACT_ADDITIVE_REDUCER_ID,
  compatibilityReducer: additiveProjectionReducer
} satisfies MigrationDescriptor;

async function copyFixtureRun(runId: string) {
  const paths = getRunStorePaths(rootDir, runId);
  await mkdir(paths.runsDir, { recursive: true });
  await cp(join(fixturesDir, runId), paths.runDir, { recursive: true });
}

async function readExpectedState(runId: string) {
  const state = JSON.parse(
    await readFile(join(fixturesDir, runId, "expected-state.json"), "utf8")
  ) as unknown;

  return RunStateSchema.parse(state);
}

function additiveProjectionReducer(state: RunState, event: RuntimeEvent) {
  switch (event.type) {
    case "run.started":
      return;
    case "phase.entered":
      state.phase = event.payload.phase;
      return;
    case "phase.transitioned":
      state.phase =
        event.payload.phase ?? event.payload.toPhase ?? event.payload.to ?? state.phase;
      return;
    case "tool.completed": {
      const output = event.payload.result.output;

      if (isRecord(output)) {
        const artifact = output.artifact;

        if (isRecord(artifact)) {
          state.artifacts = [
            ...state.artifacts.filter(
              (current) => current.artifactId !== artifact.artifactId
            ),
            {
              artifactId: String(artifact.artifactId),
              artifactType: String(artifact.artifactType),
              evidenceRefs: Array.isArray(artifact.evidenceRefs)
                ? artifact.evidenceRefs.map((value) => String(value))
                : [],
              uri: String(artifact.uri)
            }
          ];
        }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}

function expectRunStoreError(error: unknown, code: RunStoreError["code"]) {
  expect(error).toBeInstanceOf(RunStoreError);
  expect((error as RunStoreError).code).toBe(code);
}

async function optionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: string) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
