import { describe, expect, test } from "bun:test";
import {
  createDecisionHashBaseline,
  loadPolicyFixtureCorpus,
  validateDecisionHashBaseline,
  validateDomainCoverage,
  validateMutationCases,
  validatePolicyFixtureCorpus,
  type PolicyFixtureCorpus,
  type PolicyMutationCase,
  type PolicyVerdictFixture
} from "./policy-validation";

describe("policy validation gate meta-tests", () => {
  test("corrupted decisionHash fails closed in the baseline gate", async () => {
    const corpus = await loadPolicyFixtureCorpus();
    const baseline = createDecisionHashBaseline(corpus.verdictFixtures);
    const alteredCorpus: PolicyFixtureCorpus = {
      ...corpus,
      verdictFixtures: corpus.verdictFixtures.map((fixture, index) =>
        index === 0
          ? {
              ...fixture,
              expected: {
                ...fixture.expected,
                decisionHash:
                  "sha256:0000000000000000000000000000000000000000000000000000000000000000"
              }
            }
          : fixture
      )
    };
    const report = validatePolicyFixtureCorpus(alteredCorpus, baseline);

    expect(issueCodes(report.issues)).toContain(
      "decision_hash_recomputed_mismatch"
    );
    expect(issueCodes(report.issues)).toContain(
      "decision_hash_baseline_mismatch"
    );
  });

  test("missing domain coverage fails closed", async () => {
    const corpus = await loadPolicyFixtureCorpus();
    const allowOnly = requireFixture(
      corpus.verdictFixtures,
      "run-mode-local-dev-allowed"
    );
    const coverage = validateDomainCoverage([
      {
        ...allowOnly,
        domain: "isolated-review-domain"
      }
    ]);

    expect(issueCodes(coverage.issues)).toEqual([
      "domain_coverage_missing_leg",
      "domain_coverage_missing_leg"
    ]);
  });

  test("loosening mutation fails closed", async () => {
    const corpus = await loadPolicyFixtureCorpus();
    const cases = [
      {
        category: "remove_required_scope",
        name: "remove broad scope request",
        fixtureName: "scope-exceeded-denied",
        mutate: (input) => ({
          request: {
            ...input.request,
            action: {
              ...input.request.action,
              requestedScopes: ["workspace:read"]
            }
          },
          policyBundles: input.policyBundles
        }),
        expectedRuleId: "tool.fs.read.default",
        expectedEffect: "allow"
      }
    ] as const satisfies readonly PolicyMutationCase[];
    const result = validateMutationCases(corpus.verdictFixtures, cases);

    expect(issueCodes(result.issues)).toContain("mutation_loosened");
  });

  test("baseline manifest requires every discovered verdict fixture", async () => {
    const corpus = await loadPolicyFixtureCorpus();
    const baseline = createDecisionHashBaseline(corpus.verdictFixtures);
    const removedFixture = corpus.verdictFixtures[0];

    expect(removedFixture).toBeDefined();
    if (removedFixture === undefined) {
      throw new Error("Expected at least one verdict fixture");
    }

    delete baseline[removedFixture.name];

    expect(issueCodes(validateDecisionHashBaseline(corpus.verdictFixtures, baseline))).toContain(
      "baseline_missing_fixture"
    );
  });
});

function requireFixture(
  fixtures: readonly PolicyVerdictFixture[],
  name: string
) {
  const fixture = fixtures.find((candidate) => candidate.name === name);

  expect(fixture).toBeDefined();
  if (fixture === undefined) {
    throw new Error(`Expected fixture ${name}`);
  }

  return fixture;
}

function issueCodes(
  issues: readonly { code: string }[]
) {
  return issues.map((issue) => issue.code).sort((left, right) =>
    left.localeCompare(right)
  );
}
