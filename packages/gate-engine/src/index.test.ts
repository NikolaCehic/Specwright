import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GateLifecycleInstructionSchema,
  GateVerdictSchema
} from "@specwright/schemas";
import { evaluateGate } from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

const fixtureCases = [
  "context-sufficiency-pass",
  "context-sufficiency-missing-context",
  "artifact-schema-invalid",
  "eval-passed-failed",
  "policy-denial-blocks",
  "missing-gate-definition"
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

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as never;
}
