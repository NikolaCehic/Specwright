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
  type PolicyVerdictStatus
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");
const failClosedStatuses = ["deny", "approval_required"] as const;
type FailClosedStatus = (typeof failClosedStatuses)[number];
type CoverageStatus = PolicyVerdictStatus | "covered_elsewhere";

const requiredFailureClassIds = [
  "invalid_request_shape",
  "unknown_unmatched_action",
  "missing_or_stale_snapshot",
  "partial_failure_bundle_set",
  "policy_denial",
  "approval_timeout",
  "approval_rejection_wrong_target",
  "approval_overreach",
  "schema_incompatibility",
  "replay_divergence",
  "migration_failure",
  "audit_trace_gap",
  "obligation_not_discharged",
  "malformed_regex_pathological_matcher",
  "duplicate_conflicting_rule_ids",
  "nondeterminism_attempt",
  "cross_tenant_bundle_contamination"
] as const;
type FailureClassId = (typeof requiredFailureClassIds)[number];

const requiredAbuseCaseIds = [
  "injected_source_text_requests_deploy",
  "proposal_sets_low_risk_on_shell_exec",
  "broad_requested_scopes_beyond_grant",
  "workspace_bundle_allows_host_denied_tool",
  "replayed_stale_approval",
  "tampered_or_absent_host_allowlist",
  "budget_exhaust_then_cached_allow",
  "secret_in_args_would_leak_verdict",
  "redos_authored_pattern",
  "conflicting_bundles_ordering_flip",
  "duplicate_rule_id_hides_deny",
  "tool_output_self_approves_next_call",
  "missing_budget_snapshot_unlimited_budget_claim",
  "action_kind_without_tool_id_dodges_policy"
] as const;
type AbuseCaseId = (typeof requiredAbuseCaseIds)[number];

type CoverageEntry<TId extends string> =
  | {
      id: TId;
      kind: "fixture";
      fixtureName: string;
      assertedStatus: FailClosedStatus;
      control: string;
    }
  | {
      id: TId;
      kind: "redaction_fixture";
      fixtureName: string;
      assertedStatus: FailClosedStatus;
      control: string;
    }
  | {
      id: TId;
      kind: "load_failure";
      fixtureName: string;
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "ingress_gate";
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "replay_gate";
      fixtureName: string;
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "purity_static_guard";
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "record_bundle_hash_guard";
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "budget_cache_guard";
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "bundle_order_guard";
      assertedStatus: "deny";
      control: string;
    }
  | {
      id: TId;
      kind: "covered_elsewhere";
      assertedStatus: "covered_elsewhere";
      control: string;
    };

const failureClassCoverage = [
  {
    id: "invalid_request_shape",
    kind: "ingress_gate",
    assertedStatus: "deny",
    control: "request ingress validation rejects malformed records"
  },
  {
    id: "unknown_unmatched_action",
    kind: "fixture",
    fixtureName: "missing-policy-fails-closed",
    assertedStatus: "deny",
    control: "runtime.missing_policy.fail_closed"
  },
  {
    id: "missing_or_stale_snapshot",
    kind: "fixture",
    fixtureName: "missing-budget-snapshot-denied",
    assertedStatus: "deny",
    control: "budget.tokens.missing_snapshot"
  },
  {
    id: "partial_failure_bundle_set",
    kind: "load_failure",
    fixtureName: "partial-set-rejected",
    assertedStatus: "deny",
    control: "load gate rejects the whole bundle set"
  },
  {
    id: "policy_denial",
    kind: "fixture",
    fixtureName: "destructive-command-denied",
    assertedStatus: "deny",
    control: "runtime.shell.deny_destructive_reset"
  },
  {
    id: "approval_timeout",
    kind: "fixture",
    fixtureName: "shell-exec-requires-approval",
    assertedStatus: "approval_required",
    control: "unsatisfied approval remains pending"
  },
  {
    id: "approval_rejection_wrong_target",
    kind: "fixture",
    fixtureName: "rejected-approval-ineffective",
    assertedStatus: "approval_required",
    control: "findApprovalDecision ignores rejected decisions"
  },
  {
    id: "approval_overreach",
    kind: "fixture",
    fixtureName: "approval-cannot-override-deny",
    assertedStatus: "deny",
    control: "deny scan precedes approval handling"
  },
  {
    id: "schema_incompatibility",
    kind: "load_failure",
    fixtureName: "incompatible-schema-version-fails-load",
    assertedStatus: "deny",
    control: "bundle schema version gate"
  },
  {
    id: "replay_divergence",
    kind: "replay_gate",
    fixtureName: "replay-changed-stored-hash",
    assertedStatus: "deny",
    control: "hash mismatch blocks replay acceptance"
  },
  {
    id: "migration_failure",
    kind: "replay_gate",
    fixtureName: "replay-unpinned-bundle",
    assertedStatus: "deny",
    control: "unpinned bundle is unreplayable"
  },
  {
    id: "audit_trace_gap",
    kind: "covered_elsewhere",
    assertedStatus: "covered_elsewhere",
    control: "post-decision trace-to-log reconciliation owns this class"
  },
  {
    id: "obligation_not_discharged",
    kind: "covered_elsewhere",
    assertedStatus: "covered_elsewhere",
    control: "post-decision obligation reconciliation owns this class"
  },
  {
    id: "malformed_regex_pathological_matcher",
    kind: "load_failure",
    fixtureName: "unsafe-pattern-fails-load",
    assertedStatus: "deny",
    control: "pattern safety load gate"
  },
  {
    id: "duplicate_conflicting_rule_ids",
    kind: "load_failure",
    fixtureName: "duplicate-rule-id-fails-load",
    assertedStatus: "deny",
    control: "rule-id uniqueness load gate"
  },
  {
    id: "nondeterminism_attempt",
    kind: "purity_static_guard",
    assertedStatus: "deny",
    control: "production source has no ambient I/O, clock, env, or random calls"
  },
  {
    id: "cross_tenant_bundle_contamination",
    kind: "record_bundle_hash_guard",
    assertedStatus: "deny",
    control: "recording rejects bundle-hash mismatch"
  }
] as const satisfies readonly CoverageEntry<FailureClassId>[];

const abuseCaseCoverage = [
  {
    id: "injected_source_text_requests_deploy",
    kind: "fixture",
    fixtureName: "injected-source-text-requests-deploy-denied",
    assertedStatus: "deny",
    control: "runtime.missing_policy.fail_closed"
  },
  {
    id: "proposal_sets_low_risk_on_shell_exec",
    kind: "fixture",
    fixtureName: "self-lowered-risk-still-denied",
    assertedStatus: "deny",
    control: "tool-derived risk floor blocks low-risk allow"
  },
  {
    id: "broad_requested_scopes_beyond_grant",
    kind: "fixture",
    fixtureName: "scope-exceeded-denied",
    assertedStatus: "deny",
    control: "tool.fs.read.scope"
  },
  {
    id: "workspace_bundle_allows_host_denied_tool",
    kind: "fixture",
    fixtureName: "workspace-bundle-allows-host-denied-tool",
    assertedStatus: "deny",
    control: "host.fs.read.deny"
  },
  {
    id: "replayed_stale_approval",
    kind: "fixture",
    fixtureName: "replayed-approval-ineffective",
    assertedStatus: "approval_required",
    control: "approvalId exact match"
  },
  {
    id: "tampered_or_absent_host_allowlist",
    kind: "fixture",
    fixtureName: "host-allowlist-absence-denied",
    assertedStatus: "deny",
    control: "host.shell.exec.not_allowed"
  },
  {
    id: "budget_exhaust_then_cached_allow",
    kind: "budget_cache_guard",
    assertedStatus: "deny",
    control: "budget snapshot is re-evaluated per request"
  },
  {
    id: "secret_in_args_would_leak_verdict",
    kind: "redaction_fixture",
    fixtureName: "secret-in-args-redacted-denied",
    assertedStatus: "deny",
    control: "verdict omits raw args"
  },
  {
    id: "redos_authored_pattern",
    kind: "load_failure",
    fixtureName: "unsafe-pattern-fails-load",
    assertedStatus: "deny",
    control: "pattern safety load gate"
  },
  {
    id: "conflicting_bundles_ordering_flip",
    kind: "bundle_order_guard",
    assertedStatus: "deny",
    control: "deny dominance holds under bundle reordering"
  },
  {
    id: "duplicate_rule_id_hides_deny",
    kind: "load_failure",
    fixtureName: "duplicate-rule-id-fails-load",
    assertedStatus: "deny",
    control: "rule-id uniqueness load gate"
  },
  {
    id: "tool_output_self_approves_next_call",
    kind: "fixture",
    fixtureName: "tool-output-self-approval-ignored",
    assertedStatus: "approval_required",
    control: "only approval snapshots satisfy approval_required"
  },
  {
    id: "missing_budget_snapshot_unlimited_budget_claim",
    kind: "fixture",
    fixtureName: "missing-budget-snapshot-denied",
    assertedStatus: "deny",
    control: "budget.tokens.missing_snapshot"
  },
  {
    id: "action_kind_without_tool_id_dodges_policy",
    kind: "fixture",
    fixtureName: "action-kind-without-tool-id-denied",
    assertedStatus: "deny",
    control: "runtime.missing_policy.fail_closed"
  }
] as const satisfies readonly CoverageEntry<AbuseCaseId>[];

describe("policy failure and abuse coverage guard", () => {
  test("enumerates every required failure class exactly once", () => {
    expect(sortedIds(failureClassCoverage)).toEqual(
      sortedValues(requiredFailureClassIds)
    );
    expect(new Set(failureClassCoverage.map((entry) => entry.id)).size).toBe(
      requiredFailureClassIds.length
    );
  });

  test("enumerates every required abuse case exactly once", () => {
    expect(sortedIds(abuseCaseCoverage)).toEqual(sortedValues(requiredAbuseCaseIds));
    expect(new Set(abuseCaseCoverage.map((entry) => entry.id)).size).toBe(
      requiredAbuseCaseIds.length
    );
  });

  test("all engine and load failure classes are fail-closed or covered elsewhere", async () => {
    for (const entry of failureClassCoverage) {
      const status = await statusForCoverage(entry);

      expect(status).toBe(entry.assertedStatus);
      expect(status === "allow").toBe(false);
    }
  });

  test("all abuse cases are defeated by deny or approval-required controls", async () => {
    for (const entry of abuseCaseCoverage) {
      const status = await statusForCoverage(entry);

      expect(status).toBe(entry.assertedStatus);
      expect(status === "allow").toBe(false);
    }
  });
});

async function statusForCoverage<TId extends string>(
  entry: CoverageEntry<TId>
): Promise<CoverageStatus> {
  switch (entry.kind) {
    case "fixture":
      return (await loadFixture(entry.fixtureName)).verdict.status;
    case "redaction_fixture":
      return redactionFixtureStatus(entry.fixtureName);
    case "load_failure":
      return loadFailureStatus(entry.fixtureName);
    case "ingress_gate":
      return invalidRequestIngressStatus();
    case "replay_gate":
      return replayGateStatus(entry.fixtureName);
    case "purity_static_guard":
      return purityGuardStatus();
    case "record_bundle_hash_guard":
      return recordBundleHashGuardStatus();
    case "budget_cache_guard":
      return budgetCacheGuardStatus();
    case "bundle_order_guard":
      return bundleOrderGuardStatus();
    case "covered_elsewhere":
      expect(entry.control.length).toBeGreaterThan(0);
      return "covered_elsewhere";
    default:
      return assertNever(entry);
  }
}

async function redactionFixtureStatus(
  fixtureName: string
): Promise<FailClosedStatus> {
  const { request, verdict } = await loadFixture(fixtureName);
  const rawStrings = rawArgStrings(request.action.args);

  expect(rawStrings.length).toBeGreaterThan(0);
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

  return verdict.status;
}

async function loadFailureStatus(fixtureName: string): Promise<"deny"> {
  const fixtureDir = join(fixturesDir, fixtureName);
  const policyBundle = await readJson<unknown>(
    join(fixtureDir, "policy-bundle.json")
  );
  const loadResult = loadPolicyBundles(policyBundle);

  expect(loadResult.ok).toBe(false);

  return "deny";
}

function invalidRequestIngressStatus(): "deny" {
  const result = replayPolicyDecision({
    request: {
      requestId: "",
      runId: "run_policy_fixture",
      phase: "verification",
      action: {
        kind: "tool_call"
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

  return gateStatusForReplay(result);
}

async function replayGateStatus(fixtureName: string): Promise<"deny"> {
  const result = replayPolicyDecision(await replayRecord(fixtureName));

  expect(result.equivalent).toBe(false);

  return gateStatusForReplay(result);
}

async function purityGuardStatus(): Promise<"deny"> {
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

    expect(blockedPatterns.some((pattern) => pattern.test(source))).toBe(false);
  }

  return "deny";
}

async function recordBundleHashGuardStatus(): Promise<"deny"> {
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
        eventIds: ["event:policy:tenant-guard"],
        traceId: "trace:policy:tenant-guard",
        spanId: "span:policy:tenant-guard",
        startedAt: "2026-06-07T00:00:00.000Z",
        endedAt: "2026-06-07T00:00:00.010Z",
        bundleSetRef: "policy-bundle:tenant-b",
        bundleVersions: ["fixture.workspace-deny-overrides-harness-allow"],
        policyBundles: tenantB.policyBundles
      }
    )
  ).toThrow(PolicyRecordError);

  return "deny";
}

async function budgetCacheGuardStatus(): Promise<"deny"> {
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
  expect(exhaustedVerdict.decisionHash).not.toBe(verdict.decisionHash);

  return requireFailClosedStatus(exhaustedVerdict.status);
}

async function bundleOrderGuardStatus(): Promise<"deny"> {
  const { request, policyBundles, verdict } = await loadFixture(
    "multi-bundle-higher-layer-deny"
  );
  const reversedVerdict = evaluatePolicy(request, [...policyBundles].reverse());

  expect(verdict.status).toBe("deny");
  expect(reversedVerdict.matchedRules).toEqual(verdict.matchedRules);

  return requireFailClosedStatus(reversedVerdict.status);
}

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

function gateStatusForReplay(result: PolicyReplayResult): "deny" {
  expect(result.equivalent).toBe(false);
  return "deny";
}

function requireFailClosedStatus(status: PolicyVerdictStatus): FailClosedStatus {
  expect(failClosedStatuses).toContain(status);
  if (status === "allow") {
    throw new Error("Expected deny or approval_required");
  }

  return status;
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

function sortedIds<TId extends string>(
  entries: readonly CoverageEntry<TId>[]
): string[] {
  return entries.map((entry) => entry.id).sort();
}

function sortedValues(values: readonly string[]): string[] {
  return [...values].sort();
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled coverage entry ${String(value)}`);
}
