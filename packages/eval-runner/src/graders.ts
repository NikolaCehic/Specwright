import { z } from "zod";
import type { EvalFinding, EvalSeverity } from "@specwright/schemas";
import { hashValue, stableStringify, type HashDigest } from "./decision-hash";

export const GRADER_NO_GOLDEN_CODE = "eval.grader.golden_regression_missing";

const HashDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u) as z.ZodType<HashDigest>;

export const GraderManifestSchema = z
  .object({
    schemaVersion: z.literal("specwright.eval-grader.v0"),
    id: z.string().min(1),
    version: z.string().min(1),
    rubricHash: HashDigestSchema,
    inputSchemaRef: z.string().min(1),
    outputSchemaRef: z.string().min(1),
    samplingBand: z
      .object({
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1)
      })
      .strict()
      .optional(),
    goldenRegression: z
      .object({
        datasetId: z.string().min(1),
        datasetContentId: HashDigestSchema,
        passed: z.boolean(),
        decisionHash: HashDigestSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.samplingBand !== undefined &&
      manifest.samplingBand.min > manifest.samplingBand.max
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["samplingBand"],
        message: "samplingBand min must be <= max"
      });
    }
  });

export type GraderManifest = z.infer<typeof GraderManifestSchema>;

export type PinnedGrader = {
  manifest: GraderManifest;
  contentId: HashDigest;
  id: string;
  version: string;
};

export type GraderBlockingBar =
  | {
      allowed: true;
      grader: PinnedGrader;
    }
  | {
      allowed: false;
      grader: PinnedGrader;
      finding: EvalFinding;
    };

export function parseGraderManifest(value: unknown): GraderManifest {
  return GraderManifestSchema.parse(value);
}

export function computeGraderContentId(value: unknown): HashDigest {
  return hashValue(parseGraderManifest(value));
}

export function canonicalizeGraderManifest(value: unknown): string {
  return stableStringify(parseGraderManifest(value));
}

export function pinGrader(manifest: unknown): PinnedGrader {
  const parsed = parseGraderManifest(manifest);

  return {
    manifest: parsed,
    contentId: computeGraderContentId(parsed),
    id: parsed.id,
    version: parsed.version
  };
}

export function enforceGoldenRegressionBar(input: {
  manifest: unknown;
  targetRef: string;
  severity: EvalSeverity;
  blocking: boolean;
}): GraderBlockingBar {
  const grader = pinGrader(input.manifest);
  const hasPassingGolden = grader.manifest.goldenRegression?.passed === true;

  if (!input.blocking || hasPassingGolden) {
    return {
      allowed: true,
      grader
    };
  }

  return {
    allowed: false,
    grader,
    finding: {
      message:
        "Grader version is barred from blocking verdicts until its golden regression run passes",
      code: GRADER_NO_GOLDEN_CODE,
      targetRef: input.targetRef,
      severity: input.severity,
      repairHint:
        "Run and record a passing golden regression for this grader version before using it for blocking evals.",
      metadata: {
        grader: {
          id: grader.id,
          version: grader.version,
          contentId: grader.contentId,
          goldenRegression: grader.manifest.goldenRegression
        }
      }
    }
  };
}
