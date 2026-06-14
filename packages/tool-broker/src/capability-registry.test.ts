import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import {
  definitionMissingIsolationTier,
  definitionWithAdapterKindMismatch,
  definitionWithMalformedAdapter,
  definitionWithUnmappedKind,
  definitionWithWrongIsolationTier,
  duplicateIdDefinitions,
  modelDefinitionMissingOutputSchema,
  partialDefinitionMissingRequestedScopes,
  partialDefinitionMissingVersion,
  validMultiKindDefinitions
} from "../fixtures/registry/definitions";
import {
  CAPABILITY_KINDS,
  CAPABILITY_KIND_ISOLATION_TIERS,
  CapabilityDefinitionSchema,
  CapabilityRegistry,
  ToolBrokerError,
  createDefaultCapabilityRegistry,
  createToolBroker,
  deriveTierConstraints,
  isolationTierForKind,
  type CapabilityDefinition,
  type CapabilityKind,
  type IsolationTier,
  type ToolBrokerErrorCode
} from "./index";

const workspaceRoot = resolve(import.meta.dir, "../fixtures/workspace");

const expectedIsolationTiers = {
  filesystem: 0,
  git: 0,
  browser: 4,
  model: 1,
  embeddings: 1,
  memory: 1,
  cache: 1,
  shell: 3,
  mcp: 4,
  network: 4,
  human: 4
} as const satisfies Record<CapabilityKind, IsolationTier>;

const defaultBrokerCapabilityBaseline = [
  {
    id: "fs.list",
    kind: "filesystem",
    risk: "low",
    requestedScopes: ["workspace:read"],
    mutability: "read_only",
    durable: false,
    adapterSpecific: false,
    cacheEnabled: false,
    isolationTier: 0,
    execution: "sanctioned",
    networkAllowlist: "deny_all",
    subprocess: "forbidden",
    writeConfinement: "workspace_readonly"
  },
  {
    id: "fs.read",
    kind: "filesystem",
    risk: "low",
    requestedScopes: ["workspace:read"],
    mutability: "read_only",
    durable: false,
    adapterSpecific: false,
    cacheEnabled: false,
    isolationTier: 0,
    execution: "sanctioned",
    networkAllowlist: "deny_all",
    subprocess: "forbidden",
    writeConfinement: "workspace_readonly"
  }
] as const;

const harnessCriticalCapabilityGaps = [
  {
    family: "filesystem.write_edit",
    kind: "filesystem",
    examples: ["fs.write", "fs.patch"],
    owner: "FEAT-EPIC-007/G-CAPACK-001"
  },
  {
    family: "shell.command",
    kind: "shell",
    examples: ["shell.exec", "package.install"],
    owner: "FEAT-EPIC-007/G-CAPACK-001"
  },
  {
    family: "git",
    kind: "git",
    examples: ["git.branch", "git.commit", "git.push"],
    owner: "FEAT-EPIC-007/G-CAPACK-001"
  },
  {
    family: "browser",
    kind: "browser",
    examples: ["browser.open", "browser.screenshot"],
    owner: "FEAT-EPIC-007/G-CAPACK-001"
  },
  {
    family: "network",
    kind: "network",
    examples: ["network.request", "network.write"],
    owner: "FEAT-EPIC-007/G-CAPACK-001"
  },
  {
    family: "model",
    kind: "model",
    examples: ["model.generate", "model.review"],
    owner: "FEAT-EPIC-007/G-CAPACK-001"
  },
  {
    family: "memory",
    kind: "memory",
    examples: ["memory.ingest", "memory.search", "memory.get", "memory.forget"],
    owner: "FEAT-EPIC-010/G-CAP-002"
  },
  {
    family: "embeddings",
    kind: "embeddings",
    examples: ["embeddings.search"],
    owner: "FEAT-EPIC-010/G-CAP-002"
  },
  {
    family: "cache",
    kind: "cache",
    examples: ["cache.read", "cache.write"],
    owner: "FEAT-EPIC-010/G-CAP-002"
  },
  {
    family: "human",
    kind: "human",
    examples: ["human.approval", "human.answer"],
    owner: "AUD-004A/FEAT-EPIC-004"
  },
  {
    family: "mcp",
    kind: "mcp",
    examples: ["mcp.server", "mcp.tool.call"],
    owner: "AUD-011A/FEAT-EPIC-011/FEAT-EPIC-012"
  }
] as const satisfies readonly Array<{
  family: string;
  kind: CapabilityKind;
  examples: readonly string[];
  owner: string;
}>;

describe("capability registry declaration contracts", () => {
  test("default filesystem definitions are schema-complete and tier-bound", () => {
    const definitions = createDefaultCapabilityRegistry().list();

    expect(definitions.map((definition) => definition.id)).toEqual([
      "fs.list",
      "fs.read"
    ]);

    for (const definition of definitions) {
      expect(CapabilityDefinitionSchema.safeParse(definition).success).toBe(true);
      expect(definition.inputSchema).toBeInstanceOf(z.ZodType);
      expect(definition.outputSchema).toBeInstanceOf(z.ZodType);
      expect(definition.risk).toBe("low");
      expect(definition.requestedScopes.length).toBeGreaterThan(0);
      expect(definition.limits).toBeDefined();
      expect(definition.cache).toEqual({ enabled: false });
      expect(definition.isolationTier).toBe(
        isolationTierForKind(definition.kind)
      );
    }
  });

  test("AUD-012A default broker capability baseline is read-only and gap-owned", () => {
    const definitions = createDefaultCapabilityRegistry().list();
    const defaultIds = new Set(definitions.map((definition) => definition.id));

    expect(brokerCapabilityBaselineRows(definitions)).toEqual(
      defaultBrokerCapabilityBaseline
    );
    expect(definitions.map((definition) => definition.id)).toEqual([
      "fs.list",
      "fs.read"
    ]);

    for (const gap of harnessCriticalCapabilityGaps) {
      expect(gap.owner.length).toBeGreaterThan(0);

      for (const example of gap.examples) {
        expect(defaultIds.has(example)).toBe(false);
      }
    }

    const visibleGapKinds = new Set(
      harnessCriticalCapabilityGaps.map((gap) => gap.kind)
    );
    for (const kind of CAPABILITY_KINDS.filter((kind) => kind !== "filesystem")) {
      expect(visibleGapKinds.has(kind)).toBe(true);
    }
  });

  test("valid multi-kind definitions are admitted and listed deterministically", () => {
    const definitions = validMultiKindDefinitions();
    const registry = new CapabilityRegistry(definitions);
    const expectedIds = definitions
      .map((definition) => definition.id)
      .sort((left, right) => left.localeCompare(right));

    expect(registry.list().map((definition) => definition.id)).toEqual(
      expectedIds
    );

    for (const definition of registry.list()) {
      expect(CapabilityDefinitionSchema.safeParse(definition).success).toBe(true);
      expect(definition.inputSchema).toBeInstanceOf(z.ZodType);
      expect(definition.outputSchema).toBeInstanceOf(z.ZodType);
      expect(definition.requestedScopes.length).toBeGreaterThan(0);
      expect(definition.limits).toBeDefined();
      expect(definition.cache.enabled).toBe(false);
      expect(definition.isolationTier).toBe(
        isolationTierForKind(definition.kind)
      );
    }
  });

  test("isolationTierForKind is total and stable for every capability kind", () => {
    expect(CAPABILITY_KIND_ISOLATION_TIERS).toEqual(expectedIsolationTiers);

    for (const kind of CAPABILITY_KINDS) {
      const first = isolationTierForKind(kind);
      const second = isolationTierForKind(kind);

      expect(first).toBe(expectedIsolationTiers[kind]);
      expect(second).toBe(first);
    }
  });

  test("duplicate registration fails closed with duplicate_tool", () => {
    const [first, duplicate] = duplicateIdDefinitions();

    expect(() => new CapabilityRegistry([first, duplicate])).toThrow(
      ToolBrokerError
    );

    const registry = new CapabilityRegistry([first]);
    const error = captureToolBrokerError(() => registry.register(duplicate));

    expect(error.code).toBe("duplicate_tool");
    expect(registry.list().map((definition) => definition.id)).toEqual([
      first.id
    ]);
  });

  test("partial or malformed declarations fail closed with invalid_definition", () => {
    for (const definition of [
      partialDefinitionMissingVersion(),
      partialDefinitionMissingRequestedScopes(),
      definitionWithMalformedAdapter()
    ]) {
      expectRegistrationRejection(definition, "invalid_definition");
    }
  });

  test("normalization capabilities without a real output schema fail closed", () => {
    expectRegistrationRejection(
      modelDefinitionMissingOutputSchema(),
      "missing_output_schema"
    );
  });

  test("tierless and wrong-tier definitions fail closed", () => {
    for (const definition of [
      definitionMissingIsolationTier(),
      definitionWithWrongIsolationTier()
    ]) {
      expectRegistrationRejection(definition, "missing_isolation_tier");
    }
  });

  test("unmapped capability kinds fail closed with tierless_kind", () => {
    expectRegistrationRejection(definitionWithUnmappedKind(), "tierless_kind");
  });

  test("adapter kind mismatch fails closed with adapter_kind_mismatch", () => {
    expectRegistrationRejection(
      definitionWithAdapterKindMismatch(),
      "adapter_kind_mismatch"
    );
  });

  test("unknown tool id remains a denied ToolBroker result", async () => {
    const result = await createToolBroker({
      workspaceRoot,
      runId: "run_registry_unknown_tool"
    }).callTool(
      {
        toolId: "shell.exec",
        args: {
          command: "pwd"
        },
        reason: "Registry contract test for undeclared tool ids.",
        idempotencyKey: "registry:unknown-tool",
        requestedBy: {
          phase: "evidence"
        }
      },
      {
        traceId: "trace_registry_unknown_tool"
      }
    );

    expect(result.status).toBe("denied");
    expect(result.error?.code).toBe("tool_not_found");
    expect(result.provenance.toolVersion).toBe("undeclared");
  });
});

function expectRegistrationRejection(
  definition: CapabilityDefinition,
  code: ToolBrokerErrorCode
) {
  expect(() => new CapabilityRegistry([definition])).toThrow(ToolBrokerError);

  const registry = new CapabilityRegistry();
  const error = captureToolBrokerError(() => registry.register(definition));

  expect(error.code).toBe(code);
  expect(registry.list()).toEqual([]);
}

function captureToolBrokerError(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolBrokerError);
    return error as ToolBrokerError;
  }

  throw new Error("Expected ToolBrokerError.");
}

function brokerCapabilityBaselineRows(
  definitions: readonly CapabilityDefinition[]
) {
  return definitions.map((definition) => {
    const tierConstraints = deriveTierConstraints(definition);

    return {
      id: definition.id,
      kind: definition.kind,
      risk: definition.risk,
      requestedScopes: definition.requestedScopes,
      mutability: "read_only",
      durable: false,
      adapterSpecific: false,
      cacheEnabled: definition.cache.enabled,
      isolationTier: definition.isolationTier,
      execution: tierConstraints.execution,
      networkAllowlist: tierConstraints.networkAllowlist,
      subprocess: tierConstraints.subprocess,
      writeConfinement: tierConstraints.writeConfinement
    };
  });
}
