import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadPolicyBundles,
  SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION,
  type FixturePolicyBundle,
  type PolicyRequest,
  type PolicyVerdict
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

const loadFailureFixtures = [
  {
    name: "duplicate-rule-id-fails-load",
    code: "duplicate_rule_id"
  },
  {
    name: "unsafe-pattern-fails-load",
    code: "unsafe_pattern"
  },
  {
    name: "incompatible-schema-version-fails-load",
    code: "incompatible_version"
  },
  {
    name: "invalid-schema-fails-load",
    code: "invalid_schema"
  },
  {
    name: "partial-set-rejected",
    code: "invalid_schema"
  }
] as const;

describe("policy bundle load gate", () => {
  for (const fixture of loadFailureFixtures) {
    test(`${fixture.name} returns frozen load failures`, async () => {
      const fixtureDir = join(fixturesDir, fixture.name);
      const policyBundle = await readJson(join(fixtureDir, "policy-bundle.json"));
      const expected = await readJson(
        join(fixtureDir, "expected-load-failure.json")
      );

      const result = loadPolicyBundles(policyBundle);

      expect(result).toEqual({
        ok: false,
        failures: expected
      });
      expect(result.ok ? [] : result.failures.map((failure) => failure.code)).toContain(
        fixture.code
      );
    });
  }

  test("load failures are deterministic byte-for-byte", async () => {
    const fixtureDir = join(fixturesDir, "invalid-schema-fails-load");
    const policyBundle = await readJson(join(fixtureDir, "policy-bundle.json"));

    const first = loadPolicyBundles(policyBundle);
    const second = loadPolicyBundles(policyBundle);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
  });

  test("absent schemaVersion is admitted as current baseline", () => {
    const result = loadPolicyBundles({
      id: "fixture.absent-version-baseline"
    });

    expect(result).toEqual({
      ok: true,
      bundles: [
        {
          id: "fixture.absent-version-baseline"
        }
      ]
    });
  });

  test("supported schemaVersion is admitted", () => {
    const result = loadPolicyBundles({
      id: "fixture.supported-version",
      schemaVersion: SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION
    });

    expect(result).toEqual({
      ok: true,
      bundles: [
        {
          id: "fixture.supported-version",
          schemaVersion: SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION
        }
      ]
    });
  });

  test("base PolicyBundleSchema failures are classified as invalid_schema", () => {
    const result = loadPolicyBundles({
      id: "",
      scopes: ["workspace:read"]
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.failures).toEqual([
      {
        code: "invalid_schema",
        reason: "String must contain at least 1 character(s)",
        path: "bundles.0.id"
      }
    ]);
  });

  test("synthesized tool rule ids participate in set-wide uniqueness", () => {
    const result = loadPolicyBundles({
      id: "fixture.synthesized-duplicate",
      rules: [
        {
          id: "tool.fs.read.default",
          layer: "workspace",
          effect: "deny",
          reason: "explicit rule collides with synthesized tool default"
        }
      ],
      toolPolicy: {
        "fs.read": {
          default: "allow"
        }
      }
    });

    expect(result).toEqual({
      ok: false,
      failures: [
        {
          code: "duplicate_rule_id",
          reason:
            "Rule id \"tool.fs.read.default\" appears 2 times across the bundle set",
          bundleId: "fixture.synthesized-duplicate",
          ruleId: "tool.fs.read.default",
          path: "bundles.0.rules.0.id"
        }
      ]
    });
  });

  test("load failure denies on the caller path without evaluating a subset", async () => {
    const fixtureDir = join(fixturesDir, "caller-path-load-failure-denies");
    const request = (await readJson(join(fixtureDir, "request.json"))) as PolicyRequest;
    const policyBundle = await readJson(join(fixtureDir, "policy-bundle.json"));
    const expected = await readJson(
      join(fixtureDir, "expected-caller-verdict.json")
    );
    const expectedLoadFailure = await readJson(
      join(fixtureDir, "expected-load-failure.json")
    );
    let evaluatePolicyCalled = false;

    const result = evaluateThroughLoadGate(request, policyBundle, () => {
      evaluatePolicyCalled = true;
      return {
        status: "allow",
        reasons: [],
        constraints: [],
        obligations: [],
        matchedRules: [],
        decisionHash: "sha256:not-used"
      };
    });

    expect(evaluatePolicyCalled).toBe(false);
    expect(result).toEqual(expected);
    expect(loadPolicyBundles(policyBundle)).toEqual({
      ok: false,
      failures: expectedLoadFailure
    });
  });
});

function evaluateThroughLoadGate(
  request: PolicyRequest,
  input: unknown,
  evaluator: (
    request: PolicyRequest,
    bundles: readonly FixturePolicyBundle[]
  ) => PolicyVerdict
) {
  const loadResult = loadPolicyBundles(input);

  if (!loadResult.ok) {
    return {
      status: "deny",
      evaluatePolicyCalled: false,
      loadFailureCodes: loadResult.failures.map((failure) => failure.code)
    };
  }

  const verdict = evaluator(request, loadResult.bundles);

  return {
    status: verdict.status,
    evaluatePolicyCalled: true,
    loadFailureCodes: []
  };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
