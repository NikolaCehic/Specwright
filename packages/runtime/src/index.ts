import { fileURLToPath } from "node:url";
import {
  appendArtifact,
  listArtifacts,
  type ArtifactRecordInput
} from "@specwright/artifact-store";
import { appendEvidence, listEvidence } from "@specwright/evidence-store";
import {
  runEval as runEvalWithRunner,
  type FixtureEvalDefinition,
  type RunEvalRequest
} from "@specwright/eval-runner";
import {
  evaluateGate as evaluateGateWithEngine,
  type EvaluateGateRequest,
  type FixtureGateDefinition,
  type GateArtifactSnapshot,
  type GateEvaluationInput,
  type GateEvaluationResult,
  type GateLifecycleInstruction
} from "@specwright/gate-engine";
import {
  loadHarnessPackage as loadHarnessPackageWithLoader,
  type LoadHarnessPackageOptions
} from "@specwright/harness-loader";
import {
  generateRunReport,
  writeRunReport as writeRunReportWithReports,
  type RunReport
} from "@specwright/run-reports";
import {
  appendEvent,
  createRun,
  materializeRunState,
  projectRunState,
  readEvents,
  type RunStorePaths
} from "@specwright/run-store";
import {
  createToolBroker as createToolBrokerWithDefaults,
  type ToolBrokerOptions,
  type ToolCallContext
} from "@specwright/tool-broker";
import {
  EvalVerdictSchema,
  HarnessSnapshotSchema,
  ApprovalDecisionSchema,
  HumanAnswerRecordedEventPayloadSchema,
  RunInputSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type ArtifactRecord,
  type EvalVerdict,
  type EvidenceRecord,
  type HarnessSnapshot,
  type HumanAnswerRecordedEventPayload,
  type HumanQuestion,
  type RepairTask,
  type RunInput,
  type RunState,
  type RuntimeEvent,
  type ToolCallRequest,
  type ToolCallResult
} from "@specwright/schemas";
import {
  recordTraceSpan,
  type TraceSpanStatus
} from "@specwright/trace-recorder";

const CREATED_PHASE = "created";
const RUNTIME_VERSION = "0.1.0";
const DEFAULT_HARNESS_PACKAGE_DIR = fileURLToPath(
  new URL("../../../harnesses/default", import.meta.url)
);
const DEFAULT_HARNESS_IDS = new Set(["default", "specwright.default"]);
const DEFAULT_RUNTIME_TENANT_SCOPE = "local";

export type HarnessPackageReference = string | LoadHarnessPackageOptions;

export type HarnessPackageResolver = (
  input: RunInput
) => HarnessPackageReference | Promise<HarnessPackageReference>;

export type ToolBrokerLike = {
  callTool(
    request: ToolCallRequest | unknown,
    context?: ToolCallContext
  ): Promise<ToolCallResult>;
};

export type RuntimeToolBrokerFactoryInput = {
  runId: string;
  rootDir?: string | undefined;
  workspaceRoot: string;
};

export type RuntimeOptions = {
  rootDir?: string | undefined;
  workspaceRoot?: string | undefined;
  harnessPackages?: Record<string, HarnessPackageReference> | undefined;
  resolveHarnessPackage?: HarnessPackageResolver | undefined;
  loadHarnessPackage?:
    | ((input: HarnessPackageReference) => Promise<HarnessSnapshot>)
    | undefined;
  toolBroker?:
    | ToolBrokerLike
    | ((input: RuntimeToolBrokerFactoryInput) => ToolBrokerLike)
    | undefined;
  createToolBroker?: ((options: ToolBrokerOptions) => ToolBrokerLike) | undefined;
  policyBundle?: ToolBrokerOptions["policyBundle"] | undefined;
  evalRunner?:
    | ((request: RunEvalRequest) => EvalVerdict | Promise<EvalVerdict>)
    | undefined;
  gateEngine?:
    | ((
        request: EvaluateGateRequest
      ) => GateEvaluationResult | Promise<GateEvaluationResult>)
    | undefined;
  tenantScope?: string | undefined;
  now?: (() => Date | string) | undefined;
};

export type RunHandle = {
  runId: string;
  state: RunState;
  harness: HarnessSnapshot;
  events: RuntimeEvent[];
  paths: RunStorePaths;
};

export type RunLookupOptions = {
  rootDir?: string | undefined;
};

export type ReplayResult = {
  state: RunState;
  events: RuntimeEvent[];
};

export type RuntimeToolCallOptions = RunLookupOptions & {
  cwd?: string | undefined;
  traceId?: string | undefined;
  toolContext?: Omit<ToolCallContext, "runId" | "cwd" | "traceId"> | undefined;
};

export type RuntimeRunEvalRequest = string | RunEvalRequest;
export type RuntimeEvaluateGateRequest = string | EvaluateGateRequest;
export type RuntimeReportOptions = RunLookupOptions & {
  tenantScope?: string | undefined;
};
export type RuntimeApprovalDecisionOptions = RunLookupOptions;
export type RuntimeApprovalDecisionResult = {
  decision: ApprovalDecision;
  event: RuntimeEvent;
  state: RunState;
};
export type RuntimeHumanAnswerOptions = RunLookupOptions;
export type RuntimeHumanAnswerResult = {
  answer: HumanAnswerRecordedEventPayload;
  event: RuntimeEvent;
  state: RunState;
};
export type RuntimeNextAction =
  | {
      kind: "approval";
      runId: string;
      approval: ApprovalRequest;
    }
  | {
      kind: "question";
      runId: string;
      question: HumanQuestion;
    }
  | {
      kind: "repair";
      runId: string;
      repairTask: RepairTask;
    }
  | {
      kind: "none";
      runId: string;
      status: RunState["status"];
      phase: string;
    };
export type RuntimeApprovalState = {
  runId: string;
  status: RunState["status"];
  phase: string;
  pendingApprovals: ApprovalRequest[];
  pendingQuestions: HumanQuestion[];
  pendingRepairTasks: RepairTask[];
  nextAction: RuntimeNextAction;
  blocked: boolean;
  resolved: boolean;
};

export type RuntimeApi = {
  startRun(input: RunInput): Promise<RunHandle>;
  getRun(runId: string, options?: RunLookupOptions): Promise<RunState>;
  getNextAction(
    runId: string,
    options?: RunLookupOptions
  ): Promise<RuntimeNextAction>;
  listPendingApprovals(
    runId: string,
    options?: RunLookupOptions
  ): Promise<ApprovalRequest[]>;
  listPendingQuestions(
    runId: string,
    options?: RunLookupOptions
  ): Promise<HumanQuestion[]>;
  resolveApprovalState(
    runId: string,
    options?: RunLookupOptions
  ): Promise<RuntimeApprovalState>;
  getEvents(
    runId: string,
    options?: RunLookupOptions
  ): Promise<RuntimeEvent[]>;
  replay(runId: string, options?: RunLookupOptions): Promise<ReplayResult>;
  callTool(
    runId: string,
    request: ToolCallRequest,
    options?: RuntimeToolCallOptions
  ): Promise<ToolCallResult>;
  runEval(
    runId: string,
    request: RuntimeRunEvalRequest,
    options?: RunLookupOptions
  ): Promise<EvalVerdict>;
  recordEvidence(
    runId: string,
    record: EvidenceRecord,
    options?: RunLookupOptions
  ): Promise<EvidenceRecord>;
  recordArtifact(
    runId: string,
    record: ArtifactRecordInput,
    options?: RunLookupOptions
  ): Promise<ArtifactRecord>;
  recordApproval(
    runId: string,
    decision: ApprovalDecision,
    options?: RuntimeApprovalDecisionOptions
  ): Promise<RuntimeApprovalDecisionResult>;
  recordHumanAnswer(
    runId: string,
    answer: HumanAnswerRecordedEventPayload,
    options?: RuntimeHumanAnswerOptions
  ): Promise<RuntimeHumanAnswerResult>;
  evaluateGate(
    runId: string,
    request: RuntimeEvaluateGateRequest,
    options?: RunLookupOptions
  ): Promise<GateEvaluationResult>;
  generateReport(
    runId: string,
    options?: RuntimeReportOptions
  ): Promise<RunReport>;
  writeRunReport(
    runId: string,
    options?: RuntimeReportOptions
  ): Promise<RunReport>;
};

type OptionalKey<TObject, TKey extends keyof TObject> = {} extends Pick<
  TObject,
  TKey
>
  ? true
  : false;
type CompileTimeAssert<TValue extends true> = TValue;
export type RuntimeApiRecordApprovalRequiredRegression = CompileTimeAssert<
  OptionalKey<RuntimeApi, "recordApproval"> extends false ? true : false
>;
export type RuntimeApiRecordApprovalDefinedRegression = CompileTimeAssert<
  undefined extends RuntimeApi["recordApproval"] ? false : true
>;
export type RuntimeApiHumanLoopProjectionRegression = CompileTimeAssert<
  OptionalKey<RuntimeApi, "getNextAction"> extends false
    ? OptionalKey<RuntimeApi, "recordHumanAnswer"> extends false
      ? OptionalKey<RuntimeApi, "listPendingApprovals"> extends false
        ? OptionalKey<RuntimeApi, "listPendingQuestions"> extends false
          ? OptionalKey<RuntimeApi, "resolveApprovalState"> extends false
            ? true
            : false
          : false
        : false
      : false
    : false
>;

export function createRuntime(options: RuntimeOptions = {}): RuntimeApi {
  const loadHarnessPackage =
    options.loadHarnessPackage ?? loadHarnessPackageWithLoader;
  const runEval = options.evalRunner ?? runEvalWithRunner;
  const evaluateGate = options.gateEngine ?? evaluateGateWithEngine;
  const createToolBroker =
    options.createToolBroker ?? createToolBrokerWithDefaults;
  const runRoots = new Map<string, string | undefined>();

  async function startRun(inputLike: RunInput): Promise<RunHandle> {
    const input = RunInputSchema.parse(inputLike);
    const harnessPackage = await resolveHarnessPackage(input, options);
    const harness = await loadHarnessPackage(harnessPackage);
    const rootDir = rootDirForStart(input, options);
    const firstPhase = firstDeclaredPhase(harness);
    const created = await createRun(
      withTimestamp(
        {
          rootDir,
          input,
          harness: harnessSummary(harness),
          initialPhase: CREATED_PHASE
        },
        options.now
      )
    );
    runRoots.set(created.runId, rootDir);

    const events: RuntimeEvent[] = [created.event];
    const loaded = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId: created.runId,
          type: "harness.loaded",
          payload: {
            harness
          },
          causationId: created.event.id
        },
        options.now
      )
    );

    events.push(loaded.event);

    let state = loaded.state;
    let phaseEnteredEvent: RuntimeEvent | undefined;

    if (firstPhase !== undefined) {
      const entered = await appendEvent(
        withTimestamp(
          {
            rootDir,
            runId: created.runId,
            type: "phase.entered",
            payload: {
              phase: firstPhase,
              reason: "first_declared_phase"
            },
            causationId: loaded.event.id
          },
          options.now
        )
      );

      events.push(entered.event);
      phaseEnteredEvent = entered.event;
      state = entered.state;
    }

    const artifactPhase = firstPhase ?? CREATED_PHASE;
    const taskEvidence = await appendEvidence({
      rootDir,
      runId: created.runId,
      record: taskEvidenceRecord(input, artifactPhase)
    });
    const taskEvidenceEvent = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId: created.runId,
          type: "evidence.recorded",
          payload: {
            evidence: taskEvidence
          },
          causationId: phaseEnteredEvent?.id ?? loaded.event.id
        },
        options.now
      )
    );
    events.push(taskEvidenceEvent.event);

    const runInputArtifact = await appendArtifact({
      rootDir,
      runId: created.runId,
      record: runInputArtifactRecord(input, taskEvidence.id, artifactPhase)
    });
    const runInputArtifactEvent = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId: created.runId,
          type: "artifact.recorded",
          payload: {
            artifact: artifactRefForEvent(runInputArtifact)
          },
          causationId: taskEvidenceEvent.event.id
        },
        options.now
      )
    );
    events.push(runInputArtifactEvent.event);
    state = runInputArtifactEvent.state;

    if (phaseEnteredEvent !== undefined && firstPhase !== undefined) {
      await recordTraceSpan({
        rootDir,
        runId: created.runId,
        runtimeVersion: RUNTIME_VERSION,
        harnessSpecHash: harness.specHash,
        hostAdapter: hostAdapterFromRunInput(input),
        span: {
          kind: "phase",
          name: `phase.${firstPhase}`,
          status: "success",
          startedAt: phaseEnteredEvent.timestamp,
          endedAt: phaseEnteredEvent.timestamp,
          eventIds: [phaseEnteredEvent.id],
          metadata: {
            phaseId: firstPhase
          }
        }
      });
    }

    await writeRunReportWithReports({
      rootDir,
      runId: created.runId,
      tenantScope: tenantScopeForRuntimeReport({}, options)
    });

    return {
      runId: created.runId,
      paths: created.paths,
      harness,
      events,
      state
    };
  }

  async function getRun(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<RunState> {
    return materializeRunState({
      rootDir: rootDirForRun(runId, lookupOptions, options, runRoots),
      runId
    });
  }

  async function getEvents(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<RuntimeEvent[]> {
    return readEvents({
      rootDir: rootDirForRun(runId, lookupOptions, options, runRoots),
      runId
    });
  }

  async function replay(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<ReplayResult> {
    const events = await getEvents(runId, lookupOptions);

    return {
      events,
      state: projectRunState(events)
    };
  }

  async function callTool(
    runId: string,
    request: ToolCallRequest,
    callOptions: RuntimeToolCallOptions = {}
  ): Promise<ToolCallResult> {
    const rootDir = rootDirForRun(runId, callOptions, options, runRoots);
    const before = await replay(runId, { rootDir });
    const runInput = runInputFromEvents(before.events);
    const harness = harnessSnapshotFromEvents(before.events);
    const requested = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "tool.requested",
          payload: {
            request
          }
        },
        options.now
      )
    );
    const broker = resolveToolBroker({
      options,
      createToolBroker,
      runId,
      rootDir,
      workspaceRoot: workspaceRootForToolBroker(
        callOptions,
        options,
        rootDir,
        runInput
      )
    });
    const context = toolContextFor({
      runId,
      request,
      callOptions,
      traceId: callOptions.traceId ?? requested.event.traceId,
      state: before.state,
      rootDir,
      runInput,
      harness
    });
    const result = await broker.callTool(request, context);

    const completed = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: toolResultEventType(result),
          payload: {
            request,
            result
          },
          causationId: requested.event.id,
          traceId: result.provenance.traceId
        },
        options.now
      )
    );

    await recordTraceSpan({
      rootDir,
      runId,
      runtimeVersion: RUNTIME_VERSION,
      harnessSpecHash: before.state.harness.specHash,
      hostAdapter: hostAdapterFromRunInput(runInput),
      span: {
        kind: "tool",
        name: `tool.${request.toolId}`,
        status: traceStatusForToolResult(result.status),
        startedAt: requested.event.timestamp,
        endedAt: completed.event.timestamp,
        eventIds: [requested.event.id, completed.event.id],
        metadata: {
          phaseId: request.requestedBy.phase,
          toolId: result.provenance.toolId,
          toolVersion: result.provenance.toolVersion,
          toolCallId: result.toolCallId,
          toolStatus: result.status,
          cacheStatus: result.provenance.cacheStatus,
          policyStatus: policyStatusForToolResult(result.status),
          ...(result.error === undefined
            ? {}
            : { errorCode: result.error.code })
        }
      }
    });

    return result;
  }

  async function runEvalForRun(
    runId: string,
    requestLike: RuntimeRunEvalRequest,
    lookupOptions: RunLookupOptions = {}
  ): Promise<EvalVerdict> {
    const rootDir = rootDirForRun(runId, lookupOptions, options, runRoots);
    const replayed = await replay(runId, { rootDir });
    const harness = harnessSnapshotFromEvents(replayed.events);
    const request = await normalizeRunEvalRequest(
      requestLike,
      harness,
      rootDir,
      runId
    );
    const verdict = await runEval(request);

    const completed = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "eval.completed",
          payload: {
            evalId: verdict.evalId,
            request,
            verdict
          }
        },
        options.now
      )
    );
    const artifactRecorded = await recordEvalReportArtifact({
      rootDir,
      runId,
      verdict,
      request,
      phase: replayed.state.phase,
      causationId: completed.event.id,
      sequence: completed.event.sequence,
      now: options.now
    });

    await recordTraceSpan({
      rootDir,
      runId,
      runtimeVersion: RUNTIME_VERSION,
      harnessSpecHash: replayed.state.harness.specHash,
      hostAdapter: hostAdapterFromRunInput(runInputFromEvents(replayed.events)),
      span: {
        kind: "eval",
        name: `eval.${verdict.evalId}`,
        status: verdict.status,
        startedAt: completed.event.timestamp,
        endedAt: artifactRecorded.event.timestamp,
        eventIds: [completed.event.id, artifactRecorded.event.id],
        metadata: {
          phaseId: replayed.state.phase,
          evalId: verdict.evalId
        }
      }
    });

    return verdict;
  }

  async function evaluateGateForRun(
    runId: string,
    requestLike: RuntimeEvaluateGateRequest,
    lookupOptions: RunLookupOptions = {}
  ): Promise<GateEvaluationResult> {
    const rootDir = rootDirForRun(runId, lookupOptions, options, runRoots);
    const replayed = await replay(runId, { rootDir });
    const harness = harnessSnapshotFromEvents(replayed.events);
    const request = await normalizeEvaluateGateRequest(
      requestLike,
      harness,
      replayed,
      rootDir,
      runId
    );
    const result = await evaluateGate(request);

    const evaluated = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "gate.evaluated",
          payload: {
            gateId: result.verdict.gateId,
            verdict: result.verdict,
            instruction: result.instruction
          }
        },
        options.now
      )
    );

    let lifecycleEvents: RuntimeEvent[] = [];
    let lifecycleError: Error | undefined;

    try {
      lifecycleEvents = await applyGateLifecycleInstructionForRun({
        rootDir,
        runId,
        instruction: result.instruction,
        currentPhase: replayed.state.phase,
        causationId: evaluated.event.id,
        now: options.now
      });
    } catch (error) {
      lifecycleError = error instanceof Error ? error : new Error(String(error));
    }

    const gateSpanMetadata: Record<string, unknown> = {
      phaseId: result.verdict.phase,
      gateId: result.verdict.gateId,
      instruction: result.instruction.kind,
      lifecycleApplication:
        lifecycleError === undefined
          ? lifecycleEvents.length === 0
            ? "no_op"
            : "applied"
          : "stopped"
    };

    if (lifecycleEvents.length > 0) {
      gateSpanMetadata.lifecycleEventType = lifecycleEvents[0]?.type;
      gateSpanMetadata.lifecycleEventTypes = lifecycleEvents.map(
        (event) => event.type
      );
    }

    if (lifecycleError !== undefined) {
      gateSpanMetadata.lifecycleError = lifecycleError.message;
    }

    await recordTraceSpan({
      rootDir,
      runId,
      runtimeVersion: RUNTIME_VERSION,
      harnessSpecHash: replayed.state.harness.specHash,
      hostAdapter: hostAdapterFromRunInput(runInputFromEvents(replayed.events)),
      span: {
        kind: "gate",
        name: `gate.${result.verdict.gateId}`,
        status: result.verdict.status,
        startedAt: evaluated.event.timestamp,
        endedAt: lifecycleEvents.at(-1)?.timestamp ?? evaluated.event.timestamp,
        eventIds: [
          evaluated.event.id,
          ...lifecycleEvents.map((event) => event.id)
        ],
        metadata: gateSpanMetadata
      }
    });

    if (lifecycleError !== undefined) {
      throw lifecycleError;
    }

    return result;
  }

  async function recordEvidenceForRun(
    runId: string,
    record: EvidenceRecord,
    lookupOptions: RunLookupOptions = {}
  ): Promise<EvidenceRecord> {
    const rootDir = rootDirForRun(runId, lookupOptions, options, runRoots);
    const evidence = await appendEvidence({
      rootDir,
      runId,
      record
    });

    await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "evidence.recorded",
          payload: {
            evidence
          }
        },
        options.now
      )
    );

    return evidence;
  }

  async function recordArtifactForRun(
    runId: string,
    record: ArtifactRecordInput,
    lookupOptions: RunLookupOptions = {}
  ): Promise<ArtifactRecord> {
    const rootDir = rootDirForRun(runId, lookupOptions, options, runRoots);
    const artifact = await appendArtifact({
      rootDir,
      runId,
      record
    });

    await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "artifact.recorded",
          payload: {
            artifact: artifactRefForEvent(artifact)
          }
        },
        options.now
      )
    );

    return artifact;
  }

  async function getNextActionForRun(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<RuntimeNextAction> {
    const state = await getRun(runId, lookupOptions);

    return nextActionFromState(runId, state);
  }

  async function listPendingApprovalsForRun(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<ApprovalRequest[]> {
    const state = await getRun(runId, lookupOptions);

    return state.pendingApprovals;
  }

  async function listPendingQuestionsForRun(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<HumanQuestion[]> {
    const state = await getRun(runId, lookupOptions);

    return state.pendingQuestions;
  }

  async function resolveApprovalStateForRun(
    runId: string,
    lookupOptions: RunLookupOptions = {}
  ): Promise<RuntimeApprovalState> {
    const state = await getRun(runId, lookupOptions);
    const nextAction = nextActionFromState(runId, state);

    return {
      runId,
      status: state.status,
      phase: state.phase,
      pendingApprovals: state.pendingApprovals,
      pendingQuestions: state.pendingQuestions,
      pendingRepairTasks: state.pendingRepairTasks,
      nextAction,
      blocked: state.status === "blocked",
      resolved:
        state.pendingApprovals.length === 0 &&
        state.pendingQuestions.length === 0 &&
        state.pendingRepairTasks.length === 0
    };
  }

  async function recordApprovalForRun(
    runId: string,
    decisionLike: ApprovalDecision,
    lookupOptions: RuntimeApprovalDecisionOptions = {}
  ): Promise<RuntimeApprovalDecisionResult> {
    const decision = ApprovalDecisionSchema.parse(decisionLike);
    const rootDir = rootDirForRun(runId, lookupOptions, options, runRoots);
    const state = await getRun(runId, { rootDir });
    const pendingApproval = state.pendingApprovals.find(
      (approval) => approval.approvalId === decision.approvalId
    );

    if (pendingApproval === undefined) {
      throw new Error(
        `Approval ${decision.approvalId} is not currently pending for run ${runId}`
      );
    }

    const recorded = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "decision.recorded",
          payload: {
            approvalId: decision.approvalId,
            decision
          }
        },
        options.now
      )
    );

    return {
      decision,
      event: recorded.event,
      state: recorded.state
    };
  }

  async function recordHumanAnswerForRun(
    runId: string,
    answerLike: HumanAnswerRecordedEventPayload,
    lookupOptions: RuntimeHumanAnswerOptions = {}
  ): Promise<RuntimeHumanAnswerResult> {
    const answer = HumanAnswerRecordedEventPayloadSchema.parse(answerLike);
    const questionId = answer.questionId ?? answer.humanQuestionId;

    if (questionId === undefined) {
      throw new Error("Human answer must reference a pending question");
    }

    const rootDir = rootDirForRun(runId, lookupOptions, options, runRoots);
    const state = await getRun(runId, { rootDir });
    const pendingQuestion = state.pendingQuestions.find(
      (question) => question.questionId === questionId
    );

    if (pendingQuestion === undefined) {
      throw new Error(
        `Human question ${questionId} is not currently pending for run ${runId}`
      );
    }

    const recorded = await appendEvent(
      withTimestamp(
        {
          rootDir,
          runId,
          type: "human.answer_recorded",
          payload: answer
        },
        options.now
      )
    );

    return {
      answer,
      event: recorded.event,
      state: recorded.state
    };
  }

  async function generateReportForRun(
    runId: string,
    lookupOptions: RuntimeReportOptions = {}
  ): Promise<RunReport> {
    return generateRunReport({
      rootDir: rootDirForRun(runId, lookupOptions, options, runRoots),
      runId,
      tenantScope: tenantScopeForRuntimeReport(lookupOptions, options)
    });
  }

  async function writeRunReportForRun(
    runId: string,
    lookupOptions: RuntimeReportOptions = {}
  ): Promise<RunReport> {
    return writeRunReportWithReports({
      rootDir: rootDirForRun(runId, lookupOptions, options, runRoots),
      runId,
      tenantScope: tenantScopeForRuntimeReport(lookupOptions, options)
    });
  }

  return {
    startRun,
    getRun,
    getNextAction: getNextActionForRun,
    listPendingApprovals: listPendingApprovalsForRun,
    listPendingQuestions: listPendingQuestionsForRun,
    resolveApprovalState: resolveApprovalStateForRun,
    getEvents,
    replay,
    callTool,
    runEval: runEvalForRun,
    recordEvidence: recordEvidenceForRun,
    recordArtifact: recordArtifactForRun,
    recordApproval: recordApprovalForRun,
    recordHumanAnswer: recordHumanAnswerForRun,
    evaluateGate: evaluateGateForRun,
    generateReport: generateReportForRun,
    writeRunReport: writeRunReportForRun
  };
}

export const createRuntimeApi = createRuntime;

function nextActionFromState(runId: string, state: RunState): RuntimeNextAction {
  const approval = state.pendingApprovals[0];

  if (approval !== undefined) {
    return {
      kind: "approval",
      runId,
      approval
    };
  }

  const question = state.pendingQuestions[0];

  if (question !== undefined) {
    return {
      kind: "question",
      runId,
      question
    };
  }

  const repairTask = state.pendingRepairTasks[0];

  if (repairTask !== undefined) {
    return {
      kind: "repair",
      runId,
      repairTask
    };
  }

  return {
    kind: "none",
    runId,
    status: state.status,
    phase: state.phase
  };
}

async function applyGateLifecycleInstructionForRun(input: {
  rootDir: string | undefined;
  runId: string;
  instruction: GateLifecycleInstruction;
  currentPhase: string;
  causationId: string;
  now: RuntimeOptions["now"];
}): Promise<RuntimeEvent[]> {
  const gateReason = gateLifecycleReason(input.instruction.gateId);

  switch (input.instruction.kind) {
    case "continue":
      return [];
    case "transition_phase": {
      const transitioned = await appendEvent(
        withTimestamp(
          {
            rootDir: input.rootDir,
            runId: input.runId,
            type: "phase.transitioned",
            payload: {
              phase: input.instruction.targetPhase,
              fromPhase: input.currentPhase,
              toPhase: input.instruction.targetPhase,
              reason: gateReason
            },
            causationId: input.causationId
          },
          input.now
        )
      );

      return [transitioned.event];
    }
    case "fail_run": {
      const failed = await appendEvent(
        withTimestamp(
          {
            rootDir: input.rootDir,
            runId: input.runId,
            type: "run.failed",
            payload: {
              reason: input.instruction.reason,
              metadata: {
                gateId: input.instruction.gateId,
                gateCausation: gateReason,
                instructionKind: input.instruction.kind
              }
            },
            causationId: input.causationId
          },
          input.now
        )
      );

      return [failed.event];
    }
    case "pause_for_human": {
      const question = humanQuestionFromGateInstruction(input.instruction.question);
      const requested = await appendEvent(
        withTimestamp(
          {
            rootDir: input.rootDir,
            runId: input.runId,
            type: "human.input_requested",
            payload: {
              question
            },
            causationId: input.causationId
          },
          input.now
        )
      );
      const blocked = await appendRunBlockedForGate({
        ...input,
        reason: `Gate ${input.instruction.gateId} is waiting for human input`,
        blockedBy: "human.input_requested",
        metadata: {
          gateId: input.instruction.gateId,
          gateCausation: gateReason,
          instructionKind: input.instruction.kind,
          questionId: question.questionId
        }
      });

      return [requested.event, blocked.event];
    }
    case "request_approval": {
      const approvalRequest = approvalRequestFromGateInstruction(
        input.instruction.approvalRequest
      );
      const requested = await appendEvent(
        withTimestamp(
          {
            rootDir: input.rootDir,
            runId: input.runId,
            type: "approval.requested",
            payload: {
              approvalRequest,
              gateApprovalRequest: input.instruction.approvalRequest,
              metadata: {
                gateId: input.instruction.gateId,
                gateCausation: gateReason,
                instructionKind: input.instruction.kind
              }
            },
            causationId: input.causationId
          },
          input.now
        )
      );
      const blocked = await appendRunBlockedForGate({
        ...input,
        reason: `Gate ${input.instruction.gateId} is waiting for approval`,
        blockedBy: "approval.requested",
        metadata: {
          gateId: input.instruction.gateId,
          gateCausation: gateReason,
          instructionKind: input.instruction.kind,
          approvalId: approvalRequest.approvalId
        }
      });

      return [requested.event, blocked.event];
    }
    case "create_repair_task": {
      const repairTask = input.instruction.repairTask;
      const created = await appendEvent(
        withTimestamp(
          {
            rootDir: input.rootDir,
            runId: input.runId,
            type: "repair.task_created",
            payload: {
              repairTask,
              metadata: {
                gateId: input.instruction.gateId,
                gateCausation: gateReason,
                instructionKind: input.instruction.kind
              }
            },
            causationId: input.causationId
          },
          input.now
        )
      );
      const blocked = await appendRunBlockedForGate({
        ...input,
        reason: `Gate ${input.instruction.gateId} created repair task ${repairTask.id}`,
        blockedBy: "repair.task_created",
        metadata: {
          gateId: input.instruction.gateId,
          gateCausation: gateReason,
          instructionKind: input.instruction.kind,
          repairTaskId: repairTask.id
        }
      });

      return [created.event, blocked.event];
    }
    default: {
      const instruction: never = input.instruction;
      throw new Error(
        `Unsupported gate lifecycle instruction ${(instruction as { kind?: string }).kind ?? "unknown"}`
      );
    }
  }
}

async function appendRunBlockedForGate(input: {
  rootDir: string | undefined;
  runId: string;
  instruction: GateLifecycleInstruction;
  causationId: string;
  now: RuntimeOptions["now"];
  reason: string;
  blockedBy: string;
  metadata: Record<string, unknown>;
}) {
  return appendEvent(
    withTimestamp(
      {
        rootDir: input.rootDir,
        runId: input.runId,
        type: "run.blocked",
        payload: {
          reason: input.reason,
          blockedBy: input.blockedBy,
          metadata: input.metadata
        },
        causationId: input.causationId
      },
      input.now
    )
  );
}

function humanQuestionFromGateInstruction(
  question: Extract<
    GateLifecycleInstruction,
    { kind: "pause_for_human" }
  >["question"]
): HumanQuestion {
  return {
    questionId: question.id,
    prompt: question.question,
    ...(question.subjectRef === undefined ? {} : { subjectRef: question.subjectRef }),
    ...(question.allowedDecisionValues === undefined
      ? {}
      : { allowedDecisionValues: question.allowedDecisionValues }),
    ...(question.requiredExpertise === undefined
      ? {}
      : { requiredExpertise: question.requiredExpertise }),
    requiredFor: question.requiredFor,
    metadata: {
      ...(question.metadata ?? {}),
      gateId: question.gateId,
      phase: question.phase,
      ...(question.expectedAnswerSchema === undefined
        ? {}
        : { expectedAnswerSchema: question.expectedAnswerSchema }),
      ...(question.constraints === undefined ? {} : { constraints: question.constraints }),
      ...(question.comments === undefined ? {} : { comments: question.comments }),
      ...(question.unresolvedQuestions === undefined
        ? {}
        : { unresolvedQuestions: question.unresolvedQuestions }),
      ...(question.causationIds === undefined
        ? {}
        : { causationIds: question.causationIds })
    }
  };
}

function approvalRequestFromGateInstruction(
  request: Extract<
    GateLifecycleInstruction,
    { kind: "request_approval" }
  >["approvalRequest"]
): ApprovalRequest {
  return {
    approvalId: request.id,
    reason: request.reason,
    subjectRef: `gate:${request.gateId}`,
    requestedAction: "gate.approval",
    ...(request.riskSummary === undefined ? {} : { riskSummary: request.riskSummary }),
    ...(request.constraints === undefined ? {} : { constraints: request.constraints }),
    requiredFor: request.requiredFor,
    metadata: {
      ...(request.metadata ?? {}),
      gateId: request.gateId,
      phase: request.phase
    }
  };
}

function gateLifecycleReason(gateId: string) {
  return `gate:${gateId}`;
}

async function resolveHarnessPackage(
  input: RunInput,
  options: RuntimeOptions
): Promise<HarnessPackageReference> {
  if (options.resolveHarnessPackage !== undefined) {
    return options.resolveHarnessPackage(input);
  }

  const mappedPackage = options.harnessPackages?.[input.harnessId];

  if (mappedPackage !== undefined) {
    return mappedPackage;
  }

  if (DEFAULT_HARNESS_IDS.has(input.harnessId)) {
    return {
      packageDir: DEFAULT_HARNESS_PACKAGE_DIR
    };
  }

  return input.harnessId;
}

function rootDirForStart(input: RunInput, options: RuntimeOptions) {
  return options.rootDir ?? input.cwd;
}

function rootDirForRun(
  runId: string,
  lookupOptions: RunLookupOptions,
  options: RuntimeOptions,
  runRoots: ReadonlyMap<string, string | undefined>
) {
  return lookupOptions.rootDir ?? runRoots.get(runId) ?? options.rootDir;
}

function tenantScopeForRuntimeReport(
  lookupOptions: RuntimeReportOptions,
  options: RuntimeOptions
) {
  return (
    lookupOptions.tenantScope ??
    options.tenantScope ??
    DEFAULT_RUNTIME_TENANT_SCOPE
  );
}

function firstDeclaredPhase(harness: HarnessSnapshot) {
  return harness.phases[0]?.id;
}

function harnessSummary(harness: HarnessSnapshot): RunState["harness"] {
  return {
    id: harness.id,
    version: harness.version,
    specHash: harness.specHash
  };
}

function resolveToolBroker(input: {
  options: RuntimeOptions;
  createToolBroker: (options: ToolBrokerOptions) => ToolBrokerLike;
  runId: string;
  rootDir?: string | undefined;
  workspaceRoot: string;
}) {
  if (typeof input.options.toolBroker === "function") {
    return input.options.toolBroker({
      runId: input.runId,
      rootDir: input.rootDir,
      workspaceRoot: input.workspaceRoot
    });
  }

  if (input.options.toolBroker !== undefined) {
    return input.options.toolBroker;
  }

  const brokerOptions: ToolBrokerOptions = {
    workspaceRoot: input.workspaceRoot,
    runId: input.runId
  };

  if (input.options.policyBundle !== undefined) {
    brokerOptions.policyBundle = input.options.policyBundle;
  }

  return input.createToolBroker(brokerOptions);
}

function workspaceRootForToolBroker(
  callOptions: RuntimeToolCallOptions,
  options: RuntimeOptions,
  rootDir: string | undefined,
  runInput: RunInput | undefined
) {
  return (
    options.workspaceRoot ??
    rootDir ??
    runInput?.cwd ??
    callOptions.cwd ??
    "."
  );
}

function toolContextFor(input: {
  runId: string;
  request: ToolCallRequest;
  callOptions: RuntimeToolCallOptions;
  traceId: string;
  state: RunState;
  rootDir?: string | undefined;
  runInput?: RunInput | undefined;
  harness?: HarnessSnapshot | undefined;
}): ToolCallContext {
  const baseContext = input.callOptions.toolContext ?? {};
  const harnessPolicies = input.harness?.policies;
  const context: ToolCallContext = {
    ...baseContext,
    runId: input.runId,
    cwd: input.callOptions.cwd ?? input.runInput?.cwd ?? input.rootDir ?? ".",
    traceId: input.traceId,
    snapshots: {
      ...(baseContext.snapshots ?? {}),
      runState: input.state
    }
  };

  const harnessPolicy = harnessPolicies as
    | ToolBrokerOptions["policyBundle"]
    | undefined;
  const policyBundle = baseContext.policyBundle ?? harnessPolicy;

  if (policyBundle !== undefined) {
    context.policyBundle = policyBundle;
  }

  if (harnessPolicies !== undefined) {
    context.snapshots = {
      ...(context.snapshots ?? {}),
      harnessPolicy: harnessPolicies
    };
  }

  if (baseContext.runMode !== undefined) {
    context.runMode = baseContext.runMode;
  }

  return context;
}

function toolResultEventType(result: ToolCallResult) {
  return result.status === "denied" ? "tool.denied" : "tool.completed";
}

async function normalizeRunEvalRequest(
  requestLike: RuntimeRunEvalRequest,
  harness: HarnessSnapshot | undefined,
  rootDir: string | undefined,
  runId: string
): Promise<RunEvalRequest> {
  const request: RunEvalRequest =
    typeof requestLike === "string"
      ? {
          evalId: requestLike
        }
      : {
          ...requestLike
        };

  if (
    harness !== undefined &&
    request.evalDefinition === undefined &&
    request.evalDefinitions === undefined
  ) {
    request.evalDefinitions = harness.evals as FixtureEvalDefinition[];
  }

  const storeInput = await evalInputFromStores(rootDir, runId);
  request.input = {
    ...storeInput,
    ...(request.input ?? {}),
    artifacts: request.input?.artifacts ?? storeInput.artifacts,
    evidence: request.input?.evidence ?? storeInput.evidence
  };

  return request;
}

async function normalizeEvaluateGateRequest(
  requestLike: RuntimeEvaluateGateRequest,
  harness: HarnessSnapshot | undefined,
  replayed: ReplayResult,
  rootDir: string | undefined,
  runId: string
): Promise<EvaluateGateRequest> {
  const request: EvaluateGateRequest =
    typeof requestLike === "string"
      ? {
          gateId: requestLike
        }
      : {
          ...requestLike
        };
  const baseInput = await gateEvaluationInputFromStores(rootDir, runId, replayed);

  if (request.phase === undefined) {
    request.phase = request.input?.phase ?? replayed.state.phase;
  }

  request.input = {
    ...baseInput,
    ...(request.input ?? {})
  };

  if (
    harness !== undefined &&
    request.gateDefinition === undefined &&
    request.gateDefinitions === undefined
  ) {
    request.gateDefinitions = harness.gates as FixtureGateDefinition[];
  }

  return request;
}

async function gateEvaluationInputFromStores(
  rootDir: string | undefined,
  runId: string,
  replayed: ReplayResult
): Promise<GateEvaluationInput> {
  const [artifacts, evidenceRecords] = await Promise.all([
    listArtifacts({
      rootDir,
      runId
    }),
    listEvidence({
      rootDir,
      runId
    })
  ]);
  const input: GateEvaluationInput = {
    runId: replayed.state.runId,
    phase: replayed.state.phase,
    runInput: recordFromUnknown(runInputFromEvents(replayed.events)),
    artifacts: Object.fromEntries(
      artifacts.map((artifact) => [artifact.artifactId, artifact])
    ),
    evidence: {
      records: evidenceRecords,
      refs: Object.fromEntries(
        evidenceRecords.map((record) => [record.id, record])
      )
    },
    evals: evalVerdictsFromEvents(replayed.events)
  };

  return input;
}

function artifactsForGateInput(state: RunState) {
  const artifacts: Record<string, GateArtifactSnapshot> = {};

  for (const artifact of state.artifacts) {
    const snapshot: GateArtifactSnapshot = {
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType
    };

    if (artifact.uri !== undefined) {
      snapshot.uri = artifact.uri;
    }

    if (artifact.metadata !== undefined) {
      snapshot.metadata = artifact.metadata;
    }

    if (artifact.evidenceRefs !== undefined) {
      snapshot.evidenceRefs = artifact.evidenceRefs;
    }

    artifacts[artifact.artifactId] = snapshot;
  }

  return artifacts;
}

async function evalInputFromStores(
  rootDir: string | undefined,
  runId: string
): Promise<NonNullable<RunEvalRequest["input"]>> {
  const artifacts = await listArtifacts({
    rootDir,
    runId
  });
  const evidenceRecords = await listEvidence({
    rootDir,
    runId
  });

  return {
    artifacts,
    evidence: {
      records: evidenceRecords,
      refs: Object.fromEntries(
        evidenceRecords.map((record) => [record.id, record])
      )
    }
  };
}

function taskEvidenceRecord(input: RunInput, phase: string): EvidenceRecord {
  return {
    id: "evidence:user:task",
    class: "source_fact",
    claim: `Original user task: ${input.task}`,
    sourceRefs: [
      {
        id: "run-input.task",
        uri: "artifacts/run-input.json",
        locator: "task",
        authority: "user",
        redactionClass: "operator"
      }
    ],
    confidence: "high",
    authority: "user",
    redactionPolicy: "operator",
    createdBy: {
      phase,
      actionId: "start-run"
    }
  };
}

function runInputArtifactRecord(
  input: RunInput,
  taskEvidenceId: string,
  phase: string
): ArtifactRecordInput {
  return {
    artifactId: "run-input",
    artifactType: "run-input",
    content: input,
    evidenceRefs: [taskEvidenceId],
    claimLevel: "source_fact",
    producedBy: {
      phase,
      actionId: "start-run"
    },
    metadata: {
      canonicalName: "run-input.json"
    }
  };
}

async function recordEvalReportArtifact(input: {
  rootDir: string | undefined;
  runId: string;
  verdict: EvalVerdict;
  request: RunEvalRequest;
  phase: string;
  causationId: string;
  sequence: number;
  now: RuntimeOptions["now"];
}) {
  const safeEvalId = safeIdSegment(input.verdict.evalId);
  const artifactId = `eval-report-${safeEvalId}-${input.sequence}`;
  const artifact = await appendArtifact({
    rootDir: input.rootDir,
    runId: input.runId,
    record: {
      artifactId,
      artifactType: "eval-report",
      content: {
        evals: [input.verdict],
        request: input.request
      },
      fileRef: {
        uri: `artifacts/${artifactId}.json`
      },
      evidenceRefs: input.verdict.evidenceRefs,
      producedBy: {
        phase: input.phase,
        actionId: `run-eval:${input.verdict.evalId}`
      },
      metadata: {
        evalId: input.verdict.evalId,
        status: input.verdict.status,
        targetRef: input.verdict.targetRef
      }
    }
  });

  return appendEvent(
    withTimestamp(
      {
        rootDir: input.rootDir,
        runId: input.runId,
        type: "artifact.recorded",
        payload: {
          artifact: artifactRefForEvent(artifact)
        },
        causationId: input.causationId
      },
      input.now
    )
  );
}

function artifactRefForEvent(record: {
  artifactId: string;
  artifactType: string;
  evidenceRefs: string[];
  fileRef?: { uri: string } | undefined;
  metadata?: Record<string, unknown> | undefined;
}) {
  return {
    artifactId: record.artifactId,
    artifactType: record.artifactType,
    evidenceRefs: record.evidenceRefs,
    ...(record.fileRef === undefined ? {} : { uri: record.fileRef.uri }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata })
  };
}

function traceStatusForToolResult(
  status: ToolCallResult["status"]
): TraceSpanStatus {
  return status;
}

function policyStatusForToolResult(status: ToolCallResult["status"]) {
  switch (status) {
    case "success":
      return "allow";
    case "denied":
      return "deny";
    case "approval_required":
      return "approval_required";
    case "failed":
      return "failed";
  }
}

function hostAdapterFromRunInput(input: RunInput | undefined) {
  if (input === undefined) {
    return undefined;
  }

  return input.host.version === undefined
    ? input.host.kind
    : `${input.host.kind}@${input.host.version}`;
}

function safeIdSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function harnessSnapshotFromEvents(
  events: readonly RuntimeEvent[]
): HarnessSnapshot | undefined {
  for (const event of events) {
    if (event.type !== "harness.loaded") {
      continue;
    }

    const payload = recordFromUnknown(event.payload);
    const parsed = HarnessSnapshotSchema.safeParse(
      payload.harness ?? event.payload
    );

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function runInputFromEvents(events: readonly RuntimeEvent[]) {
  const started = events.find((event) => event.type === "run.started");

  if (started === undefined) {
    return undefined;
  }

  const payload = recordFromUnknown(started.payload);
  const parsed = RunInputSchema.safeParse(payload.input);

  return parsed.success ? parsed.data : undefined;
}

function evalVerdictsFromEvents(events: readonly RuntimeEvent[]) {
  const verdicts: Record<string, EvalVerdict> = {};

  for (const event of events) {
    if (event.type !== "eval.completed") {
      continue;
    }

    const payload = recordFromUnknown(event.payload);
    const candidates = [payload.verdict, payload.result, event.payload];

    for (const candidate of candidates) {
      const parsed = EvalVerdictSchema.safeParse(candidate);

      if (parsed.success) {
        verdicts[parsed.data.evalId] = parsed.data;
        break;
      }
    }
  }

  return verdicts;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withTimestamp<TValue extends object>(
  value: TValue,
  now: RuntimeOptions["now"]
): TValue | (TValue & { timestamp: Date | string }) {
  const timestamp = now?.();

  return timestamp === undefined
    ? value
    : {
        ...value,
        timestamp
      };
}
