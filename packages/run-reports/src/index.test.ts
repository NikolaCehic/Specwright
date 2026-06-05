import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendArtifact } from "@specwright/artifact-store";
import { appendEvidence } from "@specwright/evidence-store";
import {
  DEFAULT_REDACTION_PROFILE,
  appendEvent,
  createRun,
  getRunStorePaths,
  type HarnessSnapshot,
  type RedactionProfile
} from "@specwright/run-store";
import type { EvalVerdict, EvidenceRecord, RunInput } from "@specwright/schemas";
import { recordTraceSpan } from "@specwright/trace-recorder";
import {
  generateRunReport,
  readRunSummary,
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
            argsHash:
              "sha256:d8576b4d26ccf208a9372f9df7e7e9d6786fd8a292091fea2bc1e86a6a41b5d8",
            resultHash:
              "sha256:4b01f791f3caecd55bb6f23a443731846f66adef1d7bc0c1c8d817cf32603fbe",
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
          argsHash: "sha256:args",
          resultHash: "sha256:result",
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
