declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): {
      digest(encoding: "hex"): string;
    };
  };
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApprovalRequestSchema,
  ArtifactRefSchema,
  HumanQuestionSchema,
  RunInputSchema,
  RunStateSchema,
  RuntimeEventSchema,
  runtimeEventContractForType,
  type ApprovalRequest,
  type ArtifactRef,
  type HumanQuestion,
  type RunInput,
  type RunState,
  type RuntimeEvent,
  type RuntimeEventIntegrity
} from "@specwright/schemas";

export const RUN_STORE_DIR = ".archetype";
export const RUNS_DIR = "runs";
export const EVENTS_FILE = "events.jsonl";
export const STATE_FILE = "state.json";
export const TRACE_FILE = "trace.json";
export const DECISIONS_FILE = "decisions.jsonl";
export const SUMMARY_FILE = "summary.md";
export const CHECKPOINT_FILE = "state.checkpoint.json";
export const RUN_STATE_CHECKPOINT_VERSION = 1;
export const CHECKPOINT_INTERVAL = 128;

export type RunStoreErrorCode =
  | "corrupt_event"
  | "invalid_event"
  | "invalid_event_payload"
  | "integrity_broken"
  | "invalid_projection"
  | "invalid_run_id"
  | "invalid_sequence"
  | "missing_events"
  | "run_exists"
  | "run_not_started"
  | "unknown_event_contract"
  | "unsupported_event_version";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;

  constructor(code: RunStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type RunStorePaths = {
  rootDir: string;
  runsDir: string;
  runDir: string;
  eventsPath: string;
  statePath: string;
  tracePath: string;
  decisionsPath: string;
  artifactsDir: string;
  evidenceDir: string;
  cacheDir: string;
  checkpointPath: string;
  evalsDir: string;
  summaryPath: string;
};

export type HarnessSnapshot = RunState["harness"];

export type CreateRunOptions = {
  rootDir?: string | undefined;
  runId?: string;
  traceId?: string;
  input: RunInput;
  harness: HarnessSnapshot;
  initialPhase?: string;
  initialBudgets?: RunState["budgets"];
  timestamp?: Date | string;
};

export type RunStartedPayload = {
  input: RunInput;
  harness: HarnessSnapshot;
  initialPhase: string;
  budgets: RunState["budgets"];
};

export type AppendEventOptions<TPayload = unknown> = {
  rootDir?: string | undefined;
  runId: string;
  type: string;
  payload: TPayload;
  id?: string;
  traceId?: string;
  causationId?: string;
  correlationId?: string;
  timestamp?: Date | string;
};

export type CreateRunResult = {
  runId: string;
  paths: RunStorePaths;
  event: RuntimeEvent;
  state: RunState;
};

export type AppendEventResult = {
  event: RuntimeEvent;
  state: RunState;
};

export type RunStateCheckpoint = {
  checkpointVersion: number;
  runId: string;
  coveredSequence: number;
  coveredLastEventId: string;
  state: RunState;
  coveredHeadHash?: string;
};

export type RebuildFromCheckpointResult = {
  state: RunState;
  usedCheckpoint: boolean;
  reducedEventCount: number;
};

export const EVENT_INTEGRITY_ALGO = "sha256";
export const EVENT_INTEGRITY_HASH_PREFIX = `${EVENT_INTEGRITY_ALGO}:`;
export const EVENT_INTEGRITY_GENESIS_SEED = `${EVENT_INTEGRITY_HASH_PREFIX}${"0".repeat(64)}`;

export type RunIntegrityDefectCode =
  | RunStoreErrorCode
  | "integrity_algo_mismatch"
  | "integrity_hash_mismatch"
  | "integrity_missing"
  | "integrity_partial_chain"
  | "integrity_prev_hash_mismatch";

export type RunIntegrityVerdict =
  | {
      status: "verified";
      eventCount: number;
      headHash: string;
    }
  | {
      status: "unchained";
      eventCount: number;
    }
  | {
      status: "broken";
      eventCount: number;
      brokenAtSequence: number;
      code: RunIntegrityDefectCode;
      detail: string;
    };

export function getRunStorePaths(rootDir: string | undefined, runId: string) {
  const safeRunId = assertSafeRunId(runId);
  const absoluteRoot = resolve(rootDir ?? ".");
  const runsDir = join(absoluteRoot, RUN_STORE_DIR, RUNS_DIR);
  const runDir = join(runsDir, safeRunId);

  return {
    rootDir: absoluteRoot,
    runsDir,
    runDir,
    eventsPath: join(runDir, EVENTS_FILE),
    statePath: join(runDir, STATE_FILE),
    tracePath: join(runDir, TRACE_FILE),
    decisionsPath: join(runDir, DECISIONS_FILE),
    artifactsDir: join(runDir, "artifacts"),
    evidenceDir: join(runDir, "evidence"),
    cacheDir: join(runDir, "cache"),
    checkpointPath: join(runDir, "cache", CHECKPOINT_FILE),
    evalsDir: join(runDir, "evals"),
    summaryPath: join(runDir, SUMMARY_FILE)
  } satisfies RunStorePaths;
}

export async function createRun(
  options: CreateRunOptions
): Promise<CreateRunResult> {
  const runId = assertSafeRunId(options.runId ?? randomUUID());
  const traceId = nonEmpty(options.traceId, "traceId") ?? randomUUID();
  const input = RunInputSchema.parse(options.input);
  const harness = assertHarnessSnapshot(options.harness);
  const initialPhase =
    nonEmpty(options.initialPhase, "initialPhase") ?? "created";
  const budgets = RunStateSchema.shape.budgets.parse(
    options.initialBudgets ?? {}
  );
  const paths = getRunStorePaths(options.rootDir, runId);

  await mkdir(paths.runsDir, { recursive: true });
  await createRunDirectory(paths);

  await Promise.all([
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.evidenceDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.evalsDir, { recursive: true })
  ]);
  await Promise.all([
    writeFile(paths.eventsPath, "", { flag: "wx" }),
    writeFile(paths.decisionsPath, "", { flag: "wx" }),
    writeJsonAtomic(paths.tracePath, {
      runId,
      traceId
    }),
    writeFile(paths.summaryPath, "", { flag: "wx" })
  ]);

  const payload: RunStartedPayload = {
    input,
    harness,
    initialPhase,
    budgets
  };
  const event = withIntegrity(
    buildEvent({
      runId,
      type: "run.started",
      payload,
      traceId,
      timestamp: options.timestamp,
      sequence: 0
    }),
    EVENT_INTEGRITY_GENESIS_SEED
  );
  const state = projectRunState([event]);

  await appendJsonLine(paths.eventsPath, event);
  await writeProjection(paths, state);

  return {
    runId,
    paths,
    event,
    state
  };
}

export async function appendEvent<TPayload>(
  options: AppendEventOptions<TPayload>
): Promise<AppendEventResult> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const existingEvents = await readEvents({
    rootDir: options.rootDir,
    runId
  });
  const existingIntegrity = verifyParsedRunIntegrity(existingEvents);

  if (existingIntegrity.status === "broken") {
    throw integrityBrokenError(runId, existingIntegrity);
  }

  const lastEvent = existingEvents.at(-1);
  const builtEvent = buildEvent({
    id: options.id,
    runId,
    type: options.type,
    payload: options.payload,
    traceId: options.traceId ?? lastEvent?.traceId,
    causationId: options.causationId,
    correlationId: options.correlationId,
    timestamp: options.timestamp,
    sequence: existingEvents.length
  });
  const event =
    existingIntegrity.status === "verified"
      ? withIntegrity(builtEvent, existingIntegrity.headHash)
      : builtEvent;
  const events = [...existingEvents, event];
  const updatedIntegrity = verifyParsedRunIntegrity(events);
  const { state } = await rebuildStateFromCheckpoint({
    paths,
    runId,
    events,
    integrity: updatedIntegrity
  });

  await appendJsonLine(paths.eventsPath, event);
  await writeProjection(paths, state);
  await refreshCheckpointAfterAppend(paths, events, updatedIntegrity, state);

  return {
    event,
    state
  };
}

export async function readEvents(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RuntimeEvent[]> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  let raw: string;

  try {
    raw = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    throw new RunStoreError(
      "missing_events",
      `Missing event log for run ${runId}`,
      error
    );
  }

  return parseEventLog(raw, runId);
}

export async function verifyRunIntegrity(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RunIntegrityVerdict> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  let raw: string;

  try {
    raw = await readFile(paths.eventsPath, "utf8");
  } catch (error) {
    return brokenIntegrityVerdict({
      eventCount: 0,
      brokenAtSequence: 0,
      code: "missing_events",
      detail: `Missing event log for run ${runId}`,
      cause: error
    });
  }

  return verifyRawEventLogIntegrity(raw, runId);
}

export function parseEventLog(raw: string, expectedRunId?: string) {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((line, index) => parseEventLine(line, index, expectedRunId));
}

function verifyRawEventLogIntegrity(
  raw: string,
  expectedRunId: string
): RunIntegrityVerdict {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  const events: RuntimeEvent[] = [];

  for (const [index, line] of lines.entries()) {
    try {
      events.push(parseEventLine(line, index, expectedRunId));
    } catch (error) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: index,
        code: error instanceof RunStoreError ? error.code : "corrupt_event",
        detail:
          error instanceof Error
            ? error.message
            : `Invalid event at sequence ${index}`,
        cause: error
      });
    }
  }

  return verifyParsedRunIntegrity(events);
}

export async function materializeRunState(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RunState> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const rebuilt = await rebuildFromCheckpoint({
    rootDir: options.rootDir,
    runId
  });

  await writeProjection(paths, rebuilt.state);

  return rebuilt.state;
}

export const replayRunState = materializeRunState;

export async function rebuildFromCheckpoint(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RebuildFromCheckpointResult> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const integrity = await verifyRunIntegrity({
    rootDir: options.rootDir,
    runId
  });

  if (integrity.status === "broken") {
    throw integrityBrokenError(runId, integrity);
  }

  const events = await readEvents({
    rootDir: options.rootDir,
    runId
  });

  return rebuildStateFromCheckpoint({
    paths,
    runId,
    events,
    integrity
  });
}

export async function writeCheckpoint(
  paths: RunStorePaths,
  checkpoint: RunStateCheckpoint
) {
  const parsed = parseCheckpointRecord(checkpoint);

  if (parsed === undefined) {
    throw new RunStoreError(
      "invalid_projection",
      "Run state checkpoint does not match checkpoint requirements"
    );
  }

  await mkdir(paths.cacheDir, { recursive: true });
  await writeJsonAtomic(paths.checkpointPath, parsed);
}

export async function readCheckpoint(
  paths: RunStorePaths
): Promise<RunStateCheckpoint | undefined> {
  let raw: string;

  try {
    raw = await readFile(paths.checkpointPath, "utf8");
  } catch {
    return undefined;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }

  return parseCheckpointRecord(parsedJson);
}

export function projectRunState(events: readonly RuntimeEvent[]): RunState {
  if (events.length === 0) {
    throw new RunStoreError(
      "run_not_started",
      "Cannot project run state without events"
    );
  }

  validateEventSequence(events);

  const started = events[0];

  if (started === undefined || started.type !== "run.started") {
    throw new RunStoreError(
      "run_not_started",
      "The first run event must be run.started"
    );
  }

  const startedPayload = parseRunStartedPayload(started.payload);
  const runId = started.runId;
  const state: RunState = {
    runId,
    status: "running",
    phase: startedPayload.initialPhase,
    harness: startedPayload.harness,
    budgets: startedPayload.budgets,
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    lastEventId: started.id
  };

  for (const event of events) {
    if (event.runId !== runId) {
      throw new RunStoreError(
        "invalid_event",
        `Event ${event.id} belongs to ${event.runId}, expected ${runId}`
      );
    }

    reduceEvent(state, event);
    state.lastEventId = event.id;
  }

  const parsed = RunStateSchema.safeParse(state);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_projection",
      "Projected run state does not match RunState schema",
      parsed.error
    );
  }

  return parsed.data;
}

async function rebuildStateFromCheckpoint(input: {
  paths: RunStorePaths;
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: RunIntegrityVerdict;
}): Promise<RebuildFromCheckpointResult> {
  if (input.integrity.status === "broken") {
    throw integrityBrokenError(input.runId, input.integrity);
  }

  const checkpoint = await readCheckpoint(input.paths);
  const checkpointState = rebuildFromTrustedCheckpoint({
    runId: input.runId,
    events: input.events,
    integrity: input.integrity,
    checkpoint
  });

  if (checkpointState !== undefined) {
    return checkpointState;
  }

  return {
    state: projectRunState(input.events),
    usedCheckpoint: false,
    reducedEventCount: input.events.length
  };
}

function rebuildFromTrustedCheckpoint(input: {
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: Exclude<RunIntegrityVerdict, { status: "broken" }>;
  checkpoint: RunStateCheckpoint | undefined;
}): RebuildFromCheckpointResult | undefined {
  const { checkpoint } = input;

  if (
    checkpoint === undefined ||
    !checkpointMatchesLedger({
      runId: input.runId,
      events: input.events,
      integrity: input.integrity,
      checkpoint
    })
  ) {
    return undefined;
  }

  const state = cloneRunState(checkpoint.state);
  const tail = input.events.slice(checkpoint.coveredSequence + 1);

  /*
   * Correctness basis for checkpointing:
   * reduceEvent is pure over the prior RunState and the next event, and its
   * collection updates are idempotent-by-key. A checkpoint is therefore only a
   * cached prefix projection; replaying the verified tail must yield the same
   * result as reducing the complete ledger from sequence zero.
   */
  for (const event of tail) {
    if (event.runId !== input.runId) {
      return undefined;
    }

    reduceEvent(state, event);
    state.lastEventId = event.id;
  }

  const parsed = RunStateSchema.safeParse(state);

  if (!parsed.success) {
    return undefined;
  }

  return {
    state: parsed.data,
    usedCheckpoint: true,
    reducedEventCount: tail.length
  };
}

function checkpointMatchesLedger(input: {
  runId: string;
  events: readonly RuntimeEvent[];
  integrity: Exclude<RunIntegrityVerdict, { status: "broken" }>;
  checkpoint: RunStateCheckpoint;
}) {
  const { checkpoint, events, integrity } = input;

  if (checkpoint.runId !== input.runId || checkpoint.state.runId !== input.runId) {
    return false;
  }

  if (checkpoint.coveredSequence >= events.length) {
    return false;
  }

  const coveredEvent = events[checkpoint.coveredSequence];

  if (
    coveredEvent === undefined ||
    coveredEvent.id !== checkpoint.coveredLastEventId
  ) {
    return false;
  }

  if (integrity.status === "verified") {
    return (
      coveredEvent.integrity !== undefined &&
      checkpoint.coveredHeadHash === coveredEvent.integrity.hash
    );
  }

  return checkpoint.coveredHeadHash === undefined;
}

async function refreshCheckpointAfterAppend(
  paths: RunStorePaths,
  events: readonly RuntimeEvent[],
  integrity: RunIntegrityVerdict,
  state: RunState
) {
  const coveredSequence = events.length - 1;

  if (
    coveredSequence < 0 ||
    coveredSequence % CHECKPOINT_INTERVAL !== 0 ||
    integrity.status === "broken"
  ) {
    return;
  }

  const coveredEvent = events[coveredSequence];

  if (coveredEvent === undefined) {
    return;
  }

  const checkpoint: RunStateCheckpoint = {
    checkpointVersion: RUN_STATE_CHECKPOINT_VERSION,
    runId: coveredEvent.runId,
    coveredSequence,
    coveredLastEventId: coveredEvent.id,
    state,
    ...(integrity.status === "verified"
      ? { coveredHeadHash: integrity.headHash }
      : {})
  };

  try {
    await writeCheckpoint(paths, checkpoint);
  } catch {
    return;
  }
}

function parseCheckpointRecord(value: unknown): RunStateCheckpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.checkpointVersion !== RUN_STATE_CHECKPOINT_VERSION) {
    return undefined;
  }

  if (typeof value.runId !== "string" || value.runId.length === 0) {
    return undefined;
  }

  if (
    typeof value.coveredSequence !== "number" ||
    !Number.isInteger(value.coveredSequence) ||
    value.coveredSequence < 0
  ) {
    return undefined;
  }

  if (
    typeof value.coveredLastEventId !== "string" ||
    value.coveredLastEventId.length === 0
  ) {
    return undefined;
  }

  if (
    value.coveredHeadHash !== undefined &&
    (typeof value.coveredHeadHash !== "string" ||
      value.coveredHeadHash.length === 0)
  ) {
    return undefined;
  }

  const state = RunStateSchema.safeParse(value.state);

  if (
    !state.success ||
    state.data.runId !== value.runId ||
    state.data.lastEventId !== value.coveredLastEventId
  ) {
    return undefined;
  }

  return {
    checkpointVersion: RUN_STATE_CHECKPOINT_VERSION,
    runId: value.runId,
    coveredSequence: value.coveredSequence,
    coveredLastEventId: value.coveredLastEventId,
    state: state.data,
    ...(value.coveredHeadHash === undefined
      ? {}
      : { coveredHeadHash: value.coveredHeadHash })
  };
}

function cloneRunState(state: RunState): RunState {
  return RunStateSchema.parse(JSON.parse(JSON.stringify(state)) as unknown);
}

function reduceEvent(state: RunState, event: RuntimeEvent) {
  switch (event.type) {
    case "run.started":
      return;
    case "phase.entered":
    case "phase.transitioned": {
      const phase = getPayloadString(event.payload, [
        "phase",
        "toPhase",
        "to"
      ]);

      if (phase !== undefined) {
        state.phase = phase;
      }

      return;
    }
    case "artifact.recorded": {
      const artifact = parseNestedArtifact(event.payload);

      if (artifact !== undefined) {
        state.artifacts = upsertByKey(
          state.artifacts,
          artifact,
          "artifactId"
        );
      }

      return;
    }
    case "human.input_requested": {
      const question = parseNestedQuestion(event.payload);

      if (question !== undefined) {
        state.pendingQuestions = upsertByKey(
          state.pendingQuestions,
          question,
          "questionId"
        );
      }

      return;
    }
    case "human.answer_recorded": {
      const questionId = getPayloadString(event.payload, [
        "questionId",
        "humanQuestionId"
      ]);

      if (questionId !== undefined) {
        state.pendingQuestions = state.pendingQuestions.filter(
          (question) => question.questionId !== questionId
        );
      }

      return;
    }
    case "policy.evaluated": {
      const approval = parseNestedApprovalRequest(event.payload);

      if (approval !== undefined) {
        state.pendingApprovals = upsertByKey(
          state.pendingApprovals,
          approval,
          "approvalId"
        );
      }

      return;
    }
    case "tool.authorized":
    case "tool.denied":
    case "decision.recorded": {
      const approvalId = getPayloadString(event.payload, ["approvalId"]);

      if (approvalId !== undefined) {
        state.pendingApprovals = state.pendingApprovals.filter(
          (approval) => approval.approvalId !== approvalId
        );
      }

      return;
    }
    case "run.completed":
      state.status = "completed";
      return;
    case "run.failed":
      state.status = "failed";
      return;
    default:
      return;
  }
}

function parseEventLine(
  line: string,
  index: number,
  expectedRunId: string | undefined
) {
  if (line.trim() === "") {
    throw new RunStoreError(
      "corrupt_event",
      `Blank JSONL event at line ${index + 1}`
    );
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(line) as unknown;
  } catch (error) {
    throw new RunStoreError(
      "corrupt_event",
      `Invalid JSON at event log line ${index + 1}`,
      error
    );
  }

  const event = parseRuntimeEvent(parsedJson, index);

  if (!("payload" in event)) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} is missing payload`
    );
  }

  if (expectedRunId !== undefined && event.runId !== expectedRunId) {
    throw new RunStoreError(
      "invalid_event",
      `Event at line ${index + 1} belongs to ${event.runId}, expected ${expectedRunId}`
    );
  }

  if (event.sequence !== index) {
    throw new RunStoreError(
      "invalid_sequence",
      `Event at line ${index + 1} has sequence ${event.sequence}, expected ${index}`
    );
  }

  return event;
}

function validateEventSequence(events: readonly RuntimeEvent[]) {
  events.forEach((event, index) => {
    if (event.sequence !== index) {
      throw new RunStoreError(
        "invalid_sequence",
        `Event ${event.id} has sequence ${event.sequence}, expected ${index}`
      );
    }
  });
}

function verifyParsedRunIntegrity(
  events: readonly RuntimeEvent[]
): RunIntegrityVerdict {
  if (events.length === 0) {
    return brokenIntegrityVerdict({
      eventCount: 0,
      brokenAtSequence: 0,
      code: "run_not_started",
      detail: "Cannot verify integrity without events"
    });
  }

  const firstChainedIndex = events.findIndex(
    (event) => event.integrity !== undefined
  );

  if (firstChainedIndex === -1) {
    return {
      status: "unchained",
      eventCount: events.length
    };
  }

  if (firstChainedIndex > 0) {
    return brokenIntegrityVerdict({
      eventCount: events.length,
      brokenAtSequence: firstChainedIndex,
      code: "integrity_partial_chain",
      detail:
        "Ledger carries integrity after an unchained legacy prefix; partial chains are not trusted"
    });
  }

  let expectedPrevHash = EVENT_INTEGRITY_GENESIS_SEED;
  let headHash = EVENT_INTEGRITY_GENESIS_SEED;

  for (const event of events) {
    const integrity = event.integrity;

    if (integrity === undefined) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_missing",
        detail: `Event ${event.sequence} is missing integrity metadata`
      });
    }

    if (integrity.algo !== EVENT_INTEGRITY_ALGO) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_algo_mismatch",
        detail: `Event ${event.sequence} uses integrity algorithm ${integrity.algo}, expected ${EVENT_INTEGRITY_ALGO}`
      });
    }

    if (integrity.prevHash !== expectedPrevHash) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_prev_hash_mismatch",
        detail: `Event ${event.sequence} prevHash ${integrity.prevHash} does not match expected ${expectedPrevHash}`
      });
    }

    const expectedHash = hashEventContent(event);

    if (integrity.hash !== expectedHash) {
      return brokenIntegrityVerdict({
        eventCount: events.length,
        brokenAtSequence: event.sequence,
        code: "integrity_hash_mismatch",
        detail: `Event ${event.sequence} hash ${integrity.hash} does not match recomputed ${expectedHash}`
      });
    }

    expectedPrevHash = integrity.hash;
    headHash = integrity.hash;
  }

  return {
    status: "verified",
    eventCount: events.length,
    headHash
  };
}

function withIntegrity(
  event: RuntimeEvent,
  prevHash: string
): RuntimeEvent {
  const parsed = RuntimeEventSchema.safeParse({
    ...event,
    integrity: computeIntegrity(event, prevHash)
  });

  if (!parsed.success) {
    throw new RunStoreError(
      hasPayloadIssue(parsed.error) ? "invalid_event_payload" : "invalid_event",
      "Runtime event integrity envelope is invalid",
      parsed.error
    );
  }

  return parsed.data;
}

export function computeIntegrity(
  event: RuntimeEvent,
  prevHash: string
): RuntimeEventIntegrity {
  return {
    algo: EVENT_INTEGRITY_ALGO,
    hash: hashEventContent(event),
    prevHash
  };
}

export function hashEventContent(event: RuntimeEvent) {
  const digest = createHash(EVENT_INTEGRITY_ALGO)
    .update(canonicalizeEventContent(event))
    .digest("hex");

  return `${EVENT_INTEGRITY_HASH_PREFIX}${digest}`;
}

export function canonicalizeEventContent(event: RuntimeEvent) {
  const content = {
    id: event.id,
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    sequence: event.sequence,
    traceId: event.traceId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    ...(event.correlationId === undefined
      ? {}
      : { correlationId: event.correlationId }),
    payload: event.payload
  };

  /*
   * Stability contract for event integrity:
   * - genesis prevHash is EVENT_INTEGRITY_GENESIS_SEED
   *   (sha256: followed by 64 zeroes)
   * - the digest input is canonical JSON over the authoritative event content
   * - the integrity field and contract metadata are excluded from the digest
   * - object keys are sorted recursively; array order is preserved
   * - JSON values are normalized through JSON.stringify/parse before sorting so
   *   the hash matches the durable JSONL bytes after a write/read round trip
   */
  return canonicalJsonStringify(content);
}

function canonicalJsonStringify(value: unknown) {
  return JSON.stringify(sortJsonValue(normalizeJsonValue(value)));
}

function normalizeJsonValue(value: unknown) {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    return null;
  }

  return JSON.parse(serialized) as unknown;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }

  return value;
}

function brokenIntegrityVerdict(input: {
  eventCount: number;
  brokenAtSequence: number;
  code: RunIntegrityDefectCode;
  detail: string;
  cause?: unknown;
}): RunIntegrityVerdict {
  void input.cause;

  return {
    status: "broken",
    eventCount: input.eventCount,
    brokenAtSequence: input.brokenAtSequence,
    code: input.code,
    detail: input.detail
  };
}

function integrityBrokenError(runId: string, verdict: RunIntegrityVerdict) {
  if (verdict.status !== "broken") {
    throw new Error("Expected a broken integrity verdict");
  }

  return new RunStoreError(
    "integrity_broken",
    `Run ${runId} event ledger integrity is broken at sequence ${verdict.brokenAtSequence}: ${verdict.detail}`,
    verdict
  );
}

function parseRuntimeEvent(value: unknown, index: number) {
  if (!isRecord(value)) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} must be an object`
    );
  }

  const type = value.type;

  if (typeof type !== "string" || type.length === 0) {
    throw new RunStoreError(
      "invalid_event",
      `Runtime event at line ${index + 1} is missing type`
    );
  }

  const contract = runtimeEventContractForType(type);

  if (contract === undefined) {
    throw new RunStoreError(
      "unknown_event_contract",
      `Unknown runtime event contract ${type} at line ${index + 1}`
    );
  }

  if (
    value.contractVersion !== undefined &&
    value.contractVersion !== contract.contractVersion
  ) {
    throw new RunStoreError(
      "unsupported_event_version",
      `Unsupported runtime event contract version ${String(
        value.contractVersion
      )} for ${type} at line ${index + 1}`
    );
  }

  const parsedEvent = RuntimeEventSchema.safeParse(value);

  if (!parsedEvent.success) {
    throw new RunStoreError(
      hasPayloadIssue(parsedEvent.error) ? "invalid_event_payload" : "invalid_event",
      `Invalid runtime event at line ${index + 1}`,
      parsedEvent.error
    );
  }

  return parsedEvent.data;
}

function parseRunStartedPayload(payload: unknown): RunStartedPayload {
  if (!isRecord(payload)) {
    throw new RunStoreError(
      "invalid_event",
      "run.started payload must be an object"
    );
  }

  const input = RunInputSchema.parse(payload.input);
  const harness = assertHarnessSnapshot(payload.harness);
  const initialPhase =
    nonEmpty(payload.initialPhase, "initialPhase") ?? "created";
  const budgets = isRecord(payload.budgets) ? payload.budgets : {};

  return {
    input,
    harness,
    initialPhase,
    budgets
  };
}

function parseNestedArtifact(payload: unknown): ArtifactRef | undefined {
  const candidates = getPayloadCandidates(payload, [
    "artifact",
    "artifactRef",
    "ref"
  ]);

  for (const candidate of candidates) {
    const parsed = ArtifactRefSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function parseNestedQuestion(payload: unknown): HumanQuestion | undefined {
  const candidates = getPayloadCandidates(payload, ["question", "humanQuestion"]);

  for (const candidate of candidates) {
    const parsed = HumanQuestionSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function parseNestedApprovalRequest(
  payload: unknown
): ApprovalRequest | undefined {
  const candidates = getPayloadCandidates(payload, [
    "approval",
    "approvalRequest"
  ]);

  for (const candidate of candidates) {
    const parsed = ApprovalRequestSchema.safeParse(candidate);

    if (parsed.success) {
      return parsed.data;
    }
  }

  return undefined;
}

function getPayloadCandidates(payload: unknown, nestedKeys: string[]) {
  const candidates: unknown[] = [payload];

  if (isRecord(payload)) {
    for (const key of nestedKeys) {
      candidates.push(payload[key]);
    }
  }

  return candidates;
}

function getPayloadString(payload: unknown, keys: string[]) {
  if (!isRecord(payload)) {
    return undefined;
  }

  for (const key of keys) {
    const value = payload[key];

    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function upsertByKey<TItem extends Record<TKey, string>, TKey extends string>(
  items: readonly TItem[],
  item: TItem,
  key: TKey
) {
  const next = items.filter((current) => current[key] !== item[key]);
  next.push(item);
  return next;
}

function buildEvent<TPayload>(input: {
  id?: string | undefined;
  runId: string;
  type: string;
  payload: TPayload;
  traceId?: string | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  timestamp?: Date | string | undefined;
  sequence: number;
}): RuntimeEvent {
  const traceId = nonEmpty(input.traceId, "traceId");
  const type = nonEmpty(input.type, "type") ?? "";
  const contract = runtimeEventContractForType(type);

  if (traceId === undefined) {
    throw new RunStoreError(
      "invalid_event",
      "A traceId is required for the first run event"
    );
  }

  if (contract === undefined) {
    throw new RunStoreError(
      "unknown_event_contract",
      `Unknown runtime event contract ${type}`
    );
  }

  const event = {
    id: nonEmpty(input.id, "id") ?? randomUUID(),
    runId: assertSafeRunId(input.runId),
    type,
    timestamp: normalizeTimestamp(input.timestamp),
    sequence: input.sequence,
    traceId,
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    schemaHash: contract.schemaHash,
    ...(input.causationId === undefined
      ? {}
      : { causationId: nonEmpty(input.causationId, "causationId") }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: nonEmpty(input.correlationId, "correlationId") }),
    payload: input.payload
  };
  const parsed = RuntimeEventSchema.safeParse(event);

  if (!parsed.success) {
    throw new RunStoreError(
      hasPayloadIssue(parsed.error) ? "invalid_event_payload" : "invalid_event",
      "Runtime event envelope is invalid",
      parsed.error
    );
  }

  return parsed.data;
}

async function createRunDirectory(paths: RunStorePaths) {
  try {
    await mkdir(paths.runDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new RunStoreError(
        "run_exists",
        `Run directory already exists at ${paths.runDir}`,
        error
      );
    }

    throw error;
  }
}

async function appendJsonLine(path: string, value: unknown) {
  const file = await open(path, "a");

  try {
    await file.appendFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeProjection(paths: RunStorePaths, state: RunState) {
  await writeJsonAtomic(paths.statePath, state);
}

async function writeJsonAtomic(path: string, value: unknown) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx"
  });
  await rename(tempPath, path);
}

function assertHarnessSnapshot(value: unknown): HarnessSnapshot {
  if (!isRecord(value)) {
    throw new RunStoreError("invalid_event", "Harness snapshot is required");
  }

  const harness = {
    id: nonEmpty(value.id, "harness.id") ?? "",
    version: nonEmpty(value.version, "harness.version") ?? "",
    specHash: nonEmpty(value.specHash, "harness.specHash") ?? ""
  };

  const parsed = RunStateSchema.shape.harness.safeParse(harness);

  if (!parsed.success) {
    throw new RunStoreError(
      "invalid_event",
      "Harness snapshot must include id, version, and specHash",
      parsed.error
    );
  }

  return parsed.data;
}

function assertSafeRunId(runId: string) {
  const value = nonEmpty(runId, "runId");

  if (
    value === undefined ||
    /[/\\]/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new RunStoreError(
      "invalid_run_id",
      "Run ID must be a non-empty path segment"
    );
  }

  return value;
}

function nonEmpty(value: unknown, label: string) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new RunStoreError("invalid_event", `${label} must be a non-empty string`);
  }

  return value;
}

function normalizeTimestamp(timestamp: Date | string | undefined) {
  if (timestamp === undefined) {
    return new Date().toISOString();
  }

  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}

function hasPayloadIssue(error: { issues: readonly { path: readonly unknown[] }[] }) {
  return error.issues.some((issue) => issue.path[0] === "payload");
}
