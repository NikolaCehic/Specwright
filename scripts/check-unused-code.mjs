#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BASELINE_VERSION = 1;
const DEFAULT_BASELINE = "scripts/unused-code-baseline.json";
const UNUSED_ARGS = [
  "--noEmit",
  "--pretty",
  "false",
  "--noUnusedLocals",
  "--noUnusedParameters"
];

const rootDir = path.resolve(argumentValue("--root") ?? process.cwd());
const baselinePath = path.resolve(
  rootDir,
  argumentValue("--baseline") ?? DEFAULT_BASELINE
);
const tscPath = path.resolve(
  argumentValue("--tsc") ?? path.join(rootDir, "node_modules/.bin/tsc")
);
const writeBaseline = process.argv.includes("--write-baseline");
const jsonOutput = process.argv.includes("--json");

const packages = await discoverWorkspacePackages(rootDir);
const diagnostics = runUnusedCheck({
  rootDir,
  packages,
  tscPath
});
const actualBaseline = baselineFromDiagnostics(diagnostics);

if (writeBaseline) {
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, canonicalJson(actualBaseline), "utf8");
}

const expectedBaseline = writeBaseline
  ? actualBaseline
  : await readExpectedBaseline(baselinePath);
const result = evaluateBaseline({
  actualBaseline,
  baselinePath,
  diagnostics,
  expectedBaseline,
  wroteBaseline: writeBaseline
});

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(formatResult(result));
}

process.exitCode = result.blockingFindings.length === 0 ? 0 : 1;

function runUnusedCheck({ rootDir, packages, tscPath }) {
  const result = spawnSync(tscPath, UNUSED_ARGS, {
    cwd: rootDir,
    encoding: "utf8"
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const diagnostics = parseDiagnostics(output, rootDir, packages);

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0 && diagnostics.length === 0) {
    throw new Error(
      `TypeScript unused check exited ${result.status} without parseable diagnostics:\n${output}`
    );
  }

  return diagnostics;
}

function parseDiagnostics(output, rootDir, packages) {
  const diagnostics = [];
  const pattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const match = pattern.exec(trimmed);

    if (match === null) {
      diagnostics.push({
        file: "<unparsed>",
        line: 0,
        column: 0,
        code: "UNPARSED",
        message: trimmed,
        package: "<unknown>"
      });
      continue;
    }

    const [, file, lineNumber, columnNumber, code, message] = match;
    const absolutePath = path.resolve(rootDir, file);
    const relativePath = slashPath(path.relative(rootDir, absolutePath));

    diagnostics.push({
      file: relativePath,
      line: Number(lineNumber),
      column: Number(columnNumber),
      code,
      message,
      package: packageForFile(relativePath, packages)
    });
  }

  return diagnostics.sort(compareDiagnostics);
}

function baselineFromDiagnostics(diagnostics) {
  const codeCounts = countBy(diagnostics, (diagnostic) => diagnostic.code);
  const fileCounts = countBy(diagnostics, (diagnostic) => diagnostic.file);
  const packageCounts = countBy(diagnostics, (diagnostic) => diagnostic.package);

  return {
    version: BASELINE_VERSION,
    command: `tsc ${UNUSED_ARGS.join(" ")}`,
    policy: {
      diagnostics: "baseline",
      ci: "deferred",
      cleanup: "deferred"
    },
    inventory: {
      diagnosticCount: diagnostics.length,
      fileCount: Object.keys(fileCounts).length,
      packageCount: Object.keys(packageCounts).length,
      codeCounts,
      packageCounts
    },
    diagnostics
  };
}

function evaluateBaseline({
  actualBaseline,
  baselinePath,
  diagnostics,
  expectedBaseline,
  wroteBaseline
}) {
  const blockingFindings = [];
  const expectedDiagnostics = expectedBaseline.diagnostics ?? [];

  if (
    wroteBaseline === false &&
    canonicalJson(actualBaseline.diagnostics) !==
      canonicalJson(expectedDiagnostics)
  ) {
    blockingFindings.push({
      code: "unused_code_baseline_drift",
      message:
        "Current TypeScript unused diagnostics differ from the checked-in baseline.",
      expected: summarizeDiagnostics(expectedDiagnostics),
      actual: summarizeDiagnostics(actualBaseline.diagnostics),
      added: differenceDiagnostics(actualBaseline.diagnostics, expectedDiagnostics),
      removed: differenceDiagnostics(expectedDiagnostics, actualBaseline.diagnostics)
    });
  }

  return {
    baselinePath: slashPath(baselinePath),
    wroteBaseline,
    diagnosticCount: diagnostics.length,
    fileCount: actualBaseline.inventory.fileCount,
    packageCount: actualBaseline.inventory.packageCount,
    codeCounts: actualBaseline.inventory.codeCounts,
    packageCounts: actualBaseline.inventory.packageCounts,
    blockingFindings
  };
}

async function discoverWorkspacePackages(root) {
  const rootManifest = await readJson(path.join(root, "package.json"));
  const workspacePatterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages;

  if (!Array.isArray(workspacePatterns)) {
    return [];
  }

  const packages = [];

  for (const pattern of workspacePatterns) {
    if (typeof pattern !== "string") {
      continue;
    }

    for (const packageDir of await expandWorkspacePattern(root, pattern)) {
      const manifestPath = path.join(packageDir, "package.json");

      if ((await exists(manifestPath)) === false) {
        continue;
      }

      const manifest = await readJson(manifestPath);

      if (typeof manifest.name === "string") {
        packages.push({
          dir: slashPath(path.relative(root, packageDir)),
          name: manifest.name
        });
      }
    }
  }

  return packages.sort((left, right) => left.dir.localeCompare(right.dir));
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

async function readExpectedBaseline(filePath) {
  const baseline = await readJson(filePath);

  if (baseline.version !== BASELINE_VERSION) {
    throw new Error(
      `${filePath} has unsupported unused-code baseline version ${baseline.version}`
    );
  }

  return baseline;
}

function formatResult(result) {
  const lines = [];

  lines.push(
    result.blockingFindings.length === 0
      ? "Unused code check passed."
      : "Unused code check failed."
  );
  lines.push(`Baseline: ${result.baselinePath}`);
  lines.push(`Diagnostics: ${result.diagnosticCount}`);
  lines.push(`Files with diagnostics: ${result.fileCount}`);
  lines.push(`Packages with diagnostics: ${result.packageCount}`);
  lines.push(`Codes: ${formatCounts(result.codeCounts)}`);

  if (Object.keys(result.packageCounts).length > 0) {
    lines.push("Packages:");

    for (const [packageName, count] of Object.entries(result.packageCounts)) {
      lines.push(`- ${packageName}: ${count}`);
    }
  }

  if (result.wroteBaseline) {
    lines.push("Baseline written.");
  }

  if (result.blockingFindings.length > 0) {
    lines.push("");
    lines.push("Blocking findings:");

    for (const finding of result.blockingFindings) {
      lines.push(`- ${finding.code}: ${finding.message}`);
      lines.push(`  - expected: ${JSON.stringify(finding.expected)}`);
      lines.push(`  - actual: ${JSON.stringify(finding.actual)}`);

      if (finding.added.length > 0) {
        lines.push("  - added diagnostics:");
        lines.push(...formatDiagnosticList(finding.added, "    "));
      }

      if (finding.removed.length > 0) {
        lines.push("  - removed diagnostics:");
        lines.push(...formatDiagnosticList(finding.removed, "    "));
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatCounts(counts) {
  const entries = Object.entries(counts);

  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatDiagnosticList(diagnostics, indent) {
  return diagnostics
    .slice(0, 10)
    .map(
      (diagnostic) =>
        `${indent}- ${diagnostic.file}(${diagnostic.line},${diagnostic.column}) ${diagnostic.code}: ${diagnostic.message}`
    );
}

function summarizeDiagnostics(diagnostics) {
  const codeCounts = countBy(diagnostics, (diagnostic) => diagnostic.code);
  const fileCounts = countBy(diagnostics, (diagnostic) => diagnostic.file);
  const packageCounts = countBy(diagnostics, (diagnostic) => diagnostic.package);

  return {
    diagnosticCount: diagnostics.length,
    fileCount: Object.keys(fileCounts).length,
    packageCount: Object.keys(packageCounts).length,
    codeCounts,
    packageCounts
  };
}

function differenceDiagnostics(left, right) {
  const rightSet = new Set(right.map(diagnosticKey));
  return left.filter((diagnostic) => rightSet.has(diagnosticKey(diagnostic)) === false);
}

function diagnosticKey(diagnostic) {
  return JSON.stringify(diagnostic);
}

function compareDiagnostics(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function countBy(items, keyForItem) {
  const counts = {};

  for (const item of items) {
    const key = keyForItem(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function packageForFile(file, packages) {
  return (
    packages.find((workspacePackage) =>
      file === workspacePackage.dir ||
      file.startsWith(`${workspacePackage.dir}/`)
    )?.name ?? "<root>"
  );
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
