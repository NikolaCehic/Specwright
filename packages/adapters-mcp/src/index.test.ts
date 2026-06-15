import { describe, expect, test } from "bun:test";
import { executeCli, type CliRuntime } from "@specwright/adapters-cli";
import type { RuntimeApi } from "@specwright/runtime";
import { projectRunState } from "@specwright/run-store";
import {
  applyEgressRedaction,
  AuthorizationContextSchema,
  ClientPrincipalSchema,
  createMcpAdapter,
  defaultMcpCatalog,
  defaultMcpPromptCatalog,
  defaultMcpResourceCatalog,
  McpCatalogError,
  RedactionClassBoundarySchema,
  SubjectClaimSchema,
  SubjectEntitlementsSchema,
  mcpPromptBindings,
  mcpResourceBindings,
  mcpToolBindings,
  registerMcpCatalog,
  registerMcpTool,
  RuntimeActionDescriptorSchema,
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

  test("callTool success preserves provenance while redacting restricted output", async () => {
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
    expect(result.content[0].json).not.toBe(runtimeResult);
    expect((result.result as typeof runtimeResult).provenance).toBe(provenance);
    expect((result.result as typeof runtimeResult).provenance).toEqual(provenance);
    expect((result.result as typeof runtimeResult).output).toMatch(/^sha256:/);
    expect(JSON.stringify(result)).not.toContain('"ok":true');
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
      expect(response.content[0].json).not.toBe(outcome.result);
      expect(response.content[0].json).toMatchObject({
        toolCallId: outcome.result.toolCallId,
        status: outcome.result.status,
        provenance: outcome.result.provenance
      });

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

  test("resources/list and prompts/list return deterministic closed catalogs without runtime calls", () => {
    const { runtime, calls } = countedRuntime();
    const adapter = createMcpAdapter(runtime);
    const firstResources = adapter.resources.list();
    const secondResources = adapter.resources.list();
    const firstPrompts = adapter.prompts.list();
    const secondPrompts = adapter.prompts.list();

    expect(firstResources).toEqual(secondResources);
    expect(JSON.stringify(firstResources)).toBe(JSON.stringify(secondResources));
    expect(firstResources.resources.map((resource) => resource.uriTemplate)).toEqual(
      mcpResourceBindings.map((binding) => binding.uriTemplate)
    );
    expect(
      firstResources.resources.every(
        (resource) =>
          resource.mimeType === "application/json" &&
          resource.metadata.authorityClass.length > 0 &&
          resource.metadata.projection.length > 0
      )
    ).toBe(true);
    expect(firstPrompts).toEqual(secondPrompts);
    expect(JSON.stringify(firstPrompts)).toBe(JSON.stringify(secondPrompts));
    expect(firstPrompts.prompts.map((prompt) => prompt.name)).toEqual(
      mcpPromptBindings.map((binding) => binding.name)
    );
    expect(defaultMcpResourceCatalog.bindings).toHaveLength(8);
    expect(defaultMcpPromptCatalog.bindings).toHaveLength(3);
    expect(calls).toEqual([]);
  });

  test("resources/read state equals projectRunState and repeated canonical reads are byte-identical", async () => {
    const runId = "run-resource-state";
    const events = packet02Events(runId);
    const expectedState = projectRunState(events);
    const calls: unknown[] = [];
    const adapter = createMcpAdapter(
      fakeRuntime({
        async getRun(readRunId, options) {
          calls.push(["getRun", readRunId, options]);
          return expectedState;
        }
      })
    );

    const first = await adapter.resources.read({
      uri: `specwright://runs/${runId}/state`,
      options: {
        rootDir: "/runs-root"
      }
    });
    const second = await adapter.resources.read({
      uri: `specwright://runs/${runId}/state`,
      options: {
        rootDir: "/runs-root"
      }
    });

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);

    if (!first.isError && !second.isError) {
      expect(first.payload).toEqual(expectedState);
      expect(first.contents[0].text).toBe(canonicalJson(expectedState));
      expect(first.contents[0].text).toBe(second.contents[0].text);
      expect(first.metadata.lastEventId).toBe("event-4");
      expect(first.metadata.authorityClass).toBe("derived projection");
      expect(first.metadata.runtimeRead).toBe("getRun");
    }

    expect(calls).toEqual([
      ["getRun", runId, { rootDir: "/runs-root" }],
      ["getRun", runId, { rootDir: "/runs-root" }]
    ]);
  });

  test("resources/write is unregistered and performs zero runtime calls", async () => {
    const { runtime, calls } = countedRuntime();
    const response = await createMcpAdapter(runtime).dispatch({
      method: "resources/write",
      params: {
        uri: "specwright://runs/run-1/state",
        payload: {
          status: "completed"
        }
      }
    });

    expect(response).toMatchObject({
      isError: true,
      error: {
        code: "method_not_found"
      }
    });
    expect(calls).toEqual([]);
  });

  test("every prompts/get output validates as a runtime action descriptor with zero runtime calls", () => {
    const { runtime, calls } = countedRuntime();
    const adapter = createMcpAdapter(runtime);
    const enabledToolNames = new Set(
      defaultMcpCatalog.enabledBindings.map((binding) => binding.name)
    );
    const magicNames = [
      "generate_entire_app",
      "make_design_better",
      "fix_everything",
      "create_contract_magically"
    ];

    for (const prompt of mcpPromptBindings) {
      const response = adapter.prompts.get({
        name: prompt.name
      });

      expect(response.isError).toBe(false);

      if (!response.isError) {
        const descriptor = RuntimeActionDescriptorSchema.parse(response.action);

        expect(enabledToolNames.has(descriptor.tool)).toBe(true);
        expect(magicNames).not.toContain(descriptor.tool);
        expect(JSON.stringify(descriptor)).not.toContain("capabilityExecution");
        expect(containsInlineExecutionKey(descriptor.arguments)).toBe(false);
      }
    }

    const unknown = adapter.prompts.get({
      name: "specwright_fix_everything"
    });

    expect(unknown).toMatchObject({
      isError: true,
      error: {
        code: "method_not_found"
      }
    });
    expect(calls).toEqual([]);
  });

  test("trust labels survive evidence, eval, and artifact resource serialization", async () => {
    const runId = "run-trust-labels";
    const events = packet02Events(runId);
    const adapter = createMcpAdapter(
      fakeRuntime({
        async getEvents() {
          return events;
        },
        async replay() {
          return {
            state: projectRunState(events),
            events
          };
        }
      })
    );

    const evidence = await adapter.resources.read({
      uri: `specwright://runs/${runId}/evidence`
    });
    const evals = await adapter.resources.read({
      uri: `specwright://runs/${runId}/evals`
    });
    const artifact = await adapter.resources.read({
      uri: `specwright://runs/${runId}/artifacts/artifact-1`
    });

    expect(evidence.isError).toBe(false);
    expect(evals.isError).toBe(false);
    expect(artifact.isError).toBe(false);

    if (!evidence.isError && !evals.isError && !artifact.isError) {
      expect(evidence.payload).toMatchObject([
        {
          class: "source_fact",
          confidence: "high",
          authority: "repo"
        }
      ]);
      expect(evidence.contents[0].text).toContain('"class":"source_fact"');
      expect(evidence.contents[0].text).toContain('"authority":"repo"');

      expect(evals.payload).toMatchObject([
        {
          findings: [
            {
              metadata: {
                claimLevel: "inference",
                confidence: "medium",
                sourceAuthority: "model"
              }
            }
          ]
        }
      ]);
      expect(evals.contents[0].text).toContain('"claimLevel":"inference"');
      expect(evals.contents[0].text).toContain('"sourceAuthority":"model"');

      expect(artifact.payload).toMatchObject({
        claimLevel: "inference",
        importantClaims: [
          {
            claimLevel: "inference",
            confidence: "medium",
            authority: "model",
            metadata: {
              sourceAuthority: "model"
            }
          }
        ]
      });
      expect(artifact.contents[0].text).toContain('"importantClaims"');
      expect(artifact.contents[0].text).toContain('"authority":"model"');
    }
  });

  test("each successful resource read performs exactly one read operation and no mutation", async () => {
    const runId = "run-one-read";
    const events = packet02Events(runId);
    const cases = [
      [`specwright://runs/${runId}/state`, "getRun"],
      [`specwright://runs/${runId}/events`, "getEvents"],
      [`specwright://runs/${runId}/artifacts/artifact-1`, "getEvents"],
      [`specwright://runs/${runId}/evidence`, "getEvents"],
      [`specwright://runs/${runId}/evals`, "replay"],
      [`specwright://runs/${runId}/trace`, "getEvents"],
      [`specwright://runs/${runId}/report`, "generateReport"]
    ] as const;

    for (const [uri, expectedOperation] of cases) {
      const { runtime, calls } = countedRuntime({
        async getRun() {
          return projectRunState(events);
        },
        async getEvents() {
          return events;
        },
        async replay() {
          return {
            state: projectRunState(events),
            events
          };
        },
        async generateReport() {
          return fakeReport(runId);
        }
      });
      const response = await createMcpAdapter(runtime).resources.read({ uri });

      expect(response.isError, uri).toBe(false);
      expect(calls, uri).toEqual([expectedOperation]);

      if (!response.isError && ["state", "events", "evals", "trace"].some((leaf) => uri.endsWith(`/${leaf}`))) {
        expect(response.metadata.lastEventId, uri).toBe("event-4");
      }

      if (!response.isError && ["events", "evals", "trace"].some((leaf) => uri.endsWith(`/${leaf}`))) {
        expect(response.metadata.lastEventSequence, uri).toBe(3);
      }
    }

    const { runtime, calls } = countedRuntime();
    const harness = await createMcpAdapter(runtime).resources.read({
      uri: "specwright://harnesses/frontend-contract/spec"
    });

    expect(harness).toMatchObject({
      isError: true,
      error: {
        code: "invalid_request"
      }
    });
    expect(calls).toEqual([]);
  });

  test("malformed or unknown resource URIs and invalid payloads fail closed", async () => {
    const { runtime, calls } = countedRuntime();
    const adapter = createMcpAdapter(runtime);
    const badUris = [
      "http://runs/run-1/state",
      "specwright://",
      "specwright://runs//state",
      "specwright://runs/run-1/state/extra",
      "specwright://runs/run-1/not-a-resource",
      "specwright://runs/run-1/state?write=true"
    ];

    for (const uri of badUris) {
      const response = await adapter.resources.read({ uri });

      expect(response).toMatchObject({
        isError: true
      });
    }

    expect(calls).toEqual([]);

    const invalidCalls: string[] = [];
    const invalidPayload = await createMcpAdapter(
      fakeRuntime({
        async getRun() {
          invalidCalls.push("getRun");
          return {
            invalid: true
          } as Awaited<ReturnType<RuntimeApi["getRun"]>>;
        }
      })
    ).resources.read({
      uri: "specwright://runs/run-invalid/state"
    });

    expect(invalidPayload).toMatchObject({
      isError: true,
      error: {
        code: "invalid_request"
      }
    });
    expect(invalidCalls).toEqual(["getRun"]);
  });

  test("redaction seam is invoked once for every successful resource read", async () => {
    const runId = "run-redaction-seam";
    const events = packet02Events(runId);
    const invocations: unknown[] = [];
    const adapter = createMcpAdapter(
      fakeRuntime({
        async getRun() {
          return projectRunState(events);
        },
        async getEvents() {
          return events;
        },
        async replay() {
          return {
            state: projectRunState(events),
            events
          };
        },
        async generateReport() {
          return fakeReport(runId);
        }
      }),
      {
        applyEgressRedaction(payload, context) {
          invocations.push({
            uri: context.uri,
            template: context.resource?.uriTemplate,
            classes: context.classes,
            payload
          });
          return payload;
        }
      }
    );
    const uris = [
      `specwright://runs/${runId}/state`,
      `specwright://runs/${runId}/events`,
      `specwright://runs/${runId}/artifacts/artifact-1`,
      `specwright://runs/${runId}/evidence`,
      `specwright://runs/${runId}/evals`,
      `specwright://runs/${runId}/trace`,
      `specwright://runs/${runId}/report`
    ];

    for (const uri of uris) {
      const response = await adapter.resources.read({ uri });

      expect(response.isError, uri).toBe(false);
    }

    expect(invocations).toHaveLength(uris.length);
    expect(invocations.map((item) => (item as { uri: string }).uri)).toEqual(uris);
  });

  test("strict Packet 03 boundary schemas reject unknown auth and redaction fields", () => {
    expect(
      ClientPrincipalSchema.safeParse({
        clientId: "client-1",
        tenantId: "tenant-a",
        grantedScopes: ["run:read"],
        runMode: "assisted",
        extra: true
      }).success
    ).toBe(false);
    expect(
      SubjectClaimSchema.safeParse({
        subjectId: "subject-1",
        tenantId: "tenant-a",
        injectedScope: "run:write"
      }).success
    ).toBe(false);
    expect(
      SubjectEntitlementsSchema.safeParse({
        subjectId: "subject-1",
        tenantId: "tenant-a",
        scopes: ["run:read"],
        hiddenToken: "tok-secret"
      }).success
    ).toBe(false);
    expect(
      AuthorizationContextSchema.safeParse({
        clientPrincipal: securePrincipal(["run:read"]),
        requestedScopes: ["run:read"],
        effectiveScopes: ["run:read"],
        toolContext: {
          runMode: "assisted",
          snapshots: {
            sourceTrust: {}
          },
          ambientToken: "tok-secret"
        }
      }).success
    ).toBe(false);
    expect(RedactionClassBoundarySchema.safeParse("public").success).toBe(false);
  });

  test("secure tools/list rejects missing and invalid credentials before authority is exposed", () => {
    const adapter = createMcpAdapter(fakeRuntime(), {
      auth: secureAuth()
    });

    const missing = adapter.tools.list();
    const invalid = adapter.tools.list({
      credential: "invalid"
    });

    expect(missing).toMatchObject({
      isError: true,
      error: {
        contractId: "specwright.mcp.error.v1",
        code: "unauthenticated",
        retryable: false
      },
      tools: []
    });
    expect(invalid).toMatchObject({
      isError: true,
      error: {
        code: "unauthenticated"
      },
      tools: []
    });
  });

  test("malformed and unverifiable subject claims fail closed with zero runtime calls", async () => {
    const { runtime, calls } = countedRuntime();
    const malformed = await createMcpAdapter(runtime, {
      auth: secureAuth()
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(),
      credential: "valid",
      subject: {
        subjectId: "subject-1",
        tenantId: "tenant-a",
        extra: "not allowed"
      }
    });
    const unverifiable = await createMcpAdapter(runtime, {
      auth: secureAuth({
        subjectVerifier() {
          return false;
        }
      })
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(),
      credential: "valid",
      subject: validSubjectClaim()
    });

    expect(malformed).toMatchObject({
      isError: true,
      error: {
        code: "subject_unverifiable"
      }
    });
    expect(unverifiable).toMatchObject({
      isError: true,
      error: {
        code: "subject_unverifiable"
      }
    });
    expect(calls).toEqual([]);
  });

  test("client and subject scope overreach deny before runtime", async () => {
    const clientLimited = countedRuntime();
    const clientDenied = await createMcpAdapter(clientLimited.runtime, {
      auth: secureAuth({
        principal: securePrincipal(["tool:call"]),
        entitlements: secureEntitlements(["tool:call", "workspace:read"])
      })
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(),
      credential: "valid",
      subject: validSubjectClaim(),
      requestedScopes: ["workspace:read"]
    });
    const subjectLimited = countedRuntime();
    const subjectDenied = await createMcpAdapter(subjectLimited.runtime, {
      auth: secureAuth({
        principal: securePrincipal(["tool:call", "workspace:read"]),
        entitlements: secureEntitlements(["tool:call"])
      })
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(),
      credential: "valid",
      subject: validSubjectClaim(),
      requestedScopes: ["workspace:read"]
    });

    expect(clientDenied).toMatchObject({
      isError: true,
      error: {
        code: "scope_exceeded"
      }
    });
    expect(subjectDenied).toMatchObject({
      isError: true,
      error: {
        code: "scope_exceeded"
      }
    });
    expect(clientLimited.calls).toEqual([]);
    expect(subjectLimited.calls).toEqual([]);
  });

  test("runtime policy denial and approval_required are surfaced without laundering", async () => {
    const deniedRuntimeCalls: unknown[] = [];
    const denied = await createMcpAdapter(
      fakeRuntime({
        async callTool(runId, request, options) {
          deniedRuntimeCalls.push([runId, request, options]);
          return toolResult({
            status: "denied",
            code: "policy_error",
            message: "Policy engine failed closed."
          });
        }
      }),
      {
        auth: secureAuth()
      }
    ).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(),
      credential: "valid",
      subject: validSubjectClaim()
    });
    const approval = await createMcpAdapter(
      fakeRuntime({
        async callTool() {
          return toolResult({
            status: "approval_required",
            code: "approval_required",
            message: "Needs a human decision.",
            approvalId: "approval-1"
          });
        }
      }),
      {
        auth: secureAuth()
      }
    ).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(),
      credential: "valid",
      subject: validSubjectClaim()
    });

    expect(denied).toMatchObject({
      isError: true,
      error: {
        code: "policy_error"
      }
    });
    expect(approval).toMatchObject({
      isError: true,
      error: {
        code: "approval_required",
        approvalId: "approval-1"
      }
    });
    expect(deniedRuntimeCalls).toHaveLength(1);
  });

  test("secure callTool binds composed principal context and strips caller toolContext tokens", async () => {
    const calls: unknown[] = [];
    const adapter = createMcpAdapter(
      fakeRuntime({
        async callTool(runId, request, options) {
          calls.push([runId, request, options]);
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
        }
      }),
      {
        auth: secureAuth()
      }
    );

    const response = await adapter.tools.call({
      name: "specwright_call_tool",
      arguments: {
        ...validToolCallArguments(),
        options: {
          rootDir: "/runs-root",
          cwd: "/workspace",
          traceId: "trace-1",
          toolContext: {
            token: "tok-client-secret",
            runMode: "autonomous"
          }
        }
      },
      credential: "valid",
      subject: validSubjectClaim(),
      requestedScopes: ["workspace:read"]
    });

    expect(response.isError).toBe(false);
    expect(calls).toHaveLength(1);

    const options = (calls[0] as unknown[])[2] as Record<string, unknown>;
    const toolContext = options.toolContext as Record<string, unknown>;

    expect(options).toMatchObject({
      rootDir: "/runs-root",
      cwd: "/workspace",
      traceId: "trace-1"
    });
    expect(toolContext.runMode).toBe("assisted");
    expect(JSON.stringify(toolContext)).not.toContain("tok-client-secret");
    expect(JSON.stringify(toolContext)).not.toContain("credential");
    expect(toolContext.snapshots).toMatchObject({
      sourceTrust: {
        mcp: {
          clientId: "client-1",
          tenantId: "tenant-a",
          subjectId: "subject-1",
          requestedScopes: ["tool:call", "workspace:read"],
          effectiveScopes: expect.arrayContaining(["tool:call", "workspace:read"])
        }
      }
    });
  });

  test("tenant resolver denies cross-tenant resources without runtime lookup", async () => {
    const { runtime, calls } = countedRuntime();
    const response = await createMcpAdapter(runtime, {
      auth: secureAuth({
        tenantResolver() {
          return "tenant-b";
        }
      })
    }).resources.read({
      uri: "specwright://runs/run-other-tenant/state",
      credential: "valid",
      subject: validSubjectClaim()
    });

    expect(response).toMatchObject({
      isError: true,
      error: {
        code: "tenant_mismatch"
      }
    });
    expect(JSON.stringify(response)).not.toContain("run-other-tenant");
    expect(calls).toEqual([]);
  });

  test("default egress redaction hashes restricted nested values and preserves trust labels", () => {
    const payload = {
      authority: "repo",
      claimLevel: "source_fact",
      evidenceRefs: ["evidence-1"],
      generatedStatus: "generated",
      externalOrigin: "external-mcp",
      provenance: {
        toolId: "fs.read",
        decisionHash: "sha256:decision",
        traceId: "trace-1"
      },
      sourceRefs: [
        {
          uri: "file:///Users/nikolacehic/secret.md",
          authority: "repo",
          redactionClass: "secret"
        }
      ],
      content: {
        public: "ok",
        apiToken: "tok-raw-secret",
        nested: [
          {
            value: "restricted raw value",
            redactionPolicy: {
              value: "restricted"
            }
          }
        ]
      }
    };

    const first = applyEgressRedaction(payload, {
      surface: "tool_result",
      classes: ["ToolCallResultSchema"]
    });
    const second = applyEgressRedaction(payload, {
      surface: "tool_result",
      classes: ["ToolCallResultSchema"]
    });
    const text = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(text).toContain('"authority":"repo"');
    expect(text).toContain('"claimLevel":"source_fact"');
    expect(text).toContain('"evidenceRefs":["evidence-1"]');
    expect(text).toContain('"generatedStatus":"generated"');
    expect(text).toContain('"externalOrigin":"external-mcp"');
    expect(text).toContain('"decisionHash":"sha256:decision"');
    expect(text).not.toContain("tok-raw-secret");
    expect(text).not.toContain("restricted raw value");
    expect(text).not.toContain("/Users/nikolacehic/secret.md");
    expect(text.match(/sha256:/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("contract egress paths hash restricted non-secret runtime and prompt fields", () => {
    const payload = {
      payload: {
        request: {
          args: {
            customerNote: "internal roadmap",
            nested: [
              {
                summary: "restricted but non-secret"
              }
            ]
          }
        },
        result: {
          output: {
            summary: "restricted but non-secret",
            nested: [
              {
                customerNote: "internal roadmap"
              }
            ]
          },
          provenance: {
            decisionHash: "sha256:decision"
          }
        }
      },
      request: {
        args: {
          customerNote: "internal roadmap"
        }
      },
      result: {
        output: {
          summary: "restricted but non-secret"
        }
      },
      action: {
        tool: "specwright_start_run",
        arguments: {
          task: "internal roadmap",
          nested: {
            summary: "restricted but non-secret"
          }
        },
        mutates: true
      },
      content: [
        {
          type: "json",
          json: {
            payload: {
              request: {
                args: {
                  customerNote: "internal roadmap"
                }
              },
              result: {
                output: {
                  summary: "restricted but non-secret"
                }
              }
            },
            action: {
              arguments: {
                task: "internal roadmap"
              }
            },
            error: {
              message: "restricted but non-secret"
            }
          }
        }
      ],
      provenance: {
        decisionHash: "sha256:decision"
      }
    };

    const first = applyEgressRedaction(payload, {
      surface: "prompt",
      classes: ["RuntimeEventSchema", "ToolCallResultSchema", "Prompt", "Error"]
    });
    const second = applyEgressRedaction(payload, {
      surface: "prompt",
      classes: ["RuntimeEventSchema", "ToolCallResultSchema", "Prompt", "Error"]
    });
    const text = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(text).not.toContain("internal roadmap");
    expect(text).not.toContain("restricted but non-secret");
    expect(text).toContain('"decisionHash":"sha256:decision"');
    expect(text.match(/sha256:/g)?.length).toBeGreaterThanOrEqual(8);
    expect((first as { action: { arguments: unknown } }).action.arguments).toEqual({
      task: expect.stringMatching(/^sha256:/),
      nested: {
        summary: expect.stringMatching(/^sha256:/)
      }
    });
  });

  test("resource event egress hashes payload request args and result output without inline metadata", async () => {
    const runId = "run-contract-redaction";
    const events = [
      fakeEvent({
        runId,
        id: "event-1",
        sequence: 0
      }),
      {
        id: "event-2",
        runId,
        type: "tool.completed",
        timestamp: "2026-05-29T00:00:01.000Z",
        sequence: 1,
        traceId: "trace-1",
        payload: {
          request: {
            toolId: "crm.read",
            args: {
              customerNote: "internal roadmap",
              nested: [
                {
                  summary: "restricted but non-secret"
                }
              ]
            },
            reason: "Read customer note.",
            idempotencyKey: "idem-redaction",
            requestedBy: {
              phase: "intake"
            }
          },
          result: {
            toolCallId: "tool-call-redaction",
            status: "success",
            output: {
              summary: "restricted but non-secret",
              nested: [
                {
                  customerNote: "internal roadmap"
                }
              ]
            },
            provenance: {
              toolId: "crm.read",
              toolVersion: "0.1.0",
              argsHash: "sha256:args",
              resultHash: "sha256:result",
              cacheStatus: "miss",
              traceId: "trace-1",
              adapterVersion: "0.1.0",
              decisionHash: "sha256:decision"
            }
          }
        }
      }
    ] satisfies Awaited<ReturnType<RuntimeApi["getEvents"]>>;
    const response = await createMcpAdapter(
      fakeRuntime({
        async getEvents() {
          return events;
        }
      })
    ).resources.read({
      uri: `specwright://runs/${runId}/events`
    });
    const text = JSON.stringify(response);

    expect(response.isError).toBe(false);
    expect(text).not.toContain("internal roadmap");
    expect(text).not.toContain("restricted but non-secret");
    expect(text).toContain('"decisionHash":"sha256:decision"');
    expect(text).toContain('"args":"sha256:');
    expect(text).toContain('"output":"sha256:');
  });

  test("secure runtime throws use safe error contract without secrets, paths, or stacks", async () => {
    const response = await createMcpAdapter(
      fakeRuntime({
        async startRun() {
          throw new Error(
            "boom secret=super-secret at /Users/nikolacehic/private/file.txt\n    at Runtime.start (/Users/nikolacehic/private/runtime.ts:1:1)"
          );
        }
      }),
      {
        auth: secureAuth({
          principal: securePrincipal(["run:start"]),
          entitlements: secureEntitlements(["run:start"])
        })
      }
    ).tools.call({
      name: "specwright_start_run",
      arguments: validRunInput(),
      credential: "valid",
      subject: validSubjectClaim()
    });
    const text = JSON.stringify(response);

    expect(response).toMatchObject({
      isError: true,
      error: {
        contractId: "specwright.mcp.error.v1",
        code: "invalid_request",
        retryable: false
      }
    });
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("/Users/nikolacehic");
    expect(text).not.toContain("Runtime.start");
    expect(text).toContain("sha256:");
  });

  test("prompt egress uses the redaction chokepoint in secure mode", () => {
    const invocations: string[] = [];
    const adapter = createMcpAdapter(fakeRuntime(), {
      auth: secureAuth({
        principal: securePrincipal(["run:start"]),
        entitlements: secureEntitlements(["run:start"])
      }),
      applyEgressRedaction(payload, context) {
        invocations.push(context.surface);
        return payload;
      }
    });
    const response = adapter.prompts.get({
      name: "specwright_start_frontend_contract",
      credential: "valid"
    });

    expect(response.isError).toBe(false);
    expect(invocations).toEqual(["prompt"]);
  });
});

function secureAuth(
  overrides: {
    principal?: ReturnType<typeof securePrincipal> | undefined;
    entitlements?: ReturnType<typeof secureEntitlements> | undefined;
    subjectVerifier?:
      | ((claim: ReturnType<typeof validSubjectClaim>) => unknown)
      | undefined;
    tenantResolver?: (() => string | undefined) | undefined;
  } = {}
) {
  return {
    mode: "authenticated" as const,
    credentialVerifier(credential: unknown) {
      if (credential !== "valid") {
        throw new Error("invalid credential");
      }

      return overrides.principal ?? securePrincipal();
    },
    subjectVerifier(claim: ReturnType<typeof validSubjectClaim>) {
      if (overrides.subjectVerifier !== undefined) {
        return overrides.subjectVerifier(claim);
      }

      if (claim.subjectId !== "subject-1") {
        return false;
      }

      return overrides.entitlements ?? secureEntitlements();
    },
    ...(overrides.tenantResolver === undefined
      ? {}
      : {
          tenantResolver: overrides.tenantResolver
        })
  };
}

function securePrincipal(scopes: readonly string[] = allSecureScopes()) {
  return {
    clientId: "client-1",
    tenantId: "tenant-a",
    grantedScopes: [...scopes],
    runMode: "assisted" as const
  };
}

function secureEntitlements(scopes: readonly string[] = allSecureScopes()) {
  return {
    subjectId: "subject-1",
    tenantId: "tenant-a",
    scopes: [...scopes],
    sourceTrust: {
      subjectAuthority: "idp.fixture"
    }
  };
}

function validSubjectClaim() {
  return {
    subjectId: "subject-1",
    tenantId: "tenant-a",
    claimRef: "claim-1",
    issuedBy: "idp.fixture"
  };
}

function allSecureScopes() {
  return [
    "artifact:write",
    "eval:run",
    "evidence:write",
    "gate:evaluate",
    "harness:read",
    "report:read",
    "report:write",
    "run:read",
    "run:start",
    "tool:call",
    "workspace:read"
  ];
}

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
      evalsDir: `/workspace/.specwright/runs/${runId}/evals`,
      summaryPath: `/workspace/.specwright/runs/${runId}/summary.md`
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

function countedRuntime(overrides: Partial<RuntimeApi> = {}) {
  const calls: string[] = [];
  const base = fakeRuntime();

  return {
    calls,
    runtime: {
      async startRun(...args: Parameters<RuntimeApi["startRun"]>) {
        calls.push("startRun");
        return (overrides.startRun ?? base.startRun)(...args);
      },
      async getRun(...args: Parameters<RuntimeApi["getRun"]>) {
        calls.push("getRun");
        return (overrides.getRun ?? base.getRun)(...args);
      },
      async getEvents(...args: Parameters<RuntimeApi["getEvents"]>) {
        calls.push("getEvents");
        return (overrides.getEvents ?? base.getEvents)(...args);
      },
      async replay(...args: Parameters<RuntimeApi["replay"]>) {
        calls.push("replay");
        return (overrides.replay ?? base.replay)(...args);
      },
      async callTool(...args: Parameters<RuntimeApi["callTool"]>) {
        calls.push("callTool");
        return (overrides.callTool ?? base.callTool)(...args);
      },
      async runEval(...args: Parameters<RuntimeApi["runEval"]>) {
        calls.push("runEval");
        return (overrides.runEval ?? base.runEval)(...args);
      },
      async recordEvidence(...args: Parameters<RuntimeApi["recordEvidence"]>) {
        calls.push("recordEvidence");
        return (overrides.recordEvidence ?? base.recordEvidence)(...args);
      },
      async recordArtifact(...args: Parameters<RuntimeApi["recordArtifact"]>) {
        calls.push("recordArtifact");
        return (overrides.recordArtifact ?? base.recordArtifact)(...args);
      },
      async evaluateGate(...args: Parameters<RuntimeApi["evaluateGate"]>) {
        calls.push("evaluateGate");
        return (overrides.evaluateGate ?? base.evaluateGate)(...args);
      },
      async generateReport(...args: Parameters<RuntimeApi["generateReport"]>) {
        calls.push("generateReport");
        return (overrides.generateReport ?? base.generateReport)(...args);
      },
      async writeRunReport(...args: Parameters<RuntimeApi["writeRunReport"]>) {
        calls.push("writeRunReport");
        return (overrides.writeRunReport ?? base.writeRunReport)(...args);
      }
    } satisfies RuntimeApi
  };
}

function packet02Events(
  runId: string
): Awaited<ReturnType<RuntimeApi["getEvents"]>> {
  return [
    fakeEvent({
      runId,
      id: "event-1",
      sequence: 0
    }),
    {
      id: "event-2",
      runId,
      type: "evidence.recorded",
      timestamp: "2026-05-29T00:00:01.000Z",
      sequence: 1,
      traceId: "trace-1",
      payload: {
        evidence: packet02Evidence()
      }
    },
    {
      id: "event-3",
      runId,
      type: "eval.completed",
      timestamp: "2026-05-29T00:00:02.000Z",
      sequence: 2,
      traceId: "trace-1",
      payload: {
        evalId: "eval-1",
        verdict: packet02EvalVerdict()
      }
    },
    {
      id: "event-4",
      runId,
      type: "tool.completed",
      timestamp: "2026-05-29T00:00:03.000Z",
      sequence: 3,
      traceId: "trace-1",
      payload: {
        request: {
          toolId: "artifact.emit",
          args: {
            artifactId: "artifact-1"
          },
          reason: "Emit artifact for resource projection.",
          idempotencyKey: "artifact-1",
          requestedBy: {
            phase: "implementation"
          }
        },
        result: {
          toolCallId: "tool-call-artifact",
          status: "success",
          output: {
            artifact: packet02Artifact()
          },
          provenance: {
            toolId: "artifact.emit",
            toolVersion: "0.1.0",
            argsHash: "sha256:artifact-args",
            resultHash: "sha256:artifact-result",
            cacheStatus: "miss",
            traceId: "trace-1",
            adapterVersion: "0.1.0",
            decisionHash: "sha256:artifact-decision"
          }
        }
      }
    }
  ];
}

function packet02Evidence() {
  return {
    id: "evidence-1",
    class: "source_fact" as const,
    claim: "The contract source includes Packet 02 resource requirements.",
    sourceRefs: [
      {
        uri: "file://packet-02.md",
        authority: "repo" as const,
        redactionClass: "operator" as const
      }
    ],
    confidence: "high" as const,
    authority: "repo" as const,
    createdBy: {
      phase: "implementation",
      actionId: "packet-02-fixture"
    },
    redactionPolicy: "operator" as const,
    metadata: {
      sourceAuthority: "repo",
      claimLevel: "source_fact"
    }
  };
}

function packet02EvalVerdict() {
  return {
    evalId: "eval-1",
    targetRef: "artifact:artifact-1",
    status: "fail" as const,
    severity: "advisory" as const,
    findings: [
      {
        id: "finding-1",
        message: "Artifact requires follow-up review.",
        severity: "advisory" as const,
        metadata: {
          claimLevel: "inference",
          confidence: "medium",
          sourceAuthority: "model"
        }
      }
    ],
    evidenceRefs: ["evidence-1"],
    producedBy: {
      kind: "deterministic" as const,
      ref: "packet-02-eval"
    },
    provenance: {
      runId: "run-trust-labels",
      phase: "implementation",
      evaluatedAt: "2026-05-29T00:00:02.000Z",
      decisionHash: "sha256:eval-decision",
      traceId: "trace-1"
    }
  };
}

function packet02Artifact() {
  return {
    artifactId: "artifact-1",
    artifactType: "plan" as const,
    content: {
      summary: "Packet 02 artifact projection."
    },
    evidenceRefs: ["evidence-1"],
    claimLevel: "inference" as const,
    importantClaims: [
      {
        claim: "The artifact is a projected runtime-owned record.",
        claimLevel: "inference" as const,
        evidenceRefs: ["evidence-1"],
        confidence: "medium" as const,
        authority: "model" as const,
        owningArtifactId: "artifact-1",
        fieldPath: "content.summary",
        verificationStatus: "unverified" as const,
        redactionPolicy: "operator" as const,
        metadata: {
          sourceAuthority: "model"
        }
      }
    ],
    producedBy: {
      phase: "implementation",
      actionId: "tool-call-artifact"
    },
    redactionPolicy: "operator" as const,
    metadata: {
      sourceAuthority: "model"
    }
  };
}

function fakeReport(
  runId: string
): Awaited<ReturnType<RuntimeApi["generateReport"]>> {
  return {
    runId,
    summaryPath: `/tmp/${runId}/summary.md`,
    markdown: `# ${runId}\n`,
    missingInputs: []
  };
}

function canonicalJson(value: unknown) {
  const text = JSON.stringify(canonicalJsonValue(value));

  if (text === undefined) {
    throw new Error("Value is not JSON serializable.");
  }

  return text;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    value instanceof Date
  ) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(record).sort()) {
    const child = record[key];

    if (child !== undefined) {
      output[key] = canonicalJsonValue(child);
    }
  }

  return output;
}

function containsInlineExecutionKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsInlineExecutionKey);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "execute" ||
      key === "executor" ||
      key === "runtimeOperation" ||
      key === "capabilityExecution"
    ) {
      return true;
    }

    if (containsInlineExecutionKey(child)) {
      return true;
    }
  }

  return false;
}
