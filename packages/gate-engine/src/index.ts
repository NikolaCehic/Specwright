import {
  GateLifecycleInstructionSchema,
  GateVerdictSchema,
  ToolCallResultSchema,
  type ToolCallRequest,
  type ToolCallResult,
  type EvalVerdict,
  type GateApprovalRequest as ApprovalRequest,
  type GateDefinition,
  type GateFinding,
  type GateHumanQuestion as HumanQuestion,
  type GateKind,
  type GateLifecycleInstruction,
  type GateObligation,
  type GateRepairTask as RepairTask,
  type GateRequiredAction,
  type GateSeverity,
  type GateVerdict,
  type GateVerdictStatus,
  type PolicyVerdict,
  type PolicyVerdictStatus
} from "@specwright/schemas";
import type { ZodTypeAny } from "zod";
import {
  validateGateDefinition,
  type GateDefinitionFinding
} from "./definition";
import {
  gateDecisionHashInput,
  hashDecision,
  hashJson,
  stableStringify
} from "./decision-hash";
import { zodSchemaFromDeclaration } from "./schema-declaration";

export type {
  GateApprovalRequest as ApprovalRequest,
  GateFinding,
  GateHumanQuestion as HumanQuestion,
  GateLifecycleInstruction,
  GateObligation,
  GateRepairTask as RepairTask,
  GateRequiredAction,
  GateSeverity,
  GateVerdict,
  GateVerdictStatus,
  PolicyVerdict,
  PolicyVerdictStatus
} from "@specwright/schemas";
export {
  gateDecisionHashInput,
  hashDecision,
  hashJson,
  normalizeStable,
  stableStringify
} from "./decision-hash";
export type { GateDecisionHashInput, HashDigest } from "./decision-hash";

export const DEFAULT_EVALUATED_AT = "1970-01-01T00:00:00.000Z";
export const DEFAULT_GATE_ENGINE_EVALUATOR = "specwright.gate-engine.v0";

export type GateLifecycleInstructionKind =
  | "continue"
  | "transition_phase"
  | "pause_for_human"
  | "request_approval"
  | "create_repair_task"
  | "fail_run";

export type HashedGateVerdict = GateVerdict & { decisionHash: string };

export type GateEvaluationResult = {
  verdict: HashedGateVerdict;
  instruction: GateLifecycleInstruction;
  modelAssisted?: ModelAssistedEvaluationProvenance;
};

type UnhashedGateVerdict = Omit<GateVerdict, "decisionHash">;

export type GateArtifactSnapshot = {
  artifactId?: string;
  id?: string;
  artifactType?: string;
  status?: string;
  valid?: boolean;
  schemaValid?: boolean;
  content?: unknown;
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
} & Record<string, unknown>;

export type GateEvidenceSnapshot =
  | {
      refs?: Record<string, unknown>;
      items?: Array<Record<string, unknown>>;
      sources?: Array<Record<string, unknown>>;
      records?: Array<Record<string, unknown>>;
      evidenceRefs?: string[];
    }
  | Record<string, unknown>;

export type GatePolicyVerdict = PolicyVerdict & {
  id?: string;
  policyId?: string;
  requestId?: string;
};

export type GatePolicySnapshot =
  | GatePolicyVerdict
  | readonly GatePolicyVerdict[]
  | Record<string, GatePolicyVerdict>;

export type GateEvaluationInput = {
  runId?: string;
  phase?: string;
  runInput?: Record<string, unknown>;
  data?: Record<string, unknown>;
  artifacts?: Record<string, GateArtifactSnapshot>;
  evidence?: GateEvidenceSnapshot;
  evals?: Record<string, EvalVerdict>;
  decisions?: Record<string, unknown>;
  policy?: GatePolicySnapshot;
};

export type GateCheckBase = {
  id: string;
  type: string;
  message?: string;
  severity?: GateSeverity;
  targetRef?: string;
  evidenceRefs?: string[];
  repairHint?: string;
  requiredAction?: GateRequiredAction;
};

export type DeterministicPresenceCheck = GateCheckBase & {
  type: "deterministic";
  path: string;
  condition: "present";
};

export type SchemaPresenceCheck = GateCheckBase & {
  type: "schema";
  artifactId?: string;
  path?: string;
  requiredFields?: string[];
  required?: string[];
};

export type EvalStatusCheck = GateCheckBase & {
  type: "eval";
  evalId: string;
  allowedStatuses?: Array<EvalVerdict["status"]>;
  status?: EvalVerdict["status"];
};

export type EvidenceCoverageCheck = GateCheckBase & {
  type: "evidence";
  artifactId?: string;
  path?: string;
  evidenceRefs?: string[];
  minCount?: number;
};

export type PolicyStatusCheck = GateCheckBase & {
  type: "policy";
  policyId?: string;
  verdictId?: string;
  allowedStatuses?: PolicyVerdictStatus[];
  status?: PolicyVerdictStatus;
};

export type HumanReviewCheck = GateCheckBase & {
  type: "human_review";
  question?: string;
};

export type SupportedGateCheck =
  | DeterministicPresenceCheck
  | SchemaPresenceCheck
  | EvalStatusCheck
  | EvidenceCoverageCheck
  | PolicyStatusCheck
  | HumanReviewCheck;

export type ModelAssistedCheck = GateCheckBase & {
  type: "model_assisted";
  modelTool: string;
  inputSchema: unknown;
  outputSchema: unknown;
  rubric: {
    ref: string;
    hash: string;
  };
  allowedContextRefs: string[];
  maxTokens: number;
  onInvalidOutput?: "fail";
};

export type GateCheck = SupportedGateCheck | ModelAssistedCheck;

export type GateFailureAction =
  | "repair"
  | "create_repair_task"
  | "clarify"
  | "request_clarification"
  | "approve"
  | "request_approval"
  | "pause_for_human"
  | "fail_run";

export type GateFailureBehavior = {
  action?: GateFailureAction;
  questionTemplate?: string;
  approvalReason?: string;
  repairHint?: string;
  targetRef?: string;
  allowedTools?: string[];
  blockedTools?: string[];
  successGate?: string;
  requiredEvidenceRefs?: string[];
  expectedAnswerSchema?: string;
  obligations?: GateObligation[];
};

export type GatePassBehavior = {
  action?: "continue" | "transition_phase";
  targetPhase?: string;
  obligations?: GateObligation[];
};

export type FixtureGateDefinition = {
  id: string;
  phase?: string;
  kind?: GateKind;
  required?: boolean;
  description?: string;
  metadata?: GateDefinition["metadata"];
  severity?: GateSeverity;
  inputs?: unknown;
  checks?: GateCheck[];
  onFail?: GateFailureBehavior | GateFailureAction;
  onPass?: GatePassBehavior;
} & Record<string, unknown>;

export type EvaluateGateRequest = {
  gateId: string;
  phase?: string;
  gateDefinition?: FixtureGateDefinition;
  gateDefinitions?:
    | readonly FixtureGateDefinition[]
    | Record<string, FixtureGateDefinition>;
  input?: GateEvaluationInput;
  evaluatedAt?: Date | string;
  evaluatorRef?: string;
  broker?: BrokerPort;
  traceId?: string;
};

export type BrokerCallContext = {
  traceId?: string;
  runId?: string;
};

export type BrokerPort = (
  request: ToolCallRequest,
  context?: BrokerCallContext
) => Promise<ToolCallResult>;

export type ModelAssistedCallOutcome =
  | "success"
  | "invalid_output"
  | "denied"
  | "error";

export type ModelAssistedCallProvenance = {
  checkId: string;
  modelCallId: string;
  rubric: ModelAssistedCheck["rubric"];
  outcome: ModelAssistedCallOutcome;
  tool: {
    toolId: string;
    toolVersion?: string;
    requestHash: string;
    resultHash?: string;
    argsHash?: string;
    cacheStatus?: string;
    traceId?: string;
    tokenBudget: number;
    policyStatus: string;
  };
};

export type ModelAssistedEvaluationProvenance = {
  calls: ModelAssistedCallProvenance[];
};

type CheckEvaluation =
  | {
      status: "pass";
      evidenceRefs: string[];
    }
  | {
      status: "fail";
      finding: GateFinding;
      requiredAction?: GateRequiredAction | undefined;
      bypassOnFail?: boolean | undefined;
      evidenceRefs: string[];
    }
  | {
      status: "needs_review";
      finding: GateFinding;
      requiredAction: Extract<GateRequiredAction, "approve" | "clarify">;
      evidenceRefs: string[];
    };

type MissingInput = {
  id: string;
  message: string;
  targetRef?: string | undefined;
};

type GateDefinitionResolution =
  | { ok: true; definition: FixtureGateDefinition }
  | {
      ok: false;
      finding: GateDefinitionFinding;
      definitionPhase?: string | undefined;
    };

export function evaluateGate(request: EvaluateGateRequest): GateEvaluationResult {
  const resolvedDefinition = resolveGateDefinition(request);
  const evaluatedAt = normalizeEvaluatedAt(request.evaluatedAt);
  const phase =
    request.phase ??
    request.input?.phase ??
    (resolvedDefinition.ok
      ? resolvedDefinition.definition.phase
      : resolvedDefinition.definitionPhase) ??
    "unknown";
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_GATE_ENGINE_EVALUATOR;

  if (!resolvedDefinition.ok) {
    return failClosed({
      gateId: request.gateId,
      phase,
      evaluatedAt,
      evaluatorRef,
      reason: resolvedDefinition.finding.message,
      findingId: resolvedDefinition.finding.id,
      targetRef: resolvedDefinition.finding.targetRef,
      requiredAction: "fail_run"
    });
  }

  const definition = resolvedDefinition.definition;
  const gateId = definition.id;
  const severity = gateSeverity(definition);
  const input = request.input;
  const missingInputs = findMissingInputs(definition.inputs, input);

  if (missingInputs.length > 0) {
    return buildFailingResult({
      definition,
      phase,
      evaluatedAt,
      evaluatorRef,
      severity,
      findings: missingInputs.map((missingInput) =>
        makeFinding({
          id: `input.${missingInput.id}.missing`,
          severity,
          message: missingInput.message,
          targetRef: missingInput.targetRef
        })
      ),
      defaultRequiredAction: "clarify"
    });
  }

  const checks = definition.checks ?? [];
  const modelAssistedChecks = checks.filter(isModelAssistedCheck);

  if (modelAssistedChecks.length > 0) {
    const firstCheck = modelAssistedChecks[0] as ModelAssistedCheck;

    return failClosed({
      gateId,
      phase,
      evaluatedAt,
      evaluatorRef,
      reason: `Model-assisted gate check ${firstCheck.id} requires evaluateGateAsync`,
      findingId: `gate.check.${firstCheck.id}.requires_async_entrypoint`,
      targetRef: firstCheck.targetRef ?? `gate:${gateId}/check:${firstCheck.id}`,
      requiredAction: "fail_run"
    });
  }

  const evaluations = (checks as SupportedGateCheck[]).map((check) =>
    evaluateCheck(check, input, phase, severity)
  );
  return aggregateEvaluations({
    definition,
    phase,
    evaluatedAt,
    evaluatorRef,
    severity,
    evaluations,
    evaluatorKind: "deterministic"
  });
}

export async function evaluateGateAsync(
  request: EvaluateGateRequest
): Promise<GateEvaluationResult> {
  const resolvedDefinition = resolveGateDefinition(request);
  const evaluatedAt = normalizeEvaluatedAt(request.evaluatedAt);
  const phase =
    request.phase ??
    request.input?.phase ??
    (resolvedDefinition.ok
      ? resolvedDefinition.definition.phase
      : resolvedDefinition.definitionPhase) ??
    "unknown";
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_GATE_ENGINE_EVALUATOR;

  if (!resolvedDefinition.ok) {
    return failClosed({
      gateId: request.gateId,
      phase,
      evaluatedAt,
      evaluatorRef,
      reason: resolvedDefinition.finding.message,
      findingId: resolvedDefinition.finding.id,
      targetRef: resolvedDefinition.finding.targetRef,
      requiredAction: "fail_run"
    });
  }

  const definition = resolvedDefinition.definition;
  const severity = gateSeverity(definition);
  const input = request.input;
  const missingInputs = findMissingInputs(definition.inputs, input);

  if (missingInputs.length > 0) {
    return buildFailingResult({
      definition,
      phase,
      evaluatedAt,
      evaluatorRef,
      severity,
      findings: missingInputs.map((missingInput) =>
        makeFinding({
          id: `input.${missingInput.id}.missing`,
          severity,
          message: missingInput.message,
          targetRef: missingInput.targetRef
        })
      ),
      defaultRequiredAction: "clarify"
    });
  }

  const checks = definition.checks ?? [];
  const deterministicChecks = checks.filter(
    (check): check is SupportedGateCheck => !isModelAssistedCheck(check)
  );
  const modelAssistedChecks = checks.filter(isModelAssistedCheck);
  const deterministicEvaluations = deterministicChecks.map((check) =>
    evaluateCheck(check, input, phase, severity)
  );
  const deterministicFailed = deterministicEvaluations.some(
    (evaluation) => evaluation.status === "fail"
  );

  if (deterministicFailed || modelAssistedChecks.length === 0) {
    return aggregateEvaluations({
      definition,
      phase,
      evaluatedAt,
      evaluatorRef,
      severity,
      evaluations: deterministicEvaluations,
      evaluatorKind: "deterministic"
    });
  }

  const modelEvaluations: CheckEvaluation[] = [];
  const calls: ModelAssistedCallProvenance[] = [];

  for (const check of modelAssistedChecks) {
    const evaluated = await evaluateModelAssistedCheck({
      check,
      definition,
      input,
      phase,
      severity,
      broker: request.broker,
      evaluatedAt,
      traceId: request.traceId
    });
    modelEvaluations.push(evaluated.evaluation);
    calls.push(evaluated.provenance);
  }

  return aggregateEvaluations({
    definition,
    phase,
    evaluatedAt,
    evaluatorRef,
    severity,
    evaluations: [...deterministicEvaluations, ...modelEvaluations],
    evaluatorKind: "model_assisted",
    modelAssisted: {
      calls
    }
  });
}

function aggregateEvaluations(input: {
  definition: FixtureGateDefinition;
  phase: string;
  evaluatedAt: string;
  evaluatorRef: string;
  severity: GateSeverity;
  evaluations: CheckEvaluation[];
  evaluatorKind: GateVerdict["evaluator"]["kind"];
  modelAssisted?: ModelAssistedEvaluationProvenance;
}): GateEvaluationResult {
  const { definition, phase, evaluatedAt, evaluatorRef, severity, evaluations } =
    input;
  const gateId = definition.id;
  const failed = evaluations.filter(
    (evaluation): evaluation is Extract<CheckEvaluation, { status: "fail" }> =>
      evaluation.status === "fail"
  );
  const needsReview = evaluations.filter(
    (
      evaluation
    ): evaluation is Extract<CheckEvaluation, { status: "needs_review" }> =>
      evaluation.status === "needs_review"
  );
  const evidenceRefs = uniqueStrings(
    evaluations.flatMap((evaluation) => evaluation.evidenceRefs)
  );

  if (failed.length > 0) {
    const failClosedEvaluations = failed.filter(
      (evaluation) => evaluation.bypassOnFail === true
    );
    const bypassOnFail = failClosedEvaluations.length > 0;
    const orderedFailed = bypassOnFail
      ? [
          ...failClosedEvaluations,
          ...failed.filter((evaluation) => evaluation.bypassOnFail !== true)
        ]
      : failed;

    return buildFailingResult(withOptionalModelAssisted({
      definition,
      phase,
      evaluatedAt,
      evaluatorRef,
      severity,
      findings: orderedFailed.map((evaluation) => evaluation.finding),
      evidenceRefs,
      defaultRequiredAction: bypassOnFail
        ? "fail_run"
        : firstRequiredAction(failed) ?? "repair",
      evaluatorKind: input.evaluatorKind,
      bypassOnFail
    }, input.modelAssisted));
  }

  if (needsReview.length > 0) {
    const requiredAction = firstReviewRequiredAction(needsReview);
    const obligations = obligationsFor(definition.onFail);
    const findings = needsReview.map((evaluation) => evaluation.finding);
    const verdict = compactVerdict({
      gateId,
      phase,
      status: "needs_review",
      severity,
      reasons: findings.map((finding) => finding.message),
      findings,
      evidenceRefs,
      requiredAction,
      obligations,
      evaluatedAt,
      evaluator: {
        kind: input.evaluatorKind,
        ref: evaluatorRef
      }
    });

    return validatedGateResult(withOptionalModelAssisted({
      verdict,
      instruction: instructionForNeedsReview({
        definition,
        phase,
        verdict,
        requiredAction
      })
    }, input.modelAssisted));
  }

  const passObligations = definition.onPass?.obligations ?? [];
  const verdict = compactVerdict({
    gateId,
    phase,
    status: "pass",
    severity,
    reasons: [`Gate ${gateId} passed`],
    findings: [],
    evidenceRefs,
    obligations: passObligations,
    evaluatedAt,
    evaluator: {
      kind: input.evaluatorKind,
      ref: evaluatorRef
    }
  });

  return validatedGateResult(withOptionalModelAssisted({
    verdict,
    instruction: instructionForPass(definition, phase)
  }, input.modelAssisted));
}

function evaluateCheck(
  check: SupportedGateCheck,
  input: GateEvaluationInput | undefined,
  phase: string,
  gateSeverityValue: GateSeverity
): CheckEvaluation {
  switch (check.type) {
    case "deterministic":
      return evaluateDeterministicPresenceCheck(
        check,
        input,
        gateSeverityValue
      );
    case "schema":
      return evaluateSchemaPresenceCheck(check, input, gateSeverityValue);
    case "eval":
      return evaluateEvalStatusCheck(check, input, gateSeverityValue);
    case "evidence":
      return evaluateEvidenceCoverageCheck(check, input, gateSeverityValue);
    case "policy":
      return evaluatePolicyStatusCheck(check, input, gateSeverityValue);
    case "human_review":
      return {
        status: "needs_review",
        finding: makeFinding({
          id: check.id,
          severity: check.severity ?? gateSeverityValue,
          message: check.message ?? check.question ?? "Human review is required",
          targetRef: check.targetRef ?? `phase:${phase}`,
          evidenceRefs: check.evidenceRefs
        }),
        requiredAction: "clarify",
        evidenceRefs: check.evidenceRefs ?? []
      };
    default:
      return unsupportedCheck(check, gateSeverityValue);
  }
}

function evaluateDeterministicPresenceCheck(
  check: DeterministicPresenceCheck,
  input: GateEvaluationInput | undefined,
  severity: GateSeverity
): CheckEvaluation {
  const scope = evaluationScope(input);
  const values = readPathValues(scope, check.path);
  const present = values.length > 0 && values.every(isPresent);

  if (present) {
    return {
      status: "pass",
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  return {
    status: "fail",
    finding: makeFinding({
      id: check.id,
      severity: check.severity ?? severity,
      message: check.message ?? `Required field ${check.path} is missing`,
      targetRef: check.targetRef ?? check.path,
      evidenceRefs: check.evidenceRefs,
      repairHint: check.repairHint
    }),
    requiredAction: check.requiredAction,
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function evaluateSchemaPresenceCheck(
  check: SchemaPresenceCheck,
  input: GateEvaluationInput | undefined,
  severity: GateSeverity
): CheckEvaluation {
  const target = schemaTarget(check, input);
  const evidenceRefs = check.evidenceRefs ?? evidenceRefsForTarget(target);

  if (target === undefined) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message: check.message ?? "Required artifact is missing",
        targetRef: check.targetRef ?? check.artifactId,
        evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction,
      evidenceRefs
    };
  }

  const invalidReason = invalidArtifactReason(target);

  if (invalidReason !== undefined) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message: check.message ?? invalidReason,
        targetRef: check.targetRef ?? targetRefForTarget(target, check),
        evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction,
      evidenceRefs
    };
  }

  const requiredFields = check.requiredFields ?? check.required ?? [];
  const missingFields = requiredFields.filter(
    (field) => !fieldPresent(target, field)
  );

  if (missingFields.length > 0) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message:
          check.message ??
          `Artifact is missing required fields: ${missingFields.join(", ")}`,
        targetRef: check.targetRef ?? targetRefForTarget(target, check),
        evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction,
      evidenceRefs
    };
  }

  return {
    status: "pass",
    evidenceRefs
  };
}

function evaluateEvalStatusCheck(
  check: EvalStatusCheck,
  input: GateEvaluationInput | undefined,
  severity: GateSeverity
): CheckEvaluation {
  const verdict = input?.evals?.[check.evalId];

  if (verdict === undefined) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message: check.message ?? `Referenced eval ${check.evalId} is missing`,
        targetRef: check.targetRef ?? `eval:${check.evalId}`,
        evidenceRefs: check.evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction ?? "fail_run",
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  const evidenceRefs = uniqueStrings([
    ...(check.evidenceRefs ?? []),
    ...verdict.findings.flatMap(
      (finding: EvalVerdict["findings"][number]) => finding.evidenceRefs ?? []
    )
  ]);
  const allowedStatuses = check.allowedStatuses ?? [check.status ?? "pass"];

  if (allowedStatuses.includes(verdict.status)) {
    return {
      status: "pass",
      evidenceRefs
    };
  }

  if (verdict.status === "needs_review") {
    return {
      status: "needs_review",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message: check.message ?? `Eval ${check.evalId} needs review`,
        targetRef: check.targetRef ?? `eval:${check.evalId}`,
        evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: "clarify",
      evidenceRefs
    };
  }

  return {
    status: "fail",
    finding: makeFinding({
      id: check.id,
      severity: check.severity ?? severity,
      message:
        check.message ??
        `Eval ${check.evalId} returned ${verdict.status}; expected ${allowedStatuses.join(
          " or "
        )}`,
      targetRef: check.targetRef ?? `eval:${check.evalId}`,
      evidenceRefs,
      repairHint: check.repairHint
    }),
    requiredAction: check.requiredAction,
    evidenceRefs
  };
}

function evaluateEvidenceCoverageCheck(
  check: EvidenceCoverageCheck,
  input: GateEvaluationInput | undefined,
  severity: GateSeverity
): CheckEvaluation {
  const refs = evidenceRefsForCheck(check, input);
  const missingRefs = refs.filter((ref) => !hasEvidenceRef(input?.evidence, ref));
  const minCount = check.minCount ?? 1;

  if (refs.length < minCount) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message:
          check.message ??
          `Evidence coverage requires at least ${minCount} reference(s)`,
        targetRef: check.targetRef ?? check.artifactId ?? check.path,
        evidenceRefs: refs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction,
      evidenceRefs: refs
    };
  }

  if (missingRefs.length > 0) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message:
          check.message ??
          `Referenced evidence is missing: ${missingRefs.join(", ")}`,
        targetRef: check.targetRef ?? check.artifactId ?? check.path,
        evidenceRefs: refs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction ?? "fail_run",
      evidenceRefs: refs
    };
  }

  return {
    status: "pass",
    evidenceRefs: refs
  };
}

function evaluatePolicyStatusCheck(
  check: PolicyStatusCheck,
  input: GateEvaluationInput | undefined,
  severity: GateSeverity
): CheckEvaluation {
  const verdict = findPolicyVerdict(
    input?.policy,
    check.verdictId ?? check.policyId
  );

  if (verdict === undefined) {
    return {
      status: "fail",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message: check.message ?? "Referenced policy verdict is missing",
        targetRef: check.targetRef ?? check.verdictId ?? check.policyId,
        evidenceRefs: check.evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: check.requiredAction ?? "fail_run",
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  const allowedStatuses = check.allowedStatuses ?? [check.status ?? "allow"];

  if (allowedStatuses.includes(verdict.status)) {
    return {
      status: "pass",
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  if (verdict.status === "approval_required") {
    return {
      status: "needs_review",
      finding: makeFinding({
        id: check.id,
        severity: check.severity ?? severity,
        message:
          check.message ??
          `Policy verdict requires approval; expected ${allowedStatuses.join(
            " or "
          )}`,
        targetRef: check.targetRef ?? check.verdictId ?? check.policyId,
        evidenceRefs: check.evidenceRefs,
        repairHint: check.repairHint
      }),
      requiredAction: "approve",
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  return {
    status: "fail",
    finding: makeFinding({
      id: check.id,
      severity: check.severity ?? severity,
      message:
        check.message ??
        `Policy verdict returned ${verdict.status}; expected ${allowedStatuses.join(
          " or "
        )}`,
      targetRef: check.targetRef ?? check.verdictId ?? check.policyId,
      evidenceRefs: check.evidenceRefs,
      repairHint: check.repairHint
    }),
    requiredAction: check.requiredAction ?? "fail_run",
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function unsupportedCheck(
  check: GateCheckBase,
  severity: GateSeverity
): CheckEvaluation {
  return {
    status: "fail",
    finding: makeFinding({
      id: check.id,
      severity: check.severity ?? severity,
      message: `Unsupported gate check type ${check.type}`,
      targetRef: check.targetRef,
      evidenceRefs: check.evidenceRefs,
      repairHint: check.repairHint
    }),
    requiredAction: "fail_run",
    evidenceRefs: check.evidenceRefs ?? []
  };
}

async function evaluateModelAssistedCheck(input: {
  check: ModelAssistedCheck;
  definition: FixtureGateDefinition;
  input: GateEvaluationInput | undefined;
  phase: string;
  severity: GateSeverity;
  broker?: BrokerPort | undefined;
  evaluatedAt: string;
  traceId?: string | undefined;
}): Promise<{
  evaluation: CheckEvaluation;
  provenance: ModelAssistedCallProvenance;
}> {
  const { check, definition, phase, severity } = input;
  const contract = validateModelAssistedContract(check);
  const modelCallId = modelCallIdFor({
    gateId: definition.id,
    check,
    phase,
    input: input.input
  });
  const baseTool = {
    toolId: check.modelTool || "undeclared",
    requestHash: hashJson({
      gateId: definition.id,
      checkId: check.id,
      modelCallId,
      phase
    }),
    tokenBudget: Number.isFinite(check.maxTokens) ? check.maxTokens : 0,
    policyStatus: "not_requested"
  };

  if (!contract.ok) {
    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: fallbackRubric(check),
      outcome: "invalid_output",
      message: contract.message,
      tool: baseTool
    });
  }

  if (input.broker === undefined) {
    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: contract.rubric,
      outcome: "error",
      message: `Model-assisted check ${check.id} requires an injected broker`,
      tool: baseTool
    });
  }

  const projection = projectModelContext(check, input.input);
  const parsedProjection = contract.inputSchema.safeParse(projection.context);

  if (!parsedProjection.success) {
    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: contract.rubric,
      outcome: "invalid_output",
      message: `Model-assisted check ${check.id} context failed inputSchema validation`,
      tool: baseTool
    });
  }

  const request: ToolCallRequest = {
    toolId: contract.modelTool,
    args: {
      context: parsedProjection.data,
      rubric: contract.rubric,
      maxTokens: contract.maxTokens
    },
    reason: `Evaluate model-assisted gate check ${check.id} for gate ${definition.id}`,
    idempotencyKey: hashJson({
      gateId: definition.id,
      phase,
      checkId: check.id,
      rubricHash: contract.rubric.hash,
      context: parsedProjection.data
    }),
    requestedBy: {
      phase,
      gateId: definition.id,
      modelCallId
    }
  };
  const requestHash = hashJson(request);
  let result: ToolCallResult;

  try {
    result = ToolCallResultSchema.parse(
      await input.broker(request, brokerContext(input.traceId, input.input?.runId))
    );
  } catch {
    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: contract.rubric,
      outcome: "error",
      message: `Model-assisted check ${check.id} broker call failed`,
      tool: {
        ...baseTool,
        toolId: contract.modelTool,
        requestHash,
        policyStatus: "error"
      }
    });
  }

  const tool = modelToolProvenance({
    check,
    result,
    requestHash,
    tokenBudget: contract.maxTokens
  });

  if (result.status !== "success") {
    const outcome = result.status === "denied" ? "denied" : "error";

    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: contract.rubric,
      outcome,
      message:
        result.error?.message ??
        `Model-assisted check ${check.id} returned ${result.status}`,
      tool
    });
  }

  if (
    result.output === undefined ||
    stableStringify(result.output).length > Math.max(1, contract.maxTokens) * 16
  ) {
    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: contract.rubric,
      outcome: "invalid_output",
      message: `Model-assisted check ${check.id} returned absent or oversized output`,
      tool
    });
  }

  const parsedOutput = contract.outputSchema.safeParse(result.output);

  if (!parsedOutput.success) {
    return failClosedModelCheck({
      check,
      severity,
      modelCallId,
      rubric: contract.rubric,
      outcome: "invalid_output",
      message: `Model-assisted check ${check.id} output failed outputSchema validation`,
      tool
    });
  }

  return {
    evaluation: evaluationFromModelOutput({
      check,
      output: parsedOutput.data,
      severity
    }),
    provenance: {
      checkId: check.id,
      modelCallId,
      rubric: contract.rubric,
      outcome: "success",
      tool
    }
  };
}

function failClosedModelCheck(input: {
  check: ModelAssistedCheck;
  severity: GateSeverity;
  modelCallId: string;
  rubric: ModelAssistedCheck["rubric"];
  outcome: ModelAssistedCallOutcome;
  message: string;
  tool: ModelAssistedCallProvenance["tool"];
}): {
  evaluation: CheckEvaluation;
  provenance: ModelAssistedCallProvenance;
} {
  const finding = makeFinding({
    id: input.check.id,
    severity: input.check.severity ?? input.severity,
    message: input.message,
    targetRef: input.check.targetRef ?? `model_call:${input.modelCallId}`,
    evidenceRefs: input.check.evidenceRefs,
    repairHint: input.check.repairHint
  });

  return {
    evaluation: {
      status: "fail",
      finding,
      requiredAction: "fail_run",
      bypassOnFail: true,
      evidenceRefs: input.check.evidenceRefs ?? []
    },
    provenance: {
      checkId: input.check.id,
      modelCallId: input.modelCallId,
      rubric: input.rubric,
      outcome: input.outcome,
      tool: input.tool
    }
  };
}

function evaluationFromModelOutput(input: {
  check: ModelAssistedCheck;
  output: unknown;
  severity: GateSeverity;
}): CheckEvaluation {
  const output = isRecord(input.output) ? input.output : {};
  const status = String(
    output.status ?? output.outcome ?? output.verdict ?? "review"
  );
  const message =
    typeof output.message === "string"
      ? output.message
      : input.check.message ?? `Model-assisted check ${input.check.id} flagged review`;
  const evidenceRefs = Array.isArray(output.evidenceRefs)
    ? output.evidenceRefs.filter(isString)
    : input.check.evidenceRefs ?? [];
  const targetRef =
    typeof output.targetRef === "string"
      ? output.targetRef
      : input.check.targetRef;
  const repairHint =
    typeof output.repairHint === "string"
      ? output.repairHint
      : input.check.repairHint;

  if (status === "clean" || status === "pass") {
    return {
      status: "pass",
      evidenceRefs
    };
  }

  if (status === "blocking" || status === "fail") {
    return {
      status: "fail",
      finding: makeFinding({
        id: input.check.id,
        severity: input.check.severity ?? input.severity,
        message,
        targetRef,
        evidenceRefs,
        repairHint
      }),
      requiredAction: input.check.requiredAction ?? "repair",
      evidenceRefs
    };
  }

  return {
    status: "needs_review",
    finding: makeFinding({
      id: input.check.id,
      severity: input.check.severity ?? input.severity,
      message,
      targetRef,
      evidenceRefs,
      repairHint
    }),
    requiredAction: "clarify",
    evidenceRefs
  };
}

function modelToolProvenance(input: {
  check: ModelAssistedCheck;
  result: ToolCallResult;
  requestHash: string;
  tokenBudget: number;
}): ModelAssistedCallProvenance["tool"] {
  const resultHash = input.result.provenance.resultHash ?? hashJson(input.result);

  return {
    toolId: input.result.provenance.toolId,
    toolVersion: input.result.provenance.toolVersion,
    requestHash: input.requestHash,
    resultHash,
    argsHash: input.result.provenance.argsHash,
    cacheStatus: input.result.provenance.cacheStatus,
    traceId: input.result.provenance.traceId,
    tokenBudget: input.tokenBudget,
    policyStatus: policyStatusForToolResult(input.result.status)
  };
}

function policyStatusForToolResult(status: ToolCallResult["status"]) {
  switch (status) {
    case "success":
      return "allow";
    case "denied":
    case "approval_required":
      return status;
    case "failed":
      return "error";
  }
}

function brokerContext(
  traceId: string | undefined,
  runId: string | undefined
): BrokerCallContext {
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(runId === undefined ? {} : { runId })
  };
}

function validateModelAssistedContract(
  check: ModelAssistedCheck
):
  | {
      ok: true;
      modelTool: string;
      inputSchema: ZodTypeAny;
      outputSchema: ZodTypeAny;
      rubric: ModelAssistedCheck["rubric"];
      maxTokens: number;
    }
  | { ok: false; message: string } {
  if (!isNonEmptyString(check.modelTool)) {
    return { ok: false, message: `Model-assisted check ${check.id} is missing modelTool` };
  }

  if (
    !isRecord(check.rubric) ||
    !isNonEmptyString(check.rubric.ref) ||
    !isNonEmptyString(check.rubric.hash)
  ) {
    return { ok: false, message: `Model-assisted check ${check.id} is missing rubric ref/hash` };
  }

  if (!Array.isArray(check.allowedContextRefs)) {
    return { ok: false, message: `Model-assisted check ${check.id} is missing allowedContextRefs` };
  }

  if (!Number.isFinite(check.maxTokens) || check.maxTokens <= 0) {
    return { ok: false, message: `Model-assisted check ${check.id} is missing maxTokens` };
  }

  const inputSchema = zodSchemaFromDeclaration(check.inputSchema);
  const outputSchema = zodSchemaFromDeclaration(check.outputSchema);

  if (inputSchema === undefined || outputSchema === undefined) {
    return { ok: false, message: `Model-assisted check ${check.id} has malformed inputSchema or outputSchema` };
  }

  return {
    ok: true,
    modelTool: check.modelTool,
    inputSchema,
    outputSchema,
    rubric: check.rubric,
    maxTokens: check.maxTokens
  };
}

function projectModelContext(
  check: ModelAssistedCheck,
  input: GateEvaluationInput | undefined
) {
  const scope = evaluationScope(input);
  const context: Record<string, unknown> = {};

  for (const ref of check.allowedContextRefs) {
    if (!isNonEmptyString(ref)) {
      continue;
    }

    const value = ref.startsWith("$.")
      ? readPathValues(scope, ref)[0]
      : inputValueByName(ref, input);
    const redacted = redactForModel(value);

    if (redacted === undefined) {
      continue;
    }

    if (ref.startsWith("$.")) {
      assignProjectionPath(context, ref, redacted);
    } else {
      context[ref] = redacted;
    }
  }

  return { context };
}

function redactForModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => redactForModel(entry))
      .filter((entry) => entry !== undefined);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isRestrictedRedactionRecord(value)) {
    return undefined;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (isSecretLikeKey(key)) {
      continue;
    }

    const redactedEntry = redactForModel(entry);

    if (
      redactedEntry !== undefined &&
      !(isRecord(redactedEntry) && Object.keys(redactedEntry).length === 0)
    ) {
      redacted[key] = redactedEntry;
    }
  }

  return redacted;
}

function assignProjectionPath(
  target: Record<string, unknown>,
  ref: string,
  value: unknown
) {
  const segments = ref
    .slice(2)
    .split(".")
    .map((segment) => segment.replace(/\[\*\]$/, ""));
  let current = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;

    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }

    const next = current[segment];

    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }
}

function modelCallIdFor(input: {
  gateId: string;
  check: ModelAssistedCheck;
  phase: string;
  input: GateEvaluationInput | undefined;
}) {
  const digest = hashJson({
    gateId: input.gateId,
    phase: input.phase,
    checkId: input.check.id,
    rubricHash: fallbackRubric(input.check).hash,
    allowedContextRefs: input.check.allowedContextRefs,
    context: projectModelContext(input.check, input.input).context
  }).slice("sha256:".length, "sha256:".length + 24);

  return `gate_model_${digest}`;
}

function fallbackRubric(check: ModelAssistedCheck): ModelAssistedCheck["rubric"] {
  return {
    ref: isRecord(check.rubric) && isNonEmptyString(check.rubric.ref)
      ? check.rubric.ref
      : "undeclared",
    hash: isRecord(check.rubric) && isNonEmptyString(check.rubric.hash)
      ? check.rubric.hash
      : "undeclared"
  };
}

function isModelAssistedCheck(check: GateCheck): check is ModelAssistedCheck {
  return check.type === "model_assisted";
}

function isRestrictedRedactionRecord(value: Record<string, unknown>) {
  return (
    value.redactionClass === "secret" ||
    value.redactionClass === "restricted" ||
    value.redaction === "secret" ||
    value.redaction === "restricted"
  );
}

function isSecretLikeKey(key: string) {
  return /(?:secret|token|password|credential|api[_-]?key|authorization|private[_-]?key)/i.test(
    key
  );
}

function buildFailingResult(input: {
  definition: FixtureGateDefinition;
  phase: string;
  evaluatedAt: string;
  evaluatorRef: string;
  severity: GateSeverity;
  findings: GateFinding[];
  evidenceRefs?: string[];
  defaultRequiredAction: GateRequiredAction;
  evaluatorKind?: GateVerdict["evaluator"]["kind"];
  modelAssisted?: ModelAssistedEvaluationProvenance;
  bypassOnFail?: boolean;
}): GateEvaluationResult {
  const requiredAction = requiredActionFor(
    input.definition.onFail,
    input.defaultRequiredAction,
    input.bypassOnFail === true
  );
  const evidenceRefs = uniqueStrings([
    ...(input.evidenceRefs ?? []),
    ...input.findings.flatMap((finding) => finding.evidenceRefs)
  ]);
  const obligations = obligationsFor(input.definition.onFail);
  const verdict = compactVerdict({
    gateId: input.definition.id,
    phase: input.phase,
    status: "fail",
    severity: input.severity,
    reasons: input.findings.map((finding) => finding.message),
    findings: input.findings,
    evidenceRefs,
    requiredAction,
    obligations,
    evaluatedAt: input.evaluatedAt,
    evaluator: {
      kind: input.evaluatorKind ?? "deterministic",
      ref: input.evaluatorRef
    }
  });

  return validatedGateResult(withOptionalModelAssisted({
    verdict,
    instruction: instructionForFailure({
      definition: input.definition,
      phase: input.phase,
      verdict,
      requiredAction
    })
  }, input.modelAssisted));
}

function failClosed(input: {
  gateId: string;
  phase: string;
  evaluatedAt: string;
  evaluatorRef: string;
  reason: string;
  findingId: string;
  targetRef?: string | undefined;
  requiredAction: GateRequiredAction;
}): GateEvaluationResult {
  const finding = makeFinding({
    id: input.findingId,
    severity: "blocking",
    message: input.reason,
    targetRef: input.targetRef
  });
  const verdict = compactVerdict({
    gateId: input.gateId,
    phase: input.phase,
    status: "fail",
    severity: "blocking",
    reasons: [input.reason],
    findings: [finding],
    evidenceRefs: [],
    requiredAction: input.requiredAction,
    obligations: [],
    evaluatedAt: input.evaluatedAt,
    evaluator: {
      kind: "deterministic",
      ref: input.evaluatorRef
    }
  });

  return validatedGateResult({
    verdict,
    instruction: {
      kind: "fail_run",
      gateId: input.gateId,
      reason: input.reason
    }
  });
}

function validatedGateResult(input: GateEvaluationResult): GateEvaluationResult {
  const result: GateEvaluationResult = {
    verdict: parseHashedGateVerdict(input.verdict),
    instruction: GateLifecycleInstructionSchema.parse(input.instruction)
  };

  if (input.modelAssisted !== undefined) {
    result.modelAssisted = input.modelAssisted;
  }

  return result;
}

function withOptionalModelAssisted<T extends object>(
  value: T,
  modelAssisted: ModelAssistedEvaluationProvenance | undefined
): T & { modelAssisted?: ModelAssistedEvaluationProvenance } {
  return modelAssisted === undefined
    ? value
    : {
        ...value,
        modelAssisted
      };
}

function instructionForPass(
  definition: FixtureGateDefinition,
  phase: string
): GateLifecycleInstruction {
  if (
    definition.onPass?.action === "transition_phase" &&
    definition.onPass.targetPhase !== undefined
  ) {
    return {
      kind: "transition_phase",
      gateId: definition.id,
      targetPhase: definition.onPass.targetPhase
    };
  }

  return {
    kind: "continue",
    gateId: definition.id
  };
}

function instructionForNeedsReview(input: {
  definition: FixtureGateDefinition;
  phase: string;
  verdict: GateVerdict;
  requiredAction: Extract<GateRequiredAction, "approve" | "clarify">;
}): GateLifecycleInstruction {
  if (input.requiredAction === "approve") {
    return {
      kind: "request_approval",
      gateId: input.definition.id,
      approvalRequest: {
        id: `approval.${input.definition.id}`,
        gateId: input.definition.id,
        phase: input.phase,
        reason: firstReason(input.verdict),
        requiredFor: `gate:${input.definition.id}`
      }
    };
  }

  return {
    kind: "pause_for_human",
    gateId: input.definition.id,
    question: questionFor(input.definition, input.phase, input.verdict)
  };
}

function instructionForFailure(input: {
  definition: FixtureGateDefinition;
  phase: string;
  verdict: GateVerdict;
  requiredAction: GateRequiredAction;
}): GateLifecycleInstruction {
  switch (input.requiredAction) {
    case "clarify":
      return {
        kind: "pause_for_human",
        gateId: input.definition.id,
        question: questionFor(input.definition, input.phase, input.verdict)
      };
    case "approve":
      return {
        kind: "request_approval",
        gateId: input.definition.id,
        approvalRequest: {
          id: `approval.${input.definition.id}`,
          gateId: input.definition.id,
          phase: input.phase,
          reason:
            onFailObject(input.definition.onFail)?.approvalReason ??
            firstReason(input.verdict),
          requiredFor: `gate:${input.definition.id}`
        }
      };
    case "repair":
      return {
        kind: "create_repair_task",
        gateId: input.definition.id,
        repairTask: repairTaskFor(input.definition, input.phase, input.verdict)
      };
    case "fail_run":
      return {
        kind: "fail_run",
        gateId: input.definition.id,
        reason: firstReason(input.verdict)
      };
  }
}

function questionFor(
  definition: FixtureGateDefinition,
  phase: string,
  verdict: GateVerdict
): HumanQuestion {
  const onFail = onFailObject(definition.onFail);
  const base = {
    id: `question.${definition.id}`,
    gateId: definition.id,
    phase,
    question: onFail?.questionTemplate ?? firstReason(verdict),
    requiredFor: `gate:${definition.id}`
  };

  if (onFail?.expectedAnswerSchema !== undefined) {
    return {
      ...base,
      expectedAnswerSchema: onFail.expectedAnswerSchema
    };
  }

  return base;
}

function repairTaskFor(
  definition: FixtureGateDefinition,
  phase: string,
  verdict: GateVerdict
): RepairTask {
  const onFail = onFailObject(definition.onFail);
  const failedFindingIds = verdict.findings.map((finding) => finding.id);
  const base = {
    id: `repair.${definition.id}`,
    gateId: definition.id,
    failedPhase: phase,
    problem: firstReason(verdict),
    requiredEvidenceRefs:
      onFail?.requiredEvidenceRefs ?? verdict.evidenceRefs,
    allowedTools: onFail?.allowedTools ?? [],
    blockedTools: onFail?.blockedTools ?? [],
    successGate: onFail?.successGate ?? definition.id,
    createdFromFindingIds: failedFindingIds
  };

  const targetRef =
    onFail?.targetRef ?? verdict.findings.find((finding) => finding.targetRef)?.targetRef;

  if (targetRef !== undefined) {
    return {
      ...base,
      targetRef
    };
  }

  return base;
}

function compactVerdict(verdict: UnhashedGateVerdict): HashedGateVerdict {
  const compacted = verdict.requiredAction === undefined
    ? {
        gateId: verdict.gateId,
        phase: verdict.phase,
        status: verdict.status,
        severity: verdict.severity,
        reasons: verdict.reasons,
        findings: verdict.findings,
        evidenceRefs: verdict.evidenceRefs,
        obligations: verdict.obligations,
        evaluatedAt: verdict.evaluatedAt,
        evaluator: verdict.evaluator
      }
    : verdict;

  return {
    ...compacted,
    decisionHash: hashDecision(gateDecisionHashInput(compacted))
  };
}

function makeFinding(input: {
  id: string;
  severity: GateSeverity;
  message: string;
  targetRef?: string | undefined;
  evidenceRefs?: string[] | undefined;
  repairHint?: string | undefined;
}): GateFinding {
  const finding = {
    id: input.id,
    severity: input.severity,
    message: input.message,
    evidenceRefs: input.evidenceRefs ?? []
  };

  return {
    ...finding,
    ...(input.targetRef === undefined ? {} : { targetRef: input.targetRef }),
    ...(input.repairHint === undefined ? {} : { repairHint: input.repairHint })
  };
}

function resolveGateDefinition(request: EvaluateGateRequest): GateDefinitionResolution {
  if (request.gateDefinition !== undefined) {
    if (request.gateDefinition.id !== request.gateId) {
      return rejectDefinition(
        "gate.definition.id_mismatch",
        `Gate definition ${request.gateDefinition.id} does not match requested gate ${request.gateId}`,
        request.gateId,
        request.gateDefinition.phase
      );
    }

    if (request.gateDefinitions !== undefined) {
      return rejectDefinition(
        "gate.definition.inline_rejected",
        `Gate definition ${request.gateId} was provided inline when a governed source is required`,
        request.gateId,
        request.gateDefinition.phase
      );
    }

    return validateResolvedGateDefinition(request.gateDefinition);
  }

  const definitions = request.gateDefinitions;

  if (definitions === undefined) {
    return missingDefinition(request.gateId);
  }

  const definition = Array.isArray(definitions)
    ? definitions.find((candidate) => candidate.id === request.gateId)
    : (definitions as Record<string, FixtureGateDefinition>)[request.gateId];

  if (definition === undefined) {
    return missingDefinition(request.gateId);
  }

  if (definition.id !== request.gateId) {
    return rejectDefinition(
      "gate.definition.id_mismatch",
      `Gate definition ${definition.id} does not match requested gate ${request.gateId}`,
      request.gateId,
      definition.phase
    );
  }

  return validateResolvedGateDefinition(definition);
}

function validateResolvedGateDefinition(
  definition: FixtureGateDefinition
): GateDefinitionResolution {
  const validation = validateGateDefinition(definition);

  if (validation.ok) {
    return { ok: true, definition };
  }

  return {
    ok: false,
    finding: validation.finding,
    definitionPhase: definition.phase
  };
}

function missingDefinition(gateId: string): GateDefinitionResolution {
  return rejectDefinition(
    "gate.definition.missing",
    `Gate definition ${gateId} is missing`,
    gateId
  );
}

function rejectDefinition(
  findingId: string,
  message: string,
  gateId: string,
  definitionPhase?: string | undefined
): GateDefinitionResolution {
  return {
    ok: false,
    finding: {
      id: findingId,
      message,
      targetRef: `gate:${gateId}`
    },
    definitionPhase
  };
}

function findMissingInputs(
  inputs: unknown,
  input: GateEvaluationInput | undefined
): MissingInput[] {
  if (inputs === undefined) {
    return [];
  }

  if (Array.isArray(inputs)) {
    return inputs
      .filter((entry): entry is string => typeof entry === "string")
      .filter((name) => !isPresent(inputValueByName(name, input)))
      .map((name) => ({
        id: name,
        message: `Required gate input ${name} is missing`,
        targetRef: `input:${name}`
      }));
  }

  if (!isRecord(inputs)) {
    return [];
  }

  const missing: MissingInput[] = [];
  collectMissingNamedInputs(missing, "artifacts", inputs.artifacts, input);
  collectMissingNamedInputs(missing, "evals", inputs.evals, input);
  collectMissingNamedInputs(missing, "decisions", inputs.decisions, input);
  collectMissingNamedInputs(missing, "policy", inputs.policy, input);

  if (inputs.runInput === true && !isPresent(input?.runInput)) {
    missing.push({
      id: "runInput",
      message: "Required gate input runInput is missing",
      targetRef: "input:runInput"
    });
  }

  if (inputs.evidence === true && !isPresent(input?.evidence)) {
    missing.push({
      id: "evidence",
      message: "Required gate input evidence is missing",
      targetRef: "input:evidence"
    });
  }

  return missing;
}

function collectMissingNamedInputs(
  missing: MissingInput[],
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
            : findPolicyVerdict(input?.policy, id);

    if (!isPresent(present)) {
      missing.push({
        id,
        message: `Required gate ${kind.slice(0, -1)} ${id} is missing`,
        targetRef: `${kind.slice(0, -1)}:${id}`
      });
    }
  }
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
    findPolicyVerdict(input.policy, name)
  );
}

function evaluationScope(input: GateEvaluationInput | undefined) {
  return {
    ...(input?.data ?? {}),
    runId: input?.runId,
    phase: input?.phase,
    runInput: input?.runInput,
    run_input: input?.runInput,
    artifacts: input?.artifacts,
    evidence: input?.evidence,
    evidence_graph: input?.evidence,
    evals: input?.evals,
    decisions: input?.decisions,
    policy: input?.policy
  };
}

function schemaTarget(
  check: SchemaPresenceCheck,
  input: GateEvaluationInput | undefined
): unknown {
  if (check.path !== undefined) {
    const [first] = readPathValues(evaluationScope(input), check.path);
    return first;
  }

  if (check.artifactId === undefined) {
    return undefined;
  }

  const artifact = input?.artifacts?.[check.artifactId];

  if (artifact === undefined) {
    return undefined;
  }

  if (invalidArtifactReason(artifact) !== undefined) {
    return artifact;
  }

  return artifact.content ?? artifact;
}

function targetRefForTarget(target: unknown, check: SchemaPresenceCheck) {
  if (check.artifactId !== undefined) {
    return `artifact:${check.artifactId}`;
  }

  if (isRecord(target) && typeof target.artifactId === "string") {
    return `artifact:${target.artifactId}`;
  }

  return check.path;
}

function invalidArtifactReason(target: unknown): string | undefined {
  if (!isRecord(target)) {
    return "Artifact target is not an object";
  }

  if (target.valid === false || target.schemaValid === false) {
    return "Artifact schema validation failed";
  }

  if (target.status === "invalid") {
    return "Artifact status is invalid";
  }

  return undefined;
}

function evidenceRefsForTarget(target: unknown): string[] {
  if (isRecord(target) && Array.isArray(target.evidenceRefs)) {
    return target.evidenceRefs.filter(isString);
  }

  return [];
}

function evidenceRefsForCheck(
  check: EvidenceCoverageCheck,
  input: GateEvaluationInput | undefined
): string[] {
  if (check.evidenceRefs !== undefined) {
    return check.evidenceRefs;
  }

  if (check.artifactId !== undefined) {
    return input?.artifacts?.[check.artifactId]?.evidenceRefs ?? [];
  }

  if (check.path !== undefined) {
    const values = readPathValues(evaluationScope(input), check.path);
    return values.flatMap((value) => {
      if (Array.isArray(value)) {
        return value.filter(isString);
      }

      return isString(value) ? [value] : [];
    });
  }

  return [];
}

function hasEvidenceRef(
  evidence: GateEvidenceSnapshot | undefined,
  ref: string
): boolean {
  if (evidence === undefined) {
    return false;
  }

  if (Array.isArray(evidence.evidenceRefs) && evidence.evidenceRefs.includes(ref)) {
    return true;
  }

  if (isRecord(evidence.refs) && evidence.refs[ref] !== undefined) {
    return true;
  }

  for (const collectionName of ["items", "sources", "records"] as const) {
    const collection = evidence[collectionName];

    if (
      Array.isArray(collection) &&
      collection.some((entry) => refMatchesRecord(ref, entry))
    ) {
      return true;
    }
  }

  return (evidence as Record<string, unknown>)[ref] !== undefined;
}

function refMatchesRecord(ref: string, entry: unknown) {
  return (
    isRecord(entry) &&
    (entry.id === ref || entry.ref === ref || entry.evidenceRef === ref)
  );
}

function findPolicyVerdict(
  policy: GatePolicySnapshot | undefined,
  id: string | undefined
): GatePolicyVerdict | undefined {
  if (policy === undefined) {
    return undefined;
  }

  if (Array.isArray(policy)) {
    return policy.find((verdict) => policyVerdictMatches(verdict, id));
  }

  if (isPolicyVerdict(policy)) {
    return id === undefined || policyVerdictMatches(policy, id)
      ? policy
      : undefined;
  }

  if (id === undefined) {
    return undefined;
  }

  return (policy as Record<string, GatePolicyVerdict>)[id];
}

function policyVerdictMatches(
  verdict: GatePolicyVerdict,
  id: string | undefined
) {
  return (
    id === undefined ||
    verdict.id === id ||
    verdict.policyId === id ||
    verdict.requestId === id
  );
}

function isPolicyVerdict(value: unknown): value is GatePolicyVerdict {
  return isRecord(value) && typeof value.status === "string";
}

function readPathValues(root: unknown, path: string): unknown[] {
  if (path === "$") {
    return [root];
  }

  if (!path.startsWith("$.")) {
    return [];
  }

  const segments = path.slice(2).split(".");

  return segments.reduce<unknown[]>((currentValues, segment) => {
    const wildcard = segment.endsWith("[*]");
    const key = wildcard ? segment.slice(0, -3) : segment;
    const nextValues: unknown[] = [];

    for (const value of currentValues) {
      if (!isRecord(value)) {
        continue;
      }

      const child = value[key];

      if (wildcard) {
        if (Array.isArray(child)) {
          nextValues.push(...child);
        }
      } else {
        nextValues.push(child);
      }
    }

    return nextValues;
  }, [root]);
}

function fieldPresent(target: unknown, field: string): boolean {
  const values = field.includes(".")
    ? readPathValues(target, `$.${field}`)
    : isRecord(target)
      ? [target[field]]
      : [];

  return values.length > 0 && values.every(isPresent);
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

function gateSeverity(definition: FixtureGateDefinition): GateSeverity {
  if (definition.severity !== undefined) {
    return definition.severity;
  }

  return definition.required === false ? "advisory" : "blocking";
}

function requiredActionFor(
  onFail: FixtureGateDefinition["onFail"],
  fallback: GateRequiredAction,
  bypassOnFail = false
): GateRequiredAction {
  if (bypassOnFail) {
    return fallback;
  }

  const action = typeof onFail === "string" ? onFail : onFail?.action;

  switch (action) {
    case "clarify":
    case "request_clarification":
    case "pause_for_human":
      return "clarify";
    case "approve":
    case "request_approval":
      return "approve";
    case "repair":
    case "create_repair_task":
      return "repair";
    case "fail_run":
      return "fail_run";
    default:
      return fallback;
  }
}

function obligationsFor(onFail: FixtureGateDefinition["onFail"]) {
  const object = onFailObject(onFail);

  return object?.obligations ?? [];
}

function onFailObject(
  onFail: FixtureGateDefinition["onFail"]
): GateFailureBehavior | undefined {
  return typeof onFail === "object" && onFail !== null ? onFail : undefined;
}

function firstRequiredAction(
  evaluations: ReadonlyArray<
    Extract<CheckEvaluation, { requiredAction?: GateRequiredAction | undefined }>
  >
): GateRequiredAction | undefined {
  return evaluations.find(
    (evaluation) => evaluation.requiredAction !== undefined
  )?.requiredAction;
}

function firstReviewRequiredAction(
  evaluations: ReadonlyArray<Extract<CheckEvaluation, { status: "needs_review" }>>
): Extract<GateRequiredAction, "approve" | "clarify"> {
  return (
    evaluations.find((evaluation) => evaluation.requiredAction !== undefined)
      ?.requiredAction ?? "clarify"
  );
}

function firstReason(verdict: GateVerdict) {
  return verdict.reasons[0] ?? `Gate ${verdict.gateId} did not pass`;
}

function parseHashedGateVerdict(verdict: HashedGateVerdict): HashedGateVerdict {
  const parsed = GateVerdictSchema.parse(verdict);

  if (!isPresent(parsed.decisionHash)) {
    throw new Error("Gate verdict is missing decisionHash");
  }

  return parsed as HashedGateVerdict;
}

function normalizeEvaluatedAt(value: Date | string | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value ?? DEFAULT_EVALUATED_AT;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
