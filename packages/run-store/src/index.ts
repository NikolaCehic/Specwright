import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApprovalRequestSchema,
  ArtifactRefSchema,
  HumanQuestionSchema,
  RunInputSchema,
  RunStateSchema,
  RuntimeEventSchema,
  type ApprovalRequest,
  type ArtifactRef,
  type HumanQuestion,
  type RunInput,
  type RunState,
  type RuntimeEvent
} from "@specwright/schemas";

export const RUN_STORE_DIR = ".archetype";
export const RUNS_DIR = "runs";
export const EVENTS_FILE = "events.jsonl";
export const STATE_FILE = "state.json";
export const TRACE_FILE = "trace.json";
export const DECISIONS_FILE = "decisions.jsonl";
export const SUMMARY_FILE = "summary.md";

export type RunStoreErrorCode =
  | "corrupt_event"
  | "invalid_event"
  | "invalid_projection"
  | "invalid_run_id"
  | "invalid_sequence"
  | "missing_events"
  | "run_exists"
  | "run_not_started";

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
  event: RuntimeEvent<RunStartedPayload>;
  state: RunState;
};

export type AppendEventResult<TPayload = unknown> = {
  event: RuntimeEvent<TPayload>;
  state: RunState;
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
  const event = buildEvent({
    runId,
    type: "run.started",
    payload,
    traceId,
    timestamp: options.timestamp,
    sequence: 0
  });
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
): Promise<AppendEventResult<TPayload>> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const existingEvents = await readEvents({
    rootDir: options.rootDir,
    runId
  });
  const lastEvent = existingEvents.at(-1);
  const event = buildEvent({
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
  const events = [...existingEvents, event];
  const state = projectRunState(events);

  await appendJsonLine(paths.eventsPath, event);
  await writeProjection(paths, state);

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

export function parseEventLog(raw: string, expectedRunId?: string) {
  const lines = raw.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((line, index) => parseEventLine(line, index, expectedRunId));
}

export async function materializeRunState(options: {
  rootDir?: string | undefined;
  runId: string;
}): Promise<RunState> {
  const runId = assertSafeRunId(options.runId);
  const paths = getRunStorePaths(options.rootDir, runId);
  const state = projectRunState(
    await readEvents({
      rootDir: options.rootDir,
      runId
    })
  );

  await writeProjection(paths, state);

  return state;
}

export const replayRunState = materializeRunState;

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

  const parsedEvent = RuntimeEventSchema.safeParse(parsedJson);

  if (!parsedEvent.success) {
    throw new RunStoreError(
      "invalid_event",
      `Invalid runtime event at line ${index + 1}`,
      parsedEvent.error
    );
  }

  const event = parsedEvent.data;

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

  return event as RuntimeEvent;
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
}) {
  const traceId = nonEmpty(input.traceId, "traceId");

  if (traceId === undefined) {
    throw new RunStoreError(
      "invalid_event",
      "A traceId is required for the first run event"
    );
  }

  const event = {
    id: nonEmpty(input.id, "id") ?? randomUUID(),
    runId: assertSafeRunId(input.runId),
    type: nonEmpty(input.type, "type") ?? "",
    timestamp: normalizeTimestamp(input.timestamp),
    sequence: input.sequence,
    traceId,
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
      "invalid_event",
      "Runtime event envelope is invalid",
      parsed.error
    );
  }

  return parsed.data as RuntimeEvent<TPayload>;
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
