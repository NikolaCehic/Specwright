import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluatePolicy } from "./index";

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
  "budget-exceeded-approval-required",
  "host-deny-wins"
];

describe("policy engine fixtures", () => {
  for (const fixtureName of fixtureCases) {
    test(fixtureName, async () => {
      const fixtureDir = join(fixturesDir, fixtureName);
      const request = await readJson(join(fixtureDir, "request.json"));
      const policyBundle = await readJson(join(fixtureDir, "policy-bundle.json"));
      const expected = await readJson(join(fixtureDir, "expected-verdict.json"));

      const verdict = evaluatePolicy(request, policyBundle);

      expect(verdict).toEqual(expected);
      expect(evaluatePolicy(request, policyBundle)).toEqual(verdict);
    });
  }
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
