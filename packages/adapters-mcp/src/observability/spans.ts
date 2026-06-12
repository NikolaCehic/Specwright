import {
  recordTraceSpan,
  readTrace,
  writeTrace,
  type TraceSpan,
  type TraceSpanKind,
  type TraceSpanMetadata,
  type TraceSpanStatus
} from "@specwright/trace-recorder";

const MCP_CHILD_SPAN_KINDS = new Set<TraceSpanKind>([
  "phase",
  "tool",
  "policy",
  "eval",
  "gate",
  "approval"
]);

export type McpSpanWriter = {
  recordParentSpan(input: McpParentSpanInput): Promise<TraceSpan>;
  linkChildSpans(input: McpChildSpanLinkInput): Promise<TraceSpan[]>;
};

export type McpParentSpanInput = {
  rootDir?: string | undefined;
  runId: string;
  traceId?: string | undefined;
  spanId: string;
  name: string;
  status: TraceSpanStatus;
  startedAt: Date | string;
  endedAt: Date | string;
  eventIds?: readonly string[] | undefined;
  metadata: TraceSpanMetadata & {
    mcpRequestId?: string | undefined;
    clientId?: string | undefined;
    subjectId?: string | undefined;
    tenantId?: string | undefined;
    runId?: string | undefined;
    toolName?: string | undefined;
    resourceUri?: string | undefined;
    promptId?: string | undefined;
  };
};

export type McpChildSpanLinkInput = {
  rootDir?: string | undefined;
  runId: string;
  parentSpanId: string;
  eventIds: readonly string[];
};

export type McpSpanWriterOptions = {
  rootDir?: string | undefined;
};

export function createMcpSpanWriter(
  options: McpSpanWriterOptions = {}
): McpSpanWriter {
  return {
    recordParentSpan(input) {
      return recordMcpParentSpan({
        ...input,
        rootDir: input.rootDir ?? options.rootDir
      });
    },
    linkChildSpans(input) {
      return linkMcpChildSpans({
        ...input,
        rootDir: input.rootDir ?? options.rootDir
      });
    }
  };
}

export async function recordMcpParentSpan(
  input: McpParentSpanInput
): Promise<TraceSpan> {
  return recordTraceSpan({
    rootDir: input.rootDir,
    runId: input.runId,
    traceId: input.traceId,
    hostAdapter: "mcp",
    span: {
      spanId: input.spanId,
      kind: "mcp",
      name: input.name,
      status: input.status,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      eventIds:
        input.eventIds === undefined ? undefined : [...input.eventIds],
      metadata: {
        ...input.metadata,
        spanRole: "mcp_parent"
      }
    }
  });
}

export async function linkMcpChildSpans(
  input: McpChildSpanLinkInput
): Promise<TraceSpan[]> {
  if (input.eventIds.length === 0) {
    return [];
  }

  const eventIdSet = new Set(input.eventIds);
  const trace = await readTrace({
    rootDir: input.rootDir,
    runId: input.runId
  });
  let changed = false;
  const linked: TraceSpan[] = [];
  const spans = trace.spans.map((span) => {
    if (
      span.parentSpanId !== undefined ||
      !MCP_CHILD_SPAN_KINDS.has(span.kind) ||
      span.eventIds === undefined ||
      !span.eventIds.some((eventId) => eventIdSet.has(eventId))
    ) {
      return span;
    }

    changed = true;
    const next = {
      ...span,
      parentSpanId: input.parentSpanId,
      metadata: {
        ...span.metadata,
        mcpParentSpanId: input.parentSpanId
      }
    } satisfies TraceSpan;
    linked.push(next);
    return next;
  });

  if (!changed) {
    return [];
  }

  await writeTrace({
    rootDir: input.rootDir,
    runId: input.runId,
    trace: {
      ...trace,
      spans
    }
  });

  return linked;
}

export function mcpSpanStatusForOutcome(input: {
  isError: boolean;
  code?: string | undefined;
}): TraceSpanStatus {
  if (!input.isError) {
    return "success";
  }

  switch (input.code) {
    case "approval_required":
      return "approval_required";
    case "policy_denied":
    case "policy_error":
    case "scope_exceeded":
    case "subject_unverifiable":
    case "tenant_mismatch":
    case "tool_not_found":
    case "method_not_found":
      return "denied";
    default:
      return "failed";
  }
}
