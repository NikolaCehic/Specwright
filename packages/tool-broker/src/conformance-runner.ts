import { open, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluatePolicy } from "@specwright/policy-engine";
import type {
  FixturePolicyBundle,
  PolicyRequest,
  PolicyVerdict
} from "@specwright/policy-engine";
import {
  ToolCallRequestSchema,
  ToolCallResultSchema,
  type ToolCallRequest,
  type ToolCallResult
} from "@specwright/schemas";
import {
  CapabilityRegistry,
  createDefaultCapabilityRegistry,
  createToolBroker,
  FILESYSTEM_ADAPTER_VERSION,
  type AdapterExecutionResult,
  type CapabilityAdapter,
  type PolicyEvaluator,
  type ToolBrokerOptions
} from "./index";

export type CoverageClass = "allow" | "deny" | "failure_or_redaction";

export type FixturePolicy = "allow" | "deny" | "approval_required" | "throw";
export type FixtureRegistry = "default" | "fs_read_invalid_output";

export type ConformanceFixtureMetadata = {
  title: string;
  capabilityId?: string;
  coverage?: CoverageClass;
  determinismGroup?: string;
  repeatResultHash?: boolean;
};

export type ConformanceFixtureContext = {
  traceId: string;
  policy: FixturePolicy;
  registry: FixtureRegistry;
  cwd?: string;
  runId?: string;
};

export type NormalizedToolCallResult = Omit<
  ToolCallResult,
  "toolCallId" | "provenance"
> & {
  provenance: Omit<ToolCallResult["provenance"], "traceId">;
};

export type ProvenanceBaselineEntry = {
  status: ToolCallResult["status"];
  errorCode?: string;
  argsHash: string;
  resultHash?: string;
  cacheStatus: ToolCallResult["provenance"]["cacheStatus"];
  toolVersion: string;
};

export type ProvenanceBaseline = Record<string, ProvenanceBaselineEntry>;

export type ConformanceFixture = {
  name: string;
  directory: string;
  metadata: ConformanceFixtureMetadata;
  request: ToolCallRequest;
  context: ConformanceFixtureContext;
  expected?: NormalizedToolCallResult;
};

export type ConformanceFixtureResult = {
  fixture: ConformanceFixture;
  normalized: NormalizedToolCallResult;
  baseline: ProvenanceBaselineEntry;
};

export type ConformanceGateReport = {
  fixtures: number;
  baselineEntries: number;
  capabilities: number;
  coverageAssertions: number;
  determinismGroups: number;
  repeatedResultHashAssertions: number;
};

type LoadFixtureOptions = {
  allowMissingExpected?: boolean;
};

const DEFAULT_RUN_ID = "run_tool_broker_conformance";

export async function loadConformanceFixtures(
  corpusRoot: string,
  options: LoadFixtureOptions = {}
): Promise<ConformanceFixture[]> {
  const entries = (await readdir(corpusRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const fixtures = await Promise.all(
    entries.sort().map(async (entry) => {
      const directory = resolve(corpusRoot, entry);
      const metadata = readFixtureMetadata(
        await readJsonObject(resolve(directory, "metadata.json"))
      );
      const request = ToolCallRequestSchema.parse(
        await readJsonObject(resolve(directory, "request.json"))
      );
      const context = readFixtureContext(
        await readJsonObject(resolve(directory, "context.json"))
      );
      const expectedPath = resolve(directory, "expected.json");
      const expectedJson = await readOptionalJsonObject(expectedPath);

      if (expectedJson === undefined && options.allowMissingExpected !== true) {
        throw new Error(`Fixture ${entry} is missing expected.json.`);
      }

      const fixture: ConformanceFixture = {
        name: entry,
        directory,
        metadata,
        request,
        context
      };

      if (expectedJson !== undefined) {
        fixture.expected = expectedJson as NormalizedToolCallResult;
      }

      return fixture;
    })
  );

  if (fixtures.length === 0) {
    throw new Error(`No conformance fixtures discovered under ${corpusRoot}.`);
  }

  return fixtures;
}

export async function loadProvenanceBaseline(
  baselinePath: string
): Promise<ProvenanceBaseline> {
  const raw = await readJsonObject(baselinePath);
  const baseline: ProvenanceBaseline = {};

  for (const [name, entry] of Object.entries(raw)) {
    baseline[name] = readBaselineEntry(name, entry);
  }

  return baseline;
}

export async function runConformanceFixture(input: {
  fixture: ConformanceFixture;
  workspaceRoot: string;
}): Promise<NormalizedToolCallResult> {
  const broker = createBrokerForFixture(input.fixture, input.workspaceRoot);
  const result = await broker.callTool(input.fixture.request, {
    cwd:
      input.fixture.context.cwd === undefined
        ? input.workspaceRoot
        : resolve(input.workspaceRoot, input.fixture.context.cwd),
    runId: input.fixture.context.runId ?? DEFAULT_RUN_ID,
    traceId: input.fixture.context.traceId
  });
  const parsed = ToolCallResultSchema.parse(result);

  return normalizeToolCallResult(parsed);
}

export async function runConformanceGate(input: {
  corpusRoot: string;
  baselinePath: string;
  workspaceRoot: string;
}): Promise<ConformanceGateReport> {
  const fixtures = await loadConformanceFixtures(input.corpusRoot);
  const baseline = await loadProvenanceBaseline(input.baselinePath);
  const fixtureResults: ConformanceFixtureResult[] = [];

  assertCapabilityCoverage(
    createDefaultCapabilityRegistry().list().map((definition) => definition.id),
    fixtures
  );

  for (const fixture of fixtures) {
    const normalized = await runConformanceFixture({
      fixture,
      workspaceRoot: input.workspaceRoot
    });

    if (fixture.expected === undefined) {
      throw new Error(`Fixture ${fixture.name} is missing expected.json.`);
    }

    assertJsonEqual(
      normalized,
      fixture.expected,
      `Fixture ${fixture.name} no longer matches expected.json.`
    );

    const baselineEntry = baseline[fixture.name];
    if (baselineEntry === undefined) {
      throw new Error(
        `Fixture ${fixture.name} is missing from provenance-baseline.json.`
      );
    }

    assertJsonEqual(
      baselineEntryFromResult(normalized),
      baselineEntry,
      `Fixture ${fixture.name} no longer matches provenance-baseline.json.`
    );

    fixtureResults.push({
      fixture,
      normalized,
      baseline: baselineEntry
    });
  }

  assertNoUnreferencedBaselineEntries(baseline, fixtures);
  const determinismGroups = assertDeterminismGroups(fixtureResults);
  const repeatedResultHashAssertions =
    await assertRepeatedResultHashFixtures(fixtureResults, input.workspaceRoot);

  return {
    fixtures: fixtures.length,
    baselineEntries: Object.keys(baseline).length,
    capabilities: createDefaultCapabilityRegistry().list().length,
    coverageAssertions: 3 * createDefaultCapabilityRegistry().list().length,
    determinismGroups,
    repeatedResultHashAssertions
  };
}

export function normalizeToolCallResult(
  result: ToolCallResult
): NormalizedToolCallResult {
  const { toolCallId: _toolCallId, provenance, ...resultWithoutId } = result;
  const { traceId: _traceId, ...provenanceWithoutTrace } = provenance;

  return {
    ...resultWithoutId,
    provenance: provenanceWithoutTrace
  };
}

export function baselineEntryFromResult(
  result: NormalizedToolCallResult
): ProvenanceBaselineEntry {
  const entry: ProvenanceBaselineEntry = {
    status: result.status,
    argsHash: result.provenance.argsHash,
    cacheStatus: result.provenance.cacheStatus,
    toolVersion: result.provenance.toolVersion
  };

  if (result.error?.code !== undefined) {
    entry.errorCode = result.error.code;
  }

  if (result.provenance.resultHash !== undefined) {
    entry.resultHash = result.provenance.resultHash;
  }

  return entry;
}

export function assertCapabilityCoverage(
  capabilityIds: readonly string[],
  fixtures: readonly ConformanceFixture[]
) {
  const coverageByCapability = new Map<string, Set<CoverageClass>>();

  for (const capabilityId of capabilityIds) {
    coverageByCapability.set(capabilityId, new Set());
  }

  for (const fixture of fixtures) {
    if (
      fixture.metadata.capabilityId === undefined ||
      fixture.metadata.coverage === undefined
    ) {
      continue;
    }

    const coverage = coverageByCapability.get(fixture.metadata.capabilityId);
    if (coverage !== undefined) {
      coverage.add(fixture.metadata.coverage);
    }
  }

  for (const capabilityId of capabilityIds) {
    const coverage = coverageByCapability.get(capabilityId) ?? new Set();
    for (const coverageClass of [
      "allow",
      "deny",
      "failure_or_redaction"
    ] as const) {
      if (!coverage.has(coverageClass)) {
        throw new Error(
          `Capability ${capabilityId} is missing ${coverageClass} conformance coverage.`
        );
      }
    }
  }
}

export function assertJsonEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = stableJson(actual);
  const expectedJson = stableJson(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${label}\nExpected:\n${expectedJson}\nActual:\n${actualJson}`);
  }
}

function createBrokerForFixture(
  fixture: ConformanceFixture,
  workspaceRoot: string
) {
  const options: ToolBrokerOptions = {
    workspaceRoot,
    runId: fixture.context.runId ?? DEFAULT_RUN_ID,
    registry: registryForFixture(fixture),
    policyBundle: policyBundleForFixture(fixture)
  };

  if (fixture.context.policy === "throw") {
    options.policyEngine = throwingPolicyEngine;
  }

  return createToolBroker(options);
}

function registryForFixture(fixture: ConformanceFixture) {
  if (fixture.context.registry === "fs_read_invalid_output") {
    const fsReadAdapter: CapabilityAdapter = {
      id: "fixture/fs-read-invalid-output-conformance",
      version: FILESYSTEM_ADAPTER_VERSION,
      kind: "filesystem",
      async execute(): Promise<AdapterExecutionResult> {
        return {
          status: "success",
          output: {
            path: "src/index.ts",
            content: "missing required fields"
          }
        };
      }
    };

    return createDefaultCapabilityRegistry({ fsReadAdapter });
  }

  return createDefaultCapabilityRegistry();
}

function policyBundleForFixture(fixture: ConformanceFixture): FixturePolicyBundle {
  if (fixture.context.policy === "deny") {
    return denyPolicyBundleFor(fixture.request.toolId);
  }

  if (fixture.context.policy === "approval_required") {
    return approvalRequiredPolicyBundleFor(fixture.request.toolId);
  }

  return allowPolicyBundle;
}

const throwingPolicyEngine: PolicyEvaluator = function throwingPolicyEngine(
  _request: PolicyRequest,
  _bundles?: FixturePolicyBundle | readonly FixturePolicyBundle[]
): PolicyVerdict {
  throw new Error("Fixture policy engine failure");
};

const allowPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.conformance.allow",
  description: "Allows read-only filesystem tools for broker conformance.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fs.list": {
      default: "allow",
      risk: "low",
      reason: "fs.list is allowed for broker conformance.",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    },
    "fs.read": {
      default: "allow",
      risk: "low",
      reason: "fs.read is allowed for broker conformance.",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"],
      constraints: [
        {
          kind: "maxBytes",
          value: 64
        }
      ]
    }
  }
};

function denyPolicyBundleFor(toolId: string): FixturePolicyBundle {
  return {
    id: `fixture.tool-broker.conformance.deny.${safeId(toolId)}`,
    description: `Denies ${toolId} for broker conformance.`,
    scopes: ["workspace:read"],
    toolPolicy: {
      [toolId]: {
        default: "deny",
        risk: "low",
        reason: `Fixture denies ${toolId}`,
        allowedPhases: ["source_discovery", "evidence", "verification"],
        requiredScopes: ["workspace:read"],
        allowedScopes: ["workspace:read"]
      }
    }
  };
}

function approvalRequiredPolicyBundleFor(toolId: string): FixturePolicyBundle {
  return {
    id: `fixture.tool-broker.conformance.approval.${safeId(toolId)}`,
    description: `Requires approval for ${toolId} broker conformance.`,
    scopes: ["workspace:read"],
    toolPolicy: {
      [toolId]: {
        default: "approval_required",
        risk: "low",
        reason: `Fixture requires approval for ${toolId}`,
        approvalId: `approval.fixture.${safeId(toolId)}`,
        allowedPhases: ["source_discovery", "evidence", "verification"],
        requiredScopes: ["workspace:read"],
        allowedScopes: ["workspace:read"]
      }
    }
  };
}

export function evaluateConformancePolicy(
  request: PolicyRequest,
  bundles: readonly FixturePolicyBundle[]
) {
  return evaluatePolicy(request, bundles);
}

function assertDeterminismGroups(
  results: readonly ConformanceFixtureResult[]
) {
  const byGroup = new Map<string, ConformanceFixtureResult[]>();

  for (const result of results) {
    const group = result.fixture.metadata.determinismGroup;
    if (group === undefined) {
      continue;
    }

    byGroup.set(group, [...(byGroup.get(group) ?? []), result]);
  }

  for (const [group, groupResults] of byGroup.entries()) {
    if (groupResults.length < 2) {
      throw new Error(`Determinism group ${group} has fewer than two fixtures.`);
    }

    const [first, ...rest] = groupResults;
    if (first === undefined) {
      continue;
    }

    for (const result of rest) {
      if (
        result.normalized.provenance.argsHash !==
        first.normalized.provenance.argsHash
      ) {
        throw new Error(
          `Determinism group ${group} produced different argsHash values.`
        );
      }
    }
  }

  return byGroup.size;
}

async function assertRepeatedResultHashFixtures(
  results: readonly ConformanceFixtureResult[],
  workspaceRoot: string
) {
  let assertions = 0;

  for (const result of results) {
    if (result.fixture.metadata.repeatResultHash !== true) {
      continue;
    }

    const repeated = await runConformanceFixture({
      fixture: result.fixture,
      workspaceRoot
    });

    if (
      repeated.provenance.resultHash !== result.normalized.provenance.resultHash
    ) {
      throw new Error(
        `Fixture ${result.fixture.name} did not produce a stable resultHash on repeat execution.`
      );
    }

    assertions += 1;
  }

  return assertions;
}

function assertNoUnreferencedBaselineEntries(
  baseline: ProvenanceBaseline,
  fixtures: readonly ConformanceFixture[]
) {
  const fixtureNames = new Set(fixtures.map((fixture) => fixture.name));

  for (const name of Object.keys(baseline)) {
    if (!fixtureNames.has(name)) {
      throw new Error(
        `provenance-baseline.json contains ${name}, but no matching fixture was discovered.`
      );
    }
  }
}

function readFixtureMetadata(
  raw: Record<string, unknown>
): ConformanceFixtureMetadata {
  const metadata: ConformanceFixtureMetadata = {
    title: readRequiredString(raw, "title")
  };
  const capabilityId = readOptionalString(raw, "capabilityId");
  const coverage = readOptionalCoverage(raw, "coverage");
  const determinismGroup = readOptionalString(raw, "determinismGroup");
  const repeatResultHash = readOptionalBoolean(raw, "repeatResultHash");

  if (capabilityId !== undefined) {
    metadata.capabilityId = capabilityId;
  }
  if (coverage !== undefined) {
    metadata.coverage = coverage;
  }
  if (determinismGroup !== undefined) {
    metadata.determinismGroup = determinismGroup;
  }
  if (repeatResultHash !== undefined) {
    metadata.repeatResultHash = repeatResultHash;
  }

  return metadata;
}

function readFixtureContext(
  raw: Record<string, unknown>
): ConformanceFixtureContext {
  const context: ConformanceFixtureContext = {
    traceId: readRequiredString(raw, "traceId"),
    policy: readFixturePolicy(raw, "policy"),
    registry: readFixtureRegistry(raw, "registry")
  };
  const cwd = readOptionalString(raw, "cwd");
  const runId = readOptionalString(raw, "runId");

  if (cwd !== undefined) {
    context.cwd = cwd;
  }

  if (runId !== undefined) {
    context.runId = runId;
  }

  return context;
}

function readBaselineEntry(
  name: string,
  value: unknown
): ProvenanceBaselineEntry {
  if (!isRecord(value)) {
    throw new Error(`Baseline entry ${name} must be an object.`);
  }

  const entry: ProvenanceBaselineEntry = {
    status: readStatus(value, "status"),
    argsHash: readRequiredString(value, "argsHash"),
    cacheStatus: readCacheStatus(value, "cacheStatus"),
    toolVersion: readRequiredString(value, "toolVersion")
  };
  const errorCode = readOptionalString(value, "errorCode");
  const resultHash = readOptionalString(value, "resultHash");

  if (errorCode !== undefined) {
    entry.errorCode = errorCode;
  }

  if (resultHash !== undefined) {
    entry.resultHash = resultHash;
  }

  return entry;
}

async function readJsonObject(path: string) {
  const parsed = JSON.parse(await readTextFile(path)) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  return parsed;
}

async function readOptionalJsonObject(path: string) {
  try {
    return await readJsonObject(path);
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function stableJson(value: unknown) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }

  return value;
}

function readRequiredString(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string when present.`);
  }
  return value;
}

function readOptionalBoolean(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when present.`);
  }
  return value;
}

function readOptionalCoverage(
  raw: Record<string, unknown>,
  key: string
): CoverageClass | undefined {
  const value = readOptionalString(raw, key);
  if (value === undefined) {
    return undefined;
  }
  if (
    value !== "allow" &&
    value !== "deny" &&
    value !== "failure_or_redaction"
  ) {
    throw new Error(`${key} must be allow, deny, or failure_or_redaction.`);
  }
  return value;
}

function readFixturePolicy(
  raw: Record<string, unknown>,
  key: string
): FixturePolicy {
  const value = readRequiredString(raw, key);
  if (
    value !== "allow" &&
    value !== "deny" &&
    value !== "approval_required" &&
    value !== "throw"
  ) {
    throw new Error(`${key} must be allow, deny, approval_required, or throw.`);
  }
  return value;
}

function readFixtureRegistry(
  raw: Record<string, unknown>,
  key: string
): FixtureRegistry {
  const value = readRequiredString(raw, key);
  if (value !== "default" && value !== "fs_read_invalid_output") {
    throw new Error(`${key} must be default or fs_read_invalid_output.`);
  }
  return value;
}

function readStatus(
  raw: Record<string, unknown>,
  key: string
): ToolCallResult["status"] {
  const value = readRequiredString(raw, key);
  if (
    value !== "success" &&
    value !== "denied" &&
    value !== "approval_required" &&
    value !== "failed"
  ) {
    throw new Error(`${key} must be a ToolCallResult status.`);
  }
  return value;
}

function readCacheStatus(
  raw: Record<string, unknown>,
  key: string
): ToolCallResult["provenance"]["cacheStatus"] {
  const value = readRequiredString(raw, key);
  if (value !== "hit" && value !== "miss" && value !== "bypass") {
    throw new Error(`${key} must be hit, miss, or bypass.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown) {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, "_");
}

async function readTextFile(path: string) {
  const fileStats = await stat(path);
  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(fileStats.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
