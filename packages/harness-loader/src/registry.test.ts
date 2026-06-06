import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HarnessLoaderError,
  HarnessRegistry,
  assertLifecycleTransition,
  computeSpecHash,
  createSnapshotCache,
  loadHarnessPackageWithLimits,
  type GrantSource,
  type HarnessLoaderLimitsInput,
  type HarnessRegistryLoader,
  type PromotionApproval
} from "./index";
import {
  makeSignedHarnessPackage,
  validHarnessFiles,
  writeHarnessPackage,
  type SignedHarnessPackageFixture
} from "../test/fixtures/trust-fixtures";

const packageId = "specwright.default";
const loadedAt = "2026-05-29T00:00:00.000Z";
const runbookDir = resolve(dirname(fileURLToPath(import.meta.url)), "../runbooks");

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-harness-registry-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("harness registry lifecycle, limits, cache, and runbooks", () => {
  test("promotes candidates only with approval and verified trust evidence", async () => {
    const { registry, cache } = createRegistry();
    const fixture = await makeSignedHarnessPackage(rootDir);
    const key = { packageId, version: "0.1.0" };

    registry.stageCandidate({
      ...key,
      packageDir: fixture.packageDir
    });

    const missingApproval = await expectHarnessError(
      () =>
        registry.promote({
          ...key,
          loadOptions: signedLoadOptions(fixture)
        }),
      "promotion_unapproved"
    );
    expect(missingApproval.reason).toBe("missing_recorded_approval");
    expect(registry.getLifecycle(key)?.state).toBe("candidate");

    const missingTrust = await expectHarnessError(
      () =>
        registry.promote({
          ...key,
          approval: approval("approval-missing-trust")
        }),
      "promotion_unapproved"
    );
    expect(missingTrust.reason).toBe("missing_trust_verification");
    expect(registry.getLifecycle(key)?.state).toBe("candidate");

    const promoted = await registry.promote({
      ...key,
      approval: approval("approval-valid"),
      loadOptions: signedLoadOptions(fixture)
    });

    expect(promoted.specHash).toBe(fixture.specHash);
    expect(registry.getLifecycle(key)?.state).toBe("trusted");
    expect(cache.has(fixture.specHash)).toBe(true);
    expect(registry.resolveCurrentTrusted(packageId).specHash).toBe(
      fixture.specHash
    );
  });

  test("rejects unlisted lifecycle transitions", async () => {
    const error = await expectHarnessError(
      () =>
        assertLifecycleTransition({
          from: "deprecated",
          to: "trusted",
          evidence: {
            approval: approval("approval-invalid-transition")
          }
        }),
      "invalid_lifecycle_transition"
    );

    expect(error.reason).toBe("transition_not_allowed");
  });

  test("rejects every over-limit package before parse or validate completes", async () => {
    const packageDir = await writeHarnessPackage(
      rootDir,
      "over-limit",
      validHarnessFiles()
    );
    const cases: Array<{
      name: string;
      limits: HarnessLoaderLimitsInput;
      reason: string;
    }> = [
      {
        name: "bytes",
        limits: { maxPackageBytes: 10 },
        reason: "maxPackageBytes"
      },
      {
        name: "files",
        limits: { maxFileCount: 1 },
        reason: "maxFileCount"
      },
      {
        name: "definitions",
        limits: { maxDefinitionsPerKind: 1 },
        reason: "maxDefinitionsPerKind"
      },
      {
        name: "phase nodes",
        limits: { maxPhaseGraphNodes: 1 },
        reason: "maxPhaseGraphNodes"
      },
      {
        name: "phase edges",
        limits: { maxPhaseGraphEdges: 0 },
        reason: "maxPhaseGraphEdges"
      },
      {
        name: "artifact bytes",
        limits: { maxArtifactSchemaBytes: 10 },
        reason: "maxArtifactSchemaBytes"
      },
      {
        name: "artifact depth",
        limits: { maxArtifactSchemaDepth: 1 },
        reason: "maxArtifactSchemaDepth"
      }
    ];

    for (const limitCase of cases) {
      const stages: string[] = [];
      const error = await expectHarnessError(
        () =>
          loadHarnessPackageWithLimits({
            packageDir,
            limits: limitCase.limits,
            onLoadStage: async (stage, _metadata, operation) => {
              stages.push(`${stage}:start`);
              const value = await operation();
              stages.push(`${stage}:done`);

              return value;
            }
          }),
        "resource_limit_exceeded"
      );

      expect(error.reason, limitCase.name).toBe(limitCase.reason);
      expect(stages[0]).toBe("harness.fetch:start");
      expect(stages.includes("harness.fetch:done")).toBe(
        !["maxFileCount", "maxPackageBytes"].includes(limitCase.reason)
      );
      expect(stages.some((stage) => stage.startsWith("harness.parse"))).toBe(
        false
      );
      expect(stages.some((stage) => stage.startsWith("harness.validate"))).toBe(
        false
      );
    }
  });

  test("discards poisoned cache entries before serving a snapshot", async () => {
    const { registry, cache } = createRegistry();
    const fixture = await promoteSignedFixture(registry, "0.1.0");

    expect(cache.has(fixture.specHash)).toBe(true);
    expect(
      cache.poisonForTest(fixture.specHash, [
        {
          absolutePath: "harness.yaml",
          relativePath: "harness.yaml",
          raw: "id: tampered\n"
        }
      ])
    ).toBe(true);

    await expectHarnessError(
      () => registry.resolveSnapshot(fixture.specHash),
      "cache_poisoned"
    );
    expect(cache.has(fixture.specHash)).toBe(false);
  });

  test("rolls back current resolution without disrupting pinned specHash replay", async () => {
    const { registry } = createRegistry();
    const first = await promoteSignedFixture(registry, "0.1.0", "first");
    const second = await promoteSignedFixture(registry, "0.2.0", "second");

    expect(registry.resolveCurrentTrusted(packageId).specHash).toBe(
      second.specHash
    );

    registry.quarantine({
      packageId,
      version: "0.2.0",
      reason: "bad-promotion"
    });

    expect(registry.resolveCurrentTrusted(packageId).specHash).toBe(
      first.specHash
    );
    expect(registry.resolveSnapshot(second.specHash).specHash).toBe(
      second.specHash
    );
  });

  test("keeps promoted bytes immutable and fails closed on unknown hashes", async () => {
    const { registry } = createRegistry();
    const fixture = await promoteSignedFixture(registry, "0.1.0", "original");
    const changed = await makeSignedHarnessPackage(rootDir, {
      name: "changed-0.1.0",
      files: harnessFiles("0.1.0", "changed"),
      loadOptions: {
        grantSource: testGrantSource
      }
    });

    const overwrite = await expectHarnessError(
      () =>
        registry.promote({
          packageId,
          version: "0.1.0",
          packageDir: changed.packageDir,
          approval: approval("approval-overwrite"),
          loadOptions: signedLoadOptions(changed)
        }),
      "version_immutable"
    );

    expect(overwrite.reason).toBe("promoted_bytes_changed");
    expect(registry.resolveSnapshot(fixture.specHash).specHash).toBe(
      fixture.specHash
    );

    await expectHarnessError(
      () => registry.resolveSnapshot(`sha256:${"0".repeat(64)}`),
      "version_not_resolvable"
    );
  });

  test("purges revoked cache entries and re-derives from retained bytes", async () => {
    const { registry, cache } = createRegistry();
    const fixture = await promoteSignedFixture(registry, "0.1.0");

    expect(cache.has(fixture.specHash)).toBe(true);

    registry.revoke({
      packageId,
      version: "0.1.0",
      reason: "key-compromise"
    });

    expect(cache.has(fixture.specHash)).toBe(false);
    expect(registry.resolveSnapshot(fixture.specHash).specHash).toBe(
      fixture.specHash
    );
    expect(cache.has(fixture.specHash)).toBe(true);
  });

  test("promotes batches atomically", async () => {
    const { registry } = createRegistry();
    const first = await stageSignedFixture(registry, "0.1.0", "batch-first");
    const second = await stageSignedFixture(registry, "0.2.0", "batch-second");

    await expectHarnessError(
      () =>
        registry.promoteBatch([
          {
            packageId,
            version: "0.1.0",
            approval: approval("approval-batch-first"),
            loadOptions: signedLoadOptions(first)
          },
          {
            packageId,
            version: "0.2.0",
            loadOptions: signedLoadOptions(second)
          }
        ]),
      "promotion_unapproved"
    );

    expect(registry.getLifecycle({ packageId, version: "0.1.0" })?.state).toBe(
      "candidate"
    );
    expect(registry.getLifecycle({ packageId, version: "0.2.0" })?.state).toBe(
      "candidate"
    );
    await expectHarnessError(
      () => registry.resolveCurrentTrusted(packageId),
      "version_not_resolvable"
    );
  });

  test("preserves deterministic hash replay and serves warm cache hits", async () => {
    let loadCount = 0;
    const loader: HarnessRegistryLoader = async (input) => {
      loadCount += 1;

      return loadHarnessPackageWithLimits(input);
    };
    const { registry } = createRegistry({ loader });
    const fixture = await promoteSignedFixture(
      registry,
      "0.1.0",
      "warm-hit"
    );

    expect(loadCount).toBe(1);
    expect(registry.resolveSnapshot(fixture.specHash).specHash).toBe(
      fixture.specHash
    );
    expect(registry.resolveSnapshot(fixture.specHash).specHash).toBe(
      fixture.specHash
    );
    expect(loadCount).toBe(1);

    const lfPackage = await writeHarnessPackage(
      rootDir,
      "line-endings-lf",
      harnessFiles("0.3.0", "lf")
    );
    const crlfPackage = await writeHarnessPackage(
      rootDir,
      "line-endings-crlf",
      crlfFiles(harnessFiles("0.3.0", "lf"))
    );
    const lf = await loadHarnessPackageWithLimits({
      packageDir: lfPackage,
      loadedAt,
      grantSource: testGrantSource
    });
    const crlf = await loadHarnessPackageWithLimits({
      packageDir: crlfPackage,
      loadedAt,
      grantSource: testGrantSource
    });

    expect(lf.snapshot.specHash).toBe(crlf.snapshot.specHash);
    expect(computeSpecHash(lf.loadedFiles)).toBe(lf.snapshot.specHash);
  });

  test("documents every operator runbook action", async () => {
    const runbooks = new Set(await readdir(runbookDir));

    expect(runbooks).toEqual(
      new Set([
        "investigate-spec-hash-drift.md",
        "promote-package.md",
        "quarantine-package.md",
        "resolve-load-denial.md",
        "restore-archived-package.md",
        "roll-back-bad-promotion.md",
        "rotate-signing-key.md"
      ])
    );
  });
});

async function stageSignedFixture(
  registry: HarnessRegistry,
  version: string,
  marker = version
) {
  const fixture = await makeSignedHarnessPackage(rootDir, {
    name: `package-${version}-${marker}`,
    files: harnessFiles(version, marker),
    loadOptions: {
      grantSource: testGrantSource
    }
  });

  registry.stageCandidate({
    packageId,
    version,
    packageDir: fixture.packageDir
  });

  return fixture;
}

async function promoteSignedFixture(
  registry: HarnessRegistry,
  version: string,
  marker = version
) {
  const fixture = await stageSignedFixture(registry, version, marker);

  await registry.promote({
    packageId,
    version,
    approval: approval(`approval-${version}-${marker}`),
    loadOptions: signedLoadOptions(fixture)
  });

  return fixture;
}

function createRegistry(input: {
  limits?: HarnessLoaderLimitsInput;
  loader?: HarnessRegistryLoader;
} = {}) {
  const cache = createSnapshotCache(computeSpecHash, input.limits);
  const clock = createClock();
  const registry = new HarnessRegistry({
    cache,
    loader: input.loader ?? loadHarnessPackageWithLimits,
    now: clock
  });

  return {
    cache,
    registry
  };
}

function createClock() {
  let tick = 0;

  return () => {
    const timestamp = new Date(Date.UTC(2026, 4, 29, 0, 0, tick));
    tick += 1;

    return timestamp.toISOString();
  };
}

function signedLoadOptions(fixture: SignedHarnessPackageFixture) {
  return {
    signature: fixture.signature,
    trustStore: fixture.trustStore,
    strict: true,
    trustNow: loadedAt,
    loadedAt,
    grantSource: testGrantSource
  };
}

const testGrantSource: GrantSource = {
  resolveGrant(resolvedPackageId, version) {
    if (resolvedPackageId !== packageId) {
      return undefined;
    }

    return {
      grantId: `grant.${resolvedPackageId}.${version}`,
      packageId: resolvedPackageId,
      versionPins: [version],
      allowedTools: ["fs.read"],
      allowedRequireApproval: [],
      allowedToolDefinitions: ["fs.read"],
      allowedPolicyEffects: [],
      allowedPolicyLayers: [],
      allowedRuntimeInvariantToolIds: [],
      issuer: {
        registryId: "specwright.test.capability-grants",
        authorityId: "specwright.registry.test"
      }
    };
  }
};

function approval(approvalId: string): PromotionApproval {
  return {
    approvalId,
    approvedBy: "platform-approver",
    approvedAt: loadedAt,
    decision: "approved",
    reviewRef: `reviews/${approvalId}`
  };
}

function harnessFiles(version: string, marker: string) {
  const files = validHarnessFiles();

  files["harness.yaml"] = files["harness.yaml"]
    .replace("version: 0.1.0", `version: ${version}`)
    .replace("fixture: trust", `fixture: ${marker}`);
  files["prompts/planner.system.md"] =
    `${files["prompts/planner.system.md"]}\nMarker: ${marker}\n`;

  return files;
}

function crlfFiles(files: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [
      path,
      contents.replace(/\n/g, "\r\n")
    ])
  );
}

async function expectHarnessError(
  operation: () => unknown | Promise<unknown>,
  code: HarnessLoaderError["code"]
) {
  const error = await captureError(operation);

  expect(error).toBeInstanceOf(HarnessLoaderError);
  expect((error as HarnessLoaderError).code).toBe(code);

  return error as HarnessLoaderError;
}

async function captureError(operation: () => unknown | Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
