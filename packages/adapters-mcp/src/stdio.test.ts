import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMcpAdapter, createRealRuntimeConformanceHarness } from "./index";
import {
  MCP_STDIO_PROTOCOL_VERSION,
  dispatchMcpJsonRpcMessage,
  handleMcpJsonRpcLine
} from "./stdio";
import { fakeRuntimeForPacket06 } from "../test/packet06-test-helpers";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("MCP stdio transport", () => {
  test("initialize negotiates JSON-RPC capabilities without adapter runtime calls", async () => {
    const adapter = createMcpAdapter(fakeRuntimeForPacket06());
    const response = await dispatchMcpJsonRpcMessage(adapter, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "specwright-test",
          version: "1.0.0"
        }
      }
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          },
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: "specwright-mcp-adapter"
        }
      }
    });
  });

  test("tools/list is wrapped as JSON-RPC and exposes MCP-shaped tool schemas", async () => {
    const adapter = createMcpAdapter(fakeRuntimeForPacket06());
    const line = await handleMcpJsonRpcLine(
      adapter,
      JSON.stringify({
        jsonrpc: "2.0",
        id: "tools",
        method: "tools/list"
      })
    );

    expect(line).toBeDefined();
    const response = JSON.parse(line ?? "{}");

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "tools"
    });
    expect(Array.isArray(response.result.tools)).toBe(true);

    const callTool = response.result.tools.find(
      (tool: { name?: string }) => tool.name === "specwright_call_tool"
    );

    expect(callTool).toMatchObject({
      name: "specwright_call_tool",
      inputSchema: {
        type: "object",
        additionalProperties: true
      }
    });
    expect(callTool.inputSchema["x-specwright-schemaRef"]).toBe(
      "specwright://RuntimeApi.callTool.arguments"
    );
  });

  test("tool errors stay MCP tool results instead of becoming transport failures", async () => {
    const adapter = createMcpAdapter(fakeRuntimeForPacket06());
    const response = await dispatchMcpJsonRpcMessage(adapter, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "specwright_record_approval",
        arguments: {}
      }
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        isError: true,
        content: [
          {
            type: "text"
          }
        ],
        error: {
          code: "invalid_request"
        }
      }
    });
  });

  test("spawned local stdio process initializes, lists tools, mutates runtime, and exits cleanly", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const input = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_STDIO_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "spawn-test",
              version: "1.0.0"
            }
          }
        },
        {
          jsonrpc: "2.0",
          method: "notifications/initialized"
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list"
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "specwright_start_run",
            arguments: {
              task: "Create a source-bound frontend contract",
              cwd: harness.appDir,
              harnessId: "default",
              host: {
                kind: "mcp",
                version: MCP_STDIO_PROTOCOL_VERSION
              }
            }
          }
        }
      ]
        .map((message) => JSON.stringify(message))
        .join("\n");

      const result = spawnSync(
        "bun",
        [
          "packages/adapters-mcp/src/bin.ts",
          "--profile",
          "local-stdio",
          "--root",
          harness.appDir
        ],
        {
          cwd: repoRoot,
          input: `${input}\n`,
          encoding: "utf8"
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");

      const responses = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(responses).toHaveLength(3);
      expect(responses[0]).toMatchObject({
        id: 1,
        result: {
          protocolVersion: MCP_STDIO_PROTOCOL_VERSION
        }
      });
      expect(responses[1]).toMatchObject({
        id: 2,
        result: {
          tools: expect.any(Array)
        }
      });
      expect(responses[2]).toMatchObject({
        id: 3,
        result: {
          isError: false,
          structuredContent: {
            runId: expect.any(String),
            state: {
              status: "running"
            }
          }
        }
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("process startup fails closed without an explicit local profile", () => {
    const result = spawnSync(
      "bun",
      ["packages/adapters-mcp/src/bin.ts", "--root", "."],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--profile local-stdio");
  });
});
