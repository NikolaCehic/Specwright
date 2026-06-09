import type {
  GateApprovalRequest,
  GateFinding,
  GateHumanQuestion,
  GateLifecycleInstruction,
  GateRepairTask,
  GateRequiredAction,
  GateSeverity,
  GateVerdict
} from "@specwright/schemas";
import {
  gateDecisionHashInput,
  hashDecision,
  hashJson,
  type HashDigest
} from "./decision-hash";
import {
  hashGateDefinition as hashResolvedGateDefinition,
  hashMissingGateDefinition
} from "./definition-hash";
import {
  assertLinkable,
  type GateAuditGap,
  type PriorFailingGateVerdictRef,
  type PriorFailingVerdictLink
} from "./replay-linkage";
import type {
  EvaluateGateRequest,
  FixtureGateDefinition,
  GateCheck,
  GateEvaluationInput,
  GateEvaluationResult,
  HashedGateVerdict,
  ModelAssistedEvaluationProvenance
} from "./index";

export type GateAuditEventType =
  | "gate.evaluated"
  | "gate.definition.missing"
  | "gate.check.unsupported"
  | "gate.input.missing"
  | "gate.repair_task.created"
  | "gate.review.requested"
  | "gate.run.failed";

export type GateEvaluatedRuntimePayload = {
  gateId: string;
  verdict: HashedGateVerdict;
  instruction: GateLifecycleInstruction;
};

export type GateCheckOutcomeProjection = {
  id: string;
  type: string;
  severity: GateSeverity;
  outcome: GateSpanStatus;
  targetRef?: string | undefined;
  evidenceRefs: string[];
};

export type GateEvaluatedPayload = GateEvaluatedRuntimePayload & {
  definitionHash: HashDigest;
  inputRefHashes: Record<string, HashDigest>;
  decisionHash: string;
  evaluator: GateVerdict["evaluator"];
  checks: GateCheckOutcomeProjection[];
  missingInputs: GateMissingInputProjection[];
  modelAssisted?: ModelAssistedEvaluationProvenance | undefined;
  priorFailingVerdict?: PriorFailingVerdictLink | undefined;
  auditGaps?: GateAuditGap[] | undefined;
};

export type GateDefinitionMissingPayload = {
  gateId: string;
  phase: string;
  reason: string;
  requiredAction: Extract<GateRequiredAction, "fail_run">;
  decisionHash: string;
};

export type GateUnsupportedCheckPayload = {
  gateId: string;
  phase: string;
  unsupportedChecks: Array<{
    id: string;
    type: string;
    reason: string;
    targetRef?: string | undefined;
  }>;
  decisionHash: string;
};

export type GateMissingInputProjection = {
  id: string;
  message: string;
  targetRef?: string | undefined;
};

export type GateInputMissingPayload = {
  gateId: string;
  phase: string;
  missingInputs: GateMissingInputProjection[];
  requiredAction: Extract<GateRequiredAction, "clarify">;
  decisionHash: string;
};

export type GateRepairTaskCreatedPayload = {
  gateId: string;
  phase: string;
  repairTask: GateRepairTask;
  createdFromFindingIds: string[];
  decisionHash: string;
};

export type GateReviewRequestedPayload =
  | {
      gateId: string;
      phase: string;
      reviewKind: "human_question";
      question: GateHumanQuestion;
      requiredFor: string;
      decisionHash: string;
    }
  | {
      gateId: string;
      phase: string;
      reviewKind: "approval_request";
      approvalRequest: GateApprovalRequest;
      requiredFor: string;
      decisionHash: string;
    };

export type GateRunFailedPayload = {
  gateId: string;
  phase: string;
  reason: string;
  originatingFindingIds: string[];
  decisionHash: string;
};

export type GateAuditEventPayload =
  | GateEvaluatedPayload
  | GateDefinitionMissingPayload
  | GateUnsupportedCheckPayload
  | GateInputMissingPayload
  | GateRepairTaskCreatedPayload
  | GateReviewRequestedPayload
  | GateRunFailedPayload;

export type GateAuditEventProjection<
  TPayload extends GateAuditEventPayload = GateAuditEventPayload
> = {
  type: GateAuditEventType;
  payload: TPayload;
  runtimePayload?: GateEvaluatedRuntimePayload | undefined;
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
};

export type GateSpanKind =
  | "gate"
  | "gate.input_resolution"
  | "gate.check"
  | "tool";

export type GateSpanStatus =
  | "success"
  | "failed"
  | "denied"
  | "approval_required"
  | "pass"
  | "fail"
  | "needs_review"
  | "skipped";

export type GateSpanDescriptor = {
  spanId: string;
  parentSpanId?: string | undefined;
  kind: GateSpanKind;
  name: string;
  status: GateSpanStatus;
  startedAt: string;
  endedAt: string;
  metadata: Record<string, unknown>;
};

export type GateMetricSample = {
  name:
    | "gate_evaluations_total"
    | "gate_instruction_total"
    | "gate_check_failures_total"
    | "gate_fail_closed_total"
    | "gate_model_assisted_calls_total"
    | "gate_repair_loop_iterations"
    | "gate_review_wait_seconds"
    | "gate_evaluation_duration_seconds";
  value: number;
  labels: Record<string, string>;
};

export type GateAuditContext = {
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  isReevaluation?: boolean | undefined;
  priorFailure?: PriorFailingGateVerdictRef | undefined;
  evaluationDurationSeconds?: number | undefined;
  reviewWaitSeconds?: number | undefined;
};

export type BuildGateAuditRecordInput = {
  request: EvaluateGateRequest;
  result: GateEvaluationResult;
  context?: GateAuditContext | undefined;
};

export type GateAuditRecord = {
  events: GateAuditEventProjection[];
  spans: GateSpanDescriptor[];
  metrics: GateMetricSample[];
  definitionHash: HashDigest;
  inputRefHashes: Record<string, HashDigest>;
  auditGaps: GateAuditGap[];
};

export type GateAuditGuardFinding = {
  code:
    | "missing_gate_evaluated"
    | "decision_hash_mismatch"
    | "model_assisted_tool_span_missing"
    | "model_assisted_rubric_missing"
    | "unlinked_reevaluation_pass";
  message: string;
  gateId?: string | undefined;
  decisionHash?: string | undefined;
};

export type GateAuditGuardResult = {
  ok: boolean;
  findings: GateAuditGuardFinding[];
};

export function buildGateAuditRecord(
  input: BuildGateAuditRecordInput
): GateAuditRecord {
  const { request, result } = input;
  const context = input.context ?? {};
  const definition = gateDefinitionForAudit(request);
  const definitionHash = hashGateDefinitionForRequest(request);
  const inputRefHashes = hashInputRefs(request.input);
  const missingInputs = missingInputsForAudit(definition?.inputs, request.input, result.verdict);
  const checks = checkOutcomesFor(definition?.checks ?? [], result);
  const replay = assertLinkable({
    verdict: result.verdict,
    instruction: result.instruction,
    priorFailure: context.priorFailure,
    isReevaluation: context.isReevaluation,
    causationId: context.causationId
  });
  const evaluatedPayload = compactEvaluatedPayload({
    result,
    definitionHash,
    inputRefHashes,
    checks,
    missingInputs,
    priorFailingVerdict: replay.priorFailingVerdict,
    auditGaps: replay.auditGaps
  });
  const evaluatedEvent = eventProjection({
    type: "gate.evaluated",
    payload: evaluatedPayload,
    runtimePayload: {
      gateId: result.verdict.gateId,
      verdict: result.verdict,
      instruction: result.instruction
    },
    traceId: context.traceId ?? request.traceId,
    causationId: replay.causationId,
    correlationId: context.correlationId
  });
  const events = [
    evaluatedEvent,
    ...siblingEventProjections({
      result,
      checks,
      missingInputs,
      traceId: context.traceId ?? request.traceId,
      causationId: replay.causationId,
      correlationId: context.correlationId
    })
  ];

  return {
    events,
    spans: spanDescriptorsFor({
      request,
      result,
      definition,
      definitionHash,
      inputRefHashes,
      missingInputs,
      checks
    }),
    metrics: metricSamplesFor({
      request,
      result,
      checks,
      evaluationDurationSeconds: context.evaluationDurationSeconds,
      reviewWaitSeconds: context.reviewWaitSeconds
    }),
    definitionHash,
    inputRefHashes,
    auditGaps: replay.auditGaps
  };
}

function hashGateDefinitionForRequest(request: EvaluateGateRequest): HashDigest {
  const definition = gateDefinitionForAudit(request);

  return definition === undefined
    ? hashMissingGateDefinition(request.gateId)
    : hashResolvedGateDefinition(definition);
}

export function hashInputRefs(
  input: GateEvaluationInput | undefined
): Record<string, HashDigest> {
  const hashes: Record<string, HashDigest> = {};

  if (input === undefined) {
    return hashes;
  }

  if (input.runInput !== undefined) {
    hashes.runInput = hashJson(input.runInput);
  }

  addRecordHashes(hashes, "data", input.data);
  addRecordHashes(hashes, "artifact", input.artifacts);
  addEvidenceHashes(hashes, input.evidence);
  addRecordHashes(hashes, "eval", input.evals);
  addRecordHashes(hashes, "decision", input.decisions);
  addPolicyHashes(hashes, input.policy);

  return sortRecord(hashes);
}

export function assertGateAuditReconstructable(input: {
  events: readonly GateAuditEventProjection[];
  spans: readonly GateSpanDescriptor[];
}): GateAuditGuardResult {
  const findings: GateAuditGuardFinding[] = [];
  const evaluatedEvents = input.events.filter(
    (event): event is GateAuditEventProjection<GateEvaluatedPayload> =>
      event.type === "gate.evaluated"
  );

  for (const event of input.events) {
    const instruction = instructionFromEvent(event);

    if (
      instruction !== undefined &&
      isAdvancingInstruction(instruction) &&
      event.type !== "gate.evaluated" &&
      !hasMatchingEvaluatedEvent(evaluatedEvents, instruction.gateId)
    ) {
      findings.push({
        code: "missing_gate_evaluated",
        gateId: instruction.gateId,
        message: `Instruction ${instruction.kind} for gate ${instruction.gateId} has no matching gate.evaluated event`
      });
    }
  }

  for (const event of evaluatedEvents) {
    const verdict = event.payload.verdict;
    const { decisionHash: _decisionHash, ...withoutHash } = verdict;
    const recomputed = hashDecision(gateDecisionHashInput(withoutHash));

    if (recomputed !== verdict.decisionHash) {
      findings.push({
        code: "decision_hash_mismatch",
        gateId: verdict.gateId,
        decisionHash: verdict.decisionHash,
        message: `Decision hash for gate ${verdict.gateId} did not recompute`
      });
    }

    const calls = event.payload.modelAssisted?.calls ?? [];

    for (const call of calls) {
      const toolSpan = input.spans.find(
        (span) =>
          span.kind === "tool" &&
          span.metadata.checkId === call.checkId &&
          span.metadata.modelCallId === call.modelCallId
      );

      if (toolSpan === undefined) {
        findings.push({
          code: "model_assisted_tool_span_missing",
          gateId: verdict.gateId,
          decisionHash: verdict.decisionHash,
          message: `Model-assisted check ${call.checkId} lacks a linked tool span`
        });
      }

      if (
        call.rubric.ref.trim().length === 0 ||
        call.rubric.hash.trim().length === 0 ||
        toolSpan?.metadata.rubricRef !== call.rubric.ref
      ) {
        findings.push({
          code: "model_assisted_rubric_missing",
          gateId: verdict.gateId,
          decisionHash: verdict.decisionHash,
          message: `Model-assisted check ${call.checkId} lacks a rubric ref linkage`
        });
      }
    }

    if (
      event.payload.verdict.status === "pass" &&
      event.payload.auditGaps?.some(
        (gap) => gap.code === "unlinked_reevaluation_pass"
      )
    ) {
      findings.push({
        code: "unlinked_reevaluation_pass",
        gateId: verdict.gateId,
        decisionHash: verdict.decisionHash,
        message: `Re-evaluation pass for gate ${verdict.gateId} lacks a prior failing verdict link`
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings
  };
}

function compactEvaluatedPayload(input: {
  result: GateEvaluationResult;
  definitionHash: HashDigest;
  inputRefHashes: Record<string, HashDigest>;
  checks: GateCheckOutcomeProjection[];
  missingInputs: GateMissingInputProjection[];
  priorFailingVerdict?: PriorFailingVerdictLink | undefined;
  auditGaps: GateAuditGap[];
}): GateEvaluatedPayload {
  return {
    gateId: input.result.verdict.gateId,
    verdict: input.result.verdict,
    instruction: input.result.instruction,
    definitionHash: input.definitionHash,
    inputRefHashes: input.inputRefHashes,
    decisionHash: input.result.verdict.decisionHash,
    evaluator: input.result.verdict.evaluator,
    checks: input.checks,
    missingInputs: input.missingInputs,
    ...(input.result.modelAssisted === undefined
      ? {}
      : { modelAssisted: input.result.modelAssisted }),
    ...(input.priorFailingVerdict === undefined
      ? {}
      : { priorFailingVerdict: input.priorFailingVerdict }),
    ...(input.auditGaps.length === 0 ? {} : { auditGaps: input.auditGaps })
  };
}

function siblingEventProjections(input: {
  result: GateEvaluationResult;
  checks: GateCheckOutcomeProjection[];
  missingInputs: GateMissingInputProjection[];
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
}): GateAuditEventProjection[] {
  const events: GateAuditEventProjection[] = [];
  const common = {
    traceId: input.traceId,
    causationId: input.causationId,
    correlationId: input.correlationId
  };
  const verdict = input.result.verdict;
  const firstReason = verdict.reasons[0] ?? `Gate ${verdict.gateId} failed`;

  if (verdict.findings.some((finding) => finding.id === "gate.definition.missing")) {
    events.push(
      eventProjection({
        type: "gate.definition.missing",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          reason: firstReason,
          requiredAction: "fail_run",
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  const unsupportedChecks = input.checks
    .filter(
      (check) =>
        check.outcome === "fail" &&
        verdict.findings.some(
          (finding) =>
            finding.id === `gate.check.${check.id}.unknown_type` ||
            finding.message === `Unsupported gate check type ${check.type}`
        )
    )
    .map((check) => ({
      id: check.id,
      type: check.type,
      reason:
        verdict.findings.find(
          (finding) =>
            finding.id === `gate.check.${check.id}.unknown_type` ||
            finding.message === `Unsupported gate check type ${check.type}`
        )?.message ?? `Unsupported gate check type ${check.type}`,
      ...(check.targetRef === undefined ? {} : { targetRef: check.targetRef })
    }));

  if (unsupportedChecks.length > 0) {
    events.push(
      eventProjection({
        type: "gate.check.unsupported",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          unsupportedChecks,
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  if (input.missingInputs.length > 0) {
    events.push(
      eventProjection({
        type: "gate.input.missing",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          missingInputs: input.missingInputs,
          requiredAction: "clarify",
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  if (input.result.instruction.kind === "create_repair_task") {
    events.push(
      eventProjection({
        type: "gate.repair_task.created",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          repairTask: input.result.instruction.repairTask,
          createdFromFindingIds:
            input.result.instruction.repairTask.createdFromFindingIds ?? [],
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  if (input.result.instruction.kind === "pause_for_human") {
    events.push(
      eventProjection({
        type: "gate.review.requested",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          reviewKind: "human_question",
          question: input.result.instruction.question,
          requiredFor: input.result.instruction.question.requiredFor,
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  if (input.result.instruction.kind === "request_approval") {
    events.push(
      eventProjection({
        type: "gate.review.requested",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          reviewKind: "approval_request",
          approvalRequest: input.result.instruction.approvalRequest,
          requiredFor: input.result.instruction.approvalRequest.requiredFor,
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  if (input.result.instruction.kind === "fail_run") {
    events.push(
      eventProjection({
        type: "gate.run.failed",
        payload: {
          gateId: verdict.gateId,
          phase: verdict.phase,
          reason: input.result.instruction.reason,
          originatingFindingIds: verdict.findings.map((finding) => finding.id),
          decisionHash: verdict.decisionHash
        },
        ...common
      })
    );
  }

  return events;
}

function eventProjection<TPayload extends GateAuditEventPayload>(input: {
  type: GateAuditEventType;
  payload: TPayload;
  runtimePayload?: GateEvaluatedRuntimePayload | undefined;
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
}): GateAuditEventProjection<TPayload> {
  return {
    type: input.type,
    payload: input.payload,
    ...(input.runtimePayload === undefined
      ? {}
      : { runtimePayload: input.runtimePayload }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    ...(input.causationId === undefined
      ? {}
      : { causationId: input.causationId }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId })
  };
}

function spanDescriptorsFor(input: {
  request: EvaluateGateRequest;
  result: GateEvaluationResult;
  definition: FixtureGateDefinition | undefined;
  definitionHash: HashDigest;
  inputRefHashes: Record<string, HashDigest>;
  missingInputs: GateMissingInputProjection[];
  checks: GateCheckOutcomeProjection[];
}): GateSpanDescriptor[] {
  const verdict = input.result.verdict;
  const rootSpanId = spanIdFor("gate", verdict.decisionHash);
  const evaluatedAt = verdict.evaluatedAt;
  const runId = input.request.input?.runId;
  const traceId = input.request.traceId;
  const spans: GateSpanDescriptor[] = [
    {
      spanId: rootSpanId,
      kind: "gate",
      name: `gate.${verdict.gateId}`,
      status: verdict.status,
      startedAt: evaluatedAt,
      endedAt: evaluatedAt,
      metadata: compactRecord({
        runId,
        traceId,
        gateId: verdict.gateId,
        phase: verdict.phase,
        definitionVersion: definitionVersion(input.definition),
        definitionHash: input.definitionHash,
        evaluatorKind: verdict.evaluator.kind,
        evaluatorRef: verdict.evaluator.ref,
        instructionKind: input.result.instruction.kind,
        decisionHash: verdict.decisionHash
      })
    },
    {
      spanId: spanIdFor("gate.input_resolution", verdict.decisionHash),
      parentSpanId: rootSpanId,
      kind: "gate.input_resolution",
      name: `gate.${verdict.gateId}.input_resolution`,
      status: input.missingInputs.length > 0 ? "fail" : "success",
      startedAt: evaluatedAt,
      endedAt: evaluatedAt,
      metadata: {
        gateId: verdict.gateId,
        phase: verdict.phase,
        inputRefHashes: input.inputRefHashes,
        missingInputIds: input.missingInputs.map((missing) => missing.id)
      }
    }
  ];
  const checkSpanIds = new Map<string, string>();

  for (const check of input.checks) {
    const spanId = spanIdFor("gate.check", verdict.decisionHash, check.id);
    checkSpanIds.set(check.id, spanId);
    spans.push({
      spanId,
      parentSpanId: rootSpanId,
      kind: "gate.check",
      name: `gate.${verdict.gateId}.check.${check.id}`,
      status: check.outcome,
      startedAt: evaluatedAt,
      endedAt: evaluatedAt,
      metadata: compactRecord({
        gateId: verdict.gateId,
        phase: verdict.phase,
        checkId: check.id,
        checkType: check.type,
        severity: check.severity,
        outcome: check.outcome,
        targetRef: check.targetRef,
        evidenceRefs: check.evidenceRefs
      })
    });
  }

  for (const call of input.result.modelAssisted?.calls ?? []) {
    spans.push({
      spanId: spanIdFor("tool", verdict.decisionHash, call.modelCallId),
      parentSpanId: checkSpanIds.get(call.checkId) ?? rootSpanId,
      kind: "tool",
      name: `gate.${verdict.gateId}.tool.${call.checkId}`,
      status: toolSpanStatus(call.outcome),
      startedAt: evaluatedAt,
      endedAt: evaluatedAt,
      metadata: compactRecord({
        gateId: verdict.gateId,
        phase: verdict.phase,
        checkId: call.checkId,
        modelCallId: call.modelCallId,
        toolId: call.tool.toolId,
        toolVersion: call.tool.toolVersion,
        requestHash: call.tool.requestHash,
        resultHash: call.tool.resultHash,
        argsHash: call.tool.argsHash,
        cacheStatus: call.tool.cacheStatus,
        tokenBudget: call.tool.tokenBudget,
        policyStatus: call.tool.policyStatus,
        rubricRef: call.rubric.ref,
        rubricHash: call.rubric.hash,
        brokerTraceId: call.tool.traceId,
        outcome: call.outcome
      })
    });
  }

  return spans;
}

function metricSamplesFor(input: {
  request: EvaluateGateRequest;
  result: GateEvaluationResult;
  checks: GateCheckOutcomeProjection[];
  evaluationDurationSeconds?: number | undefined;
  reviewWaitSeconds?: number | undefined;
}): GateMetricSample[] {
  const verdict = input.result.verdict;
  const samples: GateMetricSample[] = [
    metric("gate_evaluations_total", 1, {
      gateId: verdict.gateId,
      phase: verdict.phase,
      status: verdict.status
    }),
    metric("gate_instruction_total", 1, {
      kind: input.result.instruction.kind
    }),
    metric("gate_repair_loop_iterations", repairLoopIterations(input.request.input), {
      gateId: verdict.gateId,
      phase: verdict.phase
    }),
    metric("gate_evaluation_duration_seconds", input.evaluationDurationSeconds ?? 0, {
      kind: verdict.evaluator.kind
    })
  ];

  if (
    input.result.instruction.kind === "pause_for_human" ||
    input.result.instruction.kind === "request_approval"
  ) {
    samples.push(
      metric("gate_review_wait_seconds", input.reviewWaitSeconds ?? 0, {
        gateId: verdict.gateId,
        phase: verdict.phase,
        kind: input.result.instruction.kind
      })
    );
  }

  if (verdict.status === "fail") {
    for (const finding of verdict.findings) {
      samples.push(
        metric("gate_check_failures_total", 1, {
          checkType: checkTypeForFinding(finding, input.checks),
          severity: finding.severity
        })
      );
    }
  }

  for (const call of input.result.modelAssisted?.calls ?? []) {
    samples.push(
      metric("gate_model_assisted_calls_total", 1, {
        outcome: call.outcome
      })
    );
  }

  const failClosedReason = failClosedReasonFor(verdict);

  if (failClosedReason !== undefined) {
    samples.push(
      metric("gate_fail_closed_total", 1, {
        reason: failClosedReason
      })
    );
  }

  return samples;
}

function gateDefinitionForAudit(
  request: EvaluateGateRequest
): FixtureGateDefinition | undefined {
  if (request.gateDefinition !== undefined) {
    return request.gateDefinition;
  }

  const definitions = request.gateDefinitions;

  if (definitions === undefined) {
    return undefined;
  }

  if (Array.isArray(definitions)) {
    return definitions.find((definition) => definition.id === request.gateId);
  }

  return (definitions as Record<string, FixtureGateDefinition>)[request.gateId];
}

function checkOutcomesFor(
  checks: readonly GateCheck[],
  result: GateEvaluationResult
): GateCheckOutcomeProjection[] {
  return checks.map((check) => {
    const finding = findingForCheck(check, result.verdict.findings);
    const call = result.modelAssisted?.calls.find((entry) => entry.checkId === check.id);
    const modelSkipped =
      check.type === "model_assisted" &&
      call === undefined &&
      result.verdict.status === "fail" &&
      result.verdict.evaluator.kind === "deterministic";
    const outcome: GateSpanStatus =
      finding === undefined
        ? modelSkipped
          ? "skipped"
          : "pass"
        : result.verdict.status === "needs_review"
          ? "needs_review"
          : "fail";

    return {
      id: check.id,
      type: check.type,
      severity: check.severity ?? result.verdict.severity,
      outcome,
      ...(check.targetRef === undefined ? {} : { targetRef: check.targetRef }),
      evidenceRefs: check.evidenceRefs ?? finding?.evidenceRefs ?? []
    };
  });
}

function findingForCheck(
  check: Pick<GateCheck, "id" | "type">,
  findings: readonly GateFinding[]
): GateFinding | undefined {
  return findings.find(
    (finding) =>
      finding.id === check.id ||
      finding.id === `gate.check.${check.id}.unknown_type` ||
      finding.message === `Unsupported gate check type ${check.type}`
  );
}

function missingInputsForAudit(
  inputs: unknown,
  input: GateEvaluationInput | undefined,
  verdict: GateVerdict
): GateMissingInputProjection[] {
  const fromFindings = verdict.findings
    .filter(
      (finding) =>
        finding.id.startsWith("input.") && finding.id.endsWith(".missing")
    )
    .map((finding) =>
      compactMissingInput({
        id: finding.id.slice("input.".length, -".missing".length),
        message: finding.message,
        targetRef: finding.targetRef
      })
    );

  if (fromFindings.length > 0 || inputs === undefined) {
    return fromFindings;
  }

  if (Array.isArray(inputs)) {
    return inputs
      .filter((entry): entry is string => typeof entry === "string")
      .filter((name) => !isPresent(inputValueByName(name, input)))
      .map((name) =>
        compactMissingInput({
          id: name,
          message: `Required gate input ${name} is missing`,
          targetRef: `input:${name}`
        })
      );
  }

  if (!isRecord(inputs)) {
    return [];
  }

  const missing: GateMissingInputProjection[] = [];
  collectMissingNamedInputs(missing, "artifacts", inputs.artifacts, input);
  collectMissingNamedInputs(missing, "evals", inputs.evals, input);
  collectMissingNamedInputs(missing, "decisions", inputs.decisions, input);
  collectMissingNamedInputs(missing, "policy", inputs.policy, input);

  if (inputs.runInput === true && !isPresent(input?.runInput)) {
    missing.push(
      compactMissingInput({
        id: "runInput",
        message: "Required gate input runInput is missing",
        targetRef: "input:runInput"
      })
    );
  }

  if (inputs.evidence === true && !isPresent(input?.evidence)) {
    missing.push(
      compactMissingInput({
        id: "evidence",
        message: "Required gate input evidence is missing",
        targetRef: "input:evidence"
      })
    );
  }

  return missing;
}

function collectMissingNamedInputs(
  missing: GateMissingInputProjection[],
  kind: "artifacts" | "evals" | "decisions" | "policy",
  value: unknown,
  input: GateEvaluationInput | undefined
) {
  if (!Array.isArray(value)) {
    return;
  }

  for (const id of value) {
    if (typeof id !== "string") {
      continue;
    }

    const present =
      kind === "artifacts"
        ? input?.artifacts?.[id]
        : kind === "evals"
          ? input?.evals?.[id]
          : kind === "decisions"
            ? input?.decisions?.[id]
            : policySnapshotById(input?.policy, id);

    if (!isPresent(present)) {
      missing.push(
        compactMissingInput({
          id,
          message: `Required gate ${kind.slice(0, -1)} ${id} is missing`,
          targetRef: `${kind.slice(0, -1)}:${id}`
        })
      );
    }
  }
}

function compactMissingInput(input: GateMissingInputProjection) {
  return {
    id: input.id,
    message: input.message,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef })
  };
}

function addRecordHashes(
  target: Record<string, HashDigest>,
  prefix: string,
  value: Record<string, unknown> | undefined
) {
  if (value === undefined) {
    return;
  }

  for (const key of Object.keys(value).sort()) {
    target[`${prefix}:${key}`] = hashJson(value[key]);
  }
}

function addEvidenceHashes(
  target: Record<string, HashDigest>,
  evidence: GateEvaluationInput["evidence"] | undefined
) {
  if (evidence === undefined) {
    return;
  }

  target.evidence = hashJson(evidence);

  if (isRecord(evidence.refs)) {
    for (const ref of Object.keys(evidence.refs).sort()) {
      target[`evidence:${ref}`] = hashJson(evidence.refs[ref]);
    }
  }

  for (const collectionName of ["items", "sources", "records"] as const) {
    const collection = evidence[collectionName];

    if (!Array.isArray(collection)) {
      continue;
    }

    collection.forEach((entry, index) => {
      const id = idFromRecord(entry) ?? `${collectionName}:${index}`;
      target[`evidence:${id}`] = hashJson(entry);
    });
  }
}

function addPolicyHashes(
  target: Record<string, HashDigest>,
  policy: GateEvaluationInput["policy"] | undefined
) {
  if (policy === undefined) {
    return;
  }

  if (Array.isArray(policy)) {
    policy.forEach((verdict, index) => {
      const id = policyIdFor(verdict) ?? String(index);
      target[`policy:${id}`] = hashJson(verdict);
    });
    return;
  }

  if (isPolicyVerdictLike(policy)) {
    target[`policy:${policyIdFor(policy) ?? "verdict"}`] = hashJson(policy);
    return;
  }

  addRecordHashes(target, "policy", policy as Record<string, unknown>);
}

function policySnapshotById(
  policy: GateEvaluationInput["policy"] | undefined,
  id: string
) {
  if (policy === undefined) {
    return undefined;
  }

  if (Array.isArray(policy)) {
    return policy.find((entry) => policyIdFor(entry) === id);
  }

  if (isPolicyVerdictLike(policy)) {
    return policyIdFor(policy) === id ? policy : undefined;
  }

  return (policy as Record<string, unknown>)[id];
}

function policyIdFor(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return stringValue(value.id) ?? stringValue(value.policyId) ?? stringValue(value.requestId);
}

function idFromRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return stringValue(value.id) ?? stringValue(value.ref) ?? stringValue(value.evidenceRef);
}

function inputValueByName(
  name: string,
  input: GateEvaluationInput | undefined
): unknown {
  if (input === undefined) {
    return undefined;
  }

  const aliases: Record<string, unknown> = {
    run_input: input.runInput ?? input.data?.run_input,
    runInput: input.runInput,
    evidence_graph: input.evidence ?? input.data?.evidence_graph,
    evidence: input.evidence,
    artifacts: input.artifacts,
    evals: input.evals,
    decisions: input.decisions,
    policy: input.policy
  };

  if (name in aliases) {
    return aliases[name];
  }

  return (
    input.data?.[name] ??
    input.artifacts?.[name] ??
    input.evals?.[name] ??
    input.decisions?.[name] ??
    policySnapshotById(input.policy, name)
  );
}

function instructionFromEvent(
  event: GateAuditEventProjection
): GateLifecycleInstruction | undefined {
  const payload = event.payload as Record<string, unknown>;
  const instruction = payload.instruction;

  if (isRecord(instruction) && typeof instruction.gateId === "string") {
    switch (instruction.kind) {
      case "continue":
      case "transition_phase":
      case "pause_for_human":
      case "request_approval":
      case "create_repair_task":
      case "fail_run":
        return instruction as GateLifecycleInstruction;
      default:
        return undefined;
    }
  }

  return undefined;
}

function isAdvancingInstruction(instruction: GateLifecycleInstruction) {
  return (
    instruction.kind === "continue" ||
    instruction.kind === "transition_phase"
  );
}

function hasMatchingEvaluatedEvent(
  events: readonly GateAuditEventProjection<GateEvaluatedPayload>[],
  gateId: string
) {
  return events.some((event) => event.payload.gateId === gateId);
}

function checkTypeForFinding(
  finding: GateFinding,
  checks: readonly GateCheckOutcomeProjection[]
) {
  return (
    checks.find(
      (check) =>
        finding.id === check.id ||
        finding.id === `gate.check.${check.id}.unknown_type`
    )?.type ?? "unknown"
  );
}

function failClosedReasonFor(verdict: GateVerdict): string | undefined {
  if (verdict.findings.some((finding) => finding.id === "gate.definition.missing")) {
    return "missing_definition";
  }

  if (
    verdict.findings.some(
      (finding) =>
        finding.id.startsWith("input.") && finding.id.endsWith(".missing")
    )
  ) {
    return "missing_input";
  }

  if (
    verdict.findings.some(
      (finding) =>
        finding.id.startsWith("gate.check.") &&
        finding.id.endsWith(".unknown_type")
    )
  ) {
    return "unsupported_check";
  }

  if (
    verdict.findings.some((finding) =>
      finding.message.startsWith("Referenced eval ")
    )
  ) {
    return "missing_eval";
  }

  if (
    verdict.findings.some((finding) =>
      finding.message.startsWith("Referenced policy verdict is missing")
    )
  ) {
    return "missing_policy";
  }

  return undefined;
}

function toolSpanStatus(outcome: string): GateSpanStatus {
  switch (outcome) {
    case "success":
      return "success";
    case "denied":
      return "denied";
    case "invalid_output":
    case "error":
      return "fail";
    default:
      return "failed";
  }
}

function metric(
  name: GateMetricSample["name"],
  value: number,
  labels: Record<string, string>
): GateMetricSample {
  return {
    name,
    value,
    labels: sortRecord(labels)
  };
}

function spanIdFor(kind: GateSpanKind, decisionHash: string, suffix = "root") {
  const digest = hashJson({ kind, decisionHash, suffix }).slice(
    "sha256:".length,
    "sha256:".length + 24
  );

  return `span_${kind.replace(/\W+/g, "_")}_${digest}`;
}

function definitionVersion(
  definition: FixtureGateDefinition | undefined
): string | undefined {
  if (definition === undefined) {
    return undefined;
  }

  return (
    stringValue(definition.version) ??
    stringValue(definition.definitionVersion) ??
    (isRecord(definition.metadata) ? stringValue(definition.metadata.version) : undefined)
  );
}

function repairLoopIterations(input: GateEvaluationInput | undefined) {
  return typeof input?.repairLoopIterations === "number" &&
    Number.isInteger(input.repairLoopIterations) &&
    input.repairLoopIterations >= 0
    ? input.repairLoopIterations
    : 0;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};

  for (const key of Object.keys(record).sort()) {
    const value = record[key];

    if (value !== undefined) {
      sorted[key] = value;
    }
  }

  return sorted;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};

  for (const key of Object.keys(record).sort()) {
    const value = record[key];

    if (value !== undefined) {
      compacted[key] = value;
    }
  }

  return compacted;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function isPolicyVerdictLike(value: unknown): boolean {
  return isRecord(value) && typeof value.status === "string";
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
