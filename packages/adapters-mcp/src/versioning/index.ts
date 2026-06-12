export const MCP_ADAPTER_PROTOCOL_VERSION = "2026-05-29";

export type McpProtocolVersionRange = {
  min: string;
  max: string;
};

export const SUPPORTED_MCP_PROTOCOL_RANGE = {
  min: "2026-05-29",
  max: "2026-05-29"
} as const satisfies McpProtocolVersionRange;

export type McpProtocolNegotiationResult =
  | {
      ok: true;
      agreedVersion: string;
      supportedRange: McpProtocolVersionRange;
    }
  | {
      ok: false;
      code: "unsupported_protocol_version" | "invalid_protocol_version";
      offeredVersion: string;
      supportedRange: McpProtocolVersionRange;
      retryable: false;
      message: string;
    };

export type McpCompatibilityClass =
  | "patch-compatible"
  | "additive-compatible"
  | "forward-compatible"
  | "backward-compatible"
  | "migration-required"
  | "breaking";

export type McpContractKind = "tool" | "resource" | "prompt";

export type McpDeprecationNotice = {
  since: string;
  removeAfter: string;
  replacement?: string | undefined;
  migrationNote: string;
};

export type McpContractVersion = {
  kind: McpContractKind;
  id: string;
  version: string;
  compatibilityClass: McpCompatibilityClass;
  deprecation?: McpDeprecationNotice | undefined;
  migrationRequiredFrom?: readonly string[] | undefined;
  migrationNote?: string | undefined;
};

export type McpContractDescriptorMetadata = {
  id: string;
  version: string;
  compatibilityClass: McpCompatibilityClass;
  deprecation?: McpDeprecationNotice | undefined;
};

export type McpContractVersionRequirementResult =
  | {
      ok: true;
      contract: McpContractVersion;
    }
  | {
      ok: false;
      code: "contract_version_required" | "migration_required";
      contract: McpContractVersion;
      requestedVersion?: string | undefined;
      retryable: false;
      migrationNote: string;
    };

export type McpContractRegistry = {
  readonly contracts: readonly McpContractVersion[];
  readonly byId: ReadonlyMap<string, McpContractVersion>;
  readonly byKindAndName: ReadonlyMap<string, McpContractVersion>;
};

export type McpContractRegistryInput = {
  tools: readonly { name: string }[];
  resources: readonly { id: string }[];
  prompts: readonly { name: string }[];
  overrides?: readonly Partial<McpContractVersion>[];
};

export function negotiateProtocolVersion(
  offeredVersion: string,
  supportedRange: McpProtocolVersionRange = SUPPORTED_MCP_PROTOCOL_RANGE
): McpProtocolNegotiationResult {
  if (!isProtocolVersion(offeredVersion)) {
    return {
      ok: false,
      code: "invalid_protocol_version",
      offeredVersion,
      supportedRange,
      retryable: false,
      message: `MCP protocol version ${offeredVersion} is malformed; supported range is ${supportedRange.min}..${supportedRange.max}.`
    };
  }

  if (
    compareProtocolVersions(offeredVersion, supportedRange.min) < 0 ||
    compareProtocolVersions(offeredVersion, supportedRange.max) > 0
  ) {
    return {
      ok: false,
      code: "unsupported_protocol_version",
      offeredVersion,
      supportedRange,
      retryable: false,
      message: `MCP protocol version ${offeredVersion} is unsupported; supported range is ${supportedRange.min}..${supportedRange.max}.`
    };
  }

  return {
    ok: true,
    agreedVersion: offeredVersion,
    supportedRange
  };
}

export function createMcpContractRegistry(
  input: McpContractRegistryInput
): McpContractRegistry {
  const overrides = new Map<string, Partial<McpContractVersion>>();

  for (const override of input.overrides ?? []) {
    if (override.id !== undefined) {
      overrides.set(override.id, override);
    }
  }

  const contracts = [
    ...input.tools.map((tool) =>
      contractWithOverride(
        {
          kind: "tool" as const,
          id: contractId("tool", tool.name),
          version: "1.0.0",
          compatibilityClass: "backward-compatible" as const
        },
        overrides
      )
    ),
    ...input.resources.map((resource) =>
      contractWithOverride(
        {
          kind: "resource" as const,
          id: contractId("resource", resource.id),
          version: "1.0.0",
          compatibilityClass: "backward-compatible" as const
        },
        overrides
      )
    ),
    ...input.prompts.map((prompt) =>
      contractWithOverride(
        {
          kind: "prompt" as const,
          id: contractId("prompt", prompt.name),
          version: "1.0.0",
          compatibilityClass: "backward-compatible" as const
        },
        overrides
      )
    )
  ];

  const byId = new Map<string, McpContractVersion>();
  const byKindAndName = new Map<string, McpContractVersion>();

  for (const contract of contracts) {
    if (byId.has(contract.id)) {
      throw new McpVersioningError(
        "duplicate_contract_id",
        `MCP contract ${contract.id} is registered more than once.`
      );
    }

    byId.set(contract.id, contract);
    byKindAndName.set(kindNameKey(contract.kind, nameFromContractId(contract.id)), contract);
  }

  return {
    contracts,
    byId,
    byKindAndName
  };
}

export function contractId(kind: McpContractKind, name: string) {
  return `specwright.mcp.${kind}.${name}.v1`;
}

export function contractDescriptorMetadata(
  contract: McpContractVersion
): McpContractDescriptorMetadata {
  return {
    id: contract.id,
    version: contract.version,
    compatibilityClass: contract.compatibilityClass,
    ...(contract.deprecation === undefined
      ? {}
      : { deprecation: contract.deprecation })
  };
}

export function contractForName(
  registry: McpContractRegistry,
  kind: McpContractKind,
  name: string
): McpContractVersion {
  const contract = registry.byKindAndName.get(kindNameKey(kind, name));

  if (contract === undefined) {
    throw new McpVersioningError(
      "missing_contract_version",
      `MCP ${kind} ${name} is missing a registered contract version.`
    );
  }

  return contract;
}

export function requireSupportedContractVersion(input: {
  registry: McpContractRegistry;
  kind: McpContractKind;
  name: string;
  requestedVersion?: string | undefined;
  requireClientVersion?: boolean | undefined;
}): McpContractVersionRequirementResult {
  const contract = contractForName(input.registry, input.kind, input.name);

  if (input.requireClientVersion === true && input.requestedVersion === undefined) {
    return {
      ok: false,
      code: "contract_version_required",
      contract,
      retryable: false,
      migrationNote:
        contract.migrationNote ??
        `Client must send contract version ${contract.version} for ${contract.id}.`
    };
  }

  if (
    input.requestedVersion !== undefined &&
    input.requestedVersion !== contract.version
  ) {
    return {
      ok: false,
      code: "migration_required",
      contract,
      requestedVersion: input.requestedVersion,
      retryable: false,
      migrationNote:
        contract.migrationNote ??
        `Client requested ${input.requestedVersion}; migrate to ${contract.id}@${contract.version}.`
    };
  }

  return {
    ok: true,
    contract
  };
}

export class McpVersioningError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpVersioningError";
    this.code = code;
  }
}

function contractWithOverride(
  base: McpContractVersion,
  overrides: ReadonlyMap<string, Partial<McpContractVersion>>
): McpContractVersion {
  const override = overrides.get(base.id);

  if (override === undefined) {
    return base;
  }

  return {
    ...base,
    ...override,
    kind: base.kind,
    id: base.id
  };
}

function kindNameKey(kind: McpContractKind, name: string) {
  return `${kind}:${name}`;
}

function nameFromContractId(id: string) {
  const match = /^specwright\.mcp\.(tool|resource|prompt)\.(.+)\.v1$/.exec(id);

  if (match === null || match[2] === undefined) {
    throw new McpVersioningError(
      "invalid_contract_id",
      `MCP contract id ${id} does not match the local contract id format.`
    );
  }

  return match[2];
}

function isProtocolVersion(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function compareProtocolVersions(left: string, right: string) {
  return left.localeCompare(right);
}
