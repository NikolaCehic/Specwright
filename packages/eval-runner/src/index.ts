import {
  EvalVerdictSchema,
  type EvalDefinition,
  type EvalFinding,
  type EvalProducedBy,
  type EvalSeverity,
  type EvalVerdict
} from "@specwright/schemas";
import {
  DEFAULT_EVAL_REGISTRY,
  DEFAULT_HARNESS_PACKAGE_ID,
  buildEvalRegistry,
  checksForDefinition,
  evalKind,
  isUnsupportedEvalKind,
  resolveFromRegistry,
  schemaRequiredFields,
  targetCandidates,
  type EvalRegistryManifest,
  type EvalDefinitionResolution
} from "./registry";
import {
  DECISION_HASH_FAIL_CLOSED_CODE,
  DecisionHashError,
  computeDecisionHash,
  hashResolvedInputs,
  hashValue,
  inputHashesToCausationIds,
  unresolvedDecisionInputHashes,
  type DecisionInputHashes,
  type HashDigest,
  type OrderedCheckResult,
  type ResolvedInputsHashInput
} from "./decision-hash";
import {
  evaluateModelAssistedGrader,
  type EvalBrokerPort
} from "./model-assisted";
import {
  DATASET_MISSING_CODE,
  DATASET_MALFORMED_CODE,
  DATASET_POISONED_CODE,
  datasetReferenceFromDefinition,
  findGoldenCase,
  hasDeclaredDatasetReference,
  resolveDataset,
  targetTypeFromTargetRef,
  type DatasetResolver,
  type PinnedDataset
} from "./datasets";
import {
  GRADER_NO_GOLDEN_CODE,
  enforceGoldenRegressionBar,
  type PinnedGrader
} from "./graders";
import {
  REGRESSION_DECISION_HASH_DEFECT_CODE,
  REGRESSION_GOLDEN_BINDING_MISMATCH_CODE,
  evaluateRegression,
  type EvalRegressionResult
} from "./regression";

export {
  DECISION_HASH_FAIL_CLOSED_CODE,
  computeDecisionHash,
  hashResolvedInputs,
  hashValue,
  inputHashesFromVerdict,
  inputHashesToCausationIds,
  recomputeDecisionHash,
  stableStringify,
  normalizeStable,
  type DecisionHashInput,
  type DecisionInputHashes,
  type HashDigest,
  type OrderedCheckResult,
  type ResolvedInputsHashInput
} from "./decision-hash";
export {
  DATASET_HASH_MISMATCH_CODE,
  DATASET_MALFORMED_CODE,
  DATASET_MISSING_CODE,
  DATASET_POISONED_CODE,
  DatasetCaseSchema,
  DatasetGoldenVerdictSchema,
  DatasetManifestSchema,
  DatasetReferenceSchema,
  canonicalizeDatasetManifest,
  computeDatasetContentId,
  datasetReferenceFromDefinition,
  findGoldenCase,
  hasDeclaredDatasetReference,
  parseDatasetManifest,
  pinDataset,
  resolveDataset,
  targetTypeFromTargetRef,
  verifyDatasetPin,
  type DatasetCase,
  type DatasetManifest,
  type DatasetReference,
  type DatasetResolution,
  type DatasetResolver,
  type PinnedDataset
} from "./datasets";
export {
  GRADER_NO_GOLDEN_CODE,
  GraderManifestSchema,
  canonicalizeGraderManifest,
  computeGraderContentId,
  enforceGoldenRegressionBar,
  parseGraderManifest,
  pinGrader,
  type GraderBlockingBar,
  type GraderManifest,
  type PinnedGrader
} from "./graders";
export {
  REGRESSION_DECISION_HASH_DEFECT_CODE,
  REGRESSION_GOLDEN_BINDING_MISMATCH_CODE,
  REGRESSION_GOLDEN_MISSING_CODE,
  REPLAY_DERIVATION_REQUIRED_CODE,
  EvalRegressionProvenanceSchema,
  EvalRegressionResultSchema,
  ReplayGuardResultSchema,
  evaluateRegression,
  guardDatasetBoundReplay,
  type EvalRegressionProvenance,
  type EvalRegressionResult,
  type ReplayGuardResult
} from "./regression";
export type {
  EvalBrokerContext,
  EvalBrokerPort,
  JsonSchemaLike,
  ModelAssistedFailureStatus,
  ModelAssistedGrader,
  ModelAssistedSchema,
  ProjectedGraderContext
} from "./model-assisted";
export {
  EVAL_CHECKS_MISSING_EVENT,
  EVAL_DEFINITION_MISSING_EVENT,
  EVAL_REPAIR_TASK_CREATED_EVENT,
  EVAL_TARGET_MISSING_EVENT,
  EVAL_TYPE_UNSUPPORTED_EVENT,
  EVAL_VERDICT_RECORDED_EVENT,
  EvalEmissionError,
  evaluateAndRecord,
  evaluateManyAndRecord,
  projectEvalEmissionHistory,
  recordEvalVerdict,
  type EvalAuditGap,
  type EvalEmissionAppendInput,
  type EvalEmissionAppendResult,
  type EvalEmissionAppendSink,
  type EvalEmissionContext,
  type EvalEmissionEventPayload,
  type EvalEmissionEventType,
  type EvalEmissionHistory,
  type EvalEmissionResult,
  type EvalEmissionSpanSink,
  type EvalFailClosedPayload,
  type EvalRecordedProvenance,
  type EvalRepairTaskCreatedPayload,
  type EvalVerdictRecordedPayload,
  type PriorEvalFailureLink
} from "./emission";

export const DEFAULT_EVAL_RUNNER_EVALUATOR = "specwright.eval-runner.v0";

export type EvalArtifactSnapshot = {
  artifactId?: string;
  id?: string;
  artifactType?: string;
  content?: unknown;
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
} & Record<string, unknown>;

export type EvalEvidenceSnapshot = Record<string, unknown>;

export type EvalRunnerInput = {
  artifacts?:
    | Record<string, EvalArtifactSnapshot>
    | readonly EvalArtifactSnapshot[]
    | undefined;
  evidence?: EvalEvidenceSnapshot | undefined;
};

export type FixtureEvalCheck = {
  id?: string | undefined;
  type?: string | undefined;
  message?: string | undefined;
  severity?: EvalSeverity | undefined;
  targetRef?: string | undefined;
  path?: string | undefined;
  evidenceRefs?: string[] | undefined;
  repairHint?: string | undefined;
  requiredFields?: string[] | undefined;
  required?: string[] | undefined;
  fields?: string[] | undefined;
  requiredSections?: string[] | undefined;
  sections?: string[] | undefined;
  claimsPath?: string | undefined;
  sectionsPath?: string | undefined;
  importantClaimLevels?: string[] | undefined;
} & Record<string, unknown>;

export type FixtureEvalDefinition = EvalDefinition & {
  type?: string;
  kind?: string;
  evalType?: string;
  category?: string;
  target?:
    | string
    | {
        id?: string;
        ref?: string;
        artifactId?: string;
        artifactType?: string;
      };
  targetRef?: string | undefined;
  artifactId?: string | undefined;
  severity?: EvalSeverity | undefined;
  required?: boolean | undefined;
  blocking?: boolean | undefined;
  enabled?: boolean | undefined;
  skip?: boolean | undefined;
  checks?: FixtureEvalCheck[] | undefined;
  requiredFields?: string[] | undefined;
  requiredSections?: string[] | undefined;
  claimsPath?: string | undefined;
  sectionsPath?: string | undefined;
  unsupportedStatus?: EvalVerdict["status"] | undefined;
  dataset?: unknown;
  datasetRef?: unknown;
  graderManifest?: unknown;
} & Record<string, unknown>;

export type EvalRegressionRunOptions = {
  enabled?: boolean | undefined;
  harnessSpecHash?: HashDigest | undefined;
  decisionInputHashes?: DecisionInputHashes | undefined;
  datasetRequired?: boolean | undefined;
  mismatchCode?:
    | "eval.dataset.hash_mismatch"
    | "eval.dataset.poisoned"
    | undefined;
};

export type RunEvalRequest = {
  harnessPackageId?: string | undefined;
  evalRegistry?: EvalRegistryManifest | undefined;
  evalId?: string | undefined;
  evalDefinition?: FixtureEvalDefinition | undefined;
  evalDefinitions?:
    | readonly FixtureEvalDefinition[]
    | Record<string, FixtureEvalDefinition>
    | undefined;
  input?: EvalRunnerInput | undefined;
  evaluatorRef?: string | undefined;
  broker?: EvalBrokerPort | undefined;
  phase?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  ciInvocationId?: string | undefined;
  datasetManifest?: unknown;
  currentDatasetManifest?: unknown;
  pinnedDataset?: PinnedDataset | undefined;
  datasetResolver?: DatasetResolver | undefined;
  datasetRequired?: boolean | undefined;
  datasetCaseId?: string | undefined;
  regression?: EvalRegressionRunOptions | undefined;
  graderManifest?: unknown;
};

export type RunEvalsRequest = Omit<RunEvalRequest, "evalDefinition"> & {
  evalDefinitions?:
    | readonly FixtureEvalDefinition[]
    | Record<string, FixtureEvalDefinition>;
};

type ResolvedArtifact = {
  ref: string;
  artifact: EvalArtifactSnapshot;
  content: unknown;
  evidenceRefs: string[];
};

type CheckEvaluation =
  | {
      status: "pass";
      evidenceRefs: string[];
    }
  | {
      status: "fail";
      finding: EvalFinding;
      evidenceRefs: string[];
    }
  | {
      status: "needs_review";
      finding: EvalFinding;
      evidenceRefs: string[];
    };

export type RunEvalWithRegressionResult = {
  verdict: EvalVerdict;
  dataset?: PinnedDataset | undefined;
  grader?: PinnedGrader | undefined;
  regression?: EvalRegressionResult | undefined;
};

export function runEval(request: RunEvalRequest): EvalVerdict {
  const resolution = resolveEvalDefinition(request);
  const definition = resolution.status === "resolved" ? resolution.definition : undefined;
  const evalId = request.evalId ?? request.evalDefinition?.id ?? resolution.definitionId;
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_EVAL_RUNNER_EVALUATOR;

  if (resolution.status === "untrusted") {
    return buildVerdict({
      evalId,
      targetRef: `eval:${evalId}`,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: `Eval definition ${evalId} does not match the governed registry entry`,
          code: "eval.definition.untrusted",
          targetRef: `eval:${evalId}`,
          severity: "blocking",
          repairHint:
            "Use the eval definition signed into the loaded harness package registry.",
          metadata: {
            registeredContentHash: resolution.registeredContentHash,
            suppliedContentHash: resolution.suppliedContentHash
          }
        })
      ],
      evidenceRefs: [],
      evaluatorRef,
      decisionContext: decisionContextFor({ request, resolution })
    });
  }

  if (definition === undefined) {
    return buildVerdict({
      evalId,
      targetRef: `eval:${evalId}`,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: `Eval definition ${evalId} is missing`,
          code: "eval.definition.missing",
          targetRef: `eval:${evalId}`,
          severity: "blocking",
          repairHint: "Provide a declared eval definition before running it."
        })
      ],
      evidenceRefs: [],
      evaluatorRef,
      decisionContext: decisionContextFor({ request, resolution })
    });
  }

  const severity = evalSeverity(definition);
  const target = resolveTargetArtifact(definition, request.input);
  const targetRef = target?.ref ?? targetRefFromDefinition(definition) ?? `eval:${evalId}`;
  const datasetFailure = datasetFailClosedVerdictForRequest({
    request,
    resolution,
    definition,
    evalId,
    target,
    targetRef,
    evaluatorRef
  });

  if (datasetFailure !== undefined) {
    return datasetFailure;
  }

  if (definition.skip === true || definition.enabled === false) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "skipped",
      severity,
      findings: [],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target
      })
    });
  }

  const kind = evalKind(definition);

  if (isUnsupportedEvalKind(kind)) {
    const status = unsupportedStatus(definition);
    return buildVerdict({
      evalId,
      targetRef,
      status,
      severity,
      findings:
        status === "skipped"
          ? []
          : [
              makeFinding({
                message: `Eval type ${kind} requires capabilities outside the deterministic EvalRunner slice`,
                code: "eval.type.unsupported",
                targetRef,
                severity,
                repairHint:
                  "Route this eval through an explicit ToolBroker-backed or human review path."
              })
            ],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target
      })
    });
  }

  const checks = checksForDefinition(definition, kind);

  if (checks.length === 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: [
        makeFinding({
          message: "Eval definition does not declare deterministic checks",
          code: "eval.checks.missing",
          targetRef,
          severity,
          repairHint:
            "Declare schema, source_fidelity, or completeness checks for deterministic execution."
        })
      ],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target
      })
    });
  }

  const evaluatedChecks = checks.map((check) => ({
    check,
    evaluation: evaluateCheck(check, definition, target, request.input, severity)
  }));
  const evaluations = evaluatedChecks.map(({ evaluation }) => evaluation);
  const checkResults = evaluatedChecks.map(({ check, evaluation }) =>
    normalizeCheckResult(check, definition, evaluation)
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
  const evidenceRefs = uniqueStrings([
    ...(target?.evidenceRefs ?? []),
    ...evaluations.flatMap((evaluation) => evaluation.evidenceRefs)
  ]);

  if (failed.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "fail",
      severity,
      findings: failed.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults
      })
    });
  }

  if (needsReview.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: needsReview.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults
      })
    });
  }

  return buildVerdict({
    evalId,
    targetRef,
    status: "pass",
    severity,
    findings: [],
    evidenceRefs,
    evaluatorRef,
    decisionContext: decisionContextFor({
      request,
      resolution,
      definition,
      target,
      checkResults
    })
  });
}

export async function runEvalAsync(request: RunEvalRequest): Promise<EvalVerdict> {
  const resolution = resolveEvalDefinition(request);
  const definition = resolution.status === "resolved" ? resolution.definition : undefined;
  const evalId = request.evalId ?? request.evalDefinition?.id ?? resolution.definitionId;
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_EVAL_RUNNER_EVALUATOR;

  if (resolution.status === "untrusted") {
    return buildVerdict({
      evalId,
      targetRef: `eval:${evalId}`,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: `Eval definition ${evalId} does not match the governed registry entry`,
          code: "eval.definition.untrusted",
          targetRef: `eval:${evalId}`,
          severity: "blocking",
          repairHint:
            "Use the eval definition signed into the loaded harness package registry.",
          metadata: {
            registeredContentHash: resolution.registeredContentHash,
            suppliedContentHash: resolution.suppliedContentHash
          }
        })
      ],
      evidenceRefs: [],
      evaluatorRef,
      decisionContext: decisionContextFor({ request, resolution })
    });
  }

  if (definition === undefined) {
    return buildVerdict({
      evalId,
      targetRef: `eval:${evalId}`,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: `Eval definition ${evalId} is missing`,
          code: "eval.definition.missing",
          targetRef: `eval:${evalId}`,
          severity: "blocking",
          repairHint: "Provide a declared eval definition before running it."
        })
      ],
      evidenceRefs: [],
      evaluatorRef,
      decisionContext: decisionContextFor({ request, resolution })
    });
  }

  const severity = evalSeverity(definition);
  const target = resolveTargetArtifact(definition, request.input);
  const targetRef = target?.ref ?? targetRefFromDefinition(definition) ?? `eval:${evalId}`;
  const datasetFailure = datasetFailClosedVerdictForRequest({
    request,
    resolution,
    definition,
    evalId,
    target,
    targetRef,
    evaluatorRef
  });

  if (datasetFailure !== undefined) {
    return datasetFailure;
  }

  if (definition.skip === true || definition.enabled === false) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "skipped",
      severity,
      findings: [],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target
      })
    });
  }

  const kind = evalKind(definition);

  if (isUnsupportedEvalKind(kind) && !isModelAssistedKind(kind)) {
    const status = unsupportedStatus(definition);
    return buildVerdict({
      evalId,
      targetRef,
      status,
      severity,
      findings:
        status === "skipped"
          ? []
          : [
              makeFinding({
                message: `Eval type ${kind} requires capabilities outside the deterministic EvalRunner slice`,
                code: "eval.type.unsupported",
                targetRef,
                severity,
                repairHint:
                  "Route this eval through an explicit ToolBroker-backed or human review path."
              })
            ],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target
      })
    });
  }

  const checks = checksForDefinition(definition, kind);

  if (!isModelAssistedKind(kind) && checks.length === 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: [
        makeFinding({
          message: "Eval definition does not declare deterministic checks",
          code: "eval.checks.missing",
          targetRef,
          severity,
          repairHint:
            "Declare schema, source_fidelity, or completeness checks for deterministic execution."
        })
      ],
      evidenceRefs: target?.evidenceRefs ?? [],
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target
      })
    });
  }

  const deterministicChecks = isModelAssistedKind(kind)
    ? checks.filter((check) => !isModelAssistedKind(normalizeKind(check.type ?? kind)))
    : checks;
  const evaluatedChecks = deterministicChecks.map((check) => ({
    check,
    evaluation: evaluateCheck(check, definition, target, request.input, severity)
  }));
  const evaluations = evaluatedChecks.map(({ evaluation }) => evaluation);
  const checkResults = evaluatedChecks.map(({ check, evaluation }) =>
    normalizeCheckResult(check, definition, evaluation)
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
  const evidenceRefs = uniqueStrings([
    ...(target?.evidenceRefs ?? []),
    ...evaluations.flatMap((evaluation) => evaluation.evidenceRefs)
  ]);

  if (failed.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "fail",
      severity,
      findings: failed.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults
      })
    });
  }

  if (!isModelAssistedKind(kind) && needsReview.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: needsReview.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults
      })
    });
  }

  if (!isModelAssistedKind(kind)) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "pass",
      severity,
      findings: [],
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults
      })
    });
  }

  if (needsReview.length > 0) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity,
      findings: needsReview.map((evaluation) => evaluation.finding),
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults
      })
    });
  }

  const graderBar = graderBarForRequest({
    request,
    definition,
    targetRef,
    severity
  });

  if (graderBar !== undefined && !graderBar.allowed) {
    return buildVerdict({
      evalId,
      targetRef,
      status: "needs_review",
      severity: "advisory",
      findings: [graderBar.finding],
      evidenceRefs,
      evaluatorRef,
      decisionContext: decisionContextFor({
        request,
        resolution,
        definition,
        target,
        checkResults: [
          ...checkResults,
          {
            type: "model_assisted",
            status: "needs_review",
            code: GRADER_NO_GOLDEN_CODE
          }
        ]
      })
    });
  }

  const modelEvaluation = await evaluateModelAssistedGrader({
    definition,
    evalId,
    targetRef,
    target,
    evidence: request.input?.evidence,
    severity,
    definitionHash: definitionHashForResolution(resolution),
    deterministicCheckResults: checkResults,
    broker: request.broker,
    phase: request.phase,
    runId: request.runId,
    traceId: request.traceId
  });
  const modelCheckResults = [...checkResults, modelEvaluation.checkResult];

  return buildVerdict({
    evalId,
    targetRef,
    status: modelEvaluation.status,
    severity,
    findings: modelEvaluation.finding === undefined ? [] : [modelEvaluation.finding],
    evidenceRefs: uniqueStrings([
      ...evidenceRefs,
      ...modelEvaluation.evidenceRefs
    ]),
    evaluatorRef,
    producedBy:
      modelEvaluation.contributed && modelEvaluation.producedByRef.length > 0
        ? { kind: "model_assisted", ref: modelEvaluation.producedByRef }
        : undefined,
    provenance: {
      runId: request.runId,
      phase: request.phase,
      traceId:
        modelEvaluation.contributed && modelEvaluation.traceId !== undefined
          ? modelEvaluation.traceId
          : request.traceId
    },
    decisionContext: decisionContextFor({
      request,
      resolution,
      definition,
      target,
      checkResults: modelCheckResults
    })
  });
}

export function runEvalWithRegression(
  request: RunEvalRequest
): RunEvalWithRegressionResult {
  const prepared = prepareDatasetForRequest(request);

  if (prepared?.status === "fail_closed") {
    return {
      verdict: prepared.verdict
    };
  }

  const verdict = runEval(request);

  if (prepared?.status !== "resolved") {
    return {
      verdict
    };
  }

  const regression = regressionForVerdict({
    request,
    verdict,
    dataset: prepared.dataset
  });

  if (
    regression?.status === "decision_hash_defect" ||
    regression?.status === "binding_mismatch"
  ) {
    return {
      verdict: regressionDefectVerdict({
        request,
        verdict,
        regression
      }),
      dataset: prepared.dataset,
      regression
    };
  }

  return {
    verdict,
    dataset: prepared.dataset,
    regression
  };
}

function prepareDatasetForRequest(
  request: RunEvalRequest
):
  | {
      status: "resolved";
      dataset: PinnedDataset;
    }
  | {
      status: "fail_closed";
      verdict: EvalVerdict;
    }
  | undefined {
  const resolution = resolveEvalDefinition(request);
  const definition = resolution.status === "resolved" ? resolution.definition : undefined;
  const evalId = request.evalId ?? request.evalDefinition?.id ?? resolution.definitionId;
  const evaluatorRef =
    request.evaluatorRef ?? DEFAULT_EVAL_RUNNER_EVALUATOR;

  if (definition === undefined) {
    return undefined;
  }

  const target = resolveTargetArtifact(definition, request.input);
  const targetRef = target?.ref ?? targetRefFromDefinition(definition) ?? `eval:${evalId}`;
  const resolutionResult = datasetResolutionForRequest({
    request,
    definition,
    evalId
  });

  if (resolutionResult === undefined) {
    return undefined;
  }

  if (resolutionResult.status === "resolved") {
    return {
      status: "resolved",
      dataset: resolutionResult.pinned
    };
  }

  return {
    status: "fail_closed",
    verdict: datasetFailureVerdict({
      request,
      resolution,
      definition,
      evalId,
      target,
      targetRef,
      evaluatorRef,
      datasetResolution: resolutionResult
    })
  };
}

function datasetFailClosedVerdictForRequest(input: {
  request: RunEvalRequest;
  resolution: EvalDefinitionResolution;
  definition: FixtureEvalDefinition;
  evalId: string;
  target: ResolvedArtifact | undefined;
  targetRef: string;
  evaluatorRef: string;
}): EvalVerdict | undefined {
  const datasetResolution = datasetResolutionForRequest({
    request: input.request,
    definition: input.definition,
    evalId: input.evalId
  });

  if (
    datasetResolution === undefined ||
    datasetResolution.status === "resolved"
  ) {
    return undefined;
  }

  return datasetFailureVerdict({
    ...input,
    datasetResolution
  });
}

function datasetResolutionForRequest(input: {
  request: RunEvalRequest;
  definition: FixtureEvalDefinition;
  evalId: string;
}) {
  const hasDatasetInput =
    input.request.datasetManifest !== undefined ||
    input.request.currentDatasetManifest !== undefined ||
    input.request.pinnedDataset !== undefined ||
    input.request.datasetResolver !== undefined ||
    hasDeclaredDatasetReference(input.definition);
  const required =
    hasDeclaredDatasetReference(input.definition) ||
    input.request.datasetRequired === true ||
    input.request.regression?.enabled === true ||
    input.request.regression?.datasetRequired === true;

  if (!hasDatasetInput && !required) {
    return undefined;
  }

  const datasetInput: Parameters<typeof resolveDataset>[0] = {
    evalId: input.evalId,
    definition: input.definition,
    manifest:
      input.request.currentDatasetManifest ?? input.request.datasetManifest,
    required
  };

  if (input.request.pinnedDataset !== undefined) {
    datasetInput.pinned = input.request.pinnedDataset;
  }

  if (input.request.datasetResolver !== undefined) {
    datasetInput.resolver = input.request.datasetResolver;
  }

  if (input.request.runId !== undefined) {
    datasetInput.runId = input.request.runId;
  }

  if (input.request.ciInvocationId !== undefined) {
    datasetInput.ciInvocationId = input.request.ciInvocationId;
  }

  if (input.request.regression?.mismatchCode !== undefined) {
    datasetInput.mismatchCode = input.request.regression.mismatchCode;
  }

  const result = resolveDataset(datasetInput);

  if (result.status === "missing" && !required) {
    return undefined;
  }

  return result;
}

function datasetFailureVerdict(input: {
  request: RunEvalRequest;
  resolution: EvalDefinitionResolution;
  definition: FixtureEvalDefinition;
  evalId: string;
  target: ResolvedArtifact | undefined;
  targetRef: string;
  evaluatorRef: string;
  datasetResolution: Exclude<
    ReturnType<typeof resolveDataset>,
    { status: "resolved" }
  >;
}): EvalVerdict {
  const code = input.datasetResolution.code;

  return buildVerdict({
    evalId: input.evalId,
    targetRef: input.targetRef,
    status: "fail",
    severity: "blocking",
    findings: [
      makeFinding({
        message: input.datasetResolution.message,
        code,
        targetRef: input.targetRef,
        severity: "blocking",
        repairHint:
          code === DATASET_MISSING_CODE
            ? "Resolve and pin the eval dataset before running regression analysis."
            : code === DATASET_MALFORMED_CODE
              ? "Fix the dataset reference before running this eval."
            : "Restore the pinned dataset bytes or re-pin the dataset through a governed run.",
        metadata: {
          dataset: {
            expectedContentId:
              input.datasetResolution.status === "mismatch"
                ? input.datasetResolution.expectedContentId
                : undefined,
            actualContentId:
              input.datasetResolution.status === "mismatch"
                ? input.datasetResolution.actualContentId
                : undefined,
            ref: input.datasetResolution.ref,
            malformed: code === DATASET_MALFORMED_CODE,
            poisoned: code === DATASET_POISONED_CODE
          }
        }
      })
    ],
    evidenceRefs: input.target?.evidenceRefs ?? [],
    evaluatorRef: input.evaluatorRef,
    provenance: {
      runId: input.request.runId,
      phase: input.request.phase,
      traceId: input.request.traceId
    },
    decisionContext: decisionContextFor({
      request: input.request,
      resolution: input.resolution,
      definition: input.definition,
      target: input.target,
      checkResults: [
        {
          type: "dataset",
          status: "fail",
          code
        }
      ]
    })
  });
}

function regressionForVerdict(input: {
  request: RunEvalRequest;
  verdict: EvalVerdict;
  dataset: PinnedDataset;
}): EvalRegressionResult | undefined {
  if (input.request.regression?.enabled !== true) {
    return undefined;
  }

  const targetType = targetTypeFromTargetRef(input.verdict.targetRef);
  const goldenCase = findGoldenCase({
    pinned: input.dataset,
    evalId: input.verdict.evalId,
    targetType,
    caseId: input.request.datasetCaseId
  });

  return evaluateRegression({
    current: input.verdict,
    golden: goldenCase?.golden,
    dataset: input.dataset,
    targetType,
    harnessSpecHash: input.request.regression.harnessSpecHash,
    decisionInputHashes: input.request.regression.decisionInputHashes
  });
}

function regressionDefectVerdict(input: {
  request: RunEvalRequest;
  verdict: EvalVerdict;
  regression: EvalRegressionResult;
}): EvalVerdict {
  const code =
    input.regression.findingCode ?? REGRESSION_DECISION_HASH_DEFECT_CODE;

  return buildVerdict({
    evalId: input.verdict.evalId,
    targetRef: input.verdict.targetRef,
    status: "fail",
    severity: "blocking",
    findings: [
      makeFinding({
        message:
          input.regression.message ??
          "Eval regression analysis could not recompute the decision hash",
        code,
        targetRef: input.verdict.targetRef,
        severity: "blocking",
        repairHint:
          code === REGRESSION_GOLDEN_BINDING_MISMATCH_CODE
            ? "Fix the dataset golden baseline binding before classifying regression status."
            : "Re-derive the eval verdict from recorded inputs before classifying regression status.",
        metadata: {
          regression: input.regression
        }
      })
    ],
    evidenceRefs: input.verdict.evidenceRefs,
    evaluatorRef: input.request.evaluatorRef ?? DEFAULT_EVAL_RUNNER_EVALUATOR,
    provenance: {
      runId: input.request.runId,
      phase: input.request.phase,
      traceId: input.request.traceId
    },
    decisionContext: {
      targetContent: input.verdict,
      evidenceSnapshot: undefined,
      definition: {
        defect: REGRESSION_DECISION_HASH_DEFECT_CODE
      },
      checkResults: [
        {
          type: "regression",
          status: "fail",
          code
        }
      ]
    }
  });
}

function graderBarForRequest(input: {
  request: RunEvalRequest;
  definition: FixtureEvalDefinition;
  targetRef: string;
  severity: EvalSeverity;
}) {
  const manifest = input.request.graderManifest ?? input.definition.graderManifest;

  if (manifest === undefined) {
    return undefined;
  }

  return enforceGoldenRegressionBar({
    manifest,
    targetRef: input.targetRef,
    severity: input.severity,
    blocking: input.severity === "blocking"
  });
}

export function runEvals(request: RunEvalsRequest): EvalVerdict[] {
  const registry = registryForRequest(request);
  const definitions = registry.entries.map((entry) => entry.definition);

  return definitions.map((definition) =>
    runEval({
      evalDefinition: definition,
      evalDefinitions: definitions,
      evalRegistry: registry,
      harnessPackageId: registry.harnessPackageId,
      input: request.input,
      evaluatorRef: request.evaluatorRef
    })
  );
}

export async function runEvalsAsync(
  request: RunEvalsRequest
): Promise<EvalVerdict[]> {
  const registry = registryForRequest(request);
  const definitions = registry.entries.map((entry) => entry.definition);

  return Promise.all(
    definitions.map((definition) =>
      runEvalAsync({
        evalDefinition: definition,
        evalDefinitions: definitions,
        evalRegistry: registry,
        harnessPackageId: registry.harnessPackageId,
        input: request.input,
        evaluatorRef: request.evaluatorRef,
        broker: request.broker,
        phase: request.phase,
        runId: request.runId,
        traceId: request.traceId
      })
    )
  );
}

function evaluateCheck(
  check: FixtureEvalCheck,
  definition: FixtureEvalDefinition,
  target: ResolvedArtifact | undefined,
  input: EvalRunnerInput | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  const type = normalizeKind(check.type ?? evalKind(definition));

  switch (type) {
    case "schema":
    case "presence":
    case "artifact_schema":
      return evaluateSchemaPresenceCheck(check, target, severity);
    case "source_fidelity":
      return evaluateSourceFidelityCheck(check, target, input, severity);
    case "completeness":
      return evaluateCompletenessCheck(check, target, severity);
    case "model_assisted":
    case "model_graded":
    case "visual":
    case "browser":
    case "human_review":
      return needsReviewForCheck(
        check,
        target,
        severity,
        `Eval check type ${type} is not supported by the deterministic EvalRunner slice`
      );
    default:
      return needsReviewForCheck(
        check,
        target,
        severity,
        `Eval check type ${type} is not supported`
      );
  }
}

function evaluateSchemaPresenceCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  if (target === undefined) {
    return missingTargetEvaluation(check, severity);
  }

  const requiredFields = uniqueStrings([
    ...stringArrayFrom(check.requiredFields),
    ...stringArrayFrom(check.required),
    ...stringArrayFrom(check.fields),
    ...schemaRequiredFields(check.schema)
  ]);
  const scopes = scopedValues(target.content, check.path);
  const missingFields = requiredFields.filter((field) =>
    scopes.length === 0
      ? true
      : scopes.some((scope) => !fieldPresent(scope, field))
  );

  if (missingFields.length > 0) {
    return {
      status: "fail",
      finding: makeFinding({
        message: `Artifact is missing required fields: ${missingFields.join(", ")}`,
        code: "artifact.required_fields.missing",
        targetRef: check.targetRef ?? target.ref,
        path: check.path,
        severity: check.severity ?? severity,
        evidenceRefs: check.evidenceRefs,
        repairHint:
          check.repairHint ??
          "Add the required fields or adjust the artifact schema."
      }),
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  return {
    status: "pass",
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function evaluateSourceFidelityCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  input: EvalRunnerInput | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  if (target === undefined) {
    return missingTargetEvaluation(check, severity);
  }

  const claimsPath = check.claimsPath ?? check.path ?? "claims";
  const claimValues = scopedValues(target.content, claimsPath).flatMap((value) =>
    Array.isArray(value) ? value : [value]
  );
  const claims = claimValues.filter(isRecord);

  if (claims.length === 0) {
    return {
      status: "fail",
      finding: makeFinding({
        message: "Source fidelity eval found no structured claims",
        code: "claims.missing",
        targetRef: check.targetRef ?? target.ref,
        path: normalizeDisplayPath(claimsPath),
        severity: check.severity ?? severity,
        evidenceRefs: check.evidenceRefs,
        repairHint:
          check.repairHint ??
          "Add structured claims with claim level and evidenceRefs."
      }),
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  const importantLevels = importantClaimLevels(check);
  const findings: EvalFinding[] = [];
  const evidenceRefs: string[] = [...(check.evidenceRefs ?? [])];

  claims.forEach((claim, index) => {
    if (!isImportantClaim(claim, importantLevels)) {
      return;
    }

    const refs = evidenceRefsForValue(claim);
    evidenceRefs.push(...refs);
    const path = `${normalizeDisplayPath(claimsPath)}[${index}]`;

    if (refs.length === 0) {
      findings.push(
        makeFinding({
          message: `Important claim ${claimLabel(claim, index)} lacks evidenceRefs`,
          code: "claim.evidence_refs.missing",
          targetRef: check.targetRef ?? target.ref,
          path,
          severity: check.severity ?? severity,
          repairHint:
            check.repairHint ??
            "Attach evidenceRefs or lower the claim to an assumption/unknown."
        })
      );
      return;
    }

    if (input?.evidence === undefined) {
      return;
    }

    const missingRefs = refs.filter((ref) => !hasEvidenceRef(input.evidence, ref));

    if (missingRefs.length > 0) {
      findings.push(
        makeFinding({
          message: `Important claim ${claimLabel(
            claim,
            index
          )} references missing evidence: ${missingRefs.join(", ")}`,
          code: "claim.evidence.missing",
          targetRef: check.targetRef ?? target.ref,
          path,
          severity: check.severity ?? severity,
          evidenceRefs: refs,
          repairHint:
            check.repairHint ??
            "Record the referenced evidence or replace the claim evidenceRefs."
        })
      );
    }
  });

  if (findings.length > 0) {
    return {
      status: "fail",
      finding: mergeFindings(findings, {
        message: `${findings.length} important claim(s) lack required evidence`,
        code: "source_fidelity.failed",
        targetRef: check.targetRef ?? target.ref,
        path: normalizeDisplayPath(claimsPath),
        severity: check.severity ?? severity
      }),
      evidenceRefs: uniqueStrings(evidenceRefs)
    };
  }

  return {
    status: "pass",
    evidenceRefs: uniqueStrings(evidenceRefs)
  };
}

function evaluateCompletenessCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  severity: EvalSeverity
): CheckEvaluation {
  if (target === undefined) {
    return missingTargetEvaluation(check, severity);
  }

  const requiredSections = uniqueStrings([
    ...stringArrayFrom(check.requiredSections),
    ...stringArrayFrom(check.sections)
  ]);
  const sectionsPath = check.sectionsPath ?? check.path ?? "sections";
  const sectionScopes = scopedValues(target.content, sectionsPath);
  const missingSections = requiredSections.filter(
    (section) => !sectionPresent(target.content, sectionScopes, section)
  );

  if (missingSections.length > 0) {
    return {
      status: "fail",
      finding: makeFinding({
        message: `Artifact is missing required sections: ${missingSections.join(", ")}`,
        code: "artifact.sections.missing",
        targetRef: check.targetRef ?? target.ref,
        path: normalizeDisplayPath(sectionsPath),
        severity: check.severity ?? severity,
        evidenceRefs: check.evidenceRefs,
        repairHint:
          check.repairHint ??
          "Add the missing sections before this artifact can pass completeness."
      }),
      evidenceRefs: check.evidenceRefs ?? []
    };
  }

  return {
    status: "pass",
    evidenceRefs: check.evidenceRefs ?? []
  };
}

export function resolveEvalDefinition(
  request: RunEvalRequest
): EvalDefinitionResolution {
  const definitionId =
    request.evalId ?? request.evalDefinition?.id ?? "unknown_eval";
  const registry = registryForRequest(request);

  return resolveFromRegistry({
    registry,
    harnessPackageId: request.harnessPackageId ?? registry.harnessPackageId,
    definitionId,
    suppliedDefinition: request.evalDefinition
  });
}

function registryForRequest(request: RunEvalRequest): EvalRegistryManifest {
  if (request.evalRegistry !== undefined) {
    return request.evalRegistry;
  }

  const harnessPackageId = request.harnessPackageId ?? DEFAULT_HARNESS_PACKAGE_ID;

  if (harnessPackageId === DEFAULT_EVAL_REGISTRY.harnessPackageId) {
    return DEFAULT_EVAL_REGISTRY;
  }

  return buildEvalRegistry(harnessPackageId, []);
}

function resolveTargetArtifact(
  definition: FixtureEvalDefinition,
  input: EvalRunnerInput | undefined
): ResolvedArtifact | undefined {
  const entries = artifactEntries(input?.artifacts);

  if (entries.length === 0) {
    return undefined;
  }

  const candidates = targetCandidates(definition);

  for (const candidate of candidates) {
    const normalized = normalizeTargetId(candidate);
    const matched = entries.find(([key, artifact]) =>
      artifactMatchesCandidate(key, artifact, normalized)
    );

    if (matched !== undefined) {
      const [key, artifact] = matched;
      return resolvedArtifact(key, artifact);
    }
  }

  if (candidates.length === 0 && entries.length === 1) {
    const [key, artifact] = entries[0] as [string, EvalArtifactSnapshot];
    return resolvedArtifact(key, artifact);
  }

  return undefined;
}

function artifactEntries(
  artifacts:
    | Record<string, EvalArtifactSnapshot>
    | readonly EvalArtifactSnapshot[]
    | undefined
): Array<[string, EvalArtifactSnapshot]> {
  if (artifacts === undefined) {
    return [];
  }

  if (Array.isArray(artifacts)) {
    return artifacts.map((artifact, index) => [
      artifact.artifactId ?? artifact.id ?? String(index),
      artifact
    ]);
  }

  return Object.entries(artifacts).filter(
    (entry): entry is [string, EvalArtifactSnapshot] => isRecord(entry[1])
  );
}

function resolvedArtifact(
  key: string,
  artifact: EvalArtifactSnapshot
): ResolvedArtifact {
  return {
    ref: targetRefForArtifact(key, artifact),
    artifact,
    content: artifact.content ?? artifact,
    evidenceRefs: stringArrayFrom(artifact.evidenceRefs)
  };
}

function artifactMatchesCandidate(
  key: string,
  artifact: EvalArtifactSnapshot,
  candidate: string
) {
  return [
    key,
    artifact.id,
    artifact.artifactId,
    artifact.artifactType,
    targetRefForArtifact(key, artifact)
  ]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeTargetId)
    .includes(candidate);
}

function targetRefFromDefinition(
  definition: FixtureEvalDefinition
): string | undefined {
  const candidates = targetCandidates(definition);
  const first = candidates[0];

  if (first === undefined) {
    return undefined;
  }

  return first.startsWith("artifact:") || first.startsWith("eval:")
    ? first
    : `artifact:${first}`;
}

function targetRefForArtifact(key: string, artifact: EvalArtifactSnapshot) {
  const id = artifact.artifactId ?? artifact.id ?? key;

  return id.startsWith("artifact:") ? id : `artifact:${id}`;
}

function unsupportedStatus(definition: FixtureEvalDefinition): EvalVerdict["status"] {
  return definition.unsupportedStatus === "fail" ||
    definition.unsupportedStatus === "skipped" ||
    definition.unsupportedStatus === "needs_review"
    ? definition.unsupportedStatus
    : "needs_review";
}

function isModelAssistedKind(kind: string) {
  return kind === "model_assisted" || kind === "model_graded";
}

function evalSeverity(definition: FixtureEvalDefinition): EvalSeverity {
  if (definition.severity === "advisory" || definition.severity === "blocking") {
    return definition.severity;
  }

  return definition.blocking === false || definition.required === false
    ? "advisory"
    : "blocking";
}

function missingTargetEvaluation(
  check: FixtureEvalCheck,
  severity: EvalSeverity
): CheckEvaluation {
  return {
    status: "fail",
    finding: makeFinding({
      message: "Eval target artifact is missing",
      code: "eval.target.missing",
      targetRef: check.targetRef,
      severity: check.severity ?? severity,
      evidenceRefs: check.evidenceRefs,
      repairHint:
        check.repairHint ??
        "Provide the target artifact declared by this eval definition."
    }),
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function needsReviewForCheck(
  check: FixtureEvalCheck,
  target: ResolvedArtifact | undefined,
  severity: EvalSeverity,
  message: string
): CheckEvaluation {
  return {
    status: "needs_review",
    finding: makeFinding({
      message,
      code: "eval.check.unsupported",
      targetRef: check.targetRef ?? target?.ref,
      severity: check.severity ?? severity,
      evidenceRefs: check.evidenceRefs,
      repairHint:
        check.repairHint ??
        "Use a supported deterministic check or route this eval to review."
    }),
    evidenceRefs: check.evidenceRefs ?? []
  };
}

function decisionContextFor(input: {
  request: RunEvalRequest;
  resolution: EvalDefinitionResolution;
  definition?: FixtureEvalDefinition | undefined;
  target?: ResolvedArtifact | undefined;
  checkResults?: readonly OrderedCheckResult[] | undefined;
}): ResolvedInputsHashInput {
  return {
    targetContent: input.target?.content,
    evidenceSnapshot: input.request.input?.evidence,
    definition: input.definition,
    definitionHash: definitionHashForResolution(input.resolution),
    checkResults: input.checkResults ?? []
  };
}

function definitionHashForResolution(
  resolution: EvalDefinitionResolution
): string | undefined {
  switch (resolution.status) {
    case "resolved":
      return resolution.contentHash;
    case "untrusted":
      return hashValue({
        status: "untrusted",
        registeredContentHash: resolution.registeredContentHash,
        suppliedContentHash: resolution.suppliedContentHash
      });
    case "missing":
      return undefined;
    default:
      return assertNever(resolution);
  }
}

function normalizeCheckResult(
  check: FixtureEvalCheck,
  definition: FixtureEvalDefinition,
  evaluation: CheckEvaluation
): OrderedCheckResult {
  const finding =
    evaluation.status === "pass" ? undefined : evaluation.finding;

  return {
    checkId: check.id,
    type: normalizeKind(check.type ?? evalKind(definition)),
    status: evaluation.status,
    code: finding?.code,
    path: finding?.path
  };
}

function buildVerdict(input: {
  evalId: string;
  targetRef: string;
  status: EvalVerdict["status"];
  severity: EvalSeverity;
  findings: EvalFinding[];
  evidenceRefs: string[];
  evaluatorRef: string;
  producedBy?: EvalProducedBy | undefined;
  provenance?:
    | {
        runId?: string | undefined;
        phase?: string | undefined;
        traceId?: string | undefined;
      }
    | undefined;
  decisionContext: ResolvedInputsHashInput;
}): EvalVerdict {
  const producedBy =
    input.producedBy ?? {
      kind: "deterministic" as const,
      ref: input.evaluatorRef
    };

  try {
    const inputHashes = hashResolvedInputs(input.decisionContext);
    const decisionHash = computeDecisionHash({
      evalId: input.evalId,
      targetRef: input.targetRef,
      status: input.status,
      severity: input.severity,
      producedByRef: producedBy.ref,
      ...inputHashes
    });

    return EvalVerdictSchema.parse({
      evalId: input.evalId,
      targetRef: input.targetRef,
      status: input.status,
      severity: input.severity,
      findings: input.findings,
      evidenceRefs: uniqueStrings(input.evidenceRefs),
      producedBy,
      provenance: {
        ...definedProvenance(input.provenance),
        decisionHash,
        causationIds: inputHashesToCausationIds(inputHashes)
      }
    });
  } catch (error) {
    if (!(error instanceof DecisionHashError)) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : "unknown hash error";
    const inputHashes = unresolvedDecisionInputHashes(reason);
    const decisionHash = computeDecisionHash({
      evalId: input.evalId,
      targetRef: input.targetRef,
      status: "fail",
      severity: "blocking",
      producedByRef: producedBy.ref,
      ...inputHashes
    });

    return EvalVerdictSchema.parse({
      evalId: input.evalId,
      targetRef: input.targetRef,
      status: "fail",
      severity: "blocking",
      findings: [
        makeFinding({
          message: "Eval decision hash could not be computed from resolved inputs",
          code: DECISION_HASH_FAIL_CLOSED_CODE,
          targetRef: input.targetRef,
          severity: "blocking",
          repairHint:
            "Provide JSON-canonicalizable eval inputs before treating this verdict as authoritative.",
          metadata: {
            reason
          }
        })
      ],
      evidenceRefs: [],
      producedBy,
      provenance: {
        ...definedProvenance(input.provenance),
        decisionHash,
        causationIds: inputHashesToCausationIds(inputHashes)
      }
    });
  }
}

function definedProvenance(
  provenance:
    | {
        runId?: string | undefined;
        phase?: string | undefined;
        traceId?: string | undefined;
      }
    | undefined
) {
  const output: Record<string, string> = {};

  if (provenance?.runId !== undefined) {
    output.runId = provenance.runId;
  }

  if (provenance?.phase !== undefined) {
    output.phase = provenance.phase;
  }

  if (provenance?.traceId !== undefined) {
    output.traceId = provenance.traceId;
  }

  return output;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled eval runner state ${String(value)}`);
}

function makeFinding(input: {
  message: string;
  code?: string | undefined;
  targetRef?: string | undefined;
  path?: string | undefined;
  severity?: EvalSeverity | undefined;
  evidenceRefs?: string[] | undefined;
  repairHint?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): EvalFinding {
  const finding: EvalFinding = {
    message: input.message
  };

  if (input.code !== undefined) {
    finding.code = input.code;
  }

  if (input.targetRef !== undefined) {
    finding.targetRef = input.targetRef;
  }

  if (input.path !== undefined) {
    finding.path = input.path;
  }

  if (input.severity !== undefined) {
    finding.severity = input.severity;
  }

  if (input.evidenceRefs !== undefined) {
    const evidenceRefs = uniqueStrings(input.evidenceRefs);

    if (evidenceRefs.length > 0) {
      finding.evidenceRefs = evidenceRefs;
    }
  }

  if (input.repairHint !== undefined) {
    finding.repairHint = input.repairHint;
  }

  if (input.metadata !== undefined) {
    finding.metadata = input.metadata;
  }

  return finding;
}

function mergeFindings(
  findings: readonly EvalFinding[],
  summary: {
    message: string;
    code: string;
    targetRef: string;
    path: string;
    severity: EvalSeverity;
  }
): EvalFinding {
  return makeFinding({
    ...summary,
    evidenceRefs: uniqueStrings(
      findings.flatMap((finding) => finding.evidenceRefs ?? [])
    ),
    metadata: {
      findings
    }
  });
}

function scopedValues(root: unknown, path: string | undefined): unknown[] {
  if (path === undefined || path.length === 0) {
    return [root];
  }

  return readPathValues(root, normalizeJsonPath(path));
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
    ? readPathValues(target, normalizeJsonPath(field))
    : isRecord(target)
      ? [target[field]]
      : [];

  return values.length > 0 && values.every(isPresent);
}

function sectionPresent(
  root: unknown,
  sectionScopes: readonly unknown[],
  section: string
): boolean {
  for (const scope of sectionScopes) {
    if (sectionPresentInValue(scope, section)) {
      return true;
    }
  }

  return fieldPresent(root, section);
}

function sectionPresentInValue(value: unknown, section: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => sectionPresentInValue(item, section));
  }

  if (typeof value === "string") {
    return value === section;
  }

  if (!isRecord(value)) {
    return false;
  }

  if (fieldPresent(value, section)) {
    return true;
  }

  return ["id", "key", "name", "title", "heading"].some(
    (field) => value[field] === section && isPresent(value)
  );
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function isImportantClaim(
  claim: Record<string, unknown>,
  importantLevels: readonly string[]
) {
  if (
    claim.important === true ||
    claim.required === true ||
    claim.requiresEvidence === true ||
    claim.importance === "important"
  ) {
    return true;
  }

  const level = firstString([
    claim.level,
    claim.kind,
    claim.class,
    claim.claimLevel
  ]);

  return level !== undefined && importantLevels.includes(normalizeKind(level));
}

function importantClaimLevels(check: FixtureEvalCheck): string[] {
  const configured = stringArrayFrom(check.importantClaimLevels).map(normalizeKind);

  if (configured.length > 0) {
    return configured;
  }

  return ["source_fact", "derived_fact", "inference", "human_decision"];
}

function claimLabel(claim: Record<string, unknown>, index: number) {
  return (
    firstString([claim.id, claim.claim, claim.text, claim.statement]) ??
    `#${index + 1}`
  );
}

function evidenceRefsForValue(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return uniqueStrings([
    ...stringArrayFrom(value.evidenceRefs),
    ...stringArrayFrom(value.evidence)
  ]);
}

function hasEvidenceRef(
  evidence: EvalEvidenceSnapshot | undefined,
  ref: string
) {
  if (evidence === undefined) {
    return true;
  }

  return collectEvidenceRefs(evidence).has(ref);
}

function collectEvidenceRefs(value: unknown, depth = 0): Set<string> {
  const refs = new Set<string>();

  if (depth > 6) {
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectEvidenceRefs(item, depth + 1)) {
        refs.add(ref);
      }
    }

    return refs;
  }

  if (!isRecord(value)) {
    return refs;
  }

  for (const key of ["id", "ref", "evidenceRef"]) {
    const ref = value[key];

    if (typeof ref === "string" && ref.length > 0) {
      refs.add(ref);
    }
  }

  for (const ref of stringArrayFrom(value.evidenceRefs)) {
    refs.add(ref);
  }

  const rawRefs = value.refs;

  if (isRecord(rawRefs)) {
    for (const ref of Object.keys(rawRefs)) {
      refs.add(ref);
    }
  } else {
    for (const ref of stringArrayFrom(rawRefs)) {
      refs.add(ref);
    }
  }

  for (const key of ["items", "records", "sources"]) {
    for (const ref of collectEvidenceRefs(value[key], depth + 1)) {
      refs.add(ref);
    }
  }

  return refs;
}

function normalizeJsonPath(path: string) {
  if (path === "$" || path.startsWith("$.")) {
    return path;
  }

  return `$.${path}`;
}

function normalizeDisplayPath(path: string) {
  return normalizeJsonPath(path);
}

function normalizeKind(value: string) {
  return value.trim().toLowerCase().replace(/[-. ]+/g, "_");
}

function normalizeTargetId(value: string) {
  return value.startsWith("artifact:") ? value.slice("artifact:".length) : value;
}

function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function definedStrings(values: readonly unknown[]): string[] {
  return values.filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function firstString(values: readonly unknown[]): string | undefined {
  return definedStrings(values)[0];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
