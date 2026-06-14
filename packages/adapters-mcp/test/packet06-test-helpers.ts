import type { RuntimeApi } from "@specwright/runtime";

export function fakeRuntimeForPacket06(input: { calls?: string[] } = {}): RuntimeApi {
  const calls = input.calls;

  return {
    async startRun(runInput) {
      calls?.push("startRun");
      return {
        runId: "run-packet-06",
        state: fakeState("run-packet-06"),
        harness: {
          id: "specwright.default",
          version: "0.1.0",
          specHash: "sha256:harness",
          phases: []
        },
        events: [],
        paths: {
          rootDir: runInput.cwd,
          runDir: `${runInput.cwd}/.specwright/runs/run-packet-06`,
          eventsPath: `${runInput.cwd}/.specwright/runs/run-packet-06/events.jsonl`,
          statePath: `${runInput.cwd}/.specwright/runs/run-packet-06/state.json`,
          summaryPath: `${runInput.cwd}/.specwright/runs/run-packet-06/summary.md`
        }
      } as unknown as Awaited<ReturnType<RuntimeApi["startRun"]>>;
    },
    async getRun(runId) {
      calls?.push("getRun");
      return fakeState(runId);
    },
    async getEvents(runId) {
      calls?.push("getEvents");
      return [
        {
          id: "event-1",
          runId,
          type: "run.started",
          timestamp: "2026-05-29T00:00:00.000Z",
          sequence: 0,
          traceId: "trace-1",
          payload: {
            input: {
              task: "Packet 06",
              cwd: "/workspace",
              harnessId: "default",
              host: {
                kind: "mcp",
                version: "2026-05-29"
              }
            }
          }
        }
      ] as unknown as Awaited<ReturnType<RuntimeApi["getEvents"]>>;
    },
    async replay(runId) {
      calls?.push("replay");
      const events = await this.getEvents(runId);
      return {
        state: fakeState(runId),
        events
      };
    },
    async callTool() {
      calls?.push("callTool");
      return {
        toolCallId: "tool-call-1",
        status: "success",
        output: {
          ok: true
        },
        provenance: {
          toolId: "fs.list",
          toolVersion: "0.1.0",
          argsHash: "sha256:args",
          resultHash: "sha256:result",
          cacheStatus: "miss",
          traceId: "trace-1",
          adapterVersion: "0.1.0",
          decisionHash: "sha256:decision"
        }
      };
    },
    async runEval() {
      calls?.push("runEval");
      throw new Error("not needed for Packet 06 helper");
    },
    async recordEvidence(_runId, record) {
      calls?.push("recordEvidence");
      return record;
    },
    async recordArtifact(_runId, record) {
      calls?.push("recordArtifact");
      return {
        ...record,
        metadata: record.metadata ?? {},
        redactionPolicy: record.redactionPolicy ?? "operator"
      } as unknown as Awaited<ReturnType<RuntimeApi["recordArtifact"]>>;
    },
    async evaluateGate() {
      calls?.push("evaluateGate");
      throw new Error("not needed for Packet 06 helper");
    },
    async generateReport(runId) {
      calls?.push("generateReport");
      return {
        runId,
        summaryPath: "/workspace/.specwright/runs/run-packet-06/summary.md",
        markdown: "# Packet 06",
        missingInputs: []
      };
    },
    async writeRunReport(runId) {
      calls?.push("writeRunReport");
      return {
        runId,
        summaryPath: "/workspace/.specwright/runs/run-packet-06/summary.md",
        markdown: "# Packet 06",
        missingInputs: []
      };
    }
  };
}

export function fakeState(runId: string): Awaited<ReturnType<RuntimeApi["getRun"]>> {
  return {
    runId,
    status: "running",
    phase: "intake",
    harness: {
      id: "specwright.default",
      version: "0.1.0",
      specHash: "sha256:harness"
    },
    budgets: {},
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    lastEventId: "event-1"
  };
}
