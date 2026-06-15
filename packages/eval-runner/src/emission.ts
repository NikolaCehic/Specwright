import { z } from "zod";
import {
  EvalFindingSchema,
  EvalVerdictSchema,
  RepairTaskSchema,
  runtimeEventSchema,
  type EvalFinding,
  type EvalVerdict,
  type RepairTask
} from "@specwright/schemas";
import {
  hashValue,
  inputHashesFromVerdict,
  type DecisionInputHashes,
  type HashDigest
} from "./decision-hash";
import { checksForDefinition, evalKind } from "./registry";
import {
  runEvalAsync,
  type EvalArtifactSnapshot,
  type EvalRunnerInput,
  type FixtureEvalCheck,
  type FixtureEvalDefinition,
  type RunEvalRequest,
  type RunEvalsRequest
} from "./index";

export type EvalEmissionTraceSpanKind = "eval" | "tool";
export type EvalEmissionTraceSpanStatus =
  | "success"
  | "failed"
  | "denied"
  | "approval_required"
  | "pass"
  | "fail"
  | "needs_review"
  | "skipped"
  | "hit"
  | "miss"
  | "bypass";

export type EvalEmissionTraceSpanInput = {
  spanId?: string | undefined;
  parentSpanId?: string | undefined;
  kind: EvalEmissionTraceSpanKind;
  name: string;
  status: EvalEmissionTraceSpanStatus;
  startedAt?: Date | string | undefined;
  endedAt?: Date | string | undefined;
  durationMs?: number | undefined;
  eventIds?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type EvalEmissionTraceSpan = {
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  kind: EvalEmissionTraceSpanKind;
  name: string;
  status: EvalEmissionTraceSpanStatus;
  startedAt: string;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  eventIds?: string[] | undefined;
  metadata: Record<string, unknown>;
};

export type EvalEmissionRuntimeEvent<TPayload = EvalEmissionEventPayload> = {
  id: string;
  runId: string;
  type: EvalEmissionEventType;
  timestamp: string;
  sequence: number;
  traceId: string;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  contractId: string;
  contractVersion: string;
  schemaHash: string;
  payload: TPayload;
};

export const EVAL_VERDICT_RECORDED_EVENT = "eval.verdict.recorded";
export const EVAL_DEFINITION_MISSING_EVENT = "eval.definition.missing";
export const EVAL_TARGET_MISSING_EVENT = "eval.target.missing";
export const EVAL_CHECKS_MISSING_EVENT = "eval.checks.missing";
export const EVAL_TYPE_UNSUPPORTED_EVENT = "eval.type.unsupported";
export const EVAL_REPAIR_TASK_CREATED_EVENT = "eval.repair_task.created";

export type EvalEmissionEventType =
  | typeof EVAL_VERDICT_RECORDED_EVENT
  | typeof EVAL_DEFINITION_MISSING_EVENT
  | typeof EVAL_TARGET_MISSING_EVENT
  | typeof EVAL_CHECKS_MISSING_EVENT
  | typeof EVAL_TYPE_UNSUPPORTED_EVENT
  | typeof EVAL_REPAIR_TASK_CREATED_EVENT;

export type EvalEmissionAppendInput<TPayload = EvalEmissionEventPayload> = {
  runId: string;
  traceId: string;
  type: EvalEmissionEventType;
  payload: TPayload;
  id: string;
  timestamp: string;
  sequence: number;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  rootDir?: string | undefined;
};

export type EvalEmissionAppendResult<TPayload = EvalEmissionEventPayload> = {
  event: EvalEmissionRuntimeEvent<TPayload>;
};

export type EvalEmissionAppendSink = (
  input: EvalEmissionAppendInput
) => Promise<EvalEmissionAppendResult> | EvalEmissionAppendResult;

export type EvalEmissionSpanSink = (
  span: EvalEmissionTraceSpanInput,
  context: EvalEmissionContext
) => Promise<EvalEmissionTraceSpan> | EvalEmissionTraceSpan;

export type EvalEmissionClock = () => Date | string;
export type EvalEmissionIdFactory = (input: {
  kind: "event" | "span";
  type: string;
  index: number;
  runId: string;
  traceId: string;
  evalId: string;
  decisionHash?: string | undefined;
}) => string;

export type PriorEvalFailureLink = {
  eventId: string;
  decisionHash: HashDigest;
  evalId: string;
  targetRef: string;
  sourceFindingIds: string[];
};

export type EvalRepairEmissionOptions = {
  isReevaluation?: boolean | undefined;
  priorFailure?: PriorEvalFailureLink | undefined;
  createRepairTask?: boolean | undefined;
};

export type EvalEmissionContext = {
  runId: string;
  traceId: string;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  rootDir?: string | undefined;
  appendEvent?: EvalEmissionAppendSink | undefined;
  recordSpan?: EvalEmissionSpanSink | undefined;
  clock?: EvalEmissionClock | undefined;
  idFactory?: EvalEmissionIdFactory | undefined;
  repair?: EvalRepairEmissionOptions | undefined;
};

export type EvalRecordedProvenance = {
  evalId: string;
  targetRef: string;
  definition: {
    id: string;
    version?: string | undefined;
    hash?: HashDigest | undefined;
  };
  target: {
    ref: string;
    artifactId?: string | undefined;
    artifactType?: string | undefined;
    contentHash?: HashDigest | undefined;
  };
  evidence: {
    snapshotHash?: HashDigest | undefined;
    refs: string[];
  };
  decisionHash?: HashDigest | undefined;
  checkResultsHash?: HashDigest | undefined;
  dataset?: Record<string, unknown> | undefined;
  grader?: Record<string, unknown> | undefined;
  regression?: Record<string, unknown> | undefined;
  producedBy: EvalVerdict["producedBy"];
  priorFailure?: PriorEvalFailureLink | undefined;
  incomplete: EvalProvenanceIncompleteMarker[];
};

export type EvalProvenanceIncompleteMarker = {
  field: string;
  reason: string;
};

export type EvalAuditGap = {
  code:
    | "eval.audit_gap.re_evaluation_pass_without_prior_failure"
    | "eval.audit_gap.model_finding_missing_tool_span"
    | "eval.audit_gap.model_finding_missing_rubric_ref"
    | "eval.audit_gap.produced_by_kind_round_trip_failed";
  message: string;
  findingId?: string | undefined;
};

export type EvalVerdictRecordedPayload = {
  verdict: EvalVerdict;
  provenance: EvalRecordedProvenance;
  auditGaps: EvalAuditGap[];
  trustedForPromotion: boolean;
};

export type EvalFailClosedPayload = {
  evalId: string;
  targetRef: string;
  status: EvalVerdict["status"];
  severity: EvalVerdict["severity"];
  finding: EvalFinding;
  decisionHash?: HashDigest | undefined;
  provenance: EvalRecordedProvenance;
};

export type EvalRepairTaskCreatedPayload = {
  evalId: string;
  targetRef: string;
  decisionHash?: HashDigest | undefined;
  repairTask: RepairTask;
  sourceFindingIds: string[];
  priorFailure?: PriorEvalFailureLink | undefined;
};

export type EvalEmissionEventPayload =
  | EvalVerdictRecordedPayload
  | EvalFailClosedPayload
  | EvalRepairTaskCreatedPayload;

export type EvalEmissionResult = {
  verdict: EvalVerdict;
  events: EvalEmissionRuntimeEvent<EvalEmissionEventPayload>[];
  spans: EvalEmissionTraceSpan[];
  provenance: EvalRecordedProvenance;
  auditGaps: EvalAuditGap[];
  trustedForPromotion: boolean;
};

export type EvalEmissionHistory = {
  verdicts: Array<{
    eventId: string;
    evalId: string;
    targetRef: string;
    status: EvalVerdict["status"];
    severity: EvalVerdict["severity"];
    decisionHash?: HashDigest | undefined;
    priorFailure?: PriorEvalFailureLink | undefined;
    repairTaskEventIds: string[];
    sourceFindingIds: string[];
    auditGaps: EvalAuditGap[];
  }>;
  repairs: Array<{
    eventId: string;
    evalId: string;
    targetRef: string;
    decisionHash?: HashDigest | undefined;
    repairTask: RepairTask;
    sourceFindingIds: string[];
  }>;
  spans: Array<{
    spanId: string;
    parentSpanId?: string | undefined;
    kind: EvalEmissionTraceSpan["kind"];
    status: EvalEmissionTraceSpan["status"];
    evalId?: string | undefined;
    targetRef?: string | undefined;
    decisionHash?: string | undefined;
    eventIds: string[];
  }>;
};

const NonEmptyStringSchema = z.string().min(1);
const HashDigestSchema = z.custom<HashDigest>(
  (value) =>
    typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
);

const PriorEvalFailureLinkSchema = z
  .object({
    eventId: NonEmptyStringSchema,
    decisionHash: HashDigestSchema,
    evalId: NonEmptyStringSchema,
    targetRef: NonEmptyStringSchema,
    sourceFindingIds: z.array(NonEmptyStringSchema)
  })
  .strict();

const IncompleteMarkerSchema = z
  .object({
    field: NonEmptyStringSchema,
    reason: NonEmptyStringSchema
  })
  .strict();

const RecordedProvenanceSchema = z
  .object({
    evalId: NonEmptyStringSchema,
    targetRef: NonEmptyStringSchema,
    definition: z
      .object({
        id: NonEmptyStringSchema,
        version: NonEmptyStringSchema.optional(),
        hash: HashDigestSchema.optional()
      })
      .strict(),
    target: z
      .object({
        ref: NonEmptyStringSchema,
        artifactId: NonEmptyStringSchema.optional(),
        artifactType: NonEmptyStringSchema.optional(),
        contentHash: HashDigestSchema.optional()
      })
      .strict(),
    evidence: z
      .object({
        snapshotHash: HashDigestSchema.optional(),
        refs: z.array(NonEmptyStringSchema)
      })
      .strict(),
    decisionHash: HashDigestSchema.optional(),
    checkResultsHash: HashDigestSchema.optional(),
    dataset: z.record(z.unknown()).optional(),
    grader: z.record(z.unknown()).optional(),
    regression: z.record(z.unknown()).optional(),
    producedBy: z.object({
      kind: z.enum(["deterministic", "model_assisted", "human"]),
      ref: NonEmptyStringSchema
    }),
    priorFailure: PriorEvalFailureLinkSchema.optional(),
    incomplete: z.array(IncompleteMarkerSchema)
  })
  .strict();

const AuditGapSchema = z
  .object({
    code: z.enum([
      "eval.audit_gap.re_evaluation_pass_without_prior_failure",
      "eval.audit_gap.model_finding_missing_tool_span",
      "eval.audit_gap.model_finding_missing_rubric_ref",
      "eval.audit_gap.produced_by_kind_round_trip_failed"
    ]),
    message: NonEmptyStringSchema,
    findingId: NonEmptyStringSchema.optional()
  })
  .strict();

const VerdictRecordedPayloadSchema = z
  .object({
    verdict: EvalVerdictSchema,
    provenance: RecordedProvenanceSchema,
    auditGaps: z.array(AuditGapSchema),
    trustedForPromotion: z.boolean()
  })
  .strict();

const FailClosedPayloadSchema = z
  .object({
    evalId: NonEmptyStringSchema,
    targetRef: NonEmptyStringSchema,
    status: z.enum(["pass", "fail", "needs_review", "skipped"]),
    severity: z.enum(["blocking", "advisory"]),
    finding: EvalFindingSchema,
    decisionHash: HashDigestSchema.optional(),
    provenance: RecordedProvenanceSchema
  })
  .strict();

const RepairTaskCreatedPayloadSchema = z
  .object({
    evalId: NonEmptyStringSchema,
    targetRef: NonEmptyStringSchema,
    decisionHash: HashDigestSchema.optional(),
    repairTask: RepairTaskSchema,
    sourceFindingIds: z.array(NonEmptyStringSchema),
    priorFailure: PriorEvalFailureLinkSchema.optional()
  })
  .strict();

const PayloadSchemas = {
  [EVAL_VERDICT_RECORDED_EVENT]: VerdictRecordedPayloadSchema,
  [EVAL_DEFINITION_MISSING_EVENT]: FailClosedPayloadSchema,
  [EVAL_TARGET_MISSING_EVENT]: FailClosedPayloadSchema,
  [EVAL_CHECKS_MISSING_EVENT]: FailClosedPayloadSchema,
  [EVAL_TYPE_UNSUPPORTED_EVENT]: FailClosedPayloadSchema,
  [EVAL_REPAIR_TASK_CREATED_EVENT]: RepairTaskCreatedPayloadSchema
} as const;

export class EvalEmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "EvalEmissionError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export async function evaluateAndRecord(
  request: RunEvalRequest,
  context: EvalEmissionContext
): Promise<EvalEmissionResult> {
  const verdict = await runEvalAsync({
    ...request,
    runId: request.runId ?? context.runId,
    traceId: request.traceId ?? context.traceId
  });

  return recordEvalVerdict(request, context, verdict);
}

export async function evaluateManyAndRecord(
  request: RunEvalsRequest,
  context: EvalEmissionContext
): Promise<EvalEmissionResult[]> {
  const definitions = definitionsForManyRequest(request);
  const results: EvalEmissionResult[] = [];

  for (const definition of definitions) {
    results.push(
      await evaluateAndRecord(
        {
          ...request,
          evalDefinition: definition
        },
        context
      )
    );
  }

  return results;
}

export async function recordEvalVerdict(
  request: RunEvalRequest,
  context: EvalEmissionContext,
  verdict: EvalVerdict
): Promise<EvalEmissionResult> {
  assertEmissionContext(context);

  const provenance = provenanceForVerdict(request, verdict, context);
  const auditGaps = auditGapsForVerdict(verdict, provenance, context);

  if (
    verdict.status === "pass" &&
    context.repair?.isReevaluation === true &&
    context.repair.priorFailure === undefined
  ) {
    throw new EvalEmissionError(
      "audit_gap.re_evaluation_pass_without_prior_failure",
      "Re-evaluation pass requires a linkable prior failing verdict"
    );
  }

  const trustedForPromotion =
    auditGaps.length === 0 &&
    provenance.incomplete.length === 0 &&
    (verdict.status !== "pass" || verdict.producedBy.kind !== "model_assisted" ||
      hasCompleteModelPromotionProvenance(verdict));
  const events: EvalEmissionRuntimeEvent<EvalEmissionEventPayload>[] = [];
  const append = context.appendEvent ?? defaultAppendEvent;
  let sequence = 0;

  const appendTyped = async <TType extends EvalEmissionEventType>(
    type: TType,
    payload: z.infer<(typeof PayloadSchemas)[TType]>
  ) => {
    const event = buildLocalRuntimeEvent({
      context,
      verdict,
      type,
      payload,
      sequence
    });

    sequence += 1;
    const parsed = localEventSchema(type).parse(event);
    assertProducedByKindRoundTrips(verdict, parsed);

    const result = await append({
      rootDir: context.rootDir,
      runId: context.runId,
      traceId: context.traceId,
      type,
      payload: parsed.payload as EvalEmissionEventPayload,
      id: parsed.id,
      timestamp: parsed.timestamp,
      sequence: parsed.sequence,
      causationId: context.causationId,
      correlationId: context.correlationId
    });

    const recorded = result.event as EvalEmissionRuntimeEvent<EvalEmissionEventPayload>;
    events.push(recorded);
    return recorded;
  };

  await appendTyped(EVAL_VERDICT_RECORDED_EVENT, {
    verdict,
    provenance,
    auditGaps,
    trustedForPromotion
  });

  for (const eventType of failClosedEventTypesFor(verdict)) {
    const finding = findingForEventType(verdict, eventType);

    if (finding !== undefined) {
      await appendTyped(eventType, {
        evalId: verdict.evalId,
        targetRef: verdict.targetRef,
        status: verdict.status,
        severity: verdict.severity,
        finding,
        decisionHash: provenance.decisionHash,
        provenance
      });
    }
  }

  if (shouldCreateRepairTask(verdict, context)) {
    await appendTyped(EVAL_REPAIR_TASK_CREATED_EVENT, {
      evalId: verdict.evalId,
      targetRef: verdict.targetRef,
      decisionHash: provenance.decisionHash,
      repairTask: repairTaskForVerdict(verdict, provenance),
      sourceFindingIds: findingIdsForVerdict(verdict),
      priorFailure: context.repair?.priorFailure
    });
  }

  const spans = await recordSpansForVerdict({
    request,
    context,
    verdict,
    provenance,
    eventIds: events.map((event) => event.id)
  });

  return {
    verdict,
    events,
    spans,
    provenance,
    auditGaps,
    trustedForPromotion
  };
}

export function projectEvalEmissionHistory(input: {
  events: readonly EvalEmissionRuntimeEvent<unknown>[];
  spans?: readonly EvalEmissionTraceSpan[] | undefined;
}): EvalEmissionHistory {
  const repairs = input.events
    .filter((event) => event.type === EVAL_REPAIR_TASK_CREATED_EVENT)
    .map((event) => {
      const payload = RepairTaskCreatedPayloadSchema.parse(event.payload);

      return {
        eventId: event.id,
        evalId: payload.evalId,
        targetRef: payload.targetRef,
        decisionHash: payload.decisionHash,
        repairTask: payload.repairTask,
        sourceFindingIds: payload.sourceFindingIds
      };
    });
  const verdicts = input.events
    .filter((event) => event.type === EVAL_VERDICT_RECORDED_EVENT)
    .map((event) => {
      const payload = VerdictRecordedPayloadSchema.parse(event.payload);
      const repairTaskEventIds = repairs
        .filter(
          (repair) =>
            repair.evalId === payload.verdict.evalId &&
            repair.decisionHash === payload.provenance.decisionHash
        )
        .map((repair) => repair.eventId);

      return {
        eventId: event.id,
        evalId: payload.verdict.evalId,
        targetRef: payload.verdict.targetRef,
        status: payload.verdict.status,
        severity: payload.verdict.severity,
        decisionHash: payload.provenance.decisionHash,
        priorFailure: payload.provenance.priorFailure,
        repairTaskEventIds,
        sourceFindingIds: findingIdsForVerdict(payload.verdict),
        auditGaps: payload.auditGaps
      };
    });

  return {
    verdicts,
    repairs,
    spans: (input.spans ?? []).map((span) => ({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      kind: span.kind,
      status: span.status,
      evalId:
        typeof span.metadata.evalId === "string"
          ? span.metadata.evalId
          : undefined,
      targetRef:
        typeof span.metadata.targetRef === "string"
          ? span.metadata.targetRef
          : undefined,
      decisionHash:
        typeof span.metadata.decisionHash === "string"
          ? span.metadata.decisionHash
          : undefined,
      eventIds: span.eventIds ?? []
    }))
  };
}

function assertEmissionContext(context: EvalEmissionContext) {
  if (context.runId.length === 0) {
    throw new EvalEmissionError("invalid_context", "runId is required");
  }

  if (context.traceId.length === 0) {
    throw new EvalEmissionError("invalid_context", "traceId is required");
  }
}

function provenanceForVerdict(
  request: RunEvalRequest,
  verdict: EvalVerdict,
  context: EvalEmissionContext
): EvalRecordedProvenance {
  const incomplete: EvalProvenanceIncompleteMarker[] = [];
  const hashes = safeInputHashes(verdict, incomplete);
  const target = resolveArtifactForVerdict(request.input, verdict.targetRef);
  const definition = request.evalDefinition ?? definitionFromRequest(request, verdict.evalId);
  const decisionHash = hashFromVerdict(verdict, "decisionHash", incomplete);

  if (hashes?.definitionHash === undefined) {
    incomplete.push({
      field: "definition.hash",
      reason: "definition hash unavailable from verdict provenance"
    });
  }

  if (hashes?.targetContentHash === undefined) {
    incomplete.push({
      field: "target.contentHash",
      reason: "target content hash unavailable from verdict provenance"
    });
  }

  if (hashes?.evidenceSnapshotHash === undefined) {
    incomplete.push({
      field: "evidence.snapshotHash",
      reason: "evidence snapshot hash unavailable from verdict provenance"
    });
  }

  return pruneUndefined({
    evalId: verdict.evalId,
    targetRef: verdict.targetRef,
    definition: pruneUndefined({
      id: verdict.evalId,
      version: stringFrom(firstRecord([definition])?.version),
      hash: hashes?.definitionHash
    }),
    target: pruneUndefined({
      ref: verdict.targetRef,
      artifactId: target?.artifact.artifactId ?? target?.artifact.id,
      artifactType: target?.artifact.artifactType,
      contentHash: hashes?.targetContentHash
    }),
    evidence: pruneUndefined({
      snapshotHash: hashes?.evidenceSnapshotHash,
      refs: verdict.evidenceRefs
    }),
    decisionHash,
    checkResultsHash: hashes?.checkResultsHash,
    dataset: datasetMetadata(request, definition),
    grader: graderMetadata(request, verdict, definition),
    regression: regressionMetadata(request, definition),
    producedBy: verdict.producedBy,
    priorFailure: context.repair?.priorFailure,
    incomplete
  }) as EvalRecordedProvenance;
}

function auditGapsForVerdict(
  verdict: EvalVerdict,
  provenance: EvalRecordedProvenance,
  context: EvalEmissionContext
): EvalAuditGap[] {
  const gaps: EvalAuditGap[] = [];

  if (
    verdict.status === "pass" &&
    context.repair?.isReevaluation === true &&
    context.repair.priorFailure === undefined
  ) {
    gaps.push({
      code: "eval.audit_gap.re_evaluation_pass_without_prior_failure",
      message: "Re-evaluation pass has no linkable prior failing verdict"
    });
  }

  for (const finding of verdict.findings) {
    const model = modelMetadataFromFinding(finding);

    if (model === undefined) {
      continue;
    }

    const id = findingId(finding, verdict.evalId);

    if (typeof model.rubricRef !== "string" || model.rubricRef.length === 0) {
      gaps.push({
        code: "eval.audit_gap.model_finding_missing_rubric_ref",
        message: "Model-graded finding is missing a rubric ref",
        findingId: id
      });
      provenance.incomplete.push({
        field: `findings.${id}.rubricRef`,
        reason: "model-graded finding metadata omitted rubricRef"
      });
    }

    const toolSpan = firstRecord([model.toolSpan]);

    if (
      typeof toolSpan?.spanId !== "string" ||
      toolSpan.spanId.length === 0
    ) {
      gaps.push({
        code: "eval.audit_gap.model_finding_missing_tool_span",
        message: "Model-graded finding is missing a tool span ref",
        findingId: id
      });
      provenance.incomplete.push({
        field: `findings.${id}.toolSpan`,
        reason: "model-graded finding metadata omitted tool span"
      });
    }
  }

  return gaps;
}

function failClosedEventTypesFor(
  verdict: EvalVerdict
): EvalEmissionEventType[] {
  const types: EvalEmissionEventType[] = [];
  const codes = new Set(verdict.findings.map((finding) => finding.code));

  if (codes.has("eval.definition.missing")) {
    types.push(EVAL_DEFINITION_MISSING_EVENT);
  }

  if (codes.has("eval.target.missing")) {
    types.push(EVAL_TARGET_MISSING_EVENT);
  }

  if (codes.has("eval.checks.missing")) {
    types.push(EVAL_CHECKS_MISSING_EVENT);
  }

  if (codes.has("eval.type.unsupported")) {
    types.push(EVAL_TYPE_UNSUPPORTED_EVENT);
  }

  return types;
}

function findingForEventType(
  verdict: EvalVerdict,
  eventType: EvalEmissionEventType
) {
  const code =
    eventType === EVAL_DEFINITION_MISSING_EVENT
      ? "eval.definition.missing"
      : eventType === EVAL_TARGET_MISSING_EVENT
        ? "eval.target.missing"
        : eventType === EVAL_CHECKS_MISSING_EVENT
          ? "eval.checks.missing"
          : eventType === EVAL_TYPE_UNSUPPORTED_EVENT
            ? "eval.type.unsupported"
            : undefined;

  return verdict.findings.find((finding) => finding.code === code);
}

function shouldCreateRepairTask(
  verdict: EvalVerdict,
  context: EvalEmissionContext
) {
  if (verdict.status !== "fail") {
    return false;
  }

  if (context.repair?.createRepairTask === false) {
    return false;
  }

  return verdict.findings.length > 0;
}

function repairTaskForVerdict(
  verdict: EvalVerdict,
  provenance: EvalRecordedProvenance
): RepairTask {
  if (verdict.repairTask !== undefined) {
    return verdict.repairTask;
  }

  const sourceFindingIds = findingIdsForVerdict(verdict);
  const firstRepairHint = verdict.findings.find(
    (finding) => finding.repairHint !== undefined
  )?.repairHint;

  return RepairTaskSchema.parse({
    id: `repair:${hashValue({
      evalId: verdict.evalId,
      targetRef: verdict.targetRef,
      decisionHash: provenance.decisionHash,
      sourceFindingIds
    })}`,
    task:
      firstRepairHint ??
      `Repair ${verdict.targetRef} so eval ${verdict.evalId} can pass.`,
    targetRef: verdict.targetRef,
    createdFromFindingIds: sourceFindingIds,
    producedBy: verdict.producedBy,
    constraints: {
      evalId: verdict.evalId,
      decisionHash: provenance.decisionHash,
      severity: verdict.severity
    }
  });
}

async function recordSpansForVerdict(input: {
  request: RunEvalRequest;
  context: EvalEmissionContext;
  verdict: EvalVerdict;
  provenance: EvalRecordedProvenance;
  eventIds: string[];
}): Promise<EvalEmissionTraceSpan[]> {
  const recordSpan = input.context.recordSpan ?? defaultRecordSpan;
  const spans: EvalEmissionTraceSpan[] = [];
  const startedAt = normalizeTimestamp(input.context.clock?.() ?? new Date());
  let index = 0;
  const rootSpanId = spanId({
    ...input,
    type: "eval.root",
    index: index++
  });
  const definition = definitionFromRequest(input.request, input.verdict.evalId);

  const root = await recordSpan(
    {
      spanId: rootSpanId,
      kind: "eval",
      name: `eval:${input.verdict.evalId}`,
      status: input.verdict.status,
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      eventIds: input.eventIds,
      metadata: pruneUndefined({
        runId: input.context.runId,
        evalId: input.verdict.evalId,
        targetRef: input.verdict.targetRef,
        definitionVersion: input.provenance.definition.version,
        definitionHash: input.provenance.definition.hash,
        verdictStatus: input.verdict.status,
        severity: input.verdict.severity,
        producedByKind: input.verdict.producedBy.kind,
        producedByRef: input.verdict.producedBy.ref,
        decisionHash: input.provenance.decisionHash
      })
    },
    input.context
  );
  spans.push(root);

  spans.push(
    await recordSpan(
      {
        spanId: spanId({ ...input, type: "eval.input_resolution", index: index++ }),
        parentSpanId: rootSpanId,
        kind: "eval",
        name: `eval:${input.verdict.evalId}:input_resolution`,
        status:
          input.provenance.incomplete.some((marker) =>
            marker.field.startsWith("target.")
          )
            ? "needs_review"
            : "success",
        startedAt,
        endedAt: startedAt,
        durationMs: 0,
        eventIds: input.eventIds,
        metadata: pruneUndefined({
          runId: input.context.runId,
          evalId: input.verdict.evalId,
          targetRef: input.verdict.targetRef,
          artifactId: input.provenance.target.artifactId,
          artifactType: input.provenance.target.artifactType,
          targetContentHash: input.provenance.target.contentHash,
          evidenceSnapshotHash: input.provenance.evidence.snapshotHash,
          missingTargetRef:
            input.verdict.findings.some(
              (finding) => finding.code === "eval.target.missing"
            )
              ? input.verdict.targetRef
              : undefined
        })
      },
      input.context
    )
  );

  const definitionKind =
    definition === undefined ? undefined : evalKind(definition);
  const checks =
    definition === undefined || definitionKind === undefined
      ? []
      : checksForDefinition(definition, definitionKind);

  for (const check of checks) {
    const checkStatus = checkSpanStatus(check, input.verdict);

    spans.push(
      await recordSpan(
        {
          spanId: spanId({ ...input, type: `eval.check.${check.id ?? index}`, index: index++ }),
          parentSpanId: rootSpanId,
          kind: "eval",
          name: `eval:${input.verdict.evalId}:check:${check.id ?? "anonymous"}`,
          status: checkStatus,
          startedAt,
          endedAt: startedAt,
          durationMs: 0,
          eventIds: input.eventIds,
          metadata: pruneUndefined({
            runId: input.context.runId,
            evalId: input.verdict.evalId,
            targetRef: input.verdict.targetRef,
            checkId: check.id,
            checkType: check.type ?? definitionKind,
            path: check.path,
            findingCodes: input.verdict.findings
              .map((finding) => finding.code)
              .filter((code): code is string => code !== undefined),
            decisionHash: input.provenance.decisionHash
          })
        },
        input.context
      )
    );
  }

  for (const finding of input.verdict.findings) {
    const model = modelMetadataFromFinding(finding);
    const toolSpan = firstRecord([model?.toolSpan]);

    if (model === undefined || toolSpan === undefined) {
      continue;
    }

    spans.push(
      await recordSpan(
        {
          spanId:
            stringFrom(toolSpan.spanId) ??
            spanId({ ...input, type: "tool.model_graded", index: index++ }),
          parentSpanId: rootSpanId,
          kind: "tool",
          name: `eval:${input.verdict.evalId}:model_graded`,
          status: toolStatusToSpanStatus(stringFrom(model.toolStatus)),
          startedAt,
          endedAt: startedAt,
          durationMs: 0,
          eventIds: input.eventIds,
          metadata: pruneUndefined({
            runId: input.context.runId,
            evalId: input.verdict.evalId,
            targetRef: input.verdict.targetRef,
            toolId: stringFrom(toolSpan.toolId),
            toolVersion: stringFrom(toolSpan.toolVersion),
            toolCallId: stringFrom(model.toolCallId),
            requestHash: stringFrom(toolSpan.argsHash),
            resultHash: stringFrom(toolSpan.resultHash),
            tokenBudget: numberFrom(toolSpan.tokenBudget),
            policyStatus: stringFrom(model.toolStatus),
            rubricRef: stringFrom(model.rubricRef),
            rubricHash: stringFrom(model.rubricHash),
            cacheStatus: stringFrom(toolSpan.cacheStatus),
            decisionHash: input.provenance.decisionHash
          })
        },
        input.context
      )
    );
  }

  return spans;
}

async function defaultAppendEvent(
  input: EvalEmissionAppendInput
): Promise<EvalEmissionAppendResult> {
  const moduleName = "@specwright/run-store";
  const runStore = (await import(moduleName)) as {
    appendEvent: (options: {
      rootDir?: string | undefined;
      runId: string;
      type: string;
      payload: unknown;
      id?: string | undefined;
      traceId?: string | undefined;
      causationId?: string | undefined;
      correlationId?: string | undefined;
      timestamp?: string | undefined;
    }) => Promise<{ event: EvalEmissionRuntimeEvent<unknown> }>;
  };

  try {
    return (await runStore.appendEvent({
      rootDir: input.rootDir,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      id: input.id,
      traceId: input.traceId,
      causationId: input.causationId,
      correlationId: input.correlationId,
      timestamp: input.timestamp
    })) as EvalEmissionAppendResult;
  } catch (error) {
    if (isRunStoreUnknownEventContract(error)) {
      throw new EvalEmissionError(
        "run_store_event_contract_missing",
        `Run store does not currently accept ${input.type}; inject an eval emission sink or add the shared runtime event contract.`,
        error
      );
    }

    throw error;
  }
}

async function defaultRecordSpan(
  span: EvalEmissionTraceSpanInput,
  context: EvalEmissionContext
): Promise<EvalEmissionTraceSpan> {
  const moduleName = "@specwright/trace-recorder";
  const traceRecorder = (await import(moduleName)) as {
    recordTraceSpan: (options: {
      rootDir?: string | undefined;
      runId: string;
      traceId?: string | undefined;
      span: EvalEmissionTraceSpanInput;
    }) => Promise<EvalEmissionTraceSpan>;
  };

  return traceRecorder.recordTraceSpan({
    rootDir: context.rootDir,
    runId: context.runId,
    traceId: context.traceId,
    span
  });
}

function buildLocalRuntimeEvent<TPayload>(input: {
  context: EvalEmissionContext;
  verdict: EvalVerdict;
  type: EvalEmissionEventType;
  payload: TPayload;
  sequence: number;
}): EvalEmissionRuntimeEvent<TPayload> {
  const timestamp = normalizeTimestamp(input.context.clock?.() ?? new Date());

  return pruneUndefined({
    id: eventId({
      context: input.context,
      verdict: input.verdict,
      type: input.type,
      index: input.sequence
    }),
    runId: input.context.runId,
    type: input.type,
    timestamp,
    sequence: input.sequence,
    traceId: input.context.traceId,
    causationId: input.context.causationId,
    correlationId: input.context.correlationId,
    contractId: `specwright.event.${input.type}`,
    contractVersion: "eval-runner.local.v1",
    schemaHash: hashValue({
      eventType: input.type,
      payloadSchema: "packages.eval-runner.packet05.v1"
    }),
    payload: input.payload
  }) as EvalEmissionRuntimeEvent<TPayload>;
}

function localEventSchema(type: EvalEmissionEventType) {
  return runtimeEventSchema(PayloadSchemas[type]).extend({
    type: z.literal(type),
    contractId: z.literal(`specwright.event.${type}`),
    contractVersion: z.literal("eval-runner.local.v1"),
    schemaHash: HashDigestSchema
  });
}

function assertProducedByKindRoundTrips(
  verdict: EvalVerdict,
  event: EvalEmissionRuntimeEvent<unknown>
) {
  const roundTripped = JSON.parse(
    JSON.stringify(event)
  ) as EvalEmissionRuntimeEvent<unknown>;
  const parsed = localEventSchema(event.type as EvalEmissionEventType).parse(
    roundTripped
  );
  const payload = parsed.payload as Partial<EvalVerdictRecordedPayload>;
  const kind = payload.verdict?.producedBy.kind;

  if (kind !== undefined && kind !== verdict.producedBy.kind) {
    throw new EvalEmissionError(
      "audit_gap.produced_by_kind_round_trip_failed",
      "producedBy.kind changed during event serialization"
    );
  }
}

function safeInputHashes(
  verdict: EvalVerdict,
  incomplete: EvalProvenanceIncompleteMarker[]
): DecisionInputHashes | undefined {
  try {
    return inputHashesFromVerdict(verdict);
  } catch (error) {
    incomplete.push({
      field: "inputHashes",
      reason: error instanceof Error ? error.message : "unavailable"
    });
    return undefined;
  }
}

function hashFromVerdict(
  verdict: EvalVerdict,
  field: "decisionHash",
  incomplete: EvalProvenanceIncompleteMarker[]
): HashDigest | undefined {
  const value = verdict.provenance?.[field];

  if (isHashDigest(value)) {
    return value;
  }

  incomplete.push({
    field,
    reason: `${field} unavailable from verdict provenance`
  });
  return undefined;
}

function definitionsForManyRequest(request: RunEvalsRequest) {
  const evalDefinitions = request.evalDefinitions;

  if (Array.isArray(evalDefinitions)) {
    return evalDefinitions;
  }

  if (evalDefinitions !== undefined) {
    return Object.values(evalDefinitions);
  }

  return request.evalRegistry?.entries.map((entry) => entry.definition) ?? [];
}

function definitionFromRequest(
  request: RunEvalRequest,
  evalId: string
): FixtureEvalDefinition | undefined {
  if (request.evalDefinition?.id === evalId) {
    return request.evalDefinition;
  }

  const definitions = request.evalDefinitions;

  if (Array.isArray(definitions)) {
    return definitions.find((definition) => definition.id === evalId);
  }

  if (definitions !== undefined) {
    return (definitions as Record<string, FixtureEvalDefinition>)[evalId];
  }

  return request.evalRegistry?.entries.find(
    (entry) => entry.definitionId === evalId
  )?.definition;
}

function datasetMetadata(
  request: RunEvalRequest,
  definition: FixtureEvalDefinition | undefined
) {
  const source = firstRecord([
    request.pinnedDataset,
    definition?.datasetRef,
    definition?.dataset,
    request.datasetManifest
  ]);

  return source === undefined ? undefined : pruneUndefined(source);
}

function graderMetadata(
  request: RunEvalRequest,
  verdict: EvalVerdict,
  definition: FixtureEvalDefinition | undefined
) {
  const model = firstRecord(
    verdict.findings.map((finding) => modelMetadataFromFinding(finding))
  );

  return pruneUndefined({
    ...(firstRecord([request.graderManifest, definition?.graderManifest]) ?? {}),
    ...(firstRecord([definition?.grader, definition?.modelGrader]) ?? {}),
    ...(model ?? {})
  });
}

function regressionMetadata(
  request: RunEvalRequest,
  definition: FixtureEvalDefinition | undefined
) {
  const source = firstRecord([
    request.regression,
    definition?.regression,
    verdictFindingRegression(definition)
  ]);

  return source === undefined ? undefined : pruneUndefined(source);
}

function verdictFindingRegression(
  definition: FixtureEvalDefinition | undefined
) {
  return firstRecord([definition?.metadata])?.regression;
}

function resolveArtifactForVerdict(
  input: EvalRunnerInput | undefined,
  targetRef: string
):
  | {
      key: string;
      artifact: EvalArtifactSnapshot;
    }
  | undefined {
  const entries = artifactEntries(input?.artifacts);

  return entries.find(([key, artifact]) =>
    artifactRefs(key, artifact).includes(targetRef)
  )?.[1] === undefined
    ? undefined
    : (() => {
        const [key, artifact] = entries.find(([entryKey, entryArtifact]) =>
          artifactRefs(entryKey, entryArtifact).includes(targetRef)
        ) as [string, EvalArtifactSnapshot];
        return { key, artifact };
      })();
}

function artifactEntries(
  artifacts:
    | Record<string, EvalArtifactSnapshot>
    | readonly EvalArtifactSnapshot[]
    | undefined
): Array<[string, EvalArtifactSnapshot]> {
  if (artifacts === undefined) {
    return [];
  }

  if (Array.isArray(artifacts)) {
    return artifacts.map((artifact, index) => [
      artifact.artifactId ?? artifact.id ?? String(index),
      artifact
    ]);
  }

  return Object.entries(artifacts).filter(
    (entry): entry is [string, EvalArtifactSnapshot] => isRecord(entry[1])
  );
}

function artifactRefs(key: string, artifact: EvalArtifactSnapshot) {
  const id = artifact.artifactId ?? artifact.id ?? key;

  return [
    key,
    artifact.id,
    artifact.artifactId,
    artifact.artifactType,
    id.startsWith("artifact:") ? id : `artifact:${id}`
  ].filter((value): value is string => typeof value === "string");
}

function checkSpanStatus(
  check: FixtureEvalCheck,
  verdict: EvalVerdict
): EvalEmissionTraceSpan["status"] {
  if (verdict.status === "pass" || verdict.status === "skipped") {
    return verdict.status;
  }

  const checkTargets = new Set([
    check.id,
    check.path,
    check.targetRef
  ].filter((value): value is string => value !== undefined));

  if (checkTargets.size === 0) {
    return verdict.status;
  }

  return verdict.findings.some(
    (finding) =>
      (finding.path !== undefined && checkTargets.has(finding.path)) ||
      (finding.targetRef !== undefined && checkTargets.has(finding.targetRef))
  )
    ? verdict.status
    : "pass";
}

function findingIdsForVerdict(verdict: EvalVerdict) {
  return verdict.findings.map((finding) => findingId(finding, verdict.evalId));
}

function findingId(finding: EvalFinding, evalId: string) {
  return (
    finding.id ??
    `finding:${hashValue({
      evalId,
      code: finding.code,
      targetRef: finding.targetRef,
      path: finding.path,
      message: finding.message
    })}`
  );
}

function modelMetadataFromFinding(
  finding: EvalFinding
): Record<string, unknown> | undefined {
  return firstRecord([finding.metadata?.modelAssisted]);
}

function hasCompleteModelPromotionProvenance(verdict: EvalVerdict) {
  return verdict.findings.some((finding) => {
    const model = modelMetadataFromFinding(finding);
    const toolSpan = firstRecord([model?.toolSpan]);

    return (
      typeof model?.rubricRef === "string" &&
      model.rubricRef.length > 0 &&
      typeof toolSpan?.spanId === "string" &&
      toolSpan.spanId.length > 0
    );
  });
}

function eventId(input: {
  context: EvalEmissionContext;
  verdict: EvalVerdict;
  type: EvalEmissionEventType;
  index: number;
}) {
  return (
    input.context.idFactory?.({
      kind: "event",
      type: input.type,
      index: input.index,
      runId: input.context.runId,
      traceId: input.context.traceId,
      evalId: input.verdict.evalId,
      decisionHash: input.verdict.provenance?.decisionHash
    }) ??
    `event:${hashValue({
      runId: input.context.runId,
      traceId: input.context.traceId,
      type: input.type,
      index: input.index,
      evalId: input.verdict.evalId,
      decisionHash: input.verdict.provenance?.decisionHash
    })}`
  );
}

function spanId(input: {
  context: EvalEmissionContext;
  verdict: EvalVerdict;
  type: string;
  index: number;
}) {
  return (
    input.context.idFactory?.({
      kind: "span",
      type: input.type,
      index: input.index,
      runId: input.context.runId,
      traceId: input.context.traceId,
      evalId: input.verdict.evalId,
      decisionHash: input.verdict.provenance?.decisionHash
    }) ??
    `span:${hashValue({
      runId: input.context.runId,
      traceId: input.context.traceId,
      type: input.type,
      index: input.index,
      evalId: input.verdict.evalId,
      decisionHash: input.verdict.provenance?.decisionHash
    })}`
  );
}

function normalizeTimestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toolStatusToSpanStatus(
  status: string | undefined
): EvalEmissionTraceSpan["status"] {
  switch (status) {
    case "success":
      return "success";
    case "denied":
      return "denied";
    case "approval_required":
      return "approval_required";
    case "failed":
      return "failed";
    default:
      return "needs_review";
  }
}

function isRunStoreUnknownEventContract(error: unknown) {
  return (
    isRecord(error) &&
    error.name === "RunStoreError" &&
    error.code === "unknown_event_contract"
  );
}

function isHashDigest(value: unknown): value is HashDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function firstRecord(values: readonly unknown[]) {
  return values.find(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefined(item)) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) {
      output[key] = pruneUndefined(child);
    }
  }

  return output as T;
}
