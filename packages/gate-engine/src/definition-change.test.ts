import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectDefinitionChange } from "./definition-change";
import { hashGateDefinition } from "./definition-hash";

const fixtureDir = join(import.meta.dir, "../fixtures/definition-changed");

describe("gate.definition.changed detection", () => {
  test("emits the signal when the pinned and current definition hashes differ", async () => {
    const request = await readJson(join(fixtureDir, "request.json"));
    const expected = await readJson(join(fixtureDir, "expected-signal.json"));

    expect(detectDefinitionChange(request)).toEqual(expected);
  });

  test("returns changed false when the definition hash is unchanged", async () => {
    const request = await readJson(join(fixtureDir, "request.json"));

    expect(
      detectDefinitionChange({
        gateId: request.gateId,
        pinnedDefinitionHash: hashGateDefinition(request.currentDefinition),
        currentDefinition: request.currentDefinition
      })
    ).toEqual({ changed: false });
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
