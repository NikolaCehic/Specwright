import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_INTEGRITY_ALGO,
  EVENT_INTEGRITY_GENESIS_SEED,
  appendEvent,
  canonicalizeEventContent,
  createRun,
  getRunStorePaths,
  hashEventContent,
  materializeRunState,
  parseEventLog,
  projectRunState,
  readEvents,
  replayRunState,
  RunStoreError,
  verifyRunIntegrity,
  type HarnessSnapshot
} from "./index";
import { RuntimeEventSchema } from "@specwright/schemas";
import type {
  RunInput,
  RuntimeEvent,
  RuntimeEventIntegrity
} from "@specwright/schemas";

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

const eventFixturesDir = fileURLToPath(
  new URL("../../schemas/fixtures/events/", import.meta.url)
);

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

  test("chains appended event integrity and verifies the ledger", async () => {
    await createRun({
      rootDir,
      runId: "run-integrity",
      traceId: "trace-integrity",
      input: runInput,
      harness,
      timestamp: "2026-05-29T00:00:00.000Z"
    });
    await appendEvent({
      rootDir,
      runId: "run-integrity",
      type: "phase.entered",
      payload: {
        phase: "intake"
      },
      timestamp: "2026-05-29T00:00:01.000Z"
    });
    await appendEvent({
      rootDir,
      runId: "run-integrity",
      type: "run.completed",
      payload: {
        reason: "done"
      },
      timestamp: "2026-05-29T00:00:02.000Z"
    });

    const events = await readEvents({
      rootDir,
      runId: "run-integrity"
    });
    const firstIntegrity = requireIntegrity(events[0]);
    const secondIntegrity = requireIntegrity(events[1]);
    const thirdIntegrity = requireIntegrity(events[2]);

    expect(firstIntegrity).toEqual({
      algo: EVENT_INTEGRITY_ALGO,
      prevHash: EVENT_INTEGRITY_GENESIS_SEED,
      hash: hashEventContent(events[0])
    });
    expect(secondIntegrity.prevHash).toBe(firstIntegrity.hash);
    expect(secondIntegrity.hash).toBe(hashEventContent(events[1]));
    expect(thirdIntegrity.prevHash).toBe(secondIntegrity.hash);
    expect(thirdIntegrity.hash).toBe(hashEventContent(events[2]));

    const verdict = await verifyRunIntegrity({
      rootDir,
      runId: "run-integrity"
    });

    expect(verdict).toEqual({
      status: "verified",
      eventCount: 3,
      headHash: thirdIntegrity.hash
    });
    expect(projectRunState(events)).toEqual(
      await materializeRunState({
        rootDir,
        runId: "run-integrity"
      })
    );
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

  test("detects a forged out-of-band line and quarantines projection rebuild", async () => {
    await createRun({
      rootDir,
      runId: "run-forged",
      traceId: "trace-forged",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-forged");
    const forged = RuntimeEventSchema.parse({
      id: "forged-completion",
      runId: "run-forged",
      type: "run.completed",
      timestamp: "2026-05-29T00:00:01.000Z",
      sequence: 1,
      traceId: "trace-forged",
      payload: {
        reason: "out-of-band"
      }
    });

    await writeFile(paths.eventsPath, `${JSON.stringify(forged)}\n`, {
      flag: "a"
    });
    const beforeState = await readFile(paths.statePath, "utf8");
    const verdict = await verifyRunIntegrity({
      rootDir,
      runId: "run-forged"
    });

    expect(verdict).toMatchObject({
      status: "broken",
      brokenAtSequence: 1,
      code: "integrity_missing"
    });

    const error = await captureError(() =>
      replayRunState({
        rootDir,
        runId: "run-forged"
      })
    );
    const afterState = await readFile(paths.statePath, "utf8");

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("integrity_broken");
    expect(afterState).toBe(beforeState);
  });

  test("detects valid-JSON payload mutation by recomputing the digest", async () => {
    await createRun({
      rootDir,
      runId: "run-mutated",
      traceId: "trace-mutated",
      input: runInput,
      harness
    });
    await appendEvent({
      rootDir,
      runId: "run-mutated",
      type: "phase.entered",
      payload: {
        phase: "intake"
      }
    });
    const paths = getRunStorePaths(rootDir, "run-mutated");
    const events = await readEvents({
      rootDir,
      runId: "run-mutated"
    });
    const phaseEvent = events[1];

    if (phaseEvent === undefined || phaseEvent.type !== "phase.entered") {
      throw new Error("Expected phase.entered event at sequence 1");
    }

    await writeEvents(paths.eventsPath, [
      events[0],
      {
        ...phaseEvent,
        payload: {
          ...phaseEvent.payload,
          phase: "planning"
        }
      }
    ]);

    const verdict = await verifyRunIntegrity({
      rootDir,
      runId: "run-mutated"
    });

    expect(verdict).toMatchObject({
      status: "broken",
      brokenAtSequence: 1,
      code: "integrity_hash_mismatch"
    });
  });

  test("detects sequence-stuffed and truncated tail ledgers as broken", async () => {
    await createRun({
      rootDir,
      runId: "run-adversarial",
      traceId: "trace-adversarial",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-adversarial");
    const stuffed = RuntimeEventSchema.parse({
      id: "stuffed-event",
      runId: "run-adversarial",
      type: "run.completed",
      timestamp: "2026-05-29T00:00:01.000Z",
      sequence: 99,
      traceId: "trace-adversarial",
      payload: {
        reason: "sequence stuffed"
      }
    });

    await writeFile(paths.eventsPath, `${JSON.stringify(stuffed)}\n`, {
      flag: "a"
    });

    const stuffedVerdict = await verifyRunIntegrity({
      rootDir,
      runId: "run-adversarial"
    });

    expect(stuffedVerdict).toMatchObject({
      status: "broken",
      brokenAtSequence: 1,
      code: "invalid_sequence"
    });

    await createRun({
      rootDir,
      runId: "run-truncated",
      traceId: "trace-truncated",
      input: runInput,
      harness
    });
    const truncatedPaths = getRunStorePaths(rootDir, "run-truncated");

    await writeFile(truncatedPaths.eventsPath, "{\"id\":\"truncated-tail\"\n", {
      flag: "a"
    });

    const truncatedVerdict = await verifyRunIntegrity({
      rootDir,
      runId: "run-truncated"
    });

    expect(truncatedVerdict).toMatchObject({
      status: "broken",
      brokenAtSequence: 1,
      code: "corrupt_event"
    });
  });

  test("keeps legacy unchained ledgers replayable and classified separately", async () => {
    await createRun({
      rootDir,
      runId: "run-legacy",
      traceId: "trace-legacy",
      input: runInput,
      harness
    });
    await appendEvent({
      rootDir,
      runId: "run-legacy",
      type: "phase.entered",
      payload: {
        phase: "intake"
      }
    });
    const paths = getRunStorePaths(rootDir, "run-legacy");
    const chainedEvents = await readEvents({
      rootDir,
      runId: "run-legacy"
    });
    const legacyEvents = chainedEvents.map(({ integrity, ...event }) => {
      void integrity;
      return event;
    });

    await writeEvents(paths.eventsPath, legacyEvents);

    const verdict = await verifyRunIntegrity({
      rootDir,
      runId: "run-legacy"
    });
    const replayed = await materializeRunState({
      rootDir,
      runId: "run-legacy"
    });

    expect(verdict).toEqual({
      status: "unchained",
      eventCount: 2
    });
    expect(replayed.phase).toBe("intake");
  });

  test("refuses to append onto a broken chained ledger", async () => {
    await createRun({
      rootDir,
      runId: "run-broken-append",
      traceId: "trace-broken-append",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-broken-append");
    const events = await readEvents({
      rootDir,
      runId: "run-broken-append"
    });
    const started = events[0];

    if (started === undefined || started.type !== "run.started") {
      throw new Error("Expected run.started event at sequence 0");
    }

    await writeEvents(paths.eventsPath, [
      {
        ...started,
        payload: {
          ...started.payload,
          initialPhase: "tampered"
        }
      }
    ]);
    const before = await readFile(paths.eventsPath, "utf8");

    const error = await captureError(() =>
      appendEvent({
        rootDir,
        runId: "run-broken-append",
        type: "phase.entered",
        payload: {
          phase: "intake"
        }
      })
    );
    const after = await readFile(paths.eventsPath, "utf8");

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("integrity_broken");
    expect(after).toBe(before);
  });

  test("pins the canonical event-content digest", () => {
    const event = RuntimeEventSchema.parse({
      id: "event-golden",
      runId: "run-golden",
      type: "run.started",
      timestamp: "2026-05-29T00:00:00.000Z",
      sequence: 0,
      traceId: "trace-golden",
      payload: {
        input: runInput,
        harness,
        initialPhase: "created",
        budgets: {}
      },
      integrity: {
        algo: EVENT_INTEGRITY_ALGO,
        prevHash: EVENT_INTEGRITY_GENESIS_SEED,
        hash: "sha256:ignored-by-canonicalizer"
      }
    });

    expect(canonicalizeEventContent(event)).toBe(
      "{\"id\":\"event-golden\",\"payload\":{\"budgets\":{},\"harness\":{\"id\":\"default\",\"specHash\":\"sha256:test\",\"version\":\"0.0.0\"},\"initialPhase\":\"created\",\"input\":{\"harnessId\":\"default\",\"host\":{\"kind\":\"cli\"},\"task\":\"Create a source-bound frontend contract\"}},\"runId\":\"run-golden\",\"sequence\":0,\"timestamp\":\"2026-05-29T00:00:00.000Z\",\"traceId\":\"trace-golden\",\"type\":\"run.started\"}"
    );
    expect(hashEventContent(event)).toBe(
      "sha256:e3c0b4d26be44c49c6f7cb617c95c1bb5008e53b5fccb7a1a63d59924ee3a645"
    );
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

  test("rejects invalid event payload append and preserves the log", async () => {
    await createRun({
      rootDir,
      runId: "run-invalid-payload",
      traceId: "trace-invalid-payload",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-invalid-payload");
    const before = await readFile(paths.eventsPath, "utf8");

    const error = await captureError(() =>
      appendEvent({
        rootDir,
        runId: "run-invalid-payload",
        type: "phase.entered",
        payload: {
          phase: 42
        }
      })
    );
    const after = await readFile(paths.eventsPath, "utf8");

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("invalid_event_payload");
    expect(after).toBe(before);
  });

  test("rejects unknown event type append and preserves the log", async () => {
    await createRun({
      rootDir,
      runId: "run-unknown-type",
      traceId: "trace-unknown-type",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-unknown-type");
    const before = await readFile(paths.eventsPath, "utf8");

    const error = await captureError(() =>
      appendEvent({
        rootDir,
        runId: "run-unknown-type",
        type: "event.unknown",
        payload: {}
      })
    );
    const after = await readFile(paths.eventsPath, "utf8");

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("unknown_event_contract");
    expect(after).toBe(before);
  });

  test("replays the shared valid historical event fixture", async () => {
    const events = parseEventLog(
      await readEventFixture("valid-historical-run.jsonl"),
      "fixture-run"
    );
    const state = projectRunState(events);

    expect(events).toHaveLength(18);
    expect(state).toMatchObject({
      runId: "fixture-run",
      status: "completed",
      phase: "evidence"
    });
    expect(state.artifacts.map((artifact) => artifact.artifactId)).toContain(
      "artifact-1"
    );
  });

  test("rejects invalid replay fixtures with structured event contract errors", async () => {
    const cases = [
      {
        fixture: "invalid-payload.jsonl",
        runId: "fixture-invalid-payload",
        code: "invalid_event_payload"
      },
      {
        fixture: "unknown-type.jsonl",
        runId: "fixture-unknown-type",
        code: "unknown_event_contract"
      },
      {
        fixture: "unsupported-version.jsonl",
        runId: "fixture-unsupported-version",
        code: "unsupported_event_version"
      }
    ] as const;

    for (const testCase of cases) {
      const error = await captureError(async () =>
        parseEventLog(await readEventFixture(testCase.fixture), testCase.runId)
      );

      expect(error).toBeInstanceOf(RunStoreError);
      expect((error as RunStoreError).code).toBe(testCase.code);
    }
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

async function readEventFixture(name: string) {
  return readFile(`${eventFixturesDir}${name}`, "utf8");
}

function requireIntegrity(event: RuntimeEvent | undefined): RuntimeEventIntegrity {
  if (event === undefined) {
    throw new Error("Expected runtime event");
  }

  if (event.integrity === undefined) {
    throw new Error(`Expected integrity metadata on event ${event.sequence}`);
  }

  return event.integrity;
}

async function writeEvents(path: string, events: readonly RuntimeEvent[]) {
  await writeFile(
    path,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
}
