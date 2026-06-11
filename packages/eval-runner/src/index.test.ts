import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvalVerdictSchema,
  EvalVerdictStatusSchema,
  type EvalVerdict
} from "@specwright/schemas";
import { loadHarnessPackage } from "@specwright/harness-loader";
import {
  DECISION_HASH_FAIL_CLOSED_CODE,
  inputHashesFromVerdict,
  recomputeDecisionHash,
  hashResolvedInputs,
  runEval,
  resolveEvalDefinition,
  stableStringify,
  type DecisionInputHashes,
  type RunEvalRequest
} from "./index";
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
  "registry-off-registry-fail-closed",
  "schema-pass-mutated-target"
];

const decisionHashPattern = /^sha256:[a-f0-9]{64}$/u;

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
      expectValidDecisionProvenance(result);
      expect(recomputeDecisionHash(result)).toBe(result.provenance?.decisionHash);
    });
  }
});

describe("eval decision hash integrity", () => {
  test("rejects unsupported non-plain objects during canonicalization", () => {
    for (const value of unsupportedObjectValues()) {
      expect(() => stableStringify(value)).toThrow(/unsupported .* object/u);
    }

    expect(stableStringify({ b: 1, a: undefined })).toBe("{\"b\":1}");
    expect(stableStringify(Object.assign(Object.create(null), { b: 1 }))).toBe(
      "{\"b\":1}"
    );
  });

  test("rejects recompute mismatches from recorded input hashes", async () => {
    const request = (await readJson(join(
      fixturesDir,
      "schema-pass",
      "request.json"
    ))) as RunEvalRequest;
    const result = runEval(request);
    const hashes = inputHashesFromVerdict(result);
    const mismatched: DecisionInputHashes = {
      ...hashes,
      targetContentHash: `sha256:${"0".repeat(64)}`
    };

    expect(() => recomputeDecisionHash(result, mismatched)).toThrow(
      /decisionHash does not match/u
    );
  });

  test("target content changes invalidate decision-hash reuse", async () => {
    const baseRequest = (await readJson(join(
      fixturesDir,
      "schema-pass",
      "request.json"
    ))) as RunEvalRequest;
    const mutatedRequest = (await readJson(join(
      fixturesDir,
      "schema-pass-mutated-target",
      "request.json"
    ))) as RunEvalRequest;

    const base = runEval(baseRequest);
    const mutated = runEval(mutatedRequest);

    expect(base.status).toBe("pass");
    expect(mutated.status).toBe("pass");
    expect(mutated.findings).toEqual(base.findings);
    expect(mutated.severity).toBe(base.severity);
    const baseHashes = inputHashesFromVerdict(base);
    const mutatedHashes = inputHashesFromVerdict(mutated);

    expect(mutatedHashes.definitionHash).toBe(baseHashes.definitionHash);
    expect(mutatedHashes.evidenceSnapshotHash).toBe(
      baseHashes.evidenceSnapshotHash
    );
    expect(mutatedHashes.checkResultsHash).toBe(baseHashes.checkResultsHash);
    expect(mutatedHashes.targetContentHash).not.toBe(
      baseHashes.targetContentHash
    );
    expect(mutated.provenance?.decisionHash).not.toBe(
      base.provenance?.decisionHash
    );
  });

  test("fails closed when resolved inputs are not canonicalizable", () => {
    const definition = {
      id: "cyclic_schema",
      type: "schema",
      target: {
        artifactId: "plan"
      },
      requiredFields: ["title", "steps"],
      severity: "blocking"
    } satisfies FixtureEvalDefinition;
    const registry = buildEvalRegistry("harness.test@1.0.0", [definition]);
    const content: Record<string, unknown> = {
      title: "Cyclic plan",
      steps: ["collect evidence"]
    };
    content.self = content;

    const result = runEval({
      harnessPackageId: "harness.test@1.0.0",
      evalRegistry: registry,
      evalId: "cyclic_schema",
      input: {
        artifacts: {
          plan: {
            artifactId: "plan",
            artifactType: "plan",
            content
          }
        }
      }
    });

    expect(EvalVerdictSchema.parse(result)).toEqual(result);
    expect(result.status).toBe("fail");
    expect(result.severity).toBe("blocking");
    expect(result.findings[0]?.code).toBe(DECISION_HASH_FAIL_CLOSED_CODE);
    expectValidDecisionProvenance(result);
    expect(recomputeDecisionHash(result)).toBe(result.provenance?.decisionHash);
  });

  test("fails closed for unsupported object values in target content", () => {
    for (const value of unsupportedObjectValues()) {
      const result = runEval(
        schemaRequestWith({
          targetContent: {
            title: "Unsupported target content",
            steps: ["collect evidence"],
            unsupported: value
          }
        })
      );

      expectFailClosedDecisionHash(result);
    }
  });

  test("fails closed for unsupported object values in evidence snapshots", () => {
    for (const value of unsupportedObjectValues()) {
      const result = runEval(
        sourceFidelityRequestWith({
          targetContent: {
            claims: [
              {
                id: "claim.dashboard-filtering",
                claim: "The product requires dashboard filtering.",
                level: "source_fact",
                important: true,
                evidenceRefs: ["evidence:brief#dashboard-filtering"]
              }
            ]
          },
          evidence: {
            records: [
              {
                id: "evidence:brief#dashboard-filtering",
                unsupported: value
              }
            ]
          }
        })
      );

      expectFailClosedDecisionHash(result);
    }
  });

  test("rejects unsupported object values in fallback definition hashing", () => {
    expect(() =>
      hashResolvedInputs({
        definition: {
          id: "definition_with_date",
          type: "schema",
          target: {
            artifactId: "plan"
          },
          requiredFields: ["title"],
          reviewedAt: new Date("2026-06-11T00:00:00.000Z")
        },
        checkResults: []
      })
    ).toThrow(/unsupported Date object/u);
  });

  test("rejects unsupported object values in normalized check results", () => {
    expect(() =>
      hashResolvedInputs({
        targetContent: {
          title: "Valid target",
          steps: ["collect evidence"]
        },
        checkResults: [
          {
            checkId: "checked_at",
            type: "schema",
            status: "pass",
            path: new Date("2026-06-11T00:00:00.000Z") as unknown as string
          }
        ]
      })
    ).toThrow(/unsupported Date object/u);
  });

  test("does not relabel schema validation failures as decision hash failures", () => {
    expect(() =>
      runEval({
        ...schemaRequestWith({
          targetContent: {
            title: "Valid target",
            steps: ["collect evidence"]
          }
        }),
        evaluatorRef: ""
      })
    ).toThrow();
  });

  test("distinct unsupported Date and Map target values never pass by colliding", () => {
    const firstDate = runEval(
      schemaRequestWith({
        targetContent: {
          title: "Unsupported target content",
          steps: ["collect evidence"],
          reviewedAt: new Date("2026-06-11T00:00:00.000Z")
        }
      })
    );
    const secondDate = runEval(
      schemaRequestWith({
        targetContent: {
          title: "Unsupported target content",
          steps: ["collect evidence"],
          reviewedAt: new Date("2026-06-12T00:00:00.000Z")
        }
      })
    );
    const firstMap = runEval(
      schemaRequestWith({
        targetContent: {
          title: "Unsupported target content",
          steps: ["collect evidence"],
          metadata: new Map([["first", "value"]])
        }
      })
    );
    const secondMap = runEval(
      schemaRequestWith({
        targetContent: {
          title: "Unsupported target content",
          steps: ["collect evidence"],
          metadata: new Map([["second", "value"]])
        }
      })
    );

    for (const result of [firstDate, secondDate, firstMap, secondMap]) {
      expectFailClosedDecisionHash(result);
    }
  });
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

function expectValidDecisionProvenance(verdict: EvalVerdict) {
  expect(verdict.provenance?.decisionHash).toMatch(decisionHashPattern);
  const hashes = inputHashesFromVerdict(verdict);

  expect(hashes.targetContentHash).toMatch(decisionHashPattern);
  expect(hashes.evidenceSnapshotHash).toMatch(decisionHashPattern);
  expect(hashes.definitionHash).toMatch(decisionHashPattern);
  expect(hashes.checkResultsHash).toMatch(decisionHashPattern);
}

function expectFailClosedDecisionHash(verdict: EvalVerdict) {
  expect(EvalVerdictSchema.parse(verdict)).toEqual(verdict);
  expect(verdict.status).toBe("fail");
  expect(verdict.severity).toBe("blocking");
  expect(verdict.findings[0]?.code).toBe(DECISION_HASH_FAIL_CLOSED_CODE);
  expect(verdict.findings[0]?.message).toBe(
    "Eval decision hash could not be computed from resolved inputs"
  );
  expect(verdict.provenance?.decisionHash).toMatch(decisionHashPattern);
  expect(recomputeDecisionHash(verdict)).toBe(verdict.provenance?.decisionHash);
}

function unsupportedObjectValues(): unknown[] {
  class CustomValue {
    value = "custom";
  }

  return [
    new Date("2026-06-11T00:00:00.000Z"),
    new Map([["key", "value"]]),
    new Set(["value"]),
    /value/u,
    new URL("https://specwright.local/value"),
    new CustomValue()
  ];
}

function schemaRequestWith(input: {
  targetContent: unknown;
}): RunEvalRequest {
  const definition = {
    id: "unsupported_object_schema",
    type: "schema",
    target: {
      artifactId: "plan"
    },
    requiredFields: ["title", "steps"],
    severity: "blocking"
  } satisfies FixtureEvalDefinition;

  return {
    harnessPackageId: "harness.test@1.0.0",
    evalRegistry: buildEvalRegistry("harness.test@1.0.0", [definition]),
    evalId: definition.id,
    input: {
      artifacts: {
        plan: {
          artifactId: "plan",
          artifactType: "plan",
          content: input.targetContent
        }
      }
    }
  };
}

function sourceFidelityRequestWith(input: {
  targetContent: unknown;
  evidence: Record<string, unknown>;
}): RunEvalRequest {
  const definition = {
    id: "unsupported_object_source_fidelity",
    type: "source_fidelity",
    target: {
      artifactId: "ux_contract"
    },
    claimsPath: "claims",
    severity: "blocking"
  } satisfies FixtureEvalDefinition;

  return {
    harnessPackageId: "harness.test@1.0.0",
    evalRegistry: buildEvalRegistry("harness.test@1.0.0", [definition]),
    evalId: definition.id,
    input: {
      artifacts: {
        ux_contract: {
          artifactId: "ux_contract",
          artifactType: "ux_contract",
          content: input.targetContent
        }
      },
      evidence: input.evidence
    }
  };
}
