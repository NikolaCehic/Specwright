import {
  GateCheckTypeSchema,
  GateKindSchema,
  type GateCheckType,
  type GateKind
} from "@specwright/schemas";

export const KNOWN_GATE_KINDS: readonly GateKind[] = GateKindSchema.options;
export const KNOWN_CHECK_TYPES: readonly GateCheckType[] =
  GateCheckTypeSchema.options;

export type GateDefinitionFinding = {
  id: string;
  message: string;
  targetRef?: string;
};

export type GateDefinitionValidationResult =
  | { ok: true }
  | { ok: false; finding: GateDefinitionFinding };

const knownGateKinds = new Set<string>(KNOWN_GATE_KINDS);
const knownCheckTypes = new Set<string>(KNOWN_CHECK_TYPES);
const gateFailureActions = new Set([
  "repair",
  "create_repair_task",
  "clarify",
  "request_clarification",
  "approve",
  "request_approval",
  "pause_for_human",
  "fail_run"
]);
const gatePassActions = new Set(["continue", "transition_phase"]);

export function validateGateDefinition(
  definition: unknown
): GateDefinitionValidationResult {
  if (!isRecord(definition) || !isNonEmptyString(definition.id)) {
    return malformedDefinition("Gate definition must declare a non-empty id");
  }

  const gateId = definition.id;

  if (
    typeof definition.kind !== "string" ||
    !knownGateKinds.has(definition.kind)
  ) {
    return {
      ok: false,
      finding: {
        id: "gate.kind.unknown",
        message: `Gate definition ${gateId} declares unknown kind ${String(definition.kind)}`,
        targetRef: `gate:${gateId}`
      }
    };
  }

  const checkValidation = validateChecks(definition, gateId);

  if (!checkValidation.ok) {
    return checkValidation;
  }

  const onFailValidation = validateOnFail(definition.onFail, gateId);

  if (!onFailValidation.ok) {
    return onFailValidation;
  }

  return validateOnPass(definition.onPass, gateId);
}

function validateChecks(
  definition: Record<string, unknown>,
  gateId: string
): GateDefinitionValidationResult {
  if (definition.checks === undefined) {
    return { ok: true };
  }

  if (!Array.isArray(definition.checks)) {
    return {
      ok: false,
      finding: {
        id: "gate.checks.malformed",
        message: `Gate definition ${gateId} has malformed checks`,
        targetRef: `gate:${gateId}`
      }
    };
  }

  for (let index = 0; index < definition.checks.length; index += 1) {
    const check = definition.checks[index];
    const checkKey = checkAddress(check, index);

    if (!isRecord(check)) {
      return {
        ok: false,
        finding: {
          id: `gate.check.${checkKey}.malformed`,
          message: `Gate check ${checkKey} is malformed`,
          targetRef: `gate:${gateId}/check:${checkKey}`
        }
      };
    }

    if (typeof check.type !== "string" || !knownCheckTypes.has(check.type)) {
      return {
        ok: false,
        finding: {
          id: `gate.check.${checkKey}.unknown_type`,
          message: `Gate check ${checkKey} declares unknown type ${String(check.type)}`,
          targetRef: `gate:${gateId}/check:${checkKey}`
        }
      };
    }
  }

  return { ok: true };
}

function validateOnFail(
  onFail: unknown,
  gateId: string
): GateDefinitionValidationResult {
  if (onFail === undefined) {
    return { ok: true };
  }

  if (typeof onFail === "string") {
    return gateFailureActions.has(onFail)
      ? { ok: true }
      : malformedOnFail(gateId);
  }

  if (!isRecord(onFail)) {
    return malformedOnFail(gateId);
  }

  if (
    onFail.action !== undefined &&
    (typeof onFail.action !== "string" ||
      !gateFailureActions.has(onFail.action))
  ) {
    return malformedOnFail(gateId);
  }

  for (const field of [
    "questionTemplate",
    "approvalReason",
    "repairHint",
    "targetRef",
    "successGate",
    "expectedAnswerSchema"
  ]) {
    if (onFail[field] !== undefined && typeof onFail[field] !== "string") {
      return malformedOnFail(gateId);
    }
  }

  if (
    onFail.successGate !== undefined &&
    !isNonEmptyString(onFail.successGate)
  ) {
    return malformedOnFail(gateId);
  }

  for (const field of [
    "allowedTools",
    "blockedTools",
    "requiredEvidenceRefs"
  ]) {
    if (onFail[field] !== undefined && !isStringArray(onFail[field])) {
      return malformedOnFail(gateId);
    }
  }

  if (onFail.obligations !== undefined && !Array.isArray(onFail.obligations)) {
    return malformedOnFail(gateId);
  }

  return { ok: true };
}

function validateOnPass(
  onPass: unknown,
  gateId: string
): GateDefinitionValidationResult {
  if (onPass === undefined) {
    return { ok: true };
  }

  if (!isRecord(onPass)) {
    return malformedOnPass(gateId);
  }

  if (
    onPass.action !== undefined &&
    (typeof onPass.action !== "string" || !gatePassActions.has(onPass.action))
  ) {
    return malformedOnPass(gateId);
  }

  if (
    onPass.action === "transition_phase" &&
    !isNonEmptyString(onPass.targetPhase)
  ) {
    return malformedOnPass(gateId);
  }

  if (
    onPass.targetPhase !== undefined &&
    typeof onPass.targetPhase !== "string"
  ) {
    return malformedOnPass(gateId);
  }

  if (onPass.obligations !== undefined && !Array.isArray(onPass.obligations)) {
    return malformedOnPass(gateId);
  }

  return { ok: true };
}

function malformedDefinition(message: string): GateDefinitionValidationResult {
  return {
    ok: false,
    finding: {
      id: "gate.definition.malformed",
      message,
      targetRef: "gate:unknown"
    }
  };
}

function malformedOnFail(gateId: string): GateDefinitionValidationResult {
  return {
    ok: false,
    finding: {
      id: "gate.onFail.malformed",
      message: `Gate definition ${gateId} has malformed onFail`,
      targetRef: `gate:${gateId}`
    }
  };
}

function malformedOnPass(gateId: string): GateDefinitionValidationResult {
  return {
    ok: false,
    finding: {
      id: "gate.onPass.malformed",
      message: `Gate definition ${gateId} has malformed onPass`,
      targetRef: `gate:${gateId}`
    }
  };
}

function checkAddress(check: unknown, index: number) {
  if (isRecord(check) && isNonEmptyString(check.id)) {
    return check.id;
  }

  return String(index);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
