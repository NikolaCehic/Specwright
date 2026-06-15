#!/usr/bin/env node
import { builtinModules } from "node:module";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BASELINE_VERSION = 1;
const DEFAULT_BASELINE = "scripts/source-cycle-baseline.json";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORED_DIRS = new Set([
  ".git",
  "dist",
  "node_modules",
  "coverage",
  ".turbo",
  ".cache",
  "fixtures",
  "scripts",
  "test",
  "tests",
  "__tests__"
]);
const IGNORED_SPECIFIERS = new Set([
  "bun:test",
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

const rootDir = path.resolve(argumentValue("--root") ?? process.cwd());
const baselinePath = path.resolve(
  rootDir,
  argumentValue("--baseline") ?? DEFAULT_BASELINE
);
const writeBaseline = process.argv.includes("--write-baseline");
const jsonOutput = process.argv.includes("--json");

const analysis = await analyzeCycles(rootDir);
const actualBaseline = baselineFromAnalysis(analysis);

if (writeBaseline) {
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, canonicalJson(actualBaseline), "utf8");
}

const expectedBaseline = writeBaseline
  ? actualBaseline
  : await readExpectedBaseline(baselinePath);
const result = evaluateAnalysis({
  analysis,
  actualBaseline,
  baselinePath,
  expectedBaseline,
  wroteBaseline: writeBaseline
});

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(formatResult(result));
}

process.exitCode = result.blockingFindings.length === 0 ? 0 : 1;

async function analyzeCycles(root) {
  const rootManifest = await readJson(path.join(root, "package.json"));
  const packages = await discoverWorkspacePackages(root, rootManifest);
  const packageByName = new Map(
    packages.map((workspacePackage) => [workspacePackage.name, workspacePackage])
  );
  const packageGraph = new Map(
    packages.map((workspacePackage) => [workspacePackage.name, new Set()])
  );
  const sourceGraph = new Map();
  const sourceFilesByPackage = new Map();
  const barrelImports = [];
  let fileCount = 0;

  for (const workspacePackage of packages) {
    const files = await discoverProductionSourceFiles(workspacePackage.srcDir);
    const fileSet = new Set(files);
    sourceFilesByPackage.set(workspacePackage.name, fileSet);
    fileCount += files.length;

    for (const filePath of files) {
      sourceGraph.set(slashPath(path.relative(root, filePath)), new Set());
    }
  }

  for (const workspacePackage of packages) {
    const files = [...sourceFilesByPackage.get(workspacePackage.name)].sort();

    for (const filePath of files) {
      const from = slashPath(path.relative(root, filePath));
      const imports = extractImports(await readFile(filePath, "utf8"));

      for (const specifier of imports) {
        const dependencyName = packageNameForSpecifier(specifier);

        if (
          dependencyName !== undefined &&
          dependencyName !== workspacePackage.name &&
          packageByName.has(dependencyName)
        ) {
          packageGraph.get(workspacePackage.name).add(dependencyName);
        }

        const resolved = resolveSourceImport({
          filePath,
          fileSet: sourceFilesByPackage.get(workspacePackage.name),
          specifier,
          workspacePackage
        });

        if (resolved === undefined) {
          continue;
        }

        const to = slashPath(path.relative(root, resolved));
        sourceGraph.get(from).add(to);

        if (isIndexFile(resolved)) {
          barrelImports.push({
            package: workspacePackage.name,
            from,
            to,
            specifier
          });
        }
      }
    }
  }

  const packageCycles = cyclesFromGraph(packageGraph).map((cycle) => ({
    packages: cycle
  }));
  const sourceCycles = cyclesFromGraph(sourceGraph).map((cycle) =>
    sourceCycleRecord({
      cycle,
      packages,
      root,
      sourceGraph
    })
  );
  const sourceCycleFileSet = new Set(
    sourceCycles.flatMap((cycle) => cycle.files)
  );
  const sameCycleBarrelImports = barrelImports.filter(
    (edge) => sourceCycleFileSet.has(edge.from) && sourceCycleFileSet.has(edge.to)
  );

  return {
    rootDir: root,
    packageCount: packages.length,
    productionFileCount: fileCount,
    packageEdgeCount: [...packageGraph.values()].reduce(
      (total, edges) => total + edges.size,
      0
    ),
    packageCycles: sortRecords(packageCycles),
    sourceCycles: sortRecords(sourceCycles),
    barrelImports: sortRecords(barrelImports),
    sameCycleBarrelImports: sortRecords(sameCycleBarrelImports)
  };
}

function baselineFromAnalysis(analysis) {
  return {
    version: BASELINE_VERSION,
    policy: {
      packageCycles: "blocking",
      sourceCycles: "baseline",
      barrelImports: "baseline",
      ci: "deferred"
    },
    inventory: {
      packageCount: analysis.packageCount,
      productionFileCount: analysis.productionFileCount,
      packageEdgeCount: analysis.packageEdgeCount,
      packageCycleCount: analysis.packageCycles.length,
      sourceCycleCount: analysis.sourceCycles.length,
      barrelImportCount: analysis.barrelImports.length,
      sameCycleBarrelImportCount: analysis.sameCycleBarrelImports.length
    },
    packageCycles: analysis.packageCycles,
    sourceCycles: analysis.sourceCycles,
    barrelImports: analysis.barrelImports
  };
}

function evaluateAnalysis({
  analysis,
  actualBaseline,
  baselinePath,
  expectedBaseline,
  wroteBaseline
}) {
  const blockingFindings = [];

  for (const cycle of analysis.packageCycles) {
    blockingFindings.push({
      code: "package_cycle",
      message: "Production package graph contains a cycle.",
      cycle: cycle.packages
    });
  }

  if (
    wroteBaseline === false &&
    canonicalComparable(actualBaseline) !== canonicalComparable(expectedBaseline)
  ) {
    blockingFindings.push({
      code: "source_cycle_baseline_drift",
      message:
        "Current source-cycle or barrel-import inventory differs from the checked-in baseline.",
      expected: expectedBaseline.inventory,
      actual: actualBaseline.inventory
    });
  }

  return {
    baselinePath: slashPath(baselinePath),
    wroteBaseline,
    packageCount: analysis.packageCount,
    productionFileCount: analysis.productionFileCount,
    packageEdgeCount: analysis.packageEdgeCount,
    packageCycleCount: analysis.packageCycles.length,
    sourceCycleCount: analysis.sourceCycles.length,
    barrelImportCount: analysis.barrelImports.length,
    sameCycleBarrelImportCount: analysis.sameCycleBarrelImports.length,
    blockingFindings,
    packageCycles: analysis.packageCycles,
    sourceCycles: analysis.sourceCycles,
    barrelImports: analysis.barrelImports
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
      name: manifest.name,
      srcDir: path.join(packageDir, "src")
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

async function discoverProductionSourceFiles(srcDir) {
  if ((await exists(srcDir)) === false) {
    return [];
  }

  return (await listSourceFiles(srcDir)).sort();
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

    if (entry.isFile() && isProductionSourceFile(absolute)) {
      files.push(absolute);
    }
  }

  return files;
}

function extractImports(source) {
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

function resolveSourceImport({
  filePath,
  fileSet,
  specifier,
  workspacePackage
}) {
  if (specifier.startsWith(".")) {
    const resolved = resolveSourcePath(
      path.resolve(path.dirname(filePath), specifier),
      fileSet,
      workspacePackage.srcDir
    );
    return resolved;
  }

  if (
    specifier === workspacePackage.name ||
    specifier.startsWith(`${workspacePackage.name}/`)
  ) {
    const subpath =
      specifier === workspacePackage.name
        ? "index"
        : specifier.slice(workspacePackage.name.length + 1);

    return resolveSourcePath(
      path.join(workspacePackage.srcDir, subpath),
      fileSet,
      workspacePackage.srcDir
    );
  }

  return undefined;
}

function resolveSourcePath(basePath, fileSet, srcDir) {
  const candidates = [];

  if (SOURCE_EXTENSIONS.includes(path.extname(basePath))) {
    candidates.push(basePath);
  }

  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${basePath}${extension}`);
  }

  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(path.join(basePath, `index${extension}`));
  }

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);

    if (
      isInsideDirectory(normalized, srcDir) &&
      isProductionSourceFile(normalized) &&
      fileSet.has(normalized)
    ) {
      return normalized;
    }
  }

  return undefined;
}

function cyclesFromGraph(graph) {
  const components = stronglyConnectedComponents(graph);
  const cycles = [];

  for (const component of components) {
    if (component.length > 1) {
      cycles.push(component.sort());
      continue;
    }

    const node = component[0];

    if (graph.get(node)?.has(node)) {
      cycles.push(component);
    }
  }

  return cycles.sort(compareArrayRecords);
}

function stronglyConnectedComponents(graph) {
  const indexByNode = new Map();
  const lowlinkByNode = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;

  for (const node of [...graph.keys()].sort()) {
    if (indexByNode.has(node) === false) {
      strongConnect(node);
    }
  }

  return components;

  function strongConnect(node) {
    indexByNode.set(node, index);
    lowlinkByNode.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (indexByNode.has(next) === false) {
        strongConnect(next);
        lowlinkByNode.set(
          node,
          Math.min(lowlinkByNode.get(node), lowlinkByNode.get(next))
        );
      } else if (onStack.has(next)) {
        lowlinkByNode.set(
          node,
          Math.min(lowlinkByNode.get(node), indexByNode.get(next))
        );
      }
    }

    if (lowlinkByNode.get(node) === indexByNode.get(node)) {
      const component = [];
      let next;

      do {
        next = stack.pop();
        onStack.delete(next);
        component.push(next);
      } while (next !== node);

      components.push(component.sort());
    }
  }
}

function sourceCycleRecord({ cycle, packages, root, sourceGraph }) {
  const packageName =
    packages.find((workspacePackage) =>
      cycle.every((file) =>
        isSameOrUnder(file, slashPath(path.relative(root, workspacePackage.dir)))
      )
    )?.name ?? packageForFile(cycle[0], packages);
  const cycleSet = new Set(cycle);
  const barrelBackEdges = [];

  for (const from of cycle) {
    for (const to of sourceGraph.get(from) ?? []) {
      if (cycleSet.has(to) && isIndexPath(to)) {
        barrelBackEdges.push({ from, to });
      }
    }
  }

  return {
    package: packageName,
    files: cycle,
    includesIndex: cycle.some(isIndexPath),
    barrelBackEdges: sortRecords(barrelBackEdges)
  };
}

function packageForFile(file, packages) {
  return (
    packages.find((workspacePackage) =>
      isSameOrUnder(file, slashPath(path.relative(rootDir, workspacePackage.dir)))
    )?.name ?? "unknown"
  );
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

async function readExpectedBaseline(filePath) {
  const baseline = await readJson(filePath);

  if (baseline.version !== BASELINE_VERSION) {
    throw new Error(
      `${filePath} has unsupported source-cycle baseline version ${baseline.version}`
    );
  }

  return baseline;
}

function formatResult(result) {
  const lines = [];

  lines.push(
    result.blockingFindings.length === 0
      ? "Source cycle check passed."
      : "Source cycle check failed."
  );
  lines.push(`Baseline: ${result.baselinePath}`);
  lines.push(`Packages: ${result.packageCount}`);
  lines.push(`Production source files: ${result.productionFileCount}`);
  lines.push(`Package graph edges: ${result.packageEdgeCount}`);
  lines.push(`Package cycles: ${result.packageCycleCount}`);
  lines.push(`Source cycle baseline entries: ${result.sourceCycleCount}`);
  lines.push(`Barrel import baseline entries: ${result.barrelImportCount}`);
  lines.push(
    `Same-cycle barrel imports: ${result.sameCycleBarrelImportCount}`
  );

  if (result.wroteBaseline) {
    lines.push("Baseline written.");
  }

  if (result.blockingFindings.length > 0) {
    lines.push("");
    lines.push("Blocking findings:");

    for (const finding of result.blockingFindings) {
      lines.push(`- ${finding.code}: ${finding.message}`);

      if (Array.isArray(finding.cycle)) {
        for (const node of finding.cycle) {
          lines.push(`  - ${node}`);
        }
      }

      if (finding.expected !== undefined || finding.actual !== undefined) {
        lines.push(`  - expected: ${JSON.stringify(finding.expected)}`);
        lines.push(`  - actual: ${JSON.stringify(finding.actual)}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function canonicalComparable(baseline) {
  return canonicalJson({
    packageCycles: baseline.packageCycles ?? [],
    sourceCycles: baseline.sourceCycles ?? [],
    barrelImports: baseline.barrelImports ?? []
  });
}

function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}

function sortRecords(records) {
  return [...records].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function compareArrayRecords(left, right) {
  return left.join("\u0000").localeCompare(right.join("\u0000"));
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isProductionSourceFile(filePath) {
  const normalized = slashPath(filePath);
  const basename = path.posix.basename(normalized);

  if (filePath.endsWith(".d.ts")) {
    return false;
  }

  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(basename)) {
    return false;
  }

  if (normalized.split("/").some((part) => IGNORED_DIRS.has(part))) {
    return false;
  }

  return SOURCE_EXTENSIONS.includes(path.extname(filePath));
}

function isIndexFile(filePath) {
  return isIndexPath(slashPath(filePath));
}

function isIndexPath(filePath) {
  return /^index\.[cm]?[jt]sx?$/.test(path.posix.basename(filePath));
}

function isInsideDirectory(filePath, dir) {
  const relative = path.relative(dir, filePath);
  return relative.length > 0 && relative.startsWith("..") === false;
}

function isSameOrUnder(filePath, dirPath) {
  return filePath === dirPath || filePath.startsWith(`${dirPath}/`);
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
