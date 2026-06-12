import { describe, expect, test } from "bun:test";
import { executeCli } from "@specwright/adapters-cli";
import { projectRunState } from "@specwright/run-store";
import {
  MCP_ADAPTER_PROTOCOL_VERSION,
  PAGE10_CONFORMANCE_CASES,
  PAGE10_SEED_CASE_IDS,
  PAGE8_FAILURE_CLASS_COUNT,
  conformanceSummary,
  createMcpAdapter,
  createRealRuntimeConformanceHarness
} from "./index";

const PAGE10_ROWS = {
  contract: [
    "Every MCP tool maps 1:1 to a stable RuntimeApi operation",
    "No magic tool is registrable",
    "resources/read is read-only",
    "MCP prompts produce only runtime action descriptors",
    "CLI parity preserved",
    "Trust labels survive protocol mapping"
  ],
  "determinism-replay": [
    "MCP-originated mutations are event-sourced",
    "Projections are event-derived",
    "Replay reproduces MCP-driven runs",
    "Idempotent retries do not duplicate effects",
    "Cached projections are advisory"
  ],
  "fail-closed": [
    "Invalid args fail closed",
    "Stale state is rejected",
    "Policy denial is relayed, never bypassed",
    "Policy fault fails closed",
    "Approval is never auto-satisfied",
    "Approval timeout/rejection is terminal",
    "Partial-write fails closed",
    "No silent partial mutation"
  ],
  "security-abuse": [
    "Confused-deputy prevented",
    "No token passthrough",
    "External output is non-authoritative",
    "Rug-pull/drift quarantined",
    "No cross-server shadowing",
    "Tenant isolation holds",
    "Path containment holds",
    "Subject spoof rejected",
    "Error oracle closed",
    "Redaction cannot be relaxed",
    "Mass-exfiltration bounded"
  ],
  "observability-audit": [
    "MCP span coverage",
    "Correlation spine intact",
    "Principal is durable",
    "Every effect is attributable",
    "Authorization is auditable",
    "External invocations recorded",
    "Provenance gaps are flagged",
    "Audit export is integrity-bound"
  ],
  "migration-compat": [
    "Tool/resource/prompt contracts are versioned",
    "Protocol-version negotiation is explicit",
    "Breaking contract changes carry migration",
    "Historical MCP-driven runs replay",
    "Deprecation honors notice window"
  ],
  operability: [
    "Limits are enforced, not best-effort",
    "Load is shed, not dropped",
    "Tenancy is enforced before resolution",
    "External-server manifests are pinned",
    "Runbooks exist",
    "Gateway scales statelessly",
    "Change governance enforced"
  ]
} as const;

describe("Packet 06 MCP conformance suite", () => {
  test("case registry maps every page-10 row and every seed acceptance check", () => {
    const ids = new Set(PAGE10_CONFORMANCE_CASES.map((item) => item.id));
    const rowBuckets = conformanceSummary();

    expect(PAGE10_CONFORMANCE_CASES).toHaveLength(50);
    expect(rowBuckets.get("contract")).toBe(6);
    expect(rowBuckets.get("determinism-replay")).toBe(5);
    expect(rowBuckets.get("fail-closed")).toBe(8);
    expect(rowBuckets.get("security-abuse")).toBe(11);
    expect(rowBuckets.get("observability-audit")).toBe(8);
    expect(rowBuckets.get("migration-compat")).toBe(5);
    expect(rowBuckets.get("operability")).toBe(7);

    for (const seedId of PAGE10_SEED_CASE_IDS) {
      expect(ids.has(seedId), seedId).toBe(true);
      expect(PAGE10_CONFORMANCE_CASES.find((item) => item.id === seedId)?.seed).toBe(true);
    }

    for (const [bucket, rows] of Object.entries(PAGE10_ROWS)) {
      for (const row of rows) {
        expect(
          PAGE10_CONFORMANCE_CASES.some(
            (item) => item.bucket === bucket && item.page10Row === row
          ),
          `${bucket}: ${row}`
        ).toBe(true);
      }
    }

    expect(new Set(PAGE10_CONFORMANCE_CASES.map((item) => item.id)).size).toBe(
      PAGE10_CONFORMANCE_CASES.length
    );
    expect(PAGE8_FAILURE_CLASS_COUNT).toBe(26);
  });

  test("real-runtime MCP startRun appends event-sourced mutations and stamps MCP host", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const adapter = createMcpAdapter(harness.runtime);
      const started = await adapter.tools.call({
        name: "specwright_start_run",
        arguments: {
          task: "Create a source-bound frontend contract",
          cwd: harness.appDir,
          harnessId: "default",
          host: {
            kind: "mcp",
            version: MCP_ADAPTER_PROTOCOL_VERSION
          }
        }
      });

      expect(started.isError).toBe(false);
      if (started.isError) {
        throw new Error(started.error.message);
      }

      const runId = (started.result as { runId: string }).runId;
      const truth = await harness.groundTruth(runId);

      expect(truth.events.map((event) => event.type)).toEqual([
        "run.started",
        "harness.loaded",
        "phase.entered",
        "evidence.recorded",
        "artifact.recorded"
      ]);
      expect(truth.events[0]?.payload).toMatchObject({
        input: {
          host: {
            kind: "mcp",
            version: MCP_ADAPTER_PROTOCOL_VERSION
          }
        }
      });
      expect(truth.state).toEqual(projectRunState(truth.events));
      expect((started.result as { state: unknown }).state).toEqual(truth.state);
    } finally {
      await harness.cleanup();
    }
  });

  test("real-runtime resources/read state and replay match append-only event log", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const adapter = createMcpAdapter(harness.runtime);
      const started = await adapter.tools.call({
        name: "specwright_start_run",
        arguments: {
          task: "Create a source-bound frontend contract",
          cwd: harness.appDir,
          harnessId: "default",
          host: {
            kind: "mcp",
            version: MCP_ADAPTER_PROTOCOL_VERSION
          }
        }
      });

      if (started.isError) {
        throw new Error(started.error.message);
      }

      const runId = (started.result as { runId: string }).runId;
      const truth = await harness.groundTruth(runId);
      const stateRead = await adapter.resources.read({
        uri: `specwright://runs/${runId}/state`,
        options: {
          rootDir: harness.appDir
        }
      });
      const replayed = await adapter.tools.call({
        name: "specwright_replay",
        arguments: {
          runId,
          options: {
            rootDir: harness.appDir
          }
        }
      });

      expect(stateRead.isError).toBe(false);
      expect(replayed.isError).toBe(false);

      if (!stateRead.isError) {
        expect(stateRead.payload).toEqual(truth.state);
        expect(stateRead.metadata.lastEventId).toBe(truth.events.at(-1)?.id);
      }

      if (!replayed.isError) {
        expect((replayed.result as { state: unknown }).state).toEqual(truth.state);
        expect((replayed.result as { events: unknown[] }).events).toHaveLength(
          truth.events.length
        );
      }
    } finally {
      await harness.cleanup();
    }
  });

  test("real-runtime idempotent MCP tool retry returns prior result without duplicate effects", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const adapter = createMcpAdapter(harness.runtime);
      const started = await adapter.tools.call({
        name: "specwright_start_run",
        arguments: {
          task: "Create a source-bound frontend contract",
          cwd: harness.appDir,
          harnessId: "default",
          host: {
            kind: "mcp",
            version: MCP_ADAPTER_PROTOCOL_VERSION
          }
        }
      });

      if (started.isError) {
        throw new Error(started.error.message);
      }

      const runId = (started.result as { runId: string }).runId;
      const firstRequest = {
        runId,
        request: {
          toolId: "fs.list",
          args: {
            path: "src"
          },
          reason: "List source files for Packet 06 idempotency proof.",
          idempotencyKey: "packet-06:fs.list:src",
          requestedBy: {
            phase: "source_discovery"
          }
        },
        options: {
          rootDir: harness.appDir,
          cwd: "."
        }
      };
      const first = await adapter.tools.call({
        name: "specwright_call_tool",
        arguments: firstRequest
      });
      const afterFirst = await harness.groundTruth(runId);
      const retry = await adapter.tools.call({
        name: "specwright_call_tool",
        arguments: firstRequest
      });
      const afterRetry = await harness.groundTruth(runId);
      const conflict = await adapter.tools.call({
        name: "specwright_call_tool",
        arguments: {
          ...firstRequest,
          request: {
            ...firstRequest.request,
            args: {
              path: "src/main.ts"
            },
            reason: "Conflicting reuse must fail closed."
          }
        }
      });
      const afterConflict = await harness.groundTruth(runId);

      expect(first.isError).toBe(false);
      expect(retry).toEqual(first);
      expect(conflict).toMatchObject({
        isError: true,
        error: {
          code: "idempotency_conflict",
          retryable: false
        }
      });
      expect(toolRuntimeEventTypes(afterFirst.events)).toEqual([
        "tool.requested",
        "tool.completed"
      ]);
      expect(toolRuntimeEventTypes(afterRetry.events)).toEqual(
        toolRuntimeEventTypes(afterFirst.events)
      );
      expect(toolRuntimeEventTypes(afterConflict.events)).toEqual(
        toolRuntimeEventTypes(afterFirst.events)
      );
      expect(afterRetry.events).toHaveLength(afterFirst.events.length);
      expect(afterConflict.events).toHaveLength(afterFirst.events.length);
    } finally {
      await harness.cleanup();
    }
  });

  test("real-runtime idempotency key reuse with different principal context fails closed", async () => {
    const harness = await createRealRuntimeConformanceHarness();
    const subject = (subjectId: string) => ({
      subjectId,
      tenantId: "tenant-a",
      claimRef: `claim-${subjectId}`,
      issuedBy: "idp.fixture"
    });

    try {
      const adapter = createMcpAdapter(harness.runtime, {
        auth: {
          mode: "authenticated",
          credentialVerifier(credential) {
            if (credential !== "valid") {
              throw new Error("invalid credential");
            }

            return {
              clientId: "client-1",
              tenantId: "tenant-a",
              grantedScopes: ["run:start", "tool:call"],
              runMode: "assisted"
            };
          },
          subjectVerifier(claim) {
            if (
              typeof claim !== "object" ||
              claim === null ||
              !("subjectId" in claim)
            ) {
              return false;
            }

            return {
              subjectId: String(claim.subjectId),
              tenantId: "tenant-a",
              scopes: ["run:start", "tool:call"],
              sourceTrust: {
                subjectAuthority: "idp.fixture"
              }
            };
          }
        }
      });
      const started = await adapter.tools.call({
        name: "specwright_start_run",
        arguments: {
          task: "Create a source-bound frontend contract",
          cwd: harness.appDir,
          harnessId: "default",
          host: {
            kind: "mcp",
            version: MCP_ADAPTER_PROTOCOL_VERSION
          }
        },
        credential: "valid",
        subject: subject("subject-1")
      });

      if (started.isError) {
        throw new Error(started.error.message);
      }

      const runId = (started.result as { runId: string }).runId;
      const request = {
        runId,
        request: {
          toolId: "fs.list",
          args: {
            path: "src"
          },
          reason: "List source files for Packet 06 principal idempotency proof.",
          idempotencyKey: "packet-06:principal:fs.list:src",
          requestedBy: {
            phase: "source_discovery"
          }
        },
        options: {
          rootDir: harness.appDir,
          cwd: "."
        }
      };
      const first = await adapter.tools.call({
        name: "specwright_call_tool",
        arguments: request,
        credential: "valid",
        subject: subject("subject-1")
      });
      const afterFirst = await harness.groundTruth(runId);
      const conflict = await adapter.tools.call({
        name: "specwright_call_tool",
        arguments: request,
        credential: "valid",
        subject: subject("subject-2")
      });
      const afterConflict = await harness.groundTruth(runId);

      expect(first.isError).toBe(false);
      expect(conflict).toMatchObject({
        isError: true,
        error: {
          code: "idempotency_conflict",
          retryable: false
        }
      });
      expect(toolRuntimeEventTypes(afterFirst.events)).toEqual([
        "tool.requested",
        "tool.completed"
      ]);
      expect(toolRuntimeEventTypes(afterConflict.events)).toEqual(
        toolRuntimeEventTypes(afterFirst.events)
      );
      expect(afterConflict.events).toHaveLength(afterFirst.events.length);
    } finally {
      await harness.cleanup();
    }
  });

  test("real-runtime idempotent MCP tool retry survives adapter recreation", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const adapterA = createMcpAdapter(harness.runtime);
      const adapterB = createMcpAdapter(harness.runtime);
      const started = await adapterA.tools.call({
        name: "specwright_start_run",
        arguments: {
          task: "Create a source-bound frontend contract",
          cwd: harness.appDir,
          harnessId: "default",
          host: {
            kind: "mcp",
            version: MCP_ADAPTER_PROTOCOL_VERSION
          }
        }
      });

      if (started.isError) {
        throw new Error(started.error.message);
      }

      const runId = (started.result as { runId: string }).runId;
      const firstRequest = {
        runId,
        request: {
          toolId: "fs.list",
          args: {
            path: "src"
          },
          reason: "List source files through a recreated MCP adapter.",
          idempotencyKey: "packet-06:recreated-adapter:fs.list:src",
          requestedBy: {
            phase: "source_discovery"
          }
        },
        options: {
          rootDir: harness.appDir,
          cwd: "."
        }
      };
      const first = await adapterA.tools.call({
        name: "specwright_call_tool",
        arguments: firstRequest
      });
      const afterFirst = await harness.groundTruth(runId);
      const retry = await adapterB.tools.call({
        name: "specwright_call_tool",
        arguments: firstRequest
      });
      const afterRetry = await harness.groundTruth(runId);
      const conflict = await adapterB.tools.call({
        name: "specwright_call_tool",
        arguments: {
          ...firstRequest,
          request: {
            ...firstRequest.request,
            args: {
              path: "src/main.ts"
            },
            reason: "Conflicting recreated-adapter reuse must fail closed."
          }
        }
      });
      const afterConflict = await harness.groundTruth(runId);

      expect(first.isError).toBe(false);
      expect(retry).toEqual(first);
      expect(conflict).toMatchObject({
        isError: true,
        error: {
          code: "idempotency_conflict",
          retryable: false
        }
      });
      expect(toolRuntimeEventTypes(afterFirst.events)).toEqual([
        "tool.requested",
        "tool.completed"
      ]);
      expect(toolRuntimeEventTypes(afterRetry.events)).toEqual(
        toolRuntimeEventTypes(afterFirst.events)
      );
      expect(toolRuntimeEventTypes(afterConflict.events)).toEqual(
        toolRuntimeEventTypes(afterFirst.events)
      );
      expect(afterRetry.events).toHaveLength(afterFirst.events.length);
      expect(afterConflict.events).toHaveLength(afterFirst.events.length);
    } finally {
      await harness.cleanup();
    }
  });

  test("real-runtime MCP getRun preserves CLI status parity over the same run", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const handle = await harness.runtime.startRun({
        task: "Create a source-bound frontend contract",
        cwd: harness.appDir,
        harnessId: "default",
        host: {
          kind: "cli"
        }
      });
      const adapter = createMcpAdapter(harness.runtime);
      const mcp = await adapter.tools.call({
        name: "specwright_get_run",
        arguments: {
          runId: handle.runId,
          options: {
            rootDir: harness.appDir
          }
        }
      });
      const cli = await executeCli(
        ["status", handle.runId, "--root", harness.appDir, "--json"],
        {
          startRun: harness.runtime.startRun,
          getRun: harness.runtime.getRun,
          getEvents: harness.runtime.getEvents,
          replay: harness.runtime.replay,
          writeRunReport: harness.runtime.writeRunReport,
          recordEvidence: harness.runtime.recordEvidence
        },
        {
          context: {
            principal: {
              id: "operator-1",
              source: "local",
              assuranceLevel: "medium",
              roles: ["runner"]
            },
            tenant: {
              id: "tenant-a",
              allowedRoots: [harness.appDir]
            },
            ci: false
          }
        }
      );

      expect(mcp.isError).toBe(false);
      expect(cli.exitCode).toBe(0);
      expect((mcp as { result: unknown }).result).toEqual(
        JSON.parse(cli.stdout).data
      );
    } finally {
      await harness.cleanup();
    }
  });
});

function toolRuntimeEventTypes(events: readonly { type: string }[]) {
  return events
    .map((event) => event.type)
    .filter((type) => type === "tool.requested" || type.startsWith("tool."));
}
