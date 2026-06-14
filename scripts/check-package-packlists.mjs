#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const FIRST_WAVE_PACKAGES = [
  {
    name: "@specwright/cli",
    directory: "packages/adapters-cli",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts", "dist/bin.js"]
  },
  {
    name: "@specwright/runtime",
    directory: "packages/runtime",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"]
  },
  {
    name: "@specwright/harness-loader",
    directory: "packages/harness-loader",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"]
  },
  {
    name: "@specwright/schemas",
    directory: "packages/schemas",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"]
  }
];

const EXPECTED_PUBLISH_CONFIG = {
  access: "public",
  registry: "https://registry.npmjs.org/",
  tag: "latest",
  provenance: true
};

const EXPECTED_ENGINES = {
  node: ">=20.0.0",
  bun: ">=1.1.0"
};

const DEPENDENCY_BUCKETS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];

const rootDir = path.resolve(argumentValue("--root") ?? process.cwd());
const jsonOutput = process.argv.includes("--json");

const result = await checkPackagePacklists(rootDir);

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(formatResult(result));
}

process.exitCode = result.blockingFindings.length === 0 ? 0 : 1;

async function checkPackagePacklists(root) {
  const workspacePackages = await discoverWorkspacePackages(root);
  const packagesByName = new Map(
    workspacePackages.map((workspacePackage) => [
      workspacePackage.manifest.name,
      workspacePackage
    ])
  );
  const checkedPackages = [];
  const blockingFindings = [];
  const publishBlockers = [];

  for (const expectedPackage of FIRST_WAVE_PACKAGES) {
    const workspacePackage = packagesByName.get(expectedPackage.name);

    if (workspacePackage === undefined) {
      blockingFindings.push({
        package: expectedPackage.name,
        code: "missing_first_wave_package",
        message: "First-wave package was not found in the workspace."
      });
      continue;
    }

    const relativeDir = slashPath(path.relative(root, workspacePackage.dir));

    if (relativeDir !== expectedPackage.directory) {
      blockingFindings.push({
        package: expectedPackage.name,
        code: "unexpected_package_directory",
        expected: expectedPackage.directory,
        actual: relativeDir
      });
    }

    blockingFindings.push(
      ...validateManifest({ expectedPackage, workspacePackage })
    );
    publishBlockers.push(...currentPublishBlockers(workspacePackage));

    const packResult = runNpmPackDryRun(workspacePackage);

    if (packResult.blockingFinding !== undefined) {
      blockingFindings.push(packResult.blockingFinding);
      continue;
    }

    const pack = packResult.pack;
    const filePaths = pack.files.map((file) => file.path).sort();

    blockingFindings.push(
      ...validatePacklist({
        expectedPackage,
        filePaths,
        pack,
        workspacePackage
      })
    );
    checkedPackages.push({
      name: workspacePackage.manifest.name,
      directory: relativeDir,
      version: workspacePackage.manifest.version,
      filename: pack.filename,
      fileCount: filePaths.length,
      requiredFiles: expectedPackage.requiredFiles,
      unexpectedFiles: unexpectedPackFiles(filePaths)
    });
  }

  return {
    rootDir: root,
    packageCount: checkedPackages.length,
    expectedPackageCount: FIRST_WAVE_PACKAGES.length,
    checkedPackages,
    blockingFindings,
    publishBlockers
  };
}

async function discoverWorkspacePackages(root) {
  const rootManifest = await readJson(path.join(root, "package.json"));
  const workspacePatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;

  if (!Array.isArray(workspacePatterns)) {
    throw new Error("Root package.json must define workspaces as an array");
  }

  const packageDirs = [];

  for (const pattern of workspacePatterns) {
    if (typeof pattern !== "string") {
      continue;
    }

    packageDirs.push(...(await expandWorkspacePattern(root, pattern)));
  }

  const packages = [];

  for (const packageDir of [...new Set(packageDirs)].sort()) {
    const manifestPath = path.join(packageDir, "package.json");
    const manifest = await readJson(manifestPath);

    if (typeof manifest.name === "string") {
      packages.push({
        dir: packageDir,
        manifest,
        manifestPath
      });
    }
  }

  return packages.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name)
  );
}

async function expandWorkspacePattern(root, pattern) {
  if (pattern.endsWith("/*") === false) {
    return [path.resolve(root, pattern)];
  }

  const parent = path.resolve(root, pattern.slice(0, -2));
  const entries = await readdir(parent, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

function validateManifest({ expectedPackage, workspacePackage }) {
  const manifest = workspacePackage.manifest;
  const findings = [];
  const expectedRepository = {
    type: "git",
    url: "git+https://github.com/NikolaCehic/Specwright.git",
    directory: expectedPackage.directory
  };

  if (typeof manifest.description !== "string" || manifest.description.length === 0) {
    findings.push({
      package: manifest.name,
      code: "missing_description",
      message: "First-wave package manifests must describe the public surface."
    });
  }

  if (manifest.license !== "MIT") {
    findings.push({
      package: manifest.name,
      code: "unexpected_license",
      expected: "MIT",
      actual: manifest.license
    });
  }

  if (canonicalJson(manifest.repository) !== canonicalJson(expectedRepository)) {
    findings.push({
      package: manifest.name,
      code: "unexpected_repository",
      expected: expectedRepository,
      actual: manifest.repository
    });
  }

  if (manifest.homepage !== "https://github.com/NikolaCehic/Specwright#readme") {
    findings.push({
      package: manifest.name,
      code: "unexpected_homepage",
      expected: "https://github.com/NikolaCehic/Specwright#readme",
      actual: manifest.homepage
    });
  }

  if (
    canonicalJson(manifest.bugs) !==
      canonicalJson({ url: "https://github.com/NikolaCehic/Specwright/issues" })
  ) {
    findings.push({
      package: manifest.name,
      code: "unexpected_bugs",
      expected: { url: "https://github.com/NikolaCehic/Specwright/issues" },
      actual: manifest.bugs
    });
  }

  if (
    Array.isArray(manifest.keywords) === false ||
    manifest.keywords.includes("specwright") === false
  ) {
    findings.push({
      package: manifest.name,
      code: "missing_keywords",
      message: "First-wave package keywords must include specwright."
    });
  }

  if (canonicalJson(manifest.engines) !== canonicalJson(EXPECTED_ENGINES)) {
    findings.push({
      package: manifest.name,
      code: "unexpected_engines",
      expected: EXPECTED_ENGINES,
      actual: manifest.engines
    });
  }

  if (
    canonicalJson(manifest.publishConfig) !==
    canonicalJson(EXPECTED_PUBLISH_CONFIG)
  ) {
    findings.push({
      package: manifest.name,
      code: "unexpected_publish_config",
      expected: EXPECTED_PUBLISH_CONFIG,
      actual: manifest.publishConfig
    });
  }

  if (Array.isArray(manifest.files) === false || manifest.files.length !== 1) {
    findings.push({
      package: manifest.name,
      code: "unexpected_files_field",
      expected: ["dist"],
      actual: manifest.files
    });
  } else if (manifest.files[0] !== "dist") {
    findings.push({
      package: manifest.name,
      code: "unexpected_files_field",
      expected: ["dist"],
      actual: manifest.files
    });
  }

  return findings;
}

function currentPublishBlockers(workspacePackage) {
  const manifest = workspacePackage.manifest;
  const blockers = [];

  if (manifest.private === true) {
    blockers.push({
      package: manifest.name,
      code: "package_private",
      message: "Package remains private until the release packet approves publish."
    });
  }

  if (manifest.version === "0.0.0") {
    blockers.push({
      package: manifest.name,
      code: "zero_version",
      message: "Package still uses the workspace placeholder version."
    });
  }

  for (const bucket of DEPENDENCY_BUCKETS) {
    for (const [name, specifier] of sortedEntries(manifest[bucket] ?? {})) {
      if (specifier === "workspace:*") {
        blockers.push({
          package: manifest.name,
          code: "workspace_dependency",
          dependency: name,
          bucket,
          message:
            "Published package manifests must not leak workspace dependency specifiers."
        });
      }
    }
  }

  return blockers;
}

function runNpmPackDryRun(workspacePackage) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: workspacePackage.dir,
    encoding: "utf8"
  });

  if (result.error !== undefined) {
    return {
      blockingFinding: {
        package: workspacePackage.manifest.name,
        code: "npm_pack_unavailable",
        message: result.error.message
      }
    };
  }

  if (result.status !== 0) {
    return {
      blockingFinding: {
        package: workspacePackage.manifest.name,
        code: "npm_pack_failed",
        status: result.status,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      }
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const pack = Array.isArray(parsed) ? parsed[0] : undefined;

    if (pack === undefined) {
      return {
        blockingFinding: {
          package: workspacePackage.manifest.name,
          code: "npm_pack_empty_output",
          stdout: result.stdout.trim()
        }
      };
    }

    return { pack };
  } catch (error) {
    return {
      blockingFinding: {
        package: workspacePackage.manifest.name,
        code: "npm_pack_invalid_json",
        message: error instanceof Error ? error.message : String(error),
        stdout: result.stdout.trim()
      }
    };
  }
}

function validatePacklist({ expectedPackage, filePaths, pack, workspacePackage }) {
  const manifest = workspacePackage.manifest;
  const findings = [];
  const unexpectedFiles = unexpectedPackFiles(filePaths);

  if (pack.name !== manifest.name) {
    findings.push({
      package: manifest.name,
      code: "pack_name_mismatch",
      expected: manifest.name,
      actual: pack.name
    });
  }

  if (pack.version !== manifest.version) {
    findings.push({
      package: manifest.name,
      code: "pack_version_mismatch",
      expected: manifest.version,
      actual: pack.version
    });
  }

  for (const requiredFile of expectedPackage.requiredFiles) {
    if (filePaths.includes(requiredFile) === false) {
      findings.push({
        package: manifest.name,
        code: "missing_pack_file",
        file: requiredFile
      });
    }
  }

  for (const unexpectedFile of unexpectedFiles) {
    findings.push({
      package: manifest.name,
      code: "unexpected_pack_file",
      file: unexpectedFile
    });
  }

  return findings;
}

function unexpectedPackFiles(filePaths) {
  return filePaths.filter(
    (filePath) => filePath !== "package.json" && filePath.startsWith("dist/") === false
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sortedEntries(object) {
  return Object.entries(object).sort(([left], [right]) =>
    left.localeCompare(right)
  );
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortValue(entryValue)])
    );
  }

  return value;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function formatResult(result) {
  const lines = [
    result.blockingFindings.length === 0
      ? "Package packlist dry-run check passed."
      : "Package packlist dry-run check failed.",
    `Packages checked: ${result.packageCount}/${result.expectedPackageCount}`,
    `Blocking findings: ${result.blockingFindings.length}`,
    `Publish blockers: ${result.publishBlockers.length}`
  ];

  if (result.blockingFindings.length > 0) {
    lines.push("", "Blocking findings:");

    for (const finding of result.blockingFindings) {
      lines.push(formatFinding(finding));
    }
  }

  if (result.publishBlockers.length > 0) {
    lines.push("", "Publish blockers:");

    for (const blocker of result.publishBlockers) {
      lines.push(formatFinding(blocker));
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatFinding(finding) {
  const details = Object.entries(finding)
    .filter(([key]) => key !== "package" && key !== "code")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const suffix = details.length === 0 ? "" : ` (${details.join(", ")})`;

  return `- ${finding.package}: ${finding.code}${suffix}`;
}
