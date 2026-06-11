import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { EvalVerdict } from "@specwright/schemas";
import { hashValue, stableStringify, type HashDigest } from "./decision-hash";
import type { EvalRunnerInput, FixtureEvalDefinition } from "./index";

export const DATASET_HASH_MISMATCH_CODE = "eval.dataset.hash_mismatch";
export const DATASET_POISONED_CODE = "eval.dataset.poisoned";
export const DATASET_MISSING_CODE = "eval.dataset.missing";
export const DATASET_MALFORMED_CODE = "eval.dataset.malformed";

const HashDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u) as z.ZodType<HashDigest>;

const JsonRecordSchema = z.record(z.string(), z.unknown());

const LocalProducedBySchema = z
  .object({
    kind: z.enum(["deterministic", "model_assisted", "human"]),
    ref: z.string().min(1)
  })
  .strict();

const LocalFindingSchema = z
  .object({
    id: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    message: z.string().min(1),
    severity: z.enum(["advisory", "blocking"]).optional(),
    targetRef: z.string().min(1).optional(),
    evidenceRefs: z.array(z.string().min(1)).optional(),
    repairHint: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    metadata: JsonRecordSchema.optional()
  })
  .strict();

const LocalDecisionProvenanceSchema = z
  .object({
    runId: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    evaluatedAt: z.string().datetime({ offset: true }).optional(),
    decisionHash: z.string().min(1).optional(),
    causationIds: z.array(z.string().min(1)).optional(),
    traceId: z.string().min(1).optional()
  })
  .strict();

export const DatasetGoldenVerdictSchema = z
  .object({
    evalId: z.string().min(1),
    targetRef: z.string().min(1),
    status: z.enum(["pass", "fail", "needs_review", "skipped"]),
    severity: z.enum(["advisory", "blocking"]),
    findings: z.array(LocalFindingSchema),
    evidenceRefs: z.array(z.string().min(1)),
    producedBy: LocalProducedBySchema,
    repairTask: z.unknown().optional(),
    provenance: LocalDecisionProvenanceSchema.optional()
  })
  .strict() as z.ZodType<EvalVerdict>;

export const DatasetCaseSchema = z
  .object({
    id: z.string().min(1),
    evalId: z.string().min(1).optional(),
    targetType: z.string().min(1).optional(),
    input: z.unknown() as z.ZodType<EvalRunnerInput>,
    golden: DatasetGoldenVerdictSchema
  })
  .strict();

export type DatasetCase = z.infer<typeof DatasetCaseSchema>;

export const DatasetManifestSchema = z
  .object({
    schemaVersion: z.literal("specwright.eval-dataset.v0"),
    id: z.string().min(1),
    version: z.string().min(1),
    evalId: z.string().min(1).optional(),
    targetType: z.string().min(1),
    description: z.string().min(1).optional(),
    cases: z.array(DatasetCaseSchema).min(1)
  })
  .strict()
  .superRefine((manifest, context) => {
    const caseIds = new Set<string>();

    for (const [index, datasetCase] of manifest.cases.entries()) {
      if (caseIds.has(datasetCase.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "id"],
          message: `duplicate dataset case id ${datasetCase.id}`
        });
      }

      caseIds.add(datasetCase.id);

      if (
        manifest.evalId !== undefined &&
        datasetCase.evalId !== undefined &&
        datasetCase.evalId !== manifest.evalId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "evalId"],
          message: "dataset case evalId must match manifest evalId"
        });
      }

      if (
        datasetCase.targetType !== undefined &&
        datasetCase.targetType !== manifest.targetType
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "targetType"],
          message: "dataset case targetType must match manifest targetType"
        });
      }

      const evalId = datasetCase.evalId ?? manifest.evalId;

      if (evalId !== undefined && datasetCase.golden.evalId !== evalId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "golden", "evalId"],
          message: "dataset case golden evalId must match its dataset binding"
        });
      }

      const targetType = datasetCase.targetType ?? manifest.targetType;

      if (targetTypeFromTargetRef(datasetCase.golden.targetRef) !== targetType) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "golden", "targetRef"],
          message: "dataset case golden targetRef must match its targetType binding"
        });
      }
    }
  });

export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;

export const DatasetReferenceSchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      version: z.string().min(1).optional(),
      contentId: HashDigestSchema.optional(),
      uri: z.string().min(1).optional(),
      path: z.string().min(1).optional()
    })
    .strict()
]);

export type DatasetReference = z.infer<typeof DatasetReferenceSchema>;

export type PinnedDataset = {
  manifest: DatasetManifest;
  contentId: HashDigest;
  id: string;
  version: string;
  evalId?: string | undefined;
  targetType: string;
  runId?: string | undefined;
  ciInvocationId?: string | undefined;
  ref?: DatasetReference | undefined;
};

export type DatasetResolution =
  | {
      status: "resolved";
      pinned: PinnedDataset;
    }
  | {
      status: "missing";
      code: typeof DATASET_MISSING_CODE;
      message: string;
      ref?: DatasetReference | undefined;
    }
  | {
      status: "mismatch";
      code: typeof DATASET_HASH_MISMATCH_CODE | typeof DATASET_POISONED_CODE;
      message: string;
      expectedContentId: HashDigest;
      actualContentId: HashDigest;
      ref?: DatasetReference | undefined;
    }
  | {
      status: "malformed";
      code: typeof DATASET_MALFORMED_CODE;
      message: string;
      ref?: unknown;
    };

export type DatasetResolver = (
  ref: DatasetReference,
  context: {
    evalId: string;
    definition: FixtureEvalDefinition;
  }
) => unknown;

export function datasetReferenceFromDefinition(
  definition: FixtureEvalDefinition
): DatasetReference | undefined {
  const resolved = resolveDatasetReferenceFromDefinition(definition);

  return resolved.status === "resolved" ? resolved.ref : undefined;
}

export function hasDeclaredDatasetReference(
  definition: FixtureEvalDefinition
): boolean {
  return definition.datasetRef !== undefined || definition.dataset !== undefined;
}

export function resolveDatasetReferenceFromDefinition(
  definition: FixtureEvalDefinition
):
  | {
      status: "resolved";
      ref: DatasetReference;
    }
  | {
      status: "absent";
    }
  | {
      status: "malformed";
      code: typeof DATASET_MALFORMED_CODE;
      message: string;
      ref: unknown;
    } {
  const raw = definition.datasetRef ?? definition.dataset;

  if (typeof raw === "string" && raw.length > 0) {
    return {
      status: "resolved",
      ref: raw
    };
  }

  if (isRecord(raw)) {
    const parsed = DatasetReferenceSchema.safeParse(raw);

    if (parsed.success) {
      return {
        status: "resolved",
        ref: parsed.data
      };
    }

    return {
      status: "malformed",
      code: DATASET_MALFORMED_CODE,
      message: "Dataset reference is malformed",
      ref: raw
    };
  }

  if (raw !== undefined) {
    return {
      status: "malformed",
      code: DATASET_MALFORMED_CODE,
      message: "Dataset reference must be a string or object",
      ref: raw
    };
  }

  return {
    status: "absent"
  };
}

export function parseDatasetManifest(value: unknown): DatasetManifest {
  return DatasetManifestSchema.parse(value);
}

export function computeDatasetContentId(value: unknown): HashDigest {
  return hashValue(parseDatasetManifest(value));
}

export function canonicalizeDatasetManifest(value: unknown): string {
  return stableStringify(parseDatasetManifest(value));
}

export function pinDataset(input: {
  manifest: unknown;
  ref?: DatasetReference | undefined;
  runId?: string | undefined;
  ciInvocationId?: string | undefined;
}): PinnedDataset {
  const manifest = parseDatasetManifest(input.manifest);
  const contentId = computeDatasetContentId(manifest);

  return {
    manifest,
    contentId,
    id: manifest.id,
    version: manifest.version,
    evalId: manifest.evalId,
    targetType: manifest.targetType,
    runId: input.runId,
    ciInvocationId: input.ciInvocationId,
    ref: input.ref
  };
}

export function resolveDataset(input: {
  evalId: string;
  definition: FixtureEvalDefinition;
  manifest?: unknown;
  pinned?: PinnedDataset | undefined;
  ref?: DatasetReference | undefined;
  resolver?: DatasetResolver | undefined;
  runId?: string | undefined;
  ciInvocationId?: string | undefined;
  required?: boolean | undefined;
  mismatchCode?: typeof DATASET_HASH_MISMATCH_CODE | typeof DATASET_POISONED_CODE;
}): DatasetResolution {
  const referenceResolution =
    input.ref === undefined
      ? resolveDatasetReferenceFromDefinition(input.definition)
      : ({
          status: "resolved",
          ref: input.ref
        } as const);

  if (referenceResolution.status === "malformed") {
    return referenceResolution;
  }

  const ref =
    referenceResolution.status === "resolved"
      ? referenceResolution.ref
      : undefined;

  if (input.pinned !== undefined) {
    const verifyInput: Parameters<typeof verifyDatasetPin>[0] = {
      pinned: input.pinned,
      currentManifest: input.manifest ?? input.pinned.manifest
    };

    if (ref !== undefined) {
      verifyInput.ref = ref;
    }

    if (input.mismatchCode !== undefined) {
      verifyInput.mismatchCode = input.mismatchCode;
    }

    return verifyDatasetPin(verifyInput);
  }

  let manifest =
    input.manifest ??
    (isInlineDatasetRef(ref) ? ref.manifest : undefined) ??
    (ref === undefined ? undefined : input.resolver?.(ref, {
      evalId: input.evalId,
      definition: input.definition
    }));

  if (manifest === undefined && ref !== undefined) {
    const loaded = loadDatasetManifestFromReference(ref);

    if (loaded.status === "malformed") {
      return {
        status: "malformed",
        code: DATASET_MALFORMED_CODE,
        message: loaded.message,
        ref
      };
    }

    if (loaded.status === "loaded") {
      manifest = loaded.manifest;
    }
  }

  if (manifest === undefined) {
    return {
      status: "missing",
      code: DATASET_MISSING_CODE,
      message:
        input.required === true
          ? `Dataset for eval ${input.evalId} could not be resolved`
          : `Dataset for eval ${input.evalId} is not declared`,
      ref
    };
  }

  const pinnedResult = safePinDataset({
    manifest,
    ref,
    runId: input.runId,
    ciInvocationId: input.ciInvocationId
  });
  const expectedContentId = expectedContentIdFromRef(ref);

  if (!pinnedResult.success) {
    return {
      status: "mismatch",
      code: input.mismatchCode ?? DATASET_HASH_MISMATCH_CODE,
      message: `Dataset for eval ${input.evalId} failed manifest validation`,
      expectedContentId:
        expectedContentId ?? contentIdForRejectedDataset({ absentExpected: true }),
      actualContentId: contentIdForRejectedDataset(manifest),
      ref
    };
  }

  const pinned = pinnedResult.pinned;

  if (expectedContentId !== undefined && expectedContentId !== pinned.contentId) {
    return {
      status: "mismatch",
      code: input.mismatchCode ?? DATASET_HASH_MISMATCH_CODE,
      message: `Dataset ${pinned.id}@${pinned.version} content id does not match its pinned reference`,
      expectedContentId,
      actualContentId: pinned.contentId,
      ref
    };
  }

  return {
    status: "resolved",
    pinned
  };
}

export function verifyDatasetPin(input: {
  pinned: PinnedDataset;
  currentManifest: unknown;
  ref?: DatasetReference | undefined;
  mismatchCode?: typeof DATASET_HASH_MISMATCH_CODE | typeof DATASET_POISONED_CODE;
}): DatasetResolution {
  const parsed = DatasetManifestSchema.safeParse(input.currentManifest);
  const actualContentId = parsed.success
    ? computeDatasetContentId(parsed.data)
    : contentIdForRejectedDataset(input.currentManifest);

  if (!parsed.success) {
    return {
      status: "mismatch",
      code: input.mismatchCode ?? DATASET_HASH_MISMATCH_CODE,
      message: `Dataset ${input.pinned.id}@${input.pinned.version} failed manifest validation after it was pinned`,
      expectedContentId: input.pinned.contentId,
      actualContentId,
      ref: input.ref ?? input.pinned.ref
    };
  }

  if (actualContentId !== input.pinned.contentId) {
    return {
      status: "mismatch",
      code: input.mismatchCode ?? DATASET_HASH_MISMATCH_CODE,
      message: `Dataset ${input.pinned.id}@${input.pinned.version} changed after it was pinned`,
      expectedContentId: input.pinned.contentId,
      actualContentId,
      ref: input.ref ?? input.pinned.ref
    };
  }

  return {
    status: "resolved",
    pinned: {
      ...input.pinned,
      manifest: parsed.data
    }
  };
}

export function findGoldenCase(input: {
  pinned: PinnedDataset;
  evalId: string;
  targetType: string;
  caseId?: string | undefined;
}): DatasetCase | undefined {
  return input.pinned.manifest.cases.find((datasetCase) => {
    if (input.caseId !== undefined && datasetCase.id !== input.caseId) {
      return false;
    }

    const evalId = datasetCase.evalId ?? input.pinned.manifest.evalId;
    const targetType = datasetCase.targetType ?? input.pinned.manifest.targetType;

    return evalId === input.evalId && targetType === input.targetType;
  });
}

export function targetTypeFromTargetRef(targetRef: string): string {
  const [kind, value] = targetRef.split(":", 2);

  if (kind === "artifact" && value !== undefined && value.length > 0) {
    return value;
  }

  if (kind !== undefined && kind.length > 0) {
    return kind;
  }

  return targetRef;
}

export function expectedContentIdFromRef(
  ref: DatasetReference | undefined
): HashDigest | undefined {
  if (isRecord(ref) && typeof ref.contentId === "string") {
    return HashDigestSchema.parse(ref.contentId);
  }

  return undefined;
}

function isInlineDatasetRef(
  ref: DatasetReference | undefined
): ref is DatasetReference & { manifest: unknown } {
  return isRecord(ref) && "manifest" in ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePinDataset(input: {
  manifest: unknown;
  ref?: DatasetReference | undefined;
  runId?: string | undefined;
  ciInvocationId?: string | undefined;
}):
  | {
      success: true;
      pinned: PinnedDataset;
    }
  | {
      success: false;
    } {
  const parsed = DatasetManifestSchema.safeParse(input.manifest);

  if (!parsed.success) {
    return {
      success: false
    };
  }

  return {
    success: true,
    pinned: {
      manifest: parsed.data,
      contentId: computeDatasetContentId(parsed.data),
      id: parsed.data.id,
      version: parsed.data.version,
      evalId: parsed.data.evalId,
      targetType: parsed.data.targetType,
      runId: input.runId,
      ciInvocationId: input.ciInvocationId,
      ref: input.ref
    }
  };
}

function contentIdForRejectedDataset(value: unknown): HashDigest {
  try {
    return hashValue(value);
  } catch {
    return hashValue({
      rejectedDataset: true,
      reason: "unhashable"
    });
  }
}

function loadDatasetManifestFromReference(
  ref: DatasetReference
):
  | {
      status: "loaded";
      manifest: unknown;
    }
  | {
      status: "missing";
    }
  | {
      status: "malformed";
      message: string;
    } {
  if (!isRecord(ref) || typeof ref.path !== "string") {
    return {
      status: "missing"
    };
  }

  try {
    return {
      status: "loaded",
      manifest: JSON.parse(readFileSync(resolve(ref.path), "utf8"))
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        status: "malformed",
        message: `Dataset reference ${ref.id} points to malformed JSON`
      };
    }

    return {
      status: "missing"
    };
  }
}
