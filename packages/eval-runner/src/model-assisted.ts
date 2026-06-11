import { z, type ZodTypeAny } from "zod";
import {
  ToolCallResultSchema,
  type EvalFinding,
  type EvalSeverity,
  type EvalVerdict,
  type ToolCallRequest,
  type ToolCallResult
} from "@specwright/schemas";
import { hashValue, stableStringify, type OrderedCheckResult } from "./decision-hash";
import type {
  EvalArtifactSnapshot,
  EvalEvidenceSnapshot,
  FixtureEvalDefinition
} from "./index";

export type ModelAssistedFailureStatus = "needs_review" | "fail";

export type ModelAssistedGrader = {
  grader: string;
  modelTool: string;
  rubric: {
    ref: string;
    hash: string;
  };
  inputSchema: ModelAssistedSchema;
  outputSchema: ModelAssistedSchema;
  allowedContextRefs: string[];
  maxTokens: number;
  onInvalidOutput?: ModelAssistedFailureStatus | undefined;
  blocking?: boolean | undefined;
};

export type EvalBrokerContext = {
  traceId?: string | undefined;
  runId?: string | undefined;
};

export type EvalBrokerPort = (
  request: ToolCallRequest,
  context?: EvalBrokerContext
) => Promise<ToolCallResult>;

export type ModelAssistedSchema = ZodTypeAny | JsonSchemaLike;

export type JsonSchemaLike = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | undefined;
  properties?: Record<string, JsonSchemaLike> | undefined;
  required?: string[] | undefined;
  items?: JsonSchemaLike | undefined;
  enum?: unknown[] | undefined;
  const?: unknown;
  additionalProperties?: boolean | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
};

export type ModelAssistedEvaluation =
  | {
      contributed: true;
      status: Exclude<EvalVerdict["status"], "skipped">;
      finding?: EvalFinding | undefined;
      evidenceRefs: string[];
      checkResult: OrderedCheckResult;
      producedByRef: string;
      traceId?: string | undefined;
    }
  | {
      contributed: false;
      status: "needs_review";
      finding: EvalFinding;
      evidenceRefs: string[];
      checkResult: OrderedCheckResult;
    };

export type ProjectedGraderContext = Record<string, unknown>;

type ModelAssistedInput = {
  definition: FixtureEvalDefinition;
  evalId: string;
  targetRef: string;
  target:
    | {
        ref: string;
        artifact: EvalArtifactSnapshot;
        content: unknown;
        evidenceRefs: string[];
      }
    | undefined;
  evidence: EvalEvidenceSnapshot | undefined;
  severity: EvalSeverity;
  definitionHash?: string | undefined;
  deterministicCheckResults: readonly OrderedCheckResult[];
  broker?: EvalBrokerPort | undefined;
  phase?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
};

type ValidatedModelOutput = Record<string, unknown>;

const SECRET_FIELD_NAMES = new Set([
  "secret",
  "secrets",
  "password",
  "token",
  "apikey",
  "api_key",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "authorization",
  "redacted"
]);

const SECRET_CLASSIFICATIONS = new Set([
  "secret",
  "credential",
  "credentials",
  "confidential",
  "restricted",
  "private"
]);

export async function evaluateModelAssistedGrader(
  input: ModelAssistedInput
): Promise<ModelAssistedEvaluation> {
  const resolved = resolveModelAssistedGrader(input.definition);

  if (!resolved.success) {
    return failClosed({
      status: "needs_review",
      code: "eval.grader.incomplete",
      message: resolved.message,
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: {
        outcome: "configuration_error"
      }
    });
  }

  const grader = resolved.grader;

  if (input.broker === undefined) {
    return failClosed({
      status: "needs_review",
      code: "eval.grader.broker_missing",
      message: "Model-assisted eval requires an injected broker port",
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: modelMetadata({
        grader,
        modelCallId: modelCallIdFor(input, grader),
        outcome: "broker_missing"
      })
    });
  }

  const projected = projectGraderContext({
    grader,
    target: input.target,
    evidence: input.evidence
  });

  const parsedInput = schemaFor(grader.inputSchema).safeParse(projected.context);

  if (!parsedInput.success) {
    return failClosed({
      status: "needs_review",
      code: "eval.grader.input_invalid",
      message: "Model-assisted grader context failed its input schema",
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: modelMetadata({
        grader,
        modelCallId: modelCallIdFor(input, grader),
        outcome: "invalid_projection",
        issues: parsedInput.error.issues.map((issue) => issue.message)
      })
    });
  }

  const projectedTokenEstimate = estimateTokens(parsedInput.data);

  if (projectedTokenEstimate > grader.maxTokens) {
    return failClosed({
      status: "needs_review",
      code: "eval.grader.context_over_budget",
      message: "Model-assisted grader context exceeds the declared token budget",
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: modelMetadata({
        grader,
        modelCallId: modelCallIdFor(input, grader),
        outcome: "context_over_budget",
        projectedTokenEstimate
      })
    });
  }

  const modelCallId = modelCallIdFor(input, grader);
  const toolRequest = buildToolCallRequest({
    input,
    grader,
    context: parsedInput.data,
    modelCallId
  });
  let brokerResult: unknown;

  try {
    brokerResult = await input.broker(toolRequest, {
      traceId: input.traceId,
      runId: input.runId
    });
  } catch (error) {
    return failClosed({
      status: "needs_review",
      code: "eval.grader.result_invalid",
      message: "Model-assisted grader broker call did not return a valid result",
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: modelMetadata({
        grader,
        modelCallId,
        outcome: "invalid_result",
        toolRequest,
        issues: [errorMessage(error)]
      })
    });
  }

  const parsedResult = ToolCallResultSchema.safeParse(brokerResult);

  if (!parsedResult.success) {
    return failClosed({
      status: "needs_review",
      code: "eval.grader.result_invalid",
      message: "Model-assisted grader broker result failed its result schema",
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: modelMetadata({
        grader,
        modelCallId,
        outcome: "invalid_result",
        toolRequest,
        issues: parsedResult.error.issues.map((issue) => issue.message)
      })
    });
  }

  const result = parsedResult.data;
  const resultStatus = result.status;

  if (resultStatus !== "success") {
    const outcome = resultStatus === "denied" || resultStatus === "approval_required"
      ? "denied"
      : "error";

    return failClosed({
      status: "needs_review",
      code: `eval.grader.${resultStatus}`,
      message: `Model-assisted grader call returned ${resultStatus}`,
      targetRef: input.targetRef,
      severity: input.severity,
      metadata: modelMetadata({
        grader,
        modelCallId,
        outcome,
        toolRequest,
        toolResult: result
      })
    });
  }

  if (result.output === undefined) {
    return invalidOutput(input, grader, modelCallId, result, "Model-assisted grader returned no output");
  }

  if (estimateTokens(result.output) > grader.maxTokens) {
    return invalidOutput(
      input,
      grader,
      modelCallId,
      result,
      "Model-assisted grader output exceeds the declared token budget",
      "eval.grader.output_over_budget"
    );
  }

  const parsedOutput = schemaFor(grader.outputSchema).safeParse(result.output);

  if (!parsedOutput.success || !isRecord(parsedOutput.data)) {
    return invalidOutput(
      input,
      grader,
      modelCallId,
      result,
      "Model-assisted grader output failed its output schema",
      "eval.grader.output_invalid",
      parsedOutput.success
        ? undefined
        : parsedOutput.error.issues.map((issue) => issue.message)
    );
  }

  return validOutputContribution({
    input,
    grader,
    modelCallId,
    toolRequest,
    toolResult: result,
    output: parsedOutput.data
  });
}

export function resolveModelAssistedGrader(
  definition: FixtureEvalDefinition
):
  | { success: true; grader: ModelAssistedGrader }
  | { success: false; message: string } {
  const raw = firstRecord([
    definition.modelAssistedGrader,
    definition.modelGrader,
    definition.grader
  ]);

  if (raw === undefined) {
    return {
      success: false,
      message: "Model-assisted eval definition does not declare a grader contract"
    };
  }

  const rubric = isRecord(raw.rubric) ? raw.rubric : undefined;
  const grader = stringFrom(raw.grader);
  const modelTool = stringFrom(raw.modelTool);
  const rubricRef = stringFrom(rubric?.ref);
  const rubricHash = stringFrom(rubric?.hash);
  const allowedContextRefs = stringArrayFrom(raw.allowedContextRefs);
  const maxTokens = numberFrom(raw.maxTokens);
  const inputSchema = raw.inputSchema;
  const outputSchema = raw.outputSchema;

  if (
    grader === undefined ||
    modelTool === undefined ||
    rubricRef === undefined ||
    rubricHash === undefined ||
    inputSchema === undefined ||
    outputSchema === undefined ||
    allowedContextRefs.length === 0 ||
    maxTokens === undefined ||
    maxTokens <= 0
  ) {
    return {
      success: false,
      message:
        "Model-assisted grader contract must declare grader, modelTool, rubric, inputSchema, outputSchema, allowedContextRefs, and maxTokens"
    };
  }

  return {
    success: true,
    grader: {
      grader,
      modelTool,
      rubric: {
        ref: rubricRef,
        hash: rubricHash
      },
      inputSchema: inputSchema as ModelAssistedSchema,
      outputSchema: outputSchema as ModelAssistedSchema,
      allowedContextRefs,
      maxTokens,
      onInvalidOutput:
        raw.onInvalidOutput === "fail" ? "fail" : "needs_review",
      blocking: raw.blocking === true
    }
  };
}

export function projectGraderContext(input: {
  grader: ModelAssistedGrader;
  target:
    | {
        ref: string;
        artifact: EvalArtifactSnapshot;
        content: unknown;
        evidenceRefs: string[];
      }
    | undefined;
  evidence: EvalEvidenceSnapshot | undefined;
}): { context: ProjectedGraderContext; redactedPaths: string[] } {
  const context: ProjectedGraderContext = {};
  const redactedPaths: string[] = [];

  for (const ref of input.grader.allowedContextRefs) {
    const projected = valueForContextRef(ref, input.target, input.evidence);
    const sanitized = sanitizeForModel(projected, ref, redactedPaths);

    if (sanitized !== undefined) {
      setContextRef(context, ref, sanitized);
    }
  }

  return {
    context,
    redactedPaths
  };
}

function validOutputContribution(input: {
  input: ModelAssistedInput;
  grader: ModelAssistedGrader;
  modelCallId: string;
  toolRequest: ToolCallRequest;
  toolResult: ToolCallResult;
  output: ValidatedModelOutput;
}): ModelAssistedEvaluation {
  const requestedStatus = proposalStatus(input.output);
  const evidenceRefs = uniqueStrings(stringArrayFrom(input.output.evidenceRefs));
  const metadata = modelMetadata({
    grader: input.grader,
    modelCallId: input.modelCallId,
    outcome: "success",
    toolRequest: input.toolRequest,
    toolResult: input.toolResult,
    modelOutput: input.output
  });

  if (requestedStatus === "pass") {
    if (input.input.severity === "blocking") {
      const finding = findingFor({
        message:
          "Model-assisted clean result is advisory and cannot satisfy a blocking eval by itself",
        code: "eval.grader.blocking_pass_not_authoritative",
        targetRef: input.input.targetRef,
        severity: input.input.severity,
        evidenceRefs,
        metadata
      });

      return {
        contributed: true,
        status: "needs_review",
        finding,
        evidenceRefs,
        producedByRef: input.grader.grader,
        traceId: input.toolResult.provenance.traceId,
        checkResult: {
          checkId: input.modelCallId,
          type: "model_assisted",
          status: "needs_review",
          code: finding.code,
          path: finding.path
        }
      };
    }

    const finding = findingFor({
      message:
        stringFrom(input.output.message) ??
        "Model-assisted grader returned a clean advisory result",
      code: "eval.grader.advisory_pass",
      targetRef: input.input.targetRef,
      severity: input.input.severity,
      evidenceRefs,
      metadata
    });

    return {
      contributed: true,
      status: "pass",
      finding,
      evidenceRefs,
      producedByRef: input.grader.grader,
      traceId: input.toolResult.provenance.traceId,
      checkResult: {
        checkId: input.modelCallId,
        type: "model_assisted",
        status: "pass"
      }
    };
  }

  const status =
    requestedStatus === "fail" && input.grader.blocking === true
      ? "fail"
      : "needs_review";
  const finding = findingFor({
    message: messageFromOutput(input.output, status),
    code: status === "fail" ? "eval.grader.failed" : "eval.grader.needs_review",
    targetRef: input.input.targetRef,
    severity: input.input.severity,
    evidenceRefs,
    metadata
  });

  return {
    contributed: true,
    status,
    finding,
    evidenceRefs,
    producedByRef: input.grader.grader,
    traceId: input.toolResult.provenance.traceId,
    checkResult: {
      checkId: input.modelCallId,
      type: "model_assisted",
      status,
      code: finding.code,
      path: finding.path
    }
  };
}

function invalidOutput(
  input: ModelAssistedInput,
  grader: ModelAssistedGrader,
  modelCallId: string,
  result: ToolCallResult,
  message: string,
  code = "eval.grader.output_invalid",
  issues?: string[] | undefined
): ModelAssistedEvaluation {
  const status = grader.onInvalidOutput === "fail" ? "fail" : "needs_review";

  return failClosed({
    status,
    code,
    message,
    targetRef: input.targetRef,
    severity: input.severity,
    metadata: modelMetadata({
      grader,
      modelCallId,
      outcome: "invalid_output",
      toolResult: result,
      issues
    })
  });
}

function failClosed(input: {
  status: "needs_review" | "fail";
  code: string;
  message: string;
  targetRef: string;
  severity: EvalSeverity;
  evidenceRefs?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}): ModelAssistedEvaluation {
  const finding = findingFor({
    message: input.message,
    code: input.code,
    targetRef: input.targetRef,
    severity: input.severity,
    evidenceRefs: input.evidenceRefs,
    metadata: input.metadata
  });

  return {
    contributed: input.metadata?.modelAssisted !== undefined,
    status: input.status,
    finding,
    evidenceRefs: input.evidenceRefs ?? [],
    producedByRef: stringFrom(
      isRecord(input.metadata?.modelAssisted)
        ? input.metadata.modelAssisted.grader
        : undefined
    ) ?? "",
    checkResult: {
      type: "model_assisted",
      status: input.status,
      code: input.code
    }
  } as ModelAssistedEvaluation;
}

function buildToolCallRequest(input: {
  input: ModelAssistedInput;
  grader: ModelAssistedGrader;
  context: unknown;
  modelCallId: string;
}): ToolCallRequest {
  return {
    toolId: input.grader.modelTool,
    args: {
      context: input.context,
      rubric: input.grader.rubric,
      maxTokens: input.grader.maxTokens
    },
    reason: `Grade eval ${input.input.evalId} with ${input.grader.grader}`,
    idempotencyKey: `eval-grading:${hashValue({
      evalId: input.input.evalId,
      targetRef: input.input.targetRef,
      targetContentHash: hashValue(
        input.input.target === undefined
          ? { absent: "target" }
          : input.input.target.content
      ),
      evidenceSnapshotHash: hashValue(input.input.evidence ?? { absent: "evidence" }),
      definitionHash: input.input.definitionHash,
      checkResults: input.input.deterministicCheckResults,
      rubricHash: input.grader.rubric.hash,
      grader: input.grader.grader,
      modelTool: input.grader.modelTool,
      modelCallId: input.modelCallId
    })}`,
    requestedBy: {
      phase: input.input.phase ?? "eval",
      evalId: input.input.evalId,
      modelCallId: input.modelCallId
    }
  };
}

function modelCallIdFor(
  input: ModelAssistedInput,
  grader: ModelAssistedGrader
): string {
  return `model-call:${hashValue({
    evalId: input.evalId,
    targetRef: input.targetRef,
    definitionHash: input.definitionHash,
    checkResults: input.deterministicCheckResults,
    rubricHash: grader.rubric.hash,
    grader: grader.grader,
    modelTool: grader.modelTool
  })}`;
}

function modelMetadata(input: {
  grader: ModelAssistedGrader;
  modelCallId: string;
  outcome: string;
  toolRequest?: ToolCallRequest | undefined;
  toolResult?: ToolCallResult | undefined;
  modelOutput?: Record<string, unknown> | undefined;
  issues?: string[] | undefined;
  projectedTokenEstimate?: number | undefined;
}): Record<string, unknown> {
  return {
    modelAssisted: {
      grader: input.grader.grader,
      modelTool: input.grader.modelTool,
      rubricRef: input.grader.rubric.ref,
      rubricHash: input.grader.rubric.hash,
      modelCallId: input.modelCallId,
      outcome: input.outcome,
      toolCallId: input.toolResult?.toolCallId,
      toolStatus: input.toolResult?.status,
      toolSpan: input.toolResult
        ? {
            toolId: input.toolResult.provenance.toolId,
            toolVersion: input.toolResult.provenance.toolVersion,
            argsHash: input.toolResult.provenance.argsHash,
            resultHash: input.toolResult.provenance.resultHash,
            cacheStatus: input.toolResult.provenance.cacheStatus,
            traceId: input.toolResult.provenance.traceId,
            spanId: input.toolResult.provenance.spanId,
            tokenBudget: input.grader.maxTokens
          }
        : undefined,
      requestedBy: input.toolRequest?.requestedBy,
      idempotencyKey: input.toolRequest?.idempotencyKey,
      issues: input.issues,
      projectedTokenEstimate: input.projectedTokenEstimate,
      outcomeLabel: input.outcome,
      modelOutput: input.modelOutput
    }
  };
}

function proposalStatus(output: Record<string, unknown>): "pass" | "needs_review" | "fail" {
  const value = stringFrom(output.status) ?? stringFrom(output.outcome);

  if (value === "pass" || value === "clean") {
    return "pass";
  }

  if (value === "fail" || value === "blocking") {
    return "fail";
  }

  return "needs_review";
}

function messageFromOutput(
  output: Record<string, unknown>,
  status: "needs_review" | "fail"
) {
  return (
    stringFrom(output.message) ??
    stringFrom(output.summary) ??
    (status === "fail"
      ? "Model-assisted grader reported a rubric-blocking finding"
      : "Model-assisted grader reported a finding requiring review")
  );
}

function valueForContextRef(
  ref: string,
  target:
    | {
        ref: string;
        artifact: EvalArtifactSnapshot;
        content: unknown;
        evidenceRefs: string[];
      }
    | undefined,
  evidence: EvalEvidenceSnapshot | undefined
): unknown {
  if (ref === "target") {
    return target === undefined
      ? undefined
      : {
          ref: target.ref,
          content: target.content,
          evidenceRefs: target.evidenceRefs,
          metadata: target.artifact.metadata
        };
  }

  if (ref === "target.ref") {
    return target?.ref;
  }

  if (ref === "target.content") {
    return target?.content;
  }

  if (ref.startsWith("target.content.")) {
    return readPathValue(target?.content, ref.slice("target.content.".length));
  }

  if (ref === "target.evidenceRefs") {
    return target?.evidenceRefs;
  }

  if (ref === "target.metadata") {
    return target?.artifact.metadata;
  }

  if (ref.startsWith("target.metadata.")) {
    return readPathValue(target?.artifact.metadata, ref.slice("target.metadata.".length));
  }

  if (ref === "evidence") {
    return evidence;
  }

  if (ref.startsWith("evidence.")) {
    return readPathValue(evidence, ref.slice("evidence.".length));
  }

  return undefined;
}

function setContextRef(context: Record<string, unknown>, ref: string, value: unknown) {
  const segments = ref.split(".");
  let current = context;

  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }

    const existing = current[segment];

    if (!isRecord(existing)) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
    } else {
      current = existing;
    }
  }
}

function readPathValue(root: unknown, path: string): unknown {
  const segments = path.split(".");
  let current = root;

  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function sanitizeForModel(
  value: unknown,
  path: string,
  redactedPaths: string[]
): unknown {
  if (Array.isArray(value)) {
    const sanitized = value
      .map((item, index) => sanitizeForModel(item, `${path}[${index}]`, redactedPaths))
      .filter((item) => item !== undefined);

    return sanitized;
  }

  if (!isRecord(value)) {
    return value;
  }

  const classification = stringFrom(value.classification);

  if (
    value.redacted === true ||
    (classification !== undefined &&
      SECRET_CLASSIFICATIONS.has(normalizeSecretKey(classification)))
  ) {
    redactedPaths.push(path);
    return undefined;
  }

  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;

    if (SECRET_FIELD_NAMES.has(normalizeSecretKey(key))) {
      redactedPaths.push(childPath);
      continue;
    }

    const sanitized = sanitizeForModel(child, childPath, redactedPaths);

    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }

  return output;
}

function schemaFor(schema: ModelAssistedSchema): ZodTypeAny {
  if (isZodSchema(schema)) {
    return schema;
  }

  return jsonSchemaToZod(schema);
}

function jsonSchemaToZod(schema: JsonSchemaLike): ZodTypeAny {
  if (Array.isArray(schema.enum)) {
    const values = schema.enum;

    if (values.length === 0) {
      return z.never();
    }

    if (values.length === 1) {
      return z.literal(values[0] as Parameters<typeof z.literal>[0]);
    }

    return z.union(
      values.map((value) =>
        z.literal(value as Parameters<typeof z.literal>[0])
      ) as [
        z.ZodLiteral<unknown>,
        z.ZodLiteral<unknown>,
        ...z.ZodLiteral<unknown>[]
      ]
    );
  }

  if ("const" in schema) {
    return z.literal(schema.const as Parameters<typeof z.literal>[0]);
  }

  switch (schema.type) {
    case "object": {
      const shape: Record<string, ZodTypeAny> = {};
      const required = new Set(schema.required ?? []);

      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const childSchema = jsonSchemaToZod(child);
        shape[key] = required.has(key) ? childSchema : childSchema.optional();
      }

      const objectSchema = z.object(shape);

      return schema.additionalProperties === false
        ? objectSchema.strict()
        : objectSchema.passthrough();
    }
    case "array":
      return z.array(schema.items === undefined ? z.unknown() : jsonSchemaToZod(schema.items));
    case "string": {
      let stringSchema = z.string();

      if (schema.minLength !== undefined) {
        stringSchema = stringSchema.min(schema.minLength);
      }

      if (schema.maxLength !== undefined) {
        stringSchema = stringSchema.max(schema.maxLength);
      }

      return stringSchema;
    }
    case "integer": {
      let numberSchema = z.number().int();

      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }

      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }

      return numberSchema;
    }
    case "number": {
      let numberSchema = z.number();

      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }

      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }

      return numberSchema;
    }
    case "boolean":
      return z.boolean();
    default:
      return z.unknown();
  }
}

function estimateTokens(value: unknown): number {
  return Math.ceil(stableStringify(value).length / 4);
}

function findingFor(input: {
  message: string;
  code: string;
  targetRef: string;
  severity: EvalSeverity;
  evidenceRefs?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}): EvalFinding {
  const finding: EvalFinding = {
    message: input.message,
    code: input.code,
    targetRef: input.targetRef,
    severity: input.severity
  };

  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? []);

  if (evidenceRefs.length > 0) {
    finding.evidenceRefs = evidenceRefs;
  }

  if (input.metadata !== undefined) {
    finding.metadata = input.metadata;
  }

  return finding;
}

function firstRecord(values: readonly unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return isRecord(value) && typeof value.safeParse === "function";
}

function normalizeSecretKey(value: string) {
  return value.trim().toLowerCase().replace(/[-. ]+/g, "_");
}
