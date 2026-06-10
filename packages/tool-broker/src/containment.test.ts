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
import { join } from "node:path";
import type { FixturePolicyBundle } from "@specwright/policy-engine";
import { createToolBroker } from "./index";

describe("broker workspace containment conformance", () => {
  test("rejects traversal, absolute outside paths, symlink escape, and outside cwd", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "specwright-broker-gate-"));
    const outsideRoot = await mkdtemp(
      join(tmpdir(), "specwright-broker-gate-outside-")
    );

    try {
      await mkdir(join(tempRoot, "src"), { recursive: true });
      await writeFile(join(tempRoot, "src", "inside.txt"), "inside\n", "utf8");
      await writeFile(join(outsideRoot, "secret.txt"), "outside\n", "utf8");
      await symlink(join(outsideRoot, "secret.txt"), join(tempRoot, "escape"));
      const workspaceRoot = await realpath(tempRoot);
      const outsideSecret = await realpath(join(outsideRoot, "secret.txt"));
      const broker = createToolBroker({
        workspaceRoot,
        runId: "run_containment_gate",
        policyBundle: allowPolicyBundle
      });

      const traversal = await broker.callTool(
        request("fs.read", { path: "../outside.txt" }),
        { cwd: workspaceRoot, traceId: "trace_containment_traversal" }
      );
      const absoluteOutside = await broker.callTool(
        request("fs.read", { path: outsideSecret }),
        { cwd: workspaceRoot, traceId: "trace_containment_absolute" }
      );
      const symlinkEscape = await broker.callTool(
        request("fs.read", { path: "escape" }),
        { cwd: workspaceRoot, traceId: "trace_containment_symlink" }
      );
      const outsideCwd = await broker.callTool(
        request("fs.list", { path: "." }),
        { cwd: outsideRoot, traceId: "trace_containment_cwd" }
      );

      for (const result of [traversal, absoluteOutside, symlinkEscape]) {
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe("path_outside_workspace");
        expect(result.output).toBeUndefined();
      }

      expect(outsideCwd.status).toBe("failed");
      expect(outsideCwd.error?.code).toBe("cwd_outside_workspace");
      expect(outsideCwd.output).toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

const allowPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.containment.allow",
  description: "Allows filesystem reads for containment tests.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fs.list": {
      default: "allow",
      risk: "low",
      reason: "fs.list is allowed for containment tests.",
      allowedPhases: ["evidence"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    },
    "fs.read": {
      default: "allow",
      risk: "low",
      reason: "fs.read is allowed for containment tests.",
      allowedPhases: ["evidence"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    }
  }
};

function request(toolId: string, args: unknown) {
  return {
    toolId,
    args,
    reason: `Containment conformance for ${toolId}`,
    idempotencyKey: `containment-${toolId}-${JSON.stringify(args)}`,
    requestedBy: {
      phase: "evidence"
    }
  };
}
