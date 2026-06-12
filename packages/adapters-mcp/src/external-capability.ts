import {
  isolationTierForKind,
  type CapabilityDefinition
} from "@specwright/tool-broker";
import {
  createExternalMcpCapabilityAdapter,
  type ExternalMcpTransport
} from "./external-capability-adapter";
import {
  externalMcpCapabilityId,
  findAllowedExternalMcpTool,
  parseExternalMcpManifest,
  type ExternalMcpTenantManifest
} from "./external-manifest";
import { externalMcpObservedOutputSchema } from "./external-observation";
import type { ExternalMcpQuarantineState } from "./external-quarantine";

export type CreateExternalMcpCapabilityDefinitionsOptions = {
  manifest: ExternalMcpTenantManifest | unknown;
  transport: ExternalMcpTransport;
  quarantine?: ExternalMcpQuarantineState | undefined;
};

export function createExternalMcpCapabilityDefinitions(
  options: CreateExternalMcpCapabilityDefinitionsOptions
): CapabilityDefinition[] {
  const manifest = parseExternalMcpManifest(options.manifest);
  const definitions: CapabilityDefinition[] = [];

  for (const server of [...manifest.servers].sort((left, right) =>
    left.serverId.localeCompare(right.serverId)
  )) {
    for (const tool of [...server.allowedTools].sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (server.deniedTools.includes(tool.name)) {
        continue;
      }

      findAllowedExternalMcpTool(server, tool.name);
      definitions.push({
        id: externalMcpCapabilityId(server.serverId, tool.name),
        kind: "mcp",
        description: tool.description,
        version: server.version,
        inputSchema: tool.inputSchema,
        outputSchema: externalMcpObservedOutputSchema(tool.outputSchema),
        adapter: createExternalMcpCapabilityAdapter({
          tenantId: manifest.tenantId,
          server,
          tool,
          transport: options.transport,
          quarantine: options.quarantine
        }),
        risk: tool.risk,
        requestedScopes: [...tool.requestedScopes],
        limits: capabilityLimitsFor(tool.limits),
        cache: { ...tool.cache },
        isolationTier: isolationTierForKind("mcp")
      });
    }
  }

  return definitions.sort((left, right) => left.id.localeCompare(right.id));
}

function capabilityLimitsFor(
  input: ExternalMcpTenantManifest["servers"][number]["allowedTools"][number]["limits"]
) {
  const limits: CapabilityDefinition["limits"] = {
    timeoutMs: input.timeoutMs
  };

  if (input.maxBytes !== undefined) {
    limits.maxBytes = input.maxBytes;
  }

  if (input.maxTokens !== undefined) {
    limits.maxTokens = input.maxTokens;
  }

  return limits;
}
