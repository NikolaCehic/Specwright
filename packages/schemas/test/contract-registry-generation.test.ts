import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCompatibilityReport,
  type HashManifestEntry
} from "../src/compatibility";
import {
  canonicalHashInput,
  canonicalSchemaHash,
  canonicalStringify
} from "../src/canonical-hash";
import {
  RuntimeEventSchema,
  EVENT_PAYLOAD_SCHEMAS,
  KNOWN_RUNTIME_EVENT_TYPES,
  RunInputSchema
} from "../src/index";
import {
  contractRegistry,
  lookupContract,
  type ContractRegistryRecord
} from "../src/registry";
import { contractHashManifest } from "../src/hashes";
import { contractFixtures } from "../src/fixtures";
import { GeneratedRuntimeEventSchema, generatedRuntimeEventTypes } from "../src/event-union";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("generated contract registry", () => {
  test("lists every public validator-backed contract from CONTRACTS.md", () => {
    const inventoryContracts = inventorySchemaExports();
    const registryExports = contractRegistry
      .filter((record) => record.status === "public")
      .map((record) => record.exportName)
      .sort();

    expect(registryExports).toEqual(inventoryContracts);
    expect(contractRegistry.every((record) => record.status === "public")).toBe(
      true
    );
  });

  test("looks up validators by known id and version and fails closed otherwise", () => {
    const lookup = lookupContract("specwright.lifecycle.run-input", "1");

    expect(lookup?.record.exportName).toBe("RunInputSchema");
    expect(
      lookup?.validator.safeParse({
        task: "Registry lookup succeeds.",
        harnessId: "default",
        host: {
          kind: "cli"
        }
      }).success
    ).toBe(true);
    expect(lookupContract("specwright.lifecycle.run-input", "2")).toBeUndefined();
    expect(lookupContract("specwright.unknown.contract", "1")).toBeUndefined();
  });

  test("validates generated positive, negative, and replay fixtures", () => {
    for (const fixture of contractFixtures) {
      const lookup = lookupContract(fixture.id, "1");

      expect(lookup, fixture.id).toBeDefined();

      if (lookup === undefined) {
        continue;
      }

      const positive = readJson(join(packageRoot, fixture.positive));
      const negative = readJson(join(packageRoot, fixture.negative));

      expect(lookup.validator.safeParse(positive).success, fixture.positive).toBe(
        true
      );
      expect(lookup.validator.safeParse(negative).success, fixture.negative).toBe(
        false
      );

      if ("replay" in fixture && fixture.replay !== undefined) {
        const replay = readJson(join(packageRoot, fixture.replay));

        expect(lookup.validator.safeParse(replay).success, fixture.replay).toBe(
          true
        );
      }
    }
  });

  test("event union covers every registered runtime event type and rejects unknown events", () => {
    const registeredEvents = contractRegistry
      .filter((record) => record.exportName.endsWith("EventPayloadSchema"))
      .map((record) => record.id.replace("specwright.event.", ""))
      .sort();

    expect(generatedRuntimeEventTypes).toEqual(registeredEvents);
    expect(generatedRuntimeEventTypes).toEqual(KNOWN_RUNTIME_EVENT_TYPES);
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual(registeredEvents);
    expect(GeneratedRuntimeEventSchema).toBe(RuntimeEventSchema);
    expect(
      GeneratedRuntimeEventSchema.safeParse({
        id: "event:unknown",
        runId: "run:unknown",
        timestamp: "2026-06-05T00:00:00.000Z",
        sequence: 0,
        traceId: "trace:unknown",
        type: "event.unregistered",
        payload: {}
      }).success
    ).toBe(false);
  });

  test("canonical hashes are stable and exclude non-semantic location data", () => {
    const baseInput = {
      id: "specwright.lifecycle.run-input",
      version: "1",
      schema: RunInputSchema,
      extensionPoints: ["metadata", "constraints"],
      authoritySemantics: "Runtime run ingress contract.",
      redaction: {
        defaultClass: "operator",
        fields: []
      },
      compatibility: {
        class: "forward-compatible" as const,
        durability: "durable"
      }
    };
    const first = canonicalSchemaHash(baseInput);
    const second = canonicalSchemaHash({
      ...baseInput,
      extensionPoints: [...baseInput.extensionPoints].reverse()
    });
    const canonical = canonicalStringify({
      ...canonicalHashInput(baseInput),
      filePath: "/tmp/ignored.ts",
      generatedAt: "2026-06-05T00:00:00.000Z"
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonical).toContain("filePath");
    expect(canonicalHashInput(baseInput)).not.toHaveProperty("filePath");
  });

  test("compatibility report flags unsupported migration-required changes", () => {
    const currentRegistry = readJson<ContractRegistryRecord[]>(
      join(packageRoot, "contracts", "registry.json")
    );
    const currentManifest = readJson<HashManifestEntry[]>(
      join(packageRoot, "contracts", "hash-manifest.json")
    );
    const changedManifest = currentManifest.map((entry) =>
      entry.id === "specwright.lifecycle.run-input"
        ? {
            ...entry,
            hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
          }
        : entry
    );
    const report = buildCompatibilityReport({
      registryVersion: "test",
      baselineRegistry: currentRegistry,
      currentRegistry,
      baselineManifest: changedManifest,
      currentManifest
    });
    const changed = report.entries.find(
      (entry) => entry.id === "specwright.lifecycle.run-input"
    );

    expect(changed?.classification).toBe("migration-required");
    expect(changed?.unsupportedWithoutMigration).toBe(true);
    expect(report.releasePolicy.migrationRequirements).toContain(
      "specwright.lifecycle.run-input"
    );
  });

  test("checked-in generated artifacts are idempotent after regeneration", async () => {
    const before = snapshotGeneratedArtifacts();
    const proc = Bun.spawn(["bun", "packages/schemas/scripts/generate.ts"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe"
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(snapshotGeneratedArtifacts()).toEqual(before);
  });
});

function snapshotGeneratedArtifacts() {
  const roots = [
    join(packageRoot, "contracts"),
    join(packageRoot, "fixtures"),
    join(packageRoot, "src", "generated")
  ];

  return Object.fromEntries(
    roots
      .flatMap((root) => readFilesRecursively(root))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function readFilesRecursively(directory: string): [string, string][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return readFilesRecursively(path);
    }

    if (!entry.isFile()) {
      return [];
    }

    return [
      [
        relative(packageRoot, path).split(sep).join("/"),
        readFileSync(path, "utf8")
      ]
    ];
  });
}

function inventorySchemaExports() {
  const markdown = readFileSync(join(packageRoot, "CONTRACTS.md"), "utf8");
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
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    )
    .filter((cells) => cells[1] !== "function")
    .map((cells) => cells[0]?.match(/^`([^`]+)`$/)?.[1])
    .filter((name): name is string => name !== undefined)
    .filter((name) => name.endsWith("Schema"))
    .sort();
}

function readJson<TValue = unknown>(path: string): TValue {
  return JSON.parse(readFileSync(path, "utf8")) as TValue;
}

test("generated JSON Schema docs exist for every registry record", () => {
  const jsonSchemaFiles = new Set(
    readdirSync(join(packageRoot, "contracts", "json-schema"))
  );

  for (const record of contractRegistry) {
    expect(jsonSchemaFiles.has(`${record.id}.json`), record.id).toBe(true);
  }

  expect(contractHashManifest).toHaveLength(contractRegistry.length);
});
