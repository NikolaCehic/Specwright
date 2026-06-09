import {
  ApprovalDecisionSchema,
  BudgetStateSchema,
  PolicyVerdictSchema,
  RunStateSchema,
  type PolicyVerdictStatus
} from "@specwright/schemas";
import { loadPolicyBundles } from "./bundle-load";
import {
  HASH_ALGO_VERSION,
  hashDecisionForVersion,
  hashJsonForVersion,
  isHashAlgoVersion,
  type HashAlgoVersion,
  type HashDigest
} from "./decision-hash";
import { evaluatePolicy, type PolicyRequest } from "./index";

export type PolicyDecisionReplayRecord = {
  request: unknown;
  bundles: unknown;
  storedDecisionHash: HashDigest;
  hashAlgoVersion?: HashAlgoVersion;
  requestHash?: HashDigest;
  policyBundleHash?: HashDigest;
};

export type PolicyReplayDivergenceClass =
  | "equivalent"
  | "hash_mismatch"
  | "unverifiable"
  | "unreplayable";

export type PolicyReplayStatus =
  | PolicyVerdictStatus
  | "unverifiable"
  | "unreplayable";

export type PolicyReplayResult = {
  recomputedHash: HashDigest | null;
  storedHash: string | null;
  equivalent: boolean;
  status: PolicyReplayStatus;
  divergenceClass: PolicyReplayDivergenceClass;
  hashAlgoVersion: HashAlgoVersion | null;
  requestHash: HashDigest | null;
  policyBundleHash: HashDigest | null;
  reason: string;
};

type ValidationResult<TValue> =
  | {
      ok: true;
      value: TValue;
    }
  | {
      ok: false;
      reason: string;
    };

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const POLICY_RISKS = ["low", "medium", "high", "critical"] as const;
type PolicyRisk = (typeof POLICY_RISKS)[number];

export function replayPolicyDecision(recorded: unknown): PolicyReplayResult {
  if (!isRecord(recorded)) {
    return unverifiable(
      null,
      null,
      "Recorded policy decision must be an object"
    );
  }

  const storedHash = readStoredHash(recorded.storedDecisionHash);
  if (storedHash === undefined) {
    return unverifiable(
      typeof recorded.storedDecisionHash === "string"
        ? recorded.storedDecisionHash
        : null,
      null,
      "Recorded policy decision must carry a sha256 storedDecisionHash"
    );
  }

  const versionValue = recorded.hashAlgoVersion ?? HASH_ALGO_VERSION;
  if (!isHashAlgoVersion(versionValue)) {
    return unreplayable(
      storedHash,
      null,
      `Recorded hash algorithm version ${String(versionValue)} is not supported`
    );
  }

  const requestResult = validatePolicyRequest(recorded.request);
  if (!requestResult.ok) {
    return unverifiable(storedHash, versionValue, requestResult.reason);
  }

  if (!("bundles" in recorded) || recorded.bundles === undefined) {
    return unreplayable(
      storedHash,
      versionValue,
      "Recorded policy decision is missing its bundle set"
    );
  }

  const loadResult = loadPolicyBundles(recorded.bundles);
  if (!loadResult.ok) {
    return unverifiable(
      storedHash,
      versionValue,
      "Recorded policy bundle set failed validation"
    );
  }

  const recordedPolicyBundleHash = readStoredHash(recorded.policyBundleHash);
  if (recordedPolicyBundleHash === undefined) {
    if (recorded.policyBundleHash === undefined) {
      return unreplayable(
        storedHash,
        versionValue,
        "Recorded policy decision is missing a pinned policyBundleHash"
      );
    }

    return unverifiable(
      storedHash,
      versionValue,
      "Recorded policyBundleHash must be a sha256 digest"
    );
  }

  const recordedRequestHash = readStoredHash(recorded.requestHash);
  if (
    recorded.requestHash !== undefined &&
    recordedRequestHash === undefined
  ) {
    return unverifiable(
      storedHash,
      versionValue,
      "Recorded requestHash must be a sha256 digest when supplied"
    );
  }

  const requestHash = hashJsonForVersion(requestResult.value, versionValue);
  const policyBundleHash = hashJsonForVersion(loadResult.bundles, versionValue);
  const requestHashDrift =
    recordedRequestHash !== undefined && recordedRequestHash !== requestHash;
  const policyBundleHashDrift = recordedPolicyBundleHash !== policyBundleHash;

  try {
    const verdict = PolicyVerdictSchema.parse(
      evaluatePolicy(requestResult.value, loadResult.bundles)
    );
    const recomputedHash = hashDecisionForVersion(
      {
        requestHash,
        policyBundleHash,
        matchedRuleIds: verdict.matchedRules.map((rule) => rule.ruleId),
        status: verdict.status,
        constraints: verdict.constraints,
        obligations: verdict.obligations
      },
      versionValue
    );
    const equivalent =
      recomputedHash === storedHash &&
      !requestHashDrift &&
      !policyBundleHashDrift;

    return {
      recomputedHash,
      storedHash,
      equivalent,
      status: verdict.status,
      divergenceClass: equivalent ? "equivalent" : "hash_mismatch",
      hashAlgoVersion: versionValue,
      requestHash,
      policyBundleHash,
      reason: equivalent
        ? "Recorded decision hash is replay equivalent"
        : mismatchReason(requestHashDrift, policyBundleHashDrift)
    };
  } catch (error) {
    return {
      recomputedHash: null,
      storedHash,
      equivalent: false,
      status: "unverifiable",
      divergenceClass: "unverifiable",
      hashAlgoVersion: versionValue,
      requestHash,
      policyBundleHash,
      reason: `Recorded policy inputs could not be evaluated: ${errorMessage(
        error
      )}`
    };
  }
}

export function verifyDecisionHash(recorded: unknown): PolicyReplayResult {
  return replayPolicyDecision(recorded);
}

function validatePolicyRequest(value: unknown): ValidationResult<PolicyRequest> {
  if (!isRecord(value)) {
    return failure("Recorded request must be an object");
  }

  if (!isNonEmptyString(value.requestId)) {
    return failure("Recorded request must carry requestId");
  }

  if (!isNonEmptyString(value.runId)) {
    return failure("Recorded request must carry runId");
  }

  if (!isNonEmptyString(value.phase)) {
    return failure("Recorded request must carry phase");
  }

  if (!isRecord(value.action)) {
    return failure("Recorded request action must be an object");
  }

  const action = value.action;
  if (!isNonEmptyString(action.kind)) {
    return failure("Recorded request action must carry kind");
  }

  if (action.toolId !== undefined && !isNonEmptyString(action.toolId)) {
    return failure("Recorded request action toolId must be non-empty");
  }

  if (action.args !== undefined && !isRecord(action.args)) {
    return failure("Recorded request action args must be an object when supplied");
  }

  if (
    action.requestedScopes !== undefined &&
    !isStringArray(action.requestedScopes)
  ) {
    return failure("Recorded request action requestedScopes must be strings");
  }

  if (action.risk !== undefined && !isPolicyRisk(action.risk)) {
    return failure("Recorded request action risk is not recognized");
  }

  if (
    action.budgetCosts !== undefined &&
    !isFiniteNumberRecord(action.budgetCosts)
  ) {
    return failure("Recorded request action budgetCosts must be finite numbers");
  }

  if (value.runMode !== undefined && !isNonEmptyString(value.runMode)) {
    return failure("Recorded request runMode must be non-empty");
  }

  const snapshotsResult = validateSnapshots(value.snapshots);
  if (!snapshotsResult.ok) {
    return snapshotsResult;
  }

  return {
    ok: true,
    value: value as PolicyRequest
  };
}

function validateSnapshots(value: unknown): ValidationResult<undefined> {
  if (value === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }

  if (!isRecord(value)) {
    return failure("Recorded request snapshots must be an object");
  }

  if (value.runState !== undefined && !RunStateSchema.safeParse(value.runState).success) {
    return failure("Recorded request snapshots.runState is malformed");
  }

  if (
    value.harnessPolicy !== undefined &&
    !loadPolicyBundles(value.harnessPolicy).ok
  ) {
    return failure("Recorded request snapshots.harnessPolicy is malformed");
  }

  if (
    value.workspacePolicy !== undefined &&
    !loadPolicyBundles(value.workspacePolicy).ok
  ) {
    return failure("Recorded request snapshots.workspacePolicy is malformed");
  }

  if (
    value.budgets !== undefined &&
    !BudgetStateSchema.safeParse(value.budgets).success
  ) {
    return failure("Recorded request snapshots.budgets is malformed");
  }

  const approvalsResult = validateApprovals(value.approvals);
  if (!approvalsResult.ok) {
    return approvalsResult;
  }

  const hostPolicyResult = validateHostPolicy(value.hostPolicy);
  if (!hostPolicyResult.ok) {
    return hostPolicyResult;
  }

  if (value.sourceTrust !== undefined && !isRecord(value.sourceTrust)) {
    return failure("Recorded request snapshots.sourceTrust must be an object");
  }

  return {
    ok: true,
    value: undefined
  };
}

function validateApprovals(value: unknown): ValidationResult<undefined> {
  if (value === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }

  if (Array.isArray(value)) {
    return validateApprovalDecisionArray(value);
  }

  if (!isRecord(value)) {
    return failure("Recorded request snapshots.approvals is malformed");
  }

  if (value.decisions === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }

  if (!Array.isArray(value.decisions)) {
    return failure("Recorded request snapshots.approvals.decisions must be an array");
  }

  return validateApprovalDecisionArray(value.decisions);
}

function validateApprovalDecisionArray(
  decisions: readonly unknown[]
): ValidationResult<undefined> {
  const malformedDecision = decisions.find(
    (decision) => !ApprovalDecisionSchema.safeParse(decision).success
  );

  if (malformedDecision !== undefined) {
    return failure("Recorded request approval decision is malformed");
  }

  return {
    ok: true,
    value: undefined
  };
}

function validateHostPolicy(value: unknown): ValidationResult<undefined> {
  if (value === undefined) {
    return {
      ok: true,
      value: undefined
    };
  }

  if (!isRecord(value)) {
    return failure("Recorded request snapshots.hostPolicy is malformed");
  }

  if (value.deniedTools !== undefined && !isStringArray(value.deniedTools)) {
    return failure("Recorded request snapshots.hostPolicy.deniedTools is malformed");
  }

  if (value.allowedTools !== undefined && !isStringArray(value.allowedTools)) {
    return failure("Recorded request snapshots.hostPolicy.allowedTools is malformed");
  }

  return {
    ok: true,
    value: undefined
  };
}

function mismatchReason(
  requestHashDrift: boolean,
  policyBundleHashDrift: boolean
) {
  if (requestHashDrift) {
    return "Recorded requestHash does not match the replay request";
  }

  if (policyBundleHashDrift) {
    return "Recorded policyBundleHash does not match the replay bundle set";
  }

  return "Stored decision hash does not match the recomputed decision hash";
}

function readStoredHash(value: unknown): HashDigest | undefined {
  return typeof value === "string" && HASH_PATTERN.test(value)
    ? (value as HashDigest)
    : undefined;
}

function unverifiable(
  storedHash: string | null,
  hashAlgoVersion: HashAlgoVersion | null,
  reason: string
): PolicyReplayResult {
  return {
    recomputedHash: null,
    storedHash,
    equivalent: false,
    status: "unverifiable",
    divergenceClass: "unverifiable",
    hashAlgoVersion,
    requestHash: null,
    policyBundleHash: null,
    reason
  };
}

function unreplayable(
  storedHash: string | null,
  hashAlgoVersion: HashAlgoVersion | null,
  reason: string
): PolicyReplayResult {
  return {
    recomputedHash: null,
    storedHash,
    equivalent: false,
    status: "unreplayable",
    divergenceClass: "unreplayable",
    hashAlgoVersion,
    requestHash: null,
    policyBundleHash: null,
    reason
  };
}

function failure(reason: string): ValidationResult<never> {
  return {
    ok: false,
    reason
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) =>
        isNonEmptyString(key) &&
        typeof entry === "number" &&
        Number.isFinite(entry)
    )
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPolicyRisk(value: unknown): value is PolicyRisk {
  return (
    typeof value === "string" && POLICY_RISKS.includes(value as PolicyRisk)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
