import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createMcpAdapter,
  createRealRuntimeConformanceHarness,
  readMcpAuditRecords
} from "./index";
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
          harness.appDir,
          "--session-id",
          "stdio-local-test"
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

      const audit = await readMcpAuditRecords({
        rootDir: harness.appDir,
        sessionId: "stdio-local-test",
        includeIndex: true
      });

      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "mcp.session.opened",
            sessionId: "stdio-local-test",
            clientId: "local-stdio",
            subjectId: "local-user",
            tenantId: "local",
            transport: "stdio",
            protocolVersion: MCP_STDIO_PROTOCOL_VERSION
          }),
          expect.objectContaining({
            type: "mcp.session.closed",
            sessionId: "stdio-local-test",
            clientId: "local-stdio",
            subjectId: "local-user",
            tenantId: "local",
            requestCount: expect.any(Number)
          })
        ])
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("spawned CI profile injects auth context and filters tools by granted scopes", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const result = spawnMcpStdioProcess(
        [
          "--profile",
          "ci",
          "--root",
          harness.appDir,
          "--client-id",
          "ci-worker",
          "--tenant-id",
          "tenant-a",
          "--scopes",
          "run:read"
        ],
        mcpStdioInput([
          initializeMessage(),
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
              arguments: startRunArguments(harness.appDir)
            }
          }
        ])
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");

      const responses = parseJsonRpcLines(result.stdout);
      const toolNames = responses[1]?.result.tools.map(
        (tool: { name: string }) => tool.name
      );

      expect(toolNames).toEqual([
        "specwright_get_events",
        "specwright_get_next_action",
        "specwright_get_run",
        "specwright_replay"
      ]);
      expect(responses[2]).toMatchObject({
        id: 3,
        result: {
          isError: true,
          error: {
            code: "scope_exceeded"
          }
        }
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("spawned CI profile with run start scope can mutate runtime", async () => {
    const harness = await createRealRuntimeConformanceHarness();

    try {
      const result = spawnMcpStdioProcess(
        [
          "--profile",
          "ci",
          "--root",
          harness.appDir,
          "--client-id",
          "ci-worker",
          "--tenant-id",
          "tenant-a",
          "--scopes",
          "run:start,run:read",
          "--session-id",
          "stdio-ci-test"
        ],
        mcpStdioInput([
          initializeMessage(),
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
              arguments: startRunArguments(harness.appDir)
            }
          }
        ])
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");

      const responses = parseJsonRpcLines(result.stdout);
      const toolNames = responses[1]?.result.tools.map(
        (tool: { name: string }) => tool.name
      );

      expect(toolNames).toContain("specwright_start_run");
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

      const audit = await readMcpAuditRecords({
        rootDir: harness.appDir,
        sessionId: "stdio-ci-test",
        includeIndex: true
      });

      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "mcp.session.opened",
            sessionId: "stdio-ci-test",
            clientId: "ci-worker",
            subjectId: "ci-worker",
            tenantId: "tenant-a",
            grantedScopes: ["run:start", "run:read"],
            runMode: "assisted",
            transport: "stdio",
            protocolVersion: MCP_STDIO_PROTOCOL_VERSION
          }),
          expect.objectContaining({
            type: "mcp.session.closed",
            sessionId: "stdio-ci-test",
            clientId: "ci-worker",
            subjectId: "ci-worker",
            tenantId: "tenant-a",
            requestCount: expect.any(Number)
          })
        ])
      );
    } finally {
      await harness.cleanup();
    }
  });

  test("host config helper prints Codex TOML for local stdio without launching MCP", () => {
    const result = spawnMcpConfig([
      "--print-host-config",
      "codex",
      "--profile",
      "local-stdio",
      "--root",
      "fixtures/simple-app"
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('[mcp_servers."specwright"]');
    expect(result.stdout).toContain('command = "bun"');
    expect(result.stdout).toContain('"--profile", "local-stdio"');
    expect(result.stdout).toContain('cwd = "');
  });

  test("host config helper prints Claude MCP JSON for authenticated CI stdio", () => {
    const result = spawnMcpConfig([
      "--print-host-config",
      "claude-code",
      "--profile",
      "ci",
      "--root",
      "fixtures/simple-app",
      "--client-id",
      "ci-worker",
      "--tenant-id",
      "tenant-a",
      "--scopes",
      "run:read"
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      mcpServers: {
        specwright: {
          type: "stdio",
          command: "bun",
          args: expect.arrayContaining([
            expect.stringContaining("/packages/adapters-mcp/dist/bin.js"),
            "--profile",
            "ci",
            "--client-id",
            "ci-worker",
            "--tenant-id",
            "tenant-a",
            "--scopes",
            "run:read",
            "--subject-id",
            "ci-worker",
            "--run-mode",
            "assisted"
          ]),
          env: {}
        }
      }
    });
  });

  test("host config helper prints OpenCode local MCP JSON", () => {
    const result = spawnMcpConfig([
      "--print-host-config",
      "opencode",
      "--profile",
      "local-stdio",
      "--root",
      "fixtures/simple-app"
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        specwright: {
          type: "local",
          command: expect.arrayContaining([
            "bun",
            expect.stringContaining("/packages/adapters-mcp/dist/bin.js"),
            "--profile",
            "local-stdio"
          ]),
          enabled: true
        }
      }
    });
  });

  test("host config helper fails closed for unknown host targets", () => {
    const result = spawnMcpConfig([
      "--print-host-config",
      "unknown-host",
      "--profile",
      "local-stdio",
      "--root",
      "fixtures/simple-app"
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("codex, claude-code, opencode, or generic");
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

  test("process startup fails closed for CI profile without explicit scopes", () => {
    const result = spawnSync(
      "bun",
      [
        "packages/adapters-mcp/src/bin.ts",
        "--profile",
        "ci",
        "--root",
        ".",
        "--client-id",
        "ci-worker",
        "--tenant-id",
        "tenant-a"
      ],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--scopes");
  });
});

function initializeMessage() {
  return {
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
  };
}

function startRunArguments(appDir: string) {
  return {
    task: "Create a source-bound frontend contract",
    cwd: appDir,
    harnessId: "default",
    host: {
      kind: "mcp",
      version: MCP_STDIO_PROTOCOL_VERSION
    }
  };
}

function mcpStdioInput(messages: readonly unknown[]) {
  return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
}

function spawnMcpStdioProcess(args: readonly string[], input: string) {
  return spawnSync(
    "bun",
    ["packages/adapters-mcp/src/bin.ts", ...args],
    {
      cwd: repoRoot,
      input,
      encoding: "utf8"
    }
  );
}

function spawnMcpConfig(args: readonly string[]) {
  return spawnSync(
    "bun",
    ["packages/adapters-mcp/src/bin.ts", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8"
    }
  );
}

function parseJsonRpcLines(stdout: string) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
