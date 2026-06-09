import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectDefinitionChange } from "./definition-change";
import { buildGateAuditRecord, evaluateGate } from "./index";
import { hashGateDefinition, hashMissingGateDefinition } from "./definition-hash";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("gate definition hash", () => {
  test("is stable across object key ordering", async () => {
    const request = await readJson(
      join(fixturesDir, "context-sufficiency-pass", "request.json")
    );
    const baseline = hashGateDefinition(request.gateDefinition);
    const reordered = {
      onFail: request.gateDefinition.onFail,
      checks: request.gateDefinition.checks,
      inputs: request.gateDefinition.inputs,
      required: request.gateDefinition.required,
      kind: request.gateDefinition.kind,
      phase: request.gateDefinition.phase,
      id: request.gateDefinition.id
    };

    expect(hashGateDefinition(reordered)).toBe(baseline);
  });

  test("matches the audit record definition hash for resolved gates", async () => {
    const request = await readJson(
      join(fixturesDir, "context-sufficiency-pass", "request.json")
    );
    const result = evaluateGate(request);
    const audit = buildGateAuditRecord({ request, result });

    expect(audit.definitionHash).toBe(hashGateDefinition(request.gateDefinition));
  });

  test("ignores non-governed definition extras but reacts to semantic changes", async () => {
    const request = await readJson(
      join(fixturesDir, "context-sufficiency-pass", "request.json")
    );
    const baselineDefinition = request.gateDefinition;
    const baselineHash = hashGateDefinition(baselineDefinition);
    const baselineResult = evaluateGate(request);
    const ignoredExtraDefinition = {
      ...baselineDefinition,
      ignoredByEvaluation: {
        note: "non-governed extra"
      },
      checks: baselineDefinition.checks.map((check: Record<string, unknown>) => ({
        ...check,
        ignoredNestedExtra: true
      }))
    };

    expect(
      evaluateGate({
        ...request,
        gateDefinition: ignoredExtraDefinition
      })
    ).toEqual(baselineResult);
    expect(hashGateDefinition(ignoredExtraDefinition)).toBe(baselineHash);
    expect(
      detectDefinitionChange({
        gateId: request.gateId,
        pinnedDefinitionHash: baselineHash,
        currentDefinition: ignoredExtraDefinition
      })
    ).toEqual({ changed: false });

    const semanticChangeDefinition = {
      ...baselineDefinition,
      checks: baselineDefinition.checks.map((check: Record<string, unknown>) =>
        check.id === "goal_known"
          ? {
              ...check,
              path: "$.run_input.nonexistent"
            }
          : check
      )
    };

    expect(hashGateDefinition(semanticChangeDefinition)).not.toBe(baselineHash);
    expect(
      detectDefinitionChange({
        gateId: request.gateId,
        pinnedDefinitionHash: baselineHash,
        currentDefinition: semanticChangeDefinition
      })
    ).toEqual(
      expect.objectContaining({
        changed: true,
        gateId: request.gateId,
        from: baselineHash,
        signal: "gate.definition.changed"
      })
    );
  });

  test("uses a deterministic sentinel for missing definitions", () => {
    expect(hashMissingGateDefinition("missing-gate")).toBe(
      hashMissingGateDefinition("missing-gate")
    );
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
