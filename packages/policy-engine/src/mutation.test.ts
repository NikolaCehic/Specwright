import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluatePolicy,
  loadPolicyBundles,
  type FixturePolicyBundle,
  type FixturePolicyRule,
  type PolicyRequest,
  type PolicyRuleEffect,
  type PolicyVerdict,
  type PolicyVerdictStatus
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");
const statusStrictness: Record<PolicyVerdictStatus, number> = {
  allow: 0,
  approval_required: 1,
  deny: 2
};

const mutationCases = [
  {
    name: "remove required scope",
    fixtureName: "scope-union-constrained",
    mutateRequest: (request: PolicyRequest) => {
      const next = structuredClone(request);
      const requestedScopes = next.action.requestedScopes ?? [];

      next.action.requestedScopes = requestedScopes.filter(
        (scope) => scope !== "agent:observe"
      );

      return next;
    },
    expectedBaseStatus: "allow",
    expectedMutatedStatus: "deny",
    expectedRuleId: "tool.fs.read.scope",
    expectedEffect: "deny"
  },
  {
    name: "change phase outside allowedPhases",
    fixtureName: "fs-read-allowed-in-evidence",
    mutateRequest: (request: PolicyRequest) => {
      const next = structuredClone(request);

      next.phase = "synthesis";

      return next;
    },
    expectedBaseStatus: "allow",
    expectedMutatedStatus: "deny",
    expectedRuleId: "tool.fs.read.phase",
    expectedEffect: "deny"
  },
  {
    name: "raise budgetCost beyond max",
    fixtureName: "budget-within-limit-allowed",
    mutateRequest: (request: PolicyRequest) => {
      const next = structuredClone(request);

      next.action.budgetCosts = {
        ...next.action.budgetCosts,
        fileReadBytes: 800
      };

      return next;
    },
    expectedBaseStatus: "allow",
    expectedMutatedStatus: "deny",
    expectedRuleId: "budget.file_read_bytes.deny_max",
    expectedEffect: "deny"
  },
  {
    name: "set runMode to ci",
    fixtureName: "run-mode-local-dev-allowed",
    mutateRequest: (request: PolicyRequest) => {
      const next = structuredClone(request);

      next.runMode = "ci";

      return next;
    },
    expectedBaseStatus: "allow",
    expectedMutatedStatus: "deny",
    expectedRuleId: "run_mode.ci.model_prompt.denied",
    expectedEffect: "deny"
  },
  {
    name: "remove satisfying ApprovalDecision",
    fixtureName: "shell-exec-approved",
    mutateRequest: (request: PolicyRequest) => ({
      ...structuredClone(request),
      snapshots: {
        ...request.snapshots,
        approvals: {
          decisions: []
        }
      }
    }),
    expectedBaseStatus: "allow",
    expectedMutatedStatus: "approval_required",
    expectedRuleId: "tool.shell.exec.default",
    expectedEffect: "approval_required"
  },
  {
    name: "add host deniedTools entry",
    fixtureName: "fs-read-allowed-in-evidence",
    mutateRequest: (request: PolicyRequest) => ({
      ...structuredClone(request),
      snapshots: {
        ...request.snapshots,
        hostPolicy: {
          deniedTools: ["fs.read"]
        }
      }
    }),
    expectedBaseStatus: "allow",
    expectedMutatedStatus: "deny",
    expectedRuleId: "host.fs.read.deny",
    expectedEffect: "deny"
  }
] as const satisfies readonly MutationCase[];

describe("policy engine tightening mutations", () => {
  for (const mutationCase of mutationCases) {
    test(`${mutationCase.name} makes the verdict strictly stricter`, async () => {
      const { request, policyBundles, verdict } = await loadFixture(
        mutationCase.fixtureName
      );
      const mutatedRequest = mutationCase.mutateRequest(request);
      const mutatedVerdict = evaluatePolicy(mutatedRequest, policyBundles);

      expect(verdict.status).toBe(mutationCase.expectedBaseStatus);
      expect(mutatedVerdict.status).toBe(mutationCase.expectedMutatedStatus);
      expect(strictnessOf(mutatedVerdict)).toBeGreaterThan(strictnessOf(verdict));
      expect(strictnessOf(mutatedVerdict)).toBeGreaterThanOrEqual(
        strictnessOf(verdict)
      );
      expect(mutatedVerdict.matchedRules).toContainEqual({
        ruleId: mutationCase.expectedRuleId,
        effect: mutationCase.expectedEffect,
        layer: expect.any(String),
        reason: expect.any(String)
      });
      expect(mutatedVerdict.decisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(mutatedVerdict.decisionHash).not.toBe(verdict.decisionHash);
    });
  }

  test("broaden path makes the verdict strictly stricter", async () => {
    const { request, policyBundles, verdict } = await loadFixture(
      "fs-read-allowed-in-evidence"
    );
    const pathGuard: FixturePolicyRule = {
      id: "runtime.fs_read.deny_workspace_root",
      layer: "runtime_invariant",
      effect: "deny",
      reason: "runtime policy denies broad workspace root reads",
      match: {
        actionKind: "tool_call",
        toolId: "fs.read",
        args: [
          {
            path: "path",
            equals: "."
          }
        ]
      }
    };
    const guardedBundles = withRuntimeInvariant(policyBundles, pathGuard);
    const guardedLoad = loadPolicyBundles(guardedBundles);

    expect(guardedLoad.ok).toBe(true);
    if (!guardedLoad.ok) {
      throw new Error("Path guard bundle must pass policy load");
    }

    const baselineVerdict = evaluatePolicy(request, guardedLoad.bundles);
    const broadenedVerdict = evaluatePolicy(
      {
        ...structuredClone(request),
        action: {
          ...request.action,
          args: {
            ...request.action.args,
            path: "."
          }
        }
      },
      guardedLoad.bundles
    );

    expect(verdict.status).toBe("allow");
    expect(baselineVerdict.status).toBe("allow");
    expect(broadenedVerdict.status).toBe("deny");
    expect(strictnessOf(broadenedVerdict)).toBeGreaterThan(
      strictnessOf(baselineVerdict)
    );
    expect(broadenedVerdict.matchedRules).toContainEqual({
      ruleId: "runtime.fs_read.deny_workspace_root",
      layer: "runtime_invariant",
      effect: "deny",
      reason: "runtime policy denies broad workspace root reads"
    });
    expect(broadenedVerdict.decisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(broadenedVerdict.decisionHash).not.toBe(
      baselineVerdict.decisionHash
    );
  });
});

type MutationCase = {
  name: string;
  fixtureName: string;
  mutateRequest: (request: PolicyRequest) => PolicyRequest;
  expectedBaseStatus: PolicyVerdictStatus;
  expectedMutatedStatus: PolicyVerdictStatus;
  expectedRuleId: string;
  expectedEffect: PolicyRuleEffect;
};

type FixtureInputs = {
  request: PolicyRequest;
  policyBundles: FixturePolicyBundle[];
  verdict: PolicyVerdict;
};

async function loadFixture(fixtureName: string): Promise<FixtureInputs> {
  const fixtureDir = join(fixturesDir, fixtureName);
  const request = await readJson<PolicyRequest>(join(fixtureDir, "request.json"));
  const policyBundle = await readJson<unknown>(
    join(fixtureDir, "policy-bundle.json")
  );
  const expected = await readJson<PolicyVerdict>(
    join(fixtureDir, "expected-verdict.json")
  );
  const loadResult = loadPolicyBundles(policyBundle);

  expect(loadResult.ok).toBe(true);
  if (!loadResult.ok) {
    throw new Error(`Fixture ${fixtureName} failed policy bundle load`);
  }

  const verdict = evaluatePolicy(request, loadResult.bundles);

  expect(verdict).toEqual(expected);

  return {
    request,
    policyBundles: loadResult.bundles,
    verdict
  };
}

function strictnessOf(verdict: PolicyVerdict) {
  return statusStrictness[verdict.status];
}

function withRuntimeInvariant(
  policyBundles: readonly FixturePolicyBundle[],
  rule: FixturePolicyRule
): FixturePolicyBundle[] {
  const [firstBundle, ...rest] = structuredClone(policyBundles);

  if (firstBundle === undefined) {
    throw new Error("Expected at least one policy bundle");
  }

  return [
    {
      ...firstBundle,
      runtimeInvariants: [...(firstBundle.runtimeInvariants ?? []), rule]
    },
    ...rest
  ];
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
