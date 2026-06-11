import { OUTPUT_API_VERSION } from "./constants";
import {
  exitCodeForOutcome,
  retryableForOutcome,
  type OutcomeClass
} from "./outcome";

export type CliErrorOptions = {
  runId?: string | undefined;
  operatorAction?: string | undefined;
  cause?: unknown;
};

export type CliErrorRecord = {
  apiVersion: number;
  errorClass: OutcomeClass;
  code: number;
  message: string;
  runId?: string;
  retryable: boolean;
  operatorAction: string;
};

export class CliError extends Error {
  readonly errorClass: OutcomeClass;
  readonly runId: string | undefined;
  readonly operatorAction: string | undefined;

  constructor(
    errorClass: OutcomeClass,
    message: string,
    options: CliErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.errorClass = errorClass;
    this.runId = options.runId;
    this.operatorAction = options.operatorAction;
  }
}

export class CliUsageError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super("usage_error", message, options);
    this.name = "CliUsageError";
  }
}

export class CliInputError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super("input_validation", message, options);
    this.name = "CliInputError";
  }
}

export class CliAuthError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super("auth", message, options);
    this.name = "CliAuthError";
  }
}

export class CliIntegrityError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super("integrity", message, options);
    this.name = "CliIntegrityError";
  }
}

export class CliTimeoutError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super("timeout", message, options);
    this.name = "CliTimeoutError";
  }
}

export function classifyError(error: unknown): OutcomeClass {
  if (error instanceof CliError) {
    return error.errorClass;
  }

  const message = messageForError(error).toLowerCase();

  if (
    message.includes("not found") ||
    message.includes("no such file") ||
    message.includes("enoent") ||
    message.includes("missing event log") ||
    message.includes("unable to resolve run")
  ) {
    return "not_found";
  }

  if (
    message.includes("schema") ||
    message.includes("parse") ||
    message.includes("invalid_type") ||
    message.includes("validation")
  ) {
    return "input_validation";
  }

  return "runtime_error";
}

export function errorRecordFor(error: unknown): CliErrorRecord {
  const errorClass = classifyError(error);
  const runId = error instanceof CliError ? error.runId : undefined;
  const operatorAction =
    error instanceof CliError && error.operatorAction !== undefined
      ? error.operatorAction
      : OPERATOR_ACTIONS[errorClass];

  return {
    apiVersion: OUTPUT_API_VERSION,
    errorClass,
    code: exitCodeForOutcome(errorClass),
    message: messageForError(error),
    ...(runId === undefined ? {} : { runId }),
    retryable: retryableForOutcome(errorClass),
    operatorAction
  };
}

export function errorRecordForOutcome(input: {
  outcome: OutcomeClass;
  message: string;
  runId?: string | undefined;
  operatorAction?: string | undefined;
}): CliErrorRecord {
  return {
    apiVersion: OUTPUT_API_VERSION,
    errorClass: input.outcome,
    code: exitCodeForOutcome(input.outcome),
    message: input.message,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    retryable: retryableForOutcome(input.outcome),
    operatorAction: input.operatorAction ?? OPERATOR_ACTIONS[input.outcome]
  };
}

export function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OPERATOR_ACTIONS = Object.freeze({
  ok: "No operator action required.",
  usage_error: "Fix the invocation and rerun the command.",
  input_validation: "Fix the invalid value and rerun the command.",
  denied: "Request the appropriate approval or change the requested action.",
  blocked: "Resolve the pending approval or clarification before continuing.",
  gate_failure: "Inspect the gate verdict and repair the failing condition.",
  not_found: "Supply the correct run id and --root value.",
  runtime_error: "Inspect runtime diagnostics and retry only when the cause is transient.",
  timeout: "Retry after the runtime condition clears or increase the deadline.",
  integrity: "Escalate to run-store integrity recovery with the referenced run.",
  auth: "Authenticate with a principal authorized for this tenant and command."
} satisfies Record<OutcomeClass, string>);
