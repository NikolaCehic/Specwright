import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendArtifact } from "@specwright/artifact-store";
import { appendEvidence } from "@specwright/evidence-store";
import {
  DEFAULT_REDACTION_PROFILE,
  appendEvent,
  createRun,
  getRunStorePaths,
  readEvents,
  type HarnessSnapshot,
  type RedactionProfile
} from "@specwright/run-store";
import type {
  EvalVerdict,
  EvidenceRecord,
  RunInput,
  RuntimeEvent
} from "@specwright/schemas";
import { readTrace, recordTraceSpan, writeTrace } from "@specwright/trace-recorder";
import {
  generateRunReport,
  readRunSummary,
  reconcileEventsAndTrace,
  reconcileRun,
  writeRunReport
} from "./index";

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

const passedEval = {
  evalId: "source_fidelity",
  targetRef: "artifact:plan",
  status: "pass",
  severity: "blocking",
  findings: [],
  evidenceRefs: ["evidence:repo:package-json"],
  producedBy: {
    kind: "deterministic",
    ref: "test"
  }
} satisfies EvalVerdict;

const redactionProfile = {
  ...DEFAULT_REDACTION_PROFILE,
  id: "packet-03-test-profile"
} satisfies RedactionProfile;

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-run-reports-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("run reports", () => {
  test("generates a report from a minimal successful run event log", async () => {
    await createSuccessfulRun("run-success");

    const report = await generateRunReport({
      rootDir,
      runId: "run-success"
    });

    expect(report.markdown).toContain("# Run Summary");
    expect(report.markdown).toContain("Task: Create a source-bound frontend contract");
    expect(report.markdown).toContain("Harness: `default@0.0.0` (sha256:test)");
    expect(report.markdown).toContain("Replayable run package: `.archetype/runs/run-success`");
    expect(report.markdown).toContain("intake (phase.entered");
    expect(report.markdown).toContain("context_sufficiency: pass");
    expect(report.markdown).toContain("source_fidelity: pass");
    expect(report.markdown).toContain("redaction profile: default-redacted-egress");
  });

  test("includes tools, gate verdicts, eval verdicts, artifacts, evidence, and unknowns", async () => {
    await createSuccessfulRun("run-rich");
    await appendArtifact({
      rootDir,
      runId: "run-rich",
      record: {
        artifactId: "artifact-plan",
        artifactType: "plan",
        content: {
          steps: ["Read source files"]
        },
        evidenceRefs: ["evidence:repo:package-json"],
        claimLevel: "source_fact",
        producedBy: {
          phase: "planning",
          actionId: "record-plan",
          toolCallId: "tool-call-1"
        },
        metadata: {}
      }
    });
    await appendEvidence({
      rootDir,
      runId: "run-rich",
      record: sourceFact("evidence:repo:package-json")
    });
    await appendEvidence({
      rootDir,
      runId: "run-rich",
      record: {
        id: "evidence:unknown:browser-state",
        class: "unknown",
        claim: "The browser-rendered layout was not inspected.",
        sourceRefs: [],
        confidence: "low",
        authority: "model",
        unknownReason: "No browser inspection was run for this report fixture.",
        redactionPolicy: "operator",
        createdBy: {
          phase: "verification",
          actionId: "record-unknown"
        }
      }
    });
    await recordTraceSpan({
      rootDir,
      runId: "run-rich",
      span: {
        kind: "tool",
        name: "tool.fs.read",
        status: "success",
        startedAt: "2026-05-29T00:00:00.000Z",
        durationMs: 12,
        metadata: {
          toolId: "fs.read",
          toolCallId: "tool-call-1",
          phaseId: "evidence",
          cacheStatus: "bypass",
          policyStatus: "allow"
        }
      }
    });

    const report = await generateRunReport({
      rootDir,
      runId: "run-rich"
    });

    expect(report.markdown).toContain("fs.read: success");
    expect(report.markdown).toContain("cache bypass");
    expect(report.markdown).toContain("policy allow");
    expect(report.markdown).toContain("context_sufficiency: pass");
    expect(report.markdown).toContain("source_fidelity: pass");
    expect(report.markdown).toContain("artifact-plan (plan)");
    expect(report.markdown).toContain("evidence:repo:package-json: source_fact/high/repo");
    expect(report.markdown).toContain("evidence:unknown:browser-state: unknown/low/model");
    expect(report.markdown).toContain("What Remains Unknown");
    expect(report.markdown).toContain("browser-rendered layout was not inspected");
    expect(report.markdown).toContain("sha256:");
  });

  test("remains useful when optional trace, evidence, artifact, and eval files are missing", async () => {
    await createSuccessfulRun("run-missing");
    const paths = getRunStorePaths(rootDir, "run-missing");

    await rm(paths.tracePath, { force: true });
    await rm(paths.artifactsDir, { recursive: true, force: true });
    await rm(paths.evidenceDir, { recursive: true, force: true });
    await rm(paths.evalsDir, { recursive: true, force: true });

    const report = await generateRunReport({
      rootDir,
      runId: "run-missing"
    });

    expect(report.markdown).toContain("events.jsonl:");
    expect(report.markdown).toContain("trace.json: missing");
    expect(report.markdown).toContain("missing optional inputs:");
    expect(report.markdown).toContain("tool.fs.read");
    expect(report.markdown).toContain("context_sufficiency: pass");
    expect(report.markdown).toContain("source_fidelity: pass");
  });

  test("redacts report and trace egress while preserving hash references and profile id", async () => {
    await createRun({
      rootDir,
      runId: "run-redacted-report",
      traceId: "trace-redacted-report",
      input: runInput,
      harness,
      initialPhase: "created",
      timestamp: "2026-05-29T00:00:00.000Z"
    });
    await appendEvent({
      rootDir,
      runId: "run-redacted-report",
      type: "tool.completed",
      payload: {
        request: {
          toolId: "tool.fs.read",
          args: {
            path: "package.json",
            token: "sk_live_fixture_scope_02_packet_03"
          },
          reason: "Read restricted source",
          idempotencyKey: "read-restricted-source",
          requestedBy: {
            phase: "evidence"
          }
        },
        result: {
          toolCallId: "tool-call-redaction",
          status: "success",
          output: {
            contents:
              "DATABASE_URL=postgres://scope-02-packet-03@example.invalid/specwright"
          },
          provenance: {
            toolId: "tool.fs.read",
            toolVersion: "0.1.0",
            adapterVersion: "0.1.0",
            argsHash:
              "sha256:d8576b4d26ccf208a9372f9df7e7e9d6786fd8a292091fea2bc1e86a6a41b5d8",
            resultHash:
              "sha256:4b01f791f3caecd55bb6f23a443731846f66adef1d7bc0c1c8d817cf32603fbe",
            decisionHash: "sha256:report-redaction-decision",
            cacheStatus: "bypass",
            traceId: "trace-redacted-report"
          }
        }
      },
      timestamp: "2026-05-29T00:00:01.000Z"
    });
    await appendEvent({
      rootDir,
      runId: "run-redacted-report",
      type: "evidence.recorded",
      payload: {
        evidence: {
          id: "evidence:restricted-source",
          class: "source_fact",
          claim:
            "The restricted source contains DATABASE_URL=postgres://scope-02-packet-03@example.invalid/specwright",
          sourceRefs: [
            {
              path: "restricted.env",
              contentHash:
                "sha256:6d40eaf5353d46203a2663fe017bce6d4ba504ed166ed4f27711460e6867d306",
              authority: "repo",
              redactionClass: "restricted",
              captureToolCallId: "tool-call-redaction"
            }
          ],
          confidence: "high",
          authority: "repo",
          redactionPolicy: "restricted",
          createdBy: {
            phase: "evidence",
            actionId: "record-restricted-source",
            toolCallId: "tool-call-redaction"
          }
        }
      },
      timestamp: "2026-05-29T00:00:02.000Z"
    });
    await recordTraceSpan({
      rootDir,
      runId: "run-redacted-report",
      traceId: "trace-redacted-report",
      span: {
        kind: "tool",
        name: "tool.trace.read",
        status: "success",
        startedAt: "2026-05-29T00:00:01.000Z",
        durationMs: 7,
        eventIds: ["tool-call-redaction"],
        metadata: {
          toolId: "tool.trace.read",
          toolCallId: "trace-tool-call-redaction",
          phaseId: "evidence",
          args: {
            token: "sk_live_trace_scope_02_packet_03"
          },
          output: {
            contents:
              "TRACE_DATABASE_URL=postgres://scope-02-packet-03@example.invalid/specwright"
          },
          argsHash: "sha256:trace-args",
          resultHash: "sha256:trace-result",
          cacheStatus: "bypass",
          policyStatus: "allow"
        }
      }
    });

    const report = await generateRunReport({
      rootDir,
      runId: "run-redacted-report",
      profile: redactionProfile
    });

    expect(report.markdown).toContain(
      "redaction profile: packet-03-test-profile"
    );
    expect(report.markdown).toContain(
      "sha256:d8576b4d26ccf208a9372f9df7e7e9d6786fd8a292091fea2bc1e86a6a41b5d8"
    );
    expect(report.markdown).toContain(
      "sha256:4b01f791f3caecd55bb6f23a443731846f66adef1d7bc0c1c8d817cf32603fbe"
    );
    expect(report.markdown).toContain(
      "sha256:6d40eaf5353d46203a2663fe017bce6d4ba504ed166ed4f27711460e6867d306"
    );
    expect(report.markdown).toContain("sha256:trace-args");
    expect(report.markdown).toContain("sha256:trace-result");
    expect(report.markdown).not.toContain(
      "sk_live_fixture_scope_02_packet_03"
    );
    expect(report.markdown).not.toContain("sk_live_trace_scope_02_packet_03");
    expect(report.markdown).not.toContain("DATABASE_URL=");
    expect(report.markdown).not.toContain("TRACE_DATABASE_URL=");
    expect(report.markdown).toContain("source_fact/high/repo");
    expect(report.markdown).toContain("1 source ref(s)");
  });

  test("writes summary.md under the run package", async () => {
    await createSuccessfulRun("run-write-summary");

    const report = await writeRunReport({
      rootDir,
      runId: "run-write-summary"
    });
    const paths = getRunStorePaths(rootDir, "run-write-summary");

    expect(report.summaryPath).toBe(paths.summaryPath);
    expect(await readRunSummary({ rootDir, runId: "run-write-summary" })).toBe(
      report.markdown
    );
    expect(await readFile(paths.summaryPath, "utf8")).toContain("# Run Summary");
  });

  test("reconciles a fully linked run as consistent and emits metrics", async () => {
    const fixture = await createFullyTracedRun("run-reconciled-clean");

    const result = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });

    expect(result.verdict).toBe("consistent");
    expect(result.gaps).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.integrityMetrics.map((metric) => metric.class)).toEqual([
      "trace-to-event-consistency-rate",
      "missing-input-rate",
      "schema-validation-failure-rate"
    ]);
    expect(metric(result, "trace-to-event-consistency-rate")?.value).toBe(1);
  });

  test("flags a mandatory span linked to an unknown event as an unlinkable gap", async () => {
    const fixture = await createFullyTracedRun("run-reconciled-unlinkable");
    await recordTraceSpan({
      rootDir,
      runId: fixture.runId,
      traceId: `trace-${fixture.runId}`,
      span: {
        spanId: "span-unlinkable-tool",
        kind: "tool",
        name: "tool.fs.read",
        status: "success",
        startedAt: "2026-05-29T00:00:09.000Z",
        eventIds: ["event-does-not-exist"],
        metadata: toolTraceMetadata()
      }
    });

    const result = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });

    expect(result.verdict).toBe("gap");
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        kind: "unlinkable_span_event",
        spanId: "span-unlinkable-tool",
        unknownEventId: "event-does-not-exist"
      })
    );
    expect(result.mandatoryCoverage).toContainEqual(
      expect.objectContaining({
        status: "unlinkable",
        spanId: "span-unlinkable-tool"
      })
    );
  });

  test("flags mandatory-kind spans without eventIds as non-attestable gaps", async () => {
    const fixture = await createFullyTracedRun("run-reconciled-unlinked-span");
    await recordTraceSpan({
      rootDir,
      runId: fixture.runId,
      traceId: `trace-${fixture.runId}`,
      span: {
        spanId: "span-tool-without-event-ids",
        kind: "tool",
        name: "tool.fs.read",
        status: "success",
        startedAt: "2026-05-29T00:00:09.000Z",
        metadata: toolTraceMetadata()
      }
    });

    const result = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });

    expect(result.verdict).toBe("gap");
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        kind: "missing_span_event_link",
        spanId: "span-tool-without-event-ids",
        spanKind: "tool",
        requiredSpanKind: "tool"
      })
    );
    expect(result.mandatoryCoverage).toContainEqual(
      expect.objectContaining({
        status: "unlinkable",
        spanId: "span-tool-without-event-ids",
        spanKind: "tool"
      })
    );
  });

  test("flags an active mandatory lifecycle event with no covering span as a gap", async () => {
    await createSuccessfulRun("run-reconciled-missing-coverage");
    await writeTrace({
      rootDir,
      runId: "run-reconciled-missing-coverage",
      trace: {
        runId: "run-reconciled-missing-coverage",
        traceId: "trace-run-reconciled-missing-coverage",
        spans: [],
        metadata: {}
      }
    });

    const result = await reconcileRun({
      rootDir,
      runId: "run-reconciled-missing-coverage"
    });

    expect(result.verdict).toBe("gap");
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        kind: "missing_coverage",
        eventType: "phase.entered",
        requiredSpanKind: "phase"
      })
    );
  });

  test("reports trace status disagreement as a mismatch and keeps the event authoritative", async () => {
    const fixture = await createFullyTracedRun("run-reconciled-mismatch");
    const trace = await readTrace({
      rootDir,
      runId: fixture.runId
    });

    await writeTrace({
      rootDir,
      runId: fixture.runId,
      trace: {
        ...trace,
        spans: trace.spans.map((span) =>
          span.spanId === fixture.toolSpanId
            ? { ...span, status: "failed" }
            : span
        )
      }
    });

    const result = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });

    expect(result.verdict).toBe("mismatch");
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        eventId: fixture.toolCompletedEventId,
        eventType: "tool.completed",
        spanId: fixture.toolSpanId,
        observedSpanStatus: "failed",
        authoritativeEventStatus: "success"
      })
    );
  });

  test("flags terminal tool spans without linked outcome events as mismatches", async () => {
    for (const spanStatus of ["denied", "failed"] as const) {
      const fixture = await createFullyTracedRun(
        `run-reconciled-request-only-${spanStatus}`
      );
      const trace = await readTrace({
        rootDir,
        runId: fixture.runId
      });

      await writeTrace({
        rootDir,
        runId: fixture.runId,
        trace: {
          ...trace,
          spans: trace.spans.map((span) =>
            span.spanId === fixture.toolSpanId
              ? {
                  ...span,
                  status: spanStatus,
                  eventIds: [fixture.toolRequestedEventId]
                }
              : span
          )
        }
      });

      const result = await reconcileRun({
        rootDir,
        runId: fixture.runId
      });

      expect(result.verdict).toBe("mismatch");
      expect(result.mismatches).toContainEqual(
        expect.objectContaining({
          kind: "span_event_status_disagreement",
          eventId: fixture.toolRequestedEventId,
          eventType: "tool.requested",
          spanId: fixture.toolSpanId,
          assertedSpanStatus: spanStatus,
          observedSpanStatus: spanStatus,
          requiredAuthoritativeEventType:
            spanStatus === "denied" ? "tool.denied" : "tool.completed"
        })
      );
    }
  });

  test("surfaces schema validation failures in reconciliation metrics", async () => {
    await createSuccessfulRun("run-reconciled-schema-failures");
    const events = await readEvents({
      rootDir,
      runId: "run-reconciled-schema-failures"
    });

    const result = reconcileEventsAndTrace({
      events,
      missingInputs: [],
      schemaValidationFailures: 2
    });
    const schemaMetric = metric(result, "schema-validation-failure-rate");

    expect(schemaMetric).toEqual(
      expect.objectContaining({
        numerator: 2,
        denominator: events.length,
        value: 2 / events.length
      })
    );
  });

  test("surfaces missing report inputs in the missing-input-rate metric", async () => {
    await createSuccessfulRun("run-reconciled-missing-inputs");
    const paths = getRunStorePaths(rootDir, "run-reconciled-missing-inputs");

    await rm(paths.tracePath, { force: true });
    await rm(paths.artifactsDir, { recursive: true, force: true });
    await rm(paths.evidenceDir, { recursive: true, force: true });
    await rm(paths.evalsDir, { recursive: true, force: true });

    const report = await generateRunReport({
      rootDir,
      runId: "run-reconciled-missing-inputs"
    });
    const missingInputMetric = metric(report.reconciliation, "missing-input-rate");

    expect(report.missingInputs).toEqual([
      "trace.json",
      "artifacts/index.jsonl",
      "evidence/index.jsonl",
      "evals/*.json"
    ]);
    expect(missingInputMetric).toEqual(
      expect.objectContaining({
        numerator: 4,
        denominator: 4,
        value: 1
      })
    );
  });

  test("stamps metrics with the authoritative event source range", async () => {
    const fixture = await createFullyTracedRun("run-reconciled-range");

    const result = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });

    expect(result.sourceEventRange).toEqual({
      firstSequence: 0,
      lastSequence: fixture.events.length - 1,
      eventCount: fixture.events.length
    });
    expect(result.integrityMetrics.every((metricRecord) =>
      JSON.stringify(metricRecord.sourceEventRange) ===
      JSON.stringify(result.sourceEventRange)
    )).toBe(true);
  });

  test("produces deterministic reconciliation JSON for repeated reads", async () => {
    const fixture = await createFullyTracedRun("run-reconciled-deterministic");

    const first = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });
    const second = await reconcileRun({
      rootDir,
      runId: fixture.runId
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

async function createSuccessfulRun(runId: string) {
  await createRun({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    input: runInput,
    harness,
    initialPhase: "created",
    timestamp: "2026-05-29T00:00:00.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "phase.entered",
    payload: {
      phase: "intake"
    },
    timestamp: "2026-05-29T00:00:01.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "tool.requested",
    payload: {
      request: {
        toolId: "tool.fs.read",
        args: {
          path: "package.json"
        },
        reason: "Read package metadata",
        idempotencyKey: "read-package",
        requestedBy: {
          phase: "evidence"
        }
      }
    },
    timestamp: "2026-05-29T00:00:02.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "tool.completed",
    payload: {
      request: {
        toolId: "tool.fs.read",
        requestedBy: {
          phase: "evidence"
        }
      },
      result: {
        toolCallId: "tool-call-1",
        status: "success",
        provenance: {
          toolId: "tool.fs.read",
          toolVersion: "0.1.0",
          adapterVersion: "0.1.0",
          argsHash: "sha256:args",
          resultHash: "sha256:result",
          decisionHash: "sha256:decision",
          cacheStatus: "bypass",
          traceId: `trace-${runId}`
        }
      }
    },
    timestamp: "2026-05-29T00:00:03.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "gate.evaluated",
    payload: {
      gateId: "context_sufficiency",
      verdict: {
        gateId: "context_sufficiency",
        phase: "evidence",
        status: "pass",
        severity: "blocking",
        reasons: ["Required source context exists"],
        findings: [],
        evidenceRefs: ["evidence:repo:package-json"],
        obligations: [],
        evaluatedAt: "2026-05-29T00:00:04.000Z",
        evaluator: {
          kind: "deterministic",
          ref: "test"
        }
      },
      instruction: {
        kind: "continue",
        gateId: "context_sufficiency"
      }
    },
    timestamp: "2026-05-29T00:00:04.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "artifact.recorded",
    payload: {
      artifact: {
        artifactId: "artifact-plan",
        artifactType: "plan",
        evidenceRefs: ["evidence:repo:package-json"],
        uri: "artifacts/plan.json"
      }
    },
    timestamp: "2026-05-29T00:00:05.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "evidence.recorded",
    payload: {
      evidence: sourceFact("evidence:repo:package-json")
    },
    timestamp: "2026-05-29T00:00:06.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "eval.completed",
    payload: {
      evalId: passedEval.evalId,
      verdict: passedEval
    },
    timestamp: "2026-05-29T00:00:07.000Z"
  });
  await appendEvent({
    rootDir,
    runId,
    type: "run.completed",
    payload: {
      reason: "done"
    },
    timestamp: "2026-05-29T00:00:08.000Z"
  });
}

function sourceFact(id: string): EvidenceRecord {
  return {
    id,
    class: "source_fact",
    claim: "The repository declares a runnable package.",
    sourceRefs: [
      {
        path: "package.json",
        locator: "scripts",
        authority: "repo",
        redactionClass: "operator",
        captureToolCallId: "tool-call-1"
      }
    ],
    confidence: "high",
    authority: "repo",
    redactionPolicy: "operator",
    createdBy: {
      phase: "evidence",
      actionId: "read-package-json",
      toolCallId: "tool-call-1"
    }
  };
}

async function createFullyTracedRun(runId: string) {
  await createSuccessfulRun(runId);
  await appendArtifact({
    rootDir,
    runId,
    record: {
      artifactId: "artifact-plan",
      artifactType: "plan",
      content: {
        steps: ["Read source files"]
      },
      evidenceRefs: ["evidence:repo:package-json"],
      claimLevel: "source_fact",
      producedBy: {
        phase: "planning",
        actionId: "record-plan",
        toolCallId: "tool-call-1"
      },
      metadata: {}
    }
  });
  await appendEvidence({
    rootDir,
    runId,
    record: sourceFact("evidence:repo:package-json")
  });
  await writeEvalVerdictFile(runId);

  const events = await readEvents({ rootDir, runId });
  const phaseEntered = requiredEvent(events, "phase.entered");
  const toolRequested = requiredEvent(events, "tool.requested");
  const toolCompleted = requiredEvent(events, "tool.completed");
  const gateEvaluated = requiredEvent(events, "gate.evaluated");
  const evalCompleted = requiredEvent(events, "eval.completed");
  const toolSpanId = `span-tool-${runId}`;

  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    span: {
      spanId: `span-phase-${runId}`,
      kind: "phase",
      name: "intake",
      status: "success",
      startedAt: "2026-05-29T00:00:01.000Z",
      eventIds: [phaseEntered.id],
      metadata: {
        phaseId: "intake"
      }
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    span: {
      spanId: toolSpanId,
      kind: "tool",
      name: "tool.fs.read",
      status: "success",
      startedAt: "2026-05-29T00:00:02.000Z",
      durationMs: 12,
      eventIds: [toolRequested.id, toolCompleted.id],
      metadata: toolTraceMetadata()
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    span: {
      spanId: `span-gate-${runId}`,
      kind: "gate",
      name: "context_sufficiency",
      status: "pass",
      startedAt: "2026-05-29T00:00:04.000Z",
      eventIds: [gateEvaluated.id],
      metadata: {
        gateId: "context_sufficiency",
        phaseId: "evidence",
        instruction: "continue"
      }
    }
  });
  await recordTraceSpan({
    rootDir,
    runId,
    traceId: `trace-${runId}`,
    span: {
      spanId: `span-eval-${runId}`,
      kind: "eval",
      name: "source_fidelity",
      status: "pass",
      startedAt: "2026-05-29T00:00:07.000Z",
      eventIds: [evalCompleted.id],
      metadata: {
        evalId: "source_fidelity",
        phaseId: "verification"
      }
    }
  });

  return {
    runId,
    events,
    toolRequestedEventId: toolRequested.id,
    toolCompletedEventId: toolCompleted.id,
    toolSpanId
  };
}

function toolTraceMetadata() {
  return {
    toolId: "tool.fs.read",
    toolVersion: "0.1.0",
    toolCallId: "tool-call-1",
    toolStatus: "success",
    cacheStatus: "bypass",
    policyStatus: "allow",
    phaseId: "evidence"
  };
}

function requiredEvent(events: readonly RuntimeEvent[], type: RuntimeEvent["type"]) {
  const event = events.find((candidate) => candidate.type === type);

  if (event === undefined) {
    throw new Error(`Missing fixture event ${type}`);
  }

  return event;
}

async function writeEvalVerdictFile(runId: string) {
  const paths = getRunStorePaths(rootDir, runId);

  await mkdir(paths.evalsDir, { recursive: true });
  await writeFile(
    join(paths.evalsDir, "source_fidelity.json"),
    JSON.stringify(passedEval),
    "utf8"
  );
}

function metric(
  result: Awaited<ReturnType<typeof reconcileRun>>,
  metricClass:
    | "trace-to-event-consistency-rate"
    | "missing-input-rate"
    | "schema-validation-failure-rate"
) {
  return result.integrityMetrics.find(
    (metricRecord) => metricRecord.class === metricClass
  );
}
