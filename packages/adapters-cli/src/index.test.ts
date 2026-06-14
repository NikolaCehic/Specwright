import { describe, expect, test } from "bun:test";
import {
  OUTCOMES,
  executeCli,
  outputSchemas,
  type CliRuntime
} from "./index";

const authenticatedContext = {
  principal: {
    id: "operator-1",
    source: "local" as const,
    assuranceLevel: "medium" as const,
    roles: ["runner", "redaction:read-restricted"]
  },
  tenant: {
    id: "tenant-a",
    allowedRoots: ["/workspace", "/runs-root"]
  },
  ci: false
};

const cliSurfaceBaseline = [
  { command: "run", runtimeOperation: "startRun", mutates: true },
  { command: "status", runtimeOperation: "getRun", mutates: false },
  { command: "events", runtimeOperation: "getEvents", mutates: false },
  { command: "replay", runtimeOperation: "replay", mutates: false },
  { command: "report", runtimeOperation: "writeRunReport", mutates: true },
  { command: "approve", runtimeOperation: "recordApproval", mutates: true },
  { command: "reject", runtimeOperation: "recordApproval", mutates: true },
  { command: "answer", runtimeOperation: "recordEvidence", mutates: true }
] as const;

describe("specwright cli adapter", () => {
  test("AUD-012A CLI command surface remains a narrow RuntimeApi client", async () => {
    const help = await executeCli(["help"], fakeRuntime());
    const commands = help.stdout
      .split("\n")
      .filter((line) => line.startsWith("  specwright "))
      .map((line) => line.trim().split(/\s+/)[1]);

    expect(help.exitCode).toBe(0);
    expect(commands).toEqual(cliSurfaceBaseline.map((row) => row.command));
    expect(
      cliSurfaceBaseline.filter((row) => row.mutates).map((row) => row.command)
    ).toEqual(["run", "report", "approve", "reject", "answer"]);
    expect(new Set(cliSurfaceBaseline.map((row) => row.runtimeOperation))).toEqual(
      new Set([
        "startRun",
        "getRun",
        "getEvents",
        "replay",
        "writeRunReport",
        "recordApproval",
        "recordEvidence"
      ])
    );
  });

  test("run calls runtime.startRun with resolved actor context", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async startRun(input) {
        calls.push(input);

        return fakeHandle({
          runId: "run-1",
          status: "running",
          phase: "intake"
        });
      }
    });

    const result = await executeCli(
      ["run", "--cwd", "/workspace", "--task", "Create contract"],
      runtime,
      { context: authenticatedContext }
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        task: "Create contract",
        cwd: "/workspace",
        harnessId: "default",
        host: {
          kind: "cli",
          version: "0.0.0"
        },
        metadata: {
          cli: {
            actor: authenticatedContext.principal,
            tenant: {
              id: "tenant-a"
            }
          }
        }
      }
    ]);
    expect(result.stdout).toContain("Run started");
    expect(result.stdout).toContain("Run: run-1");
    expect(result.stdout).toContain("Status: running");
    expect(result.telemetry).toMatchObject({
      command: "run",
      outcome: "ok",
      exitCode: 0,
      principal: {
        id: "operator-1"
      },
      tenant: "tenant-a"
    });
  });

  test("unidentified privileged command fails auth before runtime mutation", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async startRun(input) {
        calls.push(input);
        return fakeHandle();
      }
    });

    const result = await executeCli(
      ["run", "--cwd", "/workspace", "--task", "Create contract", "--json"],
      runtime,
      {
        context: {
          principal: {
            id: "anonymous",
            source: "anonymous",
            assuranceLevel: "anonymous",
            roles: []
          },
          tenant: {
            id: "tenant-a",
            allowedRoots: ["/workspace"]
          },
          ci: true
        }
      }
    );

    expect(result.exitCode).toBe(11);
    expect(calls).toEqual([]);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      apiVersion: 1,
      errorClass: "auth",
      code: 11,
      retryable: false
    });
  });

  test("status calls runtime.getRun and envelopes json", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async getRun(runId, options) {
        calls.push([runId, options]);

        return fakeState({
          runId,
          status: "paused",
          phase: "planning"
        });
      }
    });

    const result = await executeCli(
      ["status", "run-2", "--root", "/runs-root", "--json"],
      runtime,
      { context: authenticatedContext }
    );

    const envelope = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["run-2", { rootDir: "/runs-root" }]]);
    expect(envelope).toMatchObject({
      apiVersion: 1,
      command: "status",
      outcome: "ok",
      runId: "run-2",
      data: {
        runId: "run-2",
        status: "paused",
        phase: "planning"
      }
    });
    outputSchemas.status.parse(envelope);
  });

  test("blocked status returns the blocked outcome and exit code", async () => {
    const runtime = fakeRuntime({
      async getRun(runId) {
        return fakeState({
          runId,
          status: "blocked",
          pendingApprovals: [
            {
              approvalId: "approval-1",
              reason: "policy requires approval"
            }
          ]
        });
      }
    });

    const result = await executeCli(["status", "run-blocked", "--json"], runtime);
    const record = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("");
    expect(record).toMatchObject({
      errorClass: "blocked",
      code: 5,
      runId: "run-blocked"
    });
  });

  test("unknown harness is rejected before runtime start", async () => {
    const calls: unknown[] = [];
    const result = await executeCli(
      [
        "run",
        "--cwd",
        "/workspace",
        "--task",
        "Create contract",
        "--harness",
        "unknown",
        "--json"
      ],
      fakeRuntime({
        async startRun(input) {
          calls.push(input);
          return fakeHandle();
        }
      }),
      { context: authenticatedContext }
    );

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(calls).toEqual([]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      errorClass: "input_validation",
      code: 3,
      message: "Unknown harness: unknown"
    });
  });

  test("events are bounded, redacted, and marked when truncated", async () => {
    const runtime = fakeRuntime({
      async getEvents(runId) {
        return [
          fakeEvent({
            runId,
            id: "event-1",
            sequence: 0,
            payload: {
              budgets: {},
              harness: {
                id: "default",
                specHash: "sha256:harness-fixture",
                version: "1.0.0"
              },
              initialPhase: "intake",
              input: {
                task: "token=abc123",
                harnessId: "default",
                host: {
                  kind: "cli"
                }
              }
            }
          }),
          fakeEvent({
            runId,
            id: "event-2",
            sequence: 1
          })
        ];
      }
    });

    const result = await executeCli(
      ["events", "run-3", "--limit", "1", "--json"],
      runtime,
      { context: authenticatedContext }
    );
    const envelope = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(envelope.data).toHaveLength(1);
    expect(envelope.diagnostics[0]).toMatchObject({
      code: "output_truncated",
      truncated: true,
      shown: 1,
      total: 2
    });
    expect(JSON.stringify(envelope)).toContain("token=[redacted]");
  });

  test("report requires an authenticated actor and sanitizes human output", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async writeRunReport(runId, options) {
        calls.push([runId, options]);

        return {
          runId,
          summaryPath: "/runs/run-5/summary.md",
          markdown: "# Run Summary\n\n- Status: running\n- secret=raw-value\u001b[31m",
          missingInputs: []
        };
      }
    });

    const result = await executeCli(["report", "run-5"], runtime, {
      context: authenticatedContext
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["run-5", {}]]);
    expect(result.stdout).toContain("Summary: /runs/run-5/summary.md");
    expect(result.stdout).toContain("secret=[redacted]");
    expect(result.stdout).not.toContain("\u001b");
  });

  test("usage and input validation failures are classified", async () => {
    const usage = await executeCli(["wat", "--json"], fakeRuntime());
    const input = await executeCli(
      ["events", "run-1", "--limit", "0", "--json"],
      fakeRuntime()
    );

    expect(usage.exitCode).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({
      errorClass: "usage_error",
      code: 2
    });
    expect(input.exitCode).toBe(3);
    expect(JSON.parse(input.stderr)).toMatchObject({
      errorClass: "input_validation",
      code: 3
    });
  });

  test("runtime not found and unknown failures are classified", async () => {
    const notFound = await executeCli(
      ["status", "missing", "--json"],
      fakeRuntime({
        async getRun() {
          throw new Error("run not found");
        }
      })
    );
    const runtimeError = await executeCli(
      ["status", "oops", "--json"],
      fakeRuntime({
        async getRun() {
          throw new Error("store exploded");
        }
      })
    );

    expect(notFound.exitCode).toBe(7);
    expect(JSON.parse(notFound.stderr)).toMatchObject({
      errorClass: "not_found",
      code: 7
    });
    expect(runtimeError.exitCode).toBe(8);
    expect(JSON.parse(runtimeError.stderr)).toMatchObject({
      errorClass: "runtime_error",
      code: 8
    });
  });

  test("runtime calls are deadline bounded and timeout telemetry is emitted", async () => {
    const telemetry: CliExecution["telemetry"][] = [];
    const result = await executeCli(
      ["status", "slow", "--json"],
      fakeRuntime({
        async getRun() {
          return await new Promise(() => {
            // Intentionally never resolves.
          });
        }
      }),
      {
        defaultDeadlineMs: 1,
        now: fixedClock([0, 10]),
        telemetrySink(record) {
          telemetry.push(record);
        }
      }
    );

    expect(result.exitCode).toBe(9);
    expect(JSON.parse(result.stderr)).toMatchObject({
      errorClass: "timeout",
      code: 9,
      retryable: true
    });
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      command: "status",
      outcome: "timeout",
      exitCode: 9,
      durationMs: 10
    });
  });

  test("approve and reject map to runtime approval decisions", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async recordApproval(runId, decision, options) {
        calls.push([runId, decision, options]);

        return {
          decision,
          event: {
            ...fakeEvent({
              runId,
              id: `event-${decision.decision}`,
              sequence: calls.length
            }),
            type: "decision.recorded",
            payload: {
              approvalId: decision.approvalId,
              decision
            }
          },
          state: fakeState({
            runId,
            pendingApprovals: []
          })
        };
      }
    });
    const approve = await executeCli(
      [
        "approve",
        "run-approval",
        "--approval",
        "approval-1",
        "--decision-hash",
        "sha256:approval",
        "--message",
        "Approved for intake.",
        "--root",
        "/runs-root"
      ],
      runtime,
      { context: authenticatedContext }
    );
    const reject = await executeCli(
      [
        "reject",
        "run-approval",
        "--approval",
        "approval-2",
        "--decision-hash",
        "sha256:approval",
        "--json"
      ],
      runtime,
      { context: authenticatedContext }
    );
    const rejectEnvelope = JSON.parse(reject.stdout);

    expect(approve.exitCode).toBe(0);
    expect(approve.stdout).toContain("Approval recorded");
    expect(approve.stdout).toContain("Approval: approval-1");
    expect(approve.stdout).toContain("Decision: approved");
    expect(reject.exitCode).toBe(0);
    expect(reject.stderr).toBe("");
    expect(rejectEnvelope).toMatchObject({
      command: "reject",
      outcome: "ok",
      runId: "run-approval",
      data: {
        decision: {
          approvalId: "approval-2",
          decision: "rejected"
        },
        state: {
          pendingApprovals: []
        }
      }
    });
    outputSchemas.reject.parse(rejectEnvelope);
    expect(calls).toEqual([
      [
        "run-approval",
        {
          approvalId: "approval-1",
          decision: "approved",
          humanMessage: "Approved for intake."
        },
        {
          rootDir: "/runs-root"
        }
      ],
      [
        "run-approval",
        {
          approvalId: "approval-2",
          decision: "rejected"
        },
        {}
      ]
    ]);
  });

  test("malformed approval decision hashes fail before runtime mutation", async () => {
    const calls: unknown[] = [];
    const malformedHash = await executeCli(
      [
        "approve",
        "run-approval",
        "--approval",
        "approval-1",
        "--decision-hash",
        "bad",
        "--json"
      ],
      fakeRuntime({
        async recordApproval(runId, decision, options) {
          calls.push([runId, decision, options]);

          return {
            decision,
            event: fakeEvent({ runId }),
            state: fakeState({ runId })
          };
        }
      }),
      { context: authenticatedContext }
    );
    const malformedApprovalId = await executeCli(
      [
        "approve",
        "run-approval",
        "--approval",
        "   ",
        "--decision-hash",
        "sha256:approval",
        "--json"
      ],
      fakeRuntime({
        async recordApproval(runId, decision, options) {
          calls.push([runId, decision, options]);

          return {
            decision,
            event: fakeEvent({ runId }),
            state: fakeState({ runId })
          };
        }
      }),
      { context: authenticatedContext }
    );

    expect(malformedHash.exitCode).toBe(3);
    expect(malformedHash.stdout).toBe("");
    expect(JSON.parse(malformedHash.stderr)).toMatchObject({
      errorClass: "input_validation",
      code: 3,
      runId: "run-approval"
    });
    expect(malformedApprovalId.exitCode).toBe(3);
    expect(malformedApprovalId.stdout).toBe("");
    expect(JSON.parse(malformedApprovalId.stderr)).toMatchObject({
      errorClass: "input_validation",
      code: 3,
      runId: "run-approval"
    });
    expect(calls).toEqual([]);
  });

  test("missing or resolved approvals remain integrity failures at the CLI boundary", async () => {
    const result = await executeCli(
      [
        "reject",
        "run-approval",
        "--approval",
        "approval-1",
        "--decision-hash",
        "sha256:approval",
        "--json"
      ],
      fakeRuntime({
        async recordApproval() {
          throw new Error(
            "Approval approval-1 is not currently pending for run run-approval"
          );
        }
      }),
      { context: authenticatedContext }
    );

    expect(result.exitCode).toBe(10);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      errorClass: "integrity",
      code: 10,
      runId: "run-approval",
      operatorAction:
        "Resolve a currently pending approval through the approval-decision API; stale, missing, or already-resolved approvals are refused."
    });
  });

  test("answer records human decision evidence without source_fact", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async recordEvidence(runId, record, options) {
        calls.push([runId, record, options]);
        return record;
      }
    });

    const result = await executeCli(
      [
        "answer",
        "run-question",
        "--question",
        "question-1",
        "--answer",
        "Use the repo README",
        "--json"
      ],
      runtime,
      { context: authenticatedContext }
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      "run-question",
      {
        class: "human_decision",
        authority: "user",
        claim: "Use the repo README"
      },
      {}
    ]);
    expect(JSON.stringify(calls[0])).not.toContain("source_fact");
  });

  test("all outcome codes are unique and no failure maps to exit 1", () => {
    const codes = Object.values(OUTCOMES).map((outcome) => outcome.exitCode);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(1);
    expect(OUTCOMES.denied.retryable).toBe(false);
    expect(OUTCOMES.gate_failure.retryable).toBe(false);
  });
});

type CliExecution = Awaited<ReturnType<typeof executeCli>>;

function fakeRuntime(overrides: Partial<CliRuntime> = {}): CliRuntime {
  return {
    async startRun() {
      return fakeHandle();
    },
    async getRun(runId) {
      return fakeState({
        runId
      });
    },
    async getEvents(runId) {
      return [
        fakeEvent({
          runId
        })
      ];
    },
    async replay(runId) {
      return {
        state: fakeState({
          runId
        }),
        events: [
          fakeEvent({
            runId
          })
        ]
      };
    },
    async writeRunReport(runId) {
      return {
        runId,
        summaryPath: `/tmp/${runId}/summary.md`,
        markdown: "# Run Summary\n",
        missingInputs: []
      };
    },
    async recordEvidence(_runId, record) {
      return record;
    },
    async recordApproval(runId, decision) {
      return {
        decision,
        event: {
          ...fakeEvent({
            runId
          }),
          type: "decision.recorded",
          payload: {
            approvalId: decision.approvalId,
            decision
          }
        },
        state: fakeState({
          runId,
          pendingApprovals: []
        })
      };
    },
    ...overrides
  };
}

function fakeHandle(
  overrides: {
    runId?: string;
    status?: "running" | "paused" | "blocked" | "completed" | "failed";
    phase?: string;
  } = {}
): Awaited<ReturnType<CliRuntime["startRun"]>> {
  const runId = overrides.runId ?? "run-test";

  return {
    runId,
    state: fakeState({
      runId,
      status: overrides.status,
      phase: overrides.phase
    }),
    harness: {
      id: "specwright.default",
      version: "0.1.0",
      schemaVersion: "specwright.harness.v0",
      specHash: "sha256:harness",
      loadedAt: "2026-05-29T00:00:00.000Z",
      phases: [],
      gates: [],
      policies: [],
      tools: [],
      artifacts: [],
      evals: [],
      roles: [],
      prompts: []
    },
    events: [],
    paths: {
      rootDir: "/workspace",
      runsDir: "/workspace/.archetype/runs",
      runDir: `/workspace/.archetype/runs/${runId}`,
      eventsPath: `/workspace/.archetype/runs/${runId}/events.jsonl`,
      statePath: `/workspace/.archetype/runs/${runId}/state.json`,
      tracePath: `/workspace/.archetype/runs/${runId}/trace.json`,
      decisionsPath: `/workspace/.archetype/runs/${runId}/decisions.jsonl`,
      artifactsDir: `/workspace/.archetype/runs/${runId}/artifacts`,
      evidenceDir: `/workspace/.archetype/runs/${runId}/evidence`,
      cacheDir: `/workspace/.archetype/runs/${runId}/cache`,
      evalsDir: `/workspace/.archetype/runs/${runId}/evals`,
      summaryPath: `/workspace/.archetype/runs/${runId}/summary.md`
    }
  };
}

function fakeState(
  overrides: {
    runId?: string;
    status?: "running" | "paused" | "blocked" | "completed" | "failed";
    phase?: string;
    lastEventId?: string;
    pendingApprovals?: Awaited<ReturnType<CliRuntime["getRun"]>>["pendingApprovals"];
    pendingQuestions?: Awaited<ReturnType<CliRuntime["getRun"]>>["pendingQuestions"];
  } = {}
): Awaited<ReturnType<CliRuntime["getRun"]>> {
  return {
    runId: overrides.runId ?? "run-test",
    status: overrides.status ?? "running",
    phase: overrides.phase ?? "intake",
    harness: {
      id: "specwright.default",
      version: "0.1.0",
      specHash: "sha256:harness"
    },
    budgets: {},
    pendingApprovals: overrides.pendingApprovals ?? [],
    pendingQuestions: overrides.pendingQuestions ?? [],
    artifacts: [],
    lastEventId: overrides.lastEventId ?? "event-1"
  };
}

function fakeEvent(
  overrides: {
    runId?: string;
    id?: string;
    type?: "run.started";
    sequence?: number;
    payload?: Record<string, unknown>;
  } = {}
): Awaited<ReturnType<CliRuntime["getEvents"]>>[number] {
  return {
    id: overrides.id ?? "event-1",
    runId: overrides.runId ?? "run-test",
    type: overrides.type ?? "run.started",
    timestamp: "2026-05-29T00:00:00.000Z",
    sequence: overrides.sequence ?? 0,
    traceId: "trace-1",
    payload:
      overrides.payload ??
      {
        budgets: {},
        harness: {
          id: "default",
          specHash: "sha256:harness-fixture",
          version: "1.0.0"
        },
        initialPhase: "intake",
        input: {
          harnessId: "default",
          host: {
            kind: "cli"
          },
          task: "Generate the authoritative contract registry."
        }
      }
  };
}

function fixedClock(values: number[]) {
  let index = 0;

  return () => {
    const value = values[index] ?? values.at(-1) ?? 0;
    index += 1;
    return value;
  };
}
