import { describe, expect, test } from "bun:test";
import {
  CompatibilityClassSchema,
  EngineChangelogEntrySchema
} from "./compatibility";
import {
  BASELINE_ENGINE_CHANGELOG_ENTRY,
  ENGINE_CHANGELOG,
  LATEST_ENGINE_CHANGELOG_ENTRY,
  assertEngineChangelogInvariants
} from "./engine-changelog";
import { DEFAULT_GATE_ENGINE_EVALUATOR, parseEvaluatorRef } from "./evaluator-identity";
import { GATE_ENGINE_EVALUATOR_VERSION } from "./gate-contract-version";

describe("gate compatibility classification", () => {
  test("declares the full compatibility taxonomy and a baseline changelog entry", () => {
    expect(CompatibilityClassSchema.options).toHaveLength(6);
    expect(BASELINE_ENGINE_CHANGELOG_ENTRY.version).toBe("1.0.0");
    expect(BASELINE_ENGINE_CHANGELOG_ENTRY.class).toBe("forward-compatible");
    expect(ENGINE_CHANGELOG).toHaveLength(1);
  });

  test("current evaluator version matches the latest changelog entry", () => {
    expect(LATEST_ENGINE_CHANGELOG_ENTRY.version).toBe(
      GATE_ENGINE_EVALUATOR_VERSION
    );
    expect(parseEvaluatorRef(DEFAULT_GATE_ENGINE_EVALUATOR)?.version).toBe(
      GATE_ENGINE_EVALUATOR_VERSION
    );
    expect(assertEngineChangelogInvariants()).toEqual({ ok: true });
  });

  test("rejects undeclared compatibility classes", () => {
    const parsed = EngineChangelogEntrySchema.safeParse({
      version: "1.0.1",
      class: "unknown-compatible",
      summary: "Invalid class.",
      verdictSemanticsChanged: false,
      affectedFixtures: []
    });

    expect(parsed.success).toBe(false);
  });

  test("fails when verdict semantics change without an evaluator version bump", () => {
    const invariantResult = assertEngineChangelogInvariants([
      BASELINE_ENGINE_CHANGELOG_ENTRY,
      EngineChangelogEntrySchema.parse({
        version: "1.0.0",
        class: "migration-required",
        summary: "This should require a version bump.",
        verdictSemanticsChanged: true,
        affectedFixtures: ["context-sufficiency-pass"],
        migrationDescriptorId: "descriptor.same-version"
      })
    ]);

    expect(invariantResult.ok).toBe(false);

    if (!invariantResult.ok) {
      expect(invariantResult.findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining([
          "versions_not_strictly_increasing",
          "verdict_semantics_without_version_bump"
        ])
      );
    }
  });

  test("fails closed for an empty changelog", () => {
    expect(assertEngineChangelogInvariants([])).toEqual({
      ok: false,
      findings: [
        expect.objectContaining({
          code: "changelog_empty"
        })
      ]
    });
  });

  test("fails when the supplied latest changelog version does not match the evaluator version", () => {
    const invariantResult = assertEngineChangelogInvariants([
      BASELINE_ENGINE_CHANGELOG_ENTRY,
      EngineChangelogEntrySchema.parse({
        version: "9.9.9",
        class: "forward-compatible",
        summary: "Verifier mismatch probe.",
        verdictSemanticsChanged: false,
        affectedFixtures: []
      })
    ]);

    expect(invariantResult.ok).toBe(false);

    if (!invariantResult.ok) {
      expect(invariantResult.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "latest_version_mismatch",
            version: "9.9.9"
          })
        ])
      );
    }
  });

  test.each(["migration-required", "breaking"] as const)(
    "requires a migrationDescriptorId for %s entries",
    (compatibilityClass) => {
      const invariantResult = assertEngineChangelogInvariants([
        BASELINE_ENGINE_CHANGELOG_ENTRY,
        EngineChangelogEntrySchema.parse({
          version: "1.0.1",
          class: compatibilityClass,
          summary: "Descriptor should be required.",
          verdictSemanticsChanged: true,
          affectedFixtures: ["context-sufficiency-pass"]
        })
      ]);

      expect(invariantResult.ok).toBe(false);

      if (!invariantResult.ok) {
        expect(invariantResult.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "migration_descriptor_missing",
              version: "1.0.1"
            })
          ])
        );
      }
    }
  );
});
