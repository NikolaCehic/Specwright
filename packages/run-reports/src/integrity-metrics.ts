export const OBSERVABILITY_INPUT_LABELS = [
  "trace.json",
  "artifacts/index.jsonl",
  "evidence/index.jsonl",
  "evals/*.json"
] as const;

export type IntegrityMetricClass =
  | "trace-to-event-consistency-rate"
  | "missing-input-rate"
  | "schema-validation-failure-rate";

export type SourceEventRange = {
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
};

export type IntegrityMetric = {
  class: IntegrityMetricClass;
  value: number;
  numerator: number;
  denominator: number;
  sourceEventRange: SourceEventRange;
  tenantId?: string | undefined;
};

export type ComputeIntegrityMetricsInput = {
  sourceEventRange: SourceEventRange;
  consistentTraceEventLinks: number;
  totalTraceEventLinks: number;
  missingInputs: readonly string[];
  schemaValidationFailures?: number | undefined;
  tenantId?: string | undefined;
};

export function computeIntegrityMetrics(
  input: ComputeIntegrityMetricsInput
): IntegrityMetric[] {
  return [
    metric({
      class: "trace-to-event-consistency-rate",
      numerator: input.consistentTraceEventLinks,
      denominator: input.totalTraceEventLinks,
      sourceEventRange: input.sourceEventRange,
      tenantId: input.tenantId
    }),
    metric({
      class: "missing-input-rate",
      numerator: input.missingInputs.length,
      denominator: OBSERVABILITY_INPUT_LABELS.length,
      sourceEventRange: input.sourceEventRange,
      tenantId: input.tenantId
    }),
    metric({
      class: "schema-validation-failure-rate",
      numerator: input.schemaValidationFailures ?? 0,
      denominator: input.sourceEventRange.eventCount,
      sourceEventRange: input.sourceEventRange,
      tenantId: input.tenantId
    })
  ];
}

function metric(input: Omit<IntegrityMetric, "value">): IntegrityMetric {
  return {
    class: input.class,
    value: rate(input.numerator, input.denominator),
    numerator: input.numerator,
    denominator: input.denominator,
    sourceEventRange: input.sourceEventRange,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId })
  };
}

function rate(numerator: number, denominator: number) {
  if (denominator === 0) {
    return numerator === 0 ? 1 : 0;
  }

  return numerator / denominator;
}
