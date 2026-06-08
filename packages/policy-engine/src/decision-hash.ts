import { createHash } from "node:crypto";
import type {
  PolicyConstraint,
  PolicyObligation,
  PolicyVerdictStatus
} from "@specwright/schemas";

export const HASH_ALGO_VERSION = "v1";
export const HASH_ALGO_VERSIONS = [HASH_ALGO_VERSION] as const;

export type HashAlgoVersion = (typeof HASH_ALGO_VERSIONS)[number];
export type HashDigest = `sha256:${string}`;

export type DecisionHashInput = {
  requestHash: string;
  policyBundleHash: string;
  matchedRuleIds: string[];
  status: PolicyVerdictStatus;
  constraints: PolicyConstraint[];
  obligations: PolicyObligation[];
};

export type DecisionHashResult = {
  hash: HashDigest;
  algoVersion: HashAlgoVersion;
};

export function isHashAlgoVersion(value: unknown): value is HashAlgoVersion {
  return HASH_ALGO_VERSIONS.includes(value as HashAlgoVersion);
}

export function hashDecision(input: DecisionHashInput): HashDigest {
  return hashDecisionForVersion(input, HASH_ALGO_VERSION);
}

export function hashDecisionWithMetadata(
  input: DecisionHashInput
): DecisionHashResult {
  return {
    hash: hashDecision(input),
    algoVersion: HASH_ALGO_VERSION
  };
}

export function hashDecisionForVersion(
  input: DecisionHashInput,
  version: HashAlgoVersion
): HashDigest {
  switch (version) {
    case "v1":
      return hashJsonForVersion(input, version);
    default:
      return assertNever(version);
  }
}

export function hashJson(value: unknown): HashDigest {
  return hashJsonForVersion(value, HASH_ALGO_VERSION);
}

export function hashJsonForVersion(
  value: unknown,
  version: HashAlgoVersion
): HashDigest {
  switch (version) {
    case "v1":
      return `sha256:${createHash("sha256")
        .update(stableStringify(value))
        .digest("hex")}`;
    default:
      return assertNever(version);
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

/**
 * v1 canonicalization rules:
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

function assertNever(value: never): never {
  throw new Error(`Unhandled decision hash algorithm version ${String(value)}`);
}
