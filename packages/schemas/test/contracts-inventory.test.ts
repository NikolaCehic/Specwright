import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const contractsPath = fileURLToPath(new URL("../CONTRACTS.md", import.meta.url));

const contractFamilies = new Set([
  "identity",
  "lifecycle",
  "event",
  "harness",
  "capability",
  "governance",
  "verification",
  "evidence",
  "artifact",
  "observability",
  "adapter",
  "compatibility"
]);

const allowedKinds = new Set(["const", "enum", "function", "schema", "type"]);
const allowedAccess = new Set(["public", "internal"]);

function exportedSymbols(source: string) {
  return Array.from(
    source.matchAll(
      /^export\s+(?:const|type|function)\s+([A-Za-z_$][\w$]*)/gm
    ),
    (match) => match[1] as string
  );
}

type InventoryRow = {
  name: string;
  kind: string;
  primaryFamily: string;
  access: string;
};

function inventoryRows(markdown: string): InventoryRow[] {
  const match = markdown.match(
    /<!-- contracts-inventory:start -->([\s\S]*?)<!-- contracts-inventory:end -->/
  );

  if (match === null) {
    throw new Error("CONTRACTS.md is missing contracts inventory markers");
  }

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const name = cells[0]?.match(/^`([^`]+)`$/)?.[1];

      if (name === undefined) {
        throw new Error(`Inventory row is missing an export name: ${line}`);
      }

      return {
        name,
        kind: cells[1] ?? "",
        primaryFamily: cells[2] ?? "",
        access: cells[4] ?? ""
      };
    });
}

function duplicates(values: readonly string[]) {
  const seen = new Set<string>();
  const repeated = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }

    seen.add(value);
  }

  return [...repeated].sort();
}

describe("contracts inventory", () => {
  test("catalogues every exported schema symbol exactly once", () => {
    const exported = exportedSymbols(readFileSync(sourcePath, "utf8")).sort();
    const catalogued = inventoryRows(readFileSync(contractsPath, "utf8"))
      .map((row) => row.name)
      .sort();

    expect(duplicates(catalogued)).toEqual([]);
    expect(catalogued).toEqual(exported);
  });

  test("assigns each catalogued export to a valid primary family and access level", () => {
    const rows = inventoryRows(readFileSync(contractsPath, "utf8"));

    for (const row of rows) {
      expect(allowedKinds.has(row.kind), `${row.name} kind`).toBe(true);
      expect(
        contractFamilies.has(row.primaryFamily),
        `${row.name} primary family`
      ).toBe(true);
      expect(allowedAccess.has(row.access), `${row.name} access`).toBe(true);
    }
  });
});
