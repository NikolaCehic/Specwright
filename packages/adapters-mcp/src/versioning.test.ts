import { describe, expect, test } from "bun:test";
import {
  MCP_ADAPTER_PROTOCOL_VERSION,
  contractId,
  createMcpAdapter,
  negotiateProtocolVersion
} from "./index";
import { fakeRuntimeForPacket06 } from "../test/packet06-test-helpers";

describe("Packet 06 MCP versioning", () => {
  test("unsupported protocol version is rejected with supported range and never coerced", () => {
    const negotiation = negotiateProtocolVersion("2020-01-01");

    expect(negotiation).toMatchObject({
      ok: false,
      code: "unsupported_protocol_version",
      supportedRange: {
        min: MCP_ADAPTER_PROTOCOL_VERSION,
        max: MCP_ADAPTER_PROTOCOL_VERSION
      }
    });

    const adapter = createMcpAdapter(fakeRuntimeForPacket06(), {
      versioning: {
        clientProtocolVersion: "2020-01-01"
      }
    });

    expect(adapter.tools.list()).toMatchObject({
      isError: true,
      tools: [],
      error: {
        code: "unsupported_protocol_version",
        supportedProtocolRange: {
          min: MCP_ADAPTER_PROTOCOL_VERSION,
          max: MCP_ADAPTER_PROTOCOL_VERSION
        }
      }
    });
  });

  test("in-range protocol version agrees and descriptors carry contract metadata", () => {
    const adapter = createMcpAdapter(fakeRuntimeForPacket06(), {
      versioning: {
        clientProtocolVersion: MCP_ADAPTER_PROTOCOL_VERSION
      }
    });
    const tools = adapter.tools.list();
    const resources = adapter.resources.list();
    const prompts = adapter.prompts.list();

    expect(tools).toMatchObject({
      protocol: {
        version: MCP_ADAPTER_PROTOCOL_VERSION
      }
    });

    if ("tools" in tools && !("isError" in tools)) {
      expect(tools.tools.every((tool) => tool.metadata.contract?.id)).toBe(true);
      expect(tools.tools.every((tool) => tool.metadata.contract?.version === "1.0.0")).toBe(true);
      expect(
        tools.tools.every(
          (tool) =>
            tool.metadata.contract?.compatibilityClass === "backward-compatible"
        )
      ).toBe(true);
    }

    if ("resources" in resources && !("isError" in resources)) {
      expect(resources.resources.every((resource) => resource.metadata.contract?.id)).toBe(true);
    }

    if ("prompts" in prompts && !("isError" in prompts)) {
      expect(prompts.prompts.every((prompt) => prompt.metadata.contract?.id)).toBe(true);
    }
  });

  test("deprecated contract remains served through notice window with metadata", () => {
    const deprecatedId = contractId("tool", "specwright_get_run");
    const adapter = createMcpAdapter(fakeRuntimeForPacket06(), {
      versioning: {
        contractOverrides: [
          {
            id: deprecatedId,
            deprecation: {
              since: "1.1.0",
              removeAfter: "2.0.0",
              replacement: "specwright://runs/<run-id>/state",
              migrationNote: "Use the run-state resource for read-heavy clients."
            }
          }
        ]
      }
    });
    const response = adapter.tools.list();

    if ("isError" in response) {
      throw new Error(response.error.message);
    }

    expect(
      response.tools.find((tool) => tool.name === "specwright_get_run")?.metadata
        .contract
    ).toMatchObject({
      id: deprecatedId,
      deprecation: {
        since: "1.1.0",
        removeAfter: "2.0.0",
        replacement: "specwright://runs/<run-id>/state"
      }
    });
  });

  test("missing or migration-required contract version returns explicit migration error", async () => {
    const calls: string[] = [];
    const adapter = createMcpAdapter(fakeRuntimeForPacket06({ calls }), {
      versioning: {
        requireClientContractVersions: true,
        contractOverrides: [
          {
            id: contractId("tool", "specwright_get_run"),
            compatibilityClass: "migration-required",
            migrationNote: "Rename client binding to specwright_get_run@1.0.0."
          }
        ]
      }
    });

    const missing = await adapter.tools.call({
      name: "specwright_get_run",
      arguments: {
        runId: "run-1"
      }
    });
    const stale = await adapter.tools.call({
      name: "specwright_get_run",
      contractVersion: "0.9.0",
      arguments: {
        runId: "run-1"
      }
    });

    expect(missing).toMatchObject({
      isError: true,
      error: {
        code: "contract_version_required",
        contract: {
          id: contractId("tool", "specwright_get_run"),
          version: "1.0.0"
        }
      }
    });
    expect(stale).toMatchObject({
      isError: true,
      error: {
        code: "migration_required",
        contract: {
          requestedVersion: "0.9.0",
          migrationNote: "Rename client binding to specwright_get_run@1.0.0."
        }
      }
    });
    expect(calls).toEqual([]);
  });
});
