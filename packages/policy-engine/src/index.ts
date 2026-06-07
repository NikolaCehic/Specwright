import { createHash } from "node:crypto";
import {
  PolicyVerdictSchema,
  type ApprovalDecision,
  type BudgetState,
  type PolicyBundle,
  type PolicyConstraint,
  type PolicyObligation,
  type PolicyRuleEffect,
  type PolicyRuleLayer,
  type PolicyRuleMatch as RuleMatch,
  type PolicyVerdict,
  type PolicyVerdictStatus,
  type RunState
} from "@specwright/schemas";
import { policyPatternApplies } from "./bundle-load";

export type {
  ApprovalDecision,
  BudgetState,
  PolicyBundle,
  PolicyConstraint,
  PolicyObligation,
  PolicyRuleEffect,
  PolicyRuleLayer,
  PolicyRuleMatch as RuleMatch,
  PolicyVerdict,
  PolicyVerdictStatus,
  RunState
} from "@specwright/schemas";
export {
  loadPolicyBundles,
  isReDoSUnsafe,
  SUPPORTED_POLICY_BUNDLE_SCHEMA_VERSION
} from "./bundle-load";
export type {
  BundleLoadErrorCode,
  BundleLoadFailure,
  LoadResult
} from "./bundle-load";

export type PolicyRisk = "low" | "medium" | "high" | "critical";

export type PolicyAction = {
  kind: string;
  toolId?: string;
  args?: Record<string, unknown>;
  requestedScopes?: string[];
  risk?: PolicyRisk;
  budgetCosts?: Record<string, number>;
};

export type ApprovalState = {
  decisions?: ApprovalDecision[];
};

export type HostPolicySnapshot = {
  deniedTools?: string[];
  allowedTools?: string[];
};

export type PolicyRequest = {
  requestId: string;
  runId: string;
  phase: string;
  action: PolicyAction;
  runMode?: string;
  snapshots?: {
    runState?: RunState;
    harnessPolicy?: PolicyBundle | PolicyBundle[];
    hostPolicy?: HostPolicySnapshot;
    workspacePolicy?: PolicyBundle | PolicyBundle[];
    budgets?: BudgetState;
    approvals?: ApprovalState | ApprovalDecision[];
    sourceTrust?: Record<string, unknown>;
  };
};

export type PolicyArgMatcher = {
  path: string;
  equals?: unknown;
  includes?: string;
  pattern?: string;
};

export type PolicyRuleMatchCriteria = {
  actionKind?: string | string[];
  toolId?: string | string[];
  phases?: string[];
  risk?: PolicyRisk | PolicyRisk[];
  runModes?: string[];
  requestedScopes?: string[];
  args?: PolicyArgMatcher[];
};

export type FixturePolicyRule = {
  id: string;
  layer: PolicyRuleLayer;
  effect: PolicyRuleEffect;
  reason: string;
  match?: PolicyRuleMatchCriteria;
  approvalId?: string | undefined;
  constraints?: Array<Omit<PolicyConstraint, "sourceRuleId">>;
  obligations?: Array<Omit<PolicyObligation, "sourceRuleId">>;
};

export type FixtureToolPolicy = {
  default: "allow" | "deny" | "approval_required";
  risk?: PolicyRisk;
  reason?: string;
  approvalId?: string | undefined;
  allowedPhases?: string[];
  allowedScopes?: string[];
  requiredScopes?: string[];
  constraints?: Array<Omit<PolicyConstraint, "sourceRuleId">>;
  obligations?: Array<Omit<PolicyObligation, "sourceRuleId">>;
};

export type FixtureBudgetRule = {
  id: string;
  resource: string;
  max: number;
  onExceeded: "deny" | "approval_required";
  reason: string;
  layer?: Extract<
    PolicyRuleLayer,
    "workspace" | "harness" | "capability" | "run_mode"
  >;
  approvalId?: string | undefined;
  constraints?: Array<Omit<PolicyConstraint, "sourceRuleId">>;
  obligations?: Array<Omit<PolicyObligation, "sourceRuleId">>;
};

export type FixturePolicyBundle = Omit<PolicyBundle, "rules"> & {
  rules?: FixturePolicyRule[];
  runtimeInvariants?: FixturePolicyRule[];
  hostRules?: FixturePolicyRule[];
  workspaceRules?: FixturePolicyRule[];
  harnessRules?: FixturePolicyRule[];
  phaseRules?: FixturePolicyRule[];
  capabilityRules?: FixturePolicyRule[];
  runModeRules?: FixturePolicyRule[];
  toolPolicy?: Record<string, FixtureToolPolicy>;
  budgetPolicy?: FixtureBudgetRule[];
};

type InternalRuleMatch = RuleMatch & {
  approvalId?: string | undefined;
  constraints: PolicyConstraint[];
  obligations: PolicyObligation[];
  sequence: number;
};

const LAYER_ORDER: readonly PolicyRuleLayer[] = [
  "runtime_invariant",
  "host",
  "workspace",
  "harness",
  "phase",
  "capability",
  "run_mode",
  "approval"
];

const DECISION_EFFECTS = new Set<PolicyRuleEffect>([
  "allow",
  "deny",
  "approval_required"
]);

export function evaluatePolicy(
  request: PolicyRequest,
  policyBundles?: FixturePolicyBundle | readonly FixturePolicyBundle[]
): PolicyVerdict {
  const bundles = normalizePolicyBundles(
    policyBundles ?? request.snapshots?.harnessPolicy
  );
  const matches: InternalRuleMatch[] = [];
  let sequence = 0;

  sequence = addHostPolicySnapshotMatches(request, matches, sequence);

  for (const bundle of bundles) {
    for (const rule of collectExplicitRules(bundle)) {
      if (ruleMatchesRequest(rule, request)) {
        matches.push(ruleToMatch(rule, sequence));
        sequence += 1;
      }
    }

    sequence = addToolPolicyMatches(request, bundle, matches, sequence);
    sequence = addBudgetPolicyMatches(request, bundle, matches, sequence);
  }

  if (!hasDecisionMatch(matches)) {
    matches.push(missingPolicyMatch(request, sequence));
    sequence += 1;
  }

  sortMatches(matches);

  const denyMatches = matches.filter((match) => match.effect === "deny");
  if (denyMatches.length > 0) {
    return verdictForStatus("deny", request, bundles, matches);
  }

  const approvalMatches = matches.filter(
    (match) => match.effect === "approval_required"
  );
  if (approvalMatches.length > 0) {
    const unsatisfiedApproval = approvalMatches.find(
      (match) => findApprovalDecision(request, approvalIdFor(match)) === undefined
    );

    if (unsatisfiedApproval !== undefined) {
      return verdictForStatus(
        "approval_required",
        request,
        bundles,
        matches,
        approvalIdFor(unsatisfiedApproval)
      );
    }

    for (const match of approvalMatches) {
      const approvalId = approvalIdFor(match);
      const approvalDecision = findApprovalDecision(request, approvalId);
      const approvalRuleId = `approval.${approvalId}.approved`;
      matches.push({
        ruleId: approvalRuleId,
        layer: "approval",
        effect: "allow",
        reason: `Approval ${approvalId} satisfies policy requirement`,
        constraints: approvalDecisionConstraints(approvalDecision, approvalRuleId),
        obligations: [],
        sequence
      });
      sequence += 1;
    }

    sortMatches(matches);
    return verdictForStatus("allow", request, bundles, matches);
  }

  return verdictForStatus("allow", request, bundles, matches);
}

function addHostPolicySnapshotMatches(
  request: PolicyRequest,
  matches: InternalRuleMatch[],
  sequence: number
) {
  const hostPolicy = request.snapshots?.hostPolicy;
  const toolId = request.action.toolId;

  if (hostPolicy === undefined || toolId === undefined) {
    return sequence;
  }

  if (hostPolicy.deniedTools?.includes(toolId) === true) {
    matches.push({
      ruleId: `host.${toolId}.deny`,
      layer: "host",
      effect: "deny",
      reason: `Host policy denies ${toolId}`,
      constraints: [],
      obligations: [],
      sequence
    });
    sequence += 1;
  }

  if (
    Array.isArray(hostPolicy.allowedTools) &&
    !hostPolicy.allowedTools.includes(toolId)
  ) {
    matches.push({
      ruleId: `host.${toolId}.not_allowed`,
      layer: "host",
      effect: "deny",
      reason: `Host policy does not allow ${toolId}`,
      constraints: [],
      obligations: [],
      sequence
    });
    sequence += 1;
  }

  return sequence;
}

function addToolPolicyMatches(
  request: PolicyRequest,
  bundle: FixturePolicyBundle,
  matches: InternalRuleMatch[],
  sequence: number
) {
  const toolId = request.action.toolId;
  const toolPolicy = toolId === undefined ? undefined : bundle.toolPolicy?.[toolId];

  if (toolId === undefined || toolPolicy === undefined) {
    return sequence;
  }

  const phaseRuleId = `tool.${toolId}.phase`;
  if (Array.isArray(toolPolicy.allowedPhases)) {
    if (toolPolicy.allowedPhases.includes(request.phase)) {
      matches.push({
        ruleId: phaseRuleId,
        layer: "phase",
        effect: "allow",
        reason: `Tool ${toolId} is allowed in phase ${request.phase}`,
        constraints: [],
        obligations: [],
        sequence
      });
    } else {
      matches.push({
        ruleId: phaseRuleId,
        layer: "phase",
        effect: "deny",
        reason: `Tool ${toolId} is not allowed in phase ${request.phase}`,
        constraints: [],
        obligations: [],
        sequence
      });
    }
    sequence += 1;
  }

  const scopeMatch = evaluateScopePolicy(request, bundle, toolPolicy, toolId);
  if (scopeMatch !== undefined) {
    matches.push({
      ...scopeMatch,
      sequence
    });
    sequence += 1;
  }

  const defaultRuleId = `tool.${toolId}.default`;
  matches.push({
    ruleId: defaultRuleId,
    layer: "capability",
    effect: toolPolicy.default,
    reason:
      toolPolicy.reason ?? `Tool ${toolId} default policy is ${toolPolicy.default}`,
    approvalId: toolPolicy.approvalId,
    constraints: withSourceRule(toolPolicy.constraints, defaultRuleId),
    obligations: obligationsWithSourceRule(toolPolicy.obligations, defaultRuleId),
    sequence
  });

  return sequence + 1;
}

function evaluateScopePolicy(
  request: PolicyRequest,
  bundle: FixturePolicyBundle,
  toolPolicy: FixtureToolPolicy,
  toolId: string
): Omit<InternalRuleMatch, "sequence"> | undefined {
  const requestedScopes = request.action.requestedScopes ?? [];
  const requiredScopes = toolPolicy.requiredScopes ?? [];
  const allowedScopes = uniqueStrings([
    ...stringArray(bundle.scopes),
    ...(toolPolicy.allowedScopes ?? []),
    ...requiredScopes
  ]);
  const scopeRuleId = `tool.${toolId}.scope`;

  if (requiredScopes.length === 0 && requestedScopes.length === 0) {
    return undefined;
  }

  const missingRequiredScope = requiredScopes.find(
    (scope) => !requestedScopes.includes(scope)
  );
  if (missingRequiredScope !== undefined) {
    return {
      ruleId: scopeRuleId,
      layer: "capability",
      effect: "deny",
      reason: `Tool ${toolId} is missing required scope ${missingRequiredScope}`,
      constraints: [],
      obligations: []
    };
  }

  const exceededScope = requestedScopes.find(
    (scope) => !allowedScopes.includes(scope)
  );
  if (exceededScope !== undefined) {
    return {
      ruleId: scopeRuleId,
      layer: "capability",
      effect: "deny",
      reason: `Tool ${toolId} requested scope ${exceededScope} outside policy`,
      constraints: [],
      obligations: []
    };
  }

  return {
    ruleId: scopeRuleId,
    layer: "capability",
    effect: "constrain",
    reason: `Tool ${toolId} scopes are within policy`,
    constraints: [
      {
        kind: "allowedScopes",
        value: allowedScopes,
        sourceRuleId: scopeRuleId
      }
    ],
    obligations: []
  };
}

function addBudgetPolicyMatches(
  request: PolicyRequest,
  bundle: FixturePolicyBundle,
  matches: InternalRuleMatch[],
  sequence: number
) {
  const budgetCosts = request.action.budgetCosts ?? {};
  const budgetPolicy = bundle.budgetPolicy ?? [];
  const governedResources = new Set(budgetPolicy.map((rule) => rule.resource));

  for (const [resource, cost] of Object.entries(budgetCosts)) {
    if (cost > 0 && !governedResources.has(resource)) {
      matches.push({
        ruleId: `budget.${resource}.missing_policy`,
        layer: "harness",
        effect: "deny",
        reason: `No budget policy exists for resource ${resource}`,
        constraints: [],
        obligations: [],
        sequence
      });
      sequence += 1;
    }
  }

  for (const rule of budgetPolicy) {
    const requested = budgetCosts[rule.resource] ?? 0;
    const used = readBudgetUsed(request.snapshots?.budgets, rule.resource);

    if (requested > 0 && used + requested > rule.max) {
      matches.push({
        ruleId: rule.id,
        layer: rule.layer ?? "harness",
        effect: rule.onExceeded,
        reason: rule.reason,
        approvalId: rule.approvalId,
        constraints:
          rule.constraints === undefined
            ? [
                {
                  kind: "budget.max",
                  value: {
                    resource: rule.resource,
                    max: rule.max
                  },
                  sourceRuleId: rule.id
                }
              ]
            : withSourceRule(rule.constraints, rule.id),
        obligations: obligationsWithSourceRule(rule.obligations, rule.id),
        sequence
      });
      sequence += 1;
    }
  }

  return sequence;
}

function verdictForStatus(
  status: PolicyVerdictStatus,
  request: PolicyRequest,
  bundles: readonly FixturePolicyBundle[],
  matches: readonly InternalRuleMatch[],
  approvalId?: string
): PolicyVerdict {
  const constraints = uniqueByStableJson(
    matches.flatMap((match) => match.constraints)
  );
  const obligations = uniqueByStableJson(
    matches.flatMap((match) => match.obligations)
  );
  const matchedRules = matches.map(stripInternalMatch);
  const decisionHash = hashDecision({
    requestHash: hashJson(request),
    policyBundleHash: hashJson(bundles),
    matchedRuleIds: matchedRules.map((rule) => rule.ruleId),
    status,
    constraints,
    obligations
  });
  const base = {
    status,
    reasons: reasonsFor(status, matchedRules),
    constraints,
    obligations,
    matchedRules,
    decisionHash
  };

  if (status === "approval_required") {
    return PolicyVerdictSchema.parse({
      ...base,
      approvalId: approvalId ?? "approval_required"
    });
  }

  return PolicyVerdictSchema.parse(base);
}

function collectExplicitRules(bundle: FixturePolicyBundle) {
  return [
    ...(bundle.runtimeInvariants ?? []),
    ...(bundle.hostRules ?? []),
    ...(bundle.workspaceRules ?? []),
    ...(bundle.harnessRules ?? []),
    ...(bundle.phaseRules ?? []),
    ...(bundle.capabilityRules ?? []),
    ...(bundle.runModeRules ?? []),
    ...(bundle.rules ?? [])
  ];
}

function ruleMatchesRequest(rule: FixturePolicyRule, request: PolicyRequest) {
  const match = rule.match;

  if (match === undefined) {
    return true;
  }

  if (!matchesOne(match.actionKind, request.action.kind)) {
    return false;
  }

  if (!matchesOne(match.toolId, request.action.toolId)) {
    return false;
  }

  if (
    Array.isArray(match.phases) &&
    !match.phases.includes(request.phase)
  ) {
    return false;
  }

  if (!matchesOne(match.risk, actionRisk(request))) {
    return false;
  }

  if (
    Array.isArray(match.runModes) &&
    (request.runMode === undefined || !match.runModes.includes(request.runMode))
  ) {
    return false;
  }

  if (
    Array.isArray(match.requestedScopes) &&
    !match.requestedScopes.every((scope) =>
      request.action.requestedScopes?.includes(scope)
    )
  ) {
    return false;
  }

  if (
    Array.isArray(match.args) &&
    !match.args.every((matcher) => argMatcherApplies(matcher, request.action.args))
  ) {
    return false;
  }

  return true;
}

function argMatcherApplies(
  matcher: PolicyArgMatcher,
  args: Record<string, unknown> | undefined
) {
  const value = readPath(args, matcher.path);

  if ("equals" in matcher && stableStringify(value) !== stableStringify(matcher.equals)) {
    return false;
  }

  if (
    matcher.includes !== undefined &&
    (typeof value !== "string" || !value.includes(matcher.includes))
  ) {
    return false;
  }

  if (
    matcher.pattern !== undefined &&
    (typeof value !== "string" || !policyPatternApplies(matcher.pattern, value))
  ) {
    return false;
  }

  return true;
}

function ruleToMatch(rule: FixturePolicyRule, sequence: number): InternalRuleMatch {
  return {
    ruleId: rule.id,
    layer: rule.layer,
    effect: rule.effect,
    reason: rule.reason,
    approvalId: rule.approvalId,
    constraints: withSourceRule(rule.constraints, rule.id),
    obligations: obligationsWithSourceRule(rule.obligations, rule.id),
    sequence
  };
}

function missingPolicyMatch(
  request: PolicyRequest,
  sequence: number
): InternalRuleMatch {
  const actionName = request.action.toolId ?? request.action.kind;
  const risk = actionRisk(request);
  const reason =
    risk === "low"
      ? `No applicable policy exists for action ${actionName}`
      : `No applicable policy exists for risky action ${actionName}`;

  return {
    ruleId: "runtime.missing_policy.fail_closed",
    layer: "runtime_invariant",
    effect: "deny",
    reason,
    constraints: [],
    obligations: [],
    sequence
  };
}

function hasDecisionMatch(matches: readonly InternalRuleMatch[]) {
  return matches.some((match) => DECISION_EFFECTS.has(match.effect));
}

function approvalIdFor(match: InternalRuleMatch) {
  return match.approvalId ?? `approval.${match.ruleId}`;
}

function findApprovalDecision(
  request: PolicyRequest,
  approvalId: string
): ApprovalDecision | undefined {
  const approvals = request.snapshots?.approvals;
  const decisions = Array.isArray(approvals) ? approvals : approvals?.decisions;

  return decisions?.find(
    (decision) =>
      decision.approvalId === approvalId &&
      (decision.decision === "approved" ||
        decision.decision === "approved_with_changes")
  );
}

function approvalDecisionConstraints(
  decision: ApprovalDecision | undefined,
  sourceRuleId: string
) {
  if (decision?.constraints === undefined) {
    return [];
  }

  return Object.entries(decision.constraints).map(([kind, value]) => ({
    kind,
    value,
    sourceRuleId
  }));
}

function actionRisk(request: PolicyRequest): PolicyRisk {
  if (request.action.risk !== undefined) {
    return request.action.risk;
  }

  switch (request.action.toolId) {
    case "fs.read":
    case "fs.list":
      return "low";
    case "shell.exec":
    case "git.commit":
    case "git.push":
      return "high";
    case "network.write":
    case "deploy":
    case "secrets.read":
      return "critical";
    default:
      return "medium";
  }
}

function readBudgetUsed(budgets: BudgetState | undefined, resource: string) {
  const value = budgets?.[resource];

  if (typeof value === "number") {
    return value;
  }

  if (isRecord(value) && typeof value.used === "number") {
    return value.used;
  }

  return 0;
}

function withSourceRule(
  constraints: Array<Omit<PolicyConstraint, "sourceRuleId">> | undefined,
  sourceRuleId: string
): PolicyConstraint[] {
  return (constraints ?? []).map((constraint) => ({
    ...constraint,
    sourceRuleId
  }));
}

function obligationsWithSourceRule(
  obligations: Array<Omit<PolicyObligation, "sourceRuleId">> | undefined,
  sourceRuleId: string
): PolicyObligation[] {
  return (obligations ?? []).map((obligation) => ({
    ...obligation,
    sourceRuleId
  }));
}

function reasonsFor(
  status: PolicyVerdictStatus,
  matchedRules: readonly RuleMatch[]
) {
  if (status === "deny") {
    return uniqueStrings(
      matchedRules
        .filter((rule) => rule.effect === "deny")
        .map((rule) => rule.reason)
    );
  }

  if (status === "approval_required") {
    return uniqueStrings(
      matchedRules
        .filter((rule) => rule.effect === "approval_required")
        .map((rule) => rule.reason)
    );
  }

  return uniqueStrings(
    matchedRules
      .filter((rule) => rule.effect !== "deny")
      .map((rule) => rule.reason)
  );
}

function stripInternalMatch(match: InternalRuleMatch): RuleMatch {
  return {
    ruleId: match.ruleId,
    layer: match.layer,
    effect: match.effect,
    reason: match.reason
  };
}

function normalizePolicyBundles(
  policyBundles:
    | PolicyBundle
    | FixturePolicyBundle
    | readonly (PolicyBundle | FixturePolicyBundle)[]
    | undefined
): FixturePolicyBundle[] {
  if (policyBundles === undefined) {
    return [];
  }

  return (Array.isArray(policyBundles) ? policyBundles : [policyBundles]).map(
    (bundle) => bundle as FixturePolicyBundle
  );
}

function sortMatches(matches: InternalRuleMatch[]) {
  matches.sort((left, right) => {
    const layerDelta = layerRank(left.layer) - layerRank(right.layer);

    if (layerDelta !== 0) {
      return layerDelta;
    }

    return left.sequence - right.sequence;
  });
}

function layerRank(layer: PolicyRuleLayer) {
  return LAYER_ORDER.indexOf(layer);
}

function matchesOne<TValue extends string>(
  expected: TValue | TValue[] | undefined,
  actual: TValue | undefined
) {
  if (expected === undefined) {
    return true;
  }

  if (actual === undefined) {
    return false;
  }

  return Array.isArray(expected)
    ? expected.includes(actual)
    : expected === actual;
}

function readPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) {
      return undefined;
    }

    return current[segment];
  }, root);
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function uniqueByStableJson<TValue>(values: readonly TValue[]) {
  const seen = new Set<string>();
  const result: TValue[] = [];

  for (const value of values) {
    const key = stableStringify(value);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function hashDecision(input: {
  requestHash: string;
  policyBundleHash: string;
  matchedRuleIds: string[];
  status: PolicyVerdictStatus;
  constraints: PolicyConstraint[];
  obligations: PolicyObligation[];
}) {
  return hashJson(input);
}

function hashJson(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

function normalizeStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStable);
  }

  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const normalizedValue = normalizeStable(value[key]);

      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
    }

    return normalized;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
