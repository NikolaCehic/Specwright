import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import {
  canonicalHashInput,
  canonicalSchemaHash,
  canonicalStringify,
  describeZodSchema,
  sortValue
} from "../src/canonical-hash";
import { buildCompatibilityReport } from "../src/compatibility";
import type { HashManifestEntry } from "../src/compatibility";
import { ContractRegistryRecordSchema } from "../src/contract-registry";
import type {
  ContractCompatibilityClass,
  ContractDurability,
  ContractFamily,
  ContractRegistryRecord
} from "../src/contract-registry";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const contractsPath = join(packageRoot, "CONTRACTS.md");
const generatedRoot = join(packageRoot, "src", "generated");
const contractsRoot = join(packageRoot, "contracts");
const fixturesRoot = join(packageRoot, "fixtures");
const registryVersion = "scope-01.packet-05";

type InventoryRow = {
  exportName: string;
  kind: string;
  primaryFamily: ContractFamily;
  secondaryFamily: ContractFamily | "none";
  status: "public" | "internal";
  owner: string;
  durability: ContractDurability;
  extensionPoints: string[];
  notes: string;
};

type RegisteredDefinition = InventoryRow & {
  id: string;
  version: string;
  schema: ZodTypeAny;
  compatibilityClass: ContractCompatibilityClass;
  redaction: {
    defaultClass: "model" | "adapter" | "operator" | "audit" | "restricted" | "secret";
    fields: {
      path: string;
      class: "model" | "adapter" | "operator" | "audit" | "restricted" | "secret";
    }[];
  };
  authority: {
    semantics: string;
    ownerReviewGroup: string;
  };
};

const schemaExports = await import(
  String(new URL("../src/index.ts", import.meta.url))
);

const inventory = parseInventory(readFileSync(contractsPath, "utf8"));
const registered = inventory
  .filter((row) => row.exportName.endsWith("Schema"))
  .filter((row) => row.kind !== "function")
  .map((row) => registeredDefinition(row))
  .sort((left, right) => left.id.localeCompare(right.id));

const registry = registered.map((definition) =>
  registryRecordForDefinition(definition)
);
const manifest = registry.map((record) => ({
  id: record.id,
  version: record.version,
  exportName: record.exportName,
  hash: record.canonicalHash,
  compatibilityClass: record.compatibilityClass
})) satisfies HashManifestEntry[];

function writeGeneratedArtifacts() {
  for (const definition of registered) {
    writeJson(
      join(contractsRoot, "json-schema", `${definition.id}.json`),
      jsonSchemaDocument(definition)
    );
  }

  writeJson(join(contractsRoot, "registry.json"), registry);
  writeJson(join(contractsRoot, "hash-manifest.json"), manifest);
  writeJson(join(contractsRoot, "migrations", "descriptors.json"), []);

  const baselineRegistryPath = join(contractsRoot, "baseline", "registry.json");
  const baselineManifestPath = join(
    contractsRoot,
    "baseline",
    "hash-manifest.json"
  );

  if (!existsSync(baselineRegistryPath)) {
    writeJson(baselineRegistryPath, registry);
  }

  if (!existsSync(baselineManifestPath)) {
    writeJson(baselineManifestPath, manifest);
  }

  const baselineRegistry = readJsonArray<ContractRegistryRecord>(
    baselineRegistryPath
  );
  const baselineManifest = readJsonArray<HashManifestEntry>(
    baselineManifestPath
  );
  const report = buildCompatibilityReport({
    registryVersion,
    baselineRegistry,
    currentRegistry: registry,
    baselineManifest,
    currentManifest: manifest
  });

  writeJson(join(contractsRoot, "compatibility-report.json"), report);
  writeJson(join(fixturesRoot, "migrations", "migration-required-change.json"), {
    baseline: {
      id: "specwright.lifecycle.run-input",
      version: "1",
      hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    current: {
      id: "specwright.lifecycle.run-input",
      version: "1",
      hash: manifest.find((entry) => entry.id === "specwright.lifecycle.run-input")
        ?.hash
    },
    expectedClassification: "migration-required"
  });

  writeFixtures();
  writeTypeScriptFiles();
}

function writeTypeScriptFiles() {
  mkdirSync(generatedRoot, { recursive: true });
  writeFileSync(
    join(generatedRoot, "event-hashes.ts"),
    `${generatedHeader()}export const RUNTIME_EVENT_SCHEMA_HASHES = ${tsLiteral(
      eventHashes()
    )} as const;\n`,
    "utf8"
  );
  writeFileSync(join(generatedRoot, "registry.ts"), registryModule(), "utf8");
  writeFileSync(join(generatedRoot, "validators.ts"), validatorsModule(), "utf8");
  writeFileSync(join(generatedRoot, "types.ts"), typesModule(), "utf8");
  writeFileSync(join(generatedRoot, "hashes.ts"), hashesModule(), "utf8");
  writeFileSync(join(generatedRoot, "fixtures.ts"), fixturesModule(), "utf8");
  writeFileSync(
    join(generatedRoot, "event-union.ts"),
    eventUnionModule(),
    "utf8"
  );
  writeFileSync(
    join(generatedRoot, "migrations.ts"),
    `${generatedHeader()}export const migrationDescriptors = [] as const;\n`,
    "utf8"
  );
  writeFileSync(
    join(generatedRoot, "redaction.ts"),
    `${generatedHeader()}import { contractRegistry } from "./registry";\n\nexport const redactionMetadata = Object.fromEntries(\n  contractRegistry.map((record) => [record.id, record.redaction])\n) as Record<string, (typeof contractRegistry)[number]["redaction"]>;\n`,
    "utf8"
  );
}

function registryModule() {
  const imports = registered.map((definition) => definition.exportName).sort();

  return `${generatedHeader()}import type { ZodTypeAny } from "zod";
import {
  ContractRegistryRecordSchema,
  contractRegistryKey,
  type ContractLookupResult
} from "../contract-registry";
import {
  ${imports.join(",\n  ")}
} from "../index";

const contractRegistryData = ${tsLiteral(registry)} as const;

export const contractRegistry = contractRegistryData.map((record) =>
  ContractRegistryRecordSchema.parse(record)
);

const validators = new Map<string, ZodTypeAny>([
${registered
  .map(
    (definition) =>
      `  [contractRegistryKey(${JSON.stringify(definition.id)}, ${JSON.stringify(
        definition.version
      )}), ${definition.exportName}],`
  )
  .join("\n")}
]);

const records = new Map(
  contractRegistry.map((record) => [
    contractRegistryKey(record.id, record.version),
    record
  ])
);

export function lookupContract(
  contractId: string,
  version: string
): ContractLookupResult | undefined {
  const key = contractRegistryKey(contractId, version);
  const record = records.get(key);
  const validator = validators.get(key);

  if (record === undefined || validator === undefined) {
    return undefined;
  }

  return { record, validator };
}
`;
}

function validatorsModule() {
  const imports = registered.map((definition) => definition.exportName).sort();

  return `${generatedHeader()}import type { ZodTypeAny } from "zod";
import {
  ${imports.join(",\n  ")}
} from "../index";
import { lookupContract } from "./registry";

export const validators = {
${registered
  .map((definition) => `  ${JSON.stringify(definition.id)}: ${definition.exportName}`)
  .join(",\n")}
} satisfies Record<string, ZodTypeAny>;

export function validatorForContract(contractId: string, version = "1") {
  return lookupContract(contractId, version)?.validator;
}
`;
}

function typesModule() {
  const imports = registered.map((definition) => definition.exportName).sort();

  return `${generatedHeader()}import type { z } from "zod";
import {
  ${imports.join(",\n  ")}
} from "../index";

export type ContractTypeById = {
${registered
  .map(
    (definition) =>
      `  ${JSON.stringify(definition.id)}: z.infer<typeof ${definition.exportName}>;`
  )
  .join("\n")}
};

export type PublicContractId = keyof ContractTypeById;
export type PublicContract = ContractTypeById[PublicContractId];
export type * from "../index";
`;
}

function hashesModule() {
  return `${generatedHeader()}export const contractHashManifest = ${tsLiteral(
    manifest
  )} as const;

export const contractHashes = Object.fromEntries(
  contractHashManifest.map((entry) => [entry.id, entry.hash])
) as Record<string, (typeof contractHashManifest)[number]["hash"]>;
`;
}

function fixturesModule() {
  const fixtureIndex = registered.map((definition) => ({
    id: definition.id,
    positive: `fixtures/conformance/${kebabCase(definition.exportName)}.positive.json`,
    negative: `fixtures/negative/${kebabCase(definition.exportName)}.negative.json`,
    replay: replayFixturePath(definition)
  }));

  return `${generatedHeader()}export const contractFixtures = ${tsLiteral(
    fixtureIndex
  )} as const;\n`;
}

function eventUnionModule() {
  return `${generatedHeader()}import {
  RuntimeEventSchema,
  EVENT_PAYLOAD_SCHEMAS,
  KNOWN_RUNTIME_EVENT_TYPES
} from "../index";

export const GeneratedRuntimeEventSchema = RuntimeEventSchema;
export const generatedEventPayloadSchemas = EVENT_PAYLOAD_SCHEMAS;
export const generatedRuntimeEventTypes = KNOWN_RUNTIME_EVENT_TYPES;
export type { RuntimeEventContract, RuntimeEventPayloadByType, RuntimeEventType } from "../index";
`;
}

function writeFixtures() {
  for (const definition of registered) {
    const positive = positiveFixtureFor(definition);
    const negative = negativeFixtureFor(definition, positive);

    assertFixture(definition, positive, true);
    assertFixture(definition, negative, false);
    writeJson(
      join(
        fixturesRoot,
        "conformance",
        `${kebabCase(definition.exportName)}.positive.json`
      ),
      positive
    );
    writeJson(
      join(
        fixturesRoot,
        "negative",
        `${kebabCase(definition.exportName)}.negative.json`
      ),
      negative
    );

    const replayPath = replayFixturePath(definition);

    if (replayPath !== undefined) {
      writeJson(join(packageRoot, replayPath), positive);
    }
  }
}

function registeredDefinition(row: InventoryRow): RegisteredDefinition {
  const schema = exportedSchema(row.exportName);

  return {
    ...row,
    id: contractIdFor(row),
    version: "1",
    schema,
    compatibilityClass:
      row.durability === "durable" ? "forward-compatible" : "patch-compatible",
    redaction: redactionFor(row),
    authority: {
      semantics: `${row.notes} Durable posture: ${row.durability}. Extension posture: ${row.extensionPoints.join(", ")}.`,
      ownerReviewGroup: reviewGroupFor(row.owner)
    }
  };
}

function registryRecordForDefinition(
  definition: RegisteredDefinition
): ContractRegistryRecord {
  const fixtureBase = kebabCase(definition.exportName);
  const jsonSchemaPath = `contracts/json-schema/${definition.id}.json`;
  const hash = canonicalSchemaHash({
    id: definition.id,
    version: definition.version,
    schema: definition.schema,
    extensionPoints: definition.extensionPoints,
    authoritySemantics: definition.authority.semantics,
    redaction: definition.redaction,
    compatibility: {
      class: definition.compatibilityClass,
      durability: definition.durability
    }
  });
  const record = {
    id: definition.id,
    exportName: definition.exportName,
    family: definition.primaryFamily,
    secondaryFamily: definition.secondaryFamily,
    owner: definition.owner,
    version: definition.version,
    schemaFormat: "zod",
    canonicalHash: hash,
    compatibilityClass: definition.compatibilityClass,
    status: definition.status,
    durability: definition.durability,
    redaction: definition.redaction,
    authority: definition.authority,
    extensionPoints: definition.extensionPoints,
    migrationDescriptors: [],
    generatedArtifacts: {
      validator: "src/generated/validators.ts",
      type: "src/generated/types.ts",
      jsonSchema: jsonSchemaPath,
      fixture: `fixtures/conformance/${fixtureBase}.positive.json`,
      negativeFixture: `fixtures/negative/${fixtureBase}.negative.json`,
      replayFixture: replayFixturePath(definition)
    },
    conformanceFixtures: [
      `fixtures/conformance/${fixtureBase}.positive.json`,
      `fixtures/negative/${fixtureBase}.negative.json`
    ],
    notes: definition.notes
  };

  return ContractRegistryRecordSchema.parse(record);
}

function parseInventory(markdown: string): InventoryRow[] {
  const match = markdown.match(
    /<!-- contracts-inventory:start -->([\s\S]*?)<!-- contracts-inventory:end -->/
  );

  if (match === null) {
    throw new Error("CONTRACTS.md is missing contracts inventory markers");
  }

  const inventoryBlock = match[1];

  if (inventoryBlock === undefined) {
    throw new Error("CONTRACTS.md inventory block is empty");
  }

  return inventoryBlock
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const exportName = cells[0]?.match(/^`([^`]+)`$/)?.[1];

      if (exportName === undefined) {
        throw new Error(`Inventory row is missing an export name: ${line}`);
      }

      return {
        exportName,
        kind: requireCell(cells, 1, exportName),
        primaryFamily: parseFamily(requireCell(cells, 2, exportName)),
        secondaryFamily: parseSecondaryFamily(requireCell(cells, 3, exportName)),
        status: parseStatus(requireCell(cells, 4, exportName)),
        owner: requireCell(cells, 5, exportName),
        durability: parseDurability(requireCell(cells, 6, exportName)),
        extensionPoints: parseExtensionPoints(requireCell(cells, 7, exportName)),
        notes: requireCell(cells, 8, exportName)
      };
    });
}

function exportedSchema(name: string): ZodTypeAny {
  const value = Object.fromEntries(Object.entries(schemaExports))[name];

  if (!(value instanceof z.ZodType)) {
    throw new Error(`${name} is not an exported Zod schema`);
  }

  return value;
}

function contractIdFor(row: InventoryRow) {
  const eventType = eventTypeForPayloadSchema(row.exportName);

  if (eventType !== undefined) {
    return `specwright.event.${eventType}`;
  }

  if (row.exportName === "RuntimeEventSchema") {
    return "specwright.event.runtime-event";
  }

  if (row.exportName === "RuntimeEventEnvelopeSchema") {
    return "specwright.event.runtime-event-envelope";
  }

  return `specwright.${row.primaryFamily}.${kebabCase(
    row.exportName.replace(/Schema$/, "")
  )}`;
}

function eventTypeForPayloadSchema(exportName: string) {
  const match = exportName.match(/^(.+)EventPayloadSchema$/);

  if (match === null) {
    return undefined;
  }

  return camelEventNameToRuntimeType(match[1] ?? "");
}

function camelEventNameToRuntimeType(name: string) {
  const special: Record<string, string> = {
    RunStarted: "run.started",
    HarnessLoaded: "harness.loaded",
    PhaseEntered: "phase.entered",
    PhaseTransitioned: "phase.transitioned",
    EvidenceRecorded: "evidence.recorded",
    ArtifactRecorded: "artifact.recorded",
    ToolRequested: "tool.requested",
    ToolCompleted: "tool.completed",
    ToolAuthorized: "tool.authorized",
    ToolDenied: "tool.denied",
    GateEvaluated: "gate.evaluated",
    EvalCompleted: "eval.completed",
    RunCompleted: "run.completed",
    RunFailed: "run.failed",
    PolicyEvaluated: "policy.evaluated",
    DecisionRecorded: "decision.recorded",
    HumanInputRequested: "human.input_requested",
    HumanAnswerRecorded: "human.answer_recorded"
  };

  return special[name];
}

function redactionFor(row: InventoryRow): RegisteredDefinition["redaction"] {
  const fields = [];

  if (/redaction/i.test(row.notes) || /redaction/i.test(row.exportName)) {
    fields.push({ path: "redactionPolicy", class: "operator" as const });
    fields.push({ path: "redactionClass", class: "operator" as const });
  }

  return {
    defaultClass: row.primaryFamily === "adapter" ? "adapter" : "operator",
    fields
  };
}

function reviewGroupFor(owner: string) {
  if (/adapter|CLI|MCP/i.test(owner)) {
    return "adapter-contract-review";
  }

  if (/Policy|approval|governance/i.test(owner)) {
    return "governance-contract-review";
  }

  if (/Evidence|Artifact/i.test(owner)) {
    return "audit-contract-review";
  }

  return "shared-schema-contract-review";
}

function positiveFixtureFor(definition: RegisteredDefinition): unknown {
  const override = positiveOverrides[definition.exportName];

  if (override !== undefined) {
    return override;
  }

  return sampleForSchema(definition.schema);
}

function negativeFixtureFor(
  definition: RegisteredDefinition,
  positive: unknown
): unknown {
  const override = negativeOverrides[definition.exportName];

  if (override !== undefined) {
    return override;
  }

  return invalidSampleForSchema(definition.schema, positive);
}

function sampleForSchema(schema: ZodTypeAny): unknown {
  if (schema instanceof z.ZodString) {
    return "fixture";
  }

  if (schema instanceof z.ZodNumber) {
    return 1;
  }

  if (schema instanceof z.ZodBoolean) {
    return true;
  }

  if (schema instanceof z.ZodUnknown) {
    return { fixture: true };
  }

  if (schema instanceof z.ZodLiteral) {
    return schema._def.value;
  }

  if (schema instanceof z.ZodEnum) {
    return schema._def.values[0];
  }

  if (schema instanceof z.ZodArray) {
    return [sampleForSchema(schema.element)];
  }

  if (schema instanceof z.ZodRecord) {
    return {};
  }

  if (schema instanceof z.ZodUnion) {
    const option = schema._def.options[0] as ZodTypeAny | undefined;

    if (option === undefined) {
      throw new Error("Zod union has no options");
    }

    return sampleForSchema(option);
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const option = schema.options[0];

    if (option === undefined) {
      throw new Error("Zod discriminated union has no options");
    }

    return sampleForSchema(option);
  }

  if (schema instanceof z.ZodObject) {
    const value: Record<string, unknown> = {};
    const shape = schema.shape as Record<string, ZodTypeAny>;

    for (const [key, fieldSchema] of Object.entries(shape).sort()) {
      if (fieldSchema instanceof z.ZodOptional || fieldSchema instanceof z.ZodDefault) {
        continue;
      }

      value[key] = sampleForSchema(fieldSchema);
    }

    return value;
  }

  if (schema instanceof z.ZodOptional) {
    return sampleForSchema(schema.unwrap());
  }

  if (schema instanceof z.ZodDefault) {
    return sampleForSchema(schema.removeDefault());
  }

  if (schema instanceof z.ZodEffects) {
    return sampleForSchema(schema.innerType());
  }

  return {};
}

function invalidSampleForSchema(schema: ZodTypeAny, positive: unknown): unknown {
  if (
    schema instanceof z.ZodString ||
    schema instanceof z.ZodEnum ||
    schema instanceof z.ZodLiteral
  ) {
    return 42;
  }

  if (schema instanceof z.ZodNumber) {
    return "not-a-number";
  }

  if (schema instanceof z.ZodBoolean) {
    return "not-a-boolean";
  }

  if (schema instanceof z.ZodArray) {
    return "not-an-array";
  }

  if (schema instanceof z.ZodRecord) {
    return [];
  }

  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    return null;
  }

  if (schema instanceof z.ZodEffects) {
    return invalidSampleForSchema(schema.innerType(), positive);
  }

  if (schema instanceof z.ZodObject && isRecord(positive)) {
    const shape = schema.shape as Record<string, ZodTypeAny>;
    const requiredKey = Object.entries(shape)
      .filter(([, fieldSchema]) => !(fieldSchema instanceof z.ZodOptional))
      .map(([key]) => key)
      .sort()[0];

    if (requiredKey !== undefined) {
      const invalid = { ...positive };
      delete invalid[requiredKey];
      return invalid;
    }
  }

  return null;
}

function assertFixture(
  definition: RegisteredDefinition,
  fixture: unknown,
  shouldPass: boolean
) {
  const parsed = definition.schema.safeParse(fixture);

  if (parsed.success !== shouldPass) {
    throw new Error(
      `${definition.exportName} ${shouldPass ? "positive" : "negative"} fixture did not ${
        shouldPass ? "pass" : "fail"
      } validation`
    );
  }
}

function jsonSchemaDocument(definition: RegisteredDefinition) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: definition.id,
    title: definition.exportName,
    "x-specwright-contract": {
      id: definition.id,
      version: definition.version,
      hash: registry.find((record) => record.id === definition.id)?.canonicalHash,
      family: definition.primaryFamily,
      status: definition.status
    },
    ...jsonSchemaForZod(definition.schema)
  };
}

function jsonSchemaForZod(schema: ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: "string" };

    if (schema._def.checks.some((check) => check.kind === "datetime")) {
      result.format = "date-time";
    }

    return result;
  }

  if (schema instanceof z.ZodNumber) {
    return { type: "number" };
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }

  if (schema instanceof z.ZodUnknown) {
    return {};
  }

  if (schema instanceof z.ZodLiteral) {
    return { const: schema._def.value };
  }

  if (schema instanceof z.ZodEnum) {
    return { enum: [...schema._def.values] };
  }

  if (schema instanceof z.ZodArray) {
    return { type: "array", items: jsonSchemaForZod(schema.element) };
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: "object",
      additionalProperties: jsonSchemaForZod(schema._def.valueType)
    };
  }

  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: schema._def.options.map((option: ZodTypeAny) =>
        jsonSchemaForZod(option)
      )
    };
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    return { oneOf: [...schema.options].map((option) => jsonSchemaForZod(option)) };
  }

  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const shape = schema.shape as Record<string, ZodTypeAny>;

    for (const [key, fieldSchema] of Object.entries(shape).sort()) {
      const isOptional =
        fieldSchema instanceof z.ZodOptional || fieldSchema instanceof z.ZodDefault;
      properties[key] = jsonSchemaForZod(
        fieldSchema instanceof z.ZodOptional
          ? fieldSchema.unwrap()
          : fieldSchema instanceof z.ZodDefault
            ? fieldSchema.removeDefault()
            : fieldSchema
      );

      if (!isOptional) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required,
      additionalProperties: schema._def.unknownKeys === "passthrough"
    };
  }

  if (schema instanceof z.ZodOptional) {
    return jsonSchemaForZod(schema.unwrap());
  }

  if (schema instanceof z.ZodDefault) {
    return jsonSchemaForZod(schema.removeDefault());
  }

  if (schema instanceof z.ZodEffects) {
    return {
      ...jsonSchemaForZod(schema.innerType()),
      "x-zod-effect": schema._def.effect.type
    };
  }

  return { "x-zod-type": schema._def.typeName };
}

function eventHashes() {
  return Object.fromEntries(
    registry
      .filter((record) => record.id.startsWith("specwright.event."))
      .filter((record) => record.exportName.endsWith("EventPayloadSchema"))
      .map(
        (record): [string, string] => [
          record.id.replace("specwright.event.", ""),
          record.canonicalHash
        ]
      )
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function replayFixturePath(definition: RegisteredDefinition) {
  if (
    definition.exportName.endsWith("EventPayloadSchema") ||
    definition.exportName === "RuntimeEventSchema" ||
    definition.exportName === "ArtifactRecordSchema" ||
    definition.exportName === "EvidenceRecordSchema"
  ) {
    return `fixtures/replay/${kebabCase(definition.exportName)}.replay.json`;
  }

  return undefined;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortValue(value), null, 2)}\n`, "utf8");
}

function readJsonArray<TValue>(path: string): TValue[] {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;

  if (!Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON array`);
  }

  return value as TValue[];
}

function tsLiteral(value: unknown) {
  return JSON.stringify(sortValue(value), null, 2);
}

function generatedHeader() {
  return `// Generated by packages/schemas/scripts/generate.ts. Do not edit by hand.\n\n`;
}

function kebabCase(value: string) {
  return value
    .replace(/Schema$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function parseFamily(value: string): ContractFamily {
  return z
    .enum([
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
    ])
    .parse(value);
}

function parseSecondaryFamily(value: string): ContractFamily | "none" {
  return value === "none" ? "none" : parseFamily(value);
}

function parseStatus(value: string): "public" | "internal" {
  return z.enum(["public", "internal"]).parse(value);
}

function parseDurability(value: string): ContractDurability {
  return z.enum(["durable", "derived", "transient", "embedded"]).parse(value);
}

function parseExtensionPoints(value: string) {
  if (value === "none") {
    return [];
  }

  return value
    .split(";")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/^same as schema$/, "same-as-schema"));
}

function requireCell(cells: string[], index: number, exportName: string) {
  const value = cells[index];

  if (value === undefined || value.length === 0) {
    throw new Error(`${exportName} inventory row is missing cell ${index}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const validSourceRef = {
  id: "repo:README.md",
  path: "README.md",
  authority: "repo",
  redactionClass: "operator"
};

const validEvidenceRecord = {
  id: "evidence:contract-registry",
  class: "source_fact",
  claim: "The contract registry is generated from the schema inventory.",
  sourceRefs: [validSourceRef],
  confidence: "high",
  authority: "repo",
  createdBy: {
    phase: "contract-generation",
    actionId: "generate-contract-registry"
  },
  redactionPolicy: "operator"
};

const validArtifactRef = {
  artifactId: "artifact:contract-registry",
  artifactType: "plan",
  evidenceRefs: ["evidence:contract-registry"],
  uri: "artifacts/contract-registry.json"
};

const validArtifactRecord = {
  artifactId: "artifact:contract-registry-record",
  artifactType: "plan",
  content: {
    registryVersion
  },
  evidenceRefs: ["evidence:contract-registry"],
  claimLevel: "derived_fact",
  importantClaims: [
    {
      claim: "The generated registry is deterministic.",
      claimLevel: "source_fact",
      evidenceRefs: ["evidence:contract-registry"],
      confidence: "high",
      authority: "repo",
      owningArtifactId: "artifact:contract-registry-record",
      owningSection: "registry",
      verificationStatus: "supported",
      redactionPolicy: "operator"
    }
  ],
  producedBy: {
    phase: "contract-generation",
    actionId: "generate-contract-registry"
  },
  redactionPolicy: "operator",
  metadata: {
    registryVersion
  }
};

const validPolicyVerdict = {
  status: "approval_required",
  approvalId: "approval:contract-registry",
  reasons: ["Contract changes require compatibility review."],
  constraints: [],
  obligations: [],
  matchedRules: [],
  decisionHash: "sha256:policy-fixture"
};

const validPolicyEvaluatedEventPayload = {
  requestId: "req:contract-registry-policy",
  runId: "run:contract-registry",
  phase: "shared-schemas",
  actionKind: "tool_call",
  toolId: "shell.exec",
  risk: "high",
  status: "approval_required",
  matchedRules: [
    {
      ruleId: "tool.shell.exec.default",
      layer: "capability",
      effect: "approval_required",
      reason: "Contract changes require compatibility review."
    }
  ],
  decidingLayer: "capability",
  constraints: [
    {
      kind: "timeoutMs",
      value: 120000,
      sourceRuleId: "tool.shell.exec.default"
    }
  ],
  obligations: [
    {
      kind: "record_event",
      params: {
        eventType: "policy.evaluated"
      },
      sourceRuleId: "tool.shell.exec.default"
    }
  ],
  approvalId: "approval:contract-registry",
  requestHash: "sha256:request-fixture",
  policyBundleHash: "sha256:bundle-fixture",
  decisionHash: "sha256:policy-fixture",
  argsHash: "sha256:args-fixture",
  bundleSetRef: "policy-bundle:contract-registry",
  bundleVersions: ["contract-registry@specwright.policy-bundle.v1"]
};

const validGateVerdict = {
  gateId: "contract.registry",
  phase: "shared-schemas",
  status: "pass",
  severity: "blocking",
  reasons: ["Registry fixture passed."],
  findings: [],
  evidenceRefs: ["evidence:contract-registry"],
  obligations: [],
  evaluatedAt: "2026-06-05T00:00:00.000Z",
  evaluator: {
    kind: "deterministic",
    ref: "specwright.schemas.generator"
  }
};

const validEvalVerdict = {
  evalId: "contract.registry.conformance",
  targetRef: "contract:registry",
  status: "pass",
  severity: "blocking",
  findings: [],
  evidenceRefs: ["evidence:contract-registry"],
  producedBy: {
    kind: "deterministic",
    ref: "specwright.schemas.generator"
  }
};

const validHarnessSnapshot = {
  id: "default",
  version: "1.0.0",
  schemaVersion: "specwright.harness.v1",
  specHash: "sha256:harness-fixture",
  loadedAt: "2026-06-05T00:00:00.000Z",
  phases: [],
  gates: [],
  policies: [],
  tools: [],
  artifacts: [],
  evals: [],
  roles: [],
  prompts: []
};

const validRunInput = {
  task: "Generate the authoritative contract registry.",
  harnessId: "default",
  host: {
    kind: "cli"
  }
};

const validRunState = {
  runId: "run:contract-registry",
  status: "running",
  phase: "shared-schemas",
  harness: {
    id: "default",
    version: "1.0.0",
    specHash: "sha256:harness-fixture"
  },
  budgets: {},
  pendingApprovals: [],
  pendingQuestions: [],
  artifacts: [validArtifactRef],
  lastEventId: "event:0"
};

const validToolCallRequest = {
  toolId: "fs.read",
  args: {
    path: "packages/schemas/CONTRACTS.md"
  },
  reason: "Read contract inventory.",
  idempotencyKey: "tool:registry-read",
  requestedBy: {
    phase: "shared-schemas"
  }
};

const validToolCallResult = {
  toolCallId: "tool:registry-read",
  status: "success",
  output: {
    path: "packages/schemas/CONTRACTS.md"
  },
  provenance: {
    toolId: "fs.read",
    toolVersion: "1.0.0",
    adapterVersion: "1.0.0",
    argsHash: "sha256:args-fixture",
    resultHash: "sha256:result-fixture",
    decisionHash: "sha256:decision-fixture",
    cacheStatus: "miss",
    traceId: "trace:contract-registry"
  }
};

const validRuntimeEventEnvelope = {
  id: "event:0",
  runId: "run:contract-registry",
  timestamp: "2026-06-05T00:00:00.000Z",
  sequence: 0,
  traceId: "trace:contract-registry",
  type: "run.started",
  payload: {
    input: validRunInput,
    harness: validRunState.harness,
    initialPhase: "shared-schemas",
    budgets: {}
  }
};

const positiveOverrides: Record<string, unknown> = {
  ArtifactClaimSchema: validArtifactRecord.importantClaims[0],
  ArtifactInputSchema: {
    artifactType: "plan",
    content: {
      registryVersion
    },
    evidenceRefs: ["evidence:contract-registry"],
    claimLevel: "derived_fact",
    producedBy: {
      phase: "contract-generation",
      actionId: "generate-contract-registry"
    }
  },
  ArtifactRecordSchema: validArtifactRecord,
  ArtifactRecordedEventPayloadSchema: {
    artifact: validArtifactRef
  },
  ArtifactRefSchema: validArtifactRef,
  ApprovalDecisionSchema: {
    approvalId: "approval:contract-registry",
    decision: "approved",
    decidedAt: "2026-06-05T00:00:00.000Z"
  },
  ApprovalRequestSchema: {
    approvalId: "approval:contract-registry",
    reason: "Review generated registry changes."
  },
  CreatedBySchema: validEvidenceRecord.createdBy,
  DecisionRecordedEventPayloadSchema: {
    approvalId: "approval:contract-registry",
    decision: {
      approvalId: "approval:contract-registry",
      decision: "approved"
    },
    subject: "contract-registry"
  },
  EvalCompletedEventPayloadSchema: {
    evalId: "contract.registry.conformance",
    verdict: validEvalVerdict
  },
  EvalVerdictContractSchema: validEvalVerdict,
  EvalVerdictSchema: validEvalVerdict,
  EvidenceRecordSchema: validEvidenceRecord,
  EvidenceRecordedEventPayloadSchema: {
    evidence: validEvidenceRecord
  },
  GateApprovalRequestSchema: {
    id: "approval:contract-registry",
    gateId: "contract.registry",
    phase: "shared-schemas",
    reason: "Generated registry change needs review.",
    requiredFor: "gate:contract.registry"
  },
  GateEvaluatedEventPayloadSchema: {
    gateId: "contract.registry",
    verdict: validGateVerdict,
    instruction: {
      kind: "continue",
      gateId: "contract.registry"
    }
  },
  GateFindingSchema: {
    id: "finding:contract-registry",
    severity: "blocking",
    message: "Registry fixture finding.",
    evidenceRefs: ["evidence:contract-registry"]
  },
  GateHumanQuestionSchema: {
    id: "question:contract-registry",
    gateId: "contract.registry",
    phase: "shared-schemas",
    question: "Confirm compatibility classification.",
    requiredFor: "gate:contract.registry"
  },
  GateLifecycleInstructionSchema: {
    kind: "continue",
    gateId: "contract.registry"
  },
  GateRepairTaskSchema: {
    id: "repair:contract-registry",
    gateId: "contract.registry",
    failedPhase: "shared-schemas",
    problem: "Generated registry drifted.",
    requiredEvidenceRefs: ["evidence:contract-registry"],
    allowedTools: ["fs.read"],
    blockedTools: ["shell.exec"],
    successGate: "contract.registry",
    createdFromFindingIds: ["finding:contract-registry"]
  },
  GateVerdictSchema: validGateVerdict,
  HarnessLoadedEventPayloadSchema: {
    harness: validHarnessSnapshot
  },
  HarnessSnapshotSchema: validHarnessSnapshot,
  HumanAnswerRecordedEventPayloadSchema: {
    questionId: "question:contract-registry",
    answer: "forward-compatible",
    answeredBy: "operator"
  },
  HumanInputRequestedEventPayloadSchema: {
    question: {
      questionId: "question:contract-registry",
      prompt: "Confirm compatibility classification."
    }
  },
  HumanQuestionSchema: {
    questionId: "question:contract-registry",
    prompt: "Confirm compatibility classification."
  },
  HumanReviewSchema: {
    id: "question:contract-registry",
    question: "Confirm compatibility classification.",
    requiredFor: "gate:contract.registry"
  },
  PhaseEnteredEventPayloadSchema: {
    phase: "shared-schemas",
    reason: "contract generation started"
  },
  PhaseTransitionedEventPayloadSchema: {
    fromPhase: "inventory",
    toPhase: "registry",
    reason: "registry generation"
  },
  PolicyEvaluatedEventPayloadSchema: validPolicyEvaluatedEventPayload,
  PolicyEvaluatedEventSchema: {
    id: "event:policy-evaluated",
    runId: "run:contract-registry",
    timestamp: "2026-06-05T00:00:00.000Z",
    sequence: 1,
    traceId: "trace:contract-registry",
    type: "policy.evaluated",
    payload: validPolicyEvaluatedEventPayload
  },
  PolicyVerdictSchema: validPolicyVerdict,
  RepairTaskSchema: {
    task: "Regenerate checked-in contract artifacts."
  },
  RunCompletedEventPayloadSchema: {
    reason: "Contract registry generated."
  },
  RunFailedEventPayloadSchema: {
    reason: "Contract registry generation failed.",
    errorCode: "registry_generation_failed"
  },
  RunInputSchema: validRunInput,
  RunStartedEventPayloadSchema: {
    input: validRunInput,
    harness: validRunState.harness,
    initialPhase: "shared-schemas",
    budgets: {}
  },
  RunStateSchema: validRunState,
  RuntimeEventEnvelopeSchema: validRuntimeEventEnvelope,
  RuntimeEventSchema: validRuntimeEventEnvelope,
  SourceRefSchema: validSourceRef,
  ToolAuthorizedEventPayloadSchema: {
    request: validToolCallRequest,
    policyStatus: "allow"
  },
  ToolCallRequestSchema: validToolCallRequest,
  ToolCallResultSchema: validToolCallResult,
  ToolCompletedEventPayloadSchema: {
    request: validToolCallRequest,
    result: validToolCallResult
  },
  ToolDeniedEventPayloadSchema: {
    request: validToolCallRequest,
    reason: "Policy denied the request."
  },
  ToolRequestedEventPayloadSchema: {
    request: validToolCallRequest
  }
};

const negativeOverrides: Record<string, unknown> = {
  EvidenceRecordSchema: {
    ...validEvidenceRecord,
    sourceRefs: []
  },
  ArtifactRecordSchema: {
    ...validArtifactRecord,
    content: undefined,
    fileRef: undefined
  },
  RuntimeEventSchema: {
    ...validRuntimeEventEnvelope,
    type: "event.unregistered"
  },
  RuntimeEventEnvelopeSchema: {
    ...validRuntimeEventEnvelope,
    sequence: -1
  },
  PhaseTransitionedEventPayloadSchema: {
    reason: "missing target phase"
  },
  ArtifactInputSchema: {
    content: {
      registryVersion
    },
    evidenceRefs: ["evidence:contract-registry"],
    claimLevel: "derived_fact",
    producedBy: {
      phase: "contract-generation",
      actionId: "generate-contract-registry"
    },
    artifactType: ""
  },
  ToolCallRequestSchema: {
    ...validToolCallRequest,
    toolId: ""
  },
  ToolAuthorizedEventPayloadSchema: {},
  ToolDeniedEventPayloadSchema: {},
  HumanInputRequestedEventPayloadSchema: {},
  HumanAnswerRecordedEventPayloadSchema: {
    answer: "missing question id"
  },
  RepairTaskSchema: {
    metadata: {}
  },
  GateRepairTaskSchema: {
    problem: "missing gate repair fields"
  }
};

writeGeneratedArtifacts();
