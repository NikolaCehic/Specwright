import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateGateDefinition } from "./definition";
import { lintGateDefinitionFiles } from "./lint";

describe("gate definition validator", () => {
  test("default harness gate definitions lint clean", async () => {
    const result = await lintGateDefinitionFiles(
      join(import.meta.dir, "../../../harnesses/default/gates")
    );

    expect(result.checked).toBe(5);
    expect(result.issues).toEqual([]);
  });

  test.each([
    [
      "unknown kind",
      {
        id: "bad_kind",
        kind: "unknown",
        checks: []
      },
      "gate.kind.unknown"
    ],
    [
      "unknown check type",
      {
        id: "bad_check",
        kind: "exit",
        checks: [{ id: "unsupported_mode", type: "unsupported_mode" }]
      },
      "gate.check.unsupported_mode.unknown_type"
    ],
    [
      "malformed onFail",
      {
        id: "bad_onfail",
        kind: "exit",
        checks: [],
        onFail: { action: "create_repair_task", successGate: 42 }
      },
      "gate.onFail.malformed"
    ],
    [
      "malformed onPass",
      {
        id: "bad_onpass",
        kind: "exit",
        checks: [],
        onPass: { action: "transition_phase" }
      },
      "gate.onPass.malformed"
    ]
  ])("%s", (_name, definition, findingId) => {
    const validation = validateGateDefinition(definition);

    expect(validation.ok).toBe(false);

    if (!validation.ok) {
      expect(validation.finding.id).toBe(findingId);
    }
  });
});
