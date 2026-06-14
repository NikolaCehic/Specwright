import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");

const expectedRootScripts = [
  "build",
  "check:cycles",
  "check:deps",
  "check:pack",
  "check:unused",
  "proof:v0",
  "test",
  "test:all",
  "test:core",
  "typecheck"
] as const;

const missingRootMatrixScripts = [
  "ci",
  "lint",
  "typecheck:packages",
  "test:packages",
  "check:release",
  "package:smoke"
] as const;

const expectedPackageScriptExtras = [
  {
    packageName: "@specwright/gate-engine",
    scripts: ["lint:gates"]
  },
  {
    packageName: "@specwright/policy-engine",
    scripts: ["validate:policy"]
  },
  {
    packageName: "@specwright/schemas",
    scripts: ["compat:report", "generate"]
  },
  {
    packageName: "@specwright/tool-broker",
    scripts: ["conformance:broker"]
  }
] as const;

const workflowRows = [
  {
    name: "Eval Runner Conformance",
    file: ".github/workflows/eval-runner-conformance.yml",
    requiredByBranchProtection: false,
    packageScope: "packages/eval-runner/**"
  },
  {
    name: "Policy Validation",
    file: ".github/workflows/policy-validation.yml",
    requiredByBranchProtection: true,
    packageScope: "packages/policy-engine/**"
  },
  {
    name: "Tool Broker Conformance",
    file: ".github/workflows/tool-broker-conformance.yml",
    requiredByBranchProtection: false,
    packageScope: "packages/tool-broker/**"
  }
] as const;

const localCiRows = [
  ["root_build", "bun run build", "implemented", "OPT-001A"],
  ["root_typecheck", "bun run typecheck", "implemented", "OPT-001A"],
  ["root_test", "bun run test", "implemented", "OPT-007A"],
  ["dependency_isolation", "bun run check:deps", "implemented", "OPT-003A"],
  ["source_cycles", "bun run check:cycles", "implemented", "AUD-006A"],
  ["unused_code", "bun run check:unused", "implemented", "AUD-008A"],
  ["package_packlist_dry_run", "bun run check:pack", "implemented", "FEAT-001D"],
  [
    "installability_readiness",
    "bun test test/installability-readiness.test.ts",
    "covered_by_root_test",
    "AUD-005A/G-PKG-001"
  ],
  [
    "naming_migration",
    "bun test test/naming-migration-inventory.test.ts",
    "covered_by_root_test",
    "AUD-015A/G-NAME-001"
  ],
  [
    "release_readiness",
    "bun test test/repository-release-readiness.test.ts",
    "covered_by_root_test",
    "AUD-016A/G-REL-001"
  ],
  [
    "wiki_status_reconciliation",
    "bun test test/wiki-status-reconciliation.test.ts",
    "covered_by_root_test",
    "AUD-017A/G-WIKI-001"
  ]
] as const;

const missingCiRowOwners = [
  ["ci", "G-CI-001"],
  ["lint", "G-CI-001"],
  ["typecheck:packages", "OPT-002A/G-CI-001"],
  ["test:packages", "OPT-001/G-CI-001"],
  ["check:release", "AUD-016A/FEAT-013A/G-REL-001"],
  ["package:smoke", "AUD-005A/FEAT-001A/G-PKG-001"],
  ["workflow_path_filters", "G-CI-001/G-GH-002"],
  ["branch_protection_required_checks", "G-CI-001/G-GH-002"],
  ["current_main_without_checks", "G-CI-001/G-GH-002"]
] as const;

const remoteCiSnapshot = {
  observedAt: "2026-06-14",
  repository: "NikolaCehic/Specwright",
  mainSha: "b77c6b0be404e646d908d860409336a6d1f8c5e9",
  activeWorkflowNames: [
    "Eval Runner Conformance",
    "Policy Validation",
    "Tool Broker Conformance"
  ],
  requiredStatusChecks: ["Policy validation"],
  requiredStatusChecksStrict: true,
  requiredPullRequestReviewsConfigured: false,
  currentMainCheckRuns: 0,
  currentMainStatuses: 0,
  currentMainStatusState: "pending"
} as const;

describe("OPT-001A local CI command matrix", () => {
  test("root and package-local command inventory is explicit", async () => {
    const rootManifest = await readManifest(join(rootDir, "package.json"));
    const rootScripts = rootManifest.scripts ?? {};
    const packageManifests = await readPackageManifests();
    const packageScriptExtras = packageManifests
      .map(({ manifest }) => ({
        packageName: manifest.name,
        scripts: Object.keys(manifest.scripts ?? {})
          .filter((script) => ["build", "test", "typecheck"].includes(script) === false)
          .sort()
      }))
      .filter((row) => row.scripts.length > 0)
      .sort((left, right) => left.packageName.localeCompare(right.packageName));

    expect(Object.keys(rootScripts).sort()).toEqual(expectedRootScripts);
    expect(
      missingRootMatrixScripts.filter((script) => rootScripts[script] !== undefined)
    ).toEqual([]);
    expect(packageManifests).toHaveLength(17);
    expect(
      packageManifests
        .filter(({ manifest }) => hasScripts(manifest, ["build", "typecheck", "test"]) === false)
        .map(({ manifest }) => manifest.name)
    ).toEqual([]);
    expect(packageScriptExtras).toEqual(expectedPackageScriptExtras);
  });

  test("workflow coverage and CI gap ownership remain read-only", async () => {
    const workflowFiles = trackedWorkflowFiles();

    expect(workflowFiles).toEqual(workflowRows.map((row) => row.file));

    for (const row of workflowRows) {
      const workflow = await readFile(join(rootDir, row.file), "utf8");

      expect(workflow).toContain(`name: ${row.name}`);
      expect(workflow).toContain("pull_request:");
      expect(workflow).toContain("push:");
      expect(workflow).toContain("paths:");
      expect(workflow).toContain(row.packageScope);
    }

    expect(
      workflowRows
        .filter((row) => row.requiredByBranchProtection)
        .map((row) => row.name)
    ).toEqual(["Policy Validation"]);
    expect(localCiRows.every(([, command, status, owner]) =>
      command.length > 0 && status.length > 0 && owner.length > 0
    )).toBe(true);
    expect(missingCiRowOwners.map(([row]) => row)).toEqual([
      "ci",
      "lint",
      "typecheck:packages",
      "test:packages",
      "check:release",
      "package:smoke",
      "workflow_path_filters",
      "branch_protection_required_checks",
      "current_main_without_checks"
    ]);
    expect(missingCiRowOwners.every(([, owner]) => owner.length > 0)).toBe(true);
    expect(remoteCiSnapshot).toMatchObject({
      repository: "NikolaCehic/Specwright",
      mainSha: "b77c6b0be404e646d908d860409336a6d1f8c5e9",
      activeWorkflowNames: [
        "Eval Runner Conformance",
        "Policy Validation",
        "Tool Broker Conformance"
      ],
      requiredStatusChecks: ["Policy validation"],
      requiredStatusChecksStrict: true,
      requiredPullRequestReviewsConfigured: false,
      currentMainCheckRuns: 0,
      currentMainStatuses: 0,
      currentMainStatusState: "pending"
    });
  });

  if (process.env.SPECWRIGHT_LOCAL_CI_REMOTE === "1") {
    test("optional live GitHub CI verifier stays read-only", () => {
      const workflows = commandOutput("gh", [
        "workflow",
        "list",
        "--repo",
        "NikolaCehic/Specwright",
        "--all"
      ]);
      const mainBranch = ghJson([
        "api",
        "repos/NikolaCehic/Specwright/branches/main",
        "--jq",
        "{name: .name, protected: .protected, commitSha: .commit.sha}"
      ]) as { name: string; protected: boolean; commitSha: string };
      const protection = ghJson([
        "api",
        "repos/NikolaCehic/Specwright/branches/main/protection",
        "--jq",
        "{required_status_checks: .required_status_checks, required_pull_request_reviews: .required_pull_request_reviews}"
      ]) as {
        required_status_checks: { contexts: string[]; strict: boolean };
        required_pull_request_reviews: unknown;
      };
      const checkRuns = ghJson([
        "api",
        `repos/NikolaCehic/Specwright/commits/${mainBranch.commitSha}/check-runs`,
        "--jq",
        "{total_count: .total_count}"
      ]) as { total_count: number };
      const status = ghJson([
        "api",
        `repos/NikolaCehic/Specwright/commits/${mainBranch.commitSha}/status`,
        "--jq",
        "{state: .state, total_count: .total_count}"
      ]) as { state: string; total_count: number };

      for (const workflowName of remoteCiSnapshot.activeWorkflowNames) {
        expect(workflows).toContain(workflowName);
      }

      expect(mainBranch).toMatchObject({
        name: "main",
        protected: true
      });
      expect(protection.required_status_checks.contexts).toEqual([
        "Policy validation"
      ]);
      expect(protection.required_status_checks.strict).toBe(true);
      expect(protection.required_pull_request_reviews).toBeNull();
      expect(checkRuns.total_count).toBe(0);
      expect(status).toEqual({
        state: "pending",
        total_count: 0
      });
    });
  } else {
    test.skip("optional live GitHub CI verifier stays read-only", () => {});
  }
});

type PackageManifest = {
  name: string;
  scripts?: Record<string, string>;
};

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

async function readPackageManifests() {
  const entries = await readdir(join(rootDir, "packages"), {
    withFileTypes: true
  });
  const manifests = [];

  for (const entry of entries) {
    if (entry.isDirectory() === false) {
      continue;
    }

    manifests.push({
      dir: entry.name,
      manifest: await readManifest(
        join(rootDir, "packages", entry.name, "package.json")
      )
    });
  }

  return manifests.sort((left, right) => left.dir.localeCompare(right.dir));
}

function hasScripts(manifest: PackageManifest, scripts: readonly string[]) {
  return scripts.every((script) => manifest.scripts?.[script] !== undefined);
}

function trackedWorkflowFiles() {
  return commandOutput("git", ["ls-files", ".github/workflows"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function ghJson(args: string[]) {
  return JSON.parse(commandOutput("gh", args)) as unknown;
}

function commandOutput(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `${command} ${args.join(" ")} exited with status ${result.status}.`
    );
  }

  return result.stdout.trim();
}
