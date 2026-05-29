import type { EvalVerdict, GateDefinition, GateKind } from "@specwright/schemas";

export const DEFAULT_EVALUATED_AT = "1970-01-01T00:00:00.000Z";
export const DEFAULT_GATE_ENGINE_EVALUATOR = "specwright.gate-engine.v0";

export type GateVerdictStatus = "pass" | "fail" | "needs_review";
export type GateSeverity = "blocking" | "advisory";
export type GateRequiredAction = "repair" | "clarify" | "approve" | "fail_run";
export type PolicyVerdictStatus = "allow" | "deny" | "approval_required";

export type GateLifecycleInstructionKind =
  | "continue"
  | "transition_phase"
  | "pause_for_human"
  | "request_approval"
  | "create_repair_task"
  | "fail_run";

export type GateObligation = {
  kind:
    | "run_eval"
    | "request_clarification"
    | "create_repair_task"
    | "promote_artifact"
    | "attach_evidence"
    | "mark_assumption";
  params?: Record<string, unknown>;
};

export type GateFinding = {
  id: string;
  severity: GateSeverity;
  message: string;
  targetRef?: string;
  evidenceRefs: string[];
  repairHint?: string;
};

export type HumanQuestion = {
  id: string;
  gateId: string;
  phase: string;
  question: string;
  requiredFor: string;
  expectedAnswerSchema?: string;
};

export type ApprovalRequest = {
  id: string;
  gateId: string;
  phase: string;
  reason: string;
  requiredFor: string;
};

export type RepairTask = {
  id: string;
  gateId: string;
  failedPhase: string;
  targetRef?: string;
  problem: string;
  requiredEvidenceRefs: string[];
  allowedTools: string[];
  blockedTools: string[];
  successGate: string;
  createdFromFindingIds: string[];
};

export type GateVerdict = {
  gateId: string;
  phase: string;
  status: GateVerdictStatus;
  severity: GateSeverity;
  reasons: string[];
  findings: GateFinding[];
  evidenceRefs: string[];
  requiredAction?: GateRequiredAction;
  obligations: GateObligation[];
  evaluatedAt: string;
  evaluator: {
    kind: "deterministic" | "model_assisted" | "human";
    ref: string;
  };
};

export type GateLifecycleInstruction =
  | {
      kind: "continue";
      gateId: string;
    }
  | {
      kind: "transition_phase";
      gateId: string;
      targetPhase: string;
    }
  | {
      kind: "pause_for_human";
      gateId: string;
      question: HumanQuestion;
    }
  | {
      kind: "request_approval";
      gateId: string;
      approvalRequest: ApprovalRequest;
    }
  | {
      kind: "create_repair_task";
      gateId: string;
      repairTask: RepairTask;
    }
  | {
      kind: "fail_run";
      gateId: string;
      reason: string;
    };

export type GateEvaluationResult = {
  verdict: GateVerdict;
  instruction: GateLifecycleInstruction;
};

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

export type PolicyVerdict = {
  status: PolicyVerdictStatus;
  approvalId?: string;
  reasons?: string[];
  constraints?: unknown[];
  obligations?: unknown[];
  matchedRules?: unknown[];
  decisionHash?: string;
} & Record<string, unknown>;

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
  checks?: SupportedGateCheck[];
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

export function evaluateGate(request: EvaluateGateRequest): GateEvaluationResult {
  const definition = resolveGateDefinition(request);
  const evaluatedAt = normalizeEvaluatedAt(request.evaluatedAt);
  const phase = request.phase ?? request.input?.phase ?? definition?.phase ?? "unknown";
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_GATE_ENGINE_EVALUATOR;

  if (definition === undefined) {
    return failClosed({
      gateId: request.gateId,
      phase,
      evaluatedAt,
      evaluatorRef,
      reason: `Gate definition ${request.gateId} is missing`,
      findingId: "gate.definition.missing",
      targetRef: `gate:${request.gateId}`,
      requiredAction: "fail_run"
    });
  }

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
  const evaluations = checks.map((check) =>
    evaluateCheck(check, input, phase, severity)
  );
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
    return buildFailingResult({
      definition,
      phase,
      evaluatedAt,
      evaluatorRef,
      severity,
      findings: failed.map((evaluation) => evaluation.finding),
      evidenceRefs,
      defaultRequiredAction: firstRequiredAction(failed) ?? "repair"
    });
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
        kind: "deterministic",
        ref: evaluatorRef
      }
    });

    return {
      verdict,
      instruction: instructionForNeedsReview({
        definition,
        phase,
        verdict,
        requiredAction
      })
    };
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
      kind: "deterministic",
      ref: evaluatorRef
    }
  });

  return {
    verdict,
    instruction: instructionForPass(definition, phase)
  };
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

function buildFailingResult(input: {
  definition: FixtureGateDefinition;
  phase: string;
  evaluatedAt: string;
  evaluatorRef: string;
  severity: GateSeverity;
  findings: GateFinding[];
  evidenceRefs?: string[];
  defaultRequiredAction: GateRequiredAction;
}): GateEvaluationResult {
  const requiredAction = requiredActionFor(
    input.definition.onFail,
    input.defaultRequiredAction
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
      kind: "deterministic",
      ref: input.evaluatorRef
    }
  });

  return {
    verdict,
    instruction: instructionForFailure({
      definition: input.definition,
      phase: input.phase,
      verdict,
      requiredAction
    })
  };
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

  return {
    verdict,
    instruction: {
      kind: "fail_run",
      gateId: input.gateId,
      reason: input.reason
    }
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

function compactVerdict(verdict: GateVerdict): GateVerdict {
  return verdict.requiredAction === undefined
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

function resolveGateDefinition(
  request: EvaluateGateRequest
): FixtureGateDefinition | undefined {
  if (request.gateDefinition !== undefined) {
    return request.gateDefinition.id === request.gateId
      ? request.gateDefinition
      : undefined;
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
  fallback: GateRequiredAction
): GateRequiredAction {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
