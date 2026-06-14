import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");
const legacyStateDir = `.${"archetype"}`;
const canonicalStateDir = `.${"specwright"}`;

const expectedArchetypeFiles = [
  ".gitignore",
  "packages/adapters-cli/fixtures/output-contract/report-ok.json",
  "packages/adapters-cli/fixtures/output-contract/run-ok.json",
  "packages/adapters-cli/src/index.test.ts",
  "packages/adapters-cli/src/output-contract.test.ts",
  "packages/adapters-mcp/src/audit/writer.ts",
  "packages/adapters-mcp/src/index.test.ts",
  "packages/adapters-mcp/src/observability/correlation.ts",
  "packages/evidence-store/src/index.test.ts",
  "packages/operations/src/tenancy.test.ts",
  "packages/run-reports/src/index.test.ts",
  "packages/run-reports/src/retention.ts",
  "packages/run-store/fixtures/retention/fixture-retention-expired/read-mostly.json",
  "packages/run-store/fixtures/retention/fixture-retention-held/read-mostly.json",
  "packages/run-store/src/index.ts"
] as const;

const archetypeClassifications = [
  [".gitignore", "config_ignore_policy"],
  [
    "packages/adapters-cli/fixtures/output-contract/report-ok.json",
    "output_contract_fixture"
  ],
  [
    "packages/adapters-cli/fixtures/output-contract/run-ok.json",
    "output_contract_fixture"
  ],
  ["packages/adapters-cli/src/index.test.ts", "adapter_test_output_contract"],
  ["packages/adapters-cli/src/output-contract.test.ts", "output_contract_test"],
  ["packages/adapters-mcp/src/audit/writer.ts", "production_direct_path"],
  ["packages/adapters-mcp/src/index.test.ts", "adapter_test_output_contract"],
  [
    "packages/adapters-mcp/src/observability/correlation.ts",
    "production_direct_path"
  ],
  ["packages/evidence-store/src/index.test.ts", "store_test_path"],
  ["packages/operations/src/tenancy.test.ts", "tenancy_test_path"],
  ["packages/run-reports/src/index.test.ts", "report_test_path"],
  ["packages/run-reports/src/retention.ts", "production_direct_path"],
  [
    "packages/run-store/fixtures/retention/fixture-retention-expired/read-mostly.json",
    "retention_fixture"
  ],
  [
    "packages/run-store/fixtures/retention/fixture-retention-held/read-mostly.json",
    "retention_fixture"
  ],
  ["packages/run-store/src/index.ts", "runtime_default"]
] as const;

const expectedSpecwrightFiles = [
  "packages/adapters-mcp/test/packet06-test-helpers.ts",
  "packages/harness-loader/src/capability-grant.ts",
  "packages/harness-loader/src/index.test.ts",
  "packages/harness-loader/test/fixtures/grants/default-registry.json",
  "packages/harness-loader/test/fixtures/grants/malformed-grant-registry.json",
  "packages/harness-loader/test/fixtures/grants/over-grant-registry.json",
  "packages/harness-loader/test/fixtures/grants/runtime-invariant-registry.json",
  "packages/trace-recorder/src/index.test.ts"
] as const;

const specwrightClassifications = [
  ["packages/adapters-mcp/test/packet06-test-helpers.ts", "test_state_path"],
  ["packages/harness-loader/src/capability-grant.ts", "product_identifier"],
  ["packages/harness-loader/src/index.test.ts", "product_identifier"],
  [
    "packages/harness-loader/test/fixtures/grants/default-registry.json",
    "product_identifier"
  ],
  [
    "packages/harness-loader/test/fixtures/grants/malformed-grant-registry.json",
    "product_identifier"
  ],
  [
    "packages/harness-loader/test/fixtures/grants/over-grant-registry.json",
    "product_identifier"
  ],
  [
    "packages/harness-loader/test/fixtures/grants/runtime-invariant-registry.json",
    "product_identifier"
  ],
  ["packages/trace-recorder/src/index.test.ts", "product_identifier"]
] as const;

const directProductionArchetypeSites = [
  "packages/adapters-mcp/src/audit/writer.ts:163",
  "packages/adapters-mcp/src/audit/writer.ts:234",
  "packages/adapters-mcp/src/observability/correlation.ts:368",
  "packages/run-reports/src/retention.ts:1097",
  "packages/run-store/src/index.ts:56"
] as const;

const futureMigrationOwners = [
  ["canonical_specwright_layout", "FEAT-TASK-014.1/G-NAME-001"],
  ["migration_command", "FEAT-TASK-014.2/G-NAME-001"],
  ["compatibility_shims_warnings", "FEAT-TASK-014.3/G-NAME-001"],
  ["migration_tests", "FEAT-TASK-014.4/G-NAME-001"],
  ["migration_guide", "FEAT-TASK-014.5/G-DOCS-001"],
  ["product_naming_policy", "G-NAME-001"]
] as const;

describe("AUD-015A naming migration inventory", () => {
  test("current legacy state-dir references are inventoried and classified", async () => {
    const archetypeFiles = await trackedFilesContaining(legacyStateDir);

    expect(archetypeFiles).toEqual(expectedArchetypeFiles);
    expect(archetypeFiles.filter((file) => file !== ".gitignore")).toHaveLength(14);
    expect(archetypeClassifications.map(([file]) => file)).toEqual(archetypeFiles);
    expect(productionFiles(archetypeFiles)).toEqual([
      "packages/adapters-mcp/src/audit/writer.ts",
      "packages/adapters-mcp/src/observability/correlation.ts",
      "packages/run-reports/src/retention.ts",
      "packages/run-store/src/index.ts"
    ]);
    expect(await directLiteralSites(legacyStateDir)).toEqual(
      directProductionArchetypeSites
    );
    expect(await readFile(join(rootDir, "packages/run-store/src/index.ts"), "utf8"))
      .toContain(`export const RUN_STORE_DIR = "${legacyStateDir}";`);
  });

  test("current canonical-name rows are separated from runtime state migration", async () => {
    const specwrightFiles = await trackedFilesContaining(canonicalStateDir);

    expect(specwrightFiles).toEqual(expectedSpecwrightFiles);
    expect(specwrightClassifications.map(([file]) => file)).toEqual(
      specwrightFiles
    );
    expect(
      specwrightClassifications
        .filter(([, classification]) => classification === "test_state_path")
        .map(([file]) => file)
    ).toEqual(["packages/adapters-mcp/test/packet06-test-helpers.ts"]);
    expect(futureMigrationOwners.every(([, owner]) => owner.length > 0)).toBe(
      true
    );
  });
});

async function trackedFilesContaining(needle: string) {
  const matches = [];

  for (const file of trackedInventoryFiles()) {
    const text = await readFile(join(rootDir, file), "utf8");

    if (text.includes(needle)) {
      matches.push(file);
    }
  }

  return matches.sort((left, right) => left.localeCompare(right));
}

function trackedInventoryFiles() {
  const result = spawnSync("git", ["ls-files"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to list tracked files.");
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((file) => file.length > 0)
    .filter((file) => file.includes("/dist/") === false)
    .filter((file) => file.includes("/node_modules/") === false)
    .filter((file) => /^docs\/.*\.png$/.test(file) === false);
}

function productionFiles(files: readonly string[]) {
  return files
    .filter((file) => file.startsWith("packages/"))
    .filter((file) => file.includes("/src/"))
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => file.endsWith(".test.ts") === false)
    .filter((file) => file.includes("/fixtures/") === false)
    .sort((left, right) => left.localeCompare(right));
}

async function directLiteralSites(needle: string) {
  const sites = [];

  for (const file of productionFiles(await trackedFilesContaining(needle))) {
    const lines = (await readFile(join(rootDir, file), "utf8")).split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      if (line.includes(`"${needle}"`) || line.includes(`'${needle}'`)) {
        sites.push(`${file}:${index + 1}`);
      }
    }
  }

  return sites.sort((left, right) => left.localeCompare(right));
}
