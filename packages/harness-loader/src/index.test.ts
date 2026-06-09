import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGrantEvaluatedEvent,
  canonicalizeMigrationDescriptor,
  classifyTransition,
  computeSpecHash,
  detectCapabilitySurfaceWidening,
  evaluateGrant,
  HarnessLoaderError,
  HarnessLoadProvenanceError,
  InMemoryTrustStore,
  assertRedactionEventsCoverSubstitutions,
  assessHarnessRunAuditability,
  loadCapabilityGrantRegistryFromFile,
  loadCompatibilityMatrixFromFile,
  loadDependencyRegistryFromFile,
  loadHarnessPackage,
  loadHarnessPackageObserved,
  loadHarnessPackageWithRecord,
  createSpecHashDriftLedger,
  verifySpecHash,
  RegistryGrantSource,
  SUPPORTED_HARNESS_SCHEMA_VERSION
} from "./index";
import type {
  CapabilityGrant,
  CompatibilityMatrix,
  HarnessDependencyEvent,
  HarnessGrantEvent,
  HarnessLoaderAuditEvent,
  HarnessTraceSpanInput,
  LoadHarnessPackageObservedOptions,
  MigrationDescriptor,
  MigrationDescriptorBody
} from "./index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEP_ALPHA_HASH =
  "sha256:433c9d4f8f84eea4656559cb7cb3040fa74023a7fc0668f9b05d79fa4bf3dead";
const DEP_BETA_HASH =
  "sha256:f55ad70e2ef3c77e3b633dd0743dc42ddf328e2b5c3d2ac060134e4a2c842edd";
const WRONG_DEP_HASH =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-harness-loader-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("harness loader", () => {
  test("loads and freezes a valid declarative harness package", async () => {
    const packageDir = await writeHarnessPackage("valid", validHarnessFiles());

    const snapshot = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z"
    });

    expect(snapshot.id).toBe("specwright.default");
    expect(snapshot.version).toBe("0.1.0");
    expect(snapshot.schemaVersion).toBe(SUPPORTED_HARNESS_SCHEMA_VERSION);
    expect(snapshot.specHash).toStartWith("sha256:");
    expect(snapshot.phases.map((phase) => phase.id)).toEqual([
      "intake",
      "evidence"
    ]);
    expect(snapshot.gates.map((gate) => gate.id)).toEqual([
      "intake.exit",
      "evidence.exit"
    ]);
    expect(snapshot.tools.map((tool) => tool.id)).toEqual(["fs.read"]);
    expect(snapshot.artifacts.map((artifact) => artifact.id)).toEqual([
      "run-input"
    ]);
    expect(snapshot.evals.map((evaluation) => evaluation.id)).toEqual([
      "eval.required"
    ]);
    expect(snapshot.prompts.map((prompt) => prompt.id)).toEqual([
      "planner.system"
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.phases)).toBe(true);
    expect(Object.isFrozen(snapshot.phases[0])).toBe(true);
  });

  test("fails closed when required harness fields are missing", async () => {
    const packageDir = await writeHarnessPackage("missing-required", {
      "harness.yaml": `
version: 0.1.0
schemaVersion: ${SUPPORTED_HARNESS_SCHEMA_VERSION}
`
    });

    const error = await captureError(() => loadHarnessPackage(packageDir));

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("invalid_manifest");
  });

  test("fails closed on duplicate definition IDs", async () => {
    const packageDir = await writeHarnessPackage("duplicate-ids", {
      "harness.yaml": `
id: specwright.duplicate
version: 0.1.0
schemaVersion: ${SUPPORTED_HARNESS_SCHEMA_VERSION}
phases:
  - id: intake
  - id: intake
`
    });

    const error = await captureError(() => loadHarnessPackage(packageDir));

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("duplicate_id");
  });

  test("fails closed when declared references are missing", async () => {
    const packageDir = await writeHarnessPackage("missing-reference", {
      "harness.yaml": `
id: specwright.missing-reference
version: 0.1.0
schemaVersion: ${SUPPORTED_HARNESS_SCHEMA_VERSION}
phases:
  - id: intake
    gates:
      - intake.exit
`
    });

    const error = await captureError(() => loadHarnessPackage(packageDir));

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("missing_reference");
  });

  test("fails closed when a package symlink resolves outside the root", async () => {
    const packageDir = await writeHarnessPackage(
      "symlink-escape",
      validHarnessFiles()
    );
    const outsideTool = join(rootDir, "outside-fs-read.yaml");

    await writeFile(outsideTool, validHarnessFiles()["tools/fs.read.yaml"].trimStart());
    await rm(join(packageDir, "tools/fs.read.yaml"));
    await symlink(outsideTool, join(packageDir, "tools/fs.read.yaml"));

    const error = await captureError(() => loadHarnessPackage(packageDir));

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("parse_error");
    expect((error as HarnessLoaderError).reason).toBe("path_escape");
  });

  test("fails closed when an optional package directory symlink resolves outside the root", async () => {
    const packageDir = await writeHarnessPackage(
      "directory-symlink-escape",
      validHarnessFiles()
    );
    const outsideToolsDir = join(rootDir, "outside-tools-dir");

    await mkdir(outsideToolsDir, { recursive: true });
    await writeFile(join(outsideToolsDir, "README.txt"), "not a tool definition\n");
    await rm(join(packageDir, "tools"), { recursive: true, force: true });
    await symlink(outsideToolsDir, join(packageDir, "tools"));

    const error = await captureError(() => loadHarnessPackage(packageDir));

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("parse_error");
    expect((error as HarnessLoaderError).reason).toBe("path_escape");
  });

  test("rejects remote artifact schema refs while allowing internal refs", async () => {
    const localRefPackageDir = await writeHarnessPackage("local-ref", {
      ...validHarnessFiles(),
      "artifact-schemas/run-input.json": JSON.stringify(
        {
          id: "run-input",
          version: "0.1.0",
          type: "object",
          properties: {
            task: {
              $ref: "#/$defs/task"
            }
          },
          $defs: {
            task: {
              type: "string"
            }
          }
        },
        null,
        2
      )
    });
    const local = await loadHarnessPackage(localRefPackageDir);

    expect(local.artifacts[0]?.schema).toMatchObject({
      properties: {
        task: {
          $ref: "#/$defs/task"
        }
      }
    });

    const deniedRefs = [
      { keyword: "$ref", ref: "https://schemas.example.invalid/task.json" },
      { keyword: "$ref", ref: "http://schemas.example.invalid/task.json" },
      { keyword: "$ref", ref: "//schemas.example.invalid/task.json" },
      { keyword: "$ref", ref: "../shared/task.json" },
      { keyword: "$ref", ref: "file:///tmp/task.json" },
      { keyword: "$dynamicRef", ref: "https://schemas.example.invalid/task.json" },
      { keyword: "$recursiveRef", ref: "https://schemas.example.invalid/task.json" }
    ];

    for (const [index, denied] of deniedRefs.entries()) {
      const remoteRefPackageDir = await writeHarnessPackage(`remote-ref-${index}`, {
        ...validHarnessFiles(),
        "artifact-schemas/run-input.json": JSON.stringify(
          {
            id: "run-input",
            version: "0.1.0",
            type: "object",
            properties: {
              task: {
                [denied.keyword]: denied.ref
              }
            }
          },
          null,
          2
        )
      });
      const error = await captureError(() =>
        loadHarnessPackage(remoteRefPackageDir)
      );

      expect(error, `${denied.keyword}:${denied.ref}`).toBeInstanceOf(
        HarnessLoaderError
      );
      expect((error as HarnessLoaderError).code, denied.keyword).toBe(
        "invalid_artifact_schema"
      );
      expect((error as HarnessLoaderError).reason, denied.keyword).toBe(
        "remote_ref_denied"
      );
    }
  });

  test("computes a stable specHash from package contents", async () => {
    const packageDir = await writeHarnessPackage(
      "stable-hash",
      validHarnessFiles()
    );

    const first = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z"
    });
    const second = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-30T00:00:00.000Z"
    });

    expect(first.specHash).toBe(second.specHash);
    expect(first.loadedAt).not.toBe(second.loadedAt);
  });

  test("loads the repository default harness package", async () => {
    const packageDir = join(repoRoot, "harnesses/default");

    const first = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z"
    });
    const second = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-30T00:00:00.000Z"
    });

    expect(first.id).toBe("specwright.default");
    expect(first.version).toBe("0.1.0");
    expect(first.schemaVersion).toBe(SUPPORTED_HARNESS_SCHEMA_VERSION);
    expect(first.specHash).toStartWith("sha256:");
    expect(first.specHash).toBe(
      "sha256:b29c8e3e58717c6c97bdf6029278cc6763cb0bc3492ff40a67ff7aaf0d4be456"
    );
    expect(first.specHash).toBe(second.specHash);
    expect(first.phases.map((phase) => phase.id)).toEqual([
      "intake",
      "source_discovery",
      "evidence",
      "planning",
      "verification",
      "packaging"
    ]);
    expect(first.gates.map((gate) => gate.id)).toEqual([
      "intake.exit",
      "evidence.context_sufficiency",
      "planning.plan_schema",
      "verification.required_evals",
      "packaging.run_report",
      "verification.model_review"
    ]);
    expect(first.policies.map((policy) => policy.id)).toEqual([
      "source_bound_v0"
    ]);
    expect(first.tools.map((tool) => tool.id)).toEqual([
      "fs.list",
      "fs.read",
      "eval.run",
      "model.review"
    ]);
    expect(first.tools.some((tool) => tool.id === "model.generate")).toBe(false);
    expect(first.artifacts.map((artifact) => artifact.id)).toEqual([
      "run-input",
      "source-inventory",
      "evidence-graph",
      "plan",
      "eval-report",
      "summary.md"
    ]);
    expect(first.evals.map((evaluation) => evaluation.id)).toEqual([
      "artifact_schema_presence",
      "source_fidelity",
      "completeness_required_sections"
    ]);
    expect(first.runtime).toMatchObject({
      strict: true,
      eventLog: "append-only",
      requireEvidenceForClaims: true
    });
    expect(first.policies[0]).toMatchObject({
      toolPolicy: {
        "fs.list": {
          allowedPhases: ["source_discovery", "evidence"]
        },
        "fs.read": {
          allowedPhases: ["source_discovery", "evidence", "verification"]
        },
        "eval.run": {
          allowedPhases: ["verification"]
        }
      }
    });
  });

  test("emits harness.grant.evaluated on an in-grant load", async () => {
    const packageDir = await writeHarnessPackage("grant-allow", validHarnessFiles());
    const events: HarnessGrantEvent[] = [];

    const record = await loadHarnessPackageWithRecord({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      onGrantEvent(event) {
        events.push(event);
      }
    });

    expect(record.grant.granted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "harness.grant.evaluated",
      payload: {
        packageId: "specwright.default",
        version: "0.1.0",
        verdict: "allowed",
        requested: {
          tools: ["fs.read"],
          requireApproval: [],
          toolDefinitions: ["fs.read"],
          policyEffects: [],
          policyLayers: [],
          runtimeInvariantToolIds: []
        },
        granted: {
          tools: ["eval.run", "fs.list", "fs.read"],
          requireApproval: [],
          toolDefinitions: ["eval.run", "fs.list", "fs.read"],
          policyEffects: ["deny"],
          policyLayers: ["runtime_invariant"],
          runtimeInvariantToolIds: [
            "fs.write",
            "git.branch",
            "git.commit",
            "git.push",
            "network.request",
            "network.write",
            "shell.exec"
          ]
        },
        overGrant: {
          tools: [],
          requireApproval: [],
          toolDefinitions: [],
          policyEffects: [],
          policyLayers: [],
          runtimeInvariantToolIds: []
        },
        deniedCapabilities: []
      }
    });
  });

  test("denies a tool declared outside the grant and returns no snapshot", async () => {
    const packageDir = await writeHarnessPackage(
      "grant-over-tool",
      overGrantToolFiles()
    );
    const events: HarnessGrantEvent[] = [];
    let snapshot: unknown;

    const error = await captureError(async () => {
      snapshot = await loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture("over-grant-registry.json"),
        onGrantEvent(event) {
          events.push(event);
        }
      });
    });

    expect(snapshot).toBeUndefined();
    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("grant_denied");
    expect((error as HarnessLoaderError).message).toContain("tool:shell.exec");
    expect((error as HarnessLoaderError).details).toMatchObject({
      offendingCapability: "tool:shell.exec"
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "harness.grant.evaluated",
      payload: {
        verdict: "denied",
        deniedCapabilities: [
          "tool:shell.exec",
          "toolDefinition:shell.exec"
        ],
        overGrant: {
          tools: ["shell.exec"],
          toolDefinitions: ["shell.exec"]
        },
        denialReason: "capability_outside_grant",
        failClosed: true
      }
    });
  });

  test("denies a package with no grant on file", async () => {
    const packageDir = await writeHarnessPackage(
      "grant-missing",
      packageFilesWithId("specwright.missing-grant")
    );
    const events: HarnessGrantEvent[] = [];

    const error = await captureError(async () =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture("missing-grant-registry.json"),
        onGrantEvent(event) {
          events.push(event);
        }
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("grant_denied");
    expect((error as HarnessLoaderError).message).toContain(
      "grant:specwright.missing-grant@0.1.0"
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: {
        verdict: "denied",
        deniedCapabilities: ["grant:specwright.missing-grant@0.1.0"],
        denialReason: "missing_grant",
        failClosed: true
      }
    });
  });

  test("denies a malformed grant before freeze", async () => {
    const packageDir = await writeHarnessPackage(
      "grant-malformed",
      packageFilesWithId("specwright.malformed")
    );
    const events: HarnessGrantEvent[] = [];
    let snapshot: unknown;

    const error = await captureError(async () => {
      snapshot = await loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture("malformed-grant-registry.json"),
        onGrantEvent(event) {
          events.push(event);
        }
      });
    });

    expect(snapshot).toBeUndefined();
    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("grant_denied");
    expect((error as HarnessLoaderError).reason).toBe("malformed_grant");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: {
        verdict: "denied",
        deniedCapabilities: ["grant:malformed_grant"],
        denialReason: "malformed_grant",
        failClosed: true
      }
    });
  });

  test("denies runtime-invariant target tools outside the grant", async () => {
    const packageDir = await writeHarnessPackage(
      "grant-runtime-invariant",
      runtimeInvariantFiles()
    );
    const events: HarnessGrantEvent[] = [];

    const error = await captureError(async () =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture(
          "runtime-invariant-registry.json"
        ),
        onGrantEvent(event) {
          events.push(event);
        }
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("grant_denied");
    expect((error as HarnessLoaderError).message).toContain(
      "runtimeInvariantTool:network.request"
    );
    expect(events[0]).toMatchObject({
      payload: {
        overGrant: {
          runtimeInvariantToolIds: ["network.request"]
        },
        deniedCapabilities: ["runtimeInvariantTool:network.request"],
        denialReason: "capability_outside_grant"
      }
    });
  });

  test("does not change in-grant specHash or frozen snapshot bytes", async () => {
    const packageDir = join(repoRoot, "harnesses/default");
    const defaultGrantSource = await grantSourceFromFixture("default-registry.json");
    const broaderGrantSource = new RegistryGrantSource({
      registryId: "specwright.test.capability-grants.broader",
      grants: [
        {
          grantId: "grant.specwright.default.broader.0.1.0",
          packageId: "specwright.default",
          versionPins: ["0.1.0"],
          allowedTools: [
            "eval.run",
            "fs.list",
            "fs.read",
            "model.generate",
            "model.review"
          ],
          allowedRequireApproval: [],
          allowedToolDefinitions: [
            "eval.run",
            "fs.list",
            "fs.read",
            "model.review"
          ],
          allowedPolicyEffects: ["allow", "deny"],
          allowedPolicyLayers: ["harness", "runtime_invariant"],
          allowedRuntimeInvariantToolIds: [
            "fs.write",
            "git.branch",
            "git.commit",
            "git.push",
            "network.request",
            "network.write",
            "shell.exec"
          ],
          issuer: {
            registryId: "specwright.test.capability-grants.broader",
            authorityId: "specwright.registry.operator"
          }
        }
      ]
    });

    const first = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: defaultGrantSource
    });
    const second = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: broaderGrantSource
    });

    expect(first.specHash).toBe(second.specHash);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("leaves an empty dependency closure out of hash and events", async () => {
    const packageDir = join(repoRoot, "harnesses/default");
    const events: HarnessDependencyEvent[] = [];

    const record = await loadHarnessPackageWithRecord({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      dependencyResolver: await dependencyResolverFromFixture(
        "reviewed-registry.json"
      ),
      onDependencyEvent(event) {
        events.push(event);
      }
    });

    expect(record.dependencies).toEqual({
      declarations: [],
      resolved: []
    });
    expect(record.snapshot.specHash).toBe(
      "sha256:b29c8e3e58717c6c97bdf6029278cc6763cb0bc3492ff40a67ff7aaf0d4be456"
    );
    expect(events).toHaveLength(0);
  });

  test("pins reviewed dependencies and folds the closure into specHash", async () => {
    const packageDir = dependencyFixturePackageDir("multi-dependency");
    const dependencyResolver = await dependencyResolverFromFixture(
      "reviewed-registry.json"
    );
    const events: HarnessDependencyEvent[] = [];

    const first = await loadHarnessPackageWithRecord({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      dependencyResolver,
      onDependencyEvent(event) {
        events.push(event);
      }
    });
    const second = await loadHarnessPackageWithRecord({
      packageDir,
      loadedAt: "2026-05-30T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      dependencyResolver
    });

    expect(first.dependencies.resolved).toEqual([
      {
        name: "specwright.dep.alpha",
        version: "1.0.0",
        contentHash: DEP_ALPHA_HASH,
        trustTier: "first-party"
      },
      {
        name: "specwright.dep.beta",
        version: "2.1.0",
        contentHash: DEP_BETA_HASH,
        trustTier: "first-party"
      }
    ]);
    expect(first.snapshot.specHash).toStartWith("sha256:");
    expect(first.snapshot.specHash).not.toBe(
      "sha256:2aaf5b2c377b3eb99cd50d74497bc46440dc5b27a9892d20978fd7968947ed44"
    );
    expect(first.snapshot.specHash).toBe(second.snapshot.specHash);
    expect("dependencies" in first.snapshot).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "harness.dependencies.pinned",
      payload: {
        packageId: "specwright.test",
        version: "0.1.0",
        specHash: first.snapshot.specHash,
        dependencies: first.dependencies.resolved
      }
    });
  });

  test("fails closed when a dependency cannot be resolved", async () => {
    const error = await captureDependencyFixtureDenial("unresolved");

    expect((error as HarnessLoaderError).reason).toBe("dependency_unresolved");
    expect((error as HarnessLoaderError).details).toMatchObject({
      dependencyName: "specwright.dep.missing"
    });
  });

  test("fails closed when a dependency resolves to a different hash", async () => {
    const error = await captureDependencyFixtureDenial("hash-mismatch");

    expect((error as HarnessLoaderError).reason).toBe(
      "dependency_hash_mismatch"
    );
    expect((error as HarnessLoaderError).details).toMatchObject({
      dependencyName: "specwright.dep.alpha",
      expected: WRONG_DEP_HASH,
      actual: DEP_ALPHA_HASH
    });
  });

  test("fails closed on unpinned dependencies in strict mode", async () => {
    const error = await captureDependencyFixtureDenial("unpinned", {
      strict: false
    });

    expect((error as HarnessLoaderError).reason).toBe("dependency_unpinned");
  });

  test("fails closed on range dependencies in strict mode", async () => {
    const error = await captureDependencyFixtureDenial("range-resolved");

    expect((error as HarnessLoaderError).reason).toBe(
      "dependency_range_not_pinned"
    );
  });

  test("fails closed on conflicting dependency declarations", async () => {
    const error = await captureDependencyFixtureDenial("conflicting-range");

    expect((error as HarnessLoaderError).reason).toBe("dependency_conflict");
    expect((error as HarnessLoaderError).details).toMatchObject({
      dependencyName: "specwright.dep.alpha"
    });
  });

  test("fails closed on dependency trust-tier violations", async () => {
    const error = await captureDependencyFixtureDenial("trust-tier-violation");

    expect((error as HarnessLoaderError).reason).toBe(
      "dependency_trust_tier_violation"
    );
    expect((error as HarnessLoaderError).details).toMatchObject({
      dependencyName: "specwright.dep.community",
      requiredTrustTier: "first-party",
      resolvedTrustTier: "community"
    });
  });

  test("classifies representative compatibility transitions exactly once", () => {
    expect(
      classifyTransition({
        declaredSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.1.0",
        runtimeVersion: "current",
        normalizedContentEqual: true
      })
    ).toBe("content-stable");
    expect(
      classifyTransition({
        declaredSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.1.1",
        runtimeVersion: "current",
        metadataOnly: true
      })
    ).toBe("patch-compatible");
    expect(
      classifyTransition({
        declaredSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.2.0",
        runtimeVersion: "current",
        additiveOnly: true
      })
    ).toBe("additive-compatible");
    expect(
      classifyTransition({
        declaredSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.1.0",
        runtimeVersion: "historical",
        replayVerified: true
      })
    ).toBe("replay-compatible");
    expect(
      classifyTransition({
        declaredSchemaVersion: "specwright.harness.v0alpha",
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.1.0",
        runtimeVersion: "current",
        schemaVersionChanged: true
      })
    ).toBe("migration-required");
    expect(
      classifyTransition({
        declaredSchemaVersion: "specwright.harness.v999",
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.1.0",
        runtimeVersion: "current",
        interpretable: false
      })
    ).toBe("breaking");
  });

  test("flags capability-surface widening as migration-required", () => {
    const widening = detectCapabilitySurfaceWidening(
      {
        tools: ["fs.read"],
        requireApproval: [],
        runtimeAuthority: {
          strict: true,
          failClosed: true,
          modelOutputAuthority: "proposal"
        }
      },
      {
        tools: ["fs.read", "network.request"],
        requireApproval: ["shell.exec"],
        runtimeAuthority: {
          strict: false,
          failClosed: true,
          modelOutputAuthority: "proposal"
        }
      }
    );

    expect(widening).toEqual({
      widened: true,
      addedTools: ["network.request"],
      addedRequireApproval: ["shell.exec"],
      widenedRuntimeAuthority: ["strict"]
    });
    expect(
      classifyTransition({
        declaredSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersion: "0.2.0",
        runtimeVersion: "current",
        additiveOnly: true,
        sourceCapabilitySurface: {
          tools: ["fs.read"],
          requireApproval: [],
          runtimeAuthority: {
            strict: true
          }
        },
        targetCapabilitySurface: {
          tools: ["fs.read", "network.request"],
          requireApproval: [],
          runtimeAuthority: {
            strict: true
          }
        }
      })
    ).toBe("migration-required");
  });

  test("enforces capability-surface widening on the load admission path", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-widening-load-path",
      overGrantToolFiles()
    );
    const error = await captureError(() =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        compatibilityMatrix: {
          matrixId: "specwright.test.compatibility.widening",
          rows: [
            {
              id: "unsafe-additive-load",
              runtimeVersion: "current",
              harnessSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
              packageVersionRange: "*",
              supportClass: "additive-compatible",
              loaderBehavior: "load",
              sourceCapabilitySurface: {
                tools: ["fs.read"],
                requireApproval: [],
                runtimeAuthority: {
                  strict: true
                }
              }
            }
          ]
        }
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe(
      "classifier_requires_migration"
    );
  });

  test("fails closed when additive load admission omits a source capability surface", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-widening-without-source-surface",
      overGrantToolFiles()
    );
    const error = await captureError(() =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        compatibilityMatrix: {
          matrixId: "specwright.test.compatibility.missing-source-surface",
          rows: [
            {
              id: "unsafe-additive-load-without-source",
              runtimeVersion: "current",
              harnessSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
              packageVersionRange: "*",
              supportClass: "additive-compatible",
              loaderBehavior: "load"
            }
          ]
        }
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe(
      "missing_source_capability_surface"
    );
  });

  test("loads a governed compatibility matrix fixture", async () => {
    const matrix = await compatibilityMatrixFromFixture();

    expect(matrix.matrixId).toBe(
      "specwright.test.harness-loader.compatibility.v1"
    );
    expect(matrix.rows.map((row) => row.id)).toEqual([
      "current-v0-load",
      "historical-v0alpha-migrate"
    ]);
  });

  test("loads an older schema version through a signed migration descriptor", async () => {
    const fixture = await makeMigrationFixture("compatibility-migrate");
    const first = await loadHarnessPackageWithRecord({
      packageDir: fixture.packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      compatibilityMatrix: await compatibilityMatrixFromFixture(),
      migrationDescriptor: fixture.descriptor,
      migrationTrustStore: fixture.trustStore,
      migrationNow: "2026-05-29T00:00:00.000Z"
    });
    const second = await loadHarnessPackageWithRecord({
      packageDir: fixture.packageDir,
      loadedAt: "2026-05-30T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      compatibilityMatrix: await compatibilityMatrixFromFixture(),
      migrationDescriptor: fixture.descriptor,
      migrationTrustStore: fixture.trustStore,
      migrationNow: "2026-05-29T00:00:00.000Z"
    });

    expect(first.snapshot.schemaVersion).toBe(SUPPORTED_HARNESS_SCHEMA_VERSION);
    expect(first.snapshot.specHash).toBe(fixture.migratedSpecHash);
    expect(first.snapshot.specHash).toBe(second.snapshot.specHash);
    expect(first.compatibility).toMatchObject({
      declaredSchemaVersion: "specwright.harness.v0alpha",
      targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
      compatibilityClass: "migration-required",
      loaderBehavior: "migrate",
      migration: {
        descriptorId: fixture.descriptor.migrationId,
        originalSpecHash: fixture.originalSpecHash,
        migratedSpecHash: fixture.migratedSpecHash
      }
    });
    expect("compatibility" in first.snapshot).toBe(false);
  });

  test("parses migrated non-manifest definitions from the migrated byte set", async () => {
    const sourceFiles = fileBackedHistoricalHarnessFiles(
      "specwright.harness.v0alpha",
      "legacy-intake"
    );
    const migratedFiles = fileBackedHistoricalHarnessFiles(
      SUPPORTED_HARNESS_SCHEMA_VERSION,
      "intake"
    );
    const fixture = await makeMigrationFixture(
      "compatibility-non-manifest-migrate",
      undefined,
      {
        sourceFiles,
        migratedFiles,
        fileReplacements: [
          {
            relativePath: "harness.yaml",
            from: "  - legacy-intake",
            to: "  - intake"
          },
          {
            relativePath: "phases/intake.yaml",
            from: "id: legacy-intake",
            to: "id: intake"
          }
        ]
      }
    );
    const record = await loadHarnessPackageWithRecord({
      packageDir: fixture.packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      compatibilityMatrix: await compatibilityMatrixFromFixture(),
      migrationDescriptor: fixture.descriptor,
      migrationTrustStore: fixture.trustStore,
      migrationNow: "2026-05-29T00:00:00.000Z"
    });

    expect(record.snapshot.phases.map((phase) => phase.id)).toEqual(["intake"]);
    expect(
      record.loadedFiles.find((file) => file.relativePath === "phases/intake.yaml")
        ?.raw
    ).toContain("id: intake");
    expect(record.snapshot.specHash).toBe(fixture.migratedSpecHash);
  });

  test("fails closed when an older schema version has no migration descriptor", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-missing-descriptor",
      historicalHarnessFiles()
    );
    let snapshot: unknown;

    const error = await captureError(async () => {
      snapshot = await loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture("default-registry.json"),
        compatibilityMatrix: await compatibilityMatrixFromFixture()
      });
    });

    expect(snapshot).toBeUndefined();
    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe(
      "missing_migration_descriptor"
    );
  });

  test("enforces classifier-required migration on the load path", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-widened-tool",
      overGrantToolFiles()
    );
    const error = await captureError(() =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        compatibilityMatrix: compatibilityMatrixWithDowngradedWidening()
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe(
      "classifier_requires_migration"
    );
  });

  test("enforces classifier-required migration for array-form tool widening", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-array-widened-tool",
      arrayFormWidenedToolFiles()
    );
    const error = await captureError(() =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        compatibilityMatrix: compatibilityMatrixWithDowngradedWidening()
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe(
      "classifier_requires_migration"
    );
  });

  test("rejects load rows that the classifier determines are breaking", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-breaking-load-row",
      validHarnessFiles()
    );
    const error = await captureError(() =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        compatibilityMatrix: {
          matrixId: "specwright.test.harness-loader.compatibility.breaking",
          rows: [
            {
              id: "breaking-row-must-not-load",
              runtimeVersion: "current",
              harnessSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
              packageVersionRange: "*",
              supportClass: "breaking",
              loaderBehavior: "load"
            }
          ]
        }
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe(
      "classifier_breaking_transition"
    );
  });

  test("rejects unknown future schema versions", async () => {
    const packageDir = await writeHarnessPackage(
      "compatibility-future",
      historicalHarnessFiles("specwright.harness.v999")
    );

    const error = await captureError(async () =>
      loadHarnessPackage({
        packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture("default-registry.json"),
        compatibilityMatrix: await compatibilityMatrixFromFixture()
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe(
      "unsupported_schema_version"
    );
    expect((error as HarnessLoaderError).reason).toBe("no_matrix_cell");
  });

  test("rejects migration output when descriptor attestation mismatches", async () => {
    const fixture = await makeMigrationFixture(
      "compatibility-attestation-mismatch",
      `sha256:${"f".repeat(64)}`
    );
    let snapshot: unknown;

    const error = await captureError(async () => {
      snapshot = await loadHarnessPackage({
        packageDir: fixture.packageDir,
        loadedAt: "2026-05-29T00:00:00.000Z",
        grantSource: await grantSourceFromFixture("default-registry.json"),
        compatibilityMatrix: await compatibilityMatrixFromFixture(),
        migrationDescriptor: fixture.descriptor,
        migrationTrustStore: fixture.trustStore,
        migrationNow: "2026-05-29T00:00:00.000Z"
      });
    });

    expect(snapshot).toBeUndefined();
    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("compatibility_denied");
    expect((error as HarnessLoaderError).reason).toBe("attestation_mismatch");
  });

  test("observed load emits the full harness span tree and frozen audit anchor", async () => {
    const packageDir = await writeHarnessPackage("observed-valid", validHarnessFiles());
    const spans: HarnessTraceSpanInput[] = [];
    const events: HarnessLoaderAuditEvent[] = [];

    const result = await loadHarnessPackageObserved({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      loadedBy: "operator:test",
      registryRef: "file://observed-valid",
      now: fixedClock("2026-05-29T00:00:00.000Z"),
      traceRecorder: {
        recordSpan(span) {
          spans.push(span);
        }
      },
      onAuditEvent(event) {
        events.push(event);
      }
    });

    expect(spans.map((span) => span.kind).sort()).toEqual([
      "harness.compatibility",
      "harness.fetch",
      "harness.freeze",
      "harness.grant_check",
      "harness.load",
      "harness.parse",
      "harness.resolve_deps",
      "harness.validate",
      "harness.verify_trust"
    ]);
    expect(
      spans.every((span) => span.metadata?.traceId === result.traceId)
    ).toBe(true);
    expect(events.map((event) => event.type)).toContain(
      "harness.snapshot.frozen"
    );
    expect(
      events.find((event) => event.type === "harness.snapshot.frozen")?.payload
    ).toMatchObject({
      specHash: result.record.snapshot.specHash,
      packageId: "specwright.default",
      version: "0.1.0",
      schemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
      loadedAt: "2026-05-29T00:00:00.000Z",
      cacheStatus: "bypass"
    });
    expect(
      JSON.parse(JSON.stringify(result.provenance))
    ).toEqual(result.provenance);
    expect(result.provenance).toMatchObject({
      harnessId: "specwright.default",
      version: "0.1.0",
      registryRef: {
        status: "known",
        value: "file://observed-valid"
      },
      loadedBy: {
        status: "known",
        value: "operator:test"
      },
      assets: {
        prompts: [
          expect.objectContaining({
            id: "planner.system",
            contentHash: expect.stringMatching(/^sha256:/)
          })
        ]
      }
    });
  });

  test("observed failure spans and events carry the exact loader error code", async () => {
    const packageDir = await writeHarnessPackage("observed-invalid", {
      "harness.yaml": `
version: 0.1.0
schemaVersion: ${SUPPORTED_HARNESS_SCHEMA_VERSION}
`
    });
    const spans: HarnessTraceSpanInput[] = [];
    const events: HarnessLoaderAuditEvent[] = [];

    const error = await captureError(() =>
      loadHarnessPackageObserved({
        packageDir,
        now: fixedClock("2026-05-29T00:00:00.000Z"),
        traceRecorder: {
          recordSpan(span) {
            spans.push(span);
          }
        },
        onAuditEvent(event) {
          events.push(event);
        }
      })
    );

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("invalid_manifest");
    expect(
      spans.find((span) => span.kind === "harness.parse")?.metadata
    ).toMatchObject({
      errorCode: "invalid_manifest"
    });
    expect(
      spans.find((span) => span.kind === "harness.load")?.metadata
    ).toMatchObject({
      errorCode: "invalid_manifest"
    });
    expect(
      events.find((event) => event.type === "harness.validation.failed")?.payload
    ).toMatchObject({
      errorCode: "invalid_manifest"
    });
    expect(
      events.find((event) => event.type === "harness.load.denied")?.payload
    ).toMatchObject({
      errorCode: "invalid_manifest",
      failClosed: true
    });
  });

  test("observed path escape records a security event and no run anchor", async () => {
    const packageDir = await writeHarnessPackage(
      "observed-symlink-escape",
      validHarnessFiles()
    );
    const outsideTool = join(rootDir, "observed-outside-fs-read.yaml");
    const runStore = await loadRunStoreForTest();
    const runId = "run-observed-path-escape";
    const traceId = "trace-observed-path-escape";
    const events: HarnessLoaderAuditEvent[] = [];

    await writeFile(outsideTool, validHarnessFiles()["tools/fs.read.yaml"].trimStart());
    await rm(join(packageDir, "tools/fs.read.yaml"));
    await symlink(outsideTool, join(packageDir, "tools/fs.read.yaml"));
    await runStore.createRun({
      rootDir,
      runId,
      traceId,
      input: {
        task: "Reject escaped harness package",
        harnessId: "specwright.default",
        host: {
          kind: "cli"
        }
      },
      harness: {
        id: "specwright.default",
        version: "0.1.0",
        specHash: `sha256:${"0".repeat(64)}`
      },
      timestamp: "2026-05-29T00:00:00.000Z"
    });

    const error = await captureError(() =>
      loadHarnessPackageObserved({
        packageDir,
        now: fixedClock("2026-05-29T00:00:00.000Z"),
        runContext: {
          rootDir,
          runId,
          traceId
        },
        onAuditEvent(event) {
          events.push(event);
        }
      })
    );
    const persistedEvents = await runStore.readEvents({ rootDir, runId });

    expect(error).toBeInstanceOf(HarnessLoaderError);
    expect((error as HarnessLoaderError).code).toBe("parse_error");
    expect((error as HarnessLoaderError).reason).toBe("path_escape");
    expect(
      events.find((event) => event.type === "harness.security.failed")?.payload
    ).toMatchObject({
      errorCode: "parse_error",
      reason: "path_escape",
      stage: "harness.parse",
      failClosed: true,
      severity: "critical"
    });
    expect(events.some((event) => event.type === "harness.snapshot.frozen")).toBe(
      false
    );
    expect(persistedEvents.map((event) => event.type)).toEqual(["run.started"]);
    expect(
      assessHarnessRunAuditability({
        specHash: `sha256:${"0".repeat(64)}`,
        events: persistedEvents
      })
    ).toEqual({
      status: "non_auditable",
      reason: "missing_harness_snapshot_anchor",
      specHash: `sha256:${"0".repeat(64)}`
    });
  });

  test("observed denials propagate trust, grant, dependency, and compatibility codes", async () => {
    const trustPackageDir = await writeHarnessPackage(
      "observed-trust-denied",
      validHarnessFiles()
    );
    const grantPackageDir = await writeHarnessPackage(
      "observed-grant-denied",
      overGrantToolFiles()
    );
    const compatibilityPackageDir = await writeHarnessPackage(
      "observed-compatibility-denied",
      historicalHarnessFiles()
    );
    const cases: Array<{
      name: string;
      code: HarnessLoaderError["code"];
      stage: string;
      options: LoadHarnessPackageObservedOptions;
    }> = [
      {
        name: "trust",
        code: "trust_rejected",
        stage: "harness.verify_trust",
        options: {
          packageDir: trustPackageDir,
          strict: true,
          trustNow: "2026-05-29T00:00:00.000Z"
        }
      },
      {
        name: "grant",
        code: "grant_denied",
        stage: "harness.grant_check",
        options: {
          packageDir: grantPackageDir,
          grantSource: await grantSourceFromFixture("over-grant-registry.json")
        }
      },
      {
        name: "dependency",
        code: "dependency_unresolved",
        stage: "harness.resolve_deps",
        options: {
          packageDir: dependencyFixturePackageDir("unresolved"),
          grantSource: await grantSourceFromFixture("default-registry.json"),
          dependencyResolver: await dependencyResolverFromFixture(
            "reviewed-registry.json"
          )
        }
      },
      {
        name: "compatibility",
        code: "compatibility_denied",
        stage: "harness.compatibility",
        options: {
          packageDir: compatibilityPackageDir,
          compatibilityMatrix: await compatibilityMatrixFromFixture()
        }
      }
    ];

    for (const denial of cases) {
      const spans: HarnessTraceSpanInput[] = [];
      const events: HarnessLoaderAuditEvent[] = [];
      const error = await captureError(() =>
        loadHarnessPackageObserved({
          ...denial.options,
          now: fixedClock("2026-05-29T00:00:00.000Z"),
          traceRecorder: {
            recordSpan(span) {
              spans.push(span);
            }
          },
          onAuditEvent(event) {
            events.push(event);
          }
        })
      );

      expect(error, denial.name).toBeInstanceOf(HarnessLoaderError);
      expect((error as HarnessLoaderError).code, denial.name).toBe(denial.code);
      expect(
        spans.find((span) => span.kind === denial.stage)?.metadata,
        denial.name
      ).toMatchObject({
        errorCode: denial.code
      });
      expect(
        spans.find((span) => span.kind === "harness.load")?.status,
        denial.name
      ).toBe("denied");
      expect(
        events.find((event) => event.type === "harness.load.denied")?.payload,
        denial.name
      ).toMatchObject({
        errorCode: denial.code,
        stage: denial.stage,
        failClosed: true
      });
      expect(
        events.some((event) => event.type === "harness.snapshot.frozen"),
        denial.name
      ).toBe(false);
    }
  });

  test("run-attached observed load persists the shared harness.loaded anchor", async () => {
    const packageDir = await writeHarnessPackage("observed-run", validHarnessFiles());
    const runStore = await loadRunStoreForTest();
    const runId = "run-observed-harness-load";
    const traceId = "trace-observed-harness-load";

    await runStore.createRun({
      rootDir,
      runId,
      traceId,
      input: {
        task: "Observe harness load",
        harnessId: "specwright.default",
        host: {
          kind: "cli"
        }
      },
      harness: {
        id: "specwright.default",
        version: "0.1.0",
        specHash: `sha256:${"0".repeat(64)}`
      },
      timestamp: "2026-05-29T00:00:00.000Z"
    });

    const result = await loadHarnessPackageObserved({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      now: fixedClock("2026-05-29T00:00:01.000Z"),
      runContext: {
        rootDir,
        runId,
        traceId
      }
    });
    const persistedEvents = await runStore.readEvents({ rootDir, runId });

    expect(result.runStoreAnchorEvent?.type).toBe("harness.loaded");
    expect(persistedEvents.map((event) => event.type)).toEqual([
      "run.started",
      "harness.loaded"
    ]);
    expect(
      persistedEvents.find((event) => event.type === "harness.loaded")?.payload
    ).toMatchObject({
      harness: {
        specHash: result.record.snapshot.specHash
      }
    });
    expect(
      result.auditEvents.find((event) => event.type === "harness.snapshot.frozen")
        ?.payload
    ).toMatchObject({
      specHash: result.record.snapshot.specHash
    });
    expect(result.runStoreAnchorEvent?.payload).toMatchObject({
      harness: {
        specHash: result.record.snapshot.specHash
      }
    });
    expect(
      assessHarnessRunAuditability({
        specHash: result.record.snapshot.specHash,
        events: persistedEvents
      })
    ).toMatchObject({
      status: "auditable",
      anchorType: "harness.loaded"
    });
    expect(
      assessHarnessRunAuditability({
        specHash: result.record.snapshot.specHash,
        events: []
      })
    ).toEqual({
      status: "non_auditable",
      reason: "missing_harness_snapshot_anchor",
      specHash: result.record.snapshot.specHash
    });
  });

  test("redaction substitutions require a matching redaction audit event", async () => {
    const packageDir = await writeHarnessPackage(
      "observed-redaction",
      validHarnessFiles()
    );
    const hashReference = {
      fieldPath: "metadata.secretToken",
      hashReference: `sha256:${"a".repeat(64)}`,
      originalClass: "secret"
    };

    const result = await loadHarnessPackageObserved({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      redaction: {
        profile: "model-safe",
        hashReferences: [hashReference]
      },
      now: fixedClock("2026-05-29T00:00:00.000Z")
    });

    expect(
      result.auditEvents.find((event) => event.type === "harness.redaction.applied")
        ?.payload
    ).toMatchObject({
      redactionProfile: "model-safe",
      redactedFieldPaths: ["metadata.secretToken"],
      hashReferences: [hashReference]
    });
    expect(() =>
      assertRedactionEventsCoverSubstitutions({
        hashReferences: [hashReference],
        events: []
      })
    ).toThrow(HarnessLoadProvenanceError);
  });

  test("specHash drift is returned as a typed signal without throwing the load path", async () => {
    const ledger = createSpecHashDriftLedger();
    const firstPackageDir = await writeHarnessPackage(
      "observed-drift-a",
      validHarnessFiles()
    );
    const secondPackageDir = await writeHarnessPackage("observed-drift-b", {
      ...validHarnessFiles(),
      "prompts/planner.system.md": `---
id: planner.system
description: Minimal planning prompt
---
Create source-bound plans only. Include a drift marker.
`
    });

    const first = await loadHarnessPackageObserved({
      packageDir: firstPackageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      driftLedger: ledger
    });
    const second = await loadHarnessPackageObserved({
      packageDir: secondPackageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      driftLedger: ledger
    });

    expect(first.drift).toMatchObject({
      status: "stable"
    });
    expect(second.drift).toMatchObject({
      status: "drift",
      packageId: "specwright.default",
      version: "0.1.0",
      previousSpecHashes: [first.record.snapshot.specHash],
      observedSpecHash: second.record.snapshot.specHash
    });
  });

  test("verifySpecHash fails closed when the snapshot cannot be re-proved", async () => {
    const packageDir = await writeHarnessPackage(
      "observed-reproof",
      validHarnessFiles()
    );
    const record = await loadHarnessPackageWithRecord({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z"
    });

    expect(() =>
      verifySpecHash(
        {
          ...record.snapshot,
          specHash: `sha256:${"f".repeat(64)}`
        },
        record.loadedFiles,
        record.dependencies.resolved
      )
    ).toThrow(HarnessLoadProvenanceError);
  });

  test("observability preserves CRLF/LF specHash and frozen snapshot determinism", async () => {
    const lfPackageDir = await writeHarnessPackage(
      "observed-lf",
      validHarnessFiles()
    );
    const crlfPackageDir = await writeHarnessPackage(
      "observed-crlf",
      withCrlf(validHarnessFiles())
    );

    const lf = await loadHarnessPackageObserved({
      packageDir: lfPackageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      now: fixedClock("2026-05-29T00:00:00.000Z")
    });
    const crlf = await loadHarnessPackageObserved({
      packageDir: crlfPackageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      now: fixedClock("2026-05-29T00:00:00.000Z")
    });

    expect(lf.record.snapshot.specHash).toBe(crlf.record.snapshot.specHash);
    expect(JSON.stringify(lf.record.snapshot)).toBe(
      JSON.stringify(crlf.record.snapshot)
    );
  });

  test("evaluateGrant and grant events are deterministic", () => {
    const requested = {
      tools: ["fs.read", "shell.exec", "fs.read"],
      requireApproval: ["fs.read"],
      toolDefinitions: ["shell.exec", "fs.read"],
      policyEffects: ["deny", "allow"],
      policyLayers: ["runtime_invariant"],
      runtimeInvariantToolIds: ["network.request", "shell.exec"]
    };
    const grant: CapabilityGrant = {
      grantId: "grant.specwright.determinism.0.1.0",
      packageId: "specwright.determinism",
      versionPins: ["0.1.0"],
      allowedTools: ["fs.read"],
      allowedRequireApproval: ["fs.read"],
      allowedToolDefinitions: ["fs.read"],
      allowedPolicyEffects: ["deny"],
      allowedPolicyLayers: ["runtime_invariant"],
      allowedRuntimeInvariantToolIds: ["shell.exec"],
      issuer: {
        registryId: "specwright.test.capability-grants.determinism",
        authorityId: "specwright.registry.operator"
      }
    };

    const first = evaluateGrant(requested, grant);
    const second = evaluateGrant(requested, grant);
    const firstEvent = buildGrantEvaluatedEvent(
      "specwright.determinism",
      "0.1.0",
      first
    );
    const secondEvent = buildGrantEvaluatedEvent(
      "specwright.determinism",
      "0.1.0",
      second
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(firstEvent)).toBe(JSON.stringify(secondEvent));
    expect(first.deniedCapabilities).toEqual([
      "tool:shell.exec",
      "toolDefinition:shell.exec",
      "policyEffect:allow",
      "runtimeInvariantTool:network.request"
    ]);
  });
});

function validHarnessFiles() {
  return {
    "harness.yaml": `
id: specwright.default
version: 0.1.0
schemaVersion: ${SUPPORTED_HARNESS_SCHEMA_VERSION}
runtime:
  strict: true
  eventLog: append-only
phases:
  - id: intake
    gates:
      - intake.exit
    tools:
      - fs.read
    artifactSchemas:
      - run-input
    evals:
      - eval.required
    next: evidence
  - id: evidence
    gates:
      - evidence.exit
gates:
  - intake.exit
  - evidence.exit
tools:
  allow:
    - fs.read
artifactSchemas:
  - run-input
evals:
  - eval.required
prompts:
  - planner.system
`,
    "gates/evidence.exit.yaml": `
id: evidence.exit
phase: evidence
kind: exit
required: true
checks:
  - id: has-evidence
    type: deterministic
`,
    "gates/intake.exit.yaml": `
id: intake.exit
phase: intake
kind: exit
required: true
checks:
  - id: task-known
    type: deterministic
`,
    "tools/fs.read.yaml": `
id: fs.read
version: 0.1.0
inputSchema:
  type: object
  required:
    - path
outputSchema:
  type: object
`,
    "artifact-schemas/run-input.json": JSON.stringify(
      {
        id: "run-input",
        version: "0.1.0",
        type: "object",
        required: ["task"],
        properties: {
          task: {
            type: "string"
          }
        }
      },
      null,
      2
    ),
    "evals/required.yaml": `
id: eval.required
artifactSchemas:
  - run-input
tools:
  - fs.read
prompts:
  - planner.system
`,
    "prompts/planner.system.md": `---
id: planner.system
description: Minimal planning prompt
---
Create source-bound plans only.
`
  };
}

function packageFilesWithId(id: string) {
  return {
    ...validHarnessFiles(),
    "harness.yaml": validHarnessFiles()["harness.yaml"].replace(
      "id: specwright.default",
      `id: ${id}`
    )
  };
}

function overGrantToolFiles() {
  const files = packageFilesWithId("specwright.over-grant");

  return {
    ...files,
    "harness.yaml": files["harness.yaml"]
      .replace(
        "    - fs.read\nartifactSchemas:",
        "    - fs.read\n    - shell.exec\nartifactSchemas:"
      )
      .replace(
        "tools:\n  allow:\n    - fs.read",
        "tools:\n  allow:\n    - fs.read\n    - shell.exec"
      ),
    "tools/shell.exec.yaml": `
id: shell.exec
version: 0.1.0
inputSchema:
  type: object
  required:
    - command
outputSchema:
  type: object
`
  };
}

function arrayFormWidenedToolFiles() {
  const files = packageFilesWithId("specwright.array-widened-tool");

  return {
    ...files,
    "harness.yaml": files["harness.yaml"]
      .replace(
        "    - fs.read\nartifactSchemas:",
        "    - fs.read\n    - shell.exec\nartifactSchemas:"
      )
      .replace(
        "tools:\n  allow:\n    - fs.read\nartifactSchemas:",
        "tools:\n  - fs.read\n  - shell.exec\nartifactSchemas:"
      ),
    "tools/shell.exec.yaml": `
id: shell.exec
version: 0.1.0
inputSchema:
  type: object
  required:
    - command
outputSchema:
  type: object
`
  };
}

function runtimeInvariantFiles() {
  const files = packageFilesWithId("specwright.runtime-invariant");

  return {
    ...files,
    "harness.yaml": files["harness.yaml"].replace(
      "tools:\n  allow:",
      "policies:\n  - runtime_bound\ntools:\n  allow:"
    ),
    "policies/runtime_bound.yaml": `
id: runtime_bound
runtimeInvariants:
  - id: deny.shell.exec
    layer: runtime_invariant
    effect: deny
    match:
      actionKind: tool_call
      toolId: shell.exec
  - id: deny.network.request
    layer: runtime_invariant
    effect: deny
    match:
      actionKind: tool_call
      toolId: network.request
`
  };
}

async function grantSourceFromFixture(name: string) {
  return loadCapabilityGrantRegistryFromFile(
    join(repoRoot, "packages/harness-loader/test/fixtures/grants", name)
  );
}

async function dependencyResolverFromFixture(name: string) {
  return loadDependencyRegistryFromFile(
    join(repoRoot, "packages/harness-loader/test/fixtures/dependencies", name)
  );
}

async function compatibilityMatrixFromFixture() {
  return loadCompatibilityMatrixFromFile(
    join(repoRoot, "packages/harness-loader/test/fixtures/compatibility/matrix.json")
  );
}

function dependencyFixturePackageDir(name: string) {
  return join(
    repoRoot,
    "packages/harness-loader/test/fixtures/dependencies",
    name
  );
}

function historicalHarnessFiles(schemaVersion = "specwright.harness.v0alpha") {
  return {
    "harness.yaml": `
id: specwright.test
version: 0.1.0
schemaVersion: ${schemaVersion}
metadata:
  fixture: compatibility
runtime:
  strict: true
phases:
  - id: intake
`
  };
}

function fileBackedHistoricalHarnessFiles(
  schemaVersion = "specwright.harness.v0alpha",
  phaseId = "legacy-intake"
) {
  return {
    "harness.yaml": `
id: specwright.test
version: 0.1.0
schemaVersion: ${schemaVersion}
metadata:
  fixture: compatibility
runtime:
  strict: true
phases:
  - ${phaseId}
`,
    "phases/intake.yaml": `
id: ${phaseId}
`
  };
}

function compatibilityMatrixWithDowngradedWidening() {
  return {
    matrixId: "specwright.test.harness-loader.compatibility.downgrade",
    rows: [
      {
        id: "current-v0-additive-load-widened",
        runtimeVersion: "current",
        harnessSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
        packageVersionRange: "*",
        supportClass: "additive-compatible",
        loaderBehavior: "load",
        sourceCapabilitySurface: {
          tools: ["fs.read"],
          requireApproval: [],
          runtimeAuthority: {
            strict: true
          }
        }
      }
    ]
  } satisfies CompatibilityMatrix;
}

async function makeMigrationFixture(
  name: string,
  expectedMigratedSpecHashOverride?: string,
  options: {
    sourceFiles?: Record<string, string>;
    migratedFiles?: Record<string, string>;
    fileReplacements?: Array<{
      relativePath: string;
      from: string;
      to: string;
    }>;
  } = {}
) {
  const sourceSchemaVersion = "specwright.harness.v0alpha";
  const targetSchemaVersion = SUPPORTED_HARNESS_SCHEMA_VERSION;
  const sourceFiles =
    options.sourceFiles ?? historicalHarnessFiles(sourceSchemaVersion);
  const migratedFiles =
    options.migratedFiles ?? historicalHarnessFiles(targetSchemaVersion);
  const packageDir = await writeHarnessPackage(name, sourceFiles);
  const originalSpecHash = computeSpecHash(sourceFilesFromRecord(sourceFiles));
  const migratedSpecHash = computeSpecHash(sourceFilesFromRecord(migratedFiles));
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({
    type: "spki",
    format: "pem"
  });
  const body: MigrationDescriptorBody = {
    migrationId: "migration.specwright.harness.v0alpha-to-v0",
    source: {
      contractId: "specwright.harness",
      version: sourceSchemaVersion
    },
    target: {
      contractId: "specwright.harness",
      version: targetSchemaVersion
    },
    sourceSchemaVersion,
    targetSchemaVersion,
    migrationType: "deterministic-text-transform",
    transform: {
      operation: "replace-manifest-schema-version",
      from: sourceSchemaVersion,
      to: targetSchemaVersion,
      ...(options.fileReplacements === undefined
        ? {}
        : { fileReplacements: options.fileReplacements })
    },
    dataLoss: "none",
    authorityChanges: [],
    redactionChanges: [],
    validation: {
      before: ["CompatibilityManifestEnvelopeSchema"],
      after: ["HarnessManifestSchema", "HarnessSnapshotSchema"]
    },
    rollbackStrategy: "preserve-original-bytes-and-specHash",
    replayFixtures: ["compatibility-v0alpha"],
    operatorApprovalRequired: false,
    expectedMigratedSpecHash:
      expectedMigratedSpecHashOverride ?? migratedSpecHash
  };
  const signatureBytes = sign(
    null,
    canonicalizeMigrationDescriptor(body),
    keyPair.privateKey
  );
  const descriptor: MigrationDescriptor = {
    ...body,
    signature: {
      publisherId: "publisher.compatibility",
      signingKeyId: "key.compatibility",
      algorithm: "ed25519",
      signature: signatureBytes.toString("base64")
    }
  };
  const trustStore = new InMemoryTrustStore({
    version: "migration-trust.v1",
    entries: [
      {
        publisherId: "publisher.compatibility",
        signingKeyId: "key.compatibility",
        publicKey,
        algorithm: "ed25519",
        status: "active"
      }
    ]
  });

  return {
    packageDir,
    descriptor,
    trustStore,
    originalSpecHash,
    migratedSpecHash
  };
}

function sourceFilesFromRecord(files: Record<string, string>) {
  return Object.entries(files)
    .map(([relativePath, raw]) => ({
      relativePath,
      raw: raw.trimStart()
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function writeHarnessPackage(
  name: string,
  files: Record<string, string>
) {
  const packageDir = join(rootDir, name);

  for (const [relativePath, contents] of Object.entries(files)) {
    const targetPath = join(packageDir, relativePath);

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents.trimStart());
  }

  return packageDir;
}

function fixedClock(start: string) {
  let tick = Date.parse(start);

  return () => {
    const value = new Date(tick).toISOString();
    tick += 1;

    return value;
  };
}

function withCrlf(files: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [
      path,
      contents.replace(/\r?\n/g, "\r\n")
    ])
  );
}

async function loadRunStoreForTest() {
  const moduleName = "@specwright/run-store";

  return (await import(moduleName)) as {
    createRun(options: Record<string, unknown>): Promise<unknown>;
    readEvents(options: Record<string, unknown>): Promise<
      Array<{
        type: string;
        payload: unknown;
      }>
    >;
  };
}

async function captureDependencyFixtureDenial(
  name: string,
  options: { strict?: boolean } = {}
) {
  const packageDir = dependencyFixturePackageDir(name);
  let snapshot: unknown;

  const error = await captureError(async () => {
    snapshot = await loadHarnessPackage({
      packageDir,
      loadedAt: "2026-05-29T00:00:00.000Z",
      grantSource: await grantSourceFromFixture("default-registry.json"),
      dependencyResolver: await dependencyResolverFromFixture(
        "reviewed-registry.json"
      ),
      ...(options.strict === undefined ? {} : { strict: options.strict })
    });
  });

  expect(snapshot).toBeUndefined();
  expect(error).toBeInstanceOf(HarnessLoaderError);
  expect((error as HarnessLoaderError).code).toBe("dependency_unresolved");

  return error;
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
