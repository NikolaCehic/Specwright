import { z } from "zod";

export const COMPATIBILITY_CLASSES = [
  "patch-compatible",
  "additive-compatible",
  "forward-compatible",
  "backward-compatible",
  "migration-required",
  "breaking"
] as const;

export const CompatibilityClassSchema = z.enum(COMPATIBILITY_CLASSES);

export const COMPATIBILITY_CHANGE_KINDS = [
  "documentation",
  "optional-span-metadata",
  "advisory-metric",
  "export-profile",
  "forward-reader",
  "backward-extension",
  "required-span-kind",
  "audit-content-tightening",
  "data-class-handling",
  "retention-window",
  "metric-authoritative-source",
  "tenancy-isolation-weakening",
  "run-package-unauditable",
  "breaking-contract"
] as const;

const nonEmptyString = z.string().min(1);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const CompatibilityChangeDescriptorSchema = z
  .object({
    changeId: nonEmptyString,
    kind: z.enum(COMPATIBILITY_CHANGE_KINDS),
    description: nonEmptyString,
    extensionPoint: z.boolean().optional()
  })
  .strict();

export const ClassifyCompatibilityInputSchema = z
  .object({
    candidateVersion: semver,
    deployedVersion: semver,
    changes: z.array(CompatibilityChangeDescriptorSchema)
  })
  .strict();

export type CompatibilityClass = z.infer<typeof CompatibilityClassSchema>;
export type CompatibilityChangeKind =
  (typeof COMPATIBILITY_CHANGE_KINDS)[number];
export type CompatibilityChangeDescriptor = z.infer<
  typeof CompatibilityChangeDescriptorSchema
>;
export type ClassifyCompatibilityInput = z.infer<
  typeof ClassifyCompatibilityInputSchema
>;

export type CompatibilityClassification = {
  compatibilityClass: CompatibilityClass;
  promotable: boolean;
  reasons: string[];
};

export function classifyCompatibility(
  input: ClassifyCompatibilityInput
): CompatibilityClassification {
  const parsed = ClassifyCompatibilityInputSchema.parse(input);
  const changes = [...parsed.changes].sort((left, right) =>
    left.changeId.localeCompare(right.changeId)
  );
  const classFromChanges = classifyChanges(changes);
  const compatibilityClass =
    classFromChanges ?? classFromVersionDelta(parsed.deployedVersion, parsed.candidateVersion);

  return {
    compatibilityClass,
    promotable: isCompatibilityClassPromotable(compatibilityClass),
    reasons: compatibilityReasons(changes, compatibilityClass)
  };
}

export function isCompatibilityClassPromotable(
  compatibilityClass: CompatibilityClass
) {
  return !["migration-required", "breaking"].includes(compatibilityClass);
}

function classifyChanges(
  changes: readonly CompatibilityChangeDescriptor[]
): CompatibilityClass | undefined {
  if (
    changes.some((change) =>
      [
        "tenancy-isolation-weakening",
        "run-package-unauditable",
        "breaking-contract"
      ].includes(change.kind)
    )
  ) {
    return "breaking";
  }

  if (
    changes.some((change) =>
      [
        "required-span-kind",
        "audit-content-tightening",
        "data-class-handling",
        "retention-window",
        "metric-authoritative-source"
      ].includes(change.kind)
    )
  ) {
    return "migration-required";
  }

  if (
    changes.some(
      (change) =>
        change.kind === "backward-extension" && change.extensionPoint !== true
    )
  ) {
    return "migration-required";
  }

  if (changes.some((change) => change.kind === "forward-reader")) {
    return "forward-compatible";
  }

  if (changes.some((change) => change.kind === "backward-extension")) {
    return "backward-compatible";
  }

  if (
    changes.some((change) =>
      ["optional-span-metadata", "advisory-metric", "export-profile"].includes(
        change.kind
      )
    )
  ) {
    return "additive-compatible";
  }

  if (changes.length > 0) {
    return "patch-compatible";
  }

  return undefined;
}

function classFromVersionDelta(
  deployedVersion: string,
  candidateVersion: string
): CompatibilityClass {
  const deployed = parseSemver(deployedVersion);
  const candidate = parseSemver(candidateVersion);

  if (candidate.major !== deployed.major) {
    return candidate.major > deployed.major ? "migration-required" : "breaking";
  }

  if (candidate.minor !== deployed.minor) {
    return candidate.minor > deployed.minor
      ? "forward-compatible"
      : "backward-compatible";
  }

  return "patch-compatible";
}

function compatibilityReasons(
  changes: readonly CompatibilityChangeDescriptor[],
  compatibilityClass: CompatibilityClass
): string[] {
  if (changes.length === 0) {
    return [`version delta classified as ${compatibilityClass}`];
  }

  return changes.map((change) => `${change.changeId}:${change.kind}`);
}

function parseSemver(version: string) {
  const [major, minor, patch] = version.split(".").map((part) => Number(part));

  return {
    major: major ?? 0,
    minor: minor ?? 0,
    patch: patch ?? 0
  };
}
