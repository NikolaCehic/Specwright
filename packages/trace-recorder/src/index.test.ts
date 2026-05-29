import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, getRunStorePaths, type HarnessSnapshot } from "@specwright/run-store";
import type { RunInput } from "@specwright/schemas";
import {
  TraceRecorder,
  readTrace,
  recordTraceSpan,
  writeTrace
} from "./index";

const runInput = {
  task: "Create a traceable run",
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
  rootDir = await mkdtemp(join(tmpdir(), "specwright-trace-recorder-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("trace recorder", () => {
  test("records and reads trace spans under the run package", async () => {
    await createRun({
      rootDir,
      runId: "run-trace",
      traceId: "trace-run-trace",
      input: runInput,
      harness
    });

    const recorder = new TraceRecorder({
      rootDir,
      runId: "run-trace",
      runtimeVersion: "0.1.0",
      harnessSpecHash: harness.specHash,
      hostAdapter: "cli"
    });
    const phase = await recorder.recordSpan({
      spanId: "span-phase-intake",
      kind: "phase",
      name: "phase.intake",
      status: "success",
      startedAt: "2026-05-29T00:00:00.000Z",
      endedAt: "2026-05-29T00:00:01.250Z",
      metadata: {
        phaseId: "intake"
      }
    });
    const tool = await recordTraceSpan({
      rootDir,
      runId: "run-trace",
      span: {
        spanId: "span-tool-read",
        kind: "tool",
        name: "tool.fs.read",
        status: "success",
        startedAt: "2026-05-29T00:00:02.000Z",
        durationMs: 42,
        eventIds: ["event-tool-requested", "event-tool-completed"],
        metadata: {
          phaseId: "intake",
          toolId: "fs.read",
          toolVersion: "0.1.0",
          cacheStatus: "bypass",
          policyStatus: "allow"
        }
      }
    });
    const trace = await readTrace({
      rootDir,
      runId: "run-trace"
    });
    const paths = getRunStorePaths(rootDir, "run-trace");

    expect(phase.durationMs).toBe(1250);
    expect(tool.durationMs).toBe(42);
    expect(trace).toMatchObject({
      runId: "run-trace",
      traceId: "trace-run-trace",
      runtimeVersion: "0.1.0",
      harnessSpecHash: "sha256:test",
      hostAdapter: "cli"
    });
    expect(trace.spans.map((span) => span.kind)).toEqual(["phase", "tool"]);
    expect(JSON.parse(await readFile(paths.tracePath, "utf8")).spans).toHaveLength(2);
  });

  test("writes a normalized trace file", async () => {
    await writeTrace({
      rootDir,
      runId: "run-write-trace",
      trace: {
        runId: "run-write-trace",
        traceId: "trace-write",
        spans: [
          {
            runId: "run-write-trace",
            traceId: "trace-write",
            spanId: "span-gate",
            kind: "gate",
            name: "gate.context_sufficiency",
            status: "pass",
            startedAt: "2026-05-29T00:00:00.000Z",
            metadata: {
              gateId: "context_sufficiency"
            }
          }
        ],
        metadata: {}
      }
    });

    await expect(
      readTrace({
        rootDir,
        runId: "run-write-trace"
      })
    ).resolves.toMatchObject({
      runId: "run-write-trace",
      traceId: "trace-write",
      spans: [
        {
          spanId: "span-gate",
          kind: "gate",
          status: "pass"
        }
      ]
    });
  });
});
