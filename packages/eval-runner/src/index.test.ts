import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EvalVerdictSchema,
  EvalVerdictStatusSchema
} from "@specwright/schemas";
import { runEval, type RunEvalRequest } from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");

const fixtureCases = [
  "schema-pass",
  "schema-fail-blocking",
  "source-fidelity-pass",
  "source-fidelity-missing-evidence",
  "completeness-missing-section",
  "unsupported-model-assisted"
];

describe("eval runner fixtures", () => {
  test("uses the repaired-aware shared eval status contract", () => {
    expect(EvalVerdictStatusSchema.options).toContain("repaired");
  });

  for (const fixtureName of fixtureCases) {
    test(fixtureName, async () => {
      const fixtureDir = join(fixturesDir, fixtureName);
      const request = (await readJson(join(
        fixtureDir,
        "request.json"
      ))) as RunEvalRequest;
      const expected = await readJson(join(fixtureDir, "expected-verdict.json"));

      const result = runEval(request);

      expect(EvalVerdictSchema.parse(result)).toEqual(result);
      expect(result).toEqual(expected);
      expect(runEval(request)).toEqual(result);
    });
  }
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
