import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvalVerdictSchema,
  EvalVerdictStatusSchema
} from "@specwright/schemas";
import { loadHarnessPackage } from "@specwright/harness-loader";
import { runEval, resolveEvalDefinition, type RunEvalRequest } from "./index";
import {
  DEFAULT_HARNESS_PACKAGE_ID,
  EvalRegistryManifestSchema,
  buildEvalRegistry,
  canonicalizeEvalDefinition,
  classifyEvalDefinition,
  hashEvalDefinition,
  lintEvalDefinition,
  resolveFromRegistry,
  type EvalRegistryManifest
} from "./registry";
import type { FixtureEvalDefinition } from "./index";

const fixturesDir = join(import.meta.dir, "../fixtures");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const fixtureCases = [
  "schema-pass",
  "schema-fail-blocking",
  "source-fidelity-pass",
  "source-fidelity-missing-evidence",
  "completeness-missing-section",
  "unsupported-model-assisted",
  "registry-resolved-pass",
  "registry-hash-mismatch-fail-closed",
  "registry-off-registry-fail-closed"
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

describe("eval registry governance", () => {
  test("canonicalizes and hashes eval definitions deterministically", () => {
    const definition = {
      id: "stable",
      type: "schema",
      target: {
        artifactId: "plan"
      },
      requiredFields: ["goal", "steps"]
    } satisfies FixtureEvalDefinition;
    const reordered = {
      requiredFields: ["goal", "steps"],
      target: {
        artifactId: "plan"
      },
      type: "schema",
      id: "stable"
    } satisfies FixtureEvalDefinition;
    const edited = {
      ...definition,
      requiredFields: ["goal", "steps", "claims"]
    } satisfies FixtureEvalDefinition;

    expect(canonicalizeEvalDefinition(definition)).toEqual(
      canonicalizeEvalDefinition(reordered)
    );
    expect(hashEvalDefinition(definition)).toEqual(
      hashEvalDefinition(reordered)
    );
    expect(hashEvalDefinition(edited)).not.toEqual(hashEvalDefinition(definition));
  });

  test("builds a package-keyed registry and admits only hash-matched supplied definitions", () => {
    const definition = {
      id: "artifact_schema_presence",
      type: "schema",
      target: {
        artifactId: "plan"
      },
      requiredFields: ["goal"]
    } satisfies FixtureEvalDefinition;
    const registry = buildEvalRegistry("harness.test@1.0.0", [definition]);

    expect(registry.entries).toHaveLength(1);
    expect(
      resolveFromRegistry({
        registry,
        harnessPackageId: "harness.test@1.0.0",
        definitionId: "artifact_schema_presence",
        suppliedDefinition: definition
      }).status
    ).toBe("resolved");
    expect(
      resolveFromRegistry({
        registry,
        harnessPackageId: "other.test@1.0.0",
        definitionId: "artifact_schema_presence",
        suppliedDefinition: definition
      }).status
    ).toBe("missing");
    expect(
      resolveFromRegistry({
        registry,
        harnessPackageId: "harness.test@1.0.0",
        definitionId: "artifact_schema_presence",
        suppliedDefinition: {
          ...definition,
          requiredFields: ["goal", "tampered"]
        }
      }).status
    ).toBe("untrusted");
  });

  test("rejects unknown deterministic kinds and unresolvable targets at registration", async () => {
    const fixtureDir = join(fixturesDir, "registry-lint-rejection");
    const request = (await readJson(join(
      fixtureDir,
      "request.json"
    ))) as RunEvalRequest;
    const expected = (await readJson(join(
      fixtureDir,
      "expected-error.json"
    ))) as { codes: string[] };
    const definitions = Array.isArray(request.evalDefinitions)
      ? request.evalDefinitions
      : [];

    if (definitions[0] === undefined || definitions[1] === undefined) {
      throw new Error("registry-lint-rejection fixture must declare two definitions");
    }

    const unknownKind = definitions[0];
    const missingTarget = definitions[1];

    expect(lintEvalDefinition(unknownKind).map((issue) => issue.code)).toContain(
      expected.codes[0]
    );
    expect(() => buildEvalRegistry("harness.test@1.0.0", [unknownKind])).toThrow(
      /unknown eval kind/u
    );
    expect(lintEvalDefinition(missingTarget).map((issue) => issue.code)).toContain(
      expected.codes[1]
    );
    expect(() => buildEvalRegistry("harness.test@1.0.0", [missingTarget])).toThrow(
      /resolvable target/u
    );
  });

  test("keeps routed model-assisted definitions in needs_review, never pass", () => {
    const definition = {
      id: "semantic_rubric",
      type: "model_assisted",
      target: {
        artifactId: "summary"
      },
      severity: "advisory"
    } satisfies FixtureEvalDefinition;
    const registry = buildEvalRegistry("harness.test@1.0.0", [definition]);

    const result = runEval({
      harnessPackageId: "harness.test@1.0.0",
      evalRegistry: registry,
      evalId: "semantic_rubric",
      input: {
        artifacts: {
          summary: {
            artifactId: "summary",
            content: {
              sections: {
                overview: {
                  body: "Run overview."
                }
              }
            }
          }
        }
      }
    });

    expect(result.status).toBe("needs_review");
    expect(result.findings[0]?.code).toBe("eval.type.unsupported");
  });

  test("default registry fixture matches every default harness eval definition", async () => {
    const snapshot = await loadHarnessPackage({
      packageDir: join(repoRoot, "harnesses/default"),
      loadedAt: "2026-06-11T00:00:00.000Z"
    });
    const registry = buildEvalRegistry(
      DEFAULT_HARNESS_PACKAGE_ID,
      snapshot.evals as FixtureEvalDefinition[]
    );
    const artifact = EvalRegistryManifestSchema.parse(
      await readJson(join(fixturesDir, "registry/default.json"))
    ) as EvalRegistryManifest;

    expect(artifact).toEqual(registry);
    expect(registry.entries.map((entry) => entry.definitionId).sort()).toEqual([
      "artifact_schema_presence",
      "completeness_required_sections",
      "source_fidelity"
    ]);
    expect(
      Object.fromEntries(
        registry.entries.map((entry) => [entry.definitionId, entry.kind])
      )
    ).toEqual({
      artifact_schema_presence: "artifact_schema",
      completeness_required_sections: "completeness",
      source_fidelity: "source_fidelity"
    });
  });

  test("resolveEvalDefinition resolves only from the run package registry", () => {
    const definition = {
      id: "artifact_schema_presence",
      type: "schema",
      target: {
        artifactId: "plan"
      },
      requiredFields: ["goal"]
    } satisfies FixtureEvalDefinition;
    const registry = buildEvalRegistry("harness.test@1.0.0", [definition]);

    expect(
      resolveEvalDefinition({
        harnessPackageId: "harness.test@1.0.0",
        evalRegistry: registry,
        evalId: "artifact_schema_presence"
      }).status
    ).toBe("resolved");
    expect(
      resolveEvalDefinition({
        harnessPackageId: "other.test@1.0.0",
        evalRegistry: registry,
        evalId: "artifact_schema_presence"
      }).status
    ).toBe("missing");
  });

  test("classifies default harness eval taxonomy", () => {
    expect(
      classifyEvalDefinition({
        id: "artifact_schema_presence",
        type: "deterministic",
        target: {
          artifactId: "plan"
        },
        checks: [
          {
            id: "fields",
            type: "schema",
            requiredFields: ["goal"]
          }
        ]
      })
    ).toBe("artifact_schema");
  });
});

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
