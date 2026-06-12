export const MCP_METRIC_NAMES = [
  "mcp_requests_total",
  "mcp_denials_total",
  "mcp_approval_required_total",
  "mcp_request_duration_ms",
  "mcp_external_calls_total",
  "mcp_external_failures_total",
  "mcp_redactions_total",
  "mcp_stale_state_rejections_total",
  "mcp_active_sessions",
  "mcp_schema_incompat_total"
] as const;

export type McpMetricName = (typeof MCP_METRIC_NAMES)[number];
export type McpMetricLabels = Record<string, string>;

export type McpCounterSample = {
  name: Exclude<McpMetricName, "mcp_request_duration_ms" | "mcp_active_sessions">;
  labels: McpMetricLabels;
  value: number;
};

export type McpHistogramSample = {
  name: "mcp_request_duration_ms";
  labels: McpMetricLabels;
  count: number;
  sum: number;
  values: number[];
};

export type McpGaugeSample = {
  name: "mcp_active_sessions";
  labels: McpMetricLabels;
  value: number;
};

export type McpMetricsSnapshot = {
  counters: McpCounterSample[];
  histograms: McpHistogramSample[];
  gauges: McpGaugeSample[];
};

export class McpMetricsRegistry {
  private readonly counters = new Map<string, McpCounterSample>();
  private readonly histograms = new Map<string, McpHistogramSample>();
  private readonly gauges = new Map<string, McpGaugeSample>();

  incrementCounter(
    name: McpCounterSample["name"],
    labels: McpMetricLabels = {},
    amount = 1
  ) {
    const key = metricKey(name, labels);
    const current =
      this.counters.get(key) ?? {
        name,
        labels: normalizeLabels(labels),
        value: 0
      };

    current.value += amount;
    this.counters.set(key, current);
  }

  observeDuration(labels: McpMetricLabels, durationMs: number) {
    const name = "mcp_request_duration_ms" as const;
    const key = metricKey(name, labels);
    const current =
      this.histograms.get(key) ?? {
        name,
        labels: normalizeLabels(labels),
        count: 0,
        sum: 0,
        values: []
      };

    current.count += 1;
    current.sum += durationMs;
    current.values.push(durationMs);
    this.histograms.set(key, current);
  }

  setGauge(name: McpGaugeSample["name"], labels: McpMetricLabels, value: number) {
    this.gauges.set(metricKey(name, labels), {
      name,
      labels: normalizeLabels(labels),
      value
    });
  }

  snapshot(): McpMetricsSnapshot {
    return {
      counters: [...this.counters.values()].sort(compareMetricSamples),
      histograms: [...this.histograms.values()].sort(compareMetricSamples),
      gauges: [...this.gauges.values()].sort(compareMetricSamples)
    };
  }
}

export function createMcpMetricsRegistry() {
  return new McpMetricsRegistry();
}

export function recordMcpRequestMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  operation: string;
  toolName?: string | undefined;
  clientId?: string | undefined;
  outcome: string;
  durationMs: number;
}) {
  if (input.metrics === undefined) {
    return;
  }

  const labels = compactLabels({
    operation: input.operation,
    toolName: input.toolName,
    clientId: input.clientId,
    outcome: input.outcome
  });

  input.metrics.incrementCounter("mcp_requests_total", labels);
  input.metrics.observeDuration(
    compactLabels({
      operation: input.operation,
      outcome: input.outcome
    }),
    input.durationMs
  );
}

export function recordMcpDenialMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  denialCode: string;
  gate: string;
  clientId?: string | undefined;
}) {
  input.metrics?.incrementCounter(
    "mcp_denials_total",
    compactLabels({
      denialCode: input.denialCode,
      gate: input.gate,
      clientId: input.clientId
    })
  );
}

export function recordMcpApprovalRequiredMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  toolName?: string | undefined;
  clientId?: string | undefined;
}) {
  input.metrics?.incrementCounter(
    "mcp_approval_required_total",
    compactLabels({
      toolName: input.toolName,
      clientId: input.clientId
    })
  );
}

export function recordMcpExternalMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  serverId: string;
  version?: string | undefined;
  outcome: string;
  errorCode?: string | undefined;
}) {
  input.metrics?.incrementCounter(
    "mcp_external_calls_total",
    compactLabels({
      serverId: input.serverId,
      version: input.version,
      outcome: input.outcome
    })
  );

  if (input.outcome !== "success") {
    input.metrics?.incrementCounter(
      "mcp_external_failures_total",
      compactLabels({
        serverId: input.serverId,
        errorCode: input.errorCode
      })
    );
  }
}

export function recordMcpRedactionMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  redactionProfile: string;
  resourceUri: string;
  count: number;
}) {
  if (input.count === 0) {
    return;
  }

  input.metrics?.incrementCounter(
    "mcp_redactions_total",
    compactLabels({
      redactionProfile: input.redactionProfile,
      resourceUri: input.resourceUri
    }),
    input.count
  );
}

export function recordMcpStaleStateMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  toolName?: string | undefined;
}) {
  input.metrics?.incrementCounter(
    "mcp_stale_state_rejections_total",
    compactLabels({
      toolName: input.toolName
    })
  );
}

export function setMcpActiveSessionsMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  tenantId: string;
  value: number;
}) {
  input.metrics?.setGauge(
    "mcp_active_sessions",
    {
      tenantId: input.tenantId
    },
    input.value
  );
}

export function recordMcpSchemaIncompatMetric(input: {
  metrics: McpMetricsRegistry | undefined;
  clientProtocolVersion?: string | undefined;
}) {
  input.metrics?.incrementCounter(
    "mcp_schema_incompat_total",
    compactLabels({
      clientProtocolVersion: input.clientProtocolVersion
    })
  );
}

function compactLabels(labels: Record<string, string | undefined>) {
  const output: McpMetricLabels = {};

  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];

    if (value !== undefined && value.length > 0) {
      output[key] = value;
    }
  }

  return output;
}

function normalizeLabels(labels: McpMetricLabels) {
  return compactLabels(labels);
}

function metricKey(name: McpMetricName, labels: McpMetricLabels) {
  return `${name}:${JSON.stringify(normalizeLabels(labels))}`;
}

function compareMetricSamples(
  left:
    | McpCounterSample
    | McpHistogramSample
    | McpGaugeSample,
  right:
    | McpCounterSample
    | McpHistogramSample
    | McpGaugeSample
) {
  const byName = left.name.localeCompare(right.name);

  if (byName !== 0) {
    return byName;
  }

  return JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels));
}
