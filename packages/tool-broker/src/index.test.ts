import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluatePolicy } from "@specwright/policy-engine";
import type {
  FixturePolicyBundle,
  PolicyRequest,
  PolicyVerdict
} from "@specwright/policy-engine";
import { ToolCallResultSchema } from "@specwright/schemas";
import { z } from "zod";
import {
  EGRESS_ERROR_SECRET,
  EGRESS_FIXTURE_ADAPTER_VERSION,
  EGRESS_OUTPUT_BEARER,
  EGRESS_OUTPUT_CREDENTIAL,
  EGRESS_OUTPUT_INVALID_SECRET,
  EGRESS_OUTPUT_TOKEN,
  egressAllowPolicyBundle,
  egressErrorDefinition,
  egressInvalidOutputDefinition,
  egressMissingRedactionDischargePolicyBundle,
  egressSecretDefinition,
  egressSecretRawOutput,
  egressValidDefinition
} from "../fixtures/egress/definitions";
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
  CAPABILITY_KINDS,
  CAPABILITY_KIND_ISOLATION_TIERS,
  CapabilityRegistry,
  DEFAULT_FS_READ_MAX_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  computeLimits,
  createDefaultCapabilityRegistry,
  createToolBroker,
  FILESYSTEM_ADAPTER_VERSION,
  FsReadInputSchema,
  FsReadOutputSchema,
  deriveTierConstraints,
  hashValue,
  InMemoryToolResultCacheStore,
  isolationTierForKind,
  type AdapterExecutionResult,
  type CapabilityAdapter,
  type CapabilityDefinition,
  type ToolBrokerOptions,
  type ToolCacheMetadata,
  type ToolResultCacheEntry,
  type ToolResultCacheStore,
  type CapabilityKind
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
    expect(result.provenance.adapterVersion).toBe(FILESYSTEM_ADAPTER_VERSION);
    expect(result.provenance.decisionHash?.startsWith("sha256:")).toBe(true);
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
    expect(result.provenance.adapterVersion).toBe(FILESYSTEM_ADAPTER_VERSION);
    expect(result.provenance.decisionHash?.startsWith("sha256:")).toBe(true);
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
    expect(resumed.provenance.approvalId).toBe(TOOL_BROKER_APPROVAL_ID);
    expect(resumed.provenance.decisionHash?.startsWith("sha256:")).toBe(true);
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

  test("isolation tier constraints are total and unsupported tiers cannot run", async () => {
    expect(Object.keys(CAPABILITY_KIND_ISOLATION_TIERS).sort()).toEqual(
      [...CAPABILITY_KINDS].sort()
    );

    for (const kind of CAPABILITY_KINDS) {
      const constraints = deriveTierConstraints(genericDefinitionForKind(kind));

      expect(constraints.isolationTier).toBe(isolationTierForKind(kind));
      expect(constraints.deadlineMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
      expect(constraints.execution).toBe(
        kind === "filesystem" ? "sanctioned" : "unsupported"
      );
    }

    let adapterCalls = 0;
    const registry = new CapabilityRegistry([
      genericDefinitionForKind("model", {
        id: "fixture.model.unsupported",
        adapter: {
          id: "fixture/model-unsupported",
          version: "0.0.0",
          kind: "model",
          async execute(): Promise<AdapterExecutionResult> {
            adapterCalls += 1;
            return {
              status: "success",
              output: {
                ok: true
              }
            };
          }
        }
      })
    ]);
    const result = await broker({
      registry,
      policyEngine: allowPolicyEngine
    }).callTool(request("fixture.model.unsupported", {}), {
      traceId: "trace_unsupported_tier"
    });

    expectResultSchema(result);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("unsupported_isolation_tier");
    expect(result.error?.retryable).toBe(false);
    expect(result.output).toBeUndefined();
    expect(adapterCalls).toBe(0);
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

  test("tier ceilings participate in computeLimits without widening authority", () => {
    const filesystemDefinition = limitFixtureDefinition({
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS * 2,
      maxBytes: DEFAULT_FS_READ_MAX_BYTES * 2
    });
    const modelDefinition = genericDefinitionForKind("model", {
      limits: {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS * 2,
        maxTokens: 20_000
      }
    });

    expect(
      computeLimits(
        filesystemDefinition,
        { maxBytes: DEFAULT_FS_READ_MAX_BYTES + 1 },
        allowVerdictWithMaxBytes(DEFAULT_FS_READ_MAX_BYTES + 2)
      )
    ).toEqual({
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      maxBytes: DEFAULT_FS_READ_MAX_BYTES
    });
    expect(
      computeLimits(
        modelDefinition,
        { maxTokens: 10_000 },
        allowVerdictWithConstraint("maxTokens", 9_000)
      )
    ).toEqual({
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      maxBytes: DEFAULT_FS_READ_MAX_BYTES,
      maxTokens: 8_192
    });
  });

  test("adapter execution input stays least-context", async () => {
    let observedInputKeys: string[] = [];
    let observedRunContextKeys: string[] = [];
    let observedLimitKeys: string[] = [];
    const fsReadAdapter: CapabilityAdapter = {
      id: "fixture/fs-read-least-context",
      version: "0.0.0",
      kind: "filesystem",
      async execute(input): Promise<AdapterExecutionResult> {
        observedInputKeys = Object.keys(input).sort();
        observedRunContextKeys = Object.keys(input.runContext).sort();
        observedLimitKeys = Object.keys(input.limits).sort();
        expect(input).not.toHaveProperty("registry");
        expect(input).not.toHaveProperty("policyEngine");
        expect(input).not.toHaveProperty("runStore");
        expect(input).not.toHaveProperty("adapter");
        return successfulReadOutput();
      }
    };
    const result = await broker({
      registry: new CapabilityRegistry([
        fsReadFixtureDefinition({
          adapter: fsReadAdapter
        })
      ])
    }).callTool(request("fs.read", { path: "src/index.ts" }), {
      traceId: "trace_least_context"
    });

    expect(result.status).toBe("success");
    expect(observedInputKeys).toEqual(["args", "limits", "runContext"]);
    expect(observedRunContextKeys).toEqual([
      "cwd",
      "phase",
      "runId",
      "traceId",
      "workspaceRoot"
    ]);
    expect(observedLimitKeys).toEqual(["maxBytes", "timeoutMs"]);
  });

  test("filesystem adapters reject symlinks resolving outside workspaceRoot", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "specwright-tool-broker-"));
    const outsideRoot = await mkdtemp(
      join(tmpdir(), "specwright-tool-broker-outside-")
    );

    try {
      await mkdir(join(tempRoot, "src"), { recursive: true });
      await writeFile(join(tempRoot, "src", "inside.txt"), "inside\n", "utf8");
      await writeFile(join(outsideRoot, "secret.txt"), "outside\n", "utf8");
      await symlink(join(outsideRoot, "secret.txt"), join(tempRoot, "escape"));
      const realTempRoot = await realpath(tempRoot);

      const result = await createToolBroker({
        workspaceRoot: realTempRoot,
        runId: "run_symlink_escape",
        policyBundle: toolBrokerAllowPolicyBundle
      }).callTool(request("fs.read", { path: "escape" }), {
        cwd: realTempRoot,
        traceId: "trace_symlink_escape"
      });

      expectResultSchema(result);
      expect(result.status).toBe("failed");
      expect(result.error).toEqual({
        code: "path_outside_workspace",
        message: "Path resolves outside the configured workspace.",
        retryable: false
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
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

  describe("brokered cache replay", () => {
    test("eligible miss is written and equivalent reordered args replay as a hit", async () => {
      let adapterCalls = 0;
      const cacheStore = new InMemoryToolResultCacheStore();
      const registry = new CapabilityRegistry([
        cacheEnabledFsReadDefinition({
          adapter: countingSuccessAdapter(() => {
            adapterCalls += 1;
          })
        })
      ]);
      const first = await broker({ registry, cacheStore }).callTool(
        request("fs.read", {
          encoding: undefined,
          path: "src/index.ts"
        }),
        {
          ...cacheContext(),
          traceId: "trace_cache_miss"
        }
      );
      const second = await broker({ registry, cacheStore }).callTool(
        request("fs.read", {
          path: "src/index.ts"
        }),
        {
          ...cacheContext(),
          traceId: "trace_cache_hit"
        }
      );

      expectResultSchema(first);
      expectResultSchema(second);
      expect(first.status).toBe("success");
      expect(second.status).toBe("success");
      expect(first.provenance.cacheStatus).toBe("miss");
      expect(second.provenance.cacheStatus).toBe("hit");
      expect(first.provenance.cache?.status).toBe("miss");
      expect(second.provenance.cache?.status).toBe("hit");
      expect(second.provenance.cache?.key).toBe(first.provenance.cache?.key);
      expect(second.provenance.cache?.keyInputs).toEqual(
        first.provenance.cache?.keyInputs
      );
      expect(second.provenance.cache?.keyInputs?.argsHash).toBe(
        hashValue({ path: "src/index.ts" })
      );
      expect(second.provenance.cache?.entryCreatedAt).toBeDefined();
      expect(second.output).toEqual(first.output);
      expect(adapterCalls).toBe(1);
    });

    test("cache lookup remains after policy authorization", async () => {
      let adapterCalls = 0;
      const cacheStore = new InMemoryToolResultCacheStore();
      const registry = new CapabilityRegistry([
        cacheEnabledFsReadDefinition({
          adapter: countingSuccessAdapter(() => {
            adapterCalls += 1;
          })
        })
      ]);

      const allowed = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext(),
          traceId: "trace_cache_policy_prime"
        }
      );
      const denied = await broker({
        registry,
        cacheStore,
        policyBundle: toolBrokerDenyReadPolicyBundle
      }).callTool(request("fs.read", { path: "src/index.ts" }), {
        ...cacheContext(),
        traceId: "trace_cache_policy_denied"
      });

      expect(allowed.provenance.cacheStatus).toBe("miss");
      expect(denied.status).toBe("denied");
      expect(denied.error?.code).toBe("policy_denied");
      expect(denied.provenance.cacheStatus).toBe("bypass");
      expect(denied.output).toBeUndefined();
      expect(adapterCalls).toBe(1);
    });

    test("stale cached output revalidates against the current output schema", async () => {
      const cacheStore = new InMemoryToolResultCacheStore();
      const originalRegistry = new CapabilityRegistry([
        cacheEnabledFsReadDefinition()
      ]);
      const primed = await broker({ registry: originalRegistry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext(),
          traceId: "trace_cache_schema_prime"
        }
      );
      let adapterCalls = 0;
      const repairedOutput = {
        ...(successfulReadOutput().output as Record<string, unknown>),
        checksum: "fixture-checksum"
      };
      const currentRegistry = new CapabilityRegistry([
        cacheEnabledFsReadDefinition({
          outputSchema: FsReadOutputSchema.extend({
            checksum: z.string().min(1)
          }).strict(),
          adapter: {
            id: "fixture/fs-read-schema-v2",
            version: "0.0.1",
            kind: "filesystem",
            async execute(): Promise<AdapterExecutionResult> {
              adapterCalls += 1;
              return {
                status: "success",
                output: repairedOutput
              };
            }
          }
        })
      ]);
      const result = await broker({ registry: currentRegistry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext(),
          traceId: "trace_cache_schema_bypass"
        }
      );

      expect(primed.provenance.cacheStatus).toBe("miss");
      expect(result.status).toBe("success");
      expect(result.output).toEqual(repairedOutput);
      expect(result.provenance.cacheStatus).toBe("bypass");
      expect(result.provenance.cache?.invalidationReason).toContain(
        "cache_output_invalid"
      );
      expect(adapterCalls).toBe(1);
    });

    test("source hash, tool version, harness spec hash, and model version changes each force misses", async () => {
      let adapterCalls = 0;
      const cacheStore = new InMemoryToolResultCacheStore();
      const registry = new CapabilityRegistry([
        cacheEnabledFsReadDefinition({
          adapter: countingSuccessAdapter(() => {
            adapterCalls += 1;
          })
        })
      ]);
      const versionedRegistry = new CapabilityRegistry([
        cacheEnabledFsReadDefinition({
          version: "0.2.0",
          adapter: countingSuccessAdapter(() => {
            adapterCalls += 1;
          })
        })
      ]);

      const base = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext(),
          traceId: "trace_cache_key_base"
        }
      );
      const sourceChanged = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext({ sourceHash: "sha256:source-b" }),
          traceId: "trace_cache_key_source"
        }
      );
      const toolVersionChanged = await broker({
        registry: versionedRegistry,
        cacheStore
      }).callTool(request("fs.read", { path: "src/index.ts" }), {
        ...cacheContext(),
        traceId: "trace_cache_key_tool_version"
      });
      const harnessChanged = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext({ harnessSpecHash: "sha256:harness-b" }),
          traceId: "trace_cache_key_harness"
        }
      );
      const modelVersionChanged = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          ...cacheContext({
            cache: {
              modelVersion: "model-fixture-v2"
            }
          }),
          traceId: "trace_cache_key_model_version"
        }
      );

      expect(base.provenance.cacheStatus).toBe("miss");
      expect(sourceChanged.provenance.cacheStatus).toBe("miss");
      expect(toolVersionChanged.provenance.cacheStatus).toBe("miss");
      expect(harnessChanged.provenance.cacheStatus).toBe("miss");
      expect(modelVersionChanged.provenance.cacheStatus).toBe("miss");
      expect(sourceChanged.provenance.cache?.key).not.toBe(
        base.provenance.cache?.key
      );
      expect(toolVersionChanged.provenance.cache?.key).not.toBe(
        base.provenance.cache?.key
      );
      expect(harnessChanged.provenance.cache?.key).not.toBe(
        base.provenance.cache?.key
      );
      expect(modelVersionChanged.provenance.cache?.key).not.toBe(
        base.provenance.cache?.key
      );
      expect(adapterCalls).toBe(5);
    });

    test("ineligible capabilities always bypass and never replay cached output", async () => {
      let adapterCalls = 0;
      const cacheStore = new InMemoryToolResultCacheStore();
      const registry = new CapabilityRegistry([
        fsReadFixtureDefinition({
          adapter: countingSuccessAdapter(() => {
            adapterCalls += 1;
          })
        })
      ]);

      const first = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          traceId: "trace_cache_ineligible_first"
        }
      );
      const second = await broker({ registry, cacheStore }).callTool(
        request("fs.read", { path: "src/index.ts" }),
        {
          traceId: "trace_cache_ineligible_second"
        }
      );

      expect(first.provenance.cacheStatus).toBe("bypass");
      expect(second.provenance.cacheStatus).toBe("bypass");
      expect(first.provenance.cache).toBeUndefined();
      expect(second.provenance.cache).toBeUndefined();
      expect(adapterCalls).toBe(2);
    });

    test("cache get and set errors are contained in provenance", async () => {
      let getErrorAdapterCalls = 0;
      const getErrorResult = await broker({
        registry: new CapabilityRegistry([
          cacheEnabledFsReadDefinition({
            adapter: countingSuccessAdapter(() => {
              getErrorAdapterCalls += 1;
            })
          })
        ]),
        cacheStore: new FailingGetCacheStore()
      }).callTool(request("fs.read", { path: "src/index.ts" }), {
        ...cacheContext(),
        traceId: "trace_cache_get_error"
      });
      let setErrorAdapterCalls = 0;
      const setErrorResult = await broker({
        registry: new CapabilityRegistry([
          cacheEnabledFsReadDefinition({
            adapter: countingSuccessAdapter(() => {
              setErrorAdapterCalls += 1;
            })
          })
        ]),
        cacheStore: new FailingSetCacheStore()
      }).callTool(request("fs.read", { path: "src/index.ts" }), {
        ...cacheContext(),
        traceId: "trace_cache_set_error"
      });

      expect(getErrorResult.status).toBe("success");
      expect(getErrorResult.provenance.cacheStatus).toBe("bypass");
      expect(getErrorResult.provenance.cache?.invalidationReason).toContain(
        "cache_get_error"
      );
      expect(getErrorAdapterCalls).toBe(1);
      expect(setErrorResult.status).toBe("success");
      expect(setErrorResult.provenance.cacheStatus).toBe("miss");
      expect(setErrorResult.provenance.cache?.writeError).toContain(
        "cache_set_error"
      );
      expect(setErrorAdapterCalls).toBe(1);
    });
  });

  test("schema-valid fixture output carries enterprise provenance", async () => {
    const result = await broker({
      registry: egressRegistry(),
      policyBundle: egressAllowPolicyBundle
    }).callTool(request("fixture.egress.valid", { query: "valid" }), {
      traceId: "trace_egress_valid"
    });

    expectResultSchema(result);
    expect(result.status).toBe("success");
    expect(result.provenance.adapterVersion).toBe(EGRESS_FIXTURE_ADAPTER_VERSION);
    expect(result.provenance.decisionHash?.startsWith("sha256:")).toBe(true);
    expect(result.provenance.resultHash).toBe(hashValue(result.output));
    expect(result.provenance.spanId).toBeUndefined();
    expect(result.provenance.eventIds).toBeUndefined();
  });

  test("schema-invalid adapter output fails before redaction and sanitizes output_invalid text", async () => {
    const result = await broker({
      registry: egressRegistry(),
      policyBundle: egressAllowPolicyBundle
    }).callTool(
      request("fixture.egress.invalid-output", { query: "invalid" }),
      {
        traceId: "trace_egress_invalid"
      }
    );
    const serialized = JSON.stringify(result);

    expectResultSchema(result);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("output_invalid");
    expect(result.output).toBeUndefined();
    expect(result.provenance.redactionSummary).toBeUndefined();
    expect(result.provenance.adapterVersion).toBe(EGRESS_FIXTURE_ADAPTER_VERSION);
    expect(result.provenance.decisionHash?.startsWith("sha256:")).toBe(true);
    expect(serialized).not.toContain(EGRESS_OUTPUT_INVALID_SECRET);
    expect(result.error?.message).toContain(hashValue(EGRESS_OUTPUT_INVALID_SECRET));
  });

  test("validated output is redacted before result construction and summarized without raw values", async () => {
    const args = { query: "customer", limit: 2 };
    const result = await broker({
      registry: egressRegistry(),
      policyBundle: egressAllowPolicyBundle
    }).callTool(request("fixture.egress.secret-output", args), {
      traceId: "trace_egress_secret",
      spanId: "span_egress_secret",
      eventIds: ["event_tool_executed", "event_tool_completed"]
    });
    const serialized = JSON.stringify(result);

    expectResultSchema(result);
    expect(result.status).toBe("success");
    expect(result.output).toEqual({
      account: {
        apiToken: hashValue(EGRESS_OUTPUT_TOKEN),
        name: "Acme External",
        nested: {
          credential: hashValue(EGRESS_OUTPUT_CREDENTIAL)
        }
      },
      notes: [
        {
          label: "authorization",
          value: hashValue(EGRESS_OUTPUT_BEARER)
        }
      ]
    });
    expect(result.provenance.argsHash).toBe(hashValue(args));
    expect(result.provenance.resultHash).toBe(hashValue(result.output));
    expect(result.provenance.resultHash).not.toBe(hashValue(egressSecretRawOutput()));
    expect(result.provenance.adapterVersion).toBe(EGRESS_FIXTURE_ADAPTER_VERSION);
    expect(result.provenance.decisionHash?.startsWith("sha256:")).toBe(true);
    expect(result.provenance.spanId).toBe("span_egress_secret");
    expect(result.provenance.eventIds).toEqual([
      "event_tool_executed",
      "event_tool_completed"
    ]);
    expect(result.provenance.redactionSummary).toEqual({
      redactedCount: 3,
      redactions: [
        {
          path: "account.apiToken",
          classification: "secret",
          hash: hashValue(EGRESS_OUTPUT_TOKEN)
        },
        {
          path: "account.nested.credential",
          classification: "policy_redact",
          hash: hashValue(EGRESS_OUTPUT_CREDENTIAL)
        },
        {
          path: "notes.0.value",
          classification: "secret",
          hash: hashValue(EGRESS_OUTPUT_BEARER)
        }
      ],
      dischargedObligations: [
        {
          kind: "mark_external_source",
          sourceRuleId: "tool.fixture.egress.secret-output.default",
          externalSource: "external://fixture-crm/customer-record"
        },
        {
          kind: "redact",
          sourceRuleId: "tool.fixture.egress.secret-output.default",
          selector: "account.nested.credential"
        }
      ]
    });
    expect(serialized).not.toContain(EGRESS_OUTPUT_TOKEN);
    expect(serialized).not.toContain(EGRESS_OUTPUT_CREDENTIAL);
    expect(serialized).not.toContain(EGRESS_OUTPUT_BEARER);
  });

  test("adapter failure messages are sanitized before returning errors", async () => {
    const result = await broker({
      registry: egressRegistry(),
      policyBundle: egressAllowPolicyBundle
    }).callTool(request("fixture.egress.error", { query: "error" }), {
      traceId: "trace_egress_error"
    });

    expectResultSchema(result);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("adapter_error");
    expect(result.error?.message).not.toContain(EGRESS_ERROR_SECRET);
    expect(result.error?.message).toContain(hashValue(EGRESS_ERROR_SECRET));
    expect(JSON.stringify(result)).not.toContain(EGRESS_ERROR_SECRET);
  });

  test("missing redaction obligation discharge fails closed", async () => {
    const result = await broker({
      registry: egressRegistry(),
      policyBundle: egressMissingRedactionDischargePolicyBundle
    }).callTool(request("fixture.egress.secret-output", { query: "gap" }), {
      traceId: "trace_egress_redaction_gap"
    });
    const serialized = JSON.stringify(result);

    expectResultSchema(result);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("obligation_not_discharged");
    expect(result.error?.message).toContain("account.missingToken");
    expect(result.output).toBeUndefined();
    expect(serialized).not.toContain(EGRESS_OUTPUT_TOKEN);
    expect(serialized).not.toContain(EGRESS_OUTPUT_CREDENTIAL);
  });

  test("redaction and hashes are deterministic and argsHash stays order-independent", async () => {
    const leftArgs = { query: "customer", limit: 2 };
    const rightArgs = { limit: 2, query: "customer" };
    const testBroker = broker({
      registry: egressRegistry(),
      policyBundle: egressAllowPolicyBundle
    });
    const first = await testBroker.callTool(
      request("fixture.egress.secret-output", leftArgs),
      { traceId: "trace_egress_determinism_first" }
    );
    const second = await testBroker.callTool(
      request("fixture.egress.secret-output", rightArgs),
      { traceId: "trace_egress_determinism_second" }
    );

    expectResultSchema(first);
    expectResultSchema(second);
    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(first.output).toEqual(second.output);
    expect(first.provenance.redactionSummary).toEqual(
      second.provenance.redactionSummary
    );
    expect(first.provenance.argsHash).toBe(second.provenance.argsHash);
    expect(first.provenance.argsHash).toBe(hashValue(leftArgs));
    expect(second.provenance.argsHash).toBe(hashValue(rightArgs));
    expect(first.provenance.resultHash).toBe(second.provenance.resultHash);
    expect(first.provenance.resultHash).toBe(hashValue(first.output));
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
    policyBundle?: FixturePolicyBundle | readonly FixturePolicyBundle[];
    policyEngine?: (
      request: PolicyRequest,
      policyBundles?: FixturePolicyBundle | readonly FixturePolicyBundle[]
    ) => PolicyVerdict;
    cacheStore?: ToolBrokerOptions["cacheStore"];
  } = {}
) {
  if (options.registry !== undefined) {
    return createToolBroker({
      workspaceRoot,
      runId: "run_tool_broker_fixture",
      registry: options.registry,
      policyBundle: options.policyBundle ?? toolBrokerAllowPolicyBundle,
      policyEngine: options.policyEngine,
      cacheStore: options.cacheStore
    });
  }

  return createToolBroker({
    workspaceRoot,
    runId: "run_tool_broker_fixture",
    policyBundle: options.policyBundle ?? toolBrokerAllowPolicyBundle,
    policyEngine: options.policyEngine,
    cacheStore: options.cacheStore
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

function egressRegistry() {
  return new CapabilityRegistry([
    egressValidDefinition(),
    egressInvalidOutputDefinition(),
    egressSecretDefinition(),
    egressErrorDefinition()
  ]);
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

function cacheEnabledFsReadDefinition(
  overrides: Partial<CapabilityDefinition> = {}
): CapabilityDefinition {
  return fsReadFixtureDefinition({
    cache: {
      enabled: true
    },
    ...overrides
  });
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
  return allowVerdictWithConstraint("maxBytes", value);
}

function allowVerdictWithConstraint(kind: string, value: unknown): PolicyVerdict {
  return {
    ...allowVerdict(),
    constraints: [
      {
        kind,
        value,
        sourceRuleId: `fixture.${kind}`
      }
    ]
  };
}

function allowPolicyEngine(): PolicyVerdict {
  return allowVerdict();
}

function genericDefinitionForKind(
  kind: CapabilityKind,
  overrides: Partial<CapabilityDefinition> = {}
): CapabilityDefinition {
  const outputSchema = z
    .object({
      ok: z.boolean()
    })
    .strict();

  return {
    id: `fixture.${kind}.inspect`,
    kind,
    description: `Inspect ${kind} tier behavior.`,
    version: "0.1.0",
    inputSchema: z.object({}).strict(),
    outputSchema,
    adapter: {
      id: `fixture/${kind}`,
      version: "0.0.0",
      kind,
      async execute(): Promise<AdapterExecutionResult> {
        return {
          status: "success",
          output: {
            ok: true
          }
        };
      }
    },
    risk: "low",
    requestedScopes: [`${kind}:fixture`],
    limits: {
      timeoutMs: 1_000,
      maxBytes: 1_000,
      maxTokens: 1_000
    },
    cache: {
      enabled: false
    },
    isolationTier: isolationTierForKind(kind),
    ...overrides
  };
}

function cacheContext(
  options: {
    harnessSpecHash?: string;
    sourceHash?: string;
    cache?: ToolCacheMetadata;
  } = {}
) {
  return {
    snapshots: {
      runState: {
        runId: "run_tool_broker_fixture",
        status: "running",
        phase: "evidence",
        harness: {
          id: "harness.fixture",
          version: "0.1.0",
          specHash: options.harnessSpecHash ?? "sha256:harness-a"
        },
        budgets: {},
        pendingApprovals: [],
        pendingQuestions: [],
        artifacts: [],
        lastEventId: "evt_cache_context"
      },
      sourceTrust: {
        sourceHashes: {
          "src/index.ts": options.sourceHash ?? "sha256:source-a"
        }
      }
    },
    cache: options.cache
  };
}

class FailingGetCacheStore implements ToolResultCacheStore {
  get(): ToolResultCacheEntry | undefined {
    throw new Error("fixture cache get failed");
  }

  set(): void {}
}

class FailingSetCacheStore implements ToolResultCacheStore {
  get(): ToolResultCacheEntry | undefined {
    return undefined;
  }

  set(): void {
    throw new Error("fixture cache set failed");
  }
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
