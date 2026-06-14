import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");

const installabilityGapOwners = [
  {
    gap: "package_taxonomy",
    owner: "FEAT-EPIC-001/G-PKG-001"
  },
  {
    gap: "exports_bin_metadata",
    owner: "FEAT-EPIC-001/G-PKG-001"
  },
  {
    gap: "cli_product_surface",
    owner: "FEAT-EPIC-002/G-CLI-001"
  },
  {
    gap: "mcp_server_packaging",
    owner: "FEAT-EPIC-005/G-MCP-001"
  },
  {
    gap: "host_command_packs",
    owner: "FEAT-EPIC-006/G-HOST-001"
  },
  {
    gap: "release_tags_provenance",
    owner: "FEAT-EPIC-013/G-REL-001"
  },
  {
    gap: "install_docs_ux",
    owner: "FEAT-EPIC-015/G-DOCS-001"
  }
] as const;

const futureInstallSmoke = [
  "create clean project",
  "install approved package set",
  "run documented specwright command",
  "receive structured output",
  "reject workspace-only dependency leakage"
] as const;

describe("AUD-005A installability readiness", () => {
  test("current package inventory remains a source-checkout baseline", async () => {
    const rootManifest = await readManifest(join(rootDir, "package.json"));
    const workspaceManifests = await readWorkspaceManifests();
    const packageManifests = workspaceManifests.map((entry) => entry.manifest);
    const binManifests = workspaceManifests.filter(
      (entry) => entry.manifest.bin !== undefined
    );

    expect(rootManifest.name).toBe("specwright");
    expect(rootManifest.private).toBe(true);
    expect("version" in rootManifest).toBe(false);
    expect("license" in rootManifest).toBe(false);
    expect("repository" in rootManifest).toBe(false);
    await expect(stat(join(rootDir, "LICENSE"))).resolves.toBeDefined();

    expect(workspaceManifests).toHaveLength(17);
    expect(packageManifests.every((manifest) => manifest.private === true)).toBe(
      true
    );
    expect(
      packageManifests.every((manifest) => manifest.version === "0.0.0")
    ).toBe(true);
    expect(
      packageManifests.filter((manifest) => manifest.publishConfig !== undefined)
    ).toEqual([]);
    expect(packageManifests.filter((manifest) => manifest.license !== undefined))
      .toEqual([]);
    expect(
      packageManifests.filter((manifest) => manifest.repository !== undefined)
    ).toEqual([]);
    expect(workspaceManifests.filter(hasProductionWorkspaceDependency))
      .toHaveLength(16);
    expect(workspaceManifests.filter(hasAnyWorkspaceDependency)).toHaveLength(17);
    expect(
      binManifests.map((entry) => ({
        name: entry.manifest.name,
        bin: entry.manifest.bin
      }))
    ).toEqual([
      {
        name: "@specwright/adapters-cli",
        bin: {
          specwright: "./dist/bin.js"
        }
      }
    ]);
  });

  test("README and distribution evidence remain checkout-oriented", async () => {
    const readme = await readFile(join(rootDir, "README.md"), "utf8");

    expect(readme).toContain("git clone https://github.com/NikolaCehic/Specwright.git");
    expect(readme).toContain("bun install");
    expect(readme).toContain("bun run build");
    expect(readme).toContain("bun packages/adapters-cli/dist/bin.js help");
    expect(readme).toContain("The intended installed command name is `specwright`");
    expect(localGitTags()).toEqual([]);
    expect(installabilityGapOwners.map((row) => row.gap)).toEqual([
      "package_taxonomy",
      "exports_bin_metadata",
      "cli_product_surface",
      "mcp_server_packaging",
      "host_command_packs",
      "release_tags_provenance",
      "install_docs_ux"
    ]);
    expect(installabilityGapOwners.every((row) => row.owner.length > 0)).toBe(
      true
    );
    expect(futureInstallSmoke).toEqual([
      "create clean project",
      "install approved package set",
      "run documented specwright command",
      "receive structured output",
      "reject workspace-only dependency leakage"
    ]);
  });
});

type PackageManifest = {
  name?: string;
  private?: boolean;
  version?: string;
  license?: unknown;
  repository?: unknown;
  publishConfig?: unknown;
  bin?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function readWorkspaceManifests() {
  const packagesDir = join(rootDir, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (entry.isDirectory() === false) {
      continue;
    }

    manifests.push({
      dir: entry.name,
      manifest: await readManifest(join(packagesDir, entry.name, "package.json"))
    });
  }

  return manifests.sort((left, right) => left.dir.localeCompare(right.dir));
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

function hasProductionWorkspaceDependency(entry: { manifest: PackageManifest }) {
  return Object.values(entry.manifest.dependencies ?? {}).some(
    (specifier) => specifier === "workspace:*"
  );
}

function hasAnyWorkspaceDependency(entry: { manifest: PackageManifest }) {
  return dependencyBuckets(entry.manifest).some((dependencies) =>
    Object.values(dependencies).some((specifier) => specifier === "workspace:*")
  );
}

function dependencyBuckets(manifest: PackageManifest) {
  return [
    manifest.dependencies ?? {},
    manifest.devDependencies ?? {},
    manifest.peerDependencies ?? {},
    manifest.optionalDependencies ?? {}
  ];
}

function localGitTags() {
  const result = spawnSync("git", ["tag", "--list"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to list local git tags.");
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
