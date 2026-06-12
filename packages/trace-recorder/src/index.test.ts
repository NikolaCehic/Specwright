import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  createRun,
  getRunStorePaths,
  readEvents,
  type HarnessSnapshot
} from "@specwright/run-store";
import type { RunInput, RuntimeEvent, ToolCallRequest } from "@specwright/schemas";
import {
  MANDATORY_COVERAGE_RULES,
  TraceRecorder,
  TraceRecorderError,
  assertTraceAttributed,
  getCoverageVerdict,
  readTrace,
  readTraceForAudit,
  recordTraceSpan,
  writeTrace
} from "./index";
import type { TraceFile, TraceSpan, TraceSpanKind } from "./index";

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

  test("rejects unknown span statuses", async () => {
    await createRun({
      rootDir,
      runId: "run-invalid-status",
      traceId: "trace-invalid-status",
      input: runInput,
      harness
    });
    const paths = getRunStorePaths(rootDir, "run-invalid-status");

    await writeFile(
      paths.tracePath,
      `${JSON.stringify(
        {
          runId: "run-invalid-status",
          traceId: "trace-invalid-status",
          spans: [
            {
              runId: "run-invalid-status",
              traceId: "trace-invalid-status",
              spanId: "span-invalid-status",
              kind: "tool",
              name: "invalid.status",
              status: "not-a-real-status",
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
        runId: "run-invalid-status"
      })
    ).rejects.toThrow(TraceRecorderError);
    await expect(
      readTrace({
        rootDir,
        runId: "run-invalid-status"
      })
    ).rejects.toMatchObject({
      code: "invalid_trace"
    });
  });
});

describe("trace coverage verdict", () => {
  test("declares active and pending mandatory coverage rules", () => {
    expect(MANDATORY_COVERAGE_RULES).toContainEqual(
      expect.objectContaining({
        eventType: "phase.entered",
        requiredSpanKind: "phase",
        requiredMetadataKeys: ["phaseId"],
        requiresEventIdLink: true,
        status: "active"
      })
    );
    expect(MANDATORY_COVERAGE_RULES).toContainEqual(
      expect.objectContaining({
        eventType: "tool.completed",
        requiredSpanKind: "tool",
        requiredMetadataKeys: [
          "toolId",
          "toolVersion",
          "toolCallId",
          "toolStatus",
          "cacheStatus",
          "policyStatus"
        ],
        requiresEventIdLink: true,
        status: "active"
      })
    );
    expect(MANDATORY_COVERAGE_RULES).toContainEqual(
      expect.objectContaining({
        eventType: "harness.loaded",
        requiredSpanKind: "harness.load",
        status: "pending"
      })
    );
    expect(MANDATORY_COVERAGE_RULES).toContainEqual(
      expect.objectContaining({
        eventType: "policy.evaluated",
        requiredSpanKind: "policy",
        status: "pending"
      })
    );
    expect(MANDATORY_COVERAGE_RULES).toContainEqual(
      expect.objectContaining({
        eventType: "tool.completed",
        requiredSpanKind: "cache",
        status: "pending"
      })
    );
    expect(MANDATORY_COVERAGE_RULES).toContainEqual(
      expect.objectContaining({
        eventType: "decision.recorded",
        requiredSpanKind: "approval",
        status: "pending"
      })
    );
  });

  test("does not require pending coverage spans for strict verdicts", async () => {
    const fixture = await createCoverageFixture("run-coverage-active-only");
    const trace = completeCoverageTrace(fixture, {
      filterSpan(span) {
        return span.kind !== "harness.load" && span.kind !== "cache";
      }
    });
    const verdict = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(fixture.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["harness.loaded", "tool.completed"])
    );
    expect(trace.spans.map((span) => span.kind)).toEqual([
      "phase",
      "tool",
      "eval",
      "gate"
    ]);
    expect(verdict).toEqual({
      complete: true,
      attributed: true,
      gaps: []
    });
  });

  test("reports a complete verdict for a fully attributed covered trace", async () => {
    const fixture = await createCoverageFixture("run-coverage-complete");
    const trace = completeCoverageTrace(fixture);
    const first = getCoverageVerdict({
      trace,
      events: fixture.events
    });
    const second = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(first).toEqual({
      complete: true,
      attributed: true,
      gaps: []
    });
    expect(second).toEqual(first);
  });

  test("rejects missing and empty attribution at audit ingress", async () => {
    const fixture = await createCoverageFixture("run-coverage-unattributed");
    const trace = completeCoverageTrace(fixture);
    const unattributed = {
      ...trace,
      harnessSpecHash: undefined
    };
    const emptyRuntimeVersion = {
      ...trace,
      runtimeVersion: ""
    };

    expect(() => assertTraceAttributed(unattributed)).toThrow(
      /harnessSpecHash/
    );
    expect(() => assertTraceAttributed(emptyRuntimeVersion)).toThrow(
      /runtimeVersion/
    );

    const verdict = getCoverageVerdict({
      trace: unattributed,
      events: fixture.events
    });

    expect(verdict).toMatchObject({
      complete: false,
      attributed: false
    });
    expect(verdict.gaps).toContainEqual(
      expect.objectContaining({
        reason: "unattributed_trace",
        field: "harnessSpecHash"
      })
    );
  });

  test("readTraceForAudit rejects missing attribution fields", async () => {
    await writeTrace({
      rootDir,
      runId: "run-audit-unattributed",
      trace: {
        runId: "run-audit-unattributed",
        traceId: "trace-audit-unattributed",
        spans: [],
        metadata: {}
      }
    });

    await expect(
      readTraceForAudit({
        rootDir,
        runId: "run-audit-unattributed"
      })
    ).rejects.toMatchObject({
      code: "invalid_trace",
      message: expect.stringContaining("runtimeVersion")
    });
  });

  test("readTraceForAudit rejects coverage spans missing required metadata", async () => {
    const fixture = await createCoverageFixture("run-audit-missing-metadata");
    const trace = completeCoverageTrace(fixture, {
      mutateSpan(span) {
        if (span.kind === "tool") {
          const { toolVersion: _toolVersion, ...metadata } = span.metadata;

          return {
            ...span,
            metadata
          };
        }

        return span;
      }
    });

    await writeTrace({
      rootDir,
      runId: fixture.runId,
      trace
    });

    await expect(
      readTraceForAudit({
        rootDir,
        runId: fixture.runId
      })
    ).rejects.toMatchObject({
      code: "invalid_trace",
      message: expect.stringContaining("toolVersion")
    });
  });

  test("readTraceForAudit ignores pending-only metadata by default", async () => {
    const fixture = await createCoverageFixture("run-audit-pending-metadata");
    const trace = completeCoverageTrace(fixture, {
      mutateSpan(span) {
        if (span.kind === "harness.load" || span.kind === "cache") {
          return {
            ...span,
            metadata: {}
          };
        }

        return span;
      }
    });

    await writeTrace({
      rootDir,
      runId: fixture.runId,
      trace
    });

    await expect(
      readTraceForAudit({
        rootDir,
        runId: fixture.runId
      })
    ).resolves.toMatchObject({
      runId: fixture.runId
    });
  });

  test("reports a missing mandatory span", async () => {
    const fixture = await createCoverageFixture("run-coverage-missing-span");
    const trace = completeCoverageTrace(fixture, {
      filterSpan(span) {
        return span.kind !== "tool";
      }
    });
    const verdict = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.gaps).toContainEqual(
      expect.objectContaining({
        reason: "missing_span",
        eventId: fixture.toolRequested.id,
        eventType: "tool.requested",
        requiredSpanKind: "tool"
      })
    );
  });

  test("reports missing mandatory metadata", async () => {
    const fixture = await createCoverageFixture("run-coverage-missing-metadata");
    const trace = completeCoverageTrace(fixture, {
      mutateSpan(span) {
        if (span.kind === "tool") {
          const { toolVersion: _toolVersion, ...metadata } = span.metadata;

          return {
            ...span,
            metadata
          };
        }

        return span;
      }
    });
    const verdict = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.gaps).toContainEqual(
      expect.objectContaining({
        reason: "missing_metadata",
        eventId: fixture.toolRequested.id,
        requiredSpanKind: "tool",
        spanId: "span-tool-read",
        missingMetadataKeys: ["toolVersion"]
      })
    );
  });

  test("reports a missing event id link", async () => {
    const fixture = await createCoverageFixture("run-coverage-missing-link");
    const trace = completeCoverageTrace(fixture, {
      mutateSpan(span) {
        return span.kind === "tool"
          ? {
              ...span,
              eventIds: [fixture.toolRequested.id]
            }
          : span;
      }
    });
    const verdict = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.gaps).toContainEqual(
      expect.objectContaining({
        reason: "missing_event_link",
        eventId: fixture.toolCompleted.id,
        eventType: "tool.completed",
        requiredSpanKind: "tool"
      })
    );
  });

  test("reports span/event disagreement without changing event authority", async () => {
    const fixture = await createCoverageFixture("run-coverage-disagreement");
    const trace = completeCoverageTrace(fixture, {
      mutateSpan(span) {
        return span.kind === "tool"
          ? {
              ...span,
              status: "denied"
            }
          : span;
      }
    });
    const verdict = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(
      fixture.events.find((event) => event.id === fixture.toolCompleted.id)
        ?.type
    ).toBe("tool.completed");
    expect(verdict.complete).toBe(false);
    expect(verdict.gaps).toContainEqual(
      expect.objectContaining({
        reason: "span_event_disagreement",
        requiredSpanKind: "tool",
        spanId: "span-tool-read"
      })
    );
  });

  test("reports spans linked to unknown events", async () => {
    const fixture = await createCoverageFixture("run-coverage-unknown-link");
    const trace = completeCoverageTrace(fixture, {
      mutateSpan(span) {
        return span.kind === "tool"
          ? {
              ...span,
              eventIds: [
                fixture.toolRequested.id,
                fixture.toolCompleted.id,
                "event-does-not-exist"
              ]
            }
          : span;
      }
    });
    const verdict = getCoverageVerdict({
      trace,
      events: fixture.events
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.gaps).toContainEqual(
      expect.objectContaining({
        reason: "span_event_disagreement",
        spanId: "span-tool-read",
        message: expect.stringContaining("event-does-not-exist")
      })
    );
  });
});

type CoverageFixture = {
  runId: string;
  events: RuntimeEvent[];
  harnessLoaded: RuntimeEvent;
  phaseEntered: RuntimeEvent;
  toolRequested: RuntimeEvent;
  toolCompleted: RuntimeEvent;
  evalCompleted: RuntimeEvent;
  gateEvaluated: RuntimeEvent;
};

type TraceMutationOptions = {
  filterSpan?: (span: TraceSpan) => boolean;
  mutateSpan?: (span: TraceSpan) => TraceSpan;
};

const coverageToolRequest = {
  toolId: "fs.read",
  args: {
    path: "README.md"
  },
  reason: "coverage fixture",
  idempotencyKey: "coverage-tool-read",
  requestedBy: {
    phase: "intake"
  }
} satisfies ToolCallRequest;

const coverageHarness = {
  id: harness.id,
  version: harness.version,
  schemaVersion: "specwright.harness.v0",
  specHash: harness.specHash,
  loadedAt: "2026-06-07T00:00:00.000Z",
  phases: [],
  gates: [],
  policies: [],
  tools: [],
  artifacts: [],
  evals: [],
  roles: [],
  prompts: []
};

async function createCoverageFixture(runId: string): Promise<CoverageFixture> {
  const traceId = `trace-${runId}`;

  await createRun({
    rootDir,
    runId,
    traceId,
    input: runInput,
    harness
  });

  const harnessLoaded = await appendEvent({
    rootDir,
    runId,
    type: "harness.loaded",
    payload: {
      harness: coverageHarness
    },
    timestamp: "2026-06-07T00:00:01.000Z"
  });
  const phaseEntered = await appendEvent({
    rootDir,
    runId,
    type: "phase.entered",
    payload: {
      phase: "intake",
      reason: "coverage_fixture"
    },
    causationId: harnessLoaded.event.id,
    timestamp: "2026-06-07T00:00:02.000Z"
  });
  const toolRequested = await appendEvent({
    rootDir,
    runId,
    type: "tool.requested",
    payload: {
      request: coverageToolRequest
    },
    causationId: phaseEntered.event.id,
    timestamp: "2026-06-07T00:00:03.000Z"
  });
  const toolCompleted = await appendEvent({
    rootDir,
    runId,
    type: "tool.completed",
    payload: {
      request: coverageToolRequest,
      result: {
        toolCallId: "tool-call-read",
        status: "success",
        output: {
          ok: true
        },
        provenance: {
          toolId: "fs.read",
          toolVersion: "0.1.0",
          argsHash: "sha256:args",
          resultHash: "sha256:result",
          cacheStatus: "bypass",
          traceId,
          adapterVersion: "0.1.0",
          decisionHash: "sha256:decision"
        }
      }
    },
    causationId: toolRequested.event.id,
    timestamp: "2026-06-07T00:00:04.000Z"
  });
  const evalCompleted = await appendEvent({
    rootDir,
    runId,
    type: "eval.completed",
    payload: {
      evalId: "eval.required",
      verdict: {
        evalId: "eval.required",
        targetRef: "artifact:plan",
        status: "pass",
        severity: "blocking",
        findings: [],
        evidenceRefs: ["evidence:task"],
        producedBy: {
          kind: "deterministic",
          ref: "coverage-fixture"
        }
      }
    },
    causationId: toolCompleted.event.id,
    timestamp: "2026-06-07T00:00:05.000Z"
  });
  const gateEvaluated = await appendEvent({
    rootDir,
    runId,
    type: "gate.evaluated",
    payload: {
      gateId: "intake.exit",
      verdict: {
        gateId: "intake.exit",
        phase: "intake",
        status: "pass",
        severity: "blocking",
        reasons: ["Coverage fixture passed"],
        findings: [],
        evidenceRefs: [],
        obligations: [],
        evaluatedAt: "2026-06-07T00:00:06.000Z",
        evaluator: {
          kind: "deterministic",
          ref: "coverage-fixture"
        }
      },
      instruction: {
        kind: "continue",
        gateId: "intake.exit"
      }
    },
    causationId: evalCompleted.event.id,
    timestamp: "2026-06-07T00:00:06.000Z"
  });

  return {
    runId,
    events: await readEvents({ rootDir, runId }),
    harnessLoaded: harnessLoaded.event,
    phaseEntered: phaseEntered.event,
    toolRequested: toolRequested.event,
    toolCompleted: toolCompleted.event,
    evalCompleted: evalCompleted.event,
    gateEvaluated: gateEvaluated.event
  };
}

function completeCoverageTrace(
  fixture: CoverageFixture,
  options: TraceMutationOptions = {}
): TraceFile {
  const spans: TraceSpan[] = [
    coverageSpan(fixture, {
      spanId: "span-harness-load",
      kind: "harness.load",
      name: "harness.load",
      status: "success",
      startedAt: fixture.harnessLoaded.timestamp,
      endedAt: fixture.harnessLoaded.timestamp,
      eventIds: [fixture.harnessLoaded.id],
      metadata: {
        specHash: harness.specHash
      }
    }),
    coverageSpan(fixture, {
      spanId: "span-phase-intake",
      kind: "phase",
      name: "phase.intake",
      status: "success",
      startedAt: fixture.phaseEntered.timestamp,
      endedAt: fixture.phaseEntered.timestamp,
      eventIds: [fixture.phaseEntered.id],
      metadata: {
        phaseId: "intake"
      }
    }),
    coverageSpan(fixture, {
      spanId: "span-tool-read",
      kind: "tool",
      name: "tool.fs.read",
      status: "success",
      startedAt: fixture.toolRequested.timestamp,
      endedAt: fixture.toolCompleted.timestamp,
      eventIds: [fixture.toolRequested.id, fixture.toolCompleted.id],
      metadata: {
        phaseId: "intake",
        toolId: "fs.read",
        toolVersion: "0.1.0",
        toolCallId: "tool-call-read",
        toolStatus: "success",
        cacheStatus: "bypass",
        policyStatus: "allow"
      }
    }),
    coverageSpan(fixture, {
      spanId: "span-cache-read",
      kind: "cache",
      name: "cache.fs.read",
      status: "bypass",
      startedAt: fixture.toolRequested.timestamp,
      endedAt: fixture.toolCompleted.timestamp,
      eventIds: [fixture.toolCompleted.id],
      metadata: {
        cacheStatus: "bypass"
      }
    }),
    coverageSpan(fixture, {
      spanId: "span-eval-required",
      kind: "eval",
      name: "eval.required",
      status: "pass",
      startedAt: fixture.evalCompleted.timestamp,
      endedAt: fixture.evalCompleted.timestamp,
      eventIds: [fixture.evalCompleted.id],
      metadata: {
        phaseId: "intake",
        evalId: "eval.required"
      }
    }),
    coverageSpan(fixture, {
      spanId: "span-gate-intake-exit",
      kind: "gate",
      name: "gate.intake.exit",
      status: "pass",
      startedAt: fixture.gateEvaluated.timestamp,
      endedAt: fixture.gateEvaluated.timestamp,
      eventIds: [fixture.gateEvaluated.id],
      metadata: {
        phaseId: "intake",
        gateId: "intake.exit",
        instruction: "continue"
      }
    })
  ];
  const mutatedSpans = spans
    .filter(options.filterSpan ?? (() => true))
    .map(options.mutateSpan ?? ((span) => span));

  return {
    runId: fixture.runId,
    traceId: `trace-${fixture.runId}`,
    runtimeVersion: "0.1.0",
    harnessSpecHash: harness.specHash,
    hostAdapter: "cli",
    spans: mutatedSpans,
    metadata: {}
  };
}

function coverageSpan(
  fixture: CoverageFixture,
  span: Omit<TraceSpan, "runId" | "traceId">
): TraceSpan {
  return {
    runId: fixture.runId,
    traceId: `trace-${fixture.runId}`,
    ...span
  };
}
