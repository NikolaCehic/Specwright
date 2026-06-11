import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  assertCurrentRegistryCompatibility,
  assertReplayEventCompatible,
  assertReplayCorpus,
  loadReplayFixtures
} from "./replay-corpus";

const replayRoot = resolve(import.meta.dir, "../fixtures/replay");
const workspaceRoot = resolve(import.meta.dir, "../fixtures/workspace");

describe("broker replay corpus gate", () => {
  test("validates recorded tool events and fails closed on version incompatibility", async () => {
    const report = await assertReplayCorpus({
      replayRoot,
      workspaceRoot
    });

    expect(report.events).toBeGreaterThanOrEqual(3);
    expect(report.deterministicRehashes).toBeGreaterThanOrEqual(2);
    expect(report.versionIncompatibilities).toBe(1);
  });

  test("negative meta-test: unresolvable replay toolVersion turns the gate red", async () => {
    const fixtures = await loadReplayFixtures(replayRoot);
    const compatible = fixtures.find(
      (fixture) => fixture.expectation === "compatible"
    );

    expect(compatible).toBeDefined();
    if (
      compatible === undefined ||
      (compatible.event.type !== "tool.completed" &&
        compatible.event.type !== "tool.denied")
    ) {
      throw new Error("Compatible replay fixture is missing.");
    }

    const result = JSON.parse(
      JSON.stringify(compatible.event.payload.result)
    ) as typeof compatible.event.payload.result;
    result.provenance.toolVersion = "999.999.999";

    expect(() => assertCurrentRegistryCompatibility(result)).toThrow(
      /incompatible/
    );
  });

  test("negative meta-test: requested-only replay events still resolve the tool", async () => {
    const fixtures = await loadReplayFixtures(replayRoot);
    const requested = fixtures.find(
      (fixture) => fixture.event.type === "tool.requested"
    );

    expect(requested).toBeDefined();
    if (requested === undefined || requested.event.type !== "tool.requested") {
      throw new Error("Requested replay fixture is missing.");
    }

    const event = JSON.parse(JSON.stringify(requested.event)) as typeof requested.event;
    event.payload.request.toolId = "shell.exec";

    await expect(assertReplayEventCompatible(event, workspaceRoot)).rejects.toThrow(
      /unresolvable tool/
    );
  });
});
