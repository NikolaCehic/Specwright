import {
  hashValue,
  type AdapterExecutionResult,
  type CapabilityDefinition
} from "@specwright/tool-broker";
import type { EvidenceClass, SourceAuthority, ToolCallResult } from "@specwright/schemas";
import { z, type ZodTypeAny } from "zod";

export const EXTERNAL_MCP_OBSERVATION_CLASS = "external_observation" as const;
export const EXTERNAL_MCP_OBSERVATION_EVIDENCE_CLASS =
  "unknown" as const satisfies EvidenceClass;
export const EXTERNAL_MCP_OBSERVATION_SOURCE_AUTHORITY =
  "external" as const satisfies SourceAuthority;

export type ExternalMcpObservation = {
  class: typeof EXTERNAL_MCP_OBSERVATION_CLASS;
  sourceAuthority: typeof EXTERNAL_MCP_OBSERVATION_SOURCE_AUTHORITY;
  evidenceClass: typeof EXTERNAL_MCP_OBSERVATION_EVIDENCE_CLASS;
  serverId: string;
  pinnedVersion: string;
  toolName: string;
  argsHash: string;
  resultHash: string;
};

export type ExternalMcpObservedOutput<T = unknown> = {
  data: T;
  externalObservation: ExternalMcpObservation;
};

export const ExternalMcpObservationSchema = z
  .object({
    class: z.literal(EXTERNAL_MCP_OBSERVATION_CLASS),
    sourceAuthority: z.literal(EXTERNAL_MCP_OBSERVATION_SOURCE_AUTHORITY),
    evidenceClass: z.literal(EXTERNAL_MCP_OBSERVATION_EVIDENCE_CLASS),
    serverId: z.string().min(1),
    pinnedVersion: z.string().min(1),
    toolName: z.string().min(1),
    argsHash: z.string().min(1),
    resultHash: z.string().min(1)
  })
  .strict();

export function externalMcpObservedOutputSchema(outputSchema: ZodTypeAny) {
  return z
    .object({
      data: outputSchema,
      externalObservation: ExternalMcpObservationSchema
    })
    .strict();
}

export function classifyExternalMcpObservation(input: {
  serverId: string;
  pinnedVersion: string;
  toolName: string;
  args: unknown;
  output: unknown;
}): ExternalMcpObservedOutput {
  return {
    data: input.output,
    externalObservation: {
      class: EXTERNAL_MCP_OBSERVATION_CLASS,
      sourceAuthority: EXTERNAL_MCP_OBSERVATION_SOURCE_AUTHORITY,
      evidenceClass: EXTERNAL_MCP_OBSERVATION_EVIDENCE_CLASS,
      serverId: input.serverId,
      pinnedVersion: input.pinnedVersion,
      toolName: input.toolName,
      argsHash: hashValue(input.args),
      resultHash: hashValue(input.output)
    }
  };
}

export function classifyExternalMcpToolResult(input: {
  definition: CapabilityDefinition;
  result: ToolCallResult;
  serverId: string;
  pinnedVersion: string;
  toolName: string;
}): ToolCallResult & {
  externalObservation?: ExternalMcpObservation;
} {
  if (input.result.status !== "success") {
    return input.result;
  }

  const output = input.result.output as ExternalMcpObservedOutput | undefined;
  const parsed = ExternalMcpObservationSchema.safeParse(
    output?.externalObservation
  );

  if (!parsed.success) {
    return input.result;
  }

  return {
    ...input.result,
    externalObservation: parsed.data
  };
}

export function externalMcpAdapterResultFromOutput(
  output: ExternalMcpObservedOutput
): AdapterExecutionResult {
  return {
    status: "success",
    output
  };
}
