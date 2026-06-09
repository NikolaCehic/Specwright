import { hashJson, type HashDigest } from "./decision-hash";
import type { FixtureGateDefinition } from "./index";

export function governedGateDefinitionProjection(
  definition: FixtureGateDefinition
): Record<string, unknown> {
  // Hash only the definition surface that evaluation and validation actually
  // consult so ignored extras do not force false-positive definition drift.
  return (
    definedRecord({
      id: definition.id,
      phase: definition.phase,
      kind: definition.kind,
      required: definition.required,
      severity: definition.severity,
      inputs: governedInputsProjection(definition.inputs),
      checks: Array.isArray(definition.checks)
        ? definition.checks.map(governedCheckProjection)
        : undefined,
      onFail: governedOnFailProjection(definition.onFail),
      onPass: governedOnPassProjection(definition.onPass)
    }) ?? { id: definition.id }
  );
}

export function hashGateDefinition(
  definition: FixtureGateDefinition
): HashDigest {
  return hashJson(governedGateDefinitionProjection(definition));
}

export function hashMissingGateDefinition(gateId: string): HashDigest {
  return hashJson({
    gateId,
    missing: true
  });
}

function governedInputsProjection(inputs: unknown): unknown {
  if (Array.isArray(inputs)) {
    return inputs.filter((entry): entry is string => typeof entry === "string");
  }

  if (!isRecord(inputs)) {
    return undefined;
  }

  return definedRecord({
    artifacts: stringArrayOrUndefined(inputs.artifacts),
    evals: stringArrayOrUndefined(inputs.evals),
    decisions: stringArrayOrUndefined(inputs.decisions),
    policy: stringArrayOrUndefined(inputs.policy),
    runInput: booleanOrUndefined(inputs.runInput),
    evidence: booleanOrUndefined(inputs.evidence)
  });
}

function governedCheckProjection(check: unknown): unknown {
  if (!isRecord(check)) {
    return null;
  }

  const base = {
    id: check.id,
    type: check.type,
    message: check.message,
    severity: check.severity,
    targetRef: check.targetRef,
    evidenceRefs: check.evidenceRefs,
    repairHint: check.repairHint,
    requiredAction: check.requiredAction
  };

  switch (check.type) {
    case "deterministic":
      return definedRecord({
        ...base,
        path: check.path,
        condition: check.condition
      });
    case "schema":
      return definedRecord({
        ...base,
        artifactId: check.artifactId,
        path: check.path,
        requiredFields: check.requiredFields,
        required: check.required
      });
    case "eval":
      return definedRecord({
        ...base,
        evalId: check.evalId,
        allowedStatuses: check.allowedStatuses,
        status: check.status
      });
    case "evidence":
      return definedRecord({
        ...base,
        artifactId: check.artifactId,
        path: check.path,
        minCount: check.minCount
      });
    case "policy":
      return definedRecord({
        ...base,
        policyId: check.policyId,
        verdictId: check.verdictId,
        allowedStatuses: check.allowedStatuses,
        status: check.status
      });
    case "human_review":
      return definedRecord({
        ...base,
        question: check.question
      });
    case "model_assisted":
      return definedRecord({
        ...base,
        modelTool: check.modelTool,
        inputSchema: check.inputSchema,
        outputSchema: check.outputSchema,
        rubric: isRecord(check.rubric)
          ? definedRecord({
              ref: check.rubric.ref,
              hash: check.rubric.hash
            })
          : check.rubric,
        allowedContextRefs: check.allowedContextRefs,
        maxTokens: check.maxTokens,
        onInvalidOutput: check.onInvalidOutput
      });
    default:
      return definedRecord(base);
  }
}

function governedOnFailProjection(onFail: unknown): unknown {
  if (typeof onFail === "string") {
    return onFail;
  }

  if (!isRecord(onFail)) {
    return undefined;
  }

  return definedRecord({
    action: onFail.action,
    questionTemplate: onFail.questionTemplate,
    approvalReason: onFail.approvalReason,
    repairHint: onFail.repairHint,
    targetRef: onFail.targetRef,
    allowedTools: onFail.allowedTools,
    blockedTools: onFail.blockedTools,
    successGate: onFail.successGate,
    requiredEvidenceRefs: onFail.requiredEvidenceRefs,
    maxRepairIterations: onFail.maxRepairIterations,
    expectedAnswerSchema: onFail.expectedAnswerSchema,
    obligations: onFail.obligations
  });
}

function governedOnPassProjection(onPass: unknown): unknown {
  if (!isRecord(onPass)) {
    return undefined;
  }

  return definedRecord({
    action: onPass.action,
    targetPhase: onPass.targetPhase,
    obligations: onPass.obligations
  });
}

function definedRecord(
  value: Record<string, unknown>
): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(
    ([, entryValue]) => entryValue !== undefined
  );

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
