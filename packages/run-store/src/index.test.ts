import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_INTERVAL,
  ADMINISTRATION_AUDIT_GENESIS_SEED,
  ADMINISTRATION_OPERATIONS,
  AdministrationRecordSchema,
  EVENT_INTEGRITY_ALGO,
  EVENT_INTEGRITY_GENESIS_SEED,
  RUN_STATE_CHECKPOINT_VERSION,
  appendEvent,
  canonicalizeEventContent,
  createRun,
  exportAuditBundle,
  getAdministrationPaths,
  getRunStorePaths,
  hardDeleteRun,
  hashEventContent,
  materializeRunState,
  parseEventLog,
  projectRunState,
  readAdministrationLog,
  readRunState,
  readCheckpoint,
  readEvents,
  recordApproval,
  rebuildFromCheckpoint,
  redactForEgress,
  replayRunState,
  RunStoreError,
  runScopeForRun,
  verifyAdministrationLog,
  verifyRunIntegrity,
  withDualControl,
  writeCheckpoint,
  type HarnessSnapshot,
  type AdministrationOperation,
  type AdministrationRunScope,
  type RedactionProfile,
  type RunStateCheckpoint
} from "./index";
import { RunStateSchema, RuntimeEventSchema } from "@specwright/schemas";
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
const redactionFixturesDir = fileURLToPath(
  new URL("../fixtures/redaction/", import.meta.url)
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

  test("rebuilds from checkpoints at sequence zero, middle, and tail exactly like full replay", async () => {
    await createRun({
      rootDir,
      runId: "run-checkpoint-equivalence",
      traceId: "trace-checkpoint-equivalence",
      input: runInput,
      harness
    });
    await appendPhaseEvents("run-checkpoint-equivalence", 8);

    const paths = getRunStorePaths(rootDir, "run-checkpoint-equivalence");
    const events = await readEvents({
      rootDir,
      runId: "run-checkpoint-equivalence"
    });
    const fullReplay = projectRunState(events);

    for (const coveredSequence of [0, 4, events.length - 1]) {
      await writeCheckpoint(
        paths,
        buildCheckpoint("run-checkpoint-equivalence", events, coveredSequence)
      );

      const rebuilt = await rebuildFromCheckpoint({
        rootDir,
        runId: "run-checkpoint-equivalence"
      });
      const materialized = await materializeRunState({
        rootDir,
        runId: "run-checkpoint-equivalence"
      });

      expect(rebuilt.usedCheckpoint).toBe(true);
      expect(rebuilt.reducedEventCount).toBe(
        events.length - 1 - coveredSequence
      );
      expect(rebuilt.state).toEqual(fullReplay);
      expect(JSON.stringify(rebuilt.state, null, 2)).toBe(
        JSON.stringify(fullReplay, null, 2)
      );
      expect(materialized).toEqual(fullReplay);
      expect(RunStateSchema.safeParse(rebuilt.state).success).toBe(true);
    }
  });

  test("falls back to full replay when checkpoints are missing, corrupt, schema-invalid, or stale", async () => {
    await createRun({
      rootDir,
      runId: "run-checkpoint-fallback",
      traceId: "trace-checkpoint-fallback",
      input: runInput,
      harness
    });
    await appendPhaseEvents("run-checkpoint-fallback", 5);

    const paths = getRunStorePaths(rootDir, "run-checkpoint-fallback");
    const events = await readEvents({
      rootDir,
      runId: "run-checkpoint-fallback"
    });
    const fullReplay = projectRunState(events);

    await rm(paths.checkpointPath, { force: true });
    let rebuilt = await rebuildFromCheckpoint({
      rootDir,
      runId: "run-checkpoint-fallback"
    });

    expect(rebuilt.usedCheckpoint).toBe(false);
    expect(rebuilt.reducedEventCount).toBe(events.length);
    expect(rebuilt.state).toEqual(fullReplay);

    await writeFile(paths.checkpointPath, "{\"checkpointVersion\":");
    expect(await readCheckpoint(paths)).toBeUndefined();
    rebuilt = await rebuildFromCheckpoint({
      rootDir,
      runId: "run-checkpoint-fallback"
    });
    expect(rebuilt.usedCheckpoint).toBe(false);
    expect(rebuilt.state).toEqual(fullReplay);

    await writeFile(
      paths.checkpointPath,
      `${JSON.stringify({
        checkpointVersion: RUN_STATE_CHECKPOINT_VERSION,
        runId: "run-checkpoint-fallback",
        coveredSequence: 0,
        coveredLastEventId: events[0]?.id,
        state: {
          status: "running"
        }
      })}\n`
    );
    expect(await readCheckpoint(paths)).toBeUndefined();
    rebuilt = await rebuildFromCheckpoint({
      rootDir,
      runId: "run-checkpoint-fallback"
    });
    expect(rebuilt.usedCheckpoint).toBe(false);
    expect(rebuilt.state).toEqual(fullReplay);

    await writeFile(
      paths.checkpointPath,
      `${JSON.stringify({
        ...buildCheckpoint("run-checkpoint-fallback", events, 2),
        coveredLastEventId: "stale-event-id",
        state: {
          ...projectRunState(events.slice(0, 3)),
          lastEventId: "stale-event-id"
        }
      })}\n`
    );
    rebuilt = await rebuildFromCheckpoint({
      rootDir,
      runId: "run-checkpoint-fallback"
    });
    expect(rebuilt.usedCheckpoint).toBe(false);
    expect(rebuilt.state).toEqual(fullReplay);
  });

  test("does not let a checkpoint bypass broken-ledger quarantine", async () => {
    await createRun({
      rootDir,
      runId: "run-checkpoint-broken",
      traceId: "trace-checkpoint-broken",
      input: runInput,
      harness
    });
    await appendPhaseEvents("run-checkpoint-broken", 2);

    const paths = getRunStorePaths(rootDir, "run-checkpoint-broken");
    const events = await readEvents({
      rootDir,
      runId: "run-checkpoint-broken"
    });
    await writeCheckpoint(
      paths,
      buildCheckpoint("run-checkpoint-broken", events, 1)
    );

    const forged = RuntimeEventSchema.parse({
      id: "forged-checkpoint-bypass",
      runId: "run-checkpoint-broken",
      type: "run.completed",
      timestamp: "2026-05-29T00:00:03.000Z",
      sequence: events.length,
      traceId: "trace-checkpoint-broken",
      payload: {
        reason: "out-of-band"
      }
    });
    const beforeState = await readFile(paths.statePath, "utf8");

    await writeFile(paths.eventsPath, `${JSON.stringify(forged)}\n`, {
      flag: "a"
    });

    const rebuiltError = await captureError(() =>
      rebuildFromCheckpoint({
        rootDir,
        runId: "run-checkpoint-broken"
      })
    );
    const materializedError = await captureError(() =>
      materializeRunState({
        rootDir,
        runId: "run-checkpoint-broken"
      })
    );
    const afterState = await readFile(paths.statePath, "utf8");

    expect(rebuiltError).toBeInstanceOf(RunStoreError);
    expect((rebuiltError as RunStoreError).code).toBe("integrity_broken");
    expect(materializedError).toBeInstanceOf(RunStoreError);
    expect((materializedError as RunStoreError).code).toBe("integrity_broken");
    expect(afterState).toBe(beforeState);
  });

  test("keeps reduced-event cost bounded after deterministic checkpoint refresh", async () => {
    await createRun({
      rootDir,
      runId: "run-checkpoint-cost",
      traceId: "trace-checkpoint-cost",
      input: runInput,
      harness
    });

    const appendCount = CHECKPOINT_INTERVAL * 2 + 7;
    for (let index = 0; index < appendCount; index += 1) {
      await appendEvent({
        rootDir,
        runId: "run-checkpoint-cost",
        type: "phase.entered",
        payload: {
          phase: `phase-${index}`
        },
        timestamp: `2026-05-29T00:${String(Math.floor(index / 60)).padStart(
          2,
          "0"
        )}:${String(index % 60).padStart(2, "0")}.000Z`
      });
    }

    const paths = getRunStorePaths(rootDir, "run-checkpoint-cost");
    const checkpoint = await readCheckpoint(paths);
    const events = await readEvents({
      rootDir,
      runId: "run-checkpoint-cost"
    });
    const rebuilt = await rebuildFromCheckpoint({
      rootDir,
      runId: "run-checkpoint-cost"
    });
    const fullReplay = projectRunState(events);
    const expectedCoveredSequence = CHECKPOINT_INTERVAL * 2;
    const expectedTailCost = appendCount - expectedCoveredSequence;

    expect(checkpoint?.coveredSequence).toBe(expectedCoveredSequence);
    expect(rebuilt.usedCheckpoint).toBe(true);
    expect(rebuilt.reducedEventCount).toBe(expectedTailCost);
    expect(rebuilt.reducedEventCount).toBeLessThanOrEqual(CHECKPOINT_INTERVAL);
    expect(events.length).toBe(appendCount + 1);
    expect(events.length).toBeGreaterThan(CHECKPOINT_INTERVAL * 2);
    expect(rebuilt.reducedEventCount).toBeLessThan(events.length);
    expect(rebuilt.state).toEqual(fullReplay);
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

  test("redacts projection egress without rewriting authoritative state", async () => {
    await createRun({
      rootDir,
      runId: "run-redacted-state",
      traceId: "trace-redacted-state",
      input: runInput,
      harness
    });
    await appendEvent({
      rootDir,
      runId: "run-redacted-state",
      type: "artifact.recorded",
      payload: {
        artifact: {
          artifactId: "artifact-restricted-plan",
          artifactType: "plan",
          evidenceRefs: ["evidence:restricted-source"],
          uri: "artifacts/restricted-plan.md"
        }
      }
    });

    const paths = getRunStorePaths(rootDir, "run-redacted-state");
    const authoritative = await materializeRunState({
      rootDir,
      runId: "run-redacted-state"
    });
    const redacted = await readRunState({
      rootDir,
      runId: "run-redacted-state"
    });
    const stateJson = await readFile(paths.statePath, "utf8");
    const redactedJson = JSON.stringify(redacted);

    expect(JSON.stringify(authoritative)).toContain(
      "artifacts/restricted-plan.md"
    );
    expect(stateJson).toContain("artifacts/restricted-plan.md");
    expect(redactedJson).not.toContain("artifacts/restricted-plan.md");
    expect(redactedJson).toContain(
      "sha256:6fe391f8f903ad5b55ff1eda1bed292b109d055a39268404f0e2b0dc43b81134"
    );
  });

  test("requires audit_raw grant for raw restricted egress", async () => {
    const value = {
      payload: {
        request: {
          args: {
            token: "sk_live_fixture_scope_02_packet_03"
          }
        },
        result: {
          output: {
            contents:
              "DATABASE_URL=postgres://scope-02-packet-03@example.invalid/specwright"
          },
          provenance: {
            argsHash:
              "sha256:d8576b4d26ccf208a9372f9df7e7e9d6786fd8a292091fea2bc1e86a6a41b5d8",
            resultHash:
              "sha256:4b01f791f3caecd55bb6f23a443731846f66adef1d7bc0c1c8d817cf32603fbe"
          }
        }
      }
    };

    const denied = await captureError(async () =>
      redactForEgress(value, {
        mode: "raw"
      })
    );
    const redacted = redactForEgress(value);
    const raw = redactForEgress(value, {
      mode: "raw",
      grant: {
        class: "audit_raw",
        actor: "test-auditor",
        reason: "grant gate regression"
      }
    });

    expect(denied).toBeInstanceOf(RunStoreError);
    expect((denied as RunStoreError).code).toBe("raw_read_denied");
    expect(JSON.stringify(redacted)).not.toContain(
      "sk_live_fixture_scope_02_packet_03"
    );
    expect(JSON.stringify(redacted)).toContain(
      "sha256:d8576b4d26ccf208a9372f9df7e7e9d6786fd8a292091fea2bc1e86a6a41b5d8"
    );
    expect(JSON.stringify(raw)).toContain(
      "sk_live_fixture_scope_02_packet_03"
    );
  });

  test("fails closed on unclassified secret-bearing fields", async () => {
    const strictProfile = {
      id: "strict-test-profile",
      fieldClasses: {}
    } satisfies RedactionProfile;

    const error = await captureError(async () =>
      redactForEgress(
        {
          secret: "unclassified-secret"
        },
        {
          profile: strictProfile
        }
      )
    );

    expect(error).toBeInstanceOf(RunStoreError);
    expect((error as RunStoreError).code).toBe("unclassified_field");
  });

  test("redacts fixture egress deterministically with carried hash references", async () => {
    const events = parseEventLog(
      await readRedactionFixture("secret-bearing-events.jsonl"),
      "fixture-redaction-run"
    );
    const first = events.map((event) => redactForEgress(event));
    const second = events.map((event) => redactForEgress(event));
    const firstJson = JSON.stringify(first);

    expect(firstJson).toBe(JSON.stringify(second));
    expect(firstJson).not.toContain("sk_live_fixture_scope_02_packet_03");
    expect(firstJson).not.toContain(
      "DATABASE_URL=postgres://scope-02-packet-03@example.invalid/specwright"
    );
    expect(firstJson).toContain(
      "sha256:d8576b4d26ccf208a9372f9df7e7e9d6786fd8a292091fea2bc1e86a6a41b5d8"
    );
    expect(firstJson).toContain(
      "sha256:4b01f791f3caecd55bb6f23a443731846f66adef1d7bc0c1c8d817cf32603fbe"
    );
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

  test("requires recorded approval for each administration operation before side effects", async () => {
    const runScope = await createAdministrationRun("run-admin-denied");

    for (const [index, operation] of ADMINISTRATION_OPERATIONS.entries()) {
      let sideEffect = false;
      const error = await captureError(async () =>
        withDualControl({
          rootDir,
          operation,
          actor: "operator-a",
          runScope,
          timestamp: adminTimestamp(index),
          recordIds: {
            preOperation: `${operation}-denied-pre`,
            postOperation: `${operation}-denied-post`
          },
          execute: () => {
            sideEffect = true;
            return operation;
          }
        })
      );

      expectRunStoreError(error, "approval_required");
      expect(sideEffect).toBe(false);
    }

    expect(await readAdministrationLog({ rootDir })).toEqual([]);
  });

  test("records all administration operations as schema-valid sequence-indexed hash-chain entries", async () => {
    const runScope = await createAdministrationRun("run-admin-records");
    const executed: AdministrationOperation[] = [];

    for (const [index, operation] of ADMINISTRATION_OPERATIONS.entries()) {
      const approvalId = `approval-${operation}`;
      await approveAdministrationOperation({
        approvalId,
        operation,
        runScope,
        timestamp: adminTimestamp(index)
      });

      const result = await withDualControl({
        rootDir,
        operation,
        actor: "operator-a",
        approvalId,
        runScope,
        profileOrDescriptor: {
          reason: `record ${operation}`
        },
        timestamps: {
          preOperation: adminTimestamp(index, 10),
          postOperation: adminTimestamp(index, 20)
        },
        recordIds: {
          preOperation: `${operation}-pre`,
          postOperation: `${operation}-post`
        },
        execute: () => {
          executed.push(operation);
          return operation;
        }
      });

      expect(result.value).toBe(operation);
      expect(result.records).toHaveLength(2);
    }

    const records = await readAdministrationLog({ rootDir });
    const verification = await verifyAdministrationLog({ rootDir });
    let previousHash = ADMINISTRATION_AUDIT_GENESIS_SEED;

    expect(executed).toEqual([...ADMINISTRATION_OPERATIONS]);
    expect(records).toHaveLength(ADMINISTRATION_OPERATIONS.length * 2);
    expect(verification).toEqual({
      status: "verified",
      recordCount: records.length,
      headHash: records.at(-1)?.auditIntegrity.hash
    });

    for (const [index, record] of records.entries()) {
      expect(AdministrationRecordSchema.safeParse(record).success).toBe(true);
      expect(record.sequence).toBe(index);
      expect(record.actor).toBe("operator-a");
      expect(record.approvalRef.approvalId).toBeTruthy();
      expect(record.runScope).toEqual(runScope);
      expect(record.integrityBefore?.runHeads[0]?.headHash).toBeTruthy();
      expect(record.auditIntegrity.prevHash).toBe(previousHash);
      expect(record.result.status).toBe("success");

      if (record.recordKind === "post_operation") {
        expect(record.integrityAfter?.runHeads[0]?.headHash).toBe(
          record.integrityBefore?.runHeads[0]?.headHash
        );
      }

      previousHash = record.auditIntegrity.hash;
    }
  });

  test("hardDeleteRun deletes the run directory but leaves durable administration records", async () => {
    const runId = "run-admin-hard-delete";
    const runScope = await createAdministrationRun(runId);
    const approvalId = "approval-hard-delete";
    await approveAdministrationOperation({
      approvalId,
      operation: "hard_delete",
      runScope
    });

    const deleted = await hardDeleteRun({
      rootDir,
      runId,
      actor: "operator-a",
      approvalId,
      runScope,
      timestamps: {
        preOperation: adminTimestamp(0, 10),
        postOperation: adminTimestamp(0, 20)
      },
      recordIds: {
        preOperation: "hard-delete-pre",
        postOperation: "hard-delete-post"
      }
    });
    const readDeletedRun = await captureError(async () =>
      readEvents({ rootDir, runId })
    );
    const records = await readAdministrationLog({ rootDir });

    expect(deleted.value.deletedRunDir).toBe(
      getRunStorePaths(rootDir, runId).runDir
    );
    expectRunStoreError(readDeletedRun, "missing_events");
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.operation)).toEqual([
      "hard_delete",
      "hard_delete"
    ]);
    expect(records.every((record) => AdministrationRecordSchema.safeParse(record).success)).toBe(true);
    expect(records[1]?.integrityAfter?.runHeads[0]).toMatchObject({
      runId,
      status: "broken",
      code: "missing_events"
    });
  });

  test("keeps administration logs append-only and isolated per tenant root", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "specwright-run-store-"));

    try {
      const runScopeA = await createAdministrationRun("run-admin-tenant-a");
      const runScopeB = await createAdministrationRunInRoot(
        otherRoot,
        "run-admin-tenant-b"
      );

      await approveAndRunAdministrationOperation({
        root: rootDir,
        approvalId: "approval-tenant-a",
        operation: "quarantine",
        runScope: runScopeA,
        recordPrefix: "tenant-a"
      });
      await approveAndRunAdministrationOperation({
        root: otherRoot,
        approvalId: "approval-tenant-b",
        operation: "quarantine_release",
        runScope: runScopeB,
        recordPrefix: "tenant-b"
      });

      const pathsA = getAdministrationPaths(rootDir);
      const pathsB = getAdministrationPaths(otherRoot);
      const recordsA = await readAdministrationLog({ rootDir });
      const recordsB = await readAdministrationLog({ rootDir: otherRoot });

      expect(pathsA.auditPath).not.toContain(`/runs/${runScopeA.runIds[0]}`);
      expect(pathsB.auditPath).not.toContain(`/runs/${runScopeB.runIds[0]}`);
      expect(pathsA.auditPath).not.toBe(pathsB.auditPath);
      expect(recordsA).toHaveLength(2);
      expect(recordsB).toHaveLength(2);
      expect(recordsA[0]?.tenantId).not.toBe(recordsB[0]?.tenantId);
      expect(recordsA.map((record) => record.sequence)).toEqual([0, 1]);
      expect(recordsB.map((record) => record.sequence)).toEqual([0, 1]);
      expect(await verifyAdministrationLog({ rootDir })).toMatchObject({
        status: "verified",
        recordCount: 2
      });
      expect(await verifyAdministrationLog({ rootDir: otherRoot })).toMatchObject({
        status: "verified",
        recordCount: 2
      });
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test("rejects same-actor approval, mismatched operation, and mismatched run scope", async () => {
    const runScope = await createAdministrationRun("run-admin-dual-control");
    const otherRunScope = await createAdministrationRun(
      "run-admin-dual-control-other"
    );

    await approveAdministrationOperation({
      approvalId: "approval-same-actor",
      operation: "quarantine",
      runScope,
      approvedBy: "operator-a"
    });
    let sideEffect = false;
    let error = await captureError(async () =>
      withDualControl({
        rootDir,
        operation: "quarantine",
        actor: "operator-a",
        approvalId: "approval-same-actor",
        runScope,
        execute: () => {
          sideEffect = true;
        }
      })
    );
    expectRunStoreError(error, "dual_control_violation");
    expect(sideEffect).toBe(false);

    await approveAdministrationOperation({
      approvalId: "approval-wrong-operation",
      operation: "archive",
      runScope
    });
    error = await captureError(async () =>
      withDualControl({
        rootDir,
        operation: "quarantine",
        actor: "operator-a",
        approvalId: "approval-wrong-operation",
        runScope,
        execute: () => {
          sideEffect = true;
        }
      })
    );
    expectRunStoreError(error, "approval_mismatch");

    await approveAdministrationOperation({
      approvalId: "approval-wrong-scope",
      operation: "quarantine",
      runScope: otherRunScope
    });
    error = await captureError(async () =>
      withDualControl({
        rootDir,
        operation: "quarantine",
        actor: "operator-a",
        approvalId: "approval-wrong-scope",
        runScope,
        execute: () => {
          sideEffect = true;
        }
      })
    );
    expectRunStoreError(error, "approval_mismatch");
    expect(sideEffect).toBe(false);
    expect(await readAdministrationLog({ rootDir })).toEqual([]);
  });

  test("records legal-hold denials before hard delete or archive side effects", async () => {
    const runId = "run-admin-legal-hold";
    const runScope = await createAdministrationRun(runId);

    await approveAdministrationOperation({
      approvalId: "approval-held-delete",
      operation: "hard_delete",
      runScope
    });
    const deleteError = await captureError(async () =>
      hardDeleteRun({
        rootDir,
        runId,
        actor: "operator-a",
        approvalId: "approval-held-delete",
        runScope,
        legalHold: {
          active: true,
          reason: "litigation hold"
        },
        recordIds: {
          denial: "held-delete-denial"
        },
        timestamps: {
          denial: adminTimestamp(0, 30)
        }
      })
    );
    expectRunStoreError(deleteError, "legal_hold_active");
    expect(await readEvents({ rootDir, runId })).toHaveLength(1);

    await approveAdministrationOperation({
      approvalId: "approval-held-archive",
      operation: "archive",
      runScope
    });
    let archived = false;
    const archiveError = await captureError(async () =>
      withDualControl({
        rootDir,
        operation: "archive",
        actor: "operator-a",
        approvalId: "approval-held-archive",
        runScope,
        legalHold: {
          active: true,
          reason: "litigation hold"
        },
        recordIds: {
          denial: "held-archive-denial"
        },
        timestamps: {
          denial: adminTimestamp(0, 40)
        },
        execute: () => {
          archived = true;
        }
      })
    );
    const records = await readAdministrationLog({ rootDir });

    expectRunStoreError(archiveError, "legal_hold_active");
    expect(archived).toBe(false);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.recordKind)).toEqual([
      "denial",
      "denial"
    ]);
    expect(records.map((record) => record.result.code)).toEqual([
      "legal_hold_active",
      "legal_hold_active"
    ]);
  });

  test("reports tampered administration logs and fails trusted reads and gates closed", async () => {
    const runScope = await createAdministrationRun("run-admin-tamper");
    await approveAndRunAdministrationOperation({
      approvalId: "approval-before-tamper",
      operation: "projection_rebuild",
      runScope,
      recordPrefix: "before-tamper"
    });

    const paths = getAdministrationPaths(rootDir);
    await writeFile(
      paths.auditPath,
      `${JSON.stringify({
        recordId: "forged-admin-record",
        tenantId: paths.tenantId,
        sequence: 2
      })}\n`,
      { flag: "a" }
    );

    const verification = await verifyAdministrationLog({ rootDir });
    const readError = await captureError(async () =>
      readAdministrationLog({ rootDir })
    );
    await approveAdministrationOperation({
      approvalId: "approval-after-tamper",
      operation: "archive",
      runScope
    });
    let sideEffect = false;
    const gateError = await captureError(async () =>
      withDualControl({
        rootDir,
        operation: "archive",
        actor: "operator-a",
        approvalId: "approval-after-tamper",
        runScope,
        execute: () => {
          sideEffect = true;
        }
      })
    );

    expect(verification.status).toBe("broken-at-sequence-2");
    expectRunStoreError(readError, "corrupt_audit");
    expectRunStoreError(gateError, "corrupt_audit");
    expect(sideEffect).toBe(false);
  });

  test("exports deterministic audit bundles and records the audit_export operation", async () => {
    const tenantId = "tenant-export";
    const runScope = await createAdministrationRun("run-admin-export");
    await approveAndRunAdministrationOperation({
      tenantId,
      approvalId: "approval-export-primer",
      operation: "redaction_sweep",
      runScope,
      recordPrefix: "export-primer"
    });

    const paths = getAdministrationPaths(rootDir, tenantId);
    const auditBeforeExport = await readFile(paths.auditPath, "utf8");
    await approveAdministrationOperation({
      tenantId,
      approvalId: "approval-export",
      operation: "audit_export",
      runScope
    });

    const exportOptions = {
      rootDir,
      tenantId,
      runId: "run-admin-export",
      actor: "operator-a",
      approvalId: "approval-export",
      runScope,
      bundleId: "bundle-export-fixed",
      exportedAt: "2026-05-29T02:00:00.000Z",
      timestamps: {
        preOperation: "2026-05-29T02:00:01.000Z",
        postOperation: "2026-05-29T02:00:02.000Z"
      },
      recordIds: {
        preOperation: "audit-export-pre",
        postOperation: "audit-export-post"
      }
    } as const;
    const first = await exportAuditBundle(exportOptions);

    await writeFile(paths.auditPath, auditBeforeExport);
    const second = await exportAuditBundle(exportOptions);
    const finalRecords = await readAdministrationLog({ rootDir, tenantId });

    expect(first.bytes).toBe(second.bytes);
    expect(first.bundle.administrationRecords.some((record) =>
      record.operation === "audit_export" &&
      record.recordKind === "pre_operation" &&
      record.recordId === "audit-export-pre"
    )).toBe(true);
    expect(first.bundle.administrationRecords.every((record) =>
      record.runScope.runIds.includes("run-admin-export")
    )).toBe(true);
    expect(finalRecords.filter((record) => record.operation === "audit_export")).toHaveLength(2);
  });
});

async function createAdministrationRun(runId: string) {
  return createAdministrationRunInRoot(rootDir, runId);
}

async function createAdministrationRunInRoot(targetRoot: string, runId: string) {
  await createRun({
    rootDir: targetRoot,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    timestamp: "2026-05-29T01:00:00.000Z"
  });

  return runScopeForRun({
    rootDir: targetRoot,
    runId
  });
}

async function approveAdministrationOperation(options: {
  root?: string;
  tenantId?: string;
  approvalId: string;
  operation: AdministrationOperation;
  runScope: AdministrationRunScope;
  requestedBy?: string;
  approvedBy?: string;
  timestamp?: string;
}) {
  return recordApproval({
    rootDir: options.root ?? rootDir,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    approvalId: options.approvalId,
    operation: options.operation,
    runScope: options.runScope,
    requestedBy: options.requestedBy ?? "operator-a",
    approvedBy: options.approvedBy ?? "operator-b",
    timestamp: options.timestamp ?? "2026-05-29T01:00:01.000Z"
  });
}

async function approveAndRunAdministrationOperation(options: {
  root?: string;
  tenantId?: string;
  approvalId: string;
  operation: AdministrationOperation;
  runScope: AdministrationRunScope;
  recordPrefix: string;
}) {
  await approveAdministrationOperation(options);

  return withDualControl({
    rootDir: options.root ?? rootDir,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    operation: options.operation,
    actor: "operator-a",
    approvalId: options.approvalId,
    runScope: options.runScope,
    timestamps: {
      preOperation: "2026-05-29T01:00:10.000Z",
      postOperation: "2026-05-29T01:00:20.000Z"
    },
    recordIds: {
      preOperation: `${options.recordPrefix}-pre`,
      postOperation: `${options.recordPrefix}-post`
    },
    execute: () => options.operation
  });
}

function adminTimestamp(index: number, offset = 0) {
  const totalSeconds = index * 10 + offset;
  const minute = Math.floor(totalSeconds / 60);
  const second = totalSeconds % 60;

  return `2026-05-29T01:${String(minute).padStart(2, "0")}:${String(
    second
  ).padStart(2, "0")}.000Z`;
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

async function appendPhaseEvents(runId: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    await appendEvent({
      rootDir,
      runId,
      type: "phase.entered",
      payload: {
        phase: `phase-${index}`
      },
      timestamp: `2026-05-29T00:00:${String(index).padStart(2, "0")}.000Z`
    });
  }
}

function buildCheckpoint(
  runId: string,
  events: readonly RuntimeEvent[],
  coveredSequence: number
): RunStateCheckpoint {
  const coveredEvent = events[coveredSequence];

  if (coveredEvent === undefined) {
    throw new Error(`Missing event at sequence ${coveredSequence}`);
  }

  const state = projectRunState(events.slice(0, coveredSequence + 1));

  return {
    checkpointVersion: RUN_STATE_CHECKPOINT_VERSION,
    runId,
    coveredSequence,
    coveredLastEventId: coveredEvent.id,
    state,
    ...(coveredEvent.integrity === undefined
      ? {}
      : { coveredHeadHash: coveredEvent.integrity.hash })
  };
}

async function readEventFixture(name: string) {
  return readFile(`${eventFixturesDir}${name}`, "utf8");
}

async function readRedactionFixture(name: string) {
  return readFile(`${redactionFixturesDir}${name}`, "utf8");
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
