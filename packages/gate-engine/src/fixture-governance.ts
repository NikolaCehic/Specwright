import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type HashDigest } from "./decision-hash";
import {
  type MigrationDescriptor,
  validateMigrationDescriptor
} from "./migration-descriptor";

export const FIXTURE_GOVERNANCE_MANIFEST_VERSION = 1 as const;

export const FixtureGovernedFileSchema = z
  .object({
    path: z.string().trim().min(1),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/)
  })
  .strict();

export type FixtureGovernedFile = z.infer<typeof FixtureGovernedFileSchema>;

export const FixtureGovernanceManifestEntrySchema = z
  .object({
    fixtureId: z.string().trim().min(1),
    governedFiles: z.array(FixtureGovernedFileSchema).min(1),
    migrationDescriptorId: z.string().trim().min(1).nullable()
  })
  .strict();

export type FixtureGovernanceManifestEntry = z.infer<
  typeof FixtureGovernanceManifestEntrySchema
>;

export const FixtureGovernanceManifestSchema = z
  .object({
    schemaVersion: z.literal(FIXTURE_GOVERNANCE_MANIFEST_VERSION),
    fixtures: z.array(FixtureGovernanceManifestEntrySchema)
  })
  .strict();

export type FixtureGovernanceManifest = z.infer<
  typeof FixtureGovernanceManifestSchema
>;

export type FixtureGovernanceFinding = {
  code:
    | "fixture_missing"
    | "fixture_unexpected"
    | "governed_file_missing"
    | "governed_file_unexpected"
    | "governed_file_hash_changed"
    | "migration_descriptor_missing"
    | "migration_descriptor_invalid";
  fixtureId: string;
  path?: string;
  message: string;
};

export type FixtureGovernanceGuardResult =
  | { ok: true }
  | { ok: false; findings: FixtureGovernanceFinding[] };

export async function readFixtureGovernanceManifest(
  manifestPath: string
): Promise<FixtureGovernanceManifest> {
  return FixtureGovernanceManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8"))
  );
}

export async function collectFixtureGovernanceState(
  fixturesDir: string
): Promise<FixtureGovernanceManifest> {
  const fixtureEntries = await readdir(fixturesDir);
  const fixtures: FixtureGovernanceManifestEntry[] = [];

  for (const entry of fixtureEntries) {
    if (entry === "descriptors" || entry.endsWith(".json")) {
      continue;
    }

    const governedFiles = await collectGovernedFiles(join(fixturesDir, entry));

    if (governedFiles.length === 0) {
      continue;
    }

    fixtures.push({
      fixtureId: entry,
      governedFiles,
      migrationDescriptorId: null
    });
  }

  return FixtureGovernanceManifestSchema.parse({
    schemaVersion: FIXTURE_GOVERNANCE_MANIFEST_VERSION,
    fixtures: fixtures.sort((left, right) =>
      left.fixtureId.localeCompare(right.fixtureId)
    )
  });
}

export function assertFixtureGovernance(input: {
  manifest: FixtureGovernanceManifest;
  actual: FixtureGovernanceManifest;
  descriptors?: Record<string, MigrationDescriptor>;
}): FixtureGovernanceGuardResult {
  const findings: FixtureGovernanceFinding[] = [];
  const manifestByFixture = toFixtureMap(input.manifest.fixtures);
  const actualByFixture = toFixtureMap(input.actual.fixtures);
  const changedFixtureIdsByDescriptor = new Map<string, string[]>();

  for (const [fixtureId, manifestEntry] of manifestByFixture) {
    const actualEntry = actualByFixture.get(fixtureId);

    if (actualEntry === undefined) {
      findings.push({
        code: "fixture_missing",
        fixtureId,
        message: `Fixture ${fixtureId} is missing from disk.`
      });
      continue;
    }

    const comparison = compareFixtureEntry(manifestEntry, actualEntry);

    if (comparison.changed) {
      if (manifestEntry.migrationDescriptorId === null) {
        findings.push(
          ...comparison.changes.map((change) => ({
            ...change,
            fixtureId
          }))
        );
        findings.push({
          code: "migration_descriptor_missing",
          fixtureId,
          message: `Fixture ${fixtureId} changed without a migration descriptor.`
        });
      } else {
        const changedFixtures =
          changedFixtureIdsByDescriptor.get(manifestEntry.migrationDescriptorId) ??
          [];

        changedFixtures.push(fixtureId);
        changedFixtureIdsByDescriptor.set(
          manifestEntry.migrationDescriptorId,
          changedFixtures
        );
      }
    }
  }

  for (const [fixtureId] of actualByFixture) {
    if (!manifestByFixture.has(fixtureId)) {
      findings.push({
        code: "fixture_unexpected",
        fixtureId,
        message: `Fixture ${fixtureId} is not declared in MANIFEST.json.`
      });
    }
  }

  for (const [descriptorId, changedFixtureIds] of changedFixtureIdsByDescriptor) {
    const descriptor = input.descriptors?.[descriptorId];

    if (descriptor === undefined) {
      for (const fixtureId of changedFixtureIds) {
        const comparison = compareFixtureEntry(
          manifestByFixture.get(fixtureId)!,
          actualByFixture.get(fixtureId)!
        );

        findings.push(
          ...comparison.changes.map((change) => ({
            ...change,
            fixtureId
          }))
        );
        findings.push({
          code: "migration_descriptor_missing",
          fixtureId,
          message: `Fixture ${fixtureId} declared migration descriptor ${descriptorId}, but no descriptor was provided.`
        });
      }
      continue;
    }

    const validation = validateMigrationDescriptor(descriptor, {
      actualChangedFixtures: changedFixtureIds
    });

    if (!validation.ok) {
      for (const fixtureId of changedFixtureIds) {
        const comparison = compareFixtureEntry(
          manifestByFixture.get(fixtureId)!,
          actualByFixture.get(fixtureId)!
        );

        findings.push(
          ...comparison.changes.map((change) => ({
            ...change,
            fixtureId
          }))
        );
        findings.push({
          code: "migration_descriptor_invalid",
          fixtureId,
          message: validation.reason
        });
      }
    }
  }

  return findings.length === 0 ? { ok: true } : { ok: false, findings };
}

export function hashFixtureFileContents(contents: string): HashDigest {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function collectGovernedFiles(
  fixtureDir: string
): Promise<FixtureGovernedFile[]> {
  const governedFiles: FixtureGovernedFile[] = [];
  const entries = await readdir(fixtureDir);

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const contents = await readFile(join(fixtureDir, entry), "utf8");

    governedFiles.push({
      path: entry,
      sha256: hashFixtureFileContents(contents)
    });
  }

  return governedFiles.sort((left, right) => left.path.localeCompare(right.path));
}

function toFixtureMap(
  fixtures: readonly FixtureGovernanceManifestEntry[]
): Map<string, FixtureGovernanceManifestEntry> {
  return new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
}

function compareFixtureEntry(
  manifestEntry: FixtureGovernanceManifestEntry,
  actualEntry: FixtureGovernanceManifestEntry
): {
  changed: boolean;
  changes: Array<Omit<FixtureGovernanceFinding, "fixtureId">>;
} {
  const changes: Array<Omit<FixtureGovernanceFinding, "fixtureId">> = [];
  const manifestFiles = toGovernedFileMap(manifestEntry.governedFiles);
  const actualFiles = toGovernedFileMap(actualEntry.governedFiles);

  for (const [path, manifestFile] of manifestFiles) {
    const actualFile = actualFiles.get(path);

    if (actualFile === undefined) {
      changes.push({
        code: "governed_file_missing",
        path,
        message: `Fixture ${manifestEntry.fixtureId} is missing governed file ${path}.`
      });
      continue;
    }

    if (actualFile.sha256 !== manifestFile.sha256) {
      changes.push({
        code: "governed_file_hash_changed",
        path,
        message: `Fixture ${manifestEntry.fixtureId} governed file ${path} changed from ${manifestFile.sha256} to ${actualFile.sha256}.`
      });
    }
  }

  for (const [path] of actualFiles) {
    if (!manifestFiles.has(path)) {
      changes.push({
        code: "governed_file_unexpected",
        path,
        message: `Fixture ${manifestEntry.fixtureId} has undeclared governed file ${path}.`
      });
    }
  }

  return {
    changed: changes.length > 0,
    changes
  };
}

function toGovernedFileMap(
  governedFiles: readonly FixtureGovernedFile[]
): Map<string, FixtureGovernedFile> {
  return new Map(governedFiles.map((file) => [file.path, file]));
}
