import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HarnessLoaderError,
  HarnessRegistry,
  InMemoryRegistryStore,
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
    expect((await registry.resolveCurrentTrusted(packageId)).specHash).toBe(
      fixture.specHash
    );
  });

  test("rejects promotion that was not explicitly staged", async () => {
    const { registry } = createRegistry();
    const fixture = await makeSignedHarnessPackage(rootDir);
    const error = await expectHarnessError(
      () =>
        registry.promote({
          packageId,
          version: "0.1.0",
          packageDir: fixture.packageDir,
          approval: approval("approval-unstaged"),
          loadOptions: signedLoadOptions(fixture)
        }),
      "version_not_resolvable"
    );

    expect(error.reason).toBe("candidate_not_staged");
  });

  test("rejects promotion from a package directory different than the staged bytes", async () => {
    const { registry } = createRegistry();
    const staged = await stageSignedFixture(registry, "0.1.0", "staged-dir");
    const attempted = await makeSignedHarnessPackage(rootDir, {
      name: "attempted-other-dir",
      files: harnessFiles("0.1.0", "attempted-other-dir"),
      loadOptions: {
        grantSource: testGrantSource
      }
    });
    const error = await expectHarnessError(
      () =>
        registry.promote({
          packageId,
          version: "0.1.0",
          packageDir: attempted.packageDir,
          approval: approval("approval-staged-dir-mismatch"),
          loadOptions: signedLoadOptions(staged)
        }),
      "invalid_lifecycle_transition"
    );

    expect(error.reason).toBe("staged_package_dir_mismatch");
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

  test("treats revoked as terminal except idempotent revocation", async () => {
    const { registry } = createRegistry();
    await promoteSignedFixture(registry, "0.1.0", "terminal-revoke");

    registry.revoke({
      packageId,
      version: "0.1.0",
      reason: "key-compromise"
    });
    registry.revoke({
      packageId,
      version: "0.1.0",
      reason: "repeat-key-compromise"
    });

    const error = await expectHarnessError(
      () =>
        registry.quarantine({
          packageId,
          version: "0.1.0",
          reason: "post-revocation-quarantine"
        }),
      "invalid_lifecycle_transition"
    );

    expect(error.reason).toBe("transition_not_allowed");
    expect(registry.getLifecycle({ packageId, version: "0.1.0" })?.state).toBe(
      "revoked"
    );
  });

  test("rejects staging a revoked package version", async () => {
    const { registry } = createRegistry();
    const fixture = await promoteSignedFixture(registry, "0.1.0", "revoked-restage");

    registry.revoke({
      packageId,
      version: "0.1.0",
      reason: "key-compromise"
    });

    const error = await expectHarnessError(
      () =>
        registry.stageCandidate({
          packageId,
          version: "0.1.0",
          packageDir: fixture.packageDir
        }),
      "invalid_lifecycle_transition"
    );

    expect(error.reason).toBe("revoked_is_terminal");
  });

  test("rejects every over-limit package before parse or validate completes", async () => {
    const packageDir = await writeHarnessPackage(
      rootDir,
      "over-limit",
      overLimitHarnessFiles()
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
      },
      {
        name: "dependency depth",
        limits: { maxDependencyDepth: 1 },
        reason: "maxDependencyDepth"
      },
      {
        name: "dependency fanout",
        limits: { maxDependencyFanout: 1 },
        reason: "maxDependencyFanout"
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

    expect((await registry.resolveCurrentTrusted(packageId)).specHash).toBe(
      second.specHash
    );

    registry.quarantine({
      packageId,
      version: "0.2.0",
      reason: "bad-promotion"
    });

    expect((await registry.resolveCurrentTrusted(packageId)).specHash).toBe(
      first.specHash
    );
    expect((await registry.resolveSnapshot(second.specHash)).specHash).toBe(
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

    registry.stageCandidate({
      packageId,
      version: "0.1.0",
      packageDir: changed.packageDir
    });

    const overwrite = await expectHarnessError(
      () =>
        registry.promote({
          packageId,
          version: "0.1.0",
          approval: approval("approval-overwrite"),
          loadOptions: signedLoadOptions(changed)
        }),
      "version_immutable"
    );

    expect(overwrite.reason).toBe("promoted_bytes_changed");
    expect((await registry.resolveSnapshot(fixture.specHash)).specHash).toBe(
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
    expect((await registry.resolveSnapshot(fixture.specHash)).specHash).toBe(
      fixture.specHash
    );
    expect(cache.has(fixture.specHash)).toBe(true);
  });

  test("revocation purges dependent cache entries and forces dependent re-verification", async () => {
    let loadCount = 0;
    const loader: HarnessRegistryLoader = async (input) => {
      loadCount += 1;

      return loadHarnessPackageWithLimits(input);
    };
    const { registry, cache, store } = createRegistry({ loader });
    const dependency = await makeSignedHarnessPackage(rootDir, {
      name: "dependency-alpha",
      files: minimalHarnessFiles("specwright.dep.alpha", "1.0.0"),
      loadOptions: {
        grantSource: grantSourceForPackage("specwright.dep.alpha")
      }
    });
    const dependencyKey = {
      packageId: "specwright.dep.alpha",
      version: "1.0.0"
    };
    registry.stageCandidate({
      ...dependencyKey,
      packageDir: dependency.packageDir
    });
    await registry.promote({
      ...dependencyKey,
      approval: approval("approval-dependency-alpha"),
      loadOptions: {
        ...signedTrustOnlyOptions(dependency),
        grantSource: grantSourceForPackage("specwright.dep.alpha")
      }
    });

    const dependencyResolver = {
      resolve() {
        return [
          {
            name: "specwright.dep.alpha",
            version: "1.0.0",
            contentHash: dependency.specHash,
            trustTier: "first-party"
          }
        ];
      }
    };
    const dependent = await makeSignedHarnessPackage(rootDir, {
      name: "dependent-on-alpha",
      files: dependentHarnessFiles(dependency.specHash),
      loadOptions: {
        dependencyResolver
      }
    });
    registry.stageCandidate({
      packageId,
      version: "0.1.0",
      packageDir: dependent.packageDir
    });
    await registry.promote({
      packageId,
      version: "0.1.0",
      approval: approval("approval-dependent-alpha"),
      loadOptions: {
        ...signedTrustOnlyOptions(dependent),
        dependencyResolver
      }
    });

    expect(cache.has(dependent.specHash)).toBe(true);
    expect(loadCount).toBe(2);

    const freshRegistry = new HarnessRegistry({
      store,
      cache,
      loader,
      now: createClock()
    });

    freshRegistry.revoke({
      ...dependencyKey,
      reason: "dependency-compromised"
    });

    expect(cache.has(dependent.specHash)).toBe(false);
    expect((await freshRegistry.resolveSnapshot(dependent.specHash)).specHash).toBe(
      dependent.specHash
    );
    expect(loadCount).toBe(3);
    expect(cache.has(dependent.specHash)).toBe(true);
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
    const { registry, cache } = createRegistry({ loader });
    const fixture = await promoteSignedFixture(
      registry,
      "0.1.0",
      "warm-hit"
    );

    expect(loadCount).toBe(1);
    expect((await registry.resolveSnapshot(fixture.specHash)).specHash).toBe(
      fixture.specHash
    );
    expect((await registry.resolveSnapshot(fixture.specHash)).specHash).toBe(
      fixture.specHash
    );
    expect(loadCount).toBe(1);
    expect(cache.delete(fixture.specHash)).toBe(true);
    await writeFile(
      join(fixture.packageDir, "prompts/planner.system.md"),
      "tampered after promotion\n"
    );
    expect((await registry.resolveSnapshot(fixture.specHash)).specHash).toBe(
      fixture.specHash
    );
    expect(loadCount).toBe(2);

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

  test("fails closed when retained-byte replay re-derives a different hash", async () => {
    let loadCount = 0;
    const replaySpecHash = `sha256:${"f".repeat(64)}`;
    const loader: HarnessRegistryLoader = async (input) => {
      loadCount += 1;
      const record = await loadHarnessPackageWithLimits(input);

      if (loadCount === 2) {
        return {
          ...record,
          snapshot: {
            ...record.snapshot,
            specHash: replaySpecHash
          }
        };
      }

      return record;
    };
    const { registry, cache } = createRegistry({ loader });
    const fixture = await promoteSignedFixture(
      registry,
      "0.1.0",
      "retained-mismatch"
    );

    cache.delete(fixture.specHash);
    const error = await expectHarnessError(
      () => registry.resolveSnapshot(fixture.specHash),
      "version_not_resolvable"
    );

    expect(error.reason).toBe("retained_bytes_hash_mismatch");
    expect(error.details).toMatchObject({
      requestedSpecHash: fixture.specHash,
      actualSpecHash: replaySpecHash
    });
  });

  test("fails closed when retained registry bytes are corrupted", async () => {
    const { registry, cache, store } = createRegistry();
    const fixture = await promoteSignedFixture(
      registry,
      "0.1.0",
      "retained-corrupt"
    );
    const promoted = store.getPromotedVersion({
      packageId,
      version: "0.1.0"
    });

    if (promoted === undefined) {
      throw new Error("Expected promoted registry record");
    }

    store.putPromotedVersion({
      ...promoted,
      files: promoted.files.map((file) =>
        file.relativePath === "prompts/planner.system.md"
          ? {
              ...file,
              raw: `${file.raw}\ncorrupted retained bytes\n`
            }
          : file
      ),
      loadOptions: {
        loadedAt,
        grantSource: testGrantSource
      }
    });
    cache.delete(fixture.specHash);

    const error = await expectHarnessError(
      () => registry.resolveSnapshot(fixture.specHash),
      "version_not_resolvable"
    );

    expect(error.reason).toBe("retained_bytes_hash_mismatch");
    expect(error.details).toMatchObject({
      requestedSpecHash: fixture.specHash
    });
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
  store?: InMemoryRegistryStore;
} = {}) {
  const cache = createSnapshotCache(computeSpecHash, input.limits);
  const clock = createClock();
  const store = input.store ?? new InMemoryRegistryStore();
  const registry = new HarnessRegistry({
    store,
    cache,
    loader: input.loader ?? loadHarnessPackageWithLimits,
    now: clock
  });

  return {
    cache,
    registry,
    store
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
    ...signedTrustOnlyOptions(fixture),
    grantSource: testGrantSource
  };
}

function signedTrustOnlyOptions(fixture: SignedHarnessPackageFixture) {
  return {
    signature: fixture.signature,
    trustStore: fixture.trustStore,
    strict: true,
    trustNow: loadedAt,
    loadedAt
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

function grantSourceForPackage(grantedPackageId: string): GrantSource {
  return {
    resolveGrant(resolvedPackageId, version) {
      if (resolvedPackageId !== grantedPackageId) {
        return undefined;
      }

      return {
        grantId: `grant.${resolvedPackageId}.${version}`,
        packageId: resolvedPackageId,
        versionPins: [version],
        allowedTools: [],
        allowedRequireApproval: [],
        allowedToolDefinitions: [],
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
}

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

function minimalHarnessFiles(resolvedPackageId: string, version: string) {
  return {
    "harness.yaml": `
id: ${resolvedPackageId}
version: ${version}
schemaVersion: specwright.harness.v0
metadata:
  trustTier: first-party
phases:
  - id: intake
`
  };
}

function dependentHarnessFiles(dependencySpecHash: string) {
  return {
    "harness.yaml": `
id: ${packageId}
version: 0.1.0
schemaVersion: specwright.harness.v0
metadata:
  trustTier: first-party
phases:
  - id: intake
dependencies:
  - name: specwright.dep.alpha
    versionRange: 1.0.0
    pinnedHash: ${dependencySpecHash}
    trustTier: first-party
`
  };
}

function overLimitHarnessFiles() {
  const files = validHarnessFiles();

  return {
    ...files,
    "harness.yaml": `${files["harness.yaml"]}
dependencies:
  - name: specwright.dep.alpha
    versionRange: 1.0.0
    pinnedHash: sha256:${"a".repeat(64)}
  - group:
      - name: specwright.dep.beta
        versionRange: 1.0.0
        pinnedHash: sha256:${"b".repeat(64)}
`
  };
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
