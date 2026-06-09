import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PolicyBundleSchema,
  PolicyVerdictSchema,
  type PolicyRuleEffect,
  type PolicyVerdictStatus
} from "@specwright/schemas";
import {
  evaluatePolicy,
  hashDecision,
  hashJson,
  loadPolicyBundles,
  replayPolicyDecision,
  stableStringify,
  type FixturePolicyBundle,
  type FixturePolicyRule,
  type PolicyDecisionReplayRecord,
  type PolicyReplayDivergenceClass,
  type PolicyRequest,
  type PolicyVerdict
} from "./index";

const sourceDir = dirname(fileURLToPath(import.meta.url));

export const POLICY_FIXTURES_DIR = join(sourceDir, "../fixtures");
export const DECISION_HASH_BASELINE_PATH = join(
  sourceDir,
  "../decision-hash-baseline.json"
);

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const fixtureKinds = [
  "verdict",
  "replay",
  "load_failure",
  "caller_path_load_failure"
] as const;
export type PolicyFixtureKind = (typeof fixtureKinds)[number];

const mutationCategories = [
  "remove_required_scope",
  "change_phase",
  "exceed_budget",
  "switch_run_mode_to_ci",
  "remove_approval",
  "broaden_path"
] as const;
export type PolicyMutationCategory = (typeof mutationCategories)[number];

export type PolicyFixtureMeta = {
  domain?: string | undefined;
  kind?: PolicyFixtureKind | undefined;
  mutationOf?: string | undefined;
  mutationCategory?: PolicyMutationCategory | undefined;
  description?: string | undefined;
};

export type DecisionHashBaseline = Record<string, string>;

export type PolicyValidationIssueCode =
  | "baseline_extra_fixture"
  | "baseline_invalid_hash"
  | "baseline_missing_fixture"
  | "baseline_read_failed"
  | "caller_path_mismatch"
  | "decision_hash_baseline_mismatch"
  | "decision_hash_recomputed_mismatch"
  | "domain_coverage_missing_leg"
  | "expected_verdict_invalid"
  | "fixture_json_invalid"
  | "fixture_kind_invalid"
  | "fixture_missing_file"
  | "fixture_policy_bundle_invalid"
  | "fixture_request_invalid"
  | "load_failure_mismatch"
  | "load_failure_not_closed"
  | "metadata_invalid"
  | "mutation_category_duplicate"
  | "mutation_category_missing"
  | "mutation_expected_rule_missing"
  | "mutation_invalid_bundle"
  | "mutation_loosened"
  | "mutation_not_stricter"
  | "replay_record_invalid"
  | "replay_record_mismatch"
  | "verdict_mismatch"
  | "verdict_not_byte_stable";

export type PolicyValidationIssue = {
  code: PolicyValidationIssueCode;
  message: string;
  fixtureName?: string;
  domain?: string;
};

export type PolicyVerdictFixture = {
  name: string;
  kind: Extract<PolicyFixtureKind, "verdict" | "replay">;
  domain: string;
  request: PolicyRequest;
  rawPolicyBundle: unknown;
  policyBundles: FixturePolicyBundle[];
  expected: PolicyVerdict;
  verdict: PolicyVerdict;
  repeatedVerdict: PolicyVerdict;
  meta: PolicyFixtureMeta;
};

export type PolicyNonVerdictFixture = {
  name: string;
  kind: Extract<PolicyFixtureKind, "load_failure" | "caller_path_load_failure">;
  domain: string | null;
  meta: PolicyFixtureMeta;
};

export type PolicyFixtureCorpus = {
  fixturesDir: string;
  totalFixtureDirectories: number;
  verdictFixtures: PolicyVerdictFixture[];
  nonVerdictFixtures: PolicyNonVerdictFixture[];
  replayFixtureNames: string[];
  issues: PolicyValidationIssue[];
};

export type DomainCoverage = {
  domain: string;
  verdictFixtures: string[];
  allowFixtures: string[];
  denyFixtures: string[];
  approvalOrConstraintFixtures: string[];
};

export type MutationInput = {
  request: PolicyRequest;
  policyBundles: FixturePolicyBundle[];
};

export type PolicyMutationCase = {
  category: PolicyMutationCategory;
  name: string;
  fixtureName: string;
  prepare?: (input: MutationInput) => MutationInput;
  mutate: (input: MutationInput) => MutationInput;
  expectedRuleId: string;
  expectedEffect: PolicyRuleEffect;
};

export type MutationValidationResult = {
  category: PolicyMutationCategory;
  name: string;
  fixtureName: string;
  baselineStatus: PolicyVerdictStatus;
  mutatedStatus: PolicyVerdictStatus;
};

export type PolicyValidationReport = {
  issues: PolicyValidationIssue[];
  totalFixtureDirectories: number;
  verdictFixtureCount: number;
  nonVerdictFixtureCount: number;
  replayFixtureCount: number;
  decisionHashBaselineEntries: number;
  domainCoverage: DomainCoverage[];
  mutationResults: MutationValidationResult[];
};

type BaselineReadResult =
  | {
      ok: true;
      baseline: DecisionHashBaseline;
    }
  | {
      ok: false;
      baseline: DecisionHashBaseline;
      issues: PolicyValidationIssue[];
    };

type JsonReadResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      issue: PolicyValidationIssue;
    };

type ReplayRecordedDecision = {
  sourceFixture?: string;
  hashAlgoVersion?: PolicyDecisionReplayRecord["hashAlgoVersion"];
  requestHash?: PolicyDecisionReplayRecord["requestHash"];
  policyBundleHash?: PolicyDecisionReplayRecord["policyBundleHash"];
  storedDecisionHash: PolicyDecisionReplayRecord["storedDecisionHash"];
  expectedDivergenceClass: PolicyReplayDivergenceClass;
};

const statusStrictness: Record<PolicyVerdictStatus, number> = {
  allow: 0,
  approval_required: 1,
  deny: 2
};

export async function loadPolicyFixtureCorpus(
  fixturesDir = POLICY_FIXTURES_DIR
): Promise<PolicyFixtureCorpus> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const fixtureNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const verdictFixtures: PolicyVerdictFixture[] = [];
  const nonVerdictFixtures: PolicyNonVerdictFixture[] = [];
  const replayFixtureNames: string[] = [];
  const issues: PolicyValidationIssue[] = [];

  for (const fixtureName of fixtureNames) {
    const fixtureDir = join(fixturesDir, fixtureName);
    const fileNames = await fileNamesFor(fixtureDir);
    const meta = await readFixtureMeta(fixtureDir, fixtureName, issues);
    const kind = kindForFixture(fixtureName, fileNames, meta, issues);

    if (kind === "verdict" || kind === "replay") {
      const loaded = await loadVerdictFixture(
        fixtureDir,
        fixtureName,
        kind,
        meta,
        fileNames,
        issues
      );

      if (loaded !== undefined) {
        verdictFixtures.push(loaded);
        if (kind === "replay") {
          replayFixtureNames.push(fixtureName);
        }
      }
      continue;
    }

    const nonVerdict = await loadNonVerdictFixture(
      fixtureDir,
      fixtureName,
      kind,
      meta,
      fileNames,
      issues
    );
    if (nonVerdict !== undefined) {
      nonVerdictFixtures.push(nonVerdict);
    }
  }

  return {
    fixturesDir,
    totalFixtureDirectories: fixtureNames.length,
    verdictFixtures,
    nonVerdictFixtures,
    replayFixtureNames,
    issues
  };
}

export async function readDecisionHashBaseline(
  baselinePath = DECISION_HASH_BASELINE_PATH
): Promise<BaselineReadResult> {
  const readResult = await readJsonFile(baselinePath, "decision-hash-baseline");
  if (!readResult.ok) {
    return {
      ok: false,
      baseline: {},
      issues: [
        policyIssue(
          "baseline_read_failed",
          `Decision hash baseline could not be read: ${readResult.issue.message}`
        )
      ]
    };
  }

  if (!isRecord(readResult.value)) {
    return {
      ok: false,
      baseline: {},
      issues: [
        policyIssue(
          "baseline_read_failed",
          "Decision hash baseline must be a fixture-name to hash object"
        )
      ]
    };
  }

  const baseline: DecisionHashBaseline = {};
  const issues: PolicyValidationIssue[] = [];
  for (const [fixtureName, hash] of Object.entries(readResult.value).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
      issues.push(
        policyIssue(
          "baseline_invalid_hash",
          `Decision hash baseline entry ${fixtureName} is not a sha256 digest`,
          fixtureName
        )
      );
      continue;
    }

    baseline[fixtureName] = hash;
  }

  if (issues.length > 0) {
    return {
      ok: false,
      baseline,
      issues
    };
  }

  return {
    ok: true,
    baseline
  };
}

export function createDecisionHashBaseline(
  verdictFixtures: readonly PolicyVerdictFixture[]
): DecisionHashBaseline {
  const baseline: DecisionHashBaseline = {};

  for (const fixture of sortedVerdictFixtures(verdictFixtures)) {
    baseline[fixture.name] = fixture.expected.decisionHash;
  }

  return baseline;
}

export function validatePolicyFixtureCorpus(
  corpus: PolicyFixtureCorpus,
  baseline: DecisionHashBaseline,
  mutationCases: readonly PolicyMutationCase[] = policyMutationCases
): PolicyValidationReport {
  const issues = [
    ...corpus.issues,
    ...validateVerdictFixtures(corpus.verdictFixtures),
    ...validateDecisionHashBaseline(corpus.verdictFixtures, baseline),
    ...validateDomainCoverage(corpus.verdictFixtures).issues
  ];
  const mutationValidation = validateMutationCases(
    corpus.verdictFixtures,
    mutationCases
  );

  issues.push(...mutationValidation.issues);

  return {
    issues: sortIssues(issues),
    totalFixtureDirectories: corpus.totalFixtureDirectories,
    verdictFixtureCount: corpus.verdictFixtures.length,
    nonVerdictFixtureCount: corpus.nonVerdictFixtures.length,
    replayFixtureCount: corpus.replayFixtureNames.length,
    decisionHashBaselineEntries: Object.keys(baseline).length,
    domainCoverage: validateDomainCoverage(corpus.verdictFixtures).coverage,
    mutationResults: mutationValidation.results
  };
}

export function validateVerdictFixtures(
  fixtures: readonly PolicyVerdictFixture[]
): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];

  for (const fixture of fixtures) {
    const expectedIndependentHash = hashDecision({
      requestHash: hashJson(fixture.request),
      policyBundleHash: hashJson(fixture.policyBundles),
      matchedRuleIds: fixture.expected.matchedRules.map((rule) => rule.ruleId),
      status: fixture.expected.status,
      constraints: fixture.expected.constraints,
      obligations: fixture.expected.obligations
    });

    if (expectedIndependentHash !== fixture.expected.decisionHash) {
      issues.push(
        policyIssue(
          "decision_hash_recomputed_mismatch",
          "Expected verdict decisionHash does not rederive from request, bundle, and verdict fields",
          fixture.name,
          fixture.domain
        )
      );
    }

    if (fixture.verdict.decisionHash !== fixture.expected.decisionHash) {
      issues.push(
        policyIssue(
          "decision_hash_recomputed_mismatch",
          "Recomputed verdict decisionHash does not match expected-verdict.json",
          fixture.name,
          fixture.domain
        )
      );
    }

    if (stableStringify(fixture.verdict) !== stableStringify(fixture.expected)) {
      issues.push(
        policyIssue(
          "verdict_mismatch",
          "Recomputed verdict does not exactly match expected-verdict.json",
          fixture.name,
          fixture.domain
        )
      );
    }

    if (JSON.stringify(fixture.verdict) !== JSON.stringify(fixture.repeatedVerdict)) {
      issues.push(
        policyIssue(
          "verdict_not_byte_stable",
          "Repeated evaluation is not byte-stable",
          fixture.name,
          fixture.domain
        )
      );
    }
  }

  return issues;
}

export function validateDecisionHashBaseline(
  verdictFixtures: readonly PolicyVerdictFixture[],
  baseline: DecisionHashBaseline
): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  const fixtureNames = new Set(verdictFixtures.map((fixture) => fixture.name));

  for (const fixtureName of Object.keys(baseline).sort((left, right) =>
    left.localeCompare(right)
  )) {
    if (!fixtureNames.has(fixtureName)) {
      issues.push(
        policyIssue(
          "baseline_extra_fixture",
          "Decision hash baseline contains a fixture not discovered in the verdict corpus",
          fixtureName
        )
      );
    }
  }

  for (const fixture of sortedVerdictFixtures(verdictFixtures)) {
    const baselineHash = baseline[fixture.name];

    if (baselineHash === undefined) {
      issues.push(
        policyIssue(
          "baseline_missing_fixture",
          "Decision hash baseline is missing a discovered verdict fixture",
          fixture.name,
          fixture.domain
        )
      );
      continue;
    }

    if (baselineHash !== fixture.expected.decisionHash) {
      issues.push(
        policyIssue(
          "decision_hash_baseline_mismatch",
          "Expected verdict decisionHash is not acknowledged in the baseline manifest",
          fixture.name,
          fixture.domain
        )
      );
    }

    if (baselineHash !== fixture.verdict.decisionHash) {
      issues.push(
        policyIssue(
          "decision_hash_baseline_mismatch",
          "Recomputed verdict decisionHash is not acknowledged in the baseline manifest",
          fixture.name,
          fixture.domain
        )
      );
    }
  }

  return issues;
}

export function validateDomainCoverage(
  verdictFixtures: readonly PolicyVerdictFixture[]
): { coverage: DomainCoverage[]; issues: PolicyValidationIssue[] } {
  const groups = new Map<string, DomainCoverage>();
  const issues: PolicyValidationIssue[] = [];

  for (const fixture of sortedVerdictFixtures(verdictFixtures)) {
    const existing = groups.get(fixture.domain);
    const coverage =
      existing ??
      {
        domain: fixture.domain,
        verdictFixtures: [],
        allowFixtures: [],
        denyFixtures: [],
        approvalOrConstraintFixtures: []
      };

    coverage.verdictFixtures.push(fixture.name);
    if (fixture.expected.status === "allow") {
      coverage.allowFixtures.push(fixture.name);
    }

    if (fixture.expected.status === "deny") {
      coverage.denyFixtures.push(fixture.name);
    }

    if (
      fixture.expected.status === "approval_required" ||
      fixture.expected.constraints.length > 0 ||
      fixture.expected.matchedRules.some((rule) => rule.effect === "constrain")
    ) {
      coverage.approvalOrConstraintFixtures.push(fixture.name);
    }

    groups.set(fixture.domain, coverage);
  }

  const coverage = [...groups.values()].sort((left, right) =>
    left.domain.localeCompare(right.domain)
  );
  for (const entry of coverage) {
    if (entry.allowFixtures.length === 0) {
      issues.push(
        policyIssue(
          "domain_coverage_missing_leg",
          "Policy domain has no allow fixture",
          undefined,
          entry.domain
        )
      );
    }

    if (entry.denyFixtures.length === 0) {
      issues.push(
        policyIssue(
          "domain_coverage_missing_leg",
          "Policy domain has no deny fixture",
          undefined,
          entry.domain
        )
      );
    }

    if (entry.approvalOrConstraintFixtures.length === 0) {
      issues.push(
        policyIssue(
          "domain_coverage_missing_leg",
          "Policy domain has no approval_required or constraint fixture",
          undefined,
          entry.domain
        )
      );
    }
  }

  return {
    coverage,
    issues
  };
}

export function validateMutationCases(
  verdictFixtures: readonly PolicyVerdictFixture[],
  mutationCases: readonly PolicyMutationCase[] = policyMutationCases
): { results: MutationValidationResult[]; issues: PolicyValidationIssue[] } {
  const fixturesByName = new Map(
    verdictFixtures.map((fixture) => [fixture.name, fixture])
  );
  const issues: PolicyValidationIssue[] = [];
  const results: MutationValidationResult[] = [];
  const seenCategories = new Map<PolicyMutationCategory, number>();

  for (const mutationCase of mutationCases) {
    seenCategories.set(
      mutationCase.category,
      (seenCategories.get(mutationCase.category) ?? 0) + 1
    );
  }

  for (const category of mutationCategories) {
    const count = seenCategories.get(category) ?? 0;
    if (count === 0) {
      issues.push(
        policyIssue(
          "mutation_category_missing",
          `Mutation category ${category} is not asserted`
        )
      );
    } else if (count > 1) {
      issues.push(
        policyIssue(
          "mutation_category_duplicate",
          `Mutation category ${category} is asserted more than once`
        )
      );
    }
  }

  for (const mutationCase of mutationCases) {
    const fixture = fixturesByName.get(mutationCase.fixtureName);
    if (fixture === undefined) {
      issues.push(
        policyIssue(
          "fixture_missing_file",
          `Mutation fixture ${mutationCase.fixtureName} was not discovered`,
          mutationCase.fixtureName
        )
      );
      continue;
    }

    const prepared = mutationCase.prepare?.(copyMutationInput(fixture)) ??
      copyMutationInput(fixture);
    const preparedLoad = loadPolicyBundles(prepared.policyBundles);
    if (!preparedLoad.ok) {
      issues.push(
        policyIssue(
          "mutation_invalid_bundle",
          `Mutation baseline bundle failed validation for ${mutationCase.name}`,
          fixture.name,
          fixture.domain
        )
      );
      continue;
    }

    const baselineVerdict = PolicyVerdictSchema.parse(
      evaluatePolicy(prepared.request, preparedLoad.bundles)
    );
    const mutated = mutationCase.mutate(copyMutationInputFromPrepared(prepared));
    const mutatedLoad = loadPolicyBundles(mutated.policyBundles);
    if (!mutatedLoad.ok) {
      issues.push(
        policyIssue(
          "mutation_invalid_bundle",
          `Mutated bundle failed validation for ${mutationCase.name}`,
          fixture.name,
          fixture.domain
        )
      );
      continue;
    }

    const mutatedVerdict = PolicyVerdictSchema.parse(
      evaluatePolicy(mutated.request, mutatedLoad.bundles)
    );
    const baselineStrictness = strictnessOf(baselineVerdict);
    const mutatedStrictness = strictnessOf(mutatedVerdict);

    results.push({
      category: mutationCase.category,
      name: mutationCase.name,
      fixtureName: mutationCase.fixtureName,
      baselineStatus: baselineVerdict.status,
      mutatedStatus: mutatedVerdict.status
    });

    if (mutatedStrictness < baselineStrictness) {
      issues.push(
        policyIssue(
          "mutation_loosened",
          `Mutation ${mutationCase.name} moved policy toward allow`,
          fixture.name,
          fixture.domain
        )
      );
      continue;
    }

    if (
      mutatedStrictness === baselineStrictness &&
      mutatedVerdict.status !== "deny"
    ) {
      issues.push(
        policyIssue(
          "mutation_not_stricter",
          `Mutation ${mutationCase.name} did not become stricter or deny`,
          fixture.name,
          fixture.domain
        )
      );
    }

    const expectedRule = mutatedVerdict.matchedRules.find(
      (rule) =>
        rule.ruleId === mutationCase.expectedRuleId &&
        rule.effect === mutationCase.expectedEffect
    );
    if (expectedRule === undefined) {
      issues.push(
        policyIssue(
          "mutation_expected_rule_missing",
          `Mutation ${mutationCase.name} did not match expected rule ${mutationCase.expectedRuleId}`,
          fixture.name,
          fixture.domain
        )
      );
    }
  }

  return {
    results,
    issues: sortIssues(issues)
  };
}

export async function runPolicyValidation(
  options: {
    bless?: boolean;
    fixturesDir?: string;
    baselinePath?: string;
  } = {}
): Promise<PolicyValidationReport> {
  const fixturesDir = options.fixturesDir ?? POLICY_FIXTURES_DIR;
  const baselinePath = options.baselinePath ?? DECISION_HASH_BASELINE_PATH;
  const corpus = await loadPolicyFixtureCorpus(fixturesDir);
  const baselineRead = await readDecisionHashBaseline(baselinePath);
  const baseline = baselineRead.ok
    ? baselineRead.baseline
    : baselineRead.baseline;
  const preBlessReport = validatePolicyFixtureCorpus(corpus, baseline);
  const preBlessIssues = [
    ...preBlessReport.issues,
    ...(baselineRead.ok ? [] : baselineRead.issues)
  ];

  if (options.bless === true) {
    const nonBaselineIssues = preBlessIssues.filter(
      (issueValue) =>
        issueValue.code !== "baseline_extra_fixture" &&
        issueValue.code !== "baseline_missing_fixture" &&
        issueValue.code !== "baseline_read_failed" &&
        issueValue.code !== "decision_hash_baseline_mismatch"
    );

    if (nonBaselineIssues.length > 0) {
      return {
        ...preBlessReport,
        issues: sortIssues(nonBaselineIssues)
      };
    }

    const blessedBaseline = createDecisionHashBaseline(corpus.verdictFixtures);
    await writeFile(
      baselinePath,
      `${JSON.stringify(blessedBaseline, null, 2)}\n`,
      "utf8"
    );

    return validatePolicyFixtureCorpus(corpus, blessedBaseline);
  }

  return {
    ...preBlessReport,
    issues: sortIssues(preBlessIssues)
  };
}

async function loadVerdictFixture(
  fixtureDir: string,
  fixtureName: string,
  kind: Extract<PolicyFixtureKind, "verdict" | "replay">,
  meta: PolicyFixtureMeta,
  fileNames: ReadonlySet<string>,
  issues: PolicyValidationIssue[]
): Promise<PolicyVerdictFixture | undefined> {
  const missing = requiredFilesMissing(fileNames, [
    "request.json",
    "policy-bundle.json",
    "expected-verdict.json"
  ]);
  if (missing.length > 0) {
    for (const fileName of missing) {
      issues.push(
        policyIssue(
          "fixture_missing_file",
          `Verdict fixture is missing ${fileName}`,
          fixtureName
        )
      );
    }
    return undefined;
  }

  const requestRead = await readJsonFixture(fixtureDir, fixtureName, "request.json");
  const bundleRead = await readJsonFixture(
    fixtureDir,
    fixtureName,
    "policy-bundle.json"
  );
  const expectedRead = await readJsonFixture(
    fixtureDir,
    fixtureName,
    "expected-verdict.json"
  );
  const localIssues = [requestRead, bundleRead, expectedRead]
    .filter((readResult): readResult is { ok: false; issue: PolicyValidationIssue } =>
      !readResult.ok
    )
    .map((readResult) => readResult.issue);
  issues.push(...localIssues);
  if (!requestRead.ok || !bundleRead.ok || !expectedRead.ok) {
    return undefined;
  }

  const requestResult = parsePolicyRequest(requestRead.value, fixtureName);
  if (!requestResult.ok) {
    issues.push(requestResult.issue);
    return undefined;
  }

  issues.push(
    ...validateRawPolicyBundleShape(bundleRead.value, fixtureName)
  );
  const loadResult = loadPolicyBundles(bundleRead.value);
  if (!loadResult.ok) {
    issues.push(
      policyIssue(
        "fixture_policy_bundle_invalid",
        `Verdict fixture policy bundle failed load: ${stableStringify(loadResult.failures)}`,
        fixtureName
      )
    );
    return undefined;
  }

  const expectedResult = PolicyVerdictSchema.safeParse(expectedRead.value);
  if (!expectedResult.success) {
    issues.push(
      policyIssue(
        "expected_verdict_invalid",
        `Expected verdict failed PolicyVerdictSchema: ${expectedResult.error.message}`,
        fixtureName
      )
    );
    return undefined;
  }

  if (!SHA256_PATTERN.test(expectedResult.data.decisionHash)) {
    issues.push(
      policyIssue(
        "expected_verdict_invalid",
        "Expected verdict decisionHash must be a sha256 digest",
        fixtureName
      )
    );
    return undefined;
  }

  const verdict = PolicyVerdictSchema.parse(
    evaluatePolicy(requestResult.value, loadResult.bundles)
  );
  const repeatedVerdict = PolicyVerdictSchema.parse(
    evaluatePolicy(requestResult.value, loadResult.bundles)
  );
  const domain = domainForFixture(
    fixtureName,
    meta,
    requestResult.value,
    expectedResult.data
  );

  if (fileNames.has("recorded-decision.json")) {
    await validateReplayFixture(
      fixtureDir,
      fixtureName,
      requestResult.value,
      bundleRead.value,
      verdict,
      issues
    );
  }

  return {
    name: fixtureName,
    kind,
    domain,
    request: requestResult.value,
    rawPolicyBundle: bundleRead.value,
    policyBundles: loadResult.bundles,
    expected: expectedResult.data,
    verdict,
    repeatedVerdict,
    meta
  };
}

async function loadNonVerdictFixture(
  fixtureDir: string,
  fixtureName: string,
  kind: Extract<PolicyFixtureKind, "load_failure" | "caller_path_load_failure">,
  meta: PolicyFixtureMeta,
  fileNames: ReadonlySet<string>,
  issues: PolicyValidationIssue[]
): Promise<PolicyNonVerdictFixture | undefined> {
  const requiredFiles =
    kind === "caller_path_load_failure"
      ? [
          "request.json",
          "policy-bundle.json",
          "expected-load-failure.json",
          "expected-caller-verdict.json"
        ]
      : ["policy-bundle.json", "expected-load-failure.json"];
  const missing = requiredFilesMissing(fileNames, requiredFiles);
  if (missing.length > 0) {
    for (const fileName of missing) {
      issues.push(
        policyIssue(
          "fixture_missing_file",
          `Load-failure fixture is missing ${fileName}`,
          fixtureName
        )
      );
    }
    return undefined;
  }

  const bundleRead = await readJsonFixture(
    fixtureDir,
    fixtureName,
    "policy-bundle.json"
  );
  const expectedRead = await readJsonFixture(
    fixtureDir,
    fixtureName,
    "expected-load-failure.json"
  );
  if (!bundleRead.ok || !expectedRead.ok) {
    if (!bundleRead.ok) {
      issues.push(bundleRead.issue);
    }
    if (!expectedRead.ok) {
      issues.push(expectedRead.issue);
    }
    return undefined;
  }

  const loadResult = loadPolicyBundles(bundleRead.value);
  if (loadResult.ok) {
    issues.push(
      policyIssue(
        "load_failure_not_closed",
        "Load-failure fixture unexpectedly loaded successfully",
        fixtureName
      )
    );
  } else if (stableStringify(loadResult.failures) !== stableStringify(expectedRead.value)) {
    issues.push(
      policyIssue(
        "load_failure_mismatch",
        "Load-failure fixture does not match expected-load-failure.json",
        fixtureName
      )
    );
  }

  if (kind === "caller_path_load_failure") {
    await validateCallerPathFixture(fixtureDir, fixtureName, loadResult, issues);
  }

  return {
    name: fixtureName,
    kind,
    domain: meta.domain ?? null,
    meta
  };
}

async function validateReplayFixture(
  fixtureDir: string,
  fixtureName: string,
  request: PolicyRequest,
  rawPolicyBundle: unknown,
  verdict: PolicyVerdict,
  issues: PolicyValidationIssue[]
) {
  const recordedRead = await readJsonFixture(
    fixtureDir,
    fixtureName,
    "recorded-decision.json"
  );
  if (!recordedRead.ok) {
    issues.push(recordedRead.issue);
    return;
  }

  const recorded = parseReplayRecordedDecision(recordedRead.value, fixtureName);
  if (!recorded.ok) {
    issues.push(recorded.issue);
    return;
  }

  const replayInput: PolicyDecisionReplayRecord = {
    request,
    bundles: rawPolicyBundle,
    storedDecisionHash: recorded.value.storedDecisionHash
  };
  if (recorded.value.hashAlgoVersion !== undefined) {
    replayInput.hashAlgoVersion = recorded.value.hashAlgoVersion;
  }
  if (recorded.value.requestHash !== undefined) {
    replayInput.requestHash = recorded.value.requestHash;
  }
  if (recorded.value.policyBundleHash !== undefined) {
    replayInput.policyBundleHash = recorded.value.policyBundleHash;
  }
  const result = replayPolicyDecision(replayInput);

  if (result.divergenceClass !== recorded.value.expectedDivergenceClass) {
    issues.push(
      policyIssue(
        "replay_record_mismatch",
        "Replay fixture divergence class does not match recorded-decision.json",
        fixtureName
      )
    );
  }

  if (
    recorded.value.expectedDivergenceClass === "equivalent" &&
    (result.recomputedHash !== recorded.value.storedDecisionHash ||
      result.status !== verdict.status)
  ) {
    issues.push(
      policyIssue(
        "replay_record_mismatch",
        "Replay-equivalent fixture does not rederive the stored verdict",
        fixtureName
      )
    );
  }
}

async function validateCallerPathFixture(
  fixtureDir: string,
  fixtureName: string,
  loadResult: ReturnType<typeof loadPolicyBundles>,
  issues: PolicyValidationIssue[]
) {
  const expectedRead = await readJsonFixture(
    fixtureDir,
    fixtureName,
    "expected-caller-verdict.json"
  );
  if (!expectedRead.ok) {
    issues.push(expectedRead.issue);
    return;
  }

  const actual =
    loadResult.ok
      ? {
          status: "allow",
          evaluatePolicyCalled: true,
          loadFailureCodes: []
        }
      : {
          status: "deny",
          evaluatePolicyCalled: false,
          loadFailureCodes: loadResult.failures.map((failure) => failure.code)
        };

  if (stableStringify(actual) !== stableStringify(expectedRead.value)) {
    issues.push(
      policyIssue(
        "caller_path_mismatch",
        "Caller-path load-failure fixture does not deny as expected",
        fixtureName
      )
    );
  }
}

function validateRawPolicyBundleShape(
  rawPolicyBundle: unknown,
  fixtureName: string
): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  const candidates = Array.isArray(rawPolicyBundle)
    ? rawPolicyBundle
    : [rawPolicyBundle];

  candidates.forEach((candidate, index) => {
    const parsed = PolicyBundleSchema.safeParse(candidate);

    if (!parsed.success) {
      issues.push(
        policyIssue(
          "fixture_policy_bundle_invalid",
          `PolicyBundleSchema failed for bundle ${index}: ${parsed.error.message}`,
          fixtureName
        )
      );
    }
  });

  return issues;
}

function parsePolicyRequest(
  value: unknown,
  fixtureName: string
):
  | {
      ok: true;
      value: PolicyRequest;
    }
  | {
      ok: false;
      issue: PolicyValidationIssue;
    } {
  if (!isRecord(value)) {
    return requestFailure("Policy request must be an object", fixtureName);
  }

  if (!isNonEmptyString(value.requestId)) {
    return requestFailure("Policy request must carry requestId", fixtureName);
  }

  if (!isNonEmptyString(value.runId)) {
    return requestFailure("Policy request must carry runId", fixtureName);
  }

  if (!isNonEmptyString(value.phase)) {
    return requestFailure("Policy request must carry phase", fixtureName);
  }

  if (!isRecord(value.action)) {
    return requestFailure("Policy request action must be an object", fixtureName);
  }

  if (!isNonEmptyString(value.action.kind)) {
    return requestFailure("Policy request action must carry kind", fixtureName);
  }

  return {
    ok: true,
    value: value as PolicyRequest
  };
}

function parseReplayRecordedDecision(
  value: unknown,
  fixtureName: string
):
  | {
      ok: true;
      value: ReplayRecordedDecision;
    }
  | {
      ok: false;
      issue: PolicyValidationIssue;
    } {
  if (!isRecord(value)) {
    return replayFailure("Recorded replay decision must be an object", fixtureName);
  }

  if (!isHashDigest(value.storedDecisionHash)) {
    return replayFailure(
      "Recorded replay decision must carry storedDecisionHash",
      fixtureName
    );
  }

  if (!isReplayDivergenceClass(value.expectedDivergenceClass)) {
    return replayFailure(
      "Recorded replay decision must carry expectedDivergenceClass",
      fixtureName
    );
  }

  if (
    value.hashAlgoVersion !== undefined &&
    value.hashAlgoVersion !== "v1"
  ) {
    return replayFailure(
      "Recorded replay decision carries an unsupported hashAlgoVersion",
      fixtureName
    );
  }

  if (value.requestHash !== undefined && !isHashDigest(value.requestHash)) {
    return replayFailure("Recorded replay requestHash is malformed", fixtureName);
  }

  if (
    value.policyBundleHash !== undefined &&
    !isHashDigest(value.policyBundleHash)
  ) {
    return replayFailure(
      "Recorded replay policyBundleHash is malformed",
      fixtureName
    );
  }

  const output: ReplayRecordedDecision = {
    storedDecisionHash: value.storedDecisionHash,
    expectedDivergenceClass: value.expectedDivergenceClass
  };

  if (typeof value.sourceFixture === "string") {
    output.sourceFixture = value.sourceFixture;
  }

  if (value.hashAlgoVersion === "v1") {
    output.hashAlgoVersion = value.hashAlgoVersion;
  }

  if (isHashDigest(value.requestHash)) {
    output.requestHash = value.requestHash;
  }

  if (isHashDigest(value.policyBundleHash)) {
    output.policyBundleHash = value.policyBundleHash;
  }

  return {
    ok: true,
    value: output
  };
}

function requestFailure(message: string, fixtureName: string) {
  return {
    ok: false,
    issue: policyIssue("fixture_request_invalid", message, fixtureName)
  } as const;
}

function replayFailure(message: string, fixtureName: string) {
  return {
    ok: false,
    issue: policyIssue("replay_record_invalid", message, fixtureName)
  } as const;
}

async function fileNamesFor(fixtureDir: string): Promise<ReadonlySet<string>> {
  const entries = await readdir(fixtureDir, { withFileTypes: true });

  return new Set(
    entries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  );
}

async function readFixtureMeta(
  fixtureDir: string,
  fixtureName: string,
  issues: PolicyValidationIssue[]
): Promise<PolicyFixtureMeta> {
  const metaPath = join(fixtureDir, "meta.json");
  const readResult = await readJsonFile(metaPath, fixtureName);
  if (!readResult.ok) {
    if (readResult.issue.message.includes("ENOENT")) {
      return {};
    }

    issues.push(readResult.issue);
    return {};
  }

  if (!isRecord(readResult.value)) {
    issues.push(
      policyIssue("metadata_invalid", "Fixture meta.json must be an object", fixtureName)
    );
    return {};
  }

  const meta: PolicyFixtureMeta = {};
  if (readResult.value.domain !== undefined) {
    if (!isNonEmptyString(readResult.value.domain)) {
      issues.push(
        policyIssue(
          "metadata_invalid",
          "Fixture meta domain must be a non-empty string",
          fixtureName
        )
      );
    } else {
      meta.domain = readResult.value.domain;
    }
  }

  if (readResult.value.kind !== undefined) {
    if (!isFixtureKind(readResult.value.kind)) {
      issues.push(
        policyIssue(
          "fixture_kind_invalid",
          "Fixture meta kind is not recognized",
          fixtureName
        )
      );
    } else {
      meta.kind = readResult.value.kind;
    }
  }

  if (readResult.value.mutationOf !== undefined) {
    if (!isNonEmptyString(readResult.value.mutationOf)) {
      issues.push(
        policyIssue(
          "metadata_invalid",
          "Fixture meta mutationOf must be a non-empty string",
          fixtureName
        )
      );
    } else {
      meta.mutationOf = readResult.value.mutationOf;
    }
  }

  if (readResult.value.mutationCategory !== undefined) {
    if (!isMutationCategory(readResult.value.mutationCategory)) {
      issues.push(
        policyIssue(
          "metadata_invalid",
          "Fixture meta mutationCategory is not recognized",
          fixtureName
        )
      );
    } else {
      meta.mutationCategory = readResult.value.mutationCategory;
    }
  }

  if (readResult.value.description !== undefined) {
    if (!isNonEmptyString(readResult.value.description)) {
      issues.push(
        policyIssue(
          "metadata_invalid",
          "Fixture meta description must be a non-empty string",
          fixtureName
        )
      );
    } else {
      meta.description = readResult.value.description;
    }
  }

  return meta;
}

function kindForFixture(
  fixtureName: string,
  fileNames: ReadonlySet<string>,
  meta: PolicyFixtureMeta,
  issues: PolicyValidationIssue[]
): PolicyFixtureKind {
  if (meta.kind !== undefined) {
    return meta.kind;
  }

  if (fileNames.has("expected-verdict.json")) {
    return fileNames.has("recorded-decision.json") ? "replay" : "verdict";
  }

  if (fileNames.has("expected-caller-verdict.json")) {
    return "caller_path_load_failure";
  }

  if (fileNames.has("expected-load-failure.json")) {
    return "load_failure";
  }

  issues.push(
    policyIssue(
      "fixture_kind_invalid",
      "Fixture directory has no recognized policy validation role",
      fixtureName
    )
  );
  return "load_failure";
}

function domainForFixture(
  fixtureName: string,
  meta: PolicyFixtureMeta,
  request: PolicyRequest,
  verdict: PolicyVerdict
): string {
  if (meta.domain !== undefined) {
    return meta.domain;
  }

  if (
    fixtureName.includes("budget") ||
    verdict.matchedRules.some((rule) => rule.ruleId.startsWith("budget."))
  ) {
    return "budget-governance";
  }

  if (fixtureName.includes("scope")) {
    return "scope-governance";
  }

  if (
    fixtureName.includes("approval") ||
    request.action.toolId === "shell.exec"
  ) {
    return "approval-governance";
  }

  if (fixtureName.includes("replay")) {
    return "replay-governance";
  }

  return "capability-admission";
}

async function readJsonFixture(
  fixtureDir: string,
  fixtureName: string,
  fileName: string
): Promise<JsonReadResult> {
  return readJsonFile(join(fixtureDir, fileName), fixtureName, fileName);
}

async function readJsonFile(
  path: string,
  fixtureName: string,
  fileName?: string
): Promise<JsonReadResult> {
  try {
    return {
      ok: true,
      value: JSON.parse(await readFile(path, "utf8")) as unknown
    };
  } catch (error) {
    return {
      ok: false,
      issue: policyIssue(
        "fixture_json_invalid",
        `${fileName ?? path} could not be parsed as JSON: ${errorMessage(error)}`,
        fixtureName
      )
    };
  }
}

function requiredFilesMissing(
  fileNames: ReadonlySet<string>,
  requiredFiles: readonly string[]
) {
  return requiredFiles.filter((fileName) => !fileNames.has(fileName));
}

function sortedVerdictFixtures(fixtures: readonly PolicyVerdictFixture[]) {
  return [...fixtures].sort((left, right) => left.name.localeCompare(right.name));
}

function sortIssues(issues: readonly PolicyValidationIssue[]) {
  return [...issues].sort((left, right) =>
    issueKey(left).localeCompare(issueKey(right))
  );
}

function issueKey(issueValue: PolicyValidationIssue) {
  return [
    issueValue.code,
    issueValue.fixtureName ?? "",
    issueValue.domain ?? "",
    issueValue.message
  ].join("\u0000");
}

function policyIssue(
  code: PolicyValidationIssueCode,
  message: string,
  fixtureName?: string,
  domain?: string
): PolicyValidationIssue {
  const output: PolicyValidationIssue = {
    code,
    message
  };

  if (fixtureName !== undefined) {
    output.fixtureName = fixtureName;
  }

  if (domain !== undefined) {
    output.domain = domain;
  }

  return output;
}

function copyMutationInput(fixture: PolicyVerdictFixture): MutationInput {
  return {
    request: cloneJson(fixture.request),
    policyBundles: cloneJson(fixture.policyBundles)
  };
}

function copyMutationInputFromPrepared(input: MutationInput): MutationInput {
  return {
    request: cloneJson(input.request),
    policyBundles: cloneJson(input.policyBundles)
  };
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function strictnessOf(verdict: PolicyVerdict) {
  return statusStrictness[verdict.status];
}

function appendRuntimeInvariant(
  input: MutationInput,
  rule: FixturePolicyRule
): MutationInput {
  const [firstBundle, ...rest] = input.policyBundles;
  if (firstBundle === undefined) {
    return input;
  }

  return {
    request: input.request,
    policyBundles: [
      {
        ...firstBundle,
        runtimeInvariants: [...(firstBundle.runtimeInvariants ?? []), rule]
      },
      ...rest
    ]
  };
}

export const policyMutationCases = [
  {
    category: "remove_required_scope",
    name: "remove required scope",
    fixtureName: "scope-union-constrained",
    mutate: (input: MutationInput) => ({
      request: {
        ...input.request,
        action: {
          ...input.request.action,
          requestedScopes: (input.request.action.requestedScopes ?? []).filter(
            (scope) => scope !== "agent:observe"
          )
        }
      },
      policyBundles: input.policyBundles
    }),
    expectedRuleId: "tool.fs.read.scope",
    expectedEffect: "deny"
  },
  {
    category: "change_phase",
    name: "change phase",
    fixtureName: "fs-read-allowed-in-evidence",
    mutate: (input: MutationInput) => ({
      request: {
        ...input.request,
        phase: "synthesis"
      },
      policyBundles: input.policyBundles
    }),
    expectedRuleId: "tool.fs.read.phase",
    expectedEffect: "deny"
  },
  {
    category: "exceed_budget",
    name: "exceed budget",
    fixtureName: "budget-within-limit-allowed",
    mutate: (input: MutationInput) => ({
      request: {
        ...input.request,
        action: {
          ...input.request.action,
          budgetCosts: {
            ...input.request.action.budgetCosts,
            fileReadBytes: 800
          }
        }
      },
      policyBundles: input.policyBundles
    }),
    expectedRuleId: "budget.file_read_bytes.deny_max",
    expectedEffect: "deny"
  },
  {
    category: "switch_run_mode_to_ci",
    name: "switch run mode to ci",
    fixtureName: "run-mode-local-dev-allowed",
    mutate: (input: MutationInput) => ({
      request: {
        ...input.request,
        runMode: "ci"
      },
      policyBundles: input.policyBundles
    }),
    expectedRuleId: "run_mode.ci.model_prompt.denied",
    expectedEffect: "deny"
  },
  {
    category: "remove_approval",
    name: "remove approval",
    fixtureName: "shell-exec-approved",
    mutate: (input: MutationInput) => ({
      request: {
        ...input.request,
        snapshots: {
          ...input.request.snapshots,
          approvals: {
            decisions: []
          }
        }
      },
      policyBundles: input.policyBundles
    }),
    expectedRuleId: "tool.shell.exec.default",
    expectedEffect: "approval_required"
  },
  {
    category: "broaden_path",
    name: "broaden path",
    fixtureName: "fs-read-allowed-in-evidence",
    prepare: (input: MutationInput) =>
      appendRuntimeInvariant(input, {
        id: "runtime.fs_read.deny_workspace_root",
        layer: "runtime_invariant",
        effect: "deny",
        reason: "runtime policy denies broad workspace root reads",
        match: {
          actionKind: "tool_call",
          toolId: "fs.read",
          args: [
            {
              path: "path",
              equals: "."
            }
          ]
        }
      }),
    mutate: (input: MutationInput) => ({
      request: {
        ...input.request,
        action: {
          ...input.request.action,
          args: {
            ...input.request.action.args,
            path: "."
          }
        }
      },
      policyBundles: input.policyBundles
    }),
    expectedRuleId: "runtime.fs_read.deny_workspace_root",
    expectedEffect: "deny"
  }
] as const satisfies readonly PolicyMutationCase[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHashDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isFixtureKind(value: unknown): value is PolicyFixtureKind {
  return typeof value === "string" && fixtureKinds.includes(value as PolicyFixtureKind);
}

function isMutationCategory(value: unknown): value is PolicyMutationCategory {
  return (
    typeof value === "string" &&
    mutationCategories.includes(value as PolicyMutationCategory)
  );
}

function isReplayDivergenceClass(
  value: unknown
): value is PolicyReplayDivergenceClass {
  return (
    value === "equivalent" ||
    value === "hash_mismatch" ||
    value === "unverifiable" ||
    value === "unreplayable"
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function printReport(report: PolicyValidationReport) {
  const domains = report.domainCoverage
    .map((entry) => entry.domain)
    .sort((left, right) => left.localeCompare(right));
  const mutations = report.mutationResults
    .map((entry) => entry.category)
    .sort((left, right) => left.localeCompare(right));

  console.log(
    JSON.stringify(
      {
        status: report.issues.length === 0 ? "pass" : "fail",
        totalFixtureDirectories: report.totalFixtureDirectories,
        verdictFixtureCount: report.verdictFixtureCount,
        nonVerdictFixtureCount: report.nonVerdictFixtureCount,
        replayFixtureCount: report.replayFixtureCount,
        decisionHashBaselineEntries: report.decisionHashBaselineEntries,
        domains,
        mutationCategories: mutations,
        issues: report.issues
      },
      null,
      2
    )
  );
}

async function main() {
  const bless = process.argv.includes("--bless");
  const report = await runPolicyValidation({ bless });

  printReport(report);
  if (report.issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
