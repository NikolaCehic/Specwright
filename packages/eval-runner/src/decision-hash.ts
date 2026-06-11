import { createHash } from "node:crypto";
import type { EvalSeverity, EvalVerdict } from "@specwright/schemas";

export const DECISION_HASH_FAIL_CLOSED_CODE = "eval.decision_hash.unresolved";

export type HashDigest = `sha256:${string}`;

export type DecisionInputHashes = {
  targetContentHash: HashDigest;
  evidenceSnapshotHash: HashDigest;
  definitionHash: HashDigest;
  checkResultsHash: HashDigest;
};

export type OrderedCheckResult = {
  checkId?: string | undefined;
  type?: string | undefined;
  status: "pass" | "fail" | "needs_review";
  code?: string | undefined;
  path?: string | undefined;
};

export type ResolvedInputsHashInput = {
  targetContent?: unknown;
  evidenceSnapshot?: unknown;
  definition?: unknown;
  definitionHash?: string | undefined;
  checkResults: readonly OrderedCheckResult[];
};

export type DecisionHashInput = DecisionInputHashes & {
  evalId: string;
  targetRef: string;
  status: EvalVerdict["status"];
  severity: EvalSeverity;
  producedByRef: string;
};

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ABSENT_INPUT_SENTINEL_VERSION = "specwright.eval-runner.absent-input.v0";
const UNRESOLVED_INPUT_SENTINEL_VERSION =
  "specwright.eval-runner.unresolved-input.v0";
const INPUT_HASH_CAUSATION_PREFIX = "specwright.eval-runner.input-hash";

export class DecisionHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionHashError";
  }
}

export function hashValue(value: unknown): HashDigest {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

export function hashResolvedInputs(
  input: ResolvedInputsHashInput
): DecisionInputHashes {
  return {
    targetContentHash: hashValue(
      input.targetContent === undefined
        ? absentInputSentinel("targetContent")
        : input.targetContent
    ),
    evidenceSnapshotHash: hashValue(
      input.evidenceSnapshot === undefined
        ? absentInputSentinel("evidenceSnapshot")
        : input.evidenceSnapshot
    ),
    definitionHash:
      input.definitionHash !== undefined
        ? ensureHashDigest(input.definitionHash, "definitionHash")
        : hashValue(
            input.definition === undefined
              ? absentInputSentinel("definition")
              : input.definition
          ),
    checkResultsHash: hashValue(input.checkResults)
  };
}

export function unresolvedDecisionInputHashes(reason: string): DecisionInputHashes {
  return {
    targetContentHash: hashValue(unresolvedInputSentinel("targetContent", reason)),
    evidenceSnapshotHash: hashValue(
      unresolvedInputSentinel("evidenceSnapshot", reason)
    ),
    definitionHash: hashValue(unresolvedInputSentinel("definition", reason)),
    checkResultsHash: hashValue(unresolvedInputSentinel("checkResults", reason))
  };
}

export function computeDecisionHash(input: DecisionHashInput): HashDigest {
  return hashValue({
    evalId: input.evalId,
    targetRef: input.targetRef,
    status: input.status,
    severity: input.severity,
    producedByRef: input.producedByRef,
    targetContentHash: input.targetContentHash,
    evidenceSnapshotHash: input.evidenceSnapshotHash,
    definitionHash: input.definitionHash,
    checkResultsHash: input.checkResultsHash
  });
}

export function recomputeDecisionHash(
  verdict: EvalVerdict,
  recordedInputHashes: DecisionInputHashes = inputHashesFromVerdict(verdict)
): HashDigest {
  const storedDecisionHash = verdict.provenance?.decisionHash;

  if (!isHashDigest(storedDecisionHash)) {
    throw new DecisionHashError("verdict provenance is missing decisionHash");
  }

  const recomputed = computeDecisionHash({
    evalId: verdict.evalId,
    targetRef: verdict.targetRef,
    status: verdict.status,
    severity: verdict.severity,
    producedByRef: verdict.producedBy.ref,
    ...recordedInputHashes
  });

  if (recomputed !== storedDecisionHash) {
    throw new DecisionHashError("decisionHash does not match recorded input hashes");
  }

  return recomputed;
}

export function inputHashesFromVerdict(verdict: EvalVerdict): DecisionInputHashes {
  const provenance = verdict.provenance;

  if (provenance === undefined) {
    throw new DecisionHashError("verdict provenance is missing");
  }

  const hashes = inputHashesFromCausationIds(provenance.causationIds ?? []);

  return {
    targetContentHash: ensureHashDigest(hashes.targetContentHash, "targetContentHash"),
    evidenceSnapshotHash: ensureHashDigest(
      hashes.evidenceSnapshotHash,
      "evidenceSnapshotHash"
    ),
    definitionHash: ensureHashDigest(hashes.definitionHash, "definitionHash"),
    checkResultsHash: ensureHashDigest(hashes.checkResultsHash, "checkResultsHash")
  };
}

export function inputHashesToCausationIds(
  inputHashes: DecisionInputHashes
): string[] {
  return [
    `${INPUT_HASH_CAUSATION_PREFIX}.targetContentHash=${inputHashes.targetContentHash}`,
    `${INPUT_HASH_CAUSATION_PREFIX}.evidenceSnapshotHash=${inputHashes.evidenceSnapshotHash}`,
    `${INPUT_HASH_CAUSATION_PREFIX}.definitionHash=${inputHashes.definitionHash}`,
    `${INPUT_HASH_CAUSATION_PREFIX}.checkResultsHash=${inputHashes.checkResultsHash}`
  ];
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value)) ?? "undefined";
}

export function normalizeStable(value: unknown): unknown {
  return normalizeStableValue(value, new WeakSet<object>());
}

function normalizeStableValue(
  value: unknown,
  seen: WeakSet<object>
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DecisionHashError("non-finite numbers cannot be hashed");
    }

    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new DecisionHashError(`${typeof value} values cannot be hashed`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new DecisionHashError("cyclic values cannot be hashed");
    }

    seen.add(value);
    const normalized = value.map((item) => normalizeStableValue(item, seen));
    seen.delete(value);
    return normalized;
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) {
      throw new DecisionHashError("cyclic values cannot be hashed");
    }

    seen.add(value);
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const normalizedValue = normalizeStableValue(value[key], seen);

      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
    }

    seen.delete(value);
    return normalized;
  }

  throw new DecisionHashError(
    `unsupported ${objectTypeName(value)} object cannot be hashed`
  );
}

function absentInputSentinel(input: string) {
  return {
    kind: "absent",
    input,
    sentinel: ABSENT_INPUT_SENTINEL_VERSION
  };
}

function unresolvedInputSentinel(input: string, reason: string) {
  return {
    kind: "unresolved",
    input,
    reason,
    sentinel: UNRESOLVED_INPUT_SENTINEL_VERSION
  };
}

function ensureHashDigest(value: unknown, label: string): HashDigest {
  if (!isHashDigest(value)) {
    throw new DecisionHashError(`${label} must be sha256:<64 lowercase hex chars>`);
  }

  return value;
}

function inputHashesFromCausationIds(
  causationIds: readonly string[]
): Partial<DecisionInputHashes> {
  const hashes: Partial<DecisionInputHashes> = {};

  for (const causationId of causationIds) {
    const [key, value] = causationId.split("=");

    switch (key) {
      case `${INPUT_HASH_CAUSATION_PREFIX}.targetContentHash`:
        hashes.targetContentHash = ensureHashDigest(value, "targetContentHash");
        break;
      case `${INPUT_HASH_CAUSATION_PREFIX}.evidenceSnapshotHash`:
        hashes.evidenceSnapshotHash = ensureHashDigest(
          value,
          "evidenceSnapshotHash"
        );
        break;
      case `${INPUT_HASH_CAUSATION_PREFIX}.definitionHash`:
        hashes.definitionHash = ensureHashDigest(value, "definitionHash");
        break;
      case `${INPUT_HASH_CAUSATION_PREFIX}.checkResultsHash`:
        hashes.checkResultsHash = ensureHashDigest(value, "checkResultsHash");
        break;
      default:
        break;
    }
  }

  return hashes;
}

function isHashDigest(value: unknown): value is HashDigest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function objectTypeName(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return typeof value;
  }

  return value.constructor?.name ?? "non-plain";
}
