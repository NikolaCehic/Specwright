import { describe, expect, test } from "bun:test";
import { executeCli, type CliRuntime } from "./index";

describe("specwright cli adapter", () => {
  test("run calls runtime.startRun and prints run id and status", async () => {
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
      runtime
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
        }
      }
    ]);
    expect(result.stdout).toContain("Run started");
    expect(result.stdout).toContain("Run: run-1");
    expect(result.stdout).toContain("Status: running");
  });

  test("run accepts a harness id or path", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async startRun(input) {
        calls.push(input);

        return fakeHandle({
          runId: "run-harness"
        });
      }
    });

    await executeCli(
      [
        "run",
        "--cwd=/workspace",
        "--task=Use harness",
        "--harness",
        "/harnesses/custom"
      ],
      runtime
    );

    expect(calls).toEqual([
      expect.objectContaining({
        harnessId: "/harnesses/custom"
      })
    ]);
  });

  test("status calls runtime.getRun", async () => {
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
      ["status", "run-2", "--root", "/runs-root"],
      runtime
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["run-2", { rootDir: "/runs-root" }]]);
    expect(result.stdout).toContain("Status: paused");
    expect(result.stdout).toContain("Phase: planning");
  });

  test("events calls runtime.getEvents", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async getEvents(runId, options) {
        calls.push([runId, options]);

        return [
          fakeEvent({
            runId,
            id: "event-1",
            sequence: 0,
            type: "run.started"
          }),
          fakeEvent({
            runId,
            id: "event-2",
            sequence: 1,
            type: "phase.entered"
          })
        ];
      }
    });

    const result = await executeCli(["events", "run-3"], runtime);

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["run-3", {}]]);
    expect(result.stdout).toContain("Events: 2");
    expect(result.stdout).toContain("0 run.started event-1");
    expect(result.stdout).toContain("1 phase.entered event-2");
  });

  test("replay calls runtime.replay", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async replay(runId, options) {
        calls.push([runId, options]);

        return {
          state: fakeState({
            runId,
            status: "running",
            phase: "evidence",
            lastEventId: "event-2"
          }),
          events: [
            fakeEvent({
              runId,
              id: "event-1",
              sequence: 0
            }),
            fakeEvent({
              runId,
              id: "event-2",
              sequence: 1
            })
          ]
        };
      }
    });

    const result = await executeCli(
      ["replay", "run-4", "--root=/runs-root"],
      runtime
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["run-4", { rootDir: "/runs-root" }]]);
    expect(result.stdout).toContain("Events replayed: 2");
    expect(result.stdout).toContain("Last event: event-2");
  });

  test("report calls the runtime report API and prints the runtime output", async () => {
    const calls: unknown[] = [];
    const runtime = fakeRuntime({
      async writeRunReport(runId, options) {
        calls.push([runId, options]);

        return {
          runId,
          summaryPath: "/runs/run-5/summary.md",
          markdown: "# Run Summary\n\n- Status: running\n",
          missingInputs: []
        };
      }
    });

    const result = await executeCli(["report", "run-5"], runtime);

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([["run-5", {}]]);
    expect(result.stdout).toContain("Summary: /runs/run-5/summary.md");
    expect(result.stdout).toContain("# Run Summary");
  });

  test("json output is available for simple scripting", async () => {
    const runtime = fakeRuntime({
      async getRun(runId) {
        return fakeState({
          runId
        });
      }
    });

    const result = await executeCli(["status", "run-json", "--json"], runtime);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      runId: "run-json",
      status: "running"
    });
  });

  test("invalid command exits with a useful message", async () => {
    const result = await executeCli(["wat"], fakeRuntime());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stderr).toContain("specwright run");
  });
});

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
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    lastEventId: overrides.lastEventId ?? "event-1"
  };
}

function fakeEvent(
  overrides: {
    runId?: string;
    id?: string;
    type?: string;
    sequence?: number;
  } = {}
): Awaited<ReturnType<CliRuntime["getEvents"]>>[number] {
  return {
    id: overrides.id ?? "event-1",
    runId: overrides.runId ?? "run-test",
    type: overrides.type ?? "run.started",
    timestamp: "2026-05-29T00:00:00.000Z",
    sequence: overrides.sequence ?? 0,
    traceId: "trace-1",
    payload: {}
  };
}
