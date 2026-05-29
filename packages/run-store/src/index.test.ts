import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  createRun,
  getRunStorePaths,
  materializeRunState,
  readEvents,
  RunStoreError,
  type HarnessSnapshot
} from "./index";
import type { RunInput } from "@specwright/schemas";

const runInput = {
  task: "Create a source-bound frontend contract",
  harnessId: "default",
  host: {
    kind: "cli"
  }
} satisfies RunInput;

const harness = {
  id: "default",
  version: "0.0.0",
  specHash: "sha256:test"
} satisfies HarnessSnapshot;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-run-store-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("run store", () => {
  test("creates the file-first run layout and initial projection", async () => {
    const created = await createRun({
      rootDir,
      runId: "run-create",
      traceId: "trace-create",
      input: runInput,
      harness,
      initialPhase: "created",
      timestamp: "2026-05-29T00:00:00.000Z"
    });

    expect(created.runId).toBe("run-create");
    expect(created.event.type).toBe("run.started");
    expect(created.event.sequence).toBe(0);
    expect(created.state).toMatchObject({
      runId: "run-create",
      status: "running",
      phase: "created",
      harness,
      lastEventId: created.event.id
    });

    const paths = getRunStorePaths(rootDir, "run-create");
    const eventLog = await readFile(paths.eventsPath, "utf8");
    const stateJson = JSON.parse(await readFile(paths.statePath, "utf8"));
    const traceJson = JSON.parse(await readFile(paths.tracePath, "utf8"));

    expect(eventLog).toContain("\"run.started\"");
    expect(stateJson).toEqual(created.state);
    expect(traceJson).toEqual({
      runId: "run-create",
      traceId: "trace-create"
    });
    expect(await readFile(paths.decisionsPath, "utf8")).toBe("");
    expect(await readFile(paths.summaryPath, "utf8")).toBe("");
  });

  test("appends monotonically sequenced events and reads them back", async () => {
    await createRun({
      rootDir,
      runId: "run-append",
      traceId: "trace-append",
      input: runInput,
      harness
    });

    const phase = await appendEvent({
      rootDir,
      runId: "run-append",
      type: "phase.entered",
      payload: {
        phase: "intake"
      }
    });
    const artifact = await appendEvent({
      rootDir,
      runId: "run-append",
      type: "artifact.recorded",
      payload: {
        artifact: {
          artifactId: "artifact-1",
          artifactType: "plan",
          evidenceRefs: ["evidence-1"],
          uri: "artifacts/plan.json"
        }
      }
    });

    expect(phase.event.sequence).toBe(1);
    expect(artifact.event.sequence).toBe(2);
    expect(artifact.state.phase).toBe("intake");
    expect(artifact.state.artifacts).toEqual([
      {
        artifactId: "artifact-1",
        artifactType: "plan",
        evidenceRefs: ["evidence-1"],
        uri: "artifacts/plan.json"
      }
    ]);

    const events = await readEvents({
      rootDir,
      runId: "run-append"
    });

    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "phase.entered",
      "artifact.recorded"
    ]);
  });

  test("rebuilds state.json from events instead of trusting stale projection", async () => {
    await createRun({
      rootDir,
      runId: "run-replay",
      traceId: "trace-replay",
      input: runInput,
      harness
    });
    const appended = await appendEvent({
      rootDir,
      runId: "run-replay",
      type: "run.completed",
      payload: {
        reason: "done"
      }
    });
    const paths = getRunStorePaths(rootDir, "run-replay");

    await writeFile(paths.statePath, "{\"status\":\"stale\"}\n");

    const replayed = await materializeRunState({
      rootDir,
      runId: "run-replay"
    });
    const stateJson = JSON.parse(await readFile(paths.statePath, "utf8"));

    expect(replayed.status).toBe("completed");
    expect(replayed.lastEventId).toBe(appended.event.id);
    expect(stateJson).toEqual(replayed);
  });

  test("rejects corrupt JSONL events", async () => {
    await createRun({
      rootDir,
      runId: "run-corrupt",
      traceId: "trace-corrupt",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-corrupt");

    await writeFile(paths.eventsPath, "{not json}\n", { flag: "a" });

    const error = await captureError(() =>
      readEvents({
        rootDir,
        runId: "run-corrupt"
      })
    );

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("corrupt_event");
  });

  test("rejects non-monotonic event sequences", async () => {
    await createRun({
      rootDir,
      runId: "run-sequence",
      traceId: "trace-sequence",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-sequence");
    const badEvent = {
      id: "bad-sequence",
      runId: "run-sequence",
      type: "phase.entered",
      timestamp: "2026-05-29T00:00:00.000Z",
      sequence: 99,
      traceId: "trace-sequence",
      payload: {
        phase: "intake"
      }
    };

    await writeFile(paths.eventsPath, `${JSON.stringify(badEvent)}\n`, {
      flag: "a"
    });

    const error = await captureError(() =>
      readEvents({
        rootDir,
        runId: "run-sequence"
      })
    );

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("invalid_sequence");
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
