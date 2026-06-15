import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { executeCli, outputSchemas, type CliRuntime } from "./index";

const fixtureDir = fileURLToPath(
  new URL("../fixtures/output-contract", import.meta.url)
);
const fixtureNames = [
  "run-ok.json",
  "status-ok.json",
  "events-ok.json",
  "replay-ok.json",
  "report-ok.json"
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
  const commands: Record<string, string[]> = {
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
    "report-ok.json": ["report", "run-contract", "--json"]
  };
  const envelopes: Record<string, Record<string, unknown>> = {};

  for (const [fixtureName, argv] of Object.entries(commands)) {
    const result = await executeCli(argv, runtime, {
      context: authenticatedContext,
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
        summaryPath: "/workspace/.specwright/runs/run-contract/summary.md",
        markdown: "# Run Summary\n\n- Status: running\n",
        missingInputs: []
      };
    },
    async recordEvidence(_runId, record) {
      return record;
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
      schemaVersion: "specwright.harness.v1",
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
      runsDir: "/workspace/.specwright/runs",
      runDir: `/workspace/.specwright/runs/${runId}`,
      eventsPath: `/workspace/.specwright/runs/${runId}/events.jsonl`,
      statePath: `/workspace/.specwright/runs/${runId}/state.json`,
      tracePath: `/workspace/.specwright/runs/${runId}/trace.json`,
      decisionsPath: `/workspace/.specwright/runs/${runId}/decisions.jsonl`,
      artifactsDir: `/workspace/.specwright/runs/${runId}/artifacts`,
      evidenceDir: `/workspace/.specwright/runs/${runId}/evidence`,
      cacheDir: `/workspace/.specwright/runs/${runId}/cache`,
      checkpointPath: `/workspace/.specwright/runs/${runId}/state.checkpoint.json`,
      versionPath: `/workspace/.specwright/runs/${runId}/run.version.json`,
      migrationsPath: `/workspace/.specwright/runs/${runId}/migrations.jsonl`,
      sealPath: `/workspace/.specwright/runs/${runId}/seal.json`,
      readMostlyPath: `/workspace/.specwright/runs/${runId}/read-mostly.json`,
      retentionPath: `/workspace/.specwright/runs/${runId}/retention.json`,
      legalHoldsPath: `/workspace/.specwright/runs/${runId}/legal-holds.jsonl`,
      tombstonePath: `/workspace/.specwright/runs/${runId}/archive.tombstone.json`,
      archiveDir: "/workspace/.specwright/archives",
      archiveRunsDir: "/workspace/.specwright/archives/runs",
      archiveStageDir: "/workspace/.specwright/archives/.stage",
      archiveRunDir: `/workspace/.specwright/archives/runs/${runId}`,
      archiveManifestPath: `/workspace/.specwright/archives/runs/${runId}/archive.manifest.json`,
      evalsDir: `/workspace/.specwright/runs/${runId}/evals`,
      summaryPath: `/workspace/.specwright/runs/${runId}/summary.md`
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

function fixedClock(values: number[]) {
  let index = 0;

  return () => {
    const value = values[index] ?? values.at(-1) ?? 0;
    index += 1;
    return value;
  };
}
