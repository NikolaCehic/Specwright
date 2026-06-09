import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HASH_ALGO_VERSION,
  hashDecision,
  hashDecisionWithMetadata,
  hashJson,
  loadPolicyBundles,
  normalizeStable,
  stableStringify,
  type DecisionHashInput,
  type FixturePolicyBundle,
  type PolicyRequest,
  type PolicyVerdict
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("decision hash canonicalization", () => {
  test("exposes v1 metadata without changing existing digest bytes", async () => {
    const { hashInput, expected } = await decisionHashInputFromFixture(
      "fs-read-allowed-in-evidence"
    );

    expect(HASH_ALGO_VERSION).toBe("v1");
    expect(hashDecision(hashInput)).toBe(expected.decisionHash);
    expect(hashDecisionWithMetadata(hashInput)).toEqual({
      hash: expected.decisionHash,
      algoVersion: "v1"
    });
  });

  test("normalizes object keys recursively and drops undefined fields", () => {
    const left = {
      beta: 2,
      alpha: {
        delta: undefined,
        charlie: "stable"
      },
      array: [
        {
          zulu: 3,
          yankee: undefined,
          xray: 1
        }
      ]
    };
    const right = {
      array: [
        {
          xray: 1,
          zulu: 3
        }
      ],
      alpha: {
        charlie: "stable"
      },
      beta: 2
    };

    expect(normalizeStable(left)).toEqual(normalizeStable(right));
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(hashJson(left)).toBe(hashJson(right));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  test("freezes every decision hash input field", async () => {
    const { hashInput, expected } = await decisionHashInputFromFixture(
      "fs-read-allowed-in-evidence"
    );
    const baselineHash = hashDecision(hashInput);
    const mutationCases = [
      {
        name: "requestHash",
        mutate: (input: DecisionHashInput): DecisionHashInput => ({
          ...input,
          requestHash: hashJson({ request: "changed" })
        })
      },
      {
        name: "policyBundleHash",
        mutate: (input: DecisionHashInput): DecisionHashInput => ({
          ...input,
          policyBundleHash: hashJson({ bundle: "changed" })
        })
      },
      {
        name: "matchedRuleIds",
        mutate: (input: DecisionHashInput): DecisionHashInput => ({
          ...input,
          matchedRuleIds: [...input.matchedRuleIds, "policy.hash.extra"]
        })
      },
      {
        name: "status",
        mutate: (input: DecisionHashInput): DecisionHashInput => ({
          ...input,
          status: "deny"
        })
      },
      {
        name: "constraints",
        mutate: (input: DecisionHashInput): DecisionHashInput => ({
          ...input,
          constraints: [
            ...input.constraints,
            {
              kind: "maxBytes",
              value: 131072,
              sourceRuleId: "tool.fs.read.default"
            }
          ]
        })
      },
      {
        name: "obligations",
        mutate: (input: DecisionHashInput): DecisionHashInput => ({
          ...input,
          obligations: [
            ...input.obligations,
            {
              kind: "attach_trace",
              sourceRuleId: "tool.fs.read.default"
            }
          ]
        })
      }
    ] as const;

    expect(baselineHash).toBe(expected.decisionHash);
    for (const mutationCase of mutationCases) {
      expect(hashDecision(mutationCase.mutate(hashInput))).not.toBe(
        baselineHash
      );
    }
  });
});

async function decisionHashInputFromFixture(fixtureName: string) {
  const fixtureDir = join(fixturesDir, fixtureName);
  const request = await readJson<PolicyRequest>(join(fixtureDir, "request.json"));
  const policyBundle = await readJson<FixturePolicyBundle>(
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

  return {
    expected,
    hashInput: {
      requestHash: hashJson(request),
      policyBundleHash: hashJson(loadResult.bundles),
      matchedRuleIds: expected.matchedRules.map((rule) => rule.ruleId),
      status: expected.status,
      constraints: expected.constraints,
      obligations: expected.obligations
    } satisfies DecisionHashInput
  };
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, "utf8")) as TValue;
}
