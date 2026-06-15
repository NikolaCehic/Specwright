import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listArtifacts, readArtifact } from "@specwright/artifact-store";
import { appendEvidence, listEvidence } from "@specwright/evidence-store";
import type { EvaluateGateRequest, GateEvaluationResult } from "@specwright/gate-engine";
import type { RunEvalRequest } from "@specwright/eval-runner";
import type {
  EvidenceRecord,
  EvalVerdict,
  RunInput,
  RuntimeEvent,
  ToolCallRequest,
  ToolCallResult
} from "@specwright/schemas";
import { appendEvent, getRunStorePaths } from "@specwright/run-store";
import { readRunSummary } from "@specwright/run-reports";
import { readTrace } from "@specwright/trace-recorder";
import { createRuntime, type ToolBrokerLike } from "./index";

const runInput = {
  task: "Create a minimal runtime facade",
  harnessId: "specwright.test",
  host: {
    kind: "cli"
  }
} satisfies RunInput;

let rootDir: string;
let harnessDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-runtime-"));
  harnessDir = await writeHarnessPackage("harness", validHarnessFiles());
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("runtime facade", () => {
  test("startRun creates a run package and records initial runtime events", async () => {
    const runtime = createRuntime({
      rootDir,
      harnessPackages: {
        "specwright.test": harnessDir
      },
      now: () => "2026-05-29T00:00:00.000Z"
    });

    const handle = await runtime.startRun(runInput);
    const paths = getRunStorePaths(rootDir, handle.runId);
    const events = await readJsonLines(paths.eventsPath);

    expect(Object.isFrozen(handle.harness)).toBe(true);
    expect(handle.state.phase).toBe("intake");
    expect(handle.events.map((event) => event.type)).toEqual([
      "run.started",
      "harness.loaded",
      "phase.entered",
      "evidence.recorded",
      "artifact.recorded"
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "harness.loaded",
      "phase.entered",
      "evidence.recorded",
      "artifact.recorded"
    ]);
    expect(events[1]?.payload).toMatchObject({
      harness: {
        id: "specwright.test",
        version: "0.1.0"
      }
    });
    expect(
      (events[1]?.payload as { harness?: { phases?: Array<{ id: string }> } })
        .harness?.phases?.[0]
    ).toMatchObject({
      id: "intake"
    });
    expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toEqual(
      handle.state
    );
    expect(handle.state.artifacts).toEqual([
      expect.objectContaining({
        artifactId: "run-input",
        artifactType: "run-input",
        uri: "artifacts/run-input.json"
      })
    ]);
    expect(await readArtifact({ rootDir, runId: handle.runId, artifactId: "run-input" }))
      .toMatchObject({
        artifactId: "run-input",
        artifactType: "run-input",
        content: runInput,
        evidenceRefs: ["evidence:user:task"]
      });
    expect(await listEvidence({ rootDir, runId: handle.runId })).toEqual([
      expect.objectContaining({
        id: "evidence:user:task",
        class: "source_fact",
        authority: "user"
      })
    ]);
    const startupSummary = await readRunSummary({ rootDir, runId: handle.runId });
    expect(startupSummary).toContain("# Run Summary");
    expect(startupSummary).toContain("- Tenant: `local`");
    expect((await readTrace({ rootDir, runId: handle.runId })).spans).toEqual([
      expect.objectContaining({
        kind: "phase",
        name: "phase.intake"
      })
    ]);
  });

  test("startRun resolves the repository default harness and records run input stores", async () => {
    const runtime = createRuntime({
      rootDir,
      now: () => "2026-05-29T00:00:00.000Z"
    });

    const handle = await runtime.startRun({
      task: "Use the repository default harness",
      harnessId: "default",
      host: {
        kind: "cli"
      }
    });

    expect(handle.harness.id).toBe("specwright.default");
    expect(handle.state.phase).toBe("intake");
    expect(await listArtifacts({ rootDir, runId: handle.runId }))
      .toContainEqual(
        expect.objectContaining({
          artifactId: "run-input",
          artifactType: "run-input"
        })
      );
    expect(await listEvidence({ rootDir, runId: handle.runId }))
      .toContainEqual(
        expect.objectContaining({
          id: "evidence:user:task",
          claim: expect.stringContaining("Use the repository default harness")
        })
      );
  });

  test("getRun returns projected state", async () => {
    const runtime = runtimeForTests();
    const handle = await runtime.startRun(runInput);

    await expect(runtime.getRun(handle.runId)).resolves.toMatchObject({
      runId: handle.runId,
      status: "running",
      phase: "intake",
      harness: {
        id: "specwright.test",
        version: "0.1.0"
      }
    });
  });

  test("runtime report facade supplies and overrides tenant scope", async () => {
    const runtime = runtimeForTests({
      tenantScope: "tenant-runtime"
    });
    const handle = await runtime.startRun(runInput);

    const defaultReport = await runtime.generateReport(handle.runId);
    expect(defaultReport.tenantScope).toBe("tenant-runtime");
    expect(defaultReport.markdown).toContain("- Tenant: `tenant-runtime`");

    const overriddenReport = await runtime.writeRunReport(handle.runId, {
      tenantScope: "tenant-report"
    });
    expect(overriddenReport.tenantScope).toBe("tenant-report");
    expect(overriddenReport.markdown).toContain("- Tenant: `tenant-report`");
  });

  test("getRun resolves runs started from input cwd on the same facade", async () => {
    const runtime = createRuntime({
      harnessPackages: {
        "specwright.test": harnessDir
      },
      now: () => "2026-05-29T00:00:00.000Z"
    });
    const handle = await runtime.startRun({
      ...runInput,
      cwd: rootDir
    });

    await expect(runtime.getRun(handle.runId)).resolves.toMatchObject({
      runId: handle.runId,
      phase: "intake"
    });
  });

  test("replay reconstructs state from the event log", async () => {
    const runtime = runtimeForTests();
    const handle = await runtime.startRun(runInput);
    const paths = getRunStorePaths(rootDir, handle.runId);

    await writeFile(paths.statePath, "{\"status\":\"stale\"}\n");
    await writeFile(paths.summaryPath, "stale summary\n");

    const replayed = await runtime.replay(handle.runId);

    expect(replayed.state.phase).toBe("intake");
    expect(replayed.state.lastEventId).toBe(handle.state.lastEventId);
    expect(replayed.events.map((event) => event.type)).toEqual([
      "run.started",
      "harness.loaded",
      "phase.entered",
      "evidence.recorded",
      "artifact.recorded"
    ]);
  });

  test("callTool delegates through the broker and records result events", async () => {
    let delegatedRequest: ToolCallRequest | undefined;
    let delegatedContextRunId: string | undefined;
    const broker: ToolBrokerLike = {
      async callTool(request, context): Promise<ToolCallResult> {
        delegatedRequest = request as ToolCallRequest;
        delegatedContextRunId = context?.runId;

        return {
          toolCallId: "tool-call-1",
          status: "success",
          output: {
            ok: true
          },
          provenance: {
            toolId: "fs.read",
            toolVersion: "0.1.0",
            adapterVersion: "0.1.0",
            argsHash: "sha256:args",
            resultHash: "sha256:result",
            decisionHash: "sha256:decision",
            cacheStatus: "bypass",
            traceId: context?.traceId ?? "trace-tool"
          }
        };
      }
    };
    const runtime = runtimeForTests({ toolBroker: broker });
    const handle = await runtime.startRun(runInput);
    const request = toolRequest();

    const result = await runtime.callTool(handle.runId, request);
    const events = await runtime.getEvents(handle.runId);

    expect(result.status).toBe("success");
    expect(delegatedRequest).toEqual(request);
    expect(delegatedContextRunId).toBe(handle.runId);
    expect(events.map((event) => event.type).slice(-2)).toEqual([
      "tool.requested",
      "tool.completed"
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      result: {
        toolCallId: "tool-call-1",
        status: "success"
      }
    });
    expect((await readTrace({ rootDir, runId: handle.runId })).spans)
      .toContainEqual(
        expect.objectContaining({
          kind: "tool",
          name: "tool.fs.read",
          status: "success",
          eventIds: [events.at(-2)?.id, events.at(-1)?.id]
        })
      );
  });

  test("runEval delegates to EvalRunner and records eval.completed", async () => {
    let delegatedRequest: RunEvalRequest | undefined;
    const verdict: EvalVerdict = {
      evalId: "eval.required",
      targetRef: "artifact:plan",
      status: "pass",
      severity: "blocking",
      findings: [],
      evidenceRefs: ["evidence:1"],
      producedBy: {
        kind: "deterministic",
        ref: "test-eval-runner"
      }
    };
    const runtime = runtimeForTests({
      evalRunner(request) {
        delegatedRequest = request;
        return verdict;
      }
    });
    const handle = await runtime.startRun(runInput);

    const result = await runtime.runEval(handle.runId, "eval.required");
    const events = await runtime.getEvents(handle.runId);

    expect(result).toEqual(verdict);
    expect(delegatedRequest?.evalId).toBe("eval.required");
    expect(delegatedRequest?.evalDefinitions).toBeArray();
    expect(events.map((event) => event.type)).toContain("eval.completed");
    expect(events.find((event) => event.type === "eval.completed")?.payload)
      .toMatchObject({
      evalId: "eval.required",
      verdict: {
        status: "pass"
      }
    });
    expect(events.at(-1)?.type).toBe("artifact.recorded");
    expect(await listArtifacts({ rootDir, runId: handle.runId }))
      .toContainEqual(
        expect.objectContaining({
          artifactType: "eval-report",
          evidenceRefs: ["evidence:1"]
        })
      );
    expect((await readTrace({ rootDir, runId: handle.runId })).spans)
      .toContainEqual(
        expect.objectContaining({
          kind: "eval",
          name: "eval.eval.required",
          status: "pass"
        })
      );
  });

  test("evaluateGate delegates to GateEngine and applies transition lifecycle events", async () => {
    let delegatedRequest: EvaluateGateRequest | undefined;
    const gateResult = gateResultForInstruction({
      kind: "transition_phase",
      gateId: "intake.exit",
      targetPhase: "evidence"
    });
    const runtime = runtimeForTests({
      gateEngine(request) {
        delegatedRequest = request;
        return gateResult;
      }
    });
    const handle = await runtime.startRun(runInput);

    const result = await runtime.evaluateGate(handle.runId, "intake.exit");
    const events = await runtime.getEvents(handle.runId);
    const state = await runtime.getRun(handle.runId);
    const replayed = await runtime.replay(handle.runId);
    const evaluated = events.at(-2);
    const transitioned = events.at(-1);

    expect(result).toEqual(gateResult);
    expect(delegatedRequest?.gateId).toBe("intake.exit");
    expect(delegatedRequest?.phase).toBe("intake");
    expect(delegatedRequest?.gateDefinitions).toBeArray();
    expect(delegatedRequest?.input).toMatchObject({
      runId: handle.runId,
      phase: "intake"
    });
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      "gate.evaluated",
      "phase.transitioned"
    ]);
    expect(evaluated?.payload).toMatchObject({
      verdict: {
        gateId: "intake.exit",
        status: "pass"
      },
      instruction: {
        kind: "transition_phase",
        targetPhase: "evidence"
      }
    });
    expect(transitioned?.payload).toMatchObject({
      phase: "evidence",
      fromPhase: "intake",
      toPhase: "evidence",
      reason: "gate:intake.exit"
    });
    expect(transitioned?.causationId).toBe(evaluated?.id);
    expect(state.phase).toBe("evidence");
    expect(replayed.state.phase).toBe("evidence");
    expect((await readTrace({ rootDir, runId: handle.runId })).spans)
      .toContainEqual(
        expect.objectContaining({
          kind: "gate",
          name: "gate.intake.exit",
          status: "pass",
          eventIds: [evaluated?.id, transitioned?.id],
          metadata: expect.objectContaining({
            lifecycleApplication: "applied",
            lifecycleEventType: "phase.transitioned"
          })
        })
      );
  });

  test("evaluateGate applies fail_run lifecycle events", async () => {
    const gateResult = gateResultForInstruction(
      {
        kind: "fail_run",
        gateId: "intake.exit",
        reason: "Gate failed"
      },
      {
        status: "fail",
        reasons: ["Gate failed"]
      }
    );
    const runtime = runtimeForTests({
      gateEngine() {
        return gateResult;
      }
    });
    const handle = await runtime.startRun(runInput);

    const result = await runtime.evaluateGate(handle.runId, "intake.exit");
    const events = await runtime.getEvents(handle.runId);
    const state = await runtime.getRun(handle.runId);
    const replayed = await runtime.replay(handle.runId);
    const evaluated = events.at(-2);
    const failed = events.at(-1);

    expect(result).toEqual(gateResult);
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      "gate.evaluated",
      "run.failed"
    ]);
    expect(failed?.payload).toMatchObject({
      reason: "Gate failed",
      metadata: {
        gateId: "intake.exit",
        gateCausation: "gate:intake.exit",
        instructionKind: "fail_run"
      }
    });
    expect(failed?.causationId).toBe(evaluated?.id);
    expect(state.status).toBe("failed");
    expect(replayed.state.status).toBe("failed");
    expect((await readTrace({ rootDir, runId: handle.runId })).spans)
      .toContainEqual(
        expect.objectContaining({
          kind: "gate",
          name: "gate.intake.exit",
          status: "fail",
          eventIds: [evaluated?.id, failed?.id],
          metadata: expect.objectContaining({
            lifecycleApplication: "applied",
            lifecycleEventType: "run.failed"
          })
        })
      );
  });

  test("evaluateGate keeps continue as a gate.evaluated no-op", async () => {
    const gateResult = gateResultForInstruction({
      kind: "continue",
      gateId: "intake.exit"
    });
    const runtime = runtimeForTests({
      gateEngine() {
        return gateResult;
      }
    });
    const handle = await runtime.startRun(runInput);

    const result = await runtime.evaluateGate(handle.runId, "intake.exit");
    const events = await runtime.getEvents(handle.runId);
    const state = await runtime.getRun(handle.runId);
    const replayed = await runtime.replay(handle.runId);

    expect(result).toEqual(gateResult);
    expect(events.at(-1)?.type).toBe("gate.evaluated");
    expect(events.filter((event) => event.type === "phase.transitioned"))
      .toHaveLength(0);
    expect(events.filter((event) => event.type === "run.failed"))
      .toHaveLength(0);
    expect(state.phase).toBe("intake");
    expect(replayed.state.phase).toBe("intake");
    expect((await readTrace({ rootDir, runId: handle.runId })).spans)
      .toContainEqual(
        expect.objectContaining({
          kind: "gate",
          name: "gate.intake.exit",
          status: "pass",
          metadata: expect.objectContaining({
            lifecycleApplication: "no_op"
          })
        })
      );
  });

  for (const [kind, instruction] of deferredGateInstructions()) {
    test(`evaluateGate stops for deferred ${kind} lifecycle instructions`, async () => {
      const gateResult = gateResultForInstruction(instruction);
      const runtime = runtimeForTests({
        gateEngine() {
          return gateResult;
        }
      });
      const handle = await runtime.startRun(runInput);

      await expect(runtime.evaluateGate(handle.runId, "intake.exit"))
        .rejects.toThrow(
          `Gate lifecycle instruction ${kind} for gate intake.exit is deferred`
        );

      const events = await runtime.getEvents(handle.runId);

      expect(events.at(-1)?.type).toBe("gate.evaluated");
      expect(events.at(-1)?.payload).toMatchObject({
        instruction: {
          kind
        }
      });
      expect(events.filter((event) => event.type === "phase.transitioned"))
        .toHaveLength(0);
      expect(events.filter((event) => event.type === "run.failed"))
        .toHaveLength(0);
      expect(events.filter((event) => event.type === "human.input_requested"))
        .toHaveLength(0);
      expect(events.filter((event) => event.type === "policy.evaluated"))
        .toHaveLength(0);
      expect((await readTrace({ rootDir, runId: handle.runId })).spans)
        .toContainEqual(
          expect.objectContaining({
            kind: "gate",
            name: "gate.intake.exit",
            metadata: expect.objectContaining({
              lifecycleApplication: "stopped",
              lifecycleError: expect.stringContaining(
                `Gate lifecycle instruction ${kind}`
              )
            })
          })
        );
    });
  }

  test("writeRunReport creates a summary across run package projections", async () => {
    const broker: ToolBrokerLike = {
      async callTool(_request, context): Promise<ToolCallResult> {
        return {
          toolCallId: "tool-call-report",
          status: "success",
          output: {
            ok: true
          },
          provenance: {
            toolId: "fs.read",
            toolVersion: "0.1.0",
            adapterVersion: "0.1.0",
            argsHash: "sha256:args",
            resultHash: "sha256:result",
            decisionHash: "sha256:decision",
            cacheStatus: "bypass",
            traceId: context?.traceId ?? "trace-report"
          }
        };
      }
    };
    const runtime = runtimeForTests({
      toolBroker: broker,
      evalRunner() {
        return {
          evalId: "eval.required",
          targetRef: "artifact:run-input",
          status: "pass",
          severity: "blocking",
          findings: [],
          evidenceRefs: ["evidence:user:task"],
          producedBy: {
            kind: "deterministic",
            ref: "test-eval-runner"
          }
        };
      },
      gateEngine() {
        return {
          verdict: {
            gateId: "intake.exit",
            phase: "intake",
            status: "pass",
            severity: "blocking",
            reasons: ["Gate passed"],
            findings: [],
            evidenceRefs: ["evidence:user:task"],
            obligations: [],
            evaluatedAt: "2026-05-29T00:00:00.000Z",
            evaluator: {
              kind: "deterministic",
              ref: "test-gate-engine"
            }
          },
          instruction: {
            kind: "continue",
            gateId: "intake.exit"
          }
        };
      }
    });
    const handle = await runtime.startRun(runInput);
    const unknown = unknownEvidence();

    await appendEvidence({
      rootDir,
      runId: handle.runId,
      record: unknown
    });
    await appendEvent({
      rootDir,
      runId: handle.runId,
      type: "evidence.recorded",
      payload: {
        evidence: unknown
      },
      timestamp: "2026-05-29T00:00:00.000Z"
    });
    await runtime.callTool(handle.runId, toolRequest());
    await runtime.runEval(handle.runId, "eval.required");
    await runtime.evaluateGate(handle.runId, "intake.exit");

    const report = await runtime.writeRunReport(handle.runId);

    expect(report.markdown).toContain("Task: Create a minimal runtime facade");
    expect(report.markdown).toContain("Harness: `specwright.test@0.1.0`");
    expect(report.markdown).toContain("- Tenant: `local`");
    expect(report.markdown).toContain("intake (phase.entered");
    expect(report.markdown).toContain("fs.read: success");
    expect(report.markdown).toContain("eval.required: pass");
    expect(report.markdown).toContain("intake.exit: pass");
    expect(report.markdown).toContain("run-input (run-input)");
    expect(report.markdown).toContain("eval-report");
    expect(report.markdown).toContain("evidence:user:task");
    expect(report.markdown).toContain("evidence:unknown:report-gap");
    expect(report.markdown).toContain("What Remains Unknown");
    expect(report.markdown).toContain("No browser-rendered state was inspected");
    expect(await readRunSummary({ rootDir, runId: handle.runId })).toBe(
      report.markdown
    );
  });
});

function runtimeForTests(
  overrides: Parameters<typeof createRuntime>[0] = {}
) {
  return createRuntime({
    rootDir,
    harnessPackages: {
      "specwright.test": harnessDir
    },
    now: () => "2026-05-29T00:00:00.000Z",
    ...overrides
  });
}

function gateResultForInstruction(
  instruction: GateEvaluationResult["instruction"],
  verdictOverrides: Partial<GateEvaluationResult["verdict"]> = {}
): GateEvaluationResult {
  return {
    verdict: {
      gateId: instruction.gateId,
      phase: "intake",
      status: "pass",
      severity: "blocking",
      reasons: ["Gate passed"],
      findings: [],
      evidenceRefs: [],
      obligations: [],
      evaluatedAt: "2026-05-29T00:00:00.000Z",
      evaluator: {
        kind: "deterministic",
        ref: "test-gate-engine"
      },
      ...verdictOverrides
    },
    instruction
  };
}

function deferredGateInstructions(): Array<
  [string, GateEvaluationResult["instruction"]]
> {
  return [
    [
      "pause_for_human",
      {
        kind: "pause_for_human",
        gateId: "intake.exit",
        question: {
          id: "human-review-1",
          gateId: "intake.exit",
          phase: "intake",
          question: "Confirm the gate result.",
          requiredFor: "intake.exit"
        }
      }
    ],
    [
      "request_approval",
      {
        kind: "request_approval",
        gateId: "intake.exit",
        approvalRequest: {
          id: "approval-1",
          gateId: "intake.exit",
          phase: "intake",
          reason: "Gate requires approval.",
          requiredFor: "intake.exit"
        }
      }
    ],
    [
      "create_repair_task",
      {
        kind: "create_repair_task",
        gateId: "intake.exit",
        repairTask: {
          id: "repair-1",
          gateId: "intake.exit",
          failedPhase: "intake",
          problem: "Missing required evidence.",
          requiredEvidenceRefs: ["evidence:missing"],
          allowedTools: ["fs.read"],
          blockedTools: [],
          successGate: "intake.exit",
          createdFromFindingIds: ["finding-1"]
        }
      }
    ]
  ];
}

function toolRequest() {
  return {
    toolId: "fs.read",
    args: {
      path: "AGENTS.md"
    },
    reason: "Read project instructions",
    idempotencyKey: "tool-request-1",
    requestedBy: {
      phase: "intake"
    }
  } satisfies ToolCallRequest;
}

function unknownEvidence() {
  return {
    id: "evidence:unknown:report-gap",
    class: "unknown",
    claim: "No browser-rendered state was inspected.",
    sourceRefs: [],
    confidence: "low",
    authority: "generated",
    unknownReason: "No browser-rendered state inspection was recorded.",
    redactionPolicy: "operator",
    createdBy: {
      phase: "verification",
      actionId: "record-unknown"
    }
  } satisfies EvidenceRecord;
}

function validHarnessFiles() {
  return {
    "harness.yaml": `
id: specwright.test
version: 0.1.0
schemaVersion: specwright.harness.v1
phases:
  - id: intake
    gates:
      - intake.exit
    tools:
      - fs.read
    evals:
      - eval.required
    next: evidence
  - id: evidence
gates:
  - intake.exit
tools:
  allow:
    - fs.read
evals:
  - eval.required
`,
    "gates/intake.exit.yaml": `
id: intake.exit
phase: intake
kind: exit
required: true
checks:
  - id: has-task
    type: deterministic
    path: runInput.task
    condition: present
onPass:
  action: transition_phase
  targetPhase: evidence
`,
    "tools/fs.read.yaml": `
id: fs.read
version: 0.1.0
inputSchema:
  type: object
  required:
    - path
outputSchema:
  type: object
`,
    "evals/required.yaml": `
id: eval.required
type: schema
target:
  artifactId: plan
severity: blocking
checks:
  - id: has-title
    type: schema
    requiredFields:
      - title
`
  };
}

async function writeHarnessPackage(
  name: string,
  files: Record<string, string>
) {
  const packageDir = join(rootDir, name);

  for (const [relativePath, contents] of Object.entries(files)) {
    const targetPath = join(packageDir, relativePath);

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents.trimStart());
  }

  return packageDir;
}

async function readJsonLines(path: string): Promise<RuntimeEvent[]> {
  const raw = await readFile(path, "utf8");

  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}
