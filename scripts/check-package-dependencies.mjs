#!/usr/bin/env node
import { builtinModules } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEPENDENCY_BUCKETS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];
const PRODUCTION_BUCKETS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies"
];
const SCAN_DIRS = ["src", "test", "tests"];
const SCANNED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts"
]);
const IGNORED_DIRS = new Set([
  ".git",
  "dist",
  "node_modules",
  "coverage",
  ".turbo",
  ".cache"
]);
const IGNORED_SPECIFIERS = new Set([
  "bun:test",
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

const rootDir = path.resolve(argumentValue("--root") ?? process.cwd());
const jsonOutput = process.argv.includes("--json");

const result = await checkPackageDependencies(rootDir);

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(formatResult(result));
}

process.exitCode = result.blockingFindings.length === 0 ? 0 : 1;

async function checkPackageDependencies(root) {
  const rootManifestPath = path.join(root, "package.json");
  const rootManifest = await readJson(rootManifestPath);
  const packages = await discoverWorkspacePackages(root, rootManifest);
  const packageResults = [];
  let filesScanned = 0;
  let productionImportCount = 0;
  let testImportCount = 0;

  for (const workspacePackage of packages) {
    const files = await discoverPackageFiles(workspacePackage.dir);
    const productionImports = new Map();
    const testImports = new Map();

    filesScanned += files.length;

    for (const filePath of files) {
      const relativePath = slashPath(path.relative(root, filePath));
      const packageRelativePath = slashPath(
        path.relative(workspacePackage.dir, filePath)
      );
      const imports = extractPackageImports(await readFile(filePath, "utf8"));
      const targetMap = isTestPath(packageRelativePath)
        ? testImports
        : productionImports;

      for (const specifier of imports) {
        const dependencyName = packageNameForSpecifier(specifier);

        if (
          dependencyName === undefined ||
          dependencyName === workspacePackage.name ||
          IGNORED_SPECIFIERS.has(dependencyName)
        ) {
          continue;
        }

        if (targetMap === testImports) {
          testImportCount += 1;
        } else {
          productionImportCount += 1;
        }

        addEvidence(targetMap, dependencyName, relativePath);
      }
    }

    packageResults.push(
      analyzePackage({
        workspacePackage,
        productionImports,
        testImports
      })
    );
  }

  const blockingFindings = packageResults.flatMap(
    (packageResult) => packageResult.blockingFindings
  );
  const advisoryFindings = packageResults.flatMap(
    (packageResult) => packageResult.advisoryFindings
  );

  return {
    rootDir: root,
    packageCount: packages.length,
    filesScanned,
    productionImportCount,
    testImportCount,
    blockingFindings,
    advisoryFindings
  };
}

async function discoverWorkspacePackages(root, rootManifest) {
  const workspacePatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;

  if (!Array.isArray(workspacePatterns)) {
    throw new Error("Root package.json must define workspaces as an array");
  }

  const packageDirs = new Set();

  for (const pattern of workspacePatterns) {
    if (typeof pattern !== "string") {
      continue;
    }

    for (const packageDir of await expandWorkspacePattern(root, pattern)) {
      packageDirs.add(packageDir);
    }
  }

  const packages = [];

  for (const packageDir of [...packageDirs].sort()) {
    const manifestPath = path.join(packageDir, "package.json");

    if ((await exists(manifestPath)) === false) {
      continue;
    }

    const manifest = await readJson(manifestPath);

    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`${manifestPath} must declare a package name`);
    }

    packages.push({
      dir: packageDir,
      manifest,
      manifestPath,
      name: manifest.name
    });
  }

  return packages;
}

async function expandWorkspacePattern(root, pattern) {
  if (pattern.endsWith("/*") === false) {
    const absolute = path.resolve(root, pattern);
    return (await exists(path.join(absolute, "package.json"))) ? [absolute] : [];
  }

  const parent = path.resolve(root, pattern.slice(0, -2));

  if ((await exists(parent)) === false) {
    return [];
  }

  const entries = await readdir(parent, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

async function discoverPackageFiles(packageDir) {
  const files = [];

  for (const scanDir of SCAN_DIRS) {
    const absolute = path.join(packageDir, scanDir);

    if (await exists(absolute)) {
      files.push(...(await listSourceFiles(absolute)));
    }
  }

  const rootEntries = await readdir(packageDir, { withFileTypes: true });

  for (const entry of rootEntries) {
    const absolute = path.join(packageDir, entry.name);

    if (
      entry.isFile() &&
      isScannableSourceFile(absolute) &&
      isTestPath(entry.name)
    ) {
      files.push(absolute);
    }
  }

  return [...new Set(files)].sort();
}

async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absolute)));
      continue;
    }

    if (entry.isFile() && isScannableSourceFile(absolute)) {
      files.push(absolute);
    }
  }

  return files;
}

function analyzePackage({ workspacePackage, productionImports, testImports }) {
  const manifestDependencies = dependenciesByBucket(workspacePackage.manifest);
  const blockingFindings = [];
  const advisoryFindings = [];

  for (const [dependencyName, files] of sortedEntries(productionImports)) {
    if (isDeclaredInBuckets(manifestDependencies, dependencyName, PRODUCTION_BUCKETS)) {
      continue;
    }

    blockingFindings.push({
      package: workspacePackage.name,
      code: "undeclared_production_import",
      dependency: dependencyName,
      files
    });
  }

  for (const [dependencyName, files] of sortedEntries(testImports)) {
    if (isDeclaredInBuckets(manifestDependencies, dependencyName, DEPENDENCY_BUCKETS)) {
      continue;
    }

    blockingFindings.push({
      package: workspacePackage.name,
      code: "undeclared_test_import",
      dependency: dependencyName,
      files
    });
  }

  for (const bucket of PRODUCTION_BUCKETS) {
    for (const dependencyName of sortedKeys(manifestDependencies[bucket])) {
      if (productionImports.has(dependencyName)) {
        continue;
      }

      advisoryFindings.push({
        package: workspacePackage.name,
        code: testImports.has(dependencyName)
          ? "production_dependency_used_only_in_tests"
          : "production_dependency_without_static_production_import",
        dependency: dependencyName,
        bucket,
        files: testImports.get(dependencyName) ?? []
      });
    }
  }

  return {
    blockingFindings,
    advisoryFindings
  };
}

function dependenciesByBucket(manifest) {
  const dependencies = {};

  for (const bucket of DEPENDENCY_BUCKETS) {
    dependencies[bucket] =
      manifest[bucket] !== undefined && typeof manifest[bucket] === "object"
        ? manifest[bucket]
        : {};
  }

  return dependencies;
}

function isDeclaredInBuckets(dependencies, dependencyName, buckets) {
  return buckets.some((bucket) =>
    Object.prototype.hasOwnProperty.call(dependencies[bucket], dependencyName)
  );
}

function extractPackageImports(source) {
  const imports = new Set();
  const withoutComments = stripComments(source);
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(withoutComments)) !== null) {
      const specifier = match[1];

      if (typeof specifier === "string") {
        imports.add(specifier);
      }
    }
  }

  return [...imports].sort();
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function packageNameForSpecifier(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    IGNORED_SPECIFIERS.has(specifier)
  ) {
    return undefined;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope !== undefined && name !== undefined
      ? `${scope}/${name}`
      : specifier;
  }

  return specifier.split("/")[0];
}

function addEvidence(map, dependencyName, filePath) {
  const existing = map.get(dependencyName) ?? [];

  if (existing.includes(filePath) === false) {
    map.set(dependencyName, [...existing, filePath].sort());
  }
}

function isScannableSourceFile(filePath) {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }

  return SCANNED_EXTENSIONS.has(path.extname(filePath));
}

function isTestPath(filePath) {
  const normalized = slashPath(filePath);
  const basename = path.posix.basename(normalized);

  return (
    normalized.split("/").some((part) => part === "test" || part === "tests") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename)
  );
}

function formatResult(result) {
  const lines = [];

  lines.push(
    result.blockingFindings.length === 0
      ? "Dependency isolation check passed."
      : "Dependency isolation check failed."
  );
  lines.push(`Packages: ${result.packageCount}`);
  lines.push(`Files scanned: ${result.filesScanned}`);
  lines.push(`Production package imports: ${result.productionImportCount}`);
  lines.push(`Test package imports: ${result.testImportCount}`);
  lines.push(`Blocking findings: ${result.blockingFindings.length}`);
  lines.push(`Advisory findings: ${result.advisoryFindings.length}`);

  if (result.blockingFindings.length > 0) {
    lines.push("");
    lines.push("Blocking findings:");
    lines.push(...formatFindings(result.blockingFindings));
  }

  if (result.advisoryFindings.length > 0) {
    lines.push("");
    lines.push("Advisory findings:");
    lines.push(...formatFindings(result.advisoryFindings));
  }

  return `${lines.join("\n")}\n`;
}

function formatFindings(findings) {
  const lines = [];
  const byPackage = new Map();

  for (const finding of findings) {
    const packageFindings = byPackage.get(finding.package) ?? [];
    packageFindings.push(finding);
    byPackage.set(finding.package, packageFindings);
  }

  for (const packageName of [...byPackage.keys()].sort()) {
    lines.push(`- ${packageName}`);

    for (const finding of byPackage.get(packageName).sort(compareFindings)) {
      const bucket = finding.bucket === undefined ? "" : ` (${finding.bucket})`;
      lines.push(`  - ${finding.code}: ${finding.dependency}${bucket}`);

      for (const file of finding.files) {
        lines.push(`    - ${file}`);
      }
    }
  }

  return lines;
}

function compareFindings(left, right) {
  return (
    left.code.localeCompare(right.code) ||
    left.dependency.localeCompare(right.dependency)
  );
}

function sortedEntries(map) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function sortedKeys(object) {
  return Object.keys(object).sort();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function slashPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}
