import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun, getRunStorePaths, type HarnessSnapshot } from "@specwright/run-store";
import type { RunInput } from "@specwright/schemas";
import {
  TraceRecorder,
  TraceRecorderError,
  readTrace,
  recordTraceSpan,
  writeTrace
} from "./index";
import type { TraceSpanKind } from "./index";

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

  test("records and reads a policy span with linked event ids", async () => {
    await createRun({
      rootDir,
      runId: "run-policy-trace",
      traceId: "trace-policy",
      input: runInput,
      harness
    });

    const span = await recordTraceSpan({
      rootDir,
      runId: "run-policy-trace",
      traceId: "trace-policy",
      span: {
        spanId: "span-policy-shell",
        parentSpanId: "span-tool-shell",
        kind: "policy",
        name: "policy.approval_required.tool_call",
        status: "approval_required",
        startedAt: "2026-06-07T00:00:00.000Z",
        endedAt: "2026-06-07T00:00:00.025Z",
        eventIds: ["event-policy-evaluated"],
        metadata: {
          requestId: "req-shell",
          runId: "run-policy-trace",
          phase: "verification",
          policyStatus: "approval_required",
          decisionHash: "sha256:decision",
          requestHash: "sha256:request",
          policyBundleHash: "sha256:bundle",
          decidingLayer: "capability",
          matchedRuleIds: ["tool.shell.exec.default"]
        }
      }
    });
    const trace = await readTrace({
      rootDir,
      runId: "run-policy-trace"
    });

    expect(span).toMatchObject({
      kind: "policy",
      status: "approval_required",
      eventIds: ["event-policy-evaluated"],
      metadata: {
        policyStatus: "approval_required",
        decisionHash: "sha256:decision",
        requestHash: "sha256:request",
        policyBundleHash: "sha256:bundle",
        decidingLayer: "capability",
        matchedRuleIds: ["tool.shell.exec.default"]
      }
    });
    expect(trace.spans[0]).toEqual(span);
  });

  test("continues to accept the known closed span kind set", async () => {
    const knownKinds = [
      "phase",
      "tool",
      "mcp",
      "policy",
      "eval",
      "gate",
      "approval",
      "cache",
      "harness.load",
      "harness.fetch",
      "harness.verify_trust",
      "harness.parse",
      "harness.validate",
      "harness.resolve_deps",
      "harness.compatibility",
      "harness.grant_check",
      "harness.freeze"
    ] satisfies TraceSpanKind[];

    await writeTrace({
      rootDir,
      runId: "run-known-span-kinds",
      trace: {
        runId: "run-known-span-kinds",
        traceId: "trace-known-span-kinds",
        spans: knownKinds.map((kind, index) => ({
          runId: "run-known-span-kinds",
          traceId: "trace-known-span-kinds",
          spanId: `span-${kind.replace(/\./g, "-")}`,
          kind,
          name: `known.${kind}`,
          status: "success",
          startedAt: `2026-06-07T00:00:${String(index).padStart(2, "0")}.000Z`,
          metadata: {}
        })),
        metadata: {}
      }
    });

    const trace = await readTrace({
      rootDir,
      runId: "run-known-span-kinds"
    });

    expect(trace.spans.map((span) => span.kind)).toEqual(knownKinds);
  });

  test("records and reads an mcp parent span with a linked child span", async () => {
    await createRun({
      rootDir,
      runId: "run-mcp-trace",
      traceId: "trace-mcp",
      input: {
        ...runInput,
        host: {
          kind: "mcp"
        }
      },
      harness
    });

    const parent = await recordTraceSpan({
      rootDir,
      runId: "run-mcp-trace",
      traceId: "trace-mcp",
      hostAdapter: "mcp",
      span: {
        spanId: "span-mcp-tools-call",
        kind: "mcp",
        name: "mcp.tools.call.specwright_call_tool",
        status: "success",
        startedAt: "2026-06-07T00:00:00.000Z",
        endedAt: "2026-06-07T00:00:00.125Z",
        eventIds: ["event-tool-requested", "event-tool-completed"],
        metadata: {
          mcpRequestId: "mcp_req_123",
          clientId: "client-cli",
          subjectId: "subject-operator",
          runtimeOperation: "callTool",
          toolName: "specwright_call_tool"
        }
      }
    });
    const child = await recordTraceSpan({
      rootDir,
      runId: "run-mcp-trace",
      traceId: "trace-mcp",
      span: {
        spanId: "span-tool-child",
        parentSpanId: parent.spanId,
        kind: "tool",
        name: "tool.fs.read",
        status: "success",
        startedAt: "2026-06-07T00:00:00.025Z",
        endedAt: "2026-06-07T00:00:00.100Z",
        eventIds: ["event-tool-requested", "event-tool-completed"],
        metadata: {
          toolId: "fs.read",
          toolVersion: "0.1.0",
          toolCallId: "tool-call-123",
          cacheStatus: "bypass",
          policyStatus: "allow"
        }
      }
    });
    const trace = await readTrace({
      rootDir,
      runId: "run-mcp-trace"
    });

    expect(parent).toMatchObject({
      kind: "mcp",
      spanId: "span-mcp-tools-call",
      status: "success",
      eventIds: ["event-tool-requested", "event-tool-completed"],
      metadata: {
        mcpRequestId: "mcp_req_123",
        runtimeOperation: "callTool"
      }
    });
    expect(parent.parentSpanId).toBeUndefined();
    expect(trace.spans).toEqual([parent, child]);
    expect(trace.spans[1]).toMatchObject({
      kind: "tool",
      parentSpanId: "span-mcp-tools-call"
    });
  });

  test("rejects unknown span kinds", async () => {
    await createRun({
      rootDir,
      runId: "run-invalid-kind",
      traceId: "trace-invalid-kind",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-invalid-kind");

    await writeFile(
      paths.tracePath,
      `${JSON.stringify(
        {
          runId: "run-invalid-kind",
          traceId: "trace-invalid-kind",
          spans: [
            {
              runId: "run-invalid-kind",
              traceId: "trace-invalid-kind",
              spanId: "span-invalid",
              kind: "not-a-real-kind",
              name: "invalid",
              status: "success",
              startedAt: "2026-06-07T00:00:00.000Z",
              metadata: {}
            }
          ],
          metadata: {}
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      readTrace({
        rootDir,
        runId: "run-invalid-kind"
      })
    ).rejects.toThrow(TraceRecorderError);
    await expect(
      readTrace({
        rootDir,
        runId: "run-invalid-kind"
      })
    ).rejects.toMatchObject({
      code: "invalid_trace"
    });
  });
});
