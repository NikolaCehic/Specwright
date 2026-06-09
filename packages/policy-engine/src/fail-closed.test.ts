import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PolicyRecordError,
  evaluatePolicy,
  hashJson,
  loadPolicyBundles,
  replayPolicyDecision,
  toPolicyEvaluatedRecord,
  type FixturePolicyBundle,
  type PolicyDecisionReplayRecord,
  type PolicyReplayResult,
  type PolicyRequest,
  type PolicyVerdict,
  type PolicyVerdictStatus,
  type RuleMatch
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("policy fail-closed corpus", () => {
  test("caller supplied low risk cannot make a high-risk tool match a low-risk allow", async () => {
    const { verdict } = await loadFixture("self-lowered-risk-still-denied");

    expect(verdict.status).toBe("deny");
    expectRule(verdict, "runtime.missing_policy.fail_closed", {
      effect: "deny",
      reason: "No applicable policy exists for risky action shell.exec"
    });
    expect(
      verdict.matchedRules.some(
        (rule) => rule.ruleId === "harness.low_risk.tool_call.allow"
      )
    ).toBe(false);
  });

  test("missing governed budget usage denies instead of assuming zero usage", async () => {
    const { verdict } = await loadFixture("missing-budget-snapshot-denied");

    expect(verdict.status).toBe("deny");
    expectRule(verdict, "budget.tokens.missing_snapshot", {
      effect: "deny",
      reason: "Budget snapshot is missing for resource tokens"
    });
  });

  test("wrong, replayed, and rejected approvals leave the approval gate unsatisfied", async () => {
    for (const fixtureName of [
      "mismatched-approval-id-ineffective",
      "replayed-approval-ineffective",
      "rejected-approval-ineffective"
    ]) {
      const { verdict } = await loadFixture(fixtureName);

      expect(verdict.status).toBe("approval_required");
      expect(verdict.approvalId).toBe("appr_shell_exec_tests");
      expect(
        verdict.matchedRules.some((rule) => rule.layer === "approval")
      ).toBe(false);
    }
  });

  test("invalid request ingress is treated as deny before evaluation", () => {
    const result = replayPolicyDecision({
      request: {
        requestId: "",
        runId: "run_policy_fixture",
        phase: "verification",
        action: {
          kind: "tool_call",
          toolId: "shell.exec"
        }
      },
      bundles: {
        id: "fixture.ingress-invalid-request"
      },
      requestHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      policyBundleHash:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      storedDecisionHash:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222"
    });

    expect(result.divergenceClass).toBe("unverifiable");
    expect(gateStatusForReplay(result)).toBe("deny");
  });

  test("replay divergence and migration failures deny the replay gate", async () => {
    for (const fixtureName of [
      "replay-changed-stored-hash",
      "replay-input-drift",
      "replay-unpinned-bundle"
    ]) {
      const recorded = await replayRecord(fixtureName);
      const result = replayPolicyDecision(recorded);

      expect(result.equivalent).toBe(false);
      expect(gateStatusForReplay(result)).toBe("deny");
    }
  });

  test("cross-tenant bundle mismatch is rejected before recording", async () => {
    const tenantA = await loadFixture("fs-read-allowed-in-evidence");
    const tenantB = await loadFixture("workspace-deny-overrides-harness-allow");

    expect(() =>
      toPolicyEvaluatedRecord(
        tenantA.request,
        {
          ...tenantA.verdict,
          policyBundleHash: hashJson(tenantA.policyBundles)
        },
        {
          eventIds: ["event:policy:cross-tenant"],
          traceId: "trace:policy:cross-tenant",
          spanId: "span:policy:cross-tenant",
          startedAt: "2026-06-07T00:00:00.000Z",
          endedAt: "2026-06-07T00:00:00.010Z",
          bundleSetRef: "policy-bundle:tenant-b",
          bundleVersions: ["fixture.workspace-deny-overrides-harness-allow"],
          policyBundles: tenantB.policyBundles
        }
      )
    ).toThrow(PolicyRecordError);
  });

  test("policy-engine production source has no ambient side-effect calls", async () => {
    const productionFiles = [
      "bundle-load.ts",
      "decision-hash.ts",
      "index.ts",
      "replay.ts"
    ];
    const blockedPatterns = [
      /\bDate\.now\s*\(/,
      /\bnew\s+Date\s*\(/,
      /\bMath\.random\s*\(/,
      /\bprocess\.env\b/,
      /\bfetch\s*\(/,
      /from\s+["']node:fs/,
      /from\s+["']node:net/,
      /from\s+["']node:http/,
      /from\s+["']node:https/
    ];

    for (const fileName of productionFiles) {
      const source = await readFile(join(import.meta.dir, fileName), "utf8");
      const violations = blockedPatterns.filter((pattern) => pattern.test(source));

      expect(violations).toHaveLength(0);
    }
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

async function replayRecord(
  fixtureName: string
): Promise<PolicyDecisionReplayRecord> {
  const fixtureDir = join(fixturesDir, fixtureName);
  const request = await readJson<unknown>(join(fixtureDir, "request.json"));
  const bundles = await readJson<unknown>(join(fixtureDir, "policy-bundle.json"));
  const recordedDecision = await readJson<{
    storedDecisionHash: PolicyDecisionReplayRecord["storedDecisionHash"];
    hashAlgoVersion?: PolicyDecisionReplayRecord["hashAlgoVersion"];
    requestHash?: PolicyDecisionReplayRecord["requestHash"];
    policyBundleHash?: PolicyDecisionReplayRecord["policyBundleHash"];
  }>(join(fixtureDir, "recorded-decision.json"));

  return {
    request,
    bundles,
    storedDecisionHash: recordedDecision.storedDecisionHash,
    hashAlgoVersion: recordedDecision.hashAlgoVersion,
    requestHash: recordedDecision.requestHash,
    policyBundleHash: recordedDecision.policyBundleHash
  };
}

function gateStatusForReplay(result: PolicyReplayResult): PolicyVerdictStatus {
  return result.equivalent && isPolicyVerdictStatus(result.status)
    ? result.status
    : "deny";
}

function isPolicyVerdictStatus(
  status: PolicyReplayResult["status"]
): status is PolicyVerdictStatus {
  return status === "allow" || status === "deny" || status === "approval_required";
}

function expectRule(
  verdict: PolicyVerdict,
  ruleId: string,
  expected: {
    effect: RuleMatch["effect"];
    reason: string;
  }
) {
  const rule = verdict.matchedRules.find((candidate) => candidate.ruleId === ruleId);

  expect(rule).toBeDefined();
  if (rule === undefined) {
    throw new Error(`Expected matched rule ${ruleId}`);
  }

  expect(rule.effect).toBe(expected.effect);
  expect(rule.reason).toBe(expected.reason);
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
