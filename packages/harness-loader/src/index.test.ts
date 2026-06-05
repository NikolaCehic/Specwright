import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGrantEvaluatedEvent,
  evaluateGrant,
  HarnessLoaderError,
  loadCapabilityGrantRegistryFromFile,
  loadDependencyRegistryFromFile,
  loadHarnessPackage,
  loadHarnessPackageWithRecord,
  RegistryGrantSource,
  SUPPORTED_HARNESS_SCHEMA_VERSION
} from "./index";
import type {
  CapabilityGrant,
  HarnessDependencyEvent,
  HarnessGrantEvent
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
      "sha256:d878da67ae18d763e9f61bad0e3f15a883f78cd77ac17823a0a4a67e35847135"
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
      "packaging.run_report"
    ]);
    expect(first.policies.map((policy) => policy.id)).toEqual([
      "source_bound_v0"
    ]);
    expect(first.tools.map((tool) => tool.id)).toEqual([
      "fs.list",
      "fs.read",
      "eval.run"
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
          allowedTools: ["eval.run", "fs.list", "fs.read", "model.generate"],
          allowedRequireApproval: [],
          allowedToolDefinitions: ["eval.run", "fs.list", "fs.read"],
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
      "sha256:d878da67ae18d763e9f61bad0e3f15a883f78cd77ac17823a0a4a67e35847135"
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
      "sha256:d878da67ae18d763e9f61bad0e3f15a883f78cd77ac17823a0a4a67e35847135"
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

function dependencyFixturePackageDir(name: string) {
  return join(
    repoRoot,
    "packages/harness-loader/test/fixtures/dependencies",
    name
  );
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
