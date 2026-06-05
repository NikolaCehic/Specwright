import type {
  ContractCompatibilityClass,
  ContractRegistryRecord
} from "./contract-registry";

export type HashManifestEntry = {
  id: string;
  version: string;
  exportName: string;
  hash: string;
  compatibilityClass: ContractCompatibilityClass;
};

export type CompatibilityReportEntry = {
  id: string;
  exportName: string;
  baselineVersion?: string;
  currentVersion?: string;
  baselineHash?: string;
  currentHash?: string;
  classification: ContractCompatibilityClass | "unchanged";
  unsupportedWithoutMigration: boolean;
  reason: string;
};

export type CompatibilityReport = {
  registryVersion: string;
  generatedAt: "deterministic";
  summary: Record<
    ContractCompatibilityClass | "unchanged",
    number
  >;
  releasePolicy: {
    contractRegistryVersion: string;
    changedContractIds: string[];
    compatibilityClasses: Record<string, ContractCompatibilityClass | "unchanged">;
    migrationRequirements: string[];
    unsupportedHistoricalVersions: string[];
    generatedSdkSurfaceChanges: string[];
    auditExportChanges: string[];
    redactionChanges: string[];
    conformanceResultSummary: string;
  };
  entries: CompatibilityReportEntry[];
};

export function buildCompatibilityReport(input: {
  registryVersion: string;
  baselineRegistry: readonly ContractRegistryRecord[];
  currentRegistry: readonly ContractRegistryRecord[];
  baselineManifest: readonly HashManifestEntry[];
  currentManifest: readonly HashManifestEntry[];
}): CompatibilityReport {
  const baselineById = byId(input.baselineManifest);
  const currentById = byId(input.currentManifest);
  const baselineRecordsById = byId(input.baselineRegistry);
  const currentRecordsById = byId(input.currentRegistry);
  const ids = [...new Set([...baselineById.keys(), ...currentById.keys()])].sort();
  const entries = ids.map((id) => {
    const baseline = baselineById.get(id);
    const current = currentById.get(id);
    const baselineRecord = baselineRecordsById.get(id);
    const currentRecord = currentRecordsById.get(id);

    if (baseline === undefined && current !== undefined) {
      return reportEntry({
        id,
        exportName: current.exportName,
        currentVersion: current.version,
        currentHash: current.hash,
        classification: "additive-compatible",
        unsupportedWithoutMigration: false,
        reason: "New registered contract; old records remain readable."
      });
    }

    if (baseline !== undefined && current === undefined) {
      return reportEntry({
        id,
        exportName: baseline.exportName,
        baselineVersion: baseline.version,
        baselineHash: baseline.hash,
        classification: "breaking",
        unsupportedWithoutMigration: true,
        reason: "Contract was removed from the current registry."
      });
    }

    if (baseline === undefined || current === undefined) {
      throw new Error(`Unable to compare contract ${id}`);
    }

    if (baseline.hash === current.hash) {
      return reportEntry({
        id,
        exportName: current.exportName,
        baselineVersion: baseline.version,
        currentVersion: current.version,
        baselineHash: baseline.hash,
        currentHash: current.hash,
        classification: "unchanged",
        unsupportedWithoutMigration: false,
        reason: "Canonical schema hash is unchanged."
      });
    }

    const authorityChanged =
      baselineRecord?.authority.semantics !== currentRecord?.authority.semantics;
    const redactionChanged =
      JSON.stringify(baselineRecord?.redaction) !==
      JSON.stringify(currentRecord?.redaction);
    const versionChanged = baseline.version !== current.version;
    const classification: ContractCompatibilityClass =
      authorityChanged || redactionChanged || !versionChanged
        ? "migration-required"
        : current.compatibilityClass;

    return reportEntry({
      id,
      exportName: current.exportName,
      baselineVersion: baseline.version,
      currentVersion: current.version,
      baselineHash: baseline.hash,
      currentHash: current.hash,
      classification,
      unsupportedWithoutMigration:
        classification === "migration-required" || classification === "breaking",
      reason:
        classification === "migration-required"
          ? "Schema hash changed in a way that requires an explicit migration review."
          : "Schema hash changed with a compatible version transition."
    });
  });

  const summary = emptySummary();

  for (const entry of entries) {
    summary[entry.classification] += 1;
  }

  const changedEntries = entries.filter(
    (entry) => entry.classification !== "unchanged"
  );
  const unsupportedEntries = entries.filter(
    (entry) => entry.unsupportedWithoutMigration
  );

  return {
    registryVersion: input.registryVersion,
    generatedAt: "deterministic",
    summary,
    releasePolicy: {
      contractRegistryVersion: input.registryVersion,
      changedContractIds: changedEntries.map((entry) => entry.id),
      compatibilityClasses: Object.fromEntries(
        entries.map((entry) => [entry.id, entry.classification])
      ),
      migrationRequirements: unsupportedEntries.map((entry) => entry.id),
      unsupportedHistoricalVersions: unsupportedEntries.flatMap((entry) =>
        entry.baselineVersion === undefined
          ? []
          : [`${entry.id}@${entry.baselineVersion}`]
      ),
      generatedSdkSurfaceChanges: changedEntries.map((entry) => entry.id),
      auditExportChanges: changedEntries.map((entry) => entry.id),
      redactionChanges: changedEntries
        .filter((entry) => {
          const baseline = baselineRecordsById.get(entry.id);
          const current = currentRecordsById.get(entry.id);

          return (
            JSON.stringify(baseline?.redaction) !==
            JSON.stringify(current?.redaction)
          );
        })
        .map((entry) => entry.id),
      conformanceResultSummary:
        unsupportedEntries.length === 0
          ? "all registered fixtures pass current validators"
          : "migration review required before release"
    },
    entries
  };
}

function byId<TValue extends { id: string }>(values: readonly TValue[]) {
  return new Map(values.map((value) => [value.id, value]));
}

function reportEntry(entry: CompatibilityReportEntry) {
  return entry;
}

function emptySummary(): Record<ContractCompatibilityClass | "unchanged", number> {
  return {
    unchanged: 0,
    "patch-compatible": 0,
    "additive-compatible": 0,
    "forward-compatible": 0,
    "backward-compatible": 0,
    "migration-required": 0,
    breaking: 0
  };
}
