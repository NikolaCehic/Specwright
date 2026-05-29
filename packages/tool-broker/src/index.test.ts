import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { FixturePolicyBundle } from "@specwright/policy-engine";
import {
  createDefaultCapabilityRegistry,
  createToolBroker,
  type AdapterExecutionResult,
  type CapabilityAdapter
} from "./index";

const workspaceRoot = resolve(import.meta.dir, "../fixtures/workspace");

const readOnlyPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.readonly",
  description: "Allows read-only filesystem tools in evidence.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fs.list": {
      default: "allow",
      risk: "low",
      reason: "fs.list is allowed for broker fixture reads",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    },
    "fs.read": {
      default: "allow",
      risk: "low",
      reason: "fs.read is allowed for broker fixture reads",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"],
      constraints: [
        {
          kind: "maxBytes",
          value: 64
        }
      ]
    }
  }
};

const denyReadPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.deny-read",
  description: "Denies fs.read for policy denial coverage.",
  toolPolicy: {
    "fs.read": {
      default: "deny",
      risk: "low",
      reason: "Fixture denies fs.read",
      allowedPhases: ["evidence"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    }
  }
};

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
      registry: createDefaultCapabilityRegistry({ fsReadAdapter })
    }).callTool(request("fs.read", {}), { traceId: "trace_invalid_input" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_request");
    expect(adapterCalls).toBe(0);
  });

  test("policy denial returns a structured denied result", async () => {
    const result = await broker({ policyBundle: denyReadPolicyBundle }).callTool(
      request("fs.read", { path: "src/index.ts" }),
      { traceId: "trace_policy_denied" }
    );

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
});

function broker(
  options: {
    registry?: ReturnType<typeof createDefaultCapabilityRegistry>;
    policyBundle?: FixturePolicyBundle;
  } = {}
) {
  if (options.registry !== undefined) {
    return createToolBroker({
      workspaceRoot,
      runId: "run_tool_broker_fixture",
      registry: options.registry,
      policyBundle: options.policyBundle ?? readOnlyPolicyBundle
    });
  }

  return createToolBroker({
    workspaceRoot,
    runId: "run_tool_broker_fixture",
    policyBundle: options.policyBundle ?? readOnlyPolicyBundle
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
