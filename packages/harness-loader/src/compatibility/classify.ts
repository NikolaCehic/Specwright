import { z } from "zod";

const nonEmptyString = z.string().min(1);

export const CompatibilityClassSchema = z.enum([
  "content-stable",
  "patch-compatible",
  "additive-compatible",
  "replay-compatible",
  "migration-required",
  "breaking"
]);

export type CompatibilityClass = z.infer<typeof CompatibilityClassSchema>;

export const CapabilitySurfaceSchema = z
  .object({
    tools: z.array(nonEmptyString).default([]),
    requireApproval: z.array(nonEmptyString).default([]),
    runtimeAuthority: z
      .object({
        strict: z.boolean().optional(),
        failClosed: z.boolean().optional(),
        modelOutputAuthority: nonEmptyString.optional()
      })
      .strict()
      .default({})
  })
  .strict();

export type CapabilitySurface = z.infer<typeof CapabilitySurfaceSchema>;

export const ClassifyTransitionInputSchema = z
  .object({
    declaredSchemaVersion: nonEmptyString,
    targetSchemaVersion: nonEmptyString,
    packageVersion: nonEmptyString,
    runtimeVersion: nonEmptyString,
    normalizedContentEqual: z.boolean().default(false),
    metadataOnly: z.boolean().default(false),
    additiveOnly: z.boolean().default(false),
    replayVerified: z.boolean().default(false),
    schemaVersionChanged: z.boolean().default(false),
    removedOrRenamedReferencedDefinition: z.boolean().default(false),
    toolContractChanged: z.boolean().default(false),
    authorityChanged: z.boolean().default(false),
    interpretable: z.boolean().default(true),
    sourceCapabilitySurface: CapabilitySurfaceSchema.optional(),
    targetCapabilitySurface: CapabilitySurfaceSchema.optional()
  })
  .strict();

export type ClassifyTransitionInput = z.input<
  typeof ClassifyTransitionInputSchema
>;

export type CapabilityWidening = {
  widened: boolean;
  addedTools: string[];
  addedRequireApproval: string[];
  widenedRuntimeAuthority: string[];
};

export function classifyTransition(input: ClassifyTransitionInput) {
  const transition = ClassifyTransitionInputSchema.parse(input);
  const widening = detectCapabilitySurfaceWidening(
    transition.sourceCapabilitySurface,
    transition.targetCapabilitySurface
  );

  if (!transition.interpretable) {
    return CompatibilityClassSchema.parse("breaking");
  }

  if (
    transition.schemaVersionChanged ||
    transition.removedOrRenamedReferencedDefinition ||
    transition.toolContractChanged ||
    transition.authorityChanged ||
    widening.widened
  ) {
    return CompatibilityClassSchema.parse("migration-required");
  }

  if (transition.normalizedContentEqual) {
    return CompatibilityClassSchema.parse("content-stable");
  }

  if (transition.metadataOnly) {
    return CompatibilityClassSchema.parse("patch-compatible");
  }

  if (transition.additiveOnly) {
    return CompatibilityClassSchema.parse("additive-compatible");
  }

  if (transition.replayVerified) {
    return CompatibilityClassSchema.parse("replay-compatible");
  }

  return CompatibilityClassSchema.parse("breaking");
}

export function detectCapabilitySurfaceWidening(
  source: CapabilitySurface | undefined,
  target: CapabilitySurface | undefined
): CapabilityWidening {
  const sourceSurface = CapabilitySurfaceSchema.parse(source ?? {});
  const targetSurface = CapabilitySurfaceSchema.parse(target ?? {});
  const addedTools = difference(targetSurface.tools, sourceSurface.tools);
  const addedRequireApproval = difference(
    targetSurface.requireApproval,
    sourceSurface.requireApproval
  );
  const widenedRuntimeAuthority = runtimeAuthorityChanges(
    sourceSurface.runtimeAuthority,
    targetSurface.runtimeAuthority
  );

  return {
    widened:
      addedTools.length > 0 ||
      addedRequireApproval.length > 0 ||
      widenedRuntimeAuthority.length > 0,
    addedTools,
    addedRequireApproval,
    widenedRuntimeAuthority
  };
}

function difference(left: readonly string[], right: readonly string[]) {
  const rightSet = new Set(right);

  return sortedUnique(left.filter((value) => !rightSet.has(value)));
}

function runtimeAuthorityChanges(
  source: CapabilitySurface["runtimeAuthority"],
  target: CapabilitySurface["runtimeAuthority"]
) {
  const changed: string[] = [];

  for (const key of [
    "strict",
    "failClosed",
    "modelOutputAuthority"
  ] as const) {
    if (source[key] !== target[key]) {
      changed.push(key);
    }
  }

  return changed;
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
