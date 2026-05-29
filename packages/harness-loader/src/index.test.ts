import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HarnessLoaderError,
  loadHarnessPackage,
  SUPPORTED_HARNESS_SCHEMA_VERSION
} from "./index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}
