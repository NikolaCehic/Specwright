import type {
  AdapterExecutionInput,
  AdapterExecutionResult,
  CapabilityAdapter
} from "@specwright/tool-broker";
import {
  assertExternalMcpEndpointAllowlisted,
  assertExternalMcpPhaseAllowed,
  findClientCredentialPath,
  type ExternalMcpServerManifest,
  type ExternalMcpToolManifest
} from "./external-manifest";
import { classifyExternalMcpObservation } from "./external-observation";
import type { ExternalMcpQuarantineState } from "./external-quarantine";

declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(timeoutId: unknown): void;

export type ExternalMcpTransportRequest = {
  tenantId: string;
  serverId: string;
  toolName: string;
  endpoint: string;
  pinnedVersion: string;
  credential: unknown;
  args: unknown;
  limits: AdapterExecutionInput["limits"];
};

export type ExternalMcpTransportResult = {
  serverVersion: string;
  output: unknown;
  metrics?: {
    durationMs?: number;
    bytesRead?: number;
    bytesWritten?: number;
  };
};

export type ExternalMcpTransport = (
  request: ExternalMcpTransportRequest
) => Promise<ExternalMcpTransportResult> | ExternalMcpTransportResult;

export type CreateExternalMcpCapabilityAdapterOptions = {
  tenantId: string;
  server: ExternalMcpServerManifest;
  tool: ExternalMcpToolManifest;
  transport: ExternalMcpTransport;
  quarantine?: ExternalMcpQuarantineState | undefined;
};

export function createExternalMcpCapabilityAdapter(
  options: CreateExternalMcpCapabilityAdapterOptions
): CapabilityAdapter {
  return {
    id: `external-mcp/${options.server.serverId}/${options.tool.name}`,
    version: options.server.version,
    kind: "mcp",
    async execute(input: AdapterExecutionInput): Promise<AdapterExecutionResult> {
      const quarantineKey = {
        serverId: options.server.serverId,
        toolName: options.tool.name,
        version: options.server.version
      };

      if (options.quarantine?.isQuarantined(quarantineKey)) {
        return failed("external_quarantined", "External MCP capability is quarantined.", false);
      }

      try {
        assertExternalMcpEndpointAllowlisted(options.server);
        assertExternalMcpPhaseAllowed(options.server, input.runContext.phase);
      } catch (error) {
        return failedFromUnknown(error);
      }

      const parsedArgs = options.tool.inputSchema.safeParse(input.args);
      if (!parsedArgs.success) {
        return failed(
          "invalid_request",
          parsedArgs.error.issues
            .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
            .join("; "),
          false
        );
      }

      const credentialPath = findClientCredentialPath(parsedArgs.data);
      if (credentialPath !== undefined) {
        return failed(
          "client_token_relay_denied",
          `External MCP args contain client credential field ${credentialPath} and were not relayed.`,
          false
        );
      }

      const transportRequest: ExternalMcpTransportRequest = {
        tenantId: options.tenantId,
        serverId: options.server.serverId,
        toolName: options.tool.name,
        endpoint: options.server.endpoint,
        pinnedVersion: options.server.version,
        credential: options.server.pinnedCredential,
        args: parsedArgs.data,
        limits: input.limits
      };

      const transportResult = await callWithTimeout(
        () => options.transport(transportRequest),
        input.limits.timeoutMs
      );

      if (transportResult.status === "timeout") {
        const result = failed(
          "external_timeout",
          `External MCP server ${options.server.serverId} timed out.`,
          true
        );
        options.quarantine?.recordAdapterResult(quarantineKey, result);
        return result;
      }

      if (transportResult.status === "failed") {
        const result = failed(
          "external_transport_error",
          transportResult.message,
          true
        );
        options.quarantine?.recordAdapterResult(quarantineKey, result);
        return result;
      }

      if (transportResult.result.serverVersion !== options.server.version) {
        const result = failed(
          "external_version_mismatch",
          `External MCP server ${options.server.serverId} returned version ${transportResult.result.serverVersion}; expected ${options.server.version}.`,
          false
        );
        options.quarantine?.recordAdapterResult(quarantineKey, result);
        return result;
      }

      const maxBytesResult = assertOutputWithinMaxBytes(
        transportResult.result.output,
        input.limits.maxBytes
      );
      if (maxBytesResult !== undefined) {
        options.quarantine?.recordAdapterResult(quarantineKey, maxBytesResult);
        return maxBytesResult;
      }

      const parsedOutput = options.tool.outputSchema.safeParse(
        transportResult.result.output
      );
      if (!parsedOutput.success) {
        const result = failed(
          "output_invalid",
          parsedOutput.error.issues
            .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
            .join("; "),
          false
        );
        options.quarantine?.recordAdapterResult(quarantineKey, result);
        return result;
      }

      const result: AdapterExecutionResult = {
        status: "success",
        output: classifyExternalMcpObservation({
          serverId: options.server.serverId,
          pinnedVersion: options.server.version,
          toolName: options.tool.name,
          args: parsedArgs.data,
          output: parsedOutput.data
        })
      };

      if (transportResult.result.metrics !== undefined) {
        result.metrics = transportResult.result.metrics;
      }

      options.quarantine?.recordAdapterResult(quarantineKey, result);
      return result;
    }
  };
}

function assertOutputWithinMaxBytes(
  output: unknown,
  maxBytes: number | undefined
): AdapterExecutionResult | undefined {
  if (maxBytes === undefined) {
    return undefined;
  }

  const bytes = JSON.stringify(output)?.length ?? 0;
  if (bytes <= maxBytes) {
    return undefined;
  }

  return failed(
    "external_max_bytes_exceeded",
    `External MCP output exceeded maxBytes (${maxBytes}).`,
    false
  );
}

async function callWithTimeout(
  call: () => Promise<ExternalMcpTransportResult> | ExternalMcpTransportResult,
  timeoutMs: number
): Promise<
  | { status: "success"; result: ExternalMcpTransportResult }
  | { status: "timeout" }
  | { status: "failed"; message: string }
> {
  let timeoutId: unknown;

  try {
    return await Promise.race([
      Promise.resolve()
        .then(call)
        .then((result) => ({ status: "success", result }) as const)
        .catch((error: unknown) => ({
          status: "failed" as const,
          message: error instanceof Error ? error.message : String(error)
        })),
      new Promise<{ status: "timeout" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function failed(
  code: string,
  message: string,
  retryable: boolean
): AdapterExecutionResult {
  return {
    status: "failed",
    error: {
      code,
      message,
      retryable
    }
  };
}

function failedFromUnknown(error: unknown): AdapterExecutionResult {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return failed(
      (error as { code: string }).code,
      error instanceof Error ? error.message : String((error as { code: string }).code),
      false
    );
  }

  return failed("external_manifest_error", String(error), false);
}
