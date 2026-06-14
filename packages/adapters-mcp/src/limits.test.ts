import { describe, expect, test } from "bun:test";
import { DEFAULT_FS_READ_MAX_BYTES, DEFAULT_TOOL_TIMEOUT_MS } from "@specwright/tool-broker";
import {
  AdapterLimitConfigError,
  createAdapterLimitController,
  createMcpAdapter,
  DEFAULT_ADAPTER_LIMITS,
  measureMcpPayloadBytes
} from "./index";
import { fakeRuntimeForPacket06 } from "../test/packet06-test-helpers";

describe("Packet 06 MCP operability limits", () => {
  test("malformed limit config fails closed", () => {
    expect(() =>
      createAdapterLimitController({
        concurrentSessionsPerTenant: 0
      })
    ).toThrow(AdapterLimitConfigError);
    expect(() =>
      createAdapterLimitController({
        toolCallRate: {
          capacity: -1
        }
      })
    ).toThrow(AdapterLimitConfigError);
  });

  test("defaults mirror broker read and external timeout limits", () => {
    expect(DEFAULT_ADAPTER_LIMITS.resourceReadMaxBytes).toBe(DEFAULT_FS_READ_MAX_BYTES);
    expect(DEFAULT_ADAPTER_LIMITS.externalTimeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  test("session admission rejects over tenant cap with retryable metadata", () => {
    const controller = createAdapterLimitController({
      concurrentSessionsPerTenant: 1,
      sessionIdleTimeoutMs: 10_000
    });

    expect(controller.openSession({
      sessionId: "session-a",
      tenantId: "tenant-a",
      nowMs: 0
    })).toEqual({ ok: true });
    expect(controller.openSession({
      sessionId: "session-b",
      tenantId: "tenant-a",
      nowMs: 1
    })).toMatchObject({
      ok: false,
      code: "session_limit_exceeded",
      retryable: true,
      retryAfterMs: 10_000,
      limit: "concurrentSessionsPerTenant"
    });
  });

  test("inflight semaphore sheds load before a second same-session request", () => {
    const controller = createAdapterLimitController({
      inflightRequestsPerSession: 1
    });
    const first = controller.acquireRequest(baseRequest({ nowMs: 0 }));

    expect("release" in first).toBe(true);
    const second = controller.acquireRequest(baseRequest({ nowMs: 1 }));
    expect(second).toMatchObject({
      ok: false,
      code: "backpressure",
      retryable: true,
      limit: "inflightRequestsPerSession"
    });

    if ("release" in first) {
      first.release();
    }
  });

  test("token bucket returns deterministic retryable backpressure", () => {
    const controller = createAdapterLimitController({
      toolCallRate: {
        capacity: 1,
        refillTokens: 1,
        refillIntervalMs: 1000
      }
    });
    const first = controller.acquireRequest(baseRequest({ nowMs: 0 }));
    if ("release" in first) {
      first.release();
    }

    expect(controller.acquireRequest(baseRequest({ nowMs: 100 }))).toMatchObject({
      ok: false,
      code: "backpressure",
      retryable: true,
      retryAfterMs: 900,
      limit: "toolCallRate"
    });

    const refilled = controller.acquireRequest(baseRequest({ nowMs: 1000 }));
    expect("release" in refilled).toBe(true);
    if ("release" in refilled) {
      refilled.release();
    }
  });

  test("payload, projection byte, list page, and idle timeout guards are bounded", () => {
    const controller = createAdapterLimitController({
      requestPayloadMaxBytes: 32,
      resourceReadMaxBytes: 8,
      resourceListMaxPageSize: 2,
      sessionIdleTimeoutMs: 10
    });

    expect(controller.acquireRequest({
      ...baseRequest({ kind: "read", nowMs: 0 }),
      payloadBytes: 64
    })).toMatchObject({
      ok: false,
      code: "payload_too_large",
      retryable: false,
      limit: "requestPayloadMaxBytes"
    });
    expect(controller.checkResourceReadBytes(9)).toMatchObject({
      ok: false,
      code: "projection_too_large",
      retryable: false,
      limit: "resourceReadMaxBytes"
    });
    expect(controller.boundedPage(["a", "b", "c", "d"], {
      cursor: 1,
      pageSize: 10
    })).toEqual({
      page: ["b", "c"],
      pagination: {
        cursor: 1,
        requestedPageSize: 10,
        pageSize: 2,
        maxPageSize: 2,
        bounded: true,
        nextCursor: 3
      }
    });

    const lease = controller.acquireRequest(baseRequest({
      kind: "read",
      nowMs: 0
    }));
    expect("release" in lease).toBe(true);
    if ("release" in lease) {
      lease.release();
    }
    expect(controller.acquireRequest(baseRequest({
      kind: "read",
      nowMs: 11
    }))).toMatchObject({
      ok: false,
      code: "session_idle_timeout",
      retryable: true,
      retryAfterMs: 0,
      limit: "sessionIdleTimeoutMs"
    });
  });

  test("adapter over-limit sheds side-effecting load before RuntimeApi mutation", async () => {
    const calls: string[] = [];
    const adapter = createMcpAdapter(fakeRuntimeForPacket06({ calls }), {
      limits: {
        requestPayloadMaxBytes: 20
      }
    });
    const response = await adapter.tools.call({
      name: "specwright_start_run",
      arguments: {
        task: "This oversized payload must be denied before startRun",
        cwd: "/tmp/specwright",
        harnessId: "default",
        host: {
          kind: "mcp",
          version: "2026-05-29"
        }
      }
    });

    expect(response).toMatchObject({
      isError: true,
      error: {
        code: "payload_too_large",
        retryable: false
      }
    });
    expect(calls).toEqual([]);
  });

  test("adapter resources/list applies bounded pagination metadata", () => {
    const response = createMcpAdapter(fakeRuntimeForPacket06(), {
      limits: {
        resourceListMaxPageSize: 3
      }
    }).resources.list({
      cursor: 2,
      pageSize: 50
    });

    if ("isError" in response) {
      throw new Error(response.error.message);
    }

    expect(response.resources).toHaveLength(3);
    expect(response.pagination).toMatchObject({
      cursor: 2,
      requestedPageSize: 50,
      pageSize: 3,
      maxPageSize: 3,
      bounded: true,
      nextCursor: 5
    });
  });

  test("operational state snapshot is authority-free and reconstructable", async () => {
    const calls: string[] = [];
    const controller = createAdapterLimitController({
      toolCallRate: {
        capacity: 1,
        refillTokens: 1,
        refillIntervalMs: 10_000
      }
    });
    const runtime = fakeRuntimeForPacket06({ calls });
    const adapter = createMcpAdapter(runtime, {
      limitController: controller
    });

    const first = await adapter.tools.call({
      name: "specwright_get_run",
      arguments: {
        runId: "run-1"
      }
    });
    const denied = await adapter.tools.call({
      name: "specwright_call_tool",
      arguments: {
        runId: "run-1",
        request: {
          toolId: "fs.list",
          args: {
            path: "."
          },
          reason: "rate guard",
          idempotencyKey: "idem-rate",
          requestedBy: {
            phase: "intake"
          }
        }
      }
    });

    expect(first.isError).toBe(false);
    expect(denied).toMatchObject({
      isError: true,
      error: {
        code: "backpressure",
        retryable: true
      }
    });
    expect(calls).toEqual(["getRun"]);
    expect(controller.snapshotOperationalState().authorityFree).toBe(true);

    controller.clearOperationalState();
    expect(controller.snapshotOperationalState()).toMatchObject({
      sessions: [],
      tenantSessionCounts: [],
      tokenBuckets: [],
      authorityFree: true
    });

    const afterClear = await adapter.tools.call({
      name: "specwright_get_run",
      arguments: {
        runId: "run-1"
      }
    });

    expect(afterClear.isError).toBe(false);
    expect(calls).toEqual(["getRun", "getRun"]);
  });

  test("payload byte measurement is deterministic utf8 JSON length", () => {
    expect(measureMcpPayloadBytes({ ok: "yes" })).toBe(Buffer.byteLength(JSON.stringify({ ok: "yes" }), "utf8"));
  });
});

function baseRequest(input: {
  kind?: "tool-call" | "read" | "list" | "prompt";
  nowMs: number;
}) {
  return {
    sessionId: "session-1",
    tenantId: "tenant-a",
    clientId: "client-1",
    kind: input.kind ?? "tool-call",
    payloadBytes: 1,
    nowMs: input.nowMs
  };
}
