import { PolicyBundleSchema } from "@specwright/schemas";
import type {
  PolicyRuleEffect,
  PolicyRuleLayer
} from "@specwright/schemas";
import type {
  FixtureBudgetRule,
  FixturePolicyBundle,
  FixturePolicyRule,
  FixtureToolPolicy,
  PolicyArgMatcher
} from "./index";

export const SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION =
  "specwright.policy-bundle.v1";

export type BundleLoadErrorCode =
  | "invalid_schema"
  | "incompatible_version"
  | "duplicate_rule_id"
  | "unsafe_pattern";

export type BundleLoadFailure = {
  code: BundleLoadErrorCode;
  reason: string;
  bundleId?: string;
  ruleId?: string;
  path?: string;
};

export type LoadResult =
  | { ok: true; bundles: FixturePolicyBundle[] }
  | { ok: false; failures: BundleLoadFailure[] };

type Candidate = {
  bundle: unknown;
  index: number;
};

type RuleOccurrence = {
  id: string;
  bundleId: string | undefined;
  path: string;
};

type PatternSafetyResult =
  | { safe: true }
  | { safe: false; reason: string };

const LAYER_ORDER = [
  "runtime_invariant",
  "host",
  "workspace",
  "harness",
  "phase",
  "capability",
  "run_mode",
  "approval"
] as const satisfies readonly PolicyRuleLayer[];

const RULE_EFFECTS = [
  "allow",
  "deny",
  "approval_required",
  "constrain",
  "obligate"
] as const satisfies readonly PolicyRuleEffect[];

const DECISION_TOOL_DEFAULTS = [
  "allow",
  "deny",
  "approval_required"
] as const;

const BUDGET_ON_EXCEEDED = ["deny", "approval_required"] as const;
const BUDGET_LAYERS = ["workspace", "harness", "capability", "run_mode"] as const;
const RISKS = ["low", "medium", "high", "critical"] as const;
const RULE_ARRAY_KEYS = [
  "runtimeInvariants",
  "hostRules",
  "workspaceRules",
  "harnessRules",
  "phaseRules",
  "capabilityRules",
  "runModeRules",
  "rules"
] as const;
const POLICY_OBLIGATION_KINDS = [
  "record_event",
  "redact",
  "stage_write",
  "run_eval",
  "require_evidence",
  "attach_trace",
  "mark_external_source",
  "request_human_review"
] as const;

export function loadPolicyBundles(input: unknown): LoadResult {
  const candidates = normalizeCandidates(input);
  const failures: BundleLoadFailure[] = [];
  const parsedBundles: FixturePolicyBundle[] = [];

  for (const candidate of candidates) {
    const bundleId = bundleIdFor(candidate.bundle);
    const parseResult = PolicyBundleSchema.safeParse(candidate.bundle);

    if (!parseResult.success) {
      for (const issue of parseResult.error.issues) {
        failures.push(
          failure("invalid_schema", {
            bundleId,
            path: pathFor(candidate.index, issue.path),
            reason: issue.message
          })
        );
      }
      continue;
    }

    const bundle = parseResult.data as unknown as FixturePolicyBundle;
    parsedBundles.push(bundle);

    failures.push(...validateSchemaVersion(bundle, candidate.index));
    failures.push(...validateAuthoringExtensions(bundle, candidate.index));
  }

  failures.push(...validateRuleIdUniqueness(parsedBundles));

  if (failures.length > 0) {
    return { ok: false, failures: sortFailures(failures) };
  }

  return { ok: true, bundles: parsedBundles };
}

export function isReDoSUnsafe(pattern: string): boolean {
  return patternSafety(pattern).safe === false;
}

export function policyPatternApplies(pattern: string, value: string): boolean {
  const safety = patternSafety(pattern);

  if (!safety.safe) {
    return false;
  }

  const compiled = compilePattern(pattern);
  return compiled?.test(value) === true;
}

function normalizeCandidates(input: unknown): Candidate[] {
  if (input === undefined) {
    return [];
  }

  return (Array.isArray(input) ? input : [input]).map((bundle, index) => ({
    bundle,
    index
  }));
}

function validateSchemaVersion(
  bundle: FixturePolicyBundle,
  index: number
): BundleLoadFailure[] {
  const declared = readRecord(bundle).schemaVersion;

  if (
    declared !== undefined &&
    declared !== SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION
  ) {
    return [
      failure("incompatible_version", {
        bundleId: validatedBundleId(bundle),
        path: pathFor(index, ["schemaVersion"]),
        reason: `Unsupported policy bundle schemaVersion "${String(
          declared
        )}"; supported version is "${SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION}"`
      })
    ];
  }

  return [];
}

function validateAuthoringExtensions(
  bundle: FixturePolicyBundle,
  index: number
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];
  const record = readRecord(bundle);

  failures.push(...validateStringArray(record.scopes, bundle, index, ["scopes"]));

  for (const key of RULE_ARRAY_KEYS) {
    failures.push(...validateRuleArray(record[key], bundle, index, [key]));
  }

  failures.push(
    ...validateToolPolicy(record.toolPolicy, bundle, index, ["toolPolicy"])
  );
  failures.push(
    ...validateBudgetPolicy(record.budgetPolicy, bundle, index, ["budgetPolicy"])
  );

  return failures;
}

function validateRuleArray(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (value === undefined) {
    return failures;
  }

  if (!Array.isArray(value)) {
    return [
      invalid(bundle, index, path, "Expected policy rule array")
    ];
  }

  value.forEach((rule, ruleIndex) => {
    failures.push(
      ...validateRule(rule, bundle, index, [...path, ruleIndex])
    );
  });

  return failures;
}

function validateRule(
  rule: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (!isRecord(rule)) {
    return [invalid(bundle, index, path, "Expected policy rule object")];
  }

  const typedRule = rule as Partial<FixturePolicyRule>;

  failures.push(...validateNonEmptyString(typedRule.id, bundle, index, [...path, "id"], "rule id"));
  failures.push(
    ...validateEnum(
      typedRule.layer,
      LAYER_ORDER,
      bundle,
      index,
      [...path, "layer"],
      "rule layer"
    )
  );
  failures.push(
    ...validateEnum(
      typedRule.effect,
      RULE_EFFECTS,
      bundle,
      index,
      [...path, "effect"],
      "rule effect"
    )
  );
  failures.push(
    ...validateNonEmptyString(typedRule.reason, bundle, index, [...path, "reason"], "rule reason")
  );

  if (typedRule.approvalId !== undefined) {
    failures.push(
      ...validateNonEmptyString(
        typedRule.approvalId,
        bundle,
        index,
        [...path, "approvalId"],
        "approval id"
      )
    );
  }

  failures.push(
    ...validateMatchCriteria(typedRule.match, bundle, index, [...path, "match"], typedRule.id)
  );
  failures.push(
    ...validateAuthoringConstraints(
      typedRule.constraints,
      bundle,
      index,
      [...path, "constraints"]
    )
  );
  failures.push(
    ...validateAuthoringObligations(
      typedRule.obligations,
      bundle,
      index,
      [...path, "obligations"]
    )
  );

  return failures;
}

function validateMatchCriteria(
  match: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  ruleId: string | undefined
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (match === undefined) {
    return failures;
  }

  if (!isRecord(match)) {
    return [invalid(bundle, index, path, "Expected rule match object")];
  }

  failures.push(...validateStringOrStringArray(match.actionKind, bundle, index, [...path, "actionKind"]));
  failures.push(...validateStringOrStringArray(match.toolId, bundle, index, [...path, "toolId"]));
  failures.push(...validateStringArray(match.phases, bundle, index, [...path, "phases"]));
  failures.push(...validateEnumOrEnumArray(match.risk, RISKS, bundle, index, [...path, "risk"], "risk"));
  failures.push(...validateStringArray(match.runModes, bundle, index, [...path, "runModes"]));
  failures.push(...validateStringArray(match.requestedScopes, bundle, index, [...path, "requestedScopes"]));

  if (match.args !== undefined) {
    if (!Array.isArray(match.args)) {
      failures.push(invalid(bundle, index, [...path, "args"], "Expected args matcher array"));
    } else {
      match.args.forEach((matcher, matcherIndex) => {
        failures.push(
          ...validateArgMatcher(
            matcher,
            bundle,
            index,
            [...path, "args", matcherIndex],
            ruleId
          )
        );
      });
    }
  }

  return failures;
}

function validateArgMatcher(
  matcher: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  ruleId: string | undefined
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (!isRecord(matcher)) {
    return [invalid(bundle, index, path, "Expected arg matcher object")];
  }

  const typedMatcher = matcher as Partial<PolicyArgMatcher>;
  failures.push(
    ...validateNonEmptyString(typedMatcher.path, bundle, index, [...path, "path"], "arg matcher path")
  );

  if (typedMatcher.includes !== undefined) {
    failures.push(
      ...validateNonEmptyString(
        typedMatcher.includes,
        bundle,
        index,
        [...path, "includes"],
        "arg matcher includes"
      )
    );
  }

  if (typedMatcher.pattern !== undefined) {
    failures.push(
      ...validateNonEmptyString(
        typedMatcher.pattern,
        bundle,
        index,
        [...path, "pattern"],
        "arg matcher pattern"
      )
    );

    if (typeof typedMatcher.pattern === "string" && typedMatcher.pattern.length > 0) {
      const safety = patternSafety(typedMatcher.pattern);

      if (!safety.safe) {
        failures.push(
          failure("unsafe_pattern", {
            bundleId: validatedBundleId(bundle),
            ruleId,
            path: pathFor(index, [...path, "pattern"]),
            reason: safety.reason
          })
        );
      }
    }
  }

  return failures;
}

function validateToolPolicy(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (value === undefined) {
    return failures;
  }

  if (!isRecord(value)) {
    return [invalid(bundle, index, path, "Expected toolPolicy object")];
  }

  for (const [toolId, policy] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    const toolPath = [...path, toolId];
    failures.push(
      ...validateNonEmptyString(toolId, bundle, index, [...toolPath, "id"], "tool id")
    );

    if (!isRecord(policy)) {
      failures.push(invalid(bundle, index, toolPath, "Expected tool policy object"));
      continue;
    }

    const typedPolicy = policy as Partial<FixtureToolPolicy>;
    failures.push(
      ...validateEnum(
        typedPolicy.default,
        DECISION_TOOL_DEFAULTS,
        bundle,
        index,
        [...toolPath, "default"],
        "tool policy default"
      )
    );
    failures.push(
      ...validateEnumOrUndefined(
        typedPolicy.risk,
        RISKS,
        bundle,
        index,
        [...toolPath, "risk"],
        "tool policy risk"
      )
    );
    failures.push(...validateOptionalString(typedPolicy.reason, bundle, index, [...toolPath, "reason"], "tool policy reason"));
    failures.push(...validateOptionalString(typedPolicy.approvalId, bundle, index, [...toolPath, "approvalId"], "tool policy approval id"));
    failures.push(...validateStringArray(typedPolicy.allowedPhases, bundle, index, [...toolPath, "allowedPhases"]));
    failures.push(...validateStringArray(typedPolicy.allowedScopes, bundle, index, [...toolPath, "allowedScopes"]));
    failures.push(...validateStringArray(typedPolicy.requiredScopes, bundle, index, [...toolPath, "requiredScopes"]));
    failures.push(...validateAuthoringConstraints(typedPolicy.constraints, bundle, index, [...toolPath, "constraints"]));
    failures.push(...validateAuthoringObligations(typedPolicy.obligations, bundle, index, [...toolPath, "obligations"]));
  }

  return failures;
}

function validateBudgetPolicy(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (value === undefined) {
    return failures;
  }

  if (!Array.isArray(value)) {
    return [invalid(bundle, index, path, "Expected budgetPolicy array")];
  }

  value.forEach((rule, ruleIndex) => {
    const rulePath = [...path, ruleIndex];

    if (!isRecord(rule)) {
      failures.push(invalid(bundle, index, rulePath, "Expected budget policy rule object"));
      return;
    }

    const typedRule = rule as Partial<FixtureBudgetRule>;
    failures.push(...validateNonEmptyString(typedRule.id, bundle, index, [...rulePath, "id"], "budget rule id"));
    failures.push(...validateNonEmptyString(typedRule.resource, bundle, index, [...rulePath, "resource"], "budget resource"));
    failures.push(
      ...validateNumber(
        typedRule.max,
        bundle,
        index,
        [...rulePath, "max"],
        "budget max"
      )
    );
    failures.push(
      ...validateEnum(
        typedRule.onExceeded,
        BUDGET_ON_EXCEEDED,
        bundle,
        index,
        [...rulePath, "onExceeded"],
        "budget onExceeded"
      )
    );
    failures.push(...validateNonEmptyString(typedRule.reason, bundle, index, [...rulePath, "reason"], "budget reason"));
    failures.push(
      ...validateEnumOrUndefined(
        typedRule.layer,
        BUDGET_LAYERS,
        bundle,
        index,
        [...rulePath, "layer"],
        "budget layer"
      )
    );
    failures.push(...validateOptionalString(typedRule.approvalId, bundle, index, [...rulePath, "approvalId"], "budget approval id"));
    failures.push(...validateAuthoringConstraints(typedRule.constraints, bundle, index, [...rulePath, "constraints"]));
    failures.push(...validateAuthoringObligations(typedRule.obligations, bundle, index, [...rulePath, "obligations"]));
  });

  return failures;
}

function validateRuleIdUniqueness(
  bundles: readonly FixturePolicyBundle[]
): BundleLoadFailure[] {
  const occurrences = new Map<string, RuleOccurrence[]>();

  bundles.forEach((bundle, bundleIndex) => {
    for (const key of RULE_ARRAY_KEYS) {
      const rules = readRecord(bundle)[key];

      if (Array.isArray(rules)) {
        rules.forEach((rule, ruleIndex) => {
          if (isRecord(rule) && typeof rule.id === "string" && rule.id.length > 0) {
            addOccurrence(occurrences, rule.id, {
              id: rule.id,
              bundleId: validatedBundleId(bundle),
              path: pathFor(bundleIndex, [key, ruleIndex, "id"])
            });
          }
        });
      }
    }

    if (isRecord(bundle.toolPolicy)) {
      for (const toolId of Object.keys(bundle.toolPolicy).sort()) {
        const toolPolicy = bundle.toolPolicy[toolId];
        const synthesizedIds = [`tool.${toolId}.default`];

        if (isRecord(toolPolicy) && Array.isArray(toolPolicy.allowedPhases)) {
          synthesizedIds.push(`tool.${toolId}.phase`);
        }

        if (
          isRecord(toolPolicy) &&
          (Array.isArray(toolPolicy.allowedScopes) ||
            Array.isArray(toolPolicy.requiredScopes))
        ) {
          synthesizedIds.push(`tool.${toolId}.scope`);
        }

        for (const synthesizedId of synthesizedIds) {
          addOccurrence(occurrences, synthesizedId, {
            id: synthesizedId,
            bundleId: validatedBundleId(bundle),
            path: pathFor(bundleIndex, ["toolPolicy", toolId])
          });
        }
      }
    }

    if (Array.isArray(bundle.budgetPolicy)) {
      bundle.budgetPolicy.forEach((rule, ruleIndex) => {
        if (isRecord(rule)) {
          if (typeof rule.id === "string" && rule.id.length > 0) {
            addOccurrence(occurrences, rule.id, {
              id: rule.id,
              bundleId: validatedBundleId(bundle),
              path: pathFor(bundleIndex, ["budgetPolicy", ruleIndex, "id"])
            });
          }

          if (typeof rule.resource === "string" && rule.resource.length > 0) {
            const synthesizedId = `budget.${rule.resource}.missing_policy`;
            addOccurrence(occurrences, synthesizedId, {
              id: synthesizedId,
              bundleId: validatedBundleId(bundle),
              path: pathFor(bundleIndex, ["budgetPolicy", ruleIndex, "resource"])
            });
          }
        }
      });
    }
  });

  const failures: BundleLoadFailure[] = [];
  for (const [id, ruleOccurrences] of [...occurrences.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (ruleOccurrences.length > 1) {
      const first = ruleOccurrences[0];
      failures.push(
        failure("duplicate_rule_id", {
          bundleId: first?.bundleId,
          ruleId: id,
          path: first?.path,
          reason: `Rule id "${id}" appears ${ruleOccurrences.length} times across the bundle set`
        })
      );
    }
  }

  return failures;
}

function addOccurrence(
  occurrences: Map<string, RuleOccurrence[]>,
  id: string,
  occurrence: RuleOccurrence
) {
  const existing = occurrences.get(id);

  if (existing === undefined) {
    occurrences.set(id, [occurrence]);
    return;
  }

  existing.push(occurrence);
}

function validateAuthoringConstraints(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (value === undefined) {
    return failures;
  }

  if (!Array.isArray(value)) {
    return [invalid(bundle, index, path, "Expected constraints array")];
  }

  value.forEach((constraint, constraintIndex) => {
    const constraintPath = [...path, constraintIndex];

    if (!isRecord(constraint)) {
      failures.push(invalid(bundle, index, constraintPath, "Expected constraint object"));
      return;
    }

    failures.push(
      ...validateNonEmptyString(
        constraint.kind,
        bundle,
        index,
        [...constraintPath, "kind"],
        "constraint kind"
      )
    );
  });

  return failures;
}

function validateAuthoringObligations(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
): BundleLoadFailure[] {
  const failures: BundleLoadFailure[] = [];

  if (value === undefined) {
    return failures;
  }

  if (!Array.isArray(value)) {
    return [invalid(bundle, index, path, "Expected obligations array")];
  }

  value.forEach((obligation, obligationIndex) => {
    const obligationPath = [...path, obligationIndex];

    if (!isRecord(obligation)) {
      failures.push(invalid(bundle, index, obligationPath, "Expected obligation object"));
      return;
    }

    failures.push(
      ...validateEnum(
        obligation.kind,
        POLICY_OBLIGATION_KINDS,
        bundle,
        index,
        [...obligationPath, "kind"],
        "obligation kind"
      )
    );

    if (obligation.params !== undefined && !isRecord(obligation.params)) {
      failures.push(invalid(bundle, index, [...obligationPath, "params"], "Expected obligation params object"));
    }
  });

  return failures;
}

function validateStringOrStringArray(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
) {
  if (value === undefined) {
    return [];
  }

  if (typeof value === "string" && value.length > 0) {
    return [];
  }

  if (Array.isArray(value)) {
    return validateStringArray(value, bundle, index, path);
  }

  return [invalid(bundle, index, path, "Expected non-empty string or string array")];
}

function validateStringArray(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[]
) {
  const failures: BundleLoadFailure[] = [];

  if (value === undefined) {
    return failures;
  }

  if (!Array.isArray(value)) {
    return [invalid(bundle, index, path, "Expected string array")];
  }

  value.forEach((entry, entryIndex) => {
    failures.push(
      ...validateNonEmptyString(
        entry,
        bundle,
        index,
        [...path, entryIndex],
        "string array entry"
      )
    );
  });

  return failures;
}

function validateEnumOrEnumArray<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  label: string
) {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, entryIndex) =>
      validateEnum(entry, allowed, bundle, index, [...path, entryIndex], label)
    );
  }

  return validateEnum(value, allowed, bundle, index, path, label);
}

function validateEnumOrUndefined<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  label: string
) {
  if (value === undefined) {
    return [];
  }

  return validateEnum(value, allowed, bundle, index, path, label);
}

function validateEnum<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  label: string
) {
  if (typeof value === "string" && allowed.includes(value as TValue)) {
    return [];
  }

  return [
    invalid(bundle, index, path, `Expected ${label} to be one of ${allowed.join(", ")}`)
  ];
}

function validateNumber(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  label: string
) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return [];
  }

  return [invalid(bundle, index, path, `Expected ${label} to be a finite number`)];
}

function validateOptionalString(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  label: string
) {
  if (value === undefined) {
    return [];
  }

  return validateNonEmptyString(value, bundle, index, path, label);
}

function validateNonEmptyString(
  value: unknown,
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  label: string
) {
  if (typeof value === "string" && value.length > 0) {
    return [];
  }

  return [invalid(bundle, index, path, `Expected ${label} to be a non-empty string`)];
}

function invalid(
  bundle: FixturePolicyBundle,
  index: number,
  path: readonly (string | number)[],
  reason: string
) {
  return failure("invalid_schema", {
    bundleId: validatedBundleId(bundle),
    path: pathFor(index, path),
    reason
  });
}

function patternSafety(pattern: string): PatternSafetyResult {
  const compiled = compilePattern(pattern);

  if (compiled === undefined) {
    return { safe: false, reason: "Pattern is not valid regular expression syntax" };
  }

  const sanitized = sanitizePattern(pattern);
  const groupIssues = findGroupIssues(sanitized);

  if (groupIssues !== undefined) {
    return groupIssues;
  }

  if (hasAdjacentOverlappingUnboundedQuantifiers(sanitized)) {
    return {
      safe: false,
      reason: "Pattern contains adjacent overlapping unbounded quantifiers"
    };
  }

  return { safe: true };
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function sanitizePattern(pattern: string) {
  let sanitized = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "\\") {
      sanitized += "L";
      index += 1;
      continue;
    }

    if (char === "[") {
      sanitized += "C";
      index = consumeCharacterClass(pattern, index);
      continue;
    }

    sanitized += char;
  }

  return sanitized;
}

function consumeCharacterClass(pattern: string, start: number) {
  for (let index = start + 1; index < pattern.length; index += 1) {
    if (pattern[index] === "\\") {
      index += 1;
      continue;
    }

    if (pattern[index] === "]") {
      return index;
    }
  }

  return pattern.length - 1;
}

function findGroupIssues(pattern: string): PatternSafetyResult | undefined {
  const stack: Array<{ start: number }> = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "(") {
      stack.push({ start: index });
      continue;
    }

    if (char !== ")" || stack.length === 0) {
      continue;
    }

    const group = stack.pop();

    if (group === undefined) {
      continue;
    }

    const quantifier = readQuantifier(pattern, index + 1);

    if (quantifier === undefined || !quantifier.unbounded) {
      continue;
    }

    const content = stripGroupPrefix(pattern.slice(group.start + 1, index));

    if (containsUnboundedQuantifier(content)) {
      return {
        safe: false,
        reason: "Pattern contains nested unbounded quantifiers"
      };
    }

    if (hasUnboundedAlternation(content)) {
      return {
        safe: false,
        reason: "Pattern contains unbounded alternation under a quantifier"
      };
    }
  }

  return undefined;
}

function stripGroupPrefix(content: string) {
  if (content.startsWith("?:")) {
    return content.slice(2);
  }

  if (content.startsWith("?=") || content.startsWith("?!")) {
    return content.slice(2);
  }

  if (content.startsWith("?<=") || content.startsWith("?<!")) {
    return content.slice(3);
  }

  return content;
}

function containsUnboundedQuantifier(content: string) {
  for (let index = 0; index < content.length; index += 1) {
    const quantifier = readQuantifier(content, index + 1);

    if (quantifier?.unbounded === true && isQuantifiableAtom(content[index])) {
      return true;
    }
  }

  return false;
}

function hasUnboundedAlternation(content: string) {
  const alternatives = splitTopLevelAlternatives(content);

  if (alternatives.length < 2) {
    return false;
  }

  for (const alternative of alternatives) {
    if (containsUnboundedQuantifier(alternative)) {
      return true;
    }
  }

  for (let leftIndex = 0; leftIndex < alternatives.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < alternatives.length;
      rightIndex += 1
    ) {
      if (alternativesOverlap(alternatives[leftIndex] ?? "", alternatives[rightIndex] ?? "")) {
        return true;
      }
    }
  }

  return false;
}

function splitTopLevelAlternatives(content: string) {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    } else if (char === "|" && depth === 0) {
      alternatives.push(content.slice(start, index));
      start = index + 1;
    }
  }

  alternatives.push(content.slice(start));
  return alternatives;
}

function alternativesOverlap(left: string, right: string) {
  const leftFirst = firstAtom(left);
  const rightFirst = firstAtom(right);

  if (leftFirst === undefined || rightFirst === undefined) {
    return true;
  }

  return (
    leftFirst === rightFirst ||
    leftFirst === "." ||
    rightFirst === "." ||
    leftFirst === "C" ||
    rightFirst === "C" ||
    left.startsWith(right) ||
    right.startsWith(left)
  );
}

function hasAdjacentOverlappingUnboundedQuantifiers(pattern: string) {
  const tokens: Array<{ atom: string; unbounded: boolean }> = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const atom = pattern[index];

    if (!isQuantifiableAtom(atom)) {
      continue;
    }

    const quantifier = readQuantifier(pattern, index + 1);
    if (quantifier === undefined) {
      tokens.push({ atom, unbounded: false });
      continue;
    }

    tokens.push({ atom, unbounded: quantifier.unbounded });
    index = quantifier.endIndex - 1;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const left = tokens[index - 1];
    const right = tokens[index];

    if (
      left?.unbounded === true &&
      right?.unbounded === true &&
      atomsOverlap(left.atom, right.atom)
    ) {
      return true;
    }
  }

  return false;
}

function atomsOverlap(left: string, right: string) {
  return left === right || left === "." || right === "." || left === "C" || right === "C";
}

function firstAtom(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (isQuantifiableAtom(char)) {
      return char;
    }
  }

  return undefined;
}

function isQuantifiableAtom(value: string | undefined): value is string {
  return value !== undefined && value !== ")" && value !== "|" && value !== "^" && value !== "$";
}

function readQuantifier(
  pattern: string,
  start: number
): { unbounded: boolean; endIndex: number } | undefined {
  const char = pattern[start];

  if (char === "*" || char === "+") {
    return { unbounded: true, endIndex: start + 1 };
  }

  if (char === "?") {
    return { unbounded: false, endIndex: start + 1 };
  }

  if (char !== "{") {
    return undefined;
  }

  const end = pattern.indexOf("}", start + 1);

  if (end === -1) {
    return undefined;
  }

  const body = pattern.slice(start + 1, end);
  const unbounded = /^\d+,$/.test(body);

  return { unbounded, endIndex: end + 1 };
}

function sortFailures(failures: readonly BundleLoadFailure[]) {
  return [...failures].sort((left, right) => stableFailureKey(left).localeCompare(stableFailureKey(right)));
}

function stableFailureKey(failureValue: BundleLoadFailure) {
  return [
    failureValue.code,
    failureValue.bundleId ?? "",
    failureValue.ruleId ?? "",
    failureValue.path ?? "",
    failureValue.reason
  ].join("\u0000");
}

function failure(
  code: BundleLoadErrorCode,
  input: {
    reason: string;
    bundleId?: string | undefined;
    ruleId?: string | undefined;
    path?: string | undefined;
  }
): BundleLoadFailure {
  const output: BundleLoadFailure = {
    code,
    reason: input.reason
  };

  if (input.bundleId !== undefined) {
    output.bundleId = input.bundleId;
  }

  if (input.ruleId !== undefined) {
    output.ruleId = input.ruleId;
  }

  if (input.path !== undefined) {
    output.path = input.path;
  }

  return output;
}

function pathFor(index: number, path: readonly (string | number)[]) {
  return [`bundles`, String(index), ...path.map(String)].join(".");
}

function bundleIdFor(value: unknown) {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    ? value.id
    : undefined;
}

function validatedBundleId(bundle: FixturePolicyBundle) {
  return bundleIdFor(bundle);
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
