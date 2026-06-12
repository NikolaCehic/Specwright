import { z, type ZodTypeAny } from "zod";

export const EXTERNAL_MCP_CAPABILITY_ID_PREFIX = "mcp.call_tool/" as const;

const identifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "Use only letters, numbers, '.', '_', or '-'.");
const nonEmptyStringSchema = z.string().min(1);
const zodSchema = z.custom<ZodTypeAny>((value) => isZodType(value), {
  message: "Expected a Zod schema."
});

export const ExternalMcpNetworkTargetSchema = z
  .object({
    scheme: z.enum(["http", "https"]),
    host: nonEmptyStringSchema,
    port: z.number().int().positive().max(65535).optional()
  })
  .strict();
export type ExternalMcpNetworkTarget = z.infer<
  typeof ExternalMcpNetworkTargetSchema
>;

export const ExternalMcpSchemaDescriptorSchema = z
  .object({
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema.optional(),
    description: nonEmptyStringSchema.optional()
  })
  .strict();
export type ExternalMcpSchemaDescriptor = z.infer<
  typeof ExternalMcpSchemaDescriptorSchema
>;

export const ExternalMcpToolManifestSchema = z
  .object({
    name: identifierSchema,
    description: nonEmptyStringSchema,
    inputSchema: zodSchema,
    inputSchemaDescriptor: ExternalMcpSchemaDescriptorSchema.optional(),
    outputSchema: zodSchema,
    outputSchemaDescriptor: ExternalMcpSchemaDescriptorSchema.optional(),
    requestedScopes: z.array(nonEmptyStringSchema).nonempty(),
    risk: z.enum(["low", "medium", "high", "critical"]),
    limits: z
      .object({
        timeoutMs: z.number().int().positive(),
        maxBytes: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional()
      })
      .strict(),
    cache: z
      .object({
        enabled: z.boolean()
      })
      .strict()
  })
  .strict();
export type ExternalMcpToolManifest = z.infer<
  typeof ExternalMcpToolManifestSchema
>;

export const ExternalMcpServerManifestSchema = z
  .object({
    serverId: identifierSchema,
    version: nonEmptyStringSchema,
    endpoint: nonEmptyStringSchema,
    networkAllowlist: z.array(ExternalMcpNetworkTargetSchema).nonempty(),
    allowedTools: z.array(ExternalMcpToolManifestSchema).nonempty(),
    deniedTools: z.array(identifierSchema).default([]),
    allowedPhases: z.array(nonEmptyStringSchema).nonempty(),
    approval: z.enum(["none", "required"]),
    pinnedCredential: z.unknown().optional()
  })
  .strict()
  .superRefine((server, context) => {
    if (parseEndpoint(server.endpoint) === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message: "Endpoint must be an absolute http(s) URL without credentials."
      });
      return;
    }

    if (!isEndpointAllowlisted(server.endpoint, server.networkAllowlist)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message: "Endpoint is outside networkAllowlist."
      });
    }

    const denied = new Set(server.deniedTools);
    const seen = new Set<string>();
    for (const [index, tool] of server.allowedTools.entries()) {
      if (seen.has(tool.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedTools", index, "name"],
          message: "Duplicate allowed tool."
        });
      }

      if (denied.has(tool.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowedTools", index, "name"],
          message: "Tool cannot appear in both allowedTools and deniedTools."
        });
      }

      seen.add(tool.name);
    }
  });
export type ExternalMcpServerManifest = z.infer<
  typeof ExternalMcpServerManifestSchema
>;

export const ExternalMcpTenantManifestSchema = z
  .object({
    tenantId: identifierSchema,
    servers: z.array(ExternalMcpServerManifestSchema).nonempty()
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, server] of manifest.servers.entries()) {
      if (seen.has(server.serverId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["servers", index, "serverId"],
          message: "Duplicate server id."
        });
      }

      seen.add(server.serverId);
    }
  });
export type ExternalMcpTenantManifest = z.infer<
  typeof ExternalMcpTenantManifestSchema
>;

export type ExternalMcpManifestErrorCode =
  | "missing_manifest"
  | "invalid_manifest"
  | "server_not_found"
  | "tool_not_allowed"
  | "tool_denied"
  | "phase_not_permitted"
  | "network_not_allowlisted"
  | "client_token_relay_denied"
  | "external_version_mismatch"
  | "external_quarantined"
  | "unverifiable_target";

export class ExternalMcpManifestError extends Error {
  readonly code: ExternalMcpManifestErrorCode;

  constructor(code: ExternalMcpManifestErrorCode, message: string) {
    super(message);
    this.name = "ExternalMcpManifestError";
    this.code = code;
  }
}

export function parseExternalMcpManifest(
  manifestLike: unknown
): ExternalMcpTenantManifest {
  if (manifestLike === undefined || manifestLike === null) {
    throw new ExternalMcpManifestError(
      "missing_manifest",
      "External MCP tenant manifest is required."
    );
  }

  const parsed = ExternalMcpTenantManifestSchema.safeParse(manifestLike);
  if (!parsed.success) {
    throw new ExternalMcpManifestError(
      "invalid_manifest",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
        .join("; ")
    );
  }

  return parsed.data;
}

export function externalMcpCapabilityId(serverId: string, toolName: string) {
  return `${EXTERNAL_MCP_CAPABILITY_ID_PREFIX}${serverId}/${toolName}`;
}

export function findExternalMcpServer(
  manifest: ExternalMcpTenantManifest,
  serverId: string
) {
  const server = manifest.servers.find((candidate) => candidate.serverId === serverId);
  if (server === undefined) {
    throw new ExternalMcpManifestError(
      "server_not_found",
      `External MCP server ${serverId} is not declared.`
    );
  }

  return server;
}

export function findAllowedExternalMcpTool(
  server: ExternalMcpServerManifest,
  toolName: string
) {
  if (server.deniedTools.includes(toolName)) {
    throw new ExternalMcpManifestError(
      "tool_denied",
      `External MCP tool ${server.serverId}/${toolName} is denied.`
    );
  }

  const tool = server.allowedTools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new ExternalMcpManifestError(
      "tool_not_allowed",
      `External MCP tool ${server.serverId}/${toolName} is not allowlisted.`
    );
  }

  return tool;
}

export function assertExternalMcpPhaseAllowed(
  server: ExternalMcpServerManifest,
  phase: string
) {
  if (!server.allowedPhases.includes(phase)) {
    throw new ExternalMcpManifestError(
      "phase_not_permitted",
      `External MCP server ${server.serverId} is not permitted in phase ${phase}.`
    );
  }
}

export function assertExternalMcpEndpointAllowlisted(
  server: ExternalMcpServerManifest
) {
  if (parseEndpoint(server.endpoint) === undefined) {
    throw new ExternalMcpManifestError(
      "unverifiable_target",
      `External MCP server ${server.serverId} endpoint is not verifiable.`
    );
  }

  if (!isEndpointAllowlisted(server.endpoint, server.networkAllowlist)) {
    throw new ExternalMcpManifestError(
      "network_not_allowlisted",
      `External MCP server ${server.serverId} endpoint is outside networkAllowlist.`
    );
  }
}

export function isEndpointAllowlisted(
  endpoint: string,
  allowlist: readonly ExternalMcpNetworkTarget[]
) {
  const parsed = parseEndpoint(endpoint);
  if (parsed === undefined) {
    return false;
  }

  return allowlist.some((target) => {
    const targetPort = target.port ?? defaultPortForScheme(target.scheme);
    return (
      parsed.scheme === target.scheme &&
      parsed.host === target.host &&
      parsed.port === targetPort
    );
  });
}

function parseEndpoint(endpoint: string):
  | {
      scheme: "http" | "https";
      host: string;
      port: number;
    }
  | undefined {
  try {
    const url = new URL(endpoint) as unknown as {
      protocol: string;
      username: string;
      password: string;
      hostname: string;
      port: string;
    };
    const scheme = url.protocol.replace(":", "");
    if (scheme !== "http" && scheme !== "https") {
      return undefined;
    }

    if (url.username !== "" || url.password !== "") {
      return undefined;
    }

    return {
      scheme,
      host: url.hostname,
      port:
        url.port === ""
          ? defaultPortForScheme(scheme)
          : Number.parseInt(url.port, 10)
    };
  } catch {
    return undefined;
  }
}

function defaultPortForScheme(scheme: "http" | "https") {
  return scheme === "https" ? 443 : 80;
}

export function findClientCredentialPath(value: unknown): string | undefined {
  return findClientCredentialPathAt(value, []);
}

function findClientCredentialPathAt(
  value: unknown,
  path: readonly string[]
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findClientCredentialPathAt(value[index], [
        ...path,
        String(index)
      ]);
      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isCredentialKey(key)) {
      return nextPath.join(".");
    }

    const found = findClientCredentialPathAt(entry, nextPath);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function isCredentialKey(key: string) {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

  return [
    "authorization",
    "token",
    "xapikey",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "password",
    "clientsecret",
    "cookie"
  ].includes(normalized);
}

function isZodType(value: unknown): value is ZodTypeAny {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}
