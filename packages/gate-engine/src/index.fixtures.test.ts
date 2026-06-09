import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertFixtureGovernance,
  collectFixtureGovernanceState,
  hashFixtureFileContents,
  readFixtureGovernanceManifest,
  type FixtureGovernanceManifest
} from "./fixture-governance";

const fixturesDir = join(import.meta.dir, "../fixtures");
const manifestPath = join(fixturesDir, "MANIFEST.json");

describe("fixture governance", () => {
  test("manifest matches the governed fixture corpus", async () => {
    const manifest = await readFixtureGovernanceManifest(manifestPath);
    const actual = await collectFixtureGovernanceState(fixturesDir);

    expect(assertFixtureGovernance({ manifest, actual })).toEqual({ ok: true });
  });

  test("mutated fixture content fails closed without a migration descriptor", async () => {
    const manifest = await readFixtureGovernanceManifest(manifestPath);
    const actual = await collectFixtureGovernanceState(fixturesDir);
    const mutated = cloneManifest(actual);
    const fixture = fixtureEntry(mutated, "context-sufficiency-pass");
    const governedFile = governedFileEntry(fixture, "expected-result.json");

    governedFile.sha256 = hashFixtureFileContents("{\"mutated\":true}\n");

    const result = assertFixtureGovernance({
      manifest,
      actual: mutated
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "governed_file_hash_changed",
            fixtureId: "context-sufficiency-pass",
            path: "expected-result.json"
          }),
          expect.objectContaining({
            code: "migration_descriptor_missing",
            fixtureId: "context-sufficiency-pass"
          })
        ])
      );
    }
  });

  test("descriptor mismatch fails closed", async () => {
    const manifest = await readFixtureGovernanceManifest(manifestPath);
    const actual = await collectFixtureGovernanceState(fixturesDir);
    const manifestWithDescriptor = cloneManifest(manifest);
    const mutated = cloneManifest(actual);
    const fixture = fixtureEntry(mutated, "context-sufficiency-pass");
    const governedFile = governedFileEntry(fixture, "expected-result.json");

    fixtureEntry(manifestWithDescriptor, "context-sufficiency-pass").migrationDescriptorId =
      "descriptor.mismatch";
    governedFile.sha256 = hashFixtureFileContents("{\"mutated\":true}\n");

    const result = assertFixtureGovernance({
      manifest: manifestWithDescriptor,
      actual: mutated,
      descriptors: {
        "descriptor.mismatch": {
          id: "descriptor.mismatch",
          fromEvaluatorVersion: "1.0.0",
          toEvaluatorVersion: "1.0.1",
          class: "migration-required",
          affectedFixtures: ["policy-denial-blocks"],
          rationale: "This descriptor intentionally names the wrong fixture.",
          replayImpact: "replay_via_alias"
        }
      }
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "migration_descriptor_invalid",
            fixtureId: "context-sufficiency-pass"
          })
        ])
      );
    }
  });

  test("matching descriptor admits an intentional governed fixture drift", async () => {
    const manifest = await readFixtureGovernanceManifest(manifestPath);
    const actual = await collectFixtureGovernanceState(fixturesDir);
    const manifestWithDescriptor = cloneManifest(manifest);
    const mutated = cloneManifest(actual);
    const fixture = fixtureEntry(mutated, "context-sufficiency-pass");
    const governedFile = governedFileEntry(fixture, "expected-result.json");

    fixtureEntry(manifestWithDescriptor, "context-sufficiency-pass").migrationDescriptorId =
      "descriptor.matching";
    governedFile.sha256 = hashFixtureFileContents("{\"mutated\":true}\n");

    expect(
      assertFixtureGovernance({
        manifest: manifestWithDescriptor,
        actual: mutated,
        descriptors: {
          "descriptor.matching": {
            id: "descriptor.matching",
            fromEvaluatorVersion: "1.0.0",
            toEvaluatorVersion: "1.0.1",
            class: "migration-required",
            affectedFixtures: ["context-sufficiency-pass"],
            rationale:
              "This fixture drift is intentionally covered by a descriptor.",
            replayImpact: "replay_via_alias"
          }
        }
      })
    ).toEqual({ ok: true });
  });
});

function cloneManifest<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fixtureEntry(
  manifest: FixtureGovernanceManifest,
  fixtureId: string
) {
  const fixture = manifest.fixtures.find((entry) => entry.fixtureId === fixtureId);

  if (fixture === undefined) {
    throw new Error(`Fixture ${fixtureId} is missing from the manifest.`);
  }

  return fixture;
}

function governedFileEntry(
  fixture: FixtureGovernanceManifest["fixtures"][number],
  path: string
) {
  const governedFile = fixture.governedFiles.find((entry) => entry.path === path);

  if (governedFile === undefined) {
    throw new Error(`Fixture ${fixture.fixtureId} is missing governed file ${path}.`);
  }

  return governedFile;
}
