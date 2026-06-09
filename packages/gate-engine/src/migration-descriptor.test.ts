import { describe, expect, test } from "bun:test";
import { validateMigrationDescriptor } from "./migration-descriptor";

const validDescriptor = {
  id: "gate-engine-1.0.0-to-1.0.1",
  fromEvaluatorVersion: "1.0.0",
  toEvaluatorVersion: "1.0.1",
  class: "migration-required",
  affectedFixtures: ["context-sufficiency-pass"],
  rationale:
    "A governed fixture changed and requires an explicit replay classification.",
  replayImpact: "replay_via_alias"
} as const;

describe("migration descriptor validation", () => {
  test("accepts a valid descriptor whose fixture list matches the actual delta", () => {
    expect(
      validateMigrationDescriptor(validDescriptor, {
        actualChangedFixtures: ["context-sufficiency-pass"]
      })
    ).toEqual({
      ok: true,
      descriptor: validDescriptor
    });
  });

  test("rejects an empty rationale", () => {
    const result = validateMigrationDescriptor({
      ...validDescriptor,
      rationale: "   "
    });

    expect(result.ok).toBe(false);
  });

  test("rejects affected fixture mismatches", () => {
    const result = validateMigrationDescriptor(validDescriptor, {
      actualChangedFixtures: ["policy-denial-blocks"]
    });

    expect(result.ok).toBe(false);
  });
});
