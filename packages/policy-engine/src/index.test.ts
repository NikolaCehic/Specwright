import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PolicyEvaluatedEventPayloadSchema,
  PolicyVerdictSchema,
  type PolicyEvaluatedEventPayload
} from "@specwright/schemas";
import {
  PolicyRecordError,
  evaluatePolicy,
  loadPolicyBundles,
  toPolicyEvaluatedRecord,
  type FixturePolicyBundle,
  type PolicyRecordContext,
  type PolicyRequest,
  type PolicyVerdict
} from "./index";
import "./bundle-load.test";
import "./conformance.test";
import "./fail-closed.test";
import "./abuse-cases.test";
import "./decision-hash.test";
import "./determinism.test";
import "./mutation.test";
import "./pattern-safety.test";
import "./replay.test";
import "./failure-class-coverage.test";

const fixturesDir = join(import.meta.dir, "../fixtures");

const fixtureCases = [
  "fs-read-allowed-in-evidence",
  "shell-exec-requires-approval",
  "shell-exec-approved",
  "destructive-command-denied",
  "missing-policy-fails-closed",
  "approval-cannot-override-deny",
  "out-of-phase-tool-denied",
  "scope-exceeded-denied",
  "workspace-deny-overrides-harness-allow",
  "multi-bundle-higher-layer-deny",
  "missing-required-scope-denied",
  "scope-union-constrained",
  "budget-exceeded-approval-required",
  "budget-missing-policy-denied",
  "budget-overrun-denied",
  "budget-within-limit-allowed",
  "run-mode-local-dev-allowed",
  "run-mode-ci-denied",
  "host-deny-wins",
  "determinism-reordered-fs-read",
  "replay-equivalent-fs-read",
  "replay-changed-stored-hash",
  "replay-input-drift",
  "replay-unpinned-bundle",
  "self-lowered-risk-still-denied",
  "mismatched-approval-id-ineffective",
  "replayed-approval-ineffective",
  "rejected-approval-ineffective",
  "missing-budget-snapshot-denied",
  "unmetered-resource-denied",
  "injected-source-text-requests-deploy-denied",
  "host-allowlist-absence-denied",
  "workspace-bundle-allows-host-denied-tool",
  "secret-in-args-redacted-denied",
  "tool-output-self-approval-ignored",
  "action-kind-without-tool-id-denied"
];
const recordProjectionCases = [
  {
    fixtureName: "fs-read-allowed-in-evidence",
    status: "allow"
  },
  {
    fixtureName: "out-of-phase-tool-denied",
    status: "deny"
  },
  {
    fixtureName: "budget-exceeded-approval-required",
    status: "approval_required"
  },
  {
    fixtureName: "shell-exec-requires-approval",
    status: "redaction"
  }
] as const;

describe("policy engine fixtures", () => {
  for (const fixtureName of fixtureCases) {
    test(fixtureName, async () => {
      const fixtureDir = join(fixturesDir, fixtureName);
      const request = await readJson(join(fixtureDir, "request.json"));
      const policyBundle = await readJson(join(fixtureDir, "policy-bundle.json"));
      const expected = await readJson(join(fixtureDir, "expected-verdict.json"));
      const loadResult = loadPolicyBundles(policyBundle);
      const expectedBundles = Array.isArray(policyBundle)
        ? policyBundle
        : [policyBundle];

      expect(loadResult).toEqual({
        ok: true,
        bundles: expectedBundles
      });

      const verdict = evaluatePolicy(
        request,
        loadResult.ok ? loadResult.bundles : []
      );

      expect(PolicyVerdictSchema.parse(verdict)).toEqual(verdict);
      expect(verdict).toEqual(expected);
      expect(evaluatePolicy(request, loadResult.ok ? loadResult.bundles : [])).toEqual(
        verdict
      );
    });
  }
});

describe("policy evaluated record projection", () => {
  for (const { fixtureName } of recordProjectionCases) {
    test(`${fixtureName} projects event payload and policy span`, async () => {
      const { record, expected, verdict } = await projectedRecord(fixtureName);

      expect(record).toEqual({
        eventPayload: expected.eventPayload,
        span: expected.span
      });
      expect(PolicyEvaluatedEventPayloadSchema.parse(record.eventPayload)).toEqual(
        record.eventPayload
      );
      expect(record.eventPayload.decisionHash).toBe(verdict.decisionHash);
      expect(record.span.eventIds).toEqual(expected.context.eventIds);
      expect(record.span.metadata?.policyBundleHash).toBe(
        record.eventPayload.policyBundleHash
      );
      expect(record.eventPayload.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.eventPayload.policyBundleHash).toMatch(
        /^sha256:[0-9a-f]{64}$/
      );
      expect(record.eventPayload.decisionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.eventPayload.argsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  }

  test("is deterministic for identical request, verdict, and context", async () => {
    const { request, policyBundle, expected, verdict } = await projectionInputs(
      "fs-read-allowed-in-evidence"
    );
    const first = toPolicyEvaluatedRecord(request, verdict, {
      ...expected.context,
      policyBundles: policyBundle
    });
    const second = toPolicyEvaluatedRecord(request, verdict, {
      ...expected.context,
      policyBundles: policyBundle
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("redacts plaintext action args from payload and span", async () => {
    const { request, record } = await projectedRecord(
      "shell-exec-requires-approval"
    );
    const command = request.action.args?.command;

    expect(typeof command).toBe("string");
    if (typeof command !== "string") {
      throw new Error("redaction fixture command must be a string");
    }

    expect(JSON.stringify(record.eventPayload)).not.toContain(command);
    expect(JSON.stringify(record.span)).not.toContain(command);
    expect(Object.prototype.hasOwnProperty.call(record.eventPayload, "args")).toBe(
      false
    );
  });

  test("fails closed for malformed records before returning", async () => {
    const { request, policyBundle, expected, verdict } = await projectionInputs(
      "shell-exec-requires-approval"
    );
    const context = {
      ...expected.context,
      policyBundles: policyBundle
    };
    const command = request.action.args?.command;

    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        {
          ...verdict,
          decisionHash: ""
        },
        context
      )
    ).toThrow(PolicyRecordError);
    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        {
          ...verdict,
          matchedRules: [
            {
              ...verdict.matchedRules[0],
              ruleId: ""
            }
          ]
        } as PolicyVerdict,
        context
      )
    ).toThrow(PolicyRecordError);
    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        {
          ...verdict,
          obligations: [
            {
              kind: "unknown_obligation",
              sourceRuleId: "tool.shell.exec.default"
            }
          ]
        } as unknown as PolicyVerdict,
        context
      )
    ).toThrow(PolicyRecordError);

    if (typeof command !== "string") {
      throw new Error("redaction fixture command must be a string");
    }

    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        {
          ...verdict,
          constraints: [
            ...verdict.constraints,
            {
              kind: "rawCommand",
              value: command,
              sourceRuleId: "tool.shell.exec.default"
            }
          ]
        },
        context
      )
    ).toThrow(PolicyRecordError);
  });

  test("requires context bundles and checks future verdict bundle hashes", async () => {
    const { request, policyBundle, expected, verdict } = await projectionInputs(
      "fs-read-allowed-in-evidence"
    );
    const context = {
      ...expected.context,
      policyBundles: policyBundle
    };
    const recordWithMatchingVerdictHash = toPolicyEvaluatedRecord(
      request,
      {
        ...verdict,
        policyBundleHash: expected.eventPayload.policyBundleHash
      } as PolicyVerdict,
      context
    );

    expect(recordWithMatchingVerdictHash.eventPayload.policyBundleHash).toBe(
      expected.eventPayload.policyBundleHash
    );
    expect(
      recordWithMatchingVerdictHash.span.metadata?.policyBundleHash
    ).toBe(expected.eventPayload.policyBundleHash);

    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        verdict,
        expected.context as unknown as PolicyRecordContext
      )
    ).toThrow(PolicyRecordError);
    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        verdict,
        {
          ...expected.context,
          policyBundles: [null]
        } as unknown as PolicyRecordContext
      )
    ).toThrow(PolicyRecordError);
    expect(() =>
      toPolicyEvaluatedRecord(
        request,
        {
          ...verdict,
          policyBundleHash:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        } as PolicyVerdict,
        context
      )
    ).toThrow(PolicyRecordError);
  });
});

type ExpectedRecordProjection = {
  sourceFixture: string;
  context: Omit<PolicyRecordContext, "policyBundles">;
  eventPayload: PolicyEvaluatedEventPayload;
  span: unknown;
};

async function projectedRecord(fixtureName: string) {
  const { request, policyBundle, expected, verdict } = await projectionInputs(
    fixtureName
  );
  const record = toPolicyEvaluatedRecord(request, verdict, {
    ...expected.context,
    policyBundles: policyBundle
  });

  return { request, policyBundle, expected, verdict, record };
}

async function projectionInputs(fixtureName: string) {
  const fixtureDir = join(fixturesDir, fixtureName);
  const request = (await readJson(join(fixtureDir, "request.json"))) as PolicyRequest;
  const policyBundle = (await readJson(
    join(fixtureDir, "policy-bundle.json")
  )) as FixturePolicyBundle;
  const expected = (await readJson(
    join(fixtureDir, "expected-record-projection.json")
  )) as ExpectedRecordProjection;
  const loadResult = loadPolicyBundles(policyBundle);

  expect(loadResult.ok).toBe(true);
  if (!loadResult.ok) {
    throw new Error(`Fixture ${fixtureName} failed policy bundle load`);
  }

  const verdict = evaluatePolicy(request, loadResult.bundles);

  return { request, policyBundle: loadResult.bundles, expected, verdict };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
