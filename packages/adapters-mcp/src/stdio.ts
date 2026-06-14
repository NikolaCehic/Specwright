import type { McpAdapter, McpErrorResponse } from "./index";
import { MCP_ADAPTER_PROTOCOL_VERSION } from "./versioning";

export const MCP_STDIO_SERVER_NAME = "specwright-mcp-adapter";
export const MCP_STDIO_PROTOCOL_VERSION = "2025-06-18";

const JSON_RPC_VERSION = "2.0";
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SUPPORTED_STDIO_PROTOCOL_VERSIONS = new Set([
  MCP_STDIO_PROTOCOL_VERSION,
  MCP_ADAPTER_PROTOCOL_VERSION
]);
const DISPATCH_METHODS = new Set([
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get"
]);

export type JsonRpcId = string | number | null;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: JsonRpcError;
    };

export type StdioStreamWriter = {
  write(chunk: string): void;
};

export type ServeMcpStdioOptions = {
  adapter: McpAdapter;
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: StdioStreamWriter;
  stderr?: StdioStreamWriter | undefined;
};

export async function serveMcpStdio(options: ServeMcpStdioOptions) {
  const decoder = new TextDecoder();
  let buffer = "";

  await options.adapter.observability?.openSession();

  try {
    for await (const chunk of options.stdin) {
      buffer +=
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer = await drainInputBuffer(buffer, options.adapter, options.stdout);
    }

    buffer += decoder.decode();

    if (buffer.trim().length > 0) {
      await writeLineResponse(buffer.trimEnd(), options.adapter, options.stdout);
    }
  } finally {
    await options.adapter.observability?.closeSession();
  }
}

export async function handleMcpJsonRpcLine(
  adapter: McpAdapter,
  line: string
): Promise<string | undefined> {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  let message: unknown;

  try {
    message = JSON.parse(trimmed);
  } catch {
    return JSON.stringify(
      jsonRpcError(null, PARSE_ERROR, "Parse error.", {
        code: "parse_error",
        message: "MCP stdio input must be one valid UTF-8 JSON-RPC message per line."
      })
    );
  }

  const response = await dispatchMcpJsonRpcMessage(adapter, message);

  return response === undefined ? undefined : JSON.stringify(response);
}

export async function dispatchMcpJsonRpcMessage(
  adapter: McpAdapter,
  message: unknown
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(message)) {
    if (message.length === 0) {
      return jsonRpcError(null, INVALID_REQUEST, "Invalid Request.", {
        code: "invalid_request",
        message: "JSON-RPC batches must contain at least one message."
      });
    }

    const responses: JsonRpcResponse[] = [];

    for (const entry of message) {
      const response = await dispatchSingleJsonRpcMessage(adapter, entry);

      if (response !== undefined) {
        responses.push(response);
      }
    }

    return responses.length === 0 ? undefined : responses;
  }

  return dispatchSingleJsonRpcMessage(adapter, message);
}

async function drainInputBuffer(
  buffer: string,
  adapter: McpAdapter,
  stdout: StdioStreamWriter
) {
  let nextBuffer = buffer;
  let newlineIndex = nextBuffer.indexOf("\n");

  while (newlineIndex >= 0) {
    const line = nextBuffer.slice(0, newlineIndex).trimEnd();
    nextBuffer = nextBuffer.slice(newlineIndex + 1);
    await writeLineResponse(line, adapter, stdout);
    newlineIndex = nextBuffer.indexOf("\n");
  }

  return nextBuffer;
}

async function writeLineResponse(
  line: string,
  adapter: McpAdapter,
  stdout: StdioStreamWriter
) {
  const response = await handleMcpJsonRpcLine(adapter, line);

  if (response !== undefined) {
    stdout.write(`${response}\n`);
  }
}

async function dispatchSingleJsonRpcMessage(
  adapter: McpAdapter,
  message: unknown
): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(message)) {
    return jsonRpcError(null, INVALID_REQUEST, "Invalid Request.", {
      code: "invalid_request",
      message: "JSON-RPC messages must be objects."
    });
  }

  if (isJsonRpcResponse(message)) {
    return undefined;
  }

  const id = jsonRpcIdFrom(message.id);
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");

  if (message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== "string") {
    return jsonRpcError(id ?? null, INVALID_REQUEST, "Invalid Request.", {
      code: "invalid_request",
      message: "MCP stdio messages must include jsonrpc: \"2.0\" and a method."
    });
  }

  if (!hasId) {
    return undefined;
  }

  if (id === undefined) {
    return jsonRpcError(null, INVALID_REQUEST, "Invalid Request.", {
      code: "invalid_request",
      message: "JSON-RPC id must be a string, number, or null."
    });
  }

  if (message.method === "initialize") {
    return initializeResponse(id, message.params);
  }

  if (message.method === "notifications/initialized") {
    return jsonRpcResult(id, {});
  }

  if (!DISPATCH_METHODS.has(message.method)) {
    return jsonRpcError(id, METHOD_NOT_FOUND, "Method not found.", {
      code: "method_not_found",
      message: `MCP method ${message.method} is not registered.`
    });
  }

  try {
    const dispatchResponse = await adapter.dispatch({
      method: message.method,
      ...(Object.prototype.hasOwnProperty.call(message, "params")
        ? { params: message.params }
        : {})
    });

    if (isMcpErrorResponse(dispatchResponse) && message.method !== "tools/call") {
      return jsonRpcErrorFromMcp(id, dispatchResponse);
    }

    return jsonRpcResult(
      id,
      protocolResultForAdapterResponse(message.method, dispatchResponse)
    );
  } catch (error) {
    return jsonRpcError(id, INTERNAL_ERROR, "Internal error.", {
      code: "internal_error",
      message: safeErrorMessage(error)
    });
  }
}

function initializeResponse(id: JsonRpcId, params: unknown): JsonRpcResponse {
  if (!isRecord(params) || typeof params.protocolVersion !== "string") {
    return jsonRpcError(id, INVALID_PARAMS, "Invalid params.", {
      code: "invalid_request",
      message: "initialize params must include a protocolVersion string.",
      supportedProtocolVersions: [...SUPPORTED_STDIO_PROTOCOL_VERSIONS].sort()
    });
  }

  if (!SUPPORTED_STDIO_PROTOCOL_VERSIONS.has(params.protocolVersion)) {
    return jsonRpcError(id, INVALID_PARAMS, "Unsupported protocol version.", {
      code: "unsupported_protocol_version",
      message: `MCP protocol version ${params.protocolVersion} is unsupported by ${MCP_STDIO_SERVER_NAME}.`,
      supportedProtocolVersions: [...SUPPORTED_STDIO_PROTOCOL_VERSIONS].sort()
    });
  }

  return jsonRpcResult(id, {
    protocolVersion: params.protocolVersion,
    capabilities: {
      tools: {
        listChanged: false
      },
      resources: {},
      prompts: {}
    },
    serverInfo: {
      name: MCP_STDIO_SERVER_NAME,
      version: MCP_ADAPTER_PROTOCOL_VERSION
    }
  });
}

function protocolResultForAdapterResponse(method: string, response: unknown) {
  if (method === "tools/list") {
    return toolsListResult(response);
  }

  if (method === "tools/call") {
    return toolCallResult(response);
  }

  if (method === "prompts/get" && isRecord(response) && response.isError === false) {
    const { content: _content, isError: _isError, ...prompt } = response;

    return prompt;
  }

  if (
    method === "resources/read" &&
    isRecord(response) &&
    response.isError === false
  ) {
    const { isError: _isError, payload, ...resource } = response;

    return {
      ...resource,
      structuredContent: payload
    };
  }

  return response;
}

function toolsListResult(response: unknown) {
  if (!isRecord(response) || !Array.isArray(response.tools)) {
    return response;
  }

  return {
    ...response,
    tools: response.tools.map((tool) => {
      if (!isRecord(tool)) {
        return tool;
      }

      const schemaRef = isRecord(tool.inputSchema)
        ? tool.inputSchema.schemaRef
        : undefined;
      const description = isRecord(tool.inputSchema)
        ? tool.inputSchema.description
        : undefined;

      return {
        ...tool,
        inputSchema: {
          type: "object",
          additionalProperties: true,
          ...(typeof description === "string" ? { description } : {}),
          ...(typeof schemaRef === "string"
            ? { "x-specwright-schemaRef": schemaRef }
            : {})
        }
      };
    })
  };
}

function toolCallResult(response: unknown) {
  if (!isRecord(response)) {
    return {
      content: textContent(response),
      structuredContent: response,
      isError: false
    };
  }

  if (isMcpErrorResponse(response)) {
    const structuredContent = structuredContentFromMcpContent(response.content);

    return {
      content: textContent(structuredContent),
      structuredContent,
      isError: true,
      error: response.error
    };
  }

  const result = response.result;

  return {
    content: textContent(result),
    structuredContent: result,
    isError: false
  };
}

function textContent(payload: unknown) {
  return [
    {
      type: "text",
      text: JSON.stringify(payload, null, 2)
    }
  ];
}

function structuredContentFromMcpContent(content: unknown) {
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    isRecord(content[0]) &&
    content[0].type === "json"
  ) {
    return content[0].json;
  }

  return content;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result
  };
}

function jsonRpcErrorFromMcp(
  id: JsonRpcId,
  response: McpErrorResponse
): JsonRpcResponse {
  return jsonRpcError(
    id,
    response.error.code === "method_not_found"
      ? METHOD_NOT_FOUND
      : INVALID_PARAMS,
    response.error.message,
    {
      code: response.error.code,
      retryable: response.error.retryable,
      operatorAction: response.error.operatorAction,
      ...(response.error.issues === undefined
        ? {}
        : { issues: response.error.issues }),
      ...(response.error.approvalId === undefined
        ? {}
        : { approvalId: response.error.approvalId }),
      ...(response.error.supportedProtocolRange === undefined
        ? {}
        : { supportedProtocolRange: response.error.supportedProtocolRange }),
      ...(response.error.contract === undefined
        ? {}
        : { contract: response.error.contract })
    }
  );
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

function jsonRpcIdFrom(value: unknown): JsonRpcId | undefined {
  return value === null || typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function isJsonRpcResponse(value: Record<string, unknown>) {
  return (
    value.jsonrpc === JSON_RPC_VERSION &&
    typeof value.method !== "string" &&
    ("result" in value || "error" in value)
  );
}

function isMcpErrorResponse(value: unknown): value is McpErrorResponse {
  return isRecord(value) && value.isError === true && isRecord(value.error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
