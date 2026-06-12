import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createRun, readEvents } from "@specwright/run-store";
import { readTrace, recordTraceSpan } from "@specwright/trace-recorder";
import type { RuntimeApi } from "@specwright/runtime";
import {
  MCP_METRIC_NAMES,
  McpAuditRecordSchema,
  createMcpAdapter,
  createMcpAuditWriter,
  createMcpMetricsRegistry,
  readMcpAuditRecords,
  resolveMcpCorrelation,
  buildMcpAuditExport,
  type McpAuditRecord,
  type McpAuditWriter,
  type McpSpanWriter
} from "../index";

describe("Packet 05 MCP observability, audit, and provenance", () => {
  test("audit schemas validate every record type and reject malformed records", () => {
    const records = allAuditRecordFixtures();

    for (const record of records) {
      expect(McpAuditRecordSchema.safeParse(record).success, record.type).toBe(true);
    }

    const denied = records.find((record) => record.type === "mcp.action.denied");
    expect(denied).toBeDefined();
    const { policyDecisionRef: _policyDecisionRef, ...deniedWithoutRef } =
      denied as Extract<McpAuditRecord, { type: "mcp.action.denied" }>;

    expect(McpAuditRecordSchema.safeParse(deniedWithoutRef).success).toBe(false);
    const dispatched = records.find(
      (record) => record.type === "mcp.action.dispatched"
    );
    expect(dispatched).toBeDefined();
    expect(
      McpAuditRecordSchema.safeParse({
        ...dispatched,
        eventIds: []
      }).success
    ).toBe(false);
    expect(
      McpAuditRecordSchema.safeParse({
        type: "mcp.request.received",
        timestamp: "2026-06-01T00:00:00.000Z"
      }).success
    ).toBe(false);
  });

  test("writer persists durable audit files and rejects invalid records before write", async () => {
    const rootDir = await tempRoot();
    const writer = createMcpAuditWriter({ rootDir });
    const record = allAuditRecordFixtures()[2];

    await writer.write(record);

    const records = await readMcpAuditRecords({ rootDir, includeIndex: true });
    expect(records.map((item) => item.type)).toContain("mcp.request.received");

    await expect(
      writer.write({
        ...record,
        mcpRequestId: ""
      })
    ).rejects.toThrow("schema validation");
  });

  test("tools/call writes parent span, child link, audit records, metrics, and four-way correlation", async () => {
    const rootDir = await tempRoot();
    const ids = deterministicIds();
    await createFixtureRun(rootDir);
    const metrics = createMcpMetricsRegistry();
    const adapter = createMcpAdapter(realDurableRuntime(rootDir), {
      observability: observedOptions(rootDir, ids, metrics)
    });

    await adapter.observability?.openSession();
    const response = await adapter.tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(rootDir)
    });
    await adapter.observability?.closeSession();

    expect(response.isError).toBe(false);

    const audit = await readMcpAuditRecords({
      rootDir,
      runId: "run-packet-05",
      includeIndex: true
    });
    const dispatched = audit.find((record) => record.type === "mcp.action.dispatched");
    const external = audit.find((record) => record.type === "mcp.external.invoked");

    expect(dispatched).toMatchObject({
      type: "mcp.action.dispatched",
      mcpRequestId: "mcp_req_1",
      runId: "run-packet-05",
      runtimeOperation: "callTool",
      traceId: "trace-packet-05",
      toolProvenance: {
        toolId: "external.crm.lookup",
        toolVersion: "2026.06",
        argsHash: "sha256:tool-args",
        resultHash: "sha256:tool-result",
        cacheStatus: "miss",
        traceId: "trace-packet-05",
        adapterVersion: "external-adapter-1",
        decisionHash: "sha256:decision"
      }
    });
    expect(external).toMatchObject({
      type: "mcp.external.invoked",
      serverId: "crm-prod",
      pinnedVersion: "2026.06",
      toolName: "lookup_account",
      argsHash: "sha256:external-args",
      resultHash: "sha256:external-result",
      trustClass: "external_observation"
    });

    const trace = await readTrace({ rootDir, runId: "run-packet-05" });
    const parent = trace.spans.find((span) => span.kind === "mcp");
    const child = trace.spans.find((span) => span.kind === "tool");

    expect(parent).toMatchObject({
      spanId: "mcp_span_1",
      metadata: {
        mcpRequestId: "mcp_req_1",
        clientId: "client-1",
        subjectId: "subject-1"
      }
    });
    expect(parent?.parentSpanId).toBeUndefined();
    expect(child).toMatchObject({
      parentSpanId: "mcp_span_1"
    });

    const eventId = (dispatched as Extract<McpAuditRecord, { type: "mcp.action.dispatched" }>).eventIds[0];
    const byRequest = await resolveMcpCorrelation({
      rootDir,
      mcpRequestId: "mcp_req_1"
    });
    const byTrace = await resolveMcpCorrelation({
      rootDir,
      traceId: "trace-packet-05"
    });
    const byRun = await resolveMcpCorrelation({
      rootDir,
      runId: "run-packet-05"
    });
    const byEvent = await resolveMcpCorrelation({
      rootDir,
      eventId
    });

    for (const resolution of [byRequest, byTrace, byRun, byEvent]) {
      expect(resolution.mcpRequestIds).toContain("mcp_req_1");
      expect(resolution.traceIds).toContain("trace-packet-05");
      expect(resolution.runIds).toContain("run-packet-05");
      expect(resolution.eventIds).toContain(eventId);
    }

    const metricNames = metricNamesFromSnapshot(metrics.snapshot());
    expect(metricNames).toContain("mcp_requests_total");
    expect(metricNames).toContain("mcp_request_duration_ms");
    expect(metricNames).toContain("mcp_external_calls_total");
    expect(metricNames).toContain("mcp_active_sessions");
  });

  test("resolver keeps same-run MCP requests separated unless linked by explicit edges", async () => {
    const rootDir = await tempRoot();
    const writer = createMcpAuditWriter({ rootDir });
    const created = await createRun({
      rootDir,
      runId: "run-correlation",
      traceId: "trace-bootstrap",
      input: validRunInput(rootDir),
      harness: {
        id: "default",
        version: "0.1.0",
        specHash: "sha256:harness"
      },
      timestamp: "2026-06-01T00:00:00.000Z"
    });
    const eventA = await appendEvent({
      rootDir,
      runId: created.runId,
      type: "tool.completed",
      traceId: "trace-a",
      payload: {
        request: minimalToolRequest("tool.a"),
        result: minimalToolResult("tool.a", "trace-a", "sha256:decision-a")
      },
      timestamp: "2026-06-01T00:00:01.000Z"
    });
    const eventB = await appendEvent({
      rootDir,
      runId: created.runId,
      type: "tool.completed",
      traceId: "trace-b",
      payload: {
        request: minimalToolRequest("tool.b"),
        result: minimalToolResult("tool.b", "trace-b", "sha256:decision-b")
      },
      timestamp: "2026-06-01T00:00:02.000Z"
    });

    await Promise.all([
      writer.write(requestReceivedRecord("audit-req-a", "mcp_req_a", "tool.a")),
      writer.write(requestReceivedRecord("audit-req-b", "mcp_req_b", "tool.b")),
      writer.write(
        actionDispatchedRecord(
          "audit-action-a",
          "mcp_req_a",
          created.runId,
          "trace-a",
          [eventA.event.id]
        )
      ),
      writer.write(
        actionDispatchedRecord(
          "audit-action-b",
          "mcp_req_b",
          created.runId,
          "trace-b",
          [eventB.event.id]
        )
      ),
      recordTraceSpan({
        rootDir,
        runId: created.runId,
        traceId: "trace-a",
        span: {
          spanId: "mcp-span-a",
          kind: "mcp",
          name: "mcp.tools/call.tool.a",
          status: "success",
          startedAt: "2026-06-01T00:00:01.000Z",
          endedAt: "2026-06-01T00:00:01.000Z",
          eventIds: [eventA.event.id],
          metadata: {
            mcpRequestId: "mcp_req_a"
          }
        }
      }),
      recordTraceSpan({
        rootDir,
        runId: created.runId,
        traceId: "trace-b",
        span: {
          spanId: "mcp-span-b",
          kind: "mcp",
          name: "mcp.tools/call.tool.b",
          status: "success",
          startedAt: "2026-06-01T00:00:02.000Z",
          endedAt: "2026-06-01T00:00:02.000Z",
          eventIds: [eventB.event.id],
          metadata: {
            mcpRequestId: "mcp_req_b"
          }
        }
      })
    ]);

    const byRequestA = await resolveMcpCorrelation({
      rootDir,
      mcpRequestId: "mcp_req_a"
    });
    const byTraceA = await resolveMcpCorrelation({
      rootDir,
      traceId: "trace-a"
    });
    const byEventA = await resolveMcpCorrelation({
      rootDir,
      eventId: eventA.event.id
    });

    const expectedA = {
      mcpRequestIds: ["mcp_req_a"],
      traceIds: ["trace-a"],
      runIds: ["run-correlation"],
      eventIds: [eventA.event.id],
      sessionIds: ["session-1"],
      clientIds: ["client-1"],
      subjectIds: ["subject-1"]
    };

    expect(byRequestA).toEqual(expectedA);
    expect(byTraceA).toEqual(expectedA);
    expect(byEventA).toEqual(expectedA);
  });

  test("denied and approval-required outcomes persist policyDecisionRef", async () => {
    const deniedRoot = await tempRoot();
    await createFixtureRun(deniedRoot);
    await createMcpAdapter(
      outcomeRuntime({
        rootDir: deniedRoot,
        status: "denied",
        code: "policy_denied",
        decisionHash: "sha256:policy-denied"
      }),
      {
        observability: observedOptions(deniedRoot, deterministicIds())
      }
    ).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(deniedRoot)
    });

    const deniedAudit = await readMcpAuditRecords({
      rootDir: deniedRoot,
      runId: "run-packet-05",
      includeIndex: true
    });
    const deniedRecord = deniedAudit.find(
      (record) => record.type === "mcp.action.denied"
    );

    expect(deniedRecord).toEqual({
      schemaVersion: "specwright.mcp.audit.v1",
      recordId: "audit_3",
      type: "mcp.action.denied",
      timestamp: "2026-06-01T00:00:04.000Z",
      sessionId: "session-1",
      mcpRequestId: "mcp_req_1",
      denialCode: "policy_denied",
      gate: "PolicyVerdict",
      target: "specwright_call_tool",
      runId: "run-packet-05",
      traceId: "trace-packet-05",
      policyDecisionRef: "sha256:policy-denied",
      principal: {
        clientId: "client-1",
        subjectId: "subject-1",
        tenantId: "tenant-a",
        grantedScopes: ["tool:call", "run:read"]
      }
    });

    const approvalRoot = await tempRoot();
    await createFixtureRun(approvalRoot);
    await createMcpAdapter(
      outcomeRuntime({
        rootDir: approvalRoot,
        status: "approval_required",
        code: "approval_required",
        decisionHash: "sha256:approval-required"
      }),
      {
        observability: observedOptions(approvalRoot, deterministicIds())
      }
    ).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(approvalRoot)
    });

    const approvalAudit = await readMcpAuditRecords({
      rootDir: approvalRoot,
      runId: "run-packet-05",
      includeIndex: true
    });
    const approvalRecord = approvalAudit.find(
      (record) => record.type === "mcp.action.denied"
    );

    expect(approvalRecord).toEqual({
      schemaVersion: "specwright.mcp.audit.v1",
      recordId: "audit_3",
      type: "mcp.action.denied",
      timestamp: "2026-06-01T00:00:04.000Z",
      sessionId: "session-1",
      mcpRequestId: "mcp_req_1",
      denialCode: "approval_required",
      gate: "approval",
      target: "specwright_call_tool",
      runId: "run-packet-05",
      traceId: "trace-packet-05",
      policyDecisionRef: "sha256:approval-required",
      principal: {
        clientId: "client-1",
        subjectId: "subject-1",
        tenantId: "tenant-a",
        grantedScopes: ["tool:call", "run:read"]
      }
    });
  });

  test("adapter denials synthesize stable policyDecisionRef values", async () => {
    const rootDir = await tempRoot();
    const response = await createMcpAdapter(realDurableRuntime(rootDir), {
      observability: observedOptions(rootDir, deterministicIds())
    }).tools.call({
      name: "missing_tool",
      arguments: {}
    });

    expect(response).toMatchObject({
      isError: true,
      error: {
        code: "method_not_found"
      }
    });

    const deniedAudit = await readMcpAuditRecords({
      rootDir,
      includeIndex: true
    });
    const deniedRecord = deniedAudit.find(
      (record) => record.type === "mcp.action.denied"
    );

    expect(deniedRecord).toMatchObject({
      type: "mcp.action.denied",
      mcpRequestId: "mcp_req_1",
      denialCode: "method_not_found",
      gate: "adapter",
      target: "missing_tool"
    });
    expect(
      (deniedRecord as Extract<McpAuditRecord, { type: "mcp.action.denied" }>)
        .policyDecisionRef
    ).toMatch(/^sha256:mcp-denial:[0-9a-f]{64}$/);
  });

  test("side-effecting operations fail closed on audit and span partial writes", async () => {
    const auditRoot = await tempRoot();
    await createFixtureRun(auditRoot);
    const auditResponse = await createMcpAdapter(realDurableRuntime(auditRoot), {
      observability: {
        ...observedOptions(auditRoot, deterministicIds()),
        auditWriter: faultingAuditWriter(
          createMcpAuditWriter({ rootDir: auditRoot }),
          new Set(["mcp.action.dispatched"])
        ),
        markerWriter: createMcpAuditWriter({ rootDir: auditRoot })
      }
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(auditRoot)
    });

    expect(auditResponse).toMatchObject({
      isError: true,
      error: {
        code: "provenance_gap",
        retryable: true
      }
    });
    expect(
      (await readMcpAuditRecords({ rootDir: auditRoot, includeIndex: true })).some(
        (record) => record.type === "mcp.provenance_gap"
      )
    ).toBe(true);

    const spanRoot = await tempRoot();
    await createFixtureRun(spanRoot);
    const spanResponse = await createMcpAdapter(realDurableRuntime(spanRoot), {
      observability: {
        ...observedOptions(spanRoot, deterministicIds()),
        spanWriter: faultingSpanWriter()
      }
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(spanRoot)
    });

    expect(spanResponse).toMatchObject({
      isError: true,
      error: {
        code: "provenance_gap",
        retryable: true
      }
    });
  });

  test("mutating tools fail closed when post-mutation runtime events cannot be read", async () => {
    const rootDir = await tempRoot();
    await createFixtureRun(rootDir);
    const runtime = {
      ...realDurableRuntime(rootDir),
      async getEvents() {
        throw new Error("forced post-mutation event read failure");
      }
    };

    const response = await createMcpAdapter(runtime, {
      observability: observedOptions(rootDir, deterministicIds())
    }).tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(rootDir)
    });

    expect(response).toMatchObject({
      isError: true,
      error: {
        code: "provenance_gap",
        retryable: true
      }
    });

    const auditRecords = await readMcpAuditRecords({
      rootDir,
      includeIndex: true
    });
    expect(
      auditRecords.some(
        (record) =>
          record.type === "mcp.action.dispatched" &&
          record.eventIds.length === 0
      )
    ).toBe(false);
    expect(
      auditRecords.some((record) => record.type === "mcp.action.dispatched")
    ).toBe(false);
    expect(
      auditRecords.some((record) => record.type === "mcp.provenance_gap")
    ).toBe(true);
  });

  test("read-path audit failure serves the read and writes a provenance_gap marker", async () => {
    const rootDir = await tempRoot();
    await createFixtureRun(rootDir);
    const response = await createMcpAdapter(realDurableRuntime(rootDir), {
      observability: {
        ...observedOptions(rootDir, deterministicIds()),
        auditWriter: faultingAuditWriter(
          createMcpAuditWriter({ rootDir }),
          new Set(["mcp.resource.read"])
        ),
        markerWriter: createMcpAuditWriter({ rootDir })
      }
    }).resources.read({
      uri: "specwright://runs/run-packet-05/events",
      options: { rootDir }
    });

    expect(response.isError).toBe(false);
    expect(
      (await readMcpAuditRecords({ rootDir, includeIndex: true })).some(
        (record) => record.type === "mcp.provenance_gap"
      )
    ).toBe(true);
  });

  test("read-path marker failure returns provenance_gap instead of serving the read", async () => {
    const rootDir = await tempRoot();
    await createFixtureRun(rootDir);
    const response = await createMcpAdapter(realDurableRuntime(rootDir), {
      observability: {
        ...observedOptions(rootDir, deterministicIds()),
        auditWriter: faultingAuditWriter(
          createMcpAuditWriter({ rootDir }),
          new Set(["mcp.resource.read"])
        ),
        markerWriter: faultingAuditWriter(
          createMcpAuditWriter({ rootDir }),
          new Set(["mcp.provenance_gap"])
        )
      }
    }).resources.read({
      uri: "specwright://runs/run-packet-05/events",
      options: { rootDir }
    });

    expect(response).toMatchObject({
      isError: true,
      error: {
        code: "provenance_gap",
        retryable: true
      }
    });
    expect(
      (await readMcpAuditRecords({ rootDir, includeIndex: true })).map(
        (record) => record.type
      )
    ).not.toContain("mcp.provenance_gap");
  });

  test("audit export bundles events, traces, records, external calls, redactions, hashes, and provenance gaps", async () => {
    const rootDir = await tempRoot();
    await createFixtureRun(rootDir);
    const ids = deterministicIds();
    const adapter = createMcpAdapter(realDurableRuntime(rootDir), {
      observability: observedOptions(rootDir, ids)
    });

    await adapter.tools.call({
      name: "specwright_call_tool",
      arguments: validToolCallArguments(rootDir)
    });
    await adapter.resources.read({
      uri: "specwright://runs/run-packet-05/events",
      options: { rootDir }
    });

    const bundle = await buildMcpAuditExport({
      rootDir,
      runId: "run-packet-05",
      generatedBy: "packet-05-test",
      generatedAt: "2026-06-01T00:00:10.000Z",
      migrationNotes: ["no migration required"]
    });

    expect(bundle.runtimeEvents.length).toBeGreaterThan(0);
    expect(bundle.includedEventRange.eventHashes.length).toBe(bundle.runtimeEvents.length);
    expect(bundle.trace?.spans.some((span) => span.kind === "mcp")).toBe(true);
    expect(bundle.mcpAuditRecords.some((record) => record.type === "mcp.request.received")).toBe(true);
    expect(bundle.redactionProfiles.length).toBe(1);
    expect(bundle.externalInvocations).toHaveLength(1);
    expect(bundle.versions.traceRecorder).toBe("0.1.0");
    expect(bundle.migrationNotes).toContain("no migration required");
    expect(bundle.integrityHash).toMatch(/^sha256:/);
    expect(bundle.provenanceGaps).toEqual([]);

    const writer = createMcpAuditWriter({ rootDir });
    await writer.write({
      schemaVersion: "specwright.mcp.audit.v1",
      recordId: "audit-untraceable",
      type: "mcp.action.dispatched",
      timestamp: "2026-06-01T00:00:11.000Z",
      mcpRequestId: "mcp_req_untraceable",
      runId: "run-packet-05",
      runtimeOperation: "callTool",
      eventIds: ["missing-event"],
      traceId: "trace-packet-05"
    });

    const flagged = await buildMcpAuditExport({
      rootDir,
      runId: "run-packet-05",
      generatedBy: "packet-05-test"
    });

    expect(flagged.provenanceGaps.length).toBeGreaterThan(0);
  });

  test("audit export flags MCP-originated runs without an MCP audit trail", async () => {
    const rootDir = await tempRoot();
    await createFixtureRun(rootDir);

    const bundle = await buildMcpAuditExport({
      rootDir,
      runId: "run-packet-05",
      generatedBy: "packet-05-test"
    });

    expect(bundle.mcpAuditRecords).toEqual([]);
    expect(bundle.provenanceGaps).toEqual([
      expect.objectContaining({
        code: "provenance_gap",
        runId: "run-packet-05",
        reason:
          "MCP-originated run has no complete durable MCP audit, span, and principal trail."
      })
    ]);
  });

  test("metrics registry exposes all ten derived metric names without gating operations", () => {
    const metrics = createMcpMetricsRegistry();

    metrics.incrementCounter("mcp_denials_total", { denialCode: "policy_denied" });
    metrics.incrementCounter("mcp_approval_required_total", { toolName: "tool" });
    metrics.incrementCounter("mcp_external_calls_total", { serverId: "server", outcome: "success" });
    metrics.incrementCounter("mcp_external_failures_total", { serverId: "server", errorCode: "timeout" });
    metrics.incrementCounter("mcp_redactions_total", { redactionProfile: "audit" });
    metrics.incrementCounter("mcp_stale_state_rejections_total", { toolName: "tool" });
    metrics.incrementCounter("mcp_schema_incompat_total", { clientProtocolVersion: "old" });
    metrics.incrementCounter("mcp_requests_total", { operation: "tools/call", outcome: "success" });
    metrics.observeDuration({ operation: "tools/call", outcome: "success" }, 12);
    metrics.setGauge("mcp_active_sessions", { tenantId: "tenant-a" }, 1);

    expect(metricNamesFromSnapshot(metrics.snapshot()).sort()).toEqual(
      [...MCP_METRIC_NAMES].sort()
    );
  });
});

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "specwright-mcp-packet-05-"));
}

async function createFixtureRun(rootDir: string) {
  await createRun({
    rootDir,
    runId: "run-packet-05",
    traceId: "trace-packet-05",
    input: validRunInput(rootDir),
    harness: {
      id: "default",
      version: "0.1.0",
      specHash: "sha256:harness"
    },
    timestamp: "2026-06-01T00:00:00.000Z"
  });
}

function realDurableRuntime(rootDir: string): RuntimeApi {
  return {
    async startRun() {
      throw new Error("not used");
    },
    async getRun() {
      throw new Error("not used");
    },
    async getEvents(runId) {
      return readEvents({ rootDir, runId });
    },
    async replay(runId) {
      const events = await readEvents({ rootDir, runId });
      return {
        state: {
          runId,
          status: "running",
          phase: "created",
          harness: {
            id: "default",
            version: "0.1.0",
            specHash: "sha256:harness"
          },
          budgets: {},
          pendingApprovals: [],
          pendingQuestions: [],
          artifacts: [],
          lastEventId: events.at(-1)?.id
        },
        events
      };
    },
    async callTool(runId, request, options) {
      const requested = await appendEvent({
        rootDir,
        runId,
        type: "tool.requested",
        payload: { request },
        traceId: options?.traceId ?? "trace-packet-05",
        timestamp: "2026-06-01T00:00:01.000Z"
      });
      const result = {
        toolCallId: "tool-call-packet-05",
        status: "success" as const,
        output: {
          data: { ok: true },
          externalObservation: {
            class: "external_observation",
            sourceAuthority: "external",
            evidenceClass: "unknown",
            serverId: "crm-prod",
            pinnedVersion: "2026.06",
            toolName: "lookup_account",
            argsHash: "sha256:external-args",
            resultHash: "sha256:external-result"
          }
        },
        provenance: {
          toolId: "external.crm.lookup",
          toolVersion: "2026.06",
          argsHash: "sha256:tool-args",
          resultHash: "sha256:tool-result",
          cacheStatus: "miss" as const,
          traceId: "trace-packet-05",
          adapterVersion: "external-adapter-1",
          decisionHash: "sha256:decision"
        }
      };
      const completed = await appendEvent({
        rootDir,
        runId,
        type: "tool.completed",
        payload: {
          request,
          result
        },
        traceId: result.provenance.traceId,
        causationId: requested.event.id,
        timestamp: "2026-06-01T00:00:02.000Z"
      });

      await recordTraceSpan({
        rootDir,
        runId,
        traceId: result.provenance.traceId,
        span: {
          spanId: "runtime-tool-span",
          kind: "tool",
          name: "tool.external.crm.lookup",
          status: "success",
          startedAt: requested.event.timestamp,
          endedAt: completed.event.timestamp,
          eventIds: [requested.event.id, completed.event.id],
          metadata: {
            toolId: result.provenance.toolId,
            toolVersion: result.provenance.toolVersion,
            toolCallId: result.toolCallId,
            cacheStatus: result.provenance.cacheStatus
          }
        }
      });

      return result;
    },
    async runEval() {
      throw new Error("not used");
    },
    async recordEvidence() {
      throw new Error("not used");
    },
    async recordArtifact() {
      throw new Error("not used");
    },
    async evaluateGate() {
      throw new Error("not used");
    },
    async generateReport() {
      throw new Error("not used");
    },
    async writeRunReport() {
      throw new Error("not used");
    }
  };
}

function outcomeRuntime(input: {
  rootDir: string;
  status: "denied" | "approval_required";
  code: string;
  decisionHash: string;
}): RuntimeApi {
  return {
    ...realDurableRuntime(input.rootDir),
    async callTool(runId, request, options) {
      const requested = await appendEvent({
        rootDir: input.rootDir,
        runId,
        type: "tool.requested",
        payload: { request },
        traceId: options?.traceId ?? "trace-packet-05",
        timestamp: "2026-06-01T00:00:01.000Z"
      });
      const result = {
        toolCallId: `tool-call-${input.status}`,
        status: input.status,
        error: {
          code: input.code,
          message:
            input.status === "denied"
              ? "Policy denied tool call."
              : "Approval is required before execution.",
          retryable: false
        },
        provenance: {
          toolId: request.toolId,
          toolVersion: "2026.06",
          argsHash: "sha256:tool-args",
          cacheStatus: "bypass" as const,
          traceId: "trace-packet-05",
          decisionHash: input.decisionHash,
          ...(input.status === "approval_required"
            ? { approvalId: "approval-1" }
            : {})
        }
      };
      const completed = await appendEvent({
        rootDir: input.rootDir,
        runId,
        type: input.status === "denied" ? "tool.denied" : "tool.completed",
        payload: {
          request,
          result
        },
        traceId: result.provenance.traceId,
        causationId: requested.event.id,
        timestamp: "2026-06-01T00:00:02.000Z"
      });

      await recordTraceSpan({
        rootDir: input.rootDir,
        runId,
        traceId: result.provenance.traceId,
        span: {
          spanId: `runtime-tool-span-${input.status}`,
          kind: "tool",
          name: `tool.${request.toolId}`,
          status: input.status,
          startedAt: requested.event.timestamp,
          endedAt: completed.event.timestamp,
          eventIds: [requested.event.id, completed.event.id],
          metadata: {
            toolId: result.provenance.toolId,
            toolVersion: result.provenance.toolVersion,
            toolCallId: result.toolCallId,
            toolStatus: input.status,
            cacheStatus: result.provenance.cacheStatus,
            policyStatus: input.status,
            errorCode: input.code
          }
        }
      });

      return result;
    }
  };
}

function minimalToolRequest(toolId: string) {
  return {
    toolId,
    args: {},
    reason: `Call ${toolId}.`,
    idempotencyKey: `idem-${toolId}`,
    requestedBy: {
      phase: "created"
    }
  };
}

function minimalToolResult(
  toolId: string,
  traceId: string,
  decisionHash: string
) {
  return {
    toolCallId: `tool-call-${toolId}`,
    status: "success" as const,
    output: {
      ok: true
    },
    provenance: {
      toolId,
      toolVersion: "1.0.0",
      argsHash: `sha256:${toolId}-args`,
      resultHash: `sha256:${toolId}-result`,
      cacheStatus: "miss" as const,
      traceId,
      adapterVersion: "1.0.0",
      decisionHash
    }
  };
}

function requestReceivedRecord(
  recordId: string,
  mcpRequestId: string,
  target: string
): Extract<McpAuditRecord, { type: "mcp.request.received" }> {
  return {
    schemaVersion: "specwright.mcp.audit.v1",
    recordId,
    type: "mcp.request.received",
    timestamp: "2026-06-01T00:00:00.000Z",
    sessionId: "session-1",
    mcpRequestId,
    operation: "tools/call",
    target,
    argsHash: `sha256:${target}-args`,
    principal: {
      clientId: "client-1",
      subjectId: "subject-1",
      tenantId: "tenant-a",
      grantedScopes: ["tool:call"]
    }
  };
}

function actionDispatchedRecord(
  recordId: string,
  mcpRequestId: string,
  runId: string,
  traceId: string,
  eventIds: string[]
): Extract<McpAuditRecord, { type: "mcp.action.dispatched" }> {
  return {
    schemaVersion: "specwright.mcp.audit.v1",
    recordId,
    type: "mcp.action.dispatched",
    timestamp: "2026-06-01T00:00:01.000Z",
    sessionId: "session-1",
    mcpRequestId,
    runId,
    runtimeOperation: "callTool",
    eventIds,
    traceId,
    toolName: mcpRequestId === "mcp_req_a" ? "tool.a" : "tool.b",
    principal: {
      clientId: "client-1",
      subjectId: "subject-1",
      tenantId: "tenant-a",
      grantedScopes: ["tool:call"]
    }
  };
}

function observedOptions(
  rootDir: string,
  ids = deterministicIds(),
  metrics = createMcpMetricsRegistry()
) {
  return {
    rootDir,
    metrics,
    session: {
      sessionId: "session-1",
      clientId: "client-1",
      subjectId: "subject-1",
      tenantId: "tenant-a",
      grantedScopes: ["tool:call", "run:read"],
      runMode: "assisted" as const,
      transport: "stdio",
      protocolVersion: "2026-06"
    },
    idFactory: ids,
    clock: deterministicClock()
  };
}

function deterministicIds() {
  const counters = {
    request: 0,
    span: 0,
    record: 0,
    gap: 0
  };

  return {
    mcpRequestId() {
      counters.request += 1;
      return `mcp_req_${counters.request}`;
    },
    sessionId() {
      return "session-1";
    },
    spanId() {
      counters.span += 1;
      return `mcp_span_${counters.span}`;
    },
    recordId() {
      counters.record += 1;
      return `audit_${counters.record}`;
    },
    gapId() {
      counters.gap += 1;
      return `gap_${counters.gap}`;
    }
  };
}

function deterministicClock() {
  let tick = 0;

  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 5, 1, 0, 0, tick)).toISOString();
  };
}

function validRunInput(rootDir: string) {
  return {
    task: "Observe MCP provenance",
    cwd: rootDir,
    harnessId: "default",
    host: {
      kind: "mcp" as const,
      version: "0.0.0"
    }
  };
}

function validToolCallArguments(rootDir: string) {
  return {
    runId: "run-packet-05",
    request: {
      toolId: "external.crm.lookup",
      args: {
        accountId: "acct-1"
      },
      reason: "Look up account through brokered external MCP server.",
      idempotencyKey: "idem-packet-05",
      requestedBy: {
        phase: "created"
      }
    },
    options: {
      rootDir,
      traceId: "trace-packet-05"
    }
  };
}

function faultingAuditWriter(
  inner: McpAuditWriter,
  failTypes: ReadonlySet<string>
): McpAuditWriter {
  return {
    async write(record) {
      if (failTypes.has(record.type)) {
        throw new Error(`forced audit failure for ${record.type}`);
      }

      return inner.write(record);
    }
  };
}

function faultingSpanWriter(): McpSpanWriter {
  return {
    async recordParentSpan() {
      throw new Error("forced span failure");
    },
    async linkChildSpans() {
      return [];
    }
  };
}

function metricNamesFromSnapshot(
  snapshot: ReturnType<ReturnType<typeof createMcpMetricsRegistry>["snapshot"]>
) {
  return [
    ...snapshot.counters.map((sample) => sample.name),
    ...snapshot.histograms.map((sample) => sample.name),
    ...snapshot.gauges.map((sample) => sample.name)
  ];
}

function allAuditRecordFixtures(): McpAuditRecord[] {
  const base = {
    schemaVersion: "specwright.mcp.audit.v1" as const,
    timestamp: "2026-06-01T00:00:00.000Z",
    sessionId: "session-1",
    principal: {
      clientId: "client-1",
      subjectId: "subject-1",
      tenantId: "tenant-a",
      grantedScopes: ["tool:call"]
    }
  };

  return [
    {
      ...base,
      recordId: "audit-session-opened",
      type: "mcp.session.opened",
      clientId: "client-1",
      subjectId: "subject-1",
      tenantId: "tenant-a",
      grantedScopes: ["tool:call"],
      runMode: "assisted",
      transport: "stdio",
      protocolVersion: "2026-06"
    },
    {
      ...base,
      recordId: "audit-session-closed",
      type: "mcp.session.closed",
      clientId: "client-1",
      durationMs: 10,
      requestCount: 1,
      denialCount: 0
    },
    {
      ...base,
      recordId: "audit-request",
      type: "mcp.request.received",
      mcpRequestId: "mcp_req_fixture",
      operation: "tools/call",
      target: "specwright_call_tool",
      argsHash: "sha256:args",
      idempotencyKey: "idem-1",
      expectedLastEventId: "event-1"
    },
    {
      ...base,
      recordId: "audit-dispatched",
      type: "mcp.action.dispatched",
      mcpRequestId: "mcp_req_fixture",
      runId: "run-packet-05",
      runtimeOperation: "callTool",
      eventIds: ["event-2"],
      traceId: "trace-packet-05"
    },
    {
      ...base,
      recordId: "audit-denied",
      type: "mcp.action.denied",
      mcpRequestId: "mcp_req_fixture",
      denialCode: "policy_denied",
      gate: "PolicyVerdict",
      policyDecisionRef: "sha256:decision"
    },
    {
      ...base,
      recordId: "audit-resource",
      type: "mcp.resource.read",
      mcpRequestId: "mcp_req_fixture",
      resourceUri: "specwright://runs/run-packet-05/events",
      redactionProfile: "audit",
      fieldsRedactedCount: 1
    },
    {
      ...base,
      recordId: "audit-external",
      type: "mcp.external.invoked",
      mcpRequestId: "mcp_req_fixture",
      serverId: "crm-prod",
      pinnedVersion: "2026.06",
      toolName: "lookup_account",
      argsHash: "sha256:external-args",
      resultHash: "sha256:external-result",
      traceId: "trace-packet-05",
      trustClass: "external_observation"
    },
    {
      ...base,
      recordId: "audit-gap",
      type: "mcp.provenance_gap",
      gapId: "gap-1",
      mcpRequestId: "mcp_req_fixture",
      operation: "tools/call",
      stage: "runtime_dispatch_observation",
      reason: "forced failure",
      partialWrites: ["span"],
      retryable: true,
      operatorAction: "reconcile"
    }
  ];
}
