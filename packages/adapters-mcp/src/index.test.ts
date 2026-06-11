import { describe, expect, test } from "bun:test";
import { executeCli, type CliRuntime } from "@specwright/adapters-cli";
import type { RuntimeApi } from "@specwright/runtime";
import {
  createMcpAdapter,
  defaultMcpCatalog,
  McpCatalogError,
  mcpToolBindings,
  registerMcpCatalog,
  registerMcpTool,
  type McpToolBinding
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

describe("specwright mcp adapter", () => {
  test("registers exactly eleven enabled runtime-backed tools", () => {
    expect(defaultMcpCatalog.enabledBindings).toHaveLength(11);
    expect(defaultMcpCatalog.disabledBindings).toHaveLength(3);

    for (const binding of defaultMcpCatalog.enabledBindings) {
      expect(binding.enabled).toBe(true);
      expect(binding.stability).toBe("stable");
      expect(typeof binding.runtimeOperation).toBe("string");
      expect(Array.isArray(binding.runtimeOperation)).toBe(false);
    }

    expect(
      defaultMcpCatalog.enabledBindings.map((binding) => [
        binding.name,
        binding.runtimeOperation
      ])
    ).toEqual([
      ["specwright_call_tool", "callTool"],
      ["specwright_evaluate_gate", "evaluateGate"],
      ["specwright_generate_report", "generateReport"],
      ["specwright_get_events", "getEvents"],
      ["specwright_get_run", "getRun"],
      ["specwright_record_artifact", "recordArtifact"],
      ["specwright_record_evidence", "recordEvidence"],
      ["specwright_replay", "replay"],
      ["specwright_run_eval", "runEval"],
      ["specwright_start_run", "startRun"],
      ["specwright_write_report", "writeRunReport"]
    ]);
  });

  test("rejects magic and stale catalog registrations", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "zero operation",
        magicBinding({
          name: "specwright_generate_entire_app",
          runtimeOperation: undefined
        }),
        "missing_runtime_operation"
      ],
      [
        "multiple operations",
        magicBinding({
          name: "specwright_fix_everything",
          runtimeOperation: ["startRun", "getRun"]
        }),
        "multiple_runtime_operations"
      ],
      [
        "unknown operation",
        magicBinding({
          name: "specwright_delete_run",
          runtimeOperation: "deleteRun"
        }),
        "unknown_runtime_operation"
      ],
      [
        "duplicate name",
        magicBinding({
          name: "specwright_start_run",
          runtimeOperation: "startRun"
        }),
        "duplicate_tool_name"
      ],
      [
        "enabled gated operation",
        magicBinding({
          name: "specwright_get_next_action",
          runtimeOperation: "getNextAction"
        }),
        "gated_tool_enabled"
      ]
    ];

    for (const [label, binding, code] of cases) {
      expect(() => registerMcpTool(mcpToolBindings, binding)).toThrow(
        McpCatalogError
      );

      try {
        registerMcpTool(mcpToolBindings, binding);
      } catch (error) {
        expect((error as McpCatalogError).code, label).toBe(code);
      }
    }
  });

  test("tools/list returns only enabled stable bindings in deterministic order", () => {
    const adapter = createMcpAdapter(fakeRuntime());
    const first = adapter.tools.list();
    const second = adapter.tools.list();

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.tools).toHaveLength(11);
    expect(first.tools.every((tool) => tool.stability === "stable")).toBe(true);
    expect(first.tools.map((tool) => tool.name)).not.toContain(
      "specwright_get_next_action"
    );
    expect(first.tools.map((tool) => tool.name)).not.toContain(
      "specwright_answer_question"
    );
    expect(first.tools.map((tool) => tool.name)).not.toContain(
      "specwright_record_approval"
    );
  });

  test("unknown, disabled, and invalid calls fail closed with zero runtime calls", async () => {
    const calls: unknown[] = [];
    const adapter = createMcpAdapter(
      fakeRuntime({
        async startRun(input) {
          calls.push(["startRun", input]);
          return fakeHandle();
        }
      })
    );

    const unknown = await adapter.tools.call({
      name: "specwright_make_design_better",
      arguments: {}
    });
    const disabled = await adapter.tools.call({
      name: "specwright_record_approval",
      arguments: { runId: "run-1" }
    });
    const invalid = await adapter.tools.call({
      name: "specwright_start_run",
      arguments: { task: "missing harness and host" }
    });

    expect(unknown).toMatchObject({
      isError: true,
      error: {
        code: "method_not_found"
      }
    });
    expect(disabled).toMatchObject({
      isError: true,
      error: {
        code: "invalid_request"
      }
    });
    expect(invalid).toMatchObject({
      isError: true,
      error: {
        code: "invalid_request"
      }
    });
    expect(calls).toEqual([]);
  });

  test("tools/call forwards exactly one RuntimeApi operation", async () => {
    const calls: unknown[] = [];
    const adapter = createMcpAdapter(
      fakeRuntime({
        async getRun(runId, options) {
          calls.push(["getRun", runId, options]);
          return fakeState({
            runId,
            status: "paused"
          });
        }
      })
    );

    const result = await adapter.tools.call({
      name: "specwright_get_run",
      arguments: {
        runId: "run-2",
        options: {
          rootDir: "/runs-root"
        }
      }
    });

    expect(result).toMatchObject({
      isError: false,
      result: {
        runId: "run-2",
        status: "paused"
      }
    });
    expect(calls).toEqual([["getRun", "run-2", { rootDir: "/runs-root" }]]);
  });

  test("recordArtifact accepts runtime-shaped ArtifactRecordInput with runtime-defaulted fields omitted", async () => {
    const calls: unknown[] = [];
    const minimalRecord = {
      artifactId: "artifact-1",
      artifactType: "plan",
      content: {
        title: "Implementation plan"
      },
      evidenceRefs: [],
      producedBy: {
        phase: "planning",
        actionId: "action-1"
      }
    };
    const adapter = createMcpAdapter(
      fakeRuntime({
        async recordArtifact(runId, record, options) {
          calls.push(["recordArtifact", runId, record, options]);

          return {
            ...record,
            metadata: record.metadata ?? {},
            redactionPolicy: record.redactionPolicy ?? "operator"
          };
        }
      })
    );

    const result = await adapter.tools.call({
      name: "specwright_record_artifact",
      arguments: {
        runId: "run-artifact",
        record: minimalRecord,
        options: {
          rootDir: "/runs-root"
        }
      }
    });

    expect(result).toMatchObject({
      isError: false,
      result: {
        artifactId: "artifact-1",
        artifactType: "plan"
      }
    });
    expect(calls).toEqual([
      [
        "recordArtifact",
        "run-artifact",
        minimalRecord,
        {
          rootDir: "/runs-root"
        }
      ]
    ]);
    expect("metadata" in minimalRecord).toBe(false);
    expect("importantClaims" in minimalRecord).toBe(false);
    expect("redactionPolicy" in minimalRecord).toBe(false);
  });

  test("recordArtifact rejects malformed artifact records before runtime", async () => {
    const calls: unknown[] = [];
    const adapter = createMcpAdapter(
      fakeRuntime({
        async recordArtifact(runId, record, options) {
          calls.push(["recordArtifact", runId, record, options]);
          return record as Awaited<ReturnType<RuntimeApi["recordArtifact"]>>;
        }
      })
    );

    const result = await adapter.tools.call({
      name: "specwright_record_artifact",
      arguments: {
        runId: "run-artifact",
        record: {
          artifactId: "artifact-1",
          artifactType: "plan",
          evidenceRefs: [],
          producedBy: {
            phase: "planning",
            actionId: "action-1"
          }
        }
      }
    });

    expect(result).toMatchObject({
      isError: true,
      error: {
        code: "invalid_request"
      }
    });
    expect(calls).toEqual([]);
  });

  test("callTool success preserves provenance unmodified", async () => {
    const provenance = {
      toolId: "fs.read",
      toolVersion: "0.1.0",
      argsHash: "sha256:args",
      resultHash: "sha256:result",
      cacheStatus: "miss" as const,
      traceId: "trace-1",
      adapterVersion: "0.1.0",
      decisionHash: "sha256:decision"
    };
    const runtimeResult = {
      toolCallId: "tool-call-1",
      status: "success" as const,
      output: {
        ok: true
      },
      provenance
    };
    const adapter = createMcpAdapter(
      fakeRuntime({
        async callTool() {
          return runtimeResult;
        }
      })
    );

    const result = await adapter.tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments()
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].json).toBe(runtimeResult);
    expect((result.result as typeof runtimeResult).provenance).toBe(provenance);
    expect((result.result as typeof runtimeResult).provenance).toEqual(provenance);
  });

  test("callTool denied, approval_required, and failed outcomes surface as errors", async () => {
    const outcomes = [
      {
        result: toolResult({
          status: "denied",
          code: "policy_denied",
          message: "Policy denied tool call."
        }),
        expectedCode: "policy_denied"
      },
      {
        result: toolResult({
          status: "approval_required",
          code: "approval_required",
          message: "Needs approval.",
          approvalId: "approval-1"
        }),
        expectedCode: "approval_required",
        approvalId: "approval-1"
      },
      {
        result: toolResult({
          status: "failed",
          code: "output_invalid",
          message: "Output failed schema validation."
        }),
        expectedCode: "output_invalid"
      }
    ];

    for (const outcome of outcomes) {
      const adapter = createMcpAdapter(
        fakeRuntime({
          async callTool() {
            return outcome.result;
          }
        })
      );

      const response = await adapter.tools.call({
        name: "specwright_call_tool",
        arguments: validToolCallArguments()
      });

      expect(response).toMatchObject({
        isError: true,
        error: {
          code: outcome.expectedCode
        }
      });
      expect(response.content[0].json).toBe(outcome.result);

      if (outcome.approvalId !== undefined) {
        expect(response).toMatchObject({
          error: {
            approvalId: outcome.approvalId
          }
        });
      }
    }
  });

  test("runtime throws become structured invalid_request responses", async () => {
    const adapter = createMcpAdapter(
      fakeRuntime({
        async startRun(input) {
          throw new Error(`unexpected invalid input ${String(input.task)}`);
        }
      })
    );

    const result = await adapter.tools.call({
      name: "specwright_start_run",
      arguments: validRunInput()
    });

    expect(result).toMatchObject({
      isError: true,
      error: {
        code: "invalid_request",
        retryable: false
      }
    });
  });

  test("CLI parity for startRun proves shared runtime semantics", async () => {
    const cliCalls: unknown[] = [];
    const mcpCalls: unknown[] = [];
    const cliRuntime = fakeCliRuntime({
      async startRun(input) {
        cliCalls.push(input);
        return fakeHandle({
          runId: "run-parity",
          status: "running"
        });
      }
    });
    const mcpRuntime = fakeRuntime({
      async startRun(input) {
        mcpCalls.push(input);
        return fakeHandle({
          runId: "run-parity",
          status: "running"
        });
      }
    });

    const cliResult = await executeCli(
      ["run", "--cwd", "/workspace", "--task", "Create contract", "--json"],
      cliRuntime,
      { context: authenticatedContext }
    );
    const mcpResult = await createMcpAdapter(mcpRuntime).tools.call({
      name: "specwright_start_run",
      arguments: validRunInput()
    });

    expect(cliResult.exitCode).toBe(0);
    expect(mcpResult.isError).toBe(false);
    expect(cliCalls).toHaveLength(1);
    expect(mcpCalls).toHaveLength(1);
    expect(stripHost(cliCalls[0])).toEqual(stripHost(mcpCalls[0]));
    expect(JSON.parse(cliResult.stdout).data.state).toEqual(
      (mcpResult.result as Awaited<ReturnType<RuntimeApi["startRun"]>>).state
    );
  });

  test("custom catalog construction never admits invalid bindings into list or call", () => {
    expect(() =>
      registerMcpCatalog([
        magicBinding({
          name: "specwright_make_design_better",
          runtimeOperation: ["getRun", "writeRunReport"]
        }) as McpToolBinding
      ])
    ).toThrow(McpCatalogError);
  });
});

function validRunInput() {
  return {
    task: "Create contract",
    cwd: "/workspace",
    harnessId: "default",
    host: {
      kind: "mcp" as const,
      version: "0.0.0"
    },
    metadata: {
      mcp: {
        actor: authenticatedContext.principal,
        tenant: {
          id: "tenant-a"
        }
      }
    }
  };
}

function validToolCallArguments() {
  return {
    runId: "run-1",
    request: {
      toolId: "fs.read",
      args: {
        path: "README.md"
      },
      reason: "Read project overview.",
      idempotencyKey: "idem-1",
      requestedBy: {
        phase: "intake"
      }
    },
    options: {
      rootDir: "/runs-root",
      traceId: "trace-1"
    }
  };
}

function toolResult(input: {
  status: "denied" | "approval_required" | "failed";
  code: string;
  message: string;
  approvalId?: string | undefined;
}): Awaited<ReturnType<RuntimeApi["callTool"]>> {
  return {
    toolCallId: `tool-call-${input.status}`,
    status: input.status,
    error: {
      code: input.code,
      message: input.message,
      retryable: false
    },
    provenance: {
      toolId: "fs.read",
      toolVersion: "0.1.0",
      argsHash: "sha256:args",
      cacheStatus: "bypass",
      traceId: "trace-1",
      ...(input.approvalId === undefined
        ? {}
        : {
            approvalId: input.approvalId
          })
    }
  };
}

function magicBinding(input: {
  name: string;
  runtimeOperation: unknown;
}): Record<string, unknown> {
  const binding: Record<string, unknown> = {
    name: input.name,
    description: "Invalid catalog test binding.",
    mutates: true,
    stability: "stable",
    enabled: true,
    inputParser: {
      safeParse() {
        return {
          success: true,
          data: {}
        };
      }
    },
    inputSchema: {
      schemaRef: "specwright://test",
      description: "test"
    },
    outputSchemaRef: "test"
  };

  if (input.runtimeOperation !== undefined) {
    binding.runtimeOperation = input.runtimeOperation;
  }

  return binding;
}

function fakeCliRuntime(overrides: Partial<CliRuntime> = {}): CliRuntime {
  const base = fakeRuntime();

  return {
    startRun: base.startRun,
    getRun: base.getRun,
    getEvents: base.getEvents,
    replay: base.replay,
    writeRunReport: base.writeRunReport,
    recordEvidence: base.recordEvidence,
    ...overrides
  };
}

function fakeRuntime(overrides: Partial<RuntimeApi> = {}): RuntimeApi {
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
    async callTool() {
      return {
        toolCallId: "tool-call-1",
        status: "success",
        output: {
          ok: true
        },
        provenance: {
          toolId: "fs.read",
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
      return {
        evalId: "eval-1",
        targetRef: "artifact:plan",
        status: "pass",
        severity: "advisory",
        findings: [],
        evidenceRefs: [],
        producedBy: {
          kind: "deterministic",
          ref: "eval.fixture"
        }
      };
    },
    async recordEvidence(_runId, record) {
      return record;
    },
    async recordArtifact(_runId, record) {
      return {
        ...record,
        metadata: record.metadata ?? {},
        redactionPolicy: record.redactionPolicy ?? "operator",
        importantClaims: record.importantClaims ?? []
      };
    },
    async evaluateGate() {
      return {
        verdict: {
          gateId: "gate-1",
          phase: "intake",
          status: "pass",
          severity: "advisory",
          reasons: [],
          findings: [],
          evidenceRefs: [],
          obligations: [],
          evaluatedAt: "2026-05-29T00:00:00.000Z",
          evaluator: {
            kind: "deterministic",
            ref: "gate.fixture"
          },
          decisionHash: "sha256:gate"
        },
        instruction: {
          kind: "continue"
        }
      };
    },
    async generateReport(runId) {
      return {
        runId,
        summaryPath: `/tmp/${runId}/summary.md`,
        markdown: "# Run Summary\n",
        missingInputs: []
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
): Awaited<ReturnType<RuntimeApi["startRun"]>> {
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
): Awaited<ReturnType<RuntimeApi["getRun"]>> {
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
    sequence?: number;
  } = {}
): Awaited<ReturnType<RuntimeApi["getEvents"]>>[number] {
  return {
    id: overrides.id ?? "event-1",
    runId: overrides.runId ?? "run-test",
    type: "run.started",
    timestamp: "2026-05-29T00:00:00.000Z",
    sequence: overrides.sequence ?? 0,
    traceId: "trace-1",
    payload: {
      budgets: {},
      harness: {
        id: "default",
        specHash: "sha256:harness-fixture",
        version: "1.0.0"
      },
      initialPhase: "intake",
      input: validRunInput()
    }
  };
}

function stripHost(value: unknown) {
  const parsed = structuredClone(value) as {
    host?: unknown;
    metadata?: unknown;
  };

  delete parsed.host;
  delete parsed.metadata;
  return parsed;
}
