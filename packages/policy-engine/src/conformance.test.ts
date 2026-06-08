import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluatePolicy,
  loadPolicyBundles,
  type FixturePolicyBundle,
  type PolicyRequest,
  type PolicyRuleEffect,
  type PolicyRuleLayer,
  type PolicyVerdict,
  type PolicyVerdictStatus,
  type RuleMatch
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");
const statusStrictness: Record<PolicyVerdictStatus, number> = {
  allow: 0,
  approval_required: 1,
  deny: 2
};

describe("policy engine architecture conformance", () => {
  test("existing conflict fixtures lock deny dominance and approval subordination", async () => {
    const host = await loadFixture("host-deny-wins");
    const approvalConflict = await loadFixture("approval-cannot-override-deny");
    const outOfPhase = await loadFixture("out-of-phase-tool-denied");
    const scopeExceeded = await loadFixture("scope-exceeded-denied");

    expect(host.verdict.status).toBe("deny");
    expectRule(host.verdict, "host.fs_read.denied", {
      layer: "host",
      effect: "deny",
      reason: "host policy denies fs.read"
    });
    expectRule(host.verdict, "tool.fs.read.default", {
      layer: "capability",
      effect: "allow",
      reason: "fs.read is allowed for source and evidence discovery"
    });

    expect(approvalConflict.verdict.status).toBe("deny");
    expectRule(approvalConflict.verdict, "runtime.shell.deny_destructive_reset", {
      layer: "runtime_invariant",
      effect: "deny",
      reason: "runtime policy denies destructive workspace reset"
    });
    expectRule(approvalConflict.verdict, "tool.shell.exec.default", {
      layer: "capability",
      effect: "approval_required",
      reason: "shell.exec requires explicit approval"
    });
    expect(
      approvalConflict.verdict.matchedRules.some(
        (rule) => rule.layer === "approval"
      )
    ).toBe(false);

    expect(outOfPhase.verdict.status).toBe("deny");
    expectRule(outOfPhase.verdict, "tool.fs.read.phase", {
      layer: "phase",
      effect: "deny",
      reason: "Tool fs.read is not allowed in phase synthesis"
    });

    expect(scopeExceeded.verdict.status).toBe("deny");
    expectRule(scopeExceeded.verdict, "tool.fs.read.scope", {
      layer: "capability",
      effect: "deny",
      reason: "Tool fs.read requested scope workspace:write:direct outside policy"
    });
  });

  test("layered precedence is monotone-stricter for single and multi-bundle composition", async () => {
    const workspaceNarrowsHarness = await loadFixture(
      "workspace-deny-overrides-harness-allow"
    );
    const multiBundle = await loadFixture("multi-bundle-higher-layer-deny");
    const harnessOnlyBundle = firstBundle(multiBundle.policyBundles);
    const harnessOnlyVerdict = evaluatePolicy(multiBundle.request, [
      harnessOnlyBundle
    ]);

    expect(workspaceNarrowsHarness.verdict.status).toBe("deny");
    expect(workspaceNarrowsHarness.verdict.matchedRules).toEqual([
      {
        ruleId: "workspace.git_push.denied",
        layer: "workspace",
        effect: "deny",
        reason: "workspace policy denies git.push"
      },
      {
        ruleId: "harness.git_push.allow",
        layer: "harness",
        effect: "allow",
        reason: "harness policy allows git.push"
      }
    ]);

    expect(harnessOnlyVerdict.status).toBe("allow");
    expect(multiBundle.verdict.status).toBe("deny");
    expect(strictnessOf(multiBundle.verdict)).toBeGreaterThan(
      strictnessOf(harnessOnlyVerdict)
    );
    expect(multiBundle.verdict.matchedRules).toEqual([
      {
        ruleId: "workspace.fs_read.denied",
        layer: "workspace",
        effect: "deny",
        reason: "workspace bundle denies fs.read"
      },
      {
        ruleId: "harness.fs_read.allow",
        layer: "harness",
        effect: "allow",
        reason: "harness bundle allows fs.read"
      }
    ]);
  });

  test("scope policy denies missing and escalated scopes, then constrains in-policy requests", async () => {
    const missingRequired = await loadFixture("missing-required-scope-denied");
    const scopeExceeded = await loadFixture("scope-exceeded-denied");
    const constrained = await loadFixture("scope-union-constrained");

    expect(missingRequired.verdict.status).toBe("deny");
    expectRule(missingRequired.verdict, "tool.fs.read.scope", {
      layer: "capability",
      effect: "deny",
      reason: "Tool fs.read is missing required scope workspace:read"
    });

    expect(scopeExceeded.verdict.status).toBe("deny");
    expectRule(scopeExceeded.verdict, "tool.fs.read.scope", {
      layer: "capability",
      effect: "deny",
      reason: "Tool fs.read requested scope workspace:write:direct outside policy"
    });

    expect(constrained.verdict.status).toBe("allow");
    expectRule(constrained.verdict, "tool.fs.read.scope", {
      layer: "capability",
      effect: "constrain",
      reason: "Tool fs.read scopes are within policy"
    });
    expect(expectConstraint(constrained.verdict, "allowedScopes")).toEqual({
      kind: "allowedScopes",
      value: ["workspace:read", "evidence:read", "agent:observe"],
      sourceRuleId: "tool.fs.read.scope"
    });
  });

  test("budget policy fails closed for unmetered spend and applies overrun effects", async () => {
    const missingPolicy = await loadFixture("budget-missing-policy-denied");
    const overrunDenied = await loadFixture("budget-overrun-denied");
    const overrunApproval = await loadFixture(
      "budget-exceeded-approval-required"
    );
    const withinLimit = await loadFixture("budget-within-limit-allowed");

    expect(missingPolicy.verdict.status).toBe("deny");
    expectRule(missingPolicy.verdict, "budget.tokens.missing_policy", {
      layer: "harness",
      effect: "deny",
      reason: "No budget policy exists for resource tokens"
    });

    expect(overrunDenied.verdict.status).toBe("deny");
    expectRule(overrunDenied.verdict, "budget.file_read_bytes.deny_max", {
      layer: "harness",
      effect: "deny",
      reason: "file read budget would exceed deny limit"
    });
    expect(expectConstraint(overrunDenied.verdict, "budget.max")).toEqual({
      kind: "budget.max",
      value: {
        resource: "fileReadBytes",
        max: 1000
      },
      sourceRuleId: "budget.file_read_bytes.deny_max"
    });

    expect(overrunApproval.verdict.status).toBe("approval_required");
    expect(overrunApproval.verdict.approvalId).toBe("appr_file_read_budget");
    expectRule(overrunApproval.verdict, "budget.file_read_bytes.max", {
      layer: "harness",
      effect: "approval_required",
      reason: "file read budget would exceed policy limit"
    });

    expect(withinLimit.verdict.status).toBe("allow");
    expect(
      withinLimit.verdict.matchedRules.some((rule) =>
        rule.ruleId.startsWith("budget.")
      )
    ).toBe(false);
    expect(
      withinLimit.verdict.constraints.some(
        (constraint) => constraint.kind === "budget.max"
      )
    ).toBe(false);
  });

  test("ci run mode is stricter-or-equal to local development for the same action", async () => {
    const localDev = await loadFixture("run-mode-local-dev-allowed");
    const ci = await loadFixture("run-mode-ci-denied");

    expect(localDev.request.action).toEqual(ci.request.action);
    expect(localDev.verdict.status).toBe("allow");
    expect(ci.verdict.status).toBe("deny");
    expect(strictnessOf(ci.verdict)).toBeGreaterThanOrEqual(
      strictnessOf(localDev.verdict)
    );
    expect(strictnessOf(ci.verdict)).toBeGreaterThan(
      strictnessOf(localDev.verdict)
    );
    expectRule(ci.verdict, "run_mode.ci.model_prompt.denied", {
      layer: "run_mode",
      effect: "deny",
      reason: "ci run mode denies prompt generation"
    });
    expect(
      localDev.verdict.matchedRules.some(
        (rule) => rule.ruleId === "run_mode.ci.model_prompt.denied"
      )
    ).toBe(false);
  });
});

type FixtureInputs = {
  request: PolicyRequest;
  policyBundles: FixturePolicyBundle[];
  expected: PolicyVerdict;
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
    expected,
    verdict
  };
}

function expectRule(
  verdict: PolicyVerdict,
  ruleId: string,
  expected: {
    layer: PolicyRuleLayer;
    effect: PolicyRuleEffect;
    reason: string;
  }
) {
  const rule = requireRule(verdict, ruleId);

  expect(rule).toEqual({
    ruleId,
    ...expected
  });
}

function requireRule(verdict: PolicyVerdict, ruleId: string): RuleMatch {
  const rule = verdict.matchedRules.find((candidate) => candidate.ruleId === ruleId);

  expect(rule).toBeDefined();
  if (rule === undefined) {
    throw new Error(`Expected matched rule ${ruleId}`);
  }

  return rule;
}

function expectConstraint(verdict: PolicyVerdict, kind: string) {
  const constraint = verdict.constraints.find(
    (candidate) => candidate.kind === kind
  );

  expect(constraint).toBeDefined();
  if (constraint === undefined) {
    throw new Error(`Expected constraint ${kind}`);
  }

  return constraint;
}

function firstBundle(bundles: readonly FixturePolicyBundle[]) {
  const bundle = bundles[0];

  if (bundle === undefined) {
    throw new Error("Expected at least one policy bundle");
  }

  return bundle;
}

function strictnessOf(verdict: PolicyVerdict) {
  return statusStrictness[verdict.status];
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
