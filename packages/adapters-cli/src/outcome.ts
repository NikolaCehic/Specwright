export type OutcomeClass =
  | "ok"
  | "usage_error"
  | "input_validation"
  | "denied"
  | "blocked"
  | "gate_failure"
  | "not_found"
  | "runtime_error"
  | "timeout"
  | "integrity"
  | "auth";

export type OutcomeDefinition = {
  exitCode: number;
  retryable: boolean;
};

export const OUTCOMES = Object.freeze({
  ok: { exitCode: 0, retryable: false },
  usage_error: { exitCode: 2, retryable: false },
  input_validation: { exitCode: 3, retryable: false },
  denied: { exitCode: 4, retryable: false },
  blocked: { exitCode: 5, retryable: true },
  gate_failure: { exitCode: 6, retryable: false },
  not_found: { exitCode: 7, retryable: false },
  runtime_error: { exitCode: 8, retryable: false },
  timeout: { exitCode: 9, retryable: true },
  integrity: { exitCode: 10, retryable: false },
  auth: { exitCode: 11, retryable: false }
} satisfies Record<OutcomeClass, OutcomeDefinition>);

export const EXIT_CODE_TO_OUTCOME = Object.freeze(
  Object.fromEntries(
    Object.entries(OUTCOMES).map(([outcome, definition]) => [
      definition.exitCode,
      outcome
    ])
  ) as Record<number, OutcomeClass>
);

export function outcomeForExitCode(exitCode: number): OutcomeClass {
  return EXIT_CODE_TO_OUTCOME[exitCode] ?? "runtime_error";
}

export function exitCodeForOutcome(outcome: OutcomeClass): number {
  return OUTCOMES[outcome].exitCode;
}

export function retryableForOutcome(outcome: OutcomeClass): boolean {
  return OUTCOMES[outcome].retryable;
}

export function classifyRuntimeOutcome(value: unknown): OutcomeClass {
  if (!isRecord(value)) {
    return "ok";
  }

  if (value.status === "denied") {
    return "denied";
  }

  if (
    isRecord(value.verdict) &&
    (value.verdict.status === "fail" || value.verdict.status === "needs_review")
  ) {
    return "gate_failure";
  }

  if (
    value.status === "blocked" ||
    nonEmptyArray(value.pendingApprovals) ||
    nonEmptyArray(value.pendingQuestions)
  ) {
    return "blocked";
  }

  if (isRecord(value.state)) {
    return classifyRuntimeOutcome(value.state);
  }

  return "ok";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
