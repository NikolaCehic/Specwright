import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { evaluatePolicy } from "@specwright/policy-engine";
import type {
  FixturePolicyBundle,
  PolicyRequest,
  PolicyVerdict
} from "@specwright/policy-engine";
import { ToolCallResultSchema } from "@specwright/schemas";
import { z } from "zod";
import {
  TOOL_BROKER_APPROVAL_ID,
  toolBrokerAllowPolicyBundle,
  toolBrokerApprovalRequiredPolicyBundle,
  toolBrokerApprovedWithChangesDecision,
  toolBrokerDenyReadPolicyBundle,
  toolBrokerElapsedApprovalDeadlineAt,
  toolBrokerMatchingApprovalDecision,
  toolBrokerMismatchedApprovalDecision,
  toolBrokerRejectedApprovalDecision
} from "../fixtures/policy/approval";
import "./capability-registry.test";
import {
  CapabilityRegistry,
  computeLimits,
  createDefaultCapabilityRegistry,
  createToolBroker,
  FsReadInputSchema,
  FsReadOutputSchema,
  hashValue,
  isolationTierForKind,
  type AdapterExecutionResult,
  type CapabilityAdapter,
  type CapabilityDefinition
} from "./index";

const workspaceRoot = resolve(import.meta.dir, "../fixtures/workspace");

describe("tool broker filesystem capabilities", () => {
  test("fs.list is allowed and succeeds", async () => {
    const result = await broker().callTool(
      request("fs.list", { path: "." }),
      { traceId: "trace_fs_list_allowed" }
    );

    expect(result.status).toBe("success");
    expect(result.provenance.toolId).toBe("fs.list");
    expect(result.provenance.toolVersion).toBe("0.1.0");
    expect(result.provenance.argsHash.startsWith("sha256:")).toBe(true);
    expect(result.provenance.resultHash?.startsWith("sha256:")).toBe(true);
    expect(result.provenance.cacheStatus).toBe("bypass");
    expect(result.provenance.traceId).toBe("trace_fs_list_allowed");
    expect(result.output).toEqual({
      path: ".",
      entries: [
        {
          name: "docs",
          path: "docs",
          type: "directory"
        },
        {
          name: "src",
          path: "src",
          type: "directory"
        }
      ]
    });
  });

  test("fs.read is allowed and succeeds", async () => {
    const result = await broker().callTool(
      request("fs.read", { path: "src/index.ts" }),
      { traceId: "trace_fs_read_allowed" }
    );

    expect(result.status).toBe("success");
    expect(result.provenance.toolId).toBe("fs.read");
    expect(result.provenance.resultHash?.startsWith("sha256:")).toBe(true);
    expect(result.output).toEqual({
      path: "src/index.ts",
      content: 'export const sample = "Specwright";\n',
      encoding: "utf8",
      bytesRead: 36,
      truncated: false
    });
  });

  test("fs.read respects maxBytes", async () => {
    const result = await broker().callTool(
      request("fs.read", { path: "docs/readme.md", maxBytes: 10 }),
      { traceId: "trace_fs_read_truncated" }
    );

    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      path: "docs/readme.md",
      content: "# Specwrig",
      encoding: "utf8",
      bytesRead: 10,
      truncated: true
    });
  });

  test("undeclared tools are denied before policy or execution", async () => {
    const result = await broker().callTool(
      request("shell.exec", { command: "pwd" }),
      { traceId: "trace_undeclared" }
    );

    expect(result.status).toBe("denied");
    expect(result.error).toEqual({
      code: "tool_not_found",
      message: "Tool shell.exec is not declared in the capability registry.",
      retryable: false
    });
    expect(result.provenance.toolVersion).toBe("undeclared");
  });

  test("invalid input is rejected before adapter execution", async () => {
    let adapterCalls = 0;
    let policyCalls = 0;
    const fsReadAdapter: CapabilityAdapter = {
      id: "fixture/fs-read-not-called",
      version: "0.0.0",
      kind: "filesystem",
      async execute(): Promise<AdapterExecutionResult> {
        adapterCalls += 1;
        return {
          status: "success",
          output: {
            path: "src/index.ts",
            content: "",
            encoding: "utf8",
            bytesRead: 0,
            truncated: false
          }
        };
      }
    };
    const result = await broker({
      registry: createDefaultCapabilityRegistry({ fsReadAdapter }),
      policyEngine(requestToAuthorize, policyBundles) {
        policyCalls += 1;
        return evaluatePolicy(requestToAuthorize, policyBundles);
      }
    }).callTool(request("fs.read", {}), { traceId: "trace_invalid_input" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(policyCalls).toBe(0);
    expect(adapterCalls).toBe(0);
  });

  test("policy denial returns a structured denied result", async () => {
    const result = await broker({
      policyBundle: toolBrokerDenyReadPolicyBundle
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_policy_denied"
    });

    expect(result.status).toBe("denied");
    expect(result.error).toEqual({
      code: "policy_denied",
      message: "Fixture denies fs.read",
      retryable: false
    });
    expect(result.provenance.toolId).toBe("fs.read");
    expect(result.output).toBeUndefined();
  });

  test("path traversal fails safely", async () => {
    const result = await broker().callTool(
      request("fs.read", { path: "../outside.txt" }),
      { traceId: "trace_path_traversal" }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "path_outside_workspace",
      message: "Path resolves outside the configured workspace.",
      retryable: false
    });
  });

  test("missing file returns a structured failure", async () => {
    const result = await broker().callTool(
      request("fs.read", { path: "missing.txt" }),
      { traceId: "trace_missing_file" }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "not_found",
      message: "Path missing.txt does not exist.",
      retryable: false
    });
  });

  test("adapter output shape is validated", async () => {
    const fsReadAdapter: CapabilityAdapter = {
      id: "fixture/fs-read-invalid-output",
      version: "0.0.0",
      kind: "filesystem",
      async execute(): Promise<AdapterExecutionResult> {
        return {
          status: "success",
          output: {
            path: "src/index.ts",
            content: "missing required fields"
          }
        };
      }
    };
    const result = await broker({
      registry: createDefaultCapabilityRegistry({ fsReadAdapter })
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_output_invalid"
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("output_invalid");
    expect(result.output).toBeUndefined();
    expect(result.provenance.resultHash).toBeUndefined();
  });

  test("invalid request envelope stops before capability resolution", async () => {
    let resolveCalls = 0;
    class CountingRegistry extends CapabilityRegistry {
      override resolve(toolId: string) {
        resolveCalls += 1;
        return super.resolve(toolId);
      }
    }

    const result = await broker({ registry: new CountingRegistry() }).callTool(
      {
        toolId: "fs.read",
        args: { path: "src/index.ts" },
        idempotencyKey: "fixture:invalid-envelope",
        requestedBy: {
          phase: "evidence"
        }
      },
      { traceId: "trace_invalid_envelope" }
    );

    expectResultSchema(result);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(result.provenance.toolVersion).toBe("unresolved");
    expect(resolveCalls).toBe(0);
  });

  test("undeclared tools stop before policy evaluation", async () => {
    let policyCalls = 0;
    const result = await broker({
      policyEngine(requestToAuthorize, policyBundles) {
        policyCalls += 1;
        return evaluatePolicy(requestToAuthorize, policyBundles);
      }
    }).callTool(request("unknown.tool", { path: "src/index.ts" }), {
      traceId: "trace_unknown_no_policy"
    });

    expectResultSchema(result);
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("tool_not_found");
    expect(policyCalls).toBe(0);
  });

  test("policy evaluator throws fail closed with policy_error", async () => {
    let adapterCalls = 0;
    const fsReadAdapter: CapabilityAdapter = {
      id: "fixture/fs-read-policy-error-not-called",
      version: "0.0.0",
      kind: "filesystem",
      async execute(): Promise<AdapterExecutionResult> {
        adapterCalls += 1;
        return successfulReadOutput();
      }
    };
    const result = await broker({
      registry: createDefaultCapabilityRegistry({ fsReadAdapter }),
      policyEngine() {
        throw new Error("fixture policy engine failure");
      }
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_policy_error"
    });

    expectResultSchema(result);
    expect(result.status).toBe("denied");
    expect(result.error).toEqual({
      code: "policy_error",
      message: "fixture policy engine failure",
      retryable: false
    });
    expect(adapterCalls).toBe(0);
  });

  test("approval_required pauses with the responsible approvalId", async () => {
    let adapterCalls = 0;
    const result = await broker({
      registry: createDefaultCapabilityRegistry({
        fsReadAdapter: countingSuccessAdapter(() => {
          adapterCalls += 1;
        })
      }),
      policyBundle: toolBrokerApprovalRequiredPolicyBundle
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_required"
    });

    expectResultSchema(result);
    expect(result.status).toBe("approval_required");
    expect(result.error?.code).toBe("approval_required");
    expect(result.error?.message).toContain(TOOL_BROKER_APPROVAL_ID);
    expect(result.provenance.cacheStatus).toBe("bypass");
    expect(adapterCalls).toBe(0);
  });

  test("matching approved decision resumes only after policy re-evaluation allows", async () => {
    const verdictStatuses: PolicyVerdict["status"][] = [];
    const policyRequests: PolicyRequest[] = [];
    const paused = await broker({
      policyBundle: toolBrokerApprovalRequiredPolicyBundle,
      policyEngine(requestToAuthorize, policyBundles) {
        const verdict = evaluatePolicy(requestToAuthorize, policyBundles);
        verdictStatuses.push(verdict.status);
        return verdict;
      }
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_initial_pause"
    });

    expect(paused.status).toBe("approval_required");

    const resumed = await broker({
      policyBundle: toolBrokerApprovalRequiredPolicyBundle,
      policyEngine(requestToAuthorize, policyBundles) {
        policyRequests.push(requestToAuthorize);
        const verdict = evaluatePolicy(requestToAuthorize, policyBundles);
        verdictStatuses.push(verdict.status);
        return verdict;
      }
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_resume",
      snapshots: {
        approvals: [toolBrokerMatchingApprovalDecision]
      }
    });

    expectResultSchema(resumed);
    expect(resumed.status).toBe("success");
    expect(resumed.output).toEqual({
      path: "src/index.ts",
      content: 'export const sample = "Specwright";\n',
      encoding: "utf8",
      bytesRead: 36,
      truncated: false
    });
    expect(verdictStatuses).toContain("approval_required");
    expect(verdictStatuses).toContain("allow");
    expect(policyRequests[0]?.snapshots?.approvals).toEqual([
      toolBrokerMatchingApprovalDecision
    ]);
  });

  test("approved_with_changes decision resumes and narrows policy constraints", async () => {
    const result = await broker({
      policyBundle: toolBrokerApprovalRequiredPolicyBundle
    }).callTool(request("fs.read", { path: "docs/readme.md" }), {
      traceId: "trace_approved_with_changes",
      snapshots: {
        approvals: {
          decisions: [toolBrokerApprovedWithChangesDecision]
        }
      }
    });

    expectResultSchema(result);
    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      path: "docs/readme.md",
      content: "# Specwright Fixture\n\nThis fixtu",
      encoding: "utf8",
      bytesRead: 32,
      truncated: true
    });
  });

  test("mismatched approvalId remains approval_required", async () => {
    let adapterCalls = 0;
    const result = await broker({
      registry: createDefaultCapabilityRegistry({
        fsReadAdapter: countingSuccessAdapter(() => {
          adapterCalls += 1;
        })
      }),
      policyBundle: toolBrokerApprovalRequiredPolicyBundle
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_mismatched",
      snapshots: {
        approvals: [toolBrokerMismatchedApprovalDecision]
      }
    });

    expectResultSchema(result);
    expect(result.status).toBe("approval_required");
    expect(result.error?.code).toBe("approval_required");
    expect(result.error?.message).toContain(TOOL_BROKER_APPROVAL_ID);
    expect(adapterCalls).toBe(0);
  });

  test("matching rejected decision returns approval_rejected", async () => {
    let adapterCalls = 0;
    const result = await broker({
      registry: createDefaultCapabilityRegistry({
        fsReadAdapter: countingSuccessAdapter(() => {
          adapterCalls += 1;
        })
      }),
      policyBundle: toolBrokerApprovalRequiredPolicyBundle
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_rejected",
      snapshots: {
        approvals: [toolBrokerRejectedApprovalDecision]
      }
    });

    expectResultSchema(result);
    expect(result.status).toBe("denied");
    expect(result.error).toEqual({
      code: "approval_rejected",
      message: `Approval ${TOOL_BROKER_APPROVAL_ID} was rejected.`,
      retryable: false
    });
    expect(adapterCalls).toBe(0);
  });

  test("elapsed approval deadline returns approval_timeout", async () => {
    let adapterCalls = 0;
    const result = await broker({
      registry: createDefaultCapabilityRegistry({
        fsReadAdapter: countingSuccessAdapter(() => {
          adapterCalls += 1;
        })
      }),
      policyBundle: toolBrokerApprovalRequiredPolicyBundle
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_timeout",
      approvalDeadlineAt: toolBrokerElapsedApprovalDeadlineAt
    });

    expectResultSchema(result);
    expect(result.status).toBe("denied");
    expect(result.error).toEqual({
      code: "approval_timeout",
      message: `Approval ${TOOL_BROKER_APPROVAL_ID} timed out before execution.`,
      retryable: false
    });
    expect(adapterCalls).toBe(0);
  });

  test("elapsed approval deadline blocks an otherwise approved resume", async () => {
    let adapterCalls = 0;
    const result = await broker({
      registry: createDefaultCapabilityRegistry({
        fsReadAdapter: countingSuccessAdapter(() => {
          adapterCalls += 1;
        })
      }),
      policyBundle: toolBrokerApprovalRequiredPolicyBundle
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_approval_timeout_after_allow",
      approvalDeadlineAt: toolBrokerElapsedApprovalDeadlineAt,
      snapshots: {
        approvals: [toolBrokerMatchingApprovalDecision]
      }
    });

    expectResultSchema(result);
    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("approval_timeout");
    expect(adapterCalls).toBe(0);
  });

  test("adapter deadline breach returns timeout", async () => {
    let adapterCompleted = false;
    const fsReadAdapter: CapabilityAdapter = {
      id: "fixture/fs-read-slow",
      version: "0.0.0",
      kind: "filesystem",
      async execute(): Promise<AdapterExecutionResult> {
        await sleep(40);
        adapterCompleted = true;
        return successfulReadOutput();
      }
    };
    const result = await broker({
      registry: new CapabilityRegistry([
        fsReadFixtureDefinition({
          adapter: fsReadAdapter,
          limits: {
            timeoutMs: 5,
            maxBytes: 64
          }
        })
      ])
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_adapter_timeout"
    });

    expectResultSchema(result);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "timeout",
      message: "Tool adapter exceeded 5ms timeout.",
      retryable: true
    });
    expect(adapterCompleted).toBe(false);
  });

  test("computeLimits narrows to the minimum and never widens definition limits", () => {
    const definition = limitFixtureDefinition({ timeoutMs: 123, maxBytes: 100 });

    expect(
      computeLimits(
        definition,
        { maxBytes: 80 },
        allowVerdictWithMaxBytes(60)
      )
    ).toEqual({
      timeoutMs: 123,
      maxBytes: 60
    });
    expect(
      computeLimits(
        definition,
        { maxBytes: 500 },
        allowVerdictWithMaxBytes(1_000)
      )
    ).toEqual({
      timeoutMs: 123,
      maxBytes: 100
    });
    expect(
      computeLimits(
        definition,
        { maxBytes: 12.5 },
        allowVerdictWithMaxBytes(Number.POSITIVE_INFINITY)
      )
    ).toEqual({
      timeoutMs: 123,
      maxBytes: 100
    });
  });

  test("policy request uses definition authority and forwards context", async () => {
    const policyRequests: PolicyRequest[] = [];
    const registry = new CapabilityRegistry([
      policyRequestFixtureDefinition({
        adapter: countingSuccessAdapter()
      })
    ]);
    const snapshots = {
      approvals: [toolBrokerMatchingApprovalDecision]
    };
    const result = await broker({
      registry,
      policyEngine(requestToAuthorize) {
        policyRequests.push(requestToAuthorize);
        return allowVerdict();
      }
    }).callTool(
      request("fixture.policy.inspect", {
        path: "src/index.ts",
        risk: "critical",
        requestedScopes: ["shell:exec"]
      }),
      {
        runId: "run_context_override",
        runMode: "verification",
        traceId: "trace_policy_request",
        snapshots
      }
    );

    expectResultSchema(result);
    expect(result.status).toBe("success");
    expect(policyRequests).toHaveLength(1);
    expect(policyRequests[0]).toMatchObject({
      requestId:
        'fixture:fixture.policy.inspect:{"path":"src/index.ts","risk":"critical","requestedScopes":["shell:exec"]}',
      runId: "run_context_override",
      phase: "evidence",
      runMode: "verification",
      snapshots,
      action: {
        kind: "tool_call",
        toolId: "fixture.policy.inspect",
        risk: "low",
        requestedScopes: ["workspace:read"],
        args: {
          path: "src/index.ts",
          risk: "critical",
          requestedScopes: ["shell:exec"]
        }
      }
    });
  });

  test("hashValue is deterministic, key-sorted, and drops undefined values", () => {
    const left = hashValue({ b: 2, a: 1, omitted: undefined });
    const right = hashValue({ a: 1, b: 2 });

    expect(left).toBe(right);
    expect(left.startsWith("sha256:")).toBe(true);
  });
});

function broker(
  options: {
    registry?: CapabilityRegistry;
    policyBundle?: FixturePolicyBundle;
    policyEngine?: (
      request: PolicyRequest,
      policyBundles?: FixturePolicyBundle | readonly FixturePolicyBundle[]
    ) => PolicyVerdict;
  } = {}
) {
  if (options.registry !== undefined) {
    return createToolBroker({
      workspaceRoot,
      runId: "run_tool_broker_fixture",
      registry: options.registry,
      policyBundle: options.policyBundle ?? toolBrokerAllowPolicyBundle,
      policyEngine: options.policyEngine
    });
  }

  return createToolBroker({
    workspaceRoot,
    runId: "run_tool_broker_fixture",
    policyBundle: options.policyBundle ?? toolBrokerAllowPolicyBundle,
    policyEngine: options.policyEngine
  });
}

function request(toolId: string, args: unknown) {
  return {
    toolId,
    args,
    reason: `Fixture request for ${toolId}`,
    idempotencyKey: `fixture:${toolId}:${JSON.stringify(args)}`,
    requestedBy: {
      phase: "evidence"
    }
  };
}

function expectResultSchema(result: unknown) {
  expect(ToolCallResultSchema.safeParse(result).success).toBe(true);
}

function successfulReadOutput(): AdapterExecutionResult {
  return {
    status: "success",
    output: {
      path: "src/index.ts",
      content: 'export const sample = "Specwright";\n',
      encoding: "utf8",
      bytesRead: 36,
      truncated: false
    }
  };
}

function countingSuccessAdapter(onExecute?: () => void): CapabilityAdapter {
  return {
    id: "fixture/fs-read-counting-success",
    version: "0.0.0",
    kind: "filesystem",
    async execute(): Promise<AdapterExecutionResult> {
      onExecute?.();
      return successfulReadOutput();
    }
  };
}

function fsReadFixtureDefinition(
  overrides: Partial<CapabilityDefinition> = {}
): CapabilityDefinition {
  return {
    id: "fs.read",
    kind: "filesystem",
    description: "Read a UTF-8 file from a fixture adapter.",
    version: "0.1.0",
    inputSchema: FsReadInputSchema,
    outputSchema: FsReadOutputSchema,
    adapter: countingSuccessAdapter(),
    risk: "low",
    requestedScopes: ["workspace:read"],
    limits: {
      timeoutMs: 1_000,
      maxBytes: 200_000
    },
    cache: {
      enabled: false
    },
    isolationTier: isolationTierForKind("filesystem"),
    ...overrides
  };
}

function limitFixtureDefinition(
  limits: CapabilityDefinition["limits"]
): CapabilityDefinition {
  return fsReadFixtureDefinition({
    id: "fixture.limit.inspect",
    limits
  });
}

function policyRequestFixtureDefinition(
  overrides: Partial<CapabilityDefinition> = {}
): CapabilityDefinition {
  const inputSchema = z
    .object({
      path: z.string().min(1),
      risk: z.string().optional(),
      requestedScopes: z.array(z.string()).optional()
    })
    .strict();

  return {
    ...fsReadFixtureDefinition({
      id: "fixture.policy.inspect",
      inputSchema,
      adapter: countingSuccessAdapter()
    }),
    ...overrides
  };
}

function allowVerdict(): PolicyVerdict {
  return {
    status: "allow",
    reasons: ["fixture allow"],
    constraints: [],
    obligations: [],
    matchedRules: [
      {
        ruleId: "fixture.allow",
        layer: "capability",
        effect: "allow",
        reason: "fixture allow"
      }
    ],
    decisionHash: "sha256:fixture-allow"
  };
}

function allowVerdictWithMaxBytes(value: unknown): PolicyVerdict {
  return {
    ...allowVerdict(),
    constraints: [
      {
        kind: "maxBytes",
        value,
        sourceRuleId: "fixture.max-bytes"
      }
    ]
  };
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
