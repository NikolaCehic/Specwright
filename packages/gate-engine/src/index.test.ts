import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GateLifecycleInstructionSchema,
  GateVerdictSchema
} from "@specwright/schemas";
import { evaluateGate, type EvaluateGateRequest } from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

const fixtureCases = [
  "context-sufficiency-pass",
  "context-sufficiency-missing-context",
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
      expect(result).toEqual(expected);
      expect(evaluateGate(request)).toEqual(result);
    });
  }
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
