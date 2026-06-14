import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeCli,
  outcomeForExitCode,
  type CliExecution,
  type OutcomeClass
} from "@specwright/cli";
import { materializeRunState, readEvents } from "@specwright/run-store";
import { createRuntime } from "@specwright/runtime";

export type LogicalOperation =
  | { kind: "startRun"; task: string }
  | { kind: "status" }
  | { kind: "events"; limit?: number | undefined }
  | { kind: "replay"; limit?: number | undefined }
  | { kind: "report" }
  | { kind: "approve"; approvalId: string; decisionHash: string };

export type ObservedOutcome = {
  adapter: string;
  operation: LogicalOperation["kind"];
  outcome: OutcomeClass;
  exitCode: number;
  runId?: string | undefined;
  machine?: unknown;
  error?: unknown;
  groundTruth?: GroundTruth | undefined;
  diagnostics?: unknown[];
  telemetryOutcome?: string | undefined;
};

export type GroundTruth = {
  stateStatus: string;
  statePhase: string;
  lastEventId: string;
  eventTypes: string[];
  reportSummaryPath?: string | undefined;
};

export type ParityAdapter = {
  name: string;
  run(operation: LogicalOperation): Promise<ObservedOutcome>;
};

export type ParityCase = {
  name: string;
  run(adapter: ParityAdapter): Promise<ObservedOutcome>;
  assert(outcome: ObservedOutcome): void;
};

type HarnessContext = {
  workspace: string;
  cleanup(): Promise<void>;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureSourceDir = join(repoRoot, "fixtures/simple-app");
const fixedNow = "2026-05-29T00:00:00.000Z";

export function createCliReferenceAdapter(): ParityAdapter {
  return {
    name: "cli",
    async run(operation) {
      const harness = await createHarnessContext();

      try {
        return await runWithRealRuntime(operation, harness);
      } finally {
        await harness.cleanup();
      }
    }
  };
}
export const parityCases: ParityCase[] = [
  {
    name: "start run persists real runtime events and state",
    async run(adapter) {
      return await adapter.run({
        kind: "startRun",
        task: "Create a source-bound frontend contract"
      });
    },
    assert(outcome) {
      assertOutcome(outcome, "ok", 0);
      assertGroundTruth(outcome);
      assertMachineStateMatchesGroundTruth(outcome);
      if (!outcome.groundTruth?.eventTypes.includes("run.started")) {
        throw new Error("real run did not persist run.started event");
      }
    }
  },
  {
    name: "status matches materialized run-store projection",
    async run(adapter) {
      return await adapter.run({ kind: "status" });
    },
    assert(outcome) {
      assertOutcome(outcome, "ok", 0);
      assertGroundTruth(outcome);
      assertMachineStateMatchesGroundTruth(outcome);
    }
  },
  {
    name: "events match persisted event log and bounded read marker",
    async run(adapter) {
      return await adapter.run({
        kind: "events",
        limit: 1
      });
    },
    assert(outcome) {
      assertOutcome(outcome, "ok", 0);
      assertGroundTruth(outcome);
      if (outcome.diagnostics?.length !== 1) {
        throw new Error("bounded events did not emit truncation diagnostics");
      }
      const machine = machineRecord(outcome);
      const data = machine.data as Array<{ type: string }>;
      if (data[0]?.type !== outcome.groundTruth?.eventTypes[0]) {
        throw new Error("events output did not match persisted log order");
      }
    }
  },
  {
    name: "replay reproduces real runtime projection",
    async run(adapter) {
      return await adapter.run({ kind: "replay" });
    },
    assert(outcome) {
      assertOutcome(outcome, "ok", 0);
      assertGroundTruth(outcome);
      const machine = machineRecord(outcome);
      const data = machine.data as { state: { lastEventId: string } };
      if (data.state.lastEventId !== outcome.groundTruth?.lastEventId) {
        throw new Error("replay projection drifted from run-store ground truth");
      }
    }
  },
  {
    name: "report writes through real runtime report API",
    async run(adapter) {
      return await adapter.run({ kind: "report" });
    },
    assert(outcome) {
      assertOutcome(outcome, "ok", 0);
      assertGroundTruth(outcome);
      const machine = machineRecord(outcome);
      const data = machine.data as { summaryPath: string; markdown: string };
      if (data.summaryPath !== outcome.groundTruth?.reportSummaryPath) {
        throw new Error("report summary path did not match runtime ground truth");
      }
      if (!data.markdown.includes("Harness: `specwright.default@0.1.0`")) {
        throw new Error("report did not contain real runtime report content");
      }
    }
  },
  {
    name: "missing run classifies not found against real runtime",
    async run(adapter) {
      const harness = await createHarnessContext();

      try {
        const execution = await executeCli(
          ["status", "missing-run", "--json"],
          createRuntime({ now: () => fixedNow }),
          optionsForHarness(harness)
        );

        return normalizeExecution({
          adapter: adapter.name,
          operation: "status",
          execution
        });
      } finally {
        await harness.cleanup();
      }
    },
    assert(outcome) {
      assertOutcome(outcome, "not_found", 7);
    }
  },
  {
    name: "approval resolution unsupported capability fails closed before runtime mutation",
    async run(adapter) {
      return await adapter.run({
        kind: "approve",
        approvalId: "approval-1",
        decisionHash: "sha256:approval"
      });
    },
    assert(outcome) {
      assertOutcome(outcome, "integrity", 10);
      if (outcome.machine !== undefined) {
        throw new Error("unsupported approval should not emit stdout machine data");
      }
      const error = errorRecord(outcome);
      if (
        !String(
          (error as { operatorAction?: unknown }).operatorAction
        ).includes("approval-decision API")
      ) {
        throw new Error("unsupported approval did not name missing runtime API");
      }
      assertGroundTruth(outcome);
      if (!outcome.groundTruth?.eventTypes.includes("run.started")) {
        throw new Error("approval blocker setup did not use real runtime run");
      }
    }
  }
];

export function registeredParityAdapters(): ParityAdapter[] {
  return [createCliReferenceAdapter()];
}

async function runWithRealRuntime(
  operation: LogicalOperation,
  harness: HarnessContext
): Promise<ObservedOutcome> {
  const runtime = createRuntime({ now: () => fixedNow });
  const start = await executeCli(
    [
      "run",
      "--cwd",
      harness.workspace,
      "--task",
      "Create a source-bound frontend contract",
      "--json"
    ],
    runtime,
    optionsForHarness(harness)
  );
  const startMachine = JSON.parse(start.stdout) as { runId: string };
  const runId = startMachine.runId;

  if (operation.kind === "startRun") {
    return normalizeExecution({
      adapter: "cli",
      operation: "startRun",
      execution: start,
      runId,
      groundTruth: await readGroundTruth(harness.workspace, runId)
    });
  }

  const execution = await executeCli(
    argvForOperation(operation, runId),
    runtime,
    optionsForHarness(harness)
  );
  const reportSummaryPath = reportPathFromExecution(execution);

  return normalizeExecution({
    adapter: "cli",
    operation: operation.kind,
    execution,
    runId,
    groundTruth: await readGroundTruth(
      harness.workspace,
      runId,
      reportSummaryPath
    )
  });
}

async function readGroundTruth(
  rootDir: string,
  runId: string,
  reportSummaryPath?: string | undefined
): Promise<GroundTruth> {
  const [state, events] = await Promise.all([
    materializeRunState({ rootDir, runId }),
    readEvents({ rootDir, runId })
  ]);

  return {
    stateStatus: state.status,
    statePhase: state.phase,
    lastEventId: state.lastEventId,
    eventTypes: events.map((event) => event.type),
    ...(reportSummaryPath === undefined ? {} : { reportSummaryPath })
  };
}

function argvForOperation(operation: LogicalOperation, runId: string): string[] {
  switch (operation.kind) {
    case "startRun":
      return [
        "run",
        "--cwd",
        "/unused",
        "--task",
        operation.task,
        "--json"
      ];
    case "status":
      return ["status", runId, "--json"];
    case "events":
      return [
        "events",
        runId,
        "--json",
        "--limit",
        String(operation.limit ?? 100)
      ];
    case "replay":
      return [
        "replay",
        runId,
        "--json",
        "--limit",
        String(operation.limit ?? 100)
      ];
    case "report":
      return ["report", runId, "--json"];
    case "approve":
      return [
        "approve",
        runId,
        "--approval",
        operation.approvalId,
        "--decision-hash",
        operation.decisionHash,
        "--json"
      ];
  }
}

function normalizeExecution(input: {
  adapter: string;
  operation: LogicalOperation["kind"];
  execution: CliExecution;
  runId?: string | undefined;
  groundTruth?: GroundTruth | undefined;
}): ObservedOutcome {
  const machine =
    input.execution.stdout.trim().length === 0
      ? undefined
      : JSON.parse(input.execution.stdout);
  const error =
    input.execution.stderr.trim().length === 0
      ? undefined
      : JSON.parse(input.execution.stderr);
  const diagnostics = diagnosticsFromMachine(machine);
  const telemetryOutcome = input.execution.telemetry?.outcome;

  return {
    adapter: input.adapter,
    operation: input.operation,
    outcome: outcomeForExitCode(input.execution.exitCode),
    exitCode: input.execution.exitCode,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(machine === undefined ? {} : { machine }),
    ...(error === undefined ? {} : { error }),
    ...(input.groundTruth === undefined ? {} : { groundTruth: input.groundTruth }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(telemetryOutcome === undefined ? {} : { telemetryOutcome })
  };
}

async function createHarnessContext(): Promise<HarnessContext> {
  const tempRoot = await mkdtemp(join(tmpdir(), "specwright-adapter-parity-"));
  const workspace = join(tempRoot, "simple-app");

  await cp(fixtureSourceDir, workspace, { recursive: true });

  return {
    workspace,
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

function optionsForHarness(harness: HarnessContext) {
  return {
    context: {
      principal: {
        id: "parity-operator",
        source: "local" as const,
        assuranceLevel: "medium" as const,
        roles: ["runner"]
      },
      tenant: {
        id: "parity",
        allowedRoots: [harness.workspace]
      },
      ci: true
    },
    invocationId: "parity-invocation",
    now: fixedClock([0, 1, 2, 3])
  };
}

function reportPathFromExecution(
  execution: CliExecution
): string | undefined {
  if (execution.stdout.trim().length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(execution.stdout) as {
    data?: { summaryPath?: string };
  };

  return parsed.data?.summaryPath;
}

function diagnosticsFromMachine(machine: unknown): unknown[] | undefined {
  if (
    typeof machine === "object" &&
    machine !== null &&
    Array.isArray((machine as { diagnostics?: unknown }).diagnostics)
  ) {
    return (machine as { diagnostics: unknown[] }).diagnostics;
  }

  return undefined;
}

function assertOutcome(
  outcome: ObservedOutcome,
  expectedOutcome: OutcomeClass,
  expectedExitCode: number
) {
  if (outcome.outcome !== expectedOutcome || outcome.exitCode !== expectedExitCode) {
    throw new Error(
      `${outcome.adapter} ${outcome.operation} expected ${expectedOutcome}/${expectedExitCode} but received ${outcome.outcome}/${outcome.exitCode}`
    );
  }

  if (outcome.telemetryOutcome !== expectedOutcome) {
    throw new Error(
      `${outcome.adapter} ${outcome.operation} telemetry outcome ${outcome.telemetryOutcome} did not match ${expectedOutcome}`
    );
  }
}

function assertGroundTruth(outcome: ObservedOutcome) {
  if (outcome.groundTruth === undefined) {
    throw new Error(`${outcome.operation} had no runtime ground truth`);
  }
}

function assertMachineStateMatchesGroundTruth(outcome: ObservedOutcome) {
  const machine = machineRecord(outcome);
  const state =
    outcome.operation === "startRun"
      ? (machine.data as { state: { status: string; phase: string; lastEventId: string } }).state
      : (machine.data as { status: string; phase: string; lastEventId: string });

  if (
    state.status !== outcome.groundTruth?.stateStatus ||
    state.phase !== outcome.groundTruth.statePhase ||
    state.lastEventId !== outcome.groundTruth.lastEventId
  ) {
    throw new Error(`${outcome.operation} output did not match run-store state`);
  }
}

function machineRecord(outcome: ObservedOutcome): Record<string, unknown> {
  if (typeof outcome.machine !== "object" || outcome.machine === null) {
    throw new Error(`${outcome.operation} did not emit machine output`);
  }

  return outcome.machine as Record<string, unknown>;
}

function errorRecord(outcome: ObservedOutcome): Record<string, unknown> {
  if (typeof outcome.error !== "object" || outcome.error === null) {
    throw new Error(`${outcome.operation} did not emit error output`);
  }

  return outcome.error as Record<string, unknown>;
}

function fixedClock(values: number[]) {
  let index = 0;

  return () => {
    const value = values[index] ?? values.at(-1) ?? 0;
    index += 1;
    return value;
  };
}
