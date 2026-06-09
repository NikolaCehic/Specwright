import {
  type CompatibilityClass,
  EngineChangelogEntrySchema,
  type EngineChangelogEntry
} from "./compatibility";
import {
  GATE_ENGINE_EVALUATOR_VERSION,
  assertVerdictSemanticsVersionBump,
  compareSemverStrings
} from "./gate-contract-version";

export const ENGINE_CHANGELOG = [
  EngineChangelogEntrySchema.parse({
    version: "1.0.0",
    class: "forward-compatible",
    summary:
      "Structured evaluator identity and governed replay compatibility land without changing verdict semantics.",
    verdictSemanticsChanged: false,
    affectedFixtures: []
  })
] as const satisfies readonly EngineChangelogEntry[];

export const BASELINE_ENGINE_CHANGELOG_ENTRY = ENGINE_CHANGELOG[0];
export const LATEST_ENGINE_CHANGELOG_ENTRY = ENGINE_CHANGELOG.at(-1)!;

export type EngineChangelogInvariantFinding = {
  code:
    | "changelog_empty"
    | "versions_not_strictly_increasing"
    | "latest_version_mismatch"
    | "verdict_semantics_without_version_bump"
    | "migration_descriptor_missing";
  version: string;
  message: string;
};

export type EngineChangelogInvariantResult =
  | { ok: true }
  | {
      ok: false;
      findings: EngineChangelogInvariantFinding[];
    };

export function assertEngineChangelogInvariants(
  entries: readonly EngineChangelogEntry[] = ENGINE_CHANGELOG
): EngineChangelogInvariantResult {
  if (entries.length === 0) {
    return {
      ok: false,
      findings: [
        {
          code: "changelog_empty",
          version: "unknown",
          message: "Engine changelog must declare at least one entry."
        }
      ]
    };
  }

  const findings: EngineChangelogInvariantFinding[] = [];
  let previousVersion: string | undefined;
  const latestEntry = entries.at(-1)!;

  for (const entry of entries) {
    if (
      previousVersion !== undefined &&
      compareSemverStrings(entry.version, previousVersion) <= 0
    ) {
      findings.push({
        code: "versions_not_strictly_increasing",
        version: entry.version,
        message: `Engine changelog version ${entry.version} must be greater than ${previousVersion}.`
      });
    }

    const verdictVersionRule = assertVerdictSemanticsVersionBump(
      previousVersion === undefined
        ? {
            nextVersion: entry.version,
            verdictSemanticsChanged: entry.verdictSemanticsChanged
          }
        : {
            previousVersion,
            nextVersion: entry.version,
            verdictSemanticsChanged: entry.verdictSemanticsChanged
          }
    );

    if (!verdictVersionRule.ok) {
      findings.push({
        code: "verdict_semantics_without_version_bump",
        version: entry.version,
        message: verdictVersionRule.reason
      });
    }

    if (
      requiresMigrationDescriptor(entry.class) &&
      entry.migrationDescriptorId === undefined
    ) {
      findings.push({
        code: "migration_descriptor_missing",
        version: entry.version,
        message: `Compatibility class ${entry.class} requires a migrationDescriptorId.`
      });
    }

    previousVersion = entry.version;
  }

  if (latestEntry.version !== GATE_ENGINE_EVALUATOR_VERSION) {
    findings.push({
      code: "latest_version_mismatch",
      version: latestEntry.version,
      message: `Latest changelog version ${latestEntry.version} must match evaluator version ${GATE_ENGINE_EVALUATOR_VERSION}.`
    });
  }

  return findings.length === 0 ? { ok: true } : { ok: false, findings };
}

function requiresMigrationDescriptor(
  compatibilityClass: CompatibilityClass
): boolean {
  return (
    compatibilityClass === "migration-required" ||
    compatibilityClass === "breaking"
  );
}
