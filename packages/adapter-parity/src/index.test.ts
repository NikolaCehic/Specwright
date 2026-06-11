import { describe, expect, test } from "bun:test";
import {
  parityCases,
  registeredParityAdapters,
  type ObservedOutcome
} from "./index";

describe("adapter parity conformance suite", () => {
  test("registry contains the cli reference adapter", () => {
    expect(registeredParityAdapters().map((adapter) => adapter.name)).toEqual([
      "cli"
    ]);
  });

  for (const adapter of registeredParityAdapters()) {
    describe(adapter.name, () => {
      for (const parityCase of parityCases) {
        test(parityCase.name, async () => {
          const outcome = await parityCase.run(adapter);

          parityCase.assert(outcome);
          expect(outcome.adapter).toBe(adapter.name);
          expect(outcome.telemetryOutcome).toBe(outcome.outcome);
        });
      }
    });
  }

  test("case corpus is adapter agnostic and observes normalized outcomes", async () => {
    const adapter = registeredParityAdapters()[0];

    expect(adapter).toBeDefined();
    expect(parityCases.length).toBeGreaterThanOrEqual(7);

    const outcomes: ObservedOutcome[] = [];

    for (const parityCase of parityCases) {
      outcomes.push(await parityCase.run(adapter));
    }

    expect(outcomes.map((outcome) => outcome.operation)).toEqual([
      "startRun",
      "status",
      "events",
      "replay",
      "report",
      "status",
      "approve"
    ]);
  });
});
