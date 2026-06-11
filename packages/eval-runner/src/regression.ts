import { z } from "zod";
import type { EvalVerdict } from "@specwright/schemas";
import {
  DecisionHashError,
  recomputeDecisionHash,
  type DecisionInputHashes,
  type HashDigest
} from "./decision-hash";
import {
  DATASET_HASH_MISMATCH_CODE,
  targetTypeFromTargetRef,
  verifyDatasetPin,
  type DatasetReference,
  type PinnedDataset
} from "./datasets";

export const REGRESSION_DECISION_HASH_DEFECT_CODE =
  "eval.regression.decision_hash_mismatch";
export const REGRESSION_GOLDEN_MISSING_CODE = "eval.regression.golden_missing";
export const REGRESSION_GOLDEN_BINDING_MISMATCH_CODE =
  "eval.regression.golden_binding_mismatch";
export const REPLAY_DERIVATION_REQUIRED_CODE =
  "eval.dataset.rederive_required";

const HashDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u) as z.ZodType<HashDigest>;

export const EvalRegressionProvenanceSchema = z
  .object({
    priorStatus: z.enum(["pass", "fail", "needs_review", "skipped"]),
    newStatus: z.enum(["pass", "fail", "needs_review", "skipped"]),
    evalId: z.string().min(1),
    targetType: z.string().min(1),
    attributedVersion: z
      .object({
        harnessSpecHash: HashDigestSchema.optional(),
        datasetVersion: z.string().min(1)
      })
      .strict(),
    datasetContentId: HashDigestSchema,
    decisionHash: HashDigestSchema
  })
  .strict();

export type EvalRegressionProvenance = z.infer<
  typeof EvalRegressionProvenanceSchema
>;

export const EvalRegressionResultSchema = z
  .object({
    kind: z.literal("eval.regression"),
    status: z.enum([
      "regression",
      "no_regression",
      "golden_missing",
      "binding_mismatch",
      "decision_hash_defect"
    ]),
    provenance: EvalRegressionProvenanceSchema.optional(),
    findingCode: z.string().min(1).optional(),
    message: z.string().min(1).optional()
  })
  .strict();

export type EvalRegressionResult = z.infer<typeof EvalRegressionResultSchema>;

export const ReplayGuardResultSchema = z
  .object({
    status: z.enum(["reuse_allowed", "reuse_blocked"]),
    findingCode: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    expectedDatasetContentId: HashDigestSchema.optional(),
    actualDatasetContentId: HashDigestSchema.optional(),
    requiresRederivation: z.boolean()
  })
  .strict();

export type ReplayGuardResult = z.infer<typeof ReplayGuardResultSchema>;

export function evaluateRegression(input: {
  current: EvalVerdict;
  golden: EvalVerdict | undefined;
  dataset: PinnedDataset;
  targetType: string;
  harnessSpecHash?: HashDigest | undefined;
  decisionInputHashes?: DecisionInputHashes | undefined;
}): EvalRegressionResult {
  const decisionHash = recomputableDecisionHash(
    input.current,
    input.decisionInputHashes
  );

  if (decisionHash.status === "mismatch") {
    return EvalRegressionResultSchema.parse({
      kind: "eval.regression",
      status: "decision_hash_defect",
      findingCode: REGRESSION_DECISION_HASH_DEFECT_CODE,
      message: decisionHash.message
    });
  }

  if (input.golden === undefined) {
    return EvalRegressionResultSchema.parse({
      kind: "eval.regression",
      status: "golden_missing",
      findingCode: REGRESSION_GOLDEN_MISSING_CODE,
      message: `No golden baseline found for ${input.current.evalId} on ${input.targetType}`
    });
  }

  if (
    input.golden.evalId !== input.current.evalId ||
    input.golden.targetRef !== input.current.targetRef ||
    targetTypeFromTargetRef(input.golden.targetRef) !== input.targetType
  ) {
    return EvalRegressionResultSchema.parse({
      kind: "eval.regression",
      status: "binding_mismatch",
      findingCode: REGRESSION_GOLDEN_BINDING_MISMATCH_CODE,
      message: `Golden baseline is not bound to ${input.current.evalId} on ${input.current.targetRef}`
    });
  }

  const provenance = EvalRegressionProvenanceSchema.parse({
    priorStatus: input.golden.status,
    newStatus: input.current.status,
    evalId: input.current.evalId,
    targetType: input.targetType,
    attributedVersion: {
      harnessSpecHash: input.harnessSpecHash,
      datasetVersion: input.dataset.version
    },
    datasetContentId: input.dataset.contentId,
    decisionHash: decisionHash.value
  });

  return EvalRegressionResultSchema.parse({
    kind: "eval.regression",
    status:
      input.golden.status === "pass" && input.current.status === "fail"
        ? "regression"
        : "no_regression",
    provenance
  });
}

export function guardDatasetBoundReplay(input: {
  storedVerdict: EvalVerdict;
  pinnedDataset: PinnedDataset;
  currentDatasetManifest: unknown;
  ref?: DatasetReference | undefined;
}): ReplayGuardResult {
  const verification = verifyDatasetPin({
    pinned: input.pinnedDataset,
    currentManifest: input.currentDatasetManifest,
    ref: input.ref,
    mismatchCode: DATASET_HASH_MISMATCH_CODE
  });

  if (verification.status === "mismatch") {
    return ReplayGuardResultSchema.parse({
      status: "reuse_blocked",
      findingCode: REPLAY_DERIVATION_REQUIRED_CODE,
      message:
        "Stored verdict is bound to a different dataset content id and must be re-derived",
      expectedDatasetContentId: verification.expectedContentId,
      actualDatasetContentId: verification.actualContentId,
      requiresRederivation: true
    });
  }

  return ReplayGuardResultSchema.parse({
    status: "reuse_allowed",
    requiresRederivation: false
  });
}

function recomputableDecisionHash(
  verdict: EvalVerdict,
  hashes: DecisionInputHashes | undefined
):
  | {
      status: "ok";
      value: HashDigest;
    }
  | {
      status: "mismatch";
      message: string;
    } {
  try {
    return {
      status: "ok",
      value: recomputeDecisionHash(verdict, hashes)
    };
  } catch (error) {
    if (error instanceof DecisionHashError || error instanceof Error) {
      return {
        status: "mismatch",
        message: error.message
      };
    }

    return {
      status: "mismatch",
      message: "decisionHash does not recompute from recorded inputs"
    };
  }
}
