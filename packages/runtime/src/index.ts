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
  type GateEvaluationResult
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
  RunInputSchema,
  type ArtifactRecord,
  type EvalVerdict,
  type EvidenceRecord,
  type HarnessSnapshot,
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

export type RuntimeApi = {
  startRun(input: RunInput): Promise<RunHandle>;
  getRun(runId: string, options?: RunLookupOptions): Promise<RunState>;
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
        endedAt: evaluated.event.timestamp,
        eventIds: [evaluated.event.id],
        metadata: {
          phaseId: result.verdict.phase,
          gateId: result.verdict.gateId,
          instruction: result.instruction.kind
        }
      }
    });

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
    getEvents,
    replay,
    callTool,
    runEval: runEvalForRun,
    recordEvidence: recordEvidenceForRun,
    recordArtifact: recordArtifactForRun,
    evaluateGate: evaluateGateForRun,
    generateReport: generateReportForRun,
    writeRunReport: writeRunReportForRun
  };
}

export const createRuntimeApi = createRuntime;

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
