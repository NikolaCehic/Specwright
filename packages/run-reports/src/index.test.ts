import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendArtifact } from "@specwright/artifact-store";
import { appendEvidence } from "@specwright/evidence-store";
import {
  appendEvent,
  createRun,
  getRunStorePaths,
  type HarnessSnapshot
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
        locator: "scripts"
      }
    ],
    confidence: "high",
    authority: "repo",
    createdBy: {
      phase: "evidence",
      actionId: "read-package-json",
      toolCallId: "tool-call-1"
    }
  };
}
