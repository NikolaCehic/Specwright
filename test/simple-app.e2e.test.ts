import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listArtifacts, readArtifact } from "@specwright/artifact-store";
import { listEvidence } from "@specwright/evidence-store";
import { getRunStorePaths } from "@specwright/run-store";
import { createRuntime } from "@specwright/runtime";
import type {
  ArtifactRecord,
  EvidenceRecord,
  EvalVerdict,
  RuntimeEvent,
  ToolCallRequest,
  ToolCallResult
} from "@specwright/schemas";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureSourceDir = join(repoRoot, "fixtures/simple-app");
const fixedNow = "2026-05-29T00:00:00.000Z";
const requiredEvalIds = [
  "artifact_schema_presence",
  "source_fidelity",
  "completeness_required_sections"
];
const expectedPhases = [
  "intake",
  "source_discovery",
  "evidence",
  "planning",
  "verification",
  "packaging"
];

let tempRoot: string;
let appDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "specwright-simple-app-e2e-"));
  appDir = join(tempRoot, "simple-app");

  await cp(fixtureSourceDir, appDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("default harness simple-app E2E", () => {
  test("runs the v0 fixture flow and replays from events", async () => {
    const runtime = createRuntime({
      now: () => fixedNow
    });
    const handle = await runtime.startRun({
      task: "Create a source-bound frontend contract",
      cwd: appDir,
      harnessId: "default",
      host: {
        kind: "cli"
      }
    });
    const paths = getRunStorePaths(appDir, handle.runId);

    expect(handle.harness.id).toBe("specwright.default");
    expect(handle.harness.phases.map((phase) => phase.id)).toEqual(expectedPhases);
    expect(handle.paths.runDir).toBe(paths.runDir);
    expect((await stat(paths.runDir)).isDirectory()).toBe(true);
    expect(handle.events.map((event) => event.type)).toEqual([
      "run.started",
      "harness.loaded",
      "phase.entered",
      "evidence.recorded",
      "artifact.recorded"
    ]);

    const intakeGate = await runtime.evaluateGate(handle.runId, "intake.exit");
    expect(intakeGate.verdict.status).toBe("pass");
    expect(intakeGate.instruction).toMatchObject({
      kind: "transition_phase",
      targetPhase: "source_discovery"
    });

    const sourceList = await callFsList(runtime, handle.runId, "src");
    const sourceEntries = sourceList.entries;
    expect(sourceEntries.map((entry) => entry.path)).toEqual([
      "src/main.ts",
      "src/messages.ts"
    ]);

    const mainSource = await callFsRead(runtime, handle.runId, "src/main.ts");
    const messagesSource = await callFsRead(
      runtime,
      handle.runId,
      "src/messages.ts"
    );
    expect(mainSource.content).toContain("export function renderMessage");
    expect(messagesSource.content).toContain("export function messageForUser");

    const evidenceRecords = await recordSourceEvidence({
      runtime,
      runId: handle.runId,
      mainToolCallId: mainSource.toolCallId,
      messagesToolCallId: messagesSource.toolCallId
    });
    const sourceInventory = await runtime.recordArtifact(
      handle.runId,
      sourceInventoryArtifact(sourceEntries, evidenceRecords)
    );
    const evidenceGraph = await runtime.recordArtifact(
      handle.runId,
      evidenceGraphArtifact(evidenceRecords)
    );

    const evidenceGate = await runtime.evaluateGate(handle.runId, {
      gateId: "evidence.context_sufficiency",
      phase: "evidence"
    });
    expect(evidenceGate.verdict.status).toBe("pass");
    expect(evidenceGate.instruction).toMatchObject({
      kind: "transition_phase",
      targetPhase: "planning"
    });

    const plan = await runtime.recordArtifact(
      handle.runId,
      planArtifact(evidenceRecords)
    );
    const planningGate = await runtime.evaluateGate(handle.runId, {
      gateId: "planning.plan_schema",
      phase: "planning"
    });
    expect(planningGate.verdict.status).toBe("pass");
    expect(planningGate.instruction).toMatchObject({
      kind: "transition_phase",
      targetPhase: "verification"
    });

    const evalVerdicts: EvalVerdict[] = [];
    for (const evalId of requiredEvalIds) {
      const verdict = await runtime.runEval(handle.runId, evalId);
      expect(verdict.status).toBe("pass");
      expect(verdict.producedBy.ref).toBe("specwright.eval-runner.v0");
      evalVerdicts.push(verdict);
    }

    const evalReport = await runtime.recordArtifact(
      handle.runId,
      evalReportArtifact(evalVerdicts)
    );
    const verificationGate = await runtime.evaluateGate(handle.runId, {
      gateId: "verification.required_evals",
      phase: "verification"
    });
    expect(verificationGate.verdict.status).toBe("pass");
    expect(verificationGate.instruction).toMatchObject({
      kind: "transition_phase",
      targetPhase: "packaging"
    });

    const summaryArtifactRecord = await runtime.recordArtifact(
      handle.runId,
      summaryArtifact(evalVerdicts)
    );
    const packagingGate = await runtime.evaluateGate(handle.runId, {
      gateId: "packaging.run_report",
      phase: "packaging"
    });
    expect(packagingGate.verdict.status).toBe("pass");
    expect(packagingGate.verdict.evaluator.ref).toBe("specwright.gate-engine.v0");

    const report = await runtime.writeRunReport(handle.runId);
    expect(report.summaryPath).toBe(paths.summaryPath);
    expect(await readFile(paths.summaryPath, "utf8")).toBe(report.markdown);
    expect(report.markdown).toContain("Harness: `specwright.default@0.1.0`");
    expect(report.markdown).toContain("fs.list: success");
    expect(report.markdown).toContain("fs.read: success");
    expect(report.markdown).toContain("artifact_schema_presence: pass");
    expect(report.markdown).toContain("packaging.run_report: pass");

    const artifacts = await listArtifacts({ rootDir: appDir, runId: handle.runId });
    expect(artifacts.map((artifact) => artifact.artifactId)).toEqual(
      expect.arrayContaining([
        "run-input",
        sourceInventory.artifactId,
        evidenceGraph.artifactId,
        plan.artifactId,
        evalReport.artifactId,
        summaryArtifactRecord.artifactId
      ])
    );
    expect(artifacts.map((artifact) => artifact.artifactType)).toEqual(
      expect.arrayContaining([
        "run-input",
        "source-inventory",
        "evidence-graph",
        "plan",
        "eval-report",
        "summary"
      ])
    );
    expect(await readArtifact({
      rootDir: appDir,
      runId: handle.runId,
      artifactId: "run-input"
    })).toMatchObject({
      artifactType: "run-input",
      content: {
        task: "Create a source-bound frontend contract"
      }
    });
    expect(await listEvidence({ rootDir: appDir, runId: handle.runId }))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "evidence:user:task",
            authority: "user"
          }),
          expect.objectContaining({
            id: "evidence:repo:src-main-render-message",
            authority: "repo"
          }),
          expect.objectContaining({
            id: "evidence:repo:src-messages-message-for-user",
            authority: "repo"
          })
        ])
      );

    const events = await runtime.getEvents(handle.runId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.started",
        "harness.loaded",
        "phase.entered",
        "tool.requested",
        "tool.completed",
        "evidence.recorded",
        "artifact.recorded",
        "eval.completed",
        "gate.evaluated"
      ])
    );
    expect(events.filter((event) => event.type === "eval.completed")).toHaveLength(3);
    expect(events.filter((event) => event.type === "gate.evaluated")).toHaveLength(5);
    expect(toolEvents(events).map((event) => event.toolId)).toEqual(
      expect.arrayContaining(["fs.list", "fs.read"])
    );

    await writeFile(paths.statePath, "{\"status\":\"stale\"}\n");
    await writeFile(paths.summaryPath, "stale summary\n");

    const replayed = await runtime.replay(handle.runId);
    expect(replayed.events).toHaveLength(events.length);
    expect(replayed.state.lastEventId).toBe(events.at(-1)?.id);
    expect(replayed.state.artifacts.map((artifact) => artifact.artifactId))
      .toEqual(
        expect.arrayContaining([
          "run-input",
          "source-inventory",
          "evidence-graph",
          "plan",
          "eval-report",
          "summary.md"
        ])
      );
  });
});

type RuntimeUnderTest = ReturnType<typeof createRuntime>;

type FsListOutput = {
  entries: Array<{
    path: string;
    type: string;
  }>;
};

type FsReadOutput = {
  content: string;
  toolCallId: string;
};

async function callFsList(
  runtime: RuntimeUnderTest,
  runId: string,
  path: string
): Promise<FsListOutput> {
  const result = await runtime.callTool(runId, toolRequest("fs.list", path), {
    cwd: "."
  });
  const output = successOutput(result);

  expect(output.path).toBe(path);
  expect(Array.isArray(output.entries)).toBe(true);

  return output as FsListOutput;
}

async function callFsRead(
  runtime: RuntimeUnderTest,
  runId: string,
  path: string
): Promise<FsReadOutput> {
  const result = await runtime.callTool(runId, toolRequest("fs.read", path), {
    cwd: "."
  });
  const output = successOutput(result);

  expect(output.path).toBe(path);
  expect(output.encoding).toBe("utf8");
  expect(output.truncated).toBe(false);

  return {
    content: String(output.content),
    toolCallId: result.toolCallId
  };
}

function toolRequest(toolId: "fs.list" | "fs.read", path: string): ToolCallRequest {
  return {
    toolId,
    args: {
      path
    },
    reason: `${toolId} ${path} for the simple-app MVP fixture`,
    idempotencyKey: `simple-app:${toolId}:${path}`,
    requestedBy: {
      phase: "source_discovery"
    }
  };
}

function successOutput(result: ToolCallResult): Record<string, unknown> {
  expect(result.status).toBe("success");

  if (result.status !== "success") {
    throw new Error(result.error?.message ?? "Tool call failed");
  }

  return result.output as Record<string, unknown>;
}

async function recordSourceEvidence(input: {
  runtime: RuntimeUnderTest;
  runId: string;
  mainToolCallId: string;
  messagesToolCallId: string;
}): Promise<EvidenceRecord[]> {
  const records = [
    {
      id: "evidence:repo:src-main-render-message",
      class: "source_fact",
      claim:
        "src/main.ts exports renderMessage and uppercases the messageForUser result.",
      sourceRefs: [
        {
          id: "src/main.ts",
          path: "src/main.ts",
          locator: "renderMessage"
        }
      ],
      confidence: "high",
      authority: "repo",
      createdBy: {
        phase: "evidence",
        actionId: "extract-source-facts",
        toolCallId: input.mainToolCallId
      }
    },
    {
      id: "evidence:repo:src-messages-message-for-user",
      class: "source_fact",
      claim: "src/messages.ts exports messageForUser and returns a greeting string.",
      sourceRefs: [
        {
          id: "src/messages.ts",
          path: "src/messages.ts",
          locator: "messageForUser"
        }
      ],
      confidence: "high",
      authority: "repo",
      createdBy: {
        phase: "evidence",
        actionId: "extract-source-facts",
        toolCallId: input.messagesToolCallId
      }
    }
  ] satisfies EvidenceRecord[];

  const recorded: EvidenceRecord[] = [];

  for (const record of records) {
    recorded.push(await input.runtime.recordEvidence(input.runId, record));
  }

  return recorded;
}

function sourceInventoryArtifact(
  entries: FsListOutput["entries"],
  evidenceRecords: EvidenceRecord[]
): ArtifactRecord {
  const evidenceRefs = evidenceRecords.map((record) => record.id);

  return {
    artifactId: "source-inventory",
    artifactType: "source-inventory",
    content: {
      root: "fixtures/simple-app",
      sources: entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        authority: "repo",
        evidenceRefs
      }))
    },
    evidenceRefs,
    claimLevel: "derived_fact",
    producedBy: {
      phase: "source_discovery",
      actionId: "record-source-inventory"
    },
    metadata: {
      canonicalName: "source-inventory.json"
    }
  };
}

function evidenceGraphArtifact(
  evidenceRecords: EvidenceRecord[]
): ArtifactRecord {
  const evidenceRefs = evidenceRecords.map((record) => record.id);

  return {
    artifactId: "evidence-graph",
    artifactType: "evidence-graph",
    content: {
      sources: evidenceRecords.map((record) => ({
        id: record.sourceRefs[0],
        authority: record.authority,
        evidenceRef: record.id
      })),
      records: evidenceRecords.map((record) => ({
        id: record.id,
        class: record.class,
        claim: record.claim,
        authority: record.authority,
        confidence: record.confidence,
        sourceRefs: record.sourceRefs
      }))
    },
    evidenceRefs,
    claimLevel: "derived_fact",
    producedBy: {
      phase: "evidence",
      actionId: "record-evidence-graph"
    },
    metadata: {
      canonicalName: "evidence-graph.json"
    }
  };
}

function planArtifact(evidenceRecords: EvidenceRecord[]): ArtifactRecord {
  const evidenceRefs = evidenceRecords.map((record) => record.id);
  const claims = [
    {
      claim:
        "The fixture has a source-backed render path from renderMessage to messageForUser.",
      claimLevel: "source_fact",
      evidenceRefs,
      confidence: "high",
      authority: "repo"
    },
    {
      claim:
        "The MVP verification can stay within read-only filesystem tools and deterministic evals.",
      claimLevel: "derived_fact",
      evidenceRefs,
      confidence: "medium",
      authority: "repo"
    }
  ] as const;

  return {
    artifactId: "plan",
    artifactType: "plan",
    content: {
      goal: "Create a source-bound frontend contract for the simple app fixture.",
      steps: [
        "Use fs.list to discover the source surface.",
        "Use fs.read to bind claims to source files.",
        "Run deterministic artifact schema, source fidelity, and completeness evals.",
        "Evaluate the required default harness gates."
      ],
      claims,
      sections: {
        goal: "Create a source-bound frontend contract for the simple app fixture.",
        evidence: evidenceRefs,
        steps: [
          "discover sources",
          "read sources",
          "record evidence",
          "run evals",
          "write report"
        ],
        risks: [
          "The fixture intentionally avoids model calls, writes, shell, browser, git, and external tools."
        ],
        verification: requiredEvalIds
      }
    },
    evidenceRefs,
    claimLevel: "derived_fact",
    importantClaims: claims.map((claim) => ({ ...claim })),
    producedBy: {
      phase: "planning",
      actionId: "record-plan"
    },
    metadata: {
      canonicalName: "plan.json"
    }
  };
}

function evalReportArtifact(verdicts: EvalVerdict[]): ArtifactRecord {
  const evidenceRefs = uniqueStrings(verdicts.flatMap((verdict) => verdict.evidenceRefs));

  return {
    artifactId: "eval-report",
    artifactType: "eval-report",
    content: {
      overallStatus: "pass",
      requiredEvalIds,
      evals: verdicts
    },
    evidenceRefs,
    claimLevel: "derived_fact",
    producedBy: {
      phase: "verification",
      actionId: "record-eval-report"
    },
    metadata: {
      canonicalName: "eval-report.json"
    }
  };
}

function summaryArtifact(verdicts: EvalVerdict[]): ArtifactRecord {
  const evidenceRefs = uniqueStrings(verdicts.flatMap((verdict) => verdict.evidenceRefs));

  return {
    artifactId: "summary.md",
    artifactType: "summary",
    content: {
      path: "summary.md",
      contentType: "text/markdown",
      sections: [
        "Run Summary",
        "Phases Executed",
        "Gates",
        "Tools",
        "Evals",
        "Artifacts",
        "Evidence And Unknowns"
      ]
    },
    evidenceRefs,
    claimLevel: "derived_fact",
    producedBy: {
      phase: "packaging",
      actionId: "record-summary-artifact"
    },
    metadata: {
      canonicalName: "summary.md"
    }
  };
}

function toolEvents(events: RuntimeEvent[]) {
  return events.flatMap((event) => {
    if (event.type !== "tool.completed" && event.type !== "tool.denied") {
      return [];
    }

    const payload = event.payload as {
      request?: {
        toolId?: string;
      };
    };
    const toolId = payload.request?.toolId;

    return toolId === undefined ? [] : [{ event, toolId }];
  });
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}
