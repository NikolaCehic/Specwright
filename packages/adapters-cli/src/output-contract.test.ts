import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { executeCli, outputSchemas, type CliRuntime } from "./index";

const fixtureDir = fileURLToPath(
  new URL("../fixtures/output-contract", import.meta.url)
);
const fixtureNames = [
  "doctor-ok.json",
  "run-ok.json",
  "status-ok.json",
  "events-ok.json",
  "replay-ok.json",
  "report-ok.json",
  "tool-call-ok.json",
  "eval-run-ok.json",
  "gate-evaluate-ok.json"
] as const;
const authenticatedContext = {
  principal: {
    id: "contract-operator",
    source: "local" as const,
    assuranceLevel: "medium" as const,
    roles: ["runner", "redaction:read-restricted"]
  },
  tenant: {
    id: "contract",
    allowedRoots: ["/workspace"]
  },
  ci: true
};

describe("cli output contract fixtures", () => {
  test("golden envelopes validate against published per-command schemas", async () => {
    for (const fixtureName of fixtureNames) {
      const fixture = await readJson(fixtureName);
      const schema =
        outputSchemas[fixture.command as keyof typeof outputSchemas];

      expect(schema).toBeDefined();
      schema.parse(fixture);
      expect(fixture.apiVersion).toBe(1);
      expect(fixture.outcome).toBe("ok");
      expect(fixture.data).toBeDefined();
    }
  });

  test("live executeCli envelopes validate against schemas and frozen shape signatures", async () => {
    const expected = await readJson("contract-shape.json");
    const classifications = await readJson("migration-classifications.json");

    expect(classifications).toMatchObject({
      apiVersion: 1,
      changes: [
        {
          classification: "additive-compatible"
        },
        {
          classification: "additive-compatible"
        },
        {
          classification: "additive-compatible"
        },
        {
          classification: "additive-compatible"
        },
        {
          classification: "additive-compatible"
        }
      ]
    });

    const live = await liveEnvelopes();
    const actual: Record<string, string> = {};

    for (const [fixtureName, envelope] of Object.entries(live)) {
      const schema =
        outputSchemas[envelope.command as keyof typeof outputSchemas];
      schema.parse(envelope);
      actual[fixtureName] = shapeSignature(envelope);
    }

    expect(actual).toEqual(expected);
  });

  test("trust labels survive serialization under live data", async () => {
    const live = await liveEnvelopes();
    const events = live["events-ok.json"];
    const first = (events.data as Array<{ payload: Record<string, unknown> }>)[0];

    expect(first.payload.harness).toMatchObject({
      id: "default",
      specHash: "sha256:harness-fixture",
      version: "1.0.0"
    });
    expect(first.payload.input).toMatchObject({
      harnessId: "default",
      host: {
        kind: "cli"
      }
    });
  });
});

async function liveEnvelopes(): Promise<Record<string, Record<string, unknown>>> {
  const runtime = contractRuntime();
  const repoRoot = join(fixtureDir, "../../../..");
  const commands: Record<string, string[]> = {
    "doctor-ok.json": ["doctor", "--root", repoRoot, "--json"],
    "run-ok.json": [
      "run",
      "--cwd",
      "/workspace",
      "--task",
      "Generate the authoritative contract registry.",
      "--json"
    ],
    "status-ok.json": ["status", "run-contract", "--json"],
    "events-ok.json": [
      "events",
      "run-contract",
      "--json",
      "--limit",
      "1"
    ],
    "replay-ok.json": [
      "replay",
      "run-contract",
      "--json",
      "--limit",
      "1"
    ],
    "report-ok.json": ["report", "run-contract", "--json"],
    "tool-call-ok.json": [
      "tool",
      "call",
      "run-contract",
      "--tool",
      "fs.read",
      "--args-json",
      "{\"path\":\"AGENTS.md\"}",
      "--reason",
      "Read project instructions",
      "--idempotency-key",
      "tool-request-contract",
      "--phase",
      "intake",
      "--json"
    ],
    "eval-run-ok.json": [
      "eval",
      "run",
      "run-contract",
      "--eval",
      "eval.required",
      "--json"
    ],
    "gate-evaluate-ok.json": [
      "gate",
      "evaluate",
      "run-contract",
      "--gate",
      "intake.exit",
      "--json"
    ]
  };
  const envelopes: Record<string, Record<string, unknown>> = {};

  for (const [fixtureName, argv] of Object.entries(commands)) {
    const result = await executeCli(argv, runtime, {
      context:
        fixtureName === "doctor-ok.json"
          ? {
              ...authenticatedContext,
              tenant: {
                id: "contract",
                allowedRoots: [repoRoot]
              }
            }
          : authenticatedContext,
      invocationId: `contract-${fixtureName}`,
      now: fixedClock([0, 1])
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    envelopes[fixtureName] = JSON.parse(result.stdout);
  }

  return envelopes;
}

async function readJson(name: string) {
  return await Bun.file(join(fixtureDir, name)).json();
}

function shapeSignature(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "array[]";
    }

    return `array[${shapeSignature(value[0])}]`;
  }

  if (value === null) {
    return "null";
  }

  if (typeof value !== "object") {
    return typeof value;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${key}:${shapeSignature(nested)}`);

  return `object{${entries.join(",")}}`;
}

function contractRuntime(): CliRuntime {
  return {
    async startRun() {
      return fakeHandle("run-contract");
    },
    async getRun() {
      return fakeState({
        runId: "run-contract"
      });
    },
    async getEvents() {
      return [fakeEvent("run-contract", 0), fakeEvent("run-contract", 1)];
    },
    async replay() {
      return {
        state: fakeState({ runId: "run-contract" }),
        events: [fakeEvent("run-contract", 0)]
      };
    },
    async writeRunReport() {
      return {
        runId: "run-contract",
        summaryPath: "/workspace/.archetype/runs/run-contract/summary.md",
        markdown: "# Run Summary\n\n- Status: running\n",
        missingInputs: []
      };
    },
    async callTool() {
      return fakeToolCallResult();
    },
    async runEval() {
      return fakeEvalVerdict();
    },
    async evaluateGate() {
      return fakeGateEvaluation();
    },
    async recordEvidence(_runId, record) {
      return record;
    },
    async recordApproval(runId, decision) {
      return {
        decision,
        event: {
          ...fakeEvent(runId, 1),
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
    async recordHumanAnswer(runId, answer) {
      return {
        answer,
        event: {
          ...fakeEvent(runId, 1),
          type: "human.answer_recorded",
          payload: answer
        },
        state: fakeState({
          runId,
          pendingQuestions: []
        })
      };
    }
  };
}

function fakeHandle(
  runId: string
): Awaited<ReturnType<CliRuntime["startRun"]>> {
  return {
    runId,
    state: fakeState({ runId }),
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
      checkpointPath: `/workspace/.archetype/runs/${runId}/state.checkpoint.json`,
      versionPath: `/workspace/.archetype/runs/${runId}/run.version.json`,
      migrationsPath: `/workspace/.archetype/runs/${runId}/migrations.jsonl`,
      sealPath: `/workspace/.archetype/runs/${runId}/seal.json`,
      readMostlyPath: `/workspace/.archetype/runs/${runId}/read-mostly.json`,
      retentionPath: `/workspace/.archetype/runs/${runId}/retention.json`,
      legalHoldsPath: `/workspace/.archetype/runs/${runId}/legal-holds.jsonl`,
      tombstonePath: `/workspace/.archetype/runs/${runId}/archive.tombstone.json`,
      archiveDir: "/workspace/.archetype/archives",
      archiveRunsDir: "/workspace/.archetype/archives/runs",
      archiveStageDir: "/workspace/.archetype/archives/.stage",
      archiveRunDir: `/workspace/.archetype/archives/runs/${runId}`,
      archiveManifestPath: `/workspace/.archetype/archives/runs/${runId}/archive.manifest.json`,
      evalsDir: `/workspace/.archetype/runs/${runId}/evals`,
      summaryPath: `/workspace/.archetype/runs/${runId}/summary.md`
    }
  };
}

function fakeState(
  overrides: {
    runId: string;
    status?: "running" | "paused" | "blocked" | "completed" | "failed";
    phase?: string;
    pendingApprovals?: Awaited<ReturnType<CliRuntime["getRun"]>>["pendingApprovals"];
    pendingQuestions?: Awaited<ReturnType<CliRuntime["getRun"]>>["pendingQuestions"];
    pendingRepairTasks?: Awaited<ReturnType<CliRuntime["getRun"]>>["pendingRepairTasks"];
  }
): Awaited<ReturnType<CliRuntime["getRun"]>> {
  return {
    runId: overrides.runId,
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
    pendingRepairTasks: overrides.pendingRepairTasks ?? [],
    artifacts: [],
    lastEventId: "event-1"
  };
}

function fakeEvent(
  runId: string,
  sequence: number
): Awaited<ReturnType<CliRuntime["getEvents"]>>[number] {
  return {
    id: `event-${sequence + 1}`,
    runId,
    type: "run.started",
    contractId: "specwright.event.run.started",
    contractVersion: "1",
    schemaHash:
      "sha256:a670db6bd3212b2022150b28ed9b9636135886c9d7da76d98f926a060a047c53",
    timestamp: "2026-05-29T00:00:00.000Z",
    sequence,
    traceId: "trace-1",
    payload: {
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

function fakeEvalVerdict(): Awaited<ReturnType<CliRuntime["runEval"]>> {
  return {
    evalId: "eval.required",
    targetRef: "eval:eval.required",
    status: "pass",
    severity: "blocking",
    findings: [],
    evidenceRefs: ["evidence:1"],
    producedBy: {
      kind: "deterministic",
      ref: "contract-eval-runner"
    }
  };
}

function fakeToolCallResult(): Awaited<ReturnType<CliRuntime["callTool"]>> {
  return {
    toolCallId: "tool-call-contract",
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
      traceId: "trace-tool"
    }
  };
}

function fakeGateEvaluation(): Awaited<ReturnType<CliRuntime["evaluateGate"]>> {
  return {
    verdict: {
      gateId: "intake.exit",
      phase: "intake",
      status: "pass",
      severity: "blocking",
      reasons: ["Gate passed"],
      findings: [],
      evidenceRefs: ["evidence:1"],
      obligations: [],
      evaluatedAt: "2026-05-29T00:00:00.000Z",
      evaluator: {
        kind: "deterministic",
        ref: "contract-gate-engine"
      },
      decisionHash: "sha256:gate"
    },
    instruction: {
      kind: "continue",
      gateId: "intake.exit"
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
