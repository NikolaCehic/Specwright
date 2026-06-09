import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluatePolicy,
  loadPolicyBundles,
  type FixturePolicyBundle,
  type PolicyRequest,
  type PolicyVerdict
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("policy abuse-case corpus", () => {
  test("secret-like action args do not appear in verdict fields", async () => {
    const { request, verdict } = await loadFixture("secret-in-args-redacted-denied");
    const rawStrings = rawArgStrings(request.action.args);

    expect(verdict.status).toBe("deny");
    expect(rawStrings).toContain("sk_live_packet05_secret_value");

    for (const raw of rawStrings) {
      expect(JSON.stringify(verdict.reasons)).not.toContain(raw);
      expect(JSON.stringify(verdict.matchedRules.map((rule) => rule.reason))).not.toContain(
        raw
      );
      expect(JSON.stringify(verdict.constraints.map((constraint) => constraint.value))).not.toContain(
        raw
      );
      expect(verdict.decisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(verdict.decisionHash).not.toContain(raw);
    }
  });

  test("budget exhaustion cannot ride a prior allow verdict", async () => {
    const { request, policyBundles, verdict } = await loadFixture(
      "budget-within-limit-allowed"
    );
    const exhaustedRequest: PolicyRequest = {
      ...structuredClone(request),
      snapshots: {
        ...request.snapshots,
        budgets: {
          fileReadBytes: {
            used: 950
          }
        }
      }
    };
    const exhaustedVerdict = evaluatePolicy(exhaustedRequest, policyBundles);

    expect(verdict.status).toBe("allow");
    expect(exhaustedVerdict.status).toBe("deny");
    expect(exhaustedVerdict.decisionHash).not.toBe(verdict.decisionHash);
    expect(exhaustedVerdict.matchedRules).toContainEqual({
      ruleId: "budget.file_read_bytes.deny_max",
      layer: "harness",
      effect: "deny",
      reason: "file read budget would exceed deny limit"
    });
  });

  test("conflicting bundle order cannot flip a deny to allow", async () => {
    const { request, policyBundles, verdict } = await loadFixture(
      "multi-bundle-higher-layer-deny"
    );
    const reversedVerdict = evaluatePolicy(request, [...policyBundles].reverse());

    expect(verdict.status).toBe("deny");
    expect(reversedVerdict.status).toBe("deny");
    expect(reversedVerdict.matchedRules).toEqual(verdict.matchedRules);
  });

  test("workspace policy cannot allow a host-denied tool", async () => {
    const { verdict } = await loadFixture(
      "workspace-bundle-allows-host-denied-tool"
    );

    expect(verdict.status).toBe("deny");
    expect(verdict.matchedRules).toContainEqual({
      ruleId: "host.fs.read.deny",
      layer: "host",
      effect: "deny",
      reason: "Host policy denies fs.read"
    });
  });

  test("tool output cannot self-approve the next call", async () => {
    const { verdict } = await loadFixture("tool-output-self-approval-ignored");

    expect(verdict.status).toBe("approval_required");
    expect(verdict.approvalId).toBe("appr_shell_exec_tests");
    expect(
      verdict.matchedRules.some((rule) => rule.layer === "approval")
    ).toBe(false);
  });

  test("action kind without a tool id still fails closed", async () => {
    const { verdict } = await loadFixture("action-kind-without-tool-id-denied");

    expect(verdict.status).toBe("deny");
    expect(verdict.matchedRules).toContainEqual({
      ruleId: "runtime.missing_policy.fail_closed",
      layer: "runtime_invariant",
      effect: "deny",
      reason: "No applicable policy exists for risky action deploy"
    });
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

function rawArgStrings(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(rawArgStrings);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(rawArgStrings);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
