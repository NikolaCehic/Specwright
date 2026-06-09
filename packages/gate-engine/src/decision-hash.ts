import { createHash } from "node:crypto";
import type {
  GateFinding,
  GateObligation,
  GateRequiredAction,
  GateSeverity,
  GateVerdict,
  GateVerdictStatus
} from "@specwright/schemas";

export type HashDigest = `sha256:${string}`;

export type GateDecisionHashInput = {
  gateId: string;
  phase: string;
  status: GateVerdictStatus;
  severity: GateSeverity;
  requiredAction?: GateRequiredAction;
  findings: GateFinding[];
  reasons: string[];
  evidenceRefs: string[];
  obligations: GateObligation[];
  evaluatedAt: string;
  evaluator: GateVerdict["evaluator"];
};

export function gateDecisionHashInput(
  verdict: Omit<GateVerdict, "decisionHash"> | GateVerdict
): GateDecisionHashInput {
  const inputBase: Omit<GateDecisionHashInput, "requiredAction"> = {
    gateId: verdict.gateId,
    phase: verdict.phase,
    status: verdict.status,
    severity: verdict.severity,
    findings: verdict.findings,
    reasons: verdict.reasons,
    evidenceRefs: verdict.evidenceRefs,
    obligations: verdict.obligations,
    evaluatedAt: verdict.evaluatedAt,
    evaluator: verdict.evaluator
  };

  if (verdict.requiredAction === undefined) {
    return inputBase;
  }

  const requiredAction = verdict.requiredAction;

  return {
    ...inputBase,
    requiredAction
  };
}

export function hashDecision(input: GateDecisionHashInput): HashDigest {
  return hashJson(input);
}

export function hashJson(value: unknown): HashDigest {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

/**
 * Canonicalization rules mirror the policy engine:
 * - object keys are sorted recursively with Object.keys(...).sort()
 * - properties whose normalized value is undefined are dropped
 * - array order is preserved because array order is semantic
 * - JSON.stringify serializes the normalized value
 * - sha256 hex digests are returned with a sha256: prefix
 */
export function normalizeStable(value: unknown): unknown {
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
