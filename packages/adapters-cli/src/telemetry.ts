import { z } from "zod";
import { CLI_VERSION, OUTPUT_API_VERSION } from "./constants";
import type { CliExecutionContext } from "./context";
import type { OutcomeClass } from "./outcome";

export type CliTelemetryRecord = z.infer<typeof CliTelemetryRecordSchema>;

export type CliTelemetrySink = (
  record: CliTelemetryRecord
) => void | Promise<void>;

export const CliTelemetryRecordSchema = z
  .object({
    invocationId: z.string().min(1),
    command: z.string().min(1),
    principal: z
      .object({
        id: z.string().min(1),
        source: z.string().min(1),
        assuranceLevel: z.string().min(1)
      })
      .strict(),
    tenant: z.string().min(1),
    host: z
      .object({
        kind: z.literal("cli"),
        version: z.string().min(1)
      })
      .strict(),
    targetRunId: z.string().optional(),
    outcome: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    apiVersion: z.literal(OUTPUT_API_VERSION)
  })
  .strict();

export function buildTelemetryRecord(input: {
  invocationId: string;
  command: string;
  context: CliExecutionContext;
  targetRunId?: string | undefined;
  outcome: OutcomeClass;
  exitCode: number;
  startedAtMs: number;
  endedAtMs: number;
}): CliTelemetryRecord {
  return CliTelemetryRecordSchema.parse({
    invocationId: input.invocationId,
    command: input.command,
    principal: {
      id: input.context.principal.id,
      source: input.context.principal.source,
      assuranceLevel: input.context.principal.assuranceLevel
    },
    tenant: input.context.tenant.id,
    host: {
      kind: "cli",
      version: CLI_VERSION
    },
    ...(input.targetRunId === undefined
      ? {}
      : { targetRunId: input.targetRunId }),
    outcome: input.outcome,
    exitCode: input.exitCode,
    durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
    apiVersion: OUTPUT_API_VERSION
  });
}

export function defaultInvocationId(): string {
  return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
