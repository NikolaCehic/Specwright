import { z } from "zod";
import { isolationTierForKind } from "../../src/index";
import type {
  AdapterExecutionResult,
  CapabilityAdapter,
  CapabilityDefinition,
  CapabilityKind
} from "../../src/index";

const RegistryTextInputSchema = z
  .object({
    prompt: z.string().min(1)
  })
  .strict();

const RegistryTextOutputSchema = z
  .object({
    text: z.string()
  })
  .strict();

const RegistryMcpInputSchema = z
  .object({
    serverId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.record(z.string(), z.unknown())
  })
  .strict();

const RegistryMcpOutputSchema = z
  .object({
    serverId: z.string().min(1),
    toolName: z.string().min(1),
    result: z.unknown()
  })
  .strict();

const RegistryFsInputSchema = z
  .object({
    path: z.string().min(1)
  })
  .strict();

const RegistryFsOutputSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean()
  })
  .strict();

type DefinitionOverrides = Partial<CapabilityDefinition>;

export function validMultiKindDefinitions(): CapabilityDefinition[] {
  return [
    createValidMcpDefinition({ id: "fixture.mcp.call" }),
    createValidFilesystemDefinition({ id: "fixture.fs.inspect" }),
    createValidModelDefinition({ id: "fixture.model.generate" })
  ];
}

export function createValidFilesystemDefinition(
  overrides: DefinitionOverrides = {}
): CapabilityDefinition {
  return withOverrides(
    {
      id: "fixture.fs.inspect",
      kind: "filesystem",
      description: "Inspect a filesystem fixture declaration.",
      version: "0.1.0",
      inputSchema: RegistryFsInputSchema,
      outputSchema: RegistryFsOutputSchema,
      adapter: createRegistryFixtureAdapter(
        "filesystem",
        "registry-fixture/filesystem"
      ),
      risk: "low",
      requestedScopes: ["workspace:read"],
      limits: {
        timeoutMs: 1_000,
        maxBytes: 4_096
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("filesystem")
    },
    overrides
  );
}

export function createValidModelDefinition(
  overrides: DefinitionOverrides = {}
): CapabilityDefinition {
  return withOverrides(
    {
      id: "fixture.model.generate",
      kind: "model",
      description: "Declare a model fixture capability with normalized output.",
      version: "0.1.0",
      inputSchema: RegistryTextInputSchema,
      outputSchema: RegistryTextOutputSchema,
      adapter: createRegistryFixtureAdapter("model", "registry-fixture/model"),
      risk: "medium",
      requestedScopes: ["model:generate"],
      limits: {
        timeoutMs: 2_000,
        maxTokens: 1_000
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("model")
    },
    overrides
  );
}

export function createValidMcpDefinition(
  overrides: DefinitionOverrides = {}
): CapabilityDefinition {
  return withOverrides(
    {
      id: "fixture.mcp.call",
      kind: "mcp",
      description: "Declare an MCP fixture capability with normalized output.",
      version: "0.1.0",
      inputSchema: RegistryMcpInputSchema,
      outputSchema: RegistryMcpOutputSchema,
      adapter: createRegistryFixtureAdapter("mcp", "registry-fixture/mcp"),
      risk: "medium",
      requestedScopes: ["mcp:call"],
      limits: {
        timeoutMs: 2_000,
        maxBytes: 16_384
      },
      cache: {
        enabled: false
      },
      isolationTier: isolationTierForKind("mcp")
    },
    overrides
  );
}

export function partialDefinitionMissingVersion(): CapabilityDefinition {
  const definition = createValidFilesystemDefinition({
    id: "fixture.partial.missing-version"
  }) as Partial<CapabilityDefinition>;

  delete definition.version;
  return definition as CapabilityDefinition;
}

export function partialDefinitionMissingRequestedScopes(): CapabilityDefinition {
  const definition = createValidFilesystemDefinition({
    id: "fixture.partial.missing-scopes"
  }) as Partial<CapabilityDefinition>;

  delete definition.requestedScopes;
  return definition as CapabilityDefinition;
}

export function modelDefinitionMissingOutputSchema(): CapabilityDefinition {
  const definition = createValidModelDefinition({
    id: "fixture.model.missing-output-schema"
  }) as Partial<CapabilityDefinition>;

  delete definition.outputSchema;
  return definition as CapabilityDefinition;
}

export function definitionMissingIsolationTier(): CapabilityDefinition {
  const definition = createValidFilesystemDefinition({
    id: "fixture.fs.missing-isolation-tier"
  }) as Partial<CapabilityDefinition>;

  delete definition.isolationTier;
  return definition as CapabilityDefinition;
}

export function definitionWithWrongIsolationTier(): CapabilityDefinition {
  return createValidFilesystemDefinition({
    id: "fixture.fs.wrong-isolation-tier",
    isolationTier: 1
  });
}

export function definitionWithUnmappedKind(): CapabilityDefinition {
  return createValidFilesystemDefinition({
    id: "fixture.unmapped-kind",
    kind: "unmapped" as CapabilityKind
  });
}

export function definitionWithAdapterKindMismatch(): CapabilityDefinition {
  return createValidFilesystemDefinition({
    id: "fixture.fs.adapter-kind-mismatch",
    adapter: createRegistryFixtureAdapter(
      "model",
      "registry-fixture/model-for-filesystem"
    )
  });
}

export function definitionWithMalformedAdapter(): CapabilityDefinition {
  return createValidFilesystemDefinition({
    id: "fixture.fs.malformed-adapter",
    adapter: {
      id: "registry-fixture/malformed-adapter",
      version: "0.1.0",
      kind: "filesystem",
      execute: "not-a-function" as unknown as CapabilityAdapter["execute"]
    }
  });
}

export function duplicateIdDefinitions(): readonly [
  CapabilityDefinition,
  CapabilityDefinition
] {
  return [
    createValidFilesystemDefinition({ id: "fixture.duplicate" }),
    createValidModelDefinition({ id: "fixture.duplicate" })
  ];
}

function withOverrides(
  definition: CapabilityDefinition,
  overrides: DefinitionOverrides
): CapabilityDefinition {
  return {
    ...definition,
    ...overrides
  };
}

function createRegistryFixtureAdapter(
  kind: CapabilityKind,
  id: string
): CapabilityAdapter {
  return {
    id,
    version: "0.1.0",
    kind,
    async execute(): Promise<AdapterExecutionResult> {
      return {
        status: "failed",
        error: {
          code: "registry_fixture_not_executable",
          message: "Registry fixture adapters are declaration-only.",
          retryable: false
        }
      };
    }
  };
}
