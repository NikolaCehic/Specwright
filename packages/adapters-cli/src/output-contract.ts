import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  HumanQuestionSchema,
  RuntimeEventSchema,
  RunStateSchema
} from "@specwright/schemas";
import { OUTPUT_API_VERSION } from "./constants";
import type { CliErrorRecord } from "./errors";
import type { OutcomeClass } from "./outcome";

export type CliCommandName =
  | "doctor"
  | "run"
  | "status"
  | "events"
  | "replay"
  | "report"
  | "approve"
  | "reject"
  | "answer";

export type CliDiagnostic = {
  code: string;
  message: string;
  [key: string]: unknown;
};

export type CliPending = {
  approvals: unknown[];
  questions: unknown[];
};

export type CliOutputEnvelope<TData = unknown> = {
  apiVersion: number;
  command: CliCommandName;
  outcome: OutcomeClass;
  runId?: string;
  data?: TData;
  pending?: CliPending;
  diagnostics?: CliDiagnostic[];
  error?: CliErrorRecord;
};

const pendingSchema = z
  .object({
    approvals: z.array(ApprovalRequestSchema),
    questions: z.array(HumanQuestionSchema)
  })
  .strict();

const errorRecordSchema = z
  .object({
    apiVersion: z.literal(OUTPUT_API_VERSION),
    errorClass: z.enum([
      "ok",
      "usage_error",
      "input_validation",
      "denied",
      "blocked",
      "gate_failure",
      "not_found",
      "runtime_error",
      "timeout",
      "integrity",
      "auth"
    ]),
    code: z.number().int(),
    message: z.string(),
    runId: z.string().optional(),
    retryable: z.boolean(),
    operatorAction: z.string()
  })
  .strict();

const diagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string()
  })
  .passthrough();

const approvalDecisionResultSchema = z
  .object({
    decision: ApprovalDecisionSchema,
    event: RuntimeEventSchema,
    state: RunStateSchema
  })
  .strict();

const doctorCheckSchema = z
  .object({
    id: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    message: z.string(),
    path: z.string().optional(),
    operatorAction: z.string().optional()
  })
  .strict();

const doctorReportSchema = z
  .object({
    rootDir: z.string(),
    mode: z.literal("source-checkout"),
    cliVersion: z.string(),
    configDir: z.string(),
    summary: z
      .object({
        pass: z.number().int().nonnegative(),
        warn: z.number().int().nonnegative(),
        fail: z.number().int().nonnegative()
      })
      .strict(),
    checks: z.array(doctorCheckSchema)
  })
  .strict();

function envelopeSchema(command: CliCommandName, data: z.ZodTypeAny) {
  return z
    .object({
      apiVersion: z.literal(OUTPUT_API_VERSION),
      command: z.literal(command),
      outcome: z.enum([
        "ok",
        "usage_error",
        "input_validation",
        "denied",
        "blocked",
        "gate_failure",
        "not_found",
        "runtime_error",
        "timeout",
        "integrity",
        "auth"
      ]),
      runId: z.string().optional(),
      data: data.optional(),
      pending: pendingSchema.optional(),
      diagnostics: z.array(diagnosticSchema).optional(),
      error: errorRecordSchema.optional()
    })
    .strict();
}

export const doctorOutputSchema = envelopeSchema("doctor", doctorReportSchema);
export const runOutputSchema = envelopeSchema("run", z.unknown());
export const statusOutputSchema = envelopeSchema("status", RunStateSchema);
export const eventsOutputSchema = envelopeSchema(
  "events",
  z.array(RuntimeEventSchema)
);
export const replayOutputSchema = envelopeSchema(
  "replay",
  z
    .object({
      state: RunStateSchema,
      events: z.array(RuntimeEventSchema)
    })
    .strict()
);
export const reportOutputSchema = envelopeSchema(
  "report",
  z
    .object({
      runId: z.string(),
      summaryPath: z.string(),
      markdown: z.string(),
      missingInputs: z.array(z.string())
    })
    .strict()
);
export const approveOutputSchema = envelopeSchema(
  "approve",
  approvalDecisionResultSchema
);
export const rejectOutputSchema = envelopeSchema(
  "reject",
  approvalDecisionResultSchema
);
export const answerOutputSchema = envelopeSchema("answer", z.unknown());

export const outputSchemas = Object.freeze({
  doctor: doctorOutputSchema,
  run: runOutputSchema,
  status: statusOutputSchema,
  events: eventsOutputSchema,
  replay: replayOutputSchema,
  report: reportOutputSchema,
  approve: approveOutputSchema,
  reject: rejectOutputSchema,
  answer: answerOutputSchema
});

export function encodeEnvelope<TData>(
  envelope: Omit<CliOutputEnvelope<TData>, "apiVersion">
): string {
  return `${JSON.stringify({ apiVersion: OUTPUT_API_VERSION, ...envelope }, null, 2)}\n`;
}

export function pendingFromState(state: unknown): CliPending | undefined {
  if (!isStateLike(state)) {
    return undefined;
  }

  if (state.pendingApprovals.length === 0 && state.pendingQuestions.length === 0) {
    return undefined;
  }

  return {
    approvals: state.pendingApprovals,
    questions: state.pendingQuestions
  };
}

function isStateLike(value: unknown): value is {
  pendingApprovals: unknown[];
  pendingQuestions: unknown[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { pendingApprovals?: unknown }).pendingApprovals) &&
    Array.isArray((value as { pendingQuestions?: unknown }).pendingQuestions)
  );
}
