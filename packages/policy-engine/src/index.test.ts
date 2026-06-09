import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PolicyEvaluatedEventPayloadSchema,
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
import "./policy-validation.test";
import {
  loadPolicyFixtureCorpus,
  readDecisionHashBaseline,
  validatePolicyFixtureCorpus
} from "./policy-validation";

const fixturesDir = join(import.meta.dir, "../fixtures");

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
  test("discovery-driven policy validation gates every fixture directory", async () => {
    const corpus = await loadPolicyFixtureCorpus();
    const baselineRead = await readDecisionHashBaseline();

    expect(baselineRead.ok).toBe(true);
    if (!baselineRead.ok) {
      throw new Error("Decision hash baseline must be readable");
    }

    const report = validatePolicyFixtureCorpus(corpus, baselineRead.baseline);

    expect(report.issues).toEqual([]);
    expect(report.totalFixtureDirectories).toBe(42);
    expect(report.verdictFixtureCount).toBe(36);
    expect(report.nonVerdictFixtureCount).toBe(6);
    expect(report.replayFixtureCount).toBe(4);
    expect(report.decisionHashBaselineEntries).toBe(report.verdictFixtureCount);
  });
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
