import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GateLifecycleInstructionSchema,
  GateVerdictSchema,
  type GateVerdict
} from "@specwright/schemas";
import {
  evaluateGate,
  gateDecisionHashInput,
  hashDecision,
  type EvaluateGateRequest
} from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");
const decisionHashPattern = /^sha256:[0-9a-f]{64}$/;

const fixtureCases = [
  "context-sufficiency-pass",
  "context-sufficiency-missing-context",
  "missing-required-input",
  "artifact-schema-invalid",
  "eval-passed-failed",
  "policy-denial-blocks",
  "missing-gate-definition",
  "gate-definition-id-mismatch",
  "gate-definition-inline-rejected",
  "gate-kind-unknown",
  "gate-check-unsupported-type",
  "gate-onfail-malformed",
  "gate-onpass-malformed"
];

describe("gate engine fixtures", () => {
  for (const fixtureName of fixtureCases) {
    test(fixtureName, async () => {
      const fixtureDir = join(fixturesDir, fixtureName);
      const request = await readJson(join(fixtureDir, "request.json"));
      const expected = await readJson(join(fixtureDir, "expected-result.json"));

      const result = evaluateGate(request);

      expect(GateVerdictSchema.parse(result.verdict)).toEqual(result.verdict);
      expect(GateLifecycleInstructionSchema.parse(result.instruction)).toEqual(
        result.instruction
      );
      expect(result.verdict.decisionHash).toMatch(decisionHashPattern);
      expect(result.verdict.evaluator.kind).toBe("deterministic");
      expect(result).toEqual(expected);
      expect(evaluateGate(request)).toEqual(result);
      expect(recomputedDecisionHash(result.verdict)).toBe(
        expected.verdict.decisionHash
      );
    });
  }
});

describe("gate engine determinism", () => {
  test("ignores wall clock when evaluatedAt is not supplied", async () => {
    const request = await readJson(
      join(fixturesDir, "context-sufficiency-pass", "request.json")
    );
    const baseline = evaluateGate(request);
    const originalNow = Date.now;

    Date.now = () => 4_102_444_800_000;

    try {
      expect(evaluateGate(request)).toEqual(baseline);
    } finally {
      Date.now = originalNow;
    }
  });

  test("core deterministic path avoids external side effects and randomness", async () => {
    const sourceFiles = [
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "decision-hash.ts")
    ];
    const forbiddenPatterns = [
      /from\s+["']node:fs(?:\/promises)?["']/,
      /from\s+["']node:net["']/,
      /from\s+["']node:process["']/,
      /from\s+["']node:http["']/,
      /from\s+["']node:https["']/,
      /\bprocess\.env\b/,
      /\bDate\.now\b/,
      /\bnew\s+Date\s*\(/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bfetch\s*\(/,
      /\bToolBroker\b/,
      /\bproviderClient\b/,
      /\bmodelClient\b/
    ];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");

      for (const forbiddenPattern of forbiddenPatterns) {
        expect(source).not.toMatch(forbiddenPattern);
      }
    }
  });
});

describe("unsupported check defense in depth", () => {
  test("known but unevaluated check types still fail_run if reached", () => {
    const request = {
      gateId: "model_assisted_backstop",
      phase: "verification",
      gateDefinitions: {
        model_assisted_backstop: {
          id: "model_assisted_backstop",
          phase: "verification",
          kind: "eval",
          required: true,
          checks: [
            {
              id: "model_assisted_check",
              type: "model_assisted"
            }
          ],
          onFail: {
            action: "fail_run"
          }
        }
      }
    } as unknown as EvaluateGateRequest;

    const result = evaluateGate(request);

    expect(result.verdict.status).toBe("fail");
    expect(result.verdict.requiredAction).toBe("fail_run");
    expect(result.verdict.findings[0]?.id).toBe("model_assisted_check");
    expect(result.verdict.findings[0]?.message).toBe(
      "Unsupported gate check type model_assisted"
    );
    expect(result.instruction).toEqual({
      kind: "fail_run",
      gateId: "model_assisted_backstop",
      reason: "Unsupported gate check type model_assisted"
    });
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as never;
}

function recomputedDecisionHash(verdict: GateVerdict) {
  const { decisionHash: _decisionHash, ...withoutDecisionHash } = verdict;

  return hashDecision(gateDecisionHashInput(withoutDecisionHash));
}
