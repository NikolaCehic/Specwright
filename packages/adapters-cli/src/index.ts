import { createRuntime, type RuntimeApi } from "@specwright/runtime";
import { EvidenceRecordSchema, type EvidenceRecord } from "@specwright/schemas";
import { CLI_VERSION, DEFAULT_HARNESS_ID } from "./constants";
import {
  resolveExecutionContext,
  type CliExecutionContext,
  type CliExecutionContextInput
} from "./context";
import {
  DEFAULT_DEADLINE_MS,
  parsePositiveIntegerFlag,
  withDeadline
} from "./deadline";
import {
  CliInputError,
  CliIntegrityError,
  CliUsageError,
  classifyError,
  errorRecordFor,
  errorRecordForOutcome,
  messageForError
} from "./errors";
import {
  encodeEnvelope,
  outputSchemas,
  pendingFromState,
  type CliCommandName,
  type CliDiagnostic
} from "./output-contract";
import {
  OUTCOMES,
  classifyRuntimeOutcome,
  exitCodeForOutcome,
  outcomeForExitCode,
  type OutcomeClass
} from "./outcome";
import { boundRead, parseLimit, truncationDiagnostic } from "./read-bounds";
import { redactForEgress, sanitizeText, type RedactionProfile } from "./redaction";
import {
  buildTelemetryRecord,
  defaultInvocationId,
  type CliTelemetryRecord,
  type CliTelemetrySink
} from "./telemetry";
import {
  assertAuthorized,
  assertCanWidenRedaction,
  canonicalizeAllowedPath,
  type CommandAuthority
} from "./security";

export { OUTCOMES, classifyRuntimeOutcome, outcomeForExitCode, outputSchemas };
export type { OutcomeClass, CliTelemetryRecord };

export type CliRuntime = Pick<
  RuntimeApi,
  | "startRun"
  | "getRun"
  | "getEvents"
  | "replay"
  | "writeRunReport"
  | "recordEvidence"
>;

export type CliExecution = {
  exitCode: number;
  stdout: string;
  stderr: string;
  telemetry?: CliTelemetryRecord;
};

export type CliExecutionOptions = {
  context?: CliExecutionContextInput | CliExecutionContext | undefined;
  telemetrySink?: CliTelemetrySink | undefined;
  now?: (() => number) | undefined;
  invocationId?: string | undefined;
  defaultDeadlineMs?: number | undefined;
};

type ParsedCommand =
  | {
      kind: "help";
      json: boolean;
      ci: boolean;
      deadlineMs?: number | undefined;
    }
  | {
      kind: "run";
      cwd: string;
      task: string;
      harnessId: string;
      json: boolean;
      ci: boolean;
      deadlineMs?: number | undefined;
    }
  | {
      kind: "status" | "events" | "replay" | "report";
      runId: string;
      rootDir?: string | undefined;
      json: boolean;
      ci: boolean;
      limit?: number | undefined;
      deadlineMs?: number | undefined;
      redactionProfile: RedactionProfile;
    }
  | {
      kind: "approve" | "reject";
      runId: string;
      approvalId: string;
      decisionHash: string;
      message?: string | undefined;
      rootDir?: string | undefined;
      json: boolean;
      ci: boolean;
      deadlineMs?: number | undefined;
    }
  | {
      kind: "answer";
      runId: string;
      questionId: string;
      answer: string;
      rootDir?: string | undefined;
      json: boolean;
      ci: boolean;
      deadlineMs?: number | undefined;
    };

type RuntimeCommand = Exclude<ParsedCommand, { kind: "help" }>;

type ParsedArguments = {
  flags: Record<string, string | true>;
  positionals: string[];
};

type CommandResult = {
  command: CliCommandName;
  outcome: OutcomeClass;
  runId?: string | undefined;
  data?: unknown;
  stdout: string;
  diagnostics?: CliDiagnostic[] | undefined;
  errorMessage?: string | undefined;
  operatorAction?: string | undefined;
};

export async function executeCli(
  argv: readonly string[],
  runtime: CliRuntime = createRuntime(),
  options: CliExecutionOptions = {}
): Promise<CliExecution> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const context = normalizeContext(options.context);
  const invocationId = options.invocationId ?? defaultInvocationId();
  let commandName = commandNameFromArgv(argv);
  let targetRunId: string | undefined;
  let result: CliExecution;

  try {
    const command = parseCommand(argv, {
      defaultDeadlineMs: options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS
    });
    commandName = command.kind;
    targetRunId = "runId" in command ? command.runId : undefined;

    const effectiveContext = {
      ...context,
      ci: context.ci || command.ci
    };

    if (command.kind === "help") {
      result = ok(`${usage()}\n`);
    } else {
      const commandResult = await executeCommand(
        command,
        runtime,
        effectiveContext,
        options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS
      );
      result = executionForCommandResult(commandResult, command.json);
    }
  } catch (error) {
    const jsonMode = argv.includes("--json");
    result = executionForError(error, jsonMode);
  }

  const outcome = outcomeForExitCode(result.exitCode);
  const telemetry = buildTelemetryRecord({
    invocationId,
    command: commandName,
    context,
    targetRunId,
    outcome,
    exitCode: result.exitCode,
    startedAtMs,
    endedAtMs: now()
  });

  await options.telemetrySink?.(telemetry);

  return {
    ...result,
    telemetry
  };
}

async function executeCommand(
  command: RuntimeCommand,
  runtime: CliRuntime,
  context: CliExecutionContext,
  defaultDeadlineMs: number
): Promise<CommandResult> {
  const authority = authorityForCommand(command.kind);
  assertAuthorized({
    command: command.kind,
    authority,
    context,
    runId: "runId" in command ? command.runId : undefined
  });

  const deadlineMs = command.deadlineMs ?? defaultDeadlineMs;

  switch (command.kind) {
    case "run": {
      validateHarnessId(command.harnessId);
      const cwd = canonicalizeAllowedPath({
        value: command.cwd,
        flagName: "cwd",
        context
      });

      const handle = await withDeadline(
        runtime.startRun({
          task: command.task,
          cwd,
          harnessId: command.harnessId,
          host: {
            kind: "cli",
            version: CLI_VERSION
          },
          metadata: {
            cli: {
              actor: context.principal,
              tenant: {
                id: context.tenant.id
              }
            }
          }
        }),
        deadlineMs,
        "startRun exceeded the invocation deadline"
      );
      const outcome = classifyRuntimeOutcome(handle.state);
      const data = redactForEgress(
        {
          runId: handle.runId,
          state: handle.state,
          harness: handle.harness,
          paths: handle.paths
        },
        "shared-log"
      );

      return {
        command: "run",
        outcome,
        runId: handle.runId,
        data,
        stdout: renderRunStarted(handle)
      };
    }

    case "status": {
      const rootDir = canonicalizeAllowedPath({
        value: command.rootDir,
        flagName: "root",
        context
      });
      const state = await withDeadline(
        runtime.getRun(command.runId, lookupOptions(rootDir)),
        deadlineMs,
        "getRun exceeded the invocation deadline"
      );
      const outcome = classifyRuntimeOutcome(state);
      const redacted = redactForEgress(state, "shared-log");

      return {
        command: "status",
        outcome,
        runId: command.runId,
        data: redacted,
        stdout: renderStatus(redacted)
      };
    }

    case "events": {
      assertCanWidenRedaction({
        principal: context.principal,
        profile: command.redactionProfile
      });
      const rootDir = canonicalizeAllowedPath({
        value: command.rootDir,
        flagName: "root",
        context
      });
      const events = await withDeadline(
        runtime.getEvents(command.runId, lookupOptions(rootDir)),
        deadlineMs,
        "getEvents exceeded the invocation deadline"
      );
      const bounded = boundRead(events, command.limit ?? parseLimit(undefined));
      const data = redactForEgress(bounded.items, command.redactionProfile);
      const diagnostics = bounded.truncated
        ? [truncationDiagnostic(bounded)]
        : undefined;

      return {
        command: "events",
        outcome: "ok",
        runId: command.runId,
        data,
        diagnostics,
        stdout: renderEvents(command.runId, data, bounded)
      };
    }

    case "replay": {
      const rootDir = canonicalizeAllowedPath({
        value: command.rootDir,
        flagName: "root",
        context
      });
      const replayed = await withDeadline(
        runtime.replay(command.runId, lookupOptions(rootDir)),
        deadlineMs,
        "replay exceeded the invocation deadline"
      );
      const bounded = boundRead(replayed.events, command.limit ?? parseLimit(undefined));
      const data = redactForEgress(
        {
          state: replayed.state,
          events: bounded.items
        },
        "shared-log"
      );
      const outcome = classifyRuntimeOutcome(replayed.state);
      const diagnostics = bounded.truncated
        ? [truncationDiagnostic(bounded)]
        : undefined;

      return {
        command: "replay",
        outcome,
        runId: command.runId,
        data,
        diagnostics,
        stdout: renderReplay(data, bounded)
      };
    }

    case "report": {
      assertCanWidenRedaction({
        principal: context.principal,
        profile: command.redactionProfile
      });
      const rootDir = canonicalizeAllowedPath({
        value: command.rootDir,
        flagName: "root",
        context
      });
      const report = await withDeadline(
        runtime.writeRunReport(command.runId, lookupOptions(rootDir)),
        deadlineMs,
        "writeRunReport exceeded the invocation deadline"
      );
      const data = redactForEgress(report, command.redactionProfile);

      return {
        command: "report",
        outcome: "ok",
        runId: command.runId,
        data,
        stdout: renderReport(data)
      };
    }

    case "answer": {
      const rootDir = canonicalizeAllowedPath({
        value: command.rootDir,
        flagName: "root",
        context
      });
      const record = answerEvidenceRecord(command, context);
      const evidence = await withDeadline(
        runtime.recordEvidence(command.runId, record, lookupOptions(rootDir)),
        deadlineMs,
        "recordEvidence exceeded the invocation deadline"
      );

      return {
        command: "answer",
        outcome: "ok",
        runId: command.runId,
        data: evidence,
        stdout: renderAnswerResult(evidence)
      };
    }

    case "approve":
    case "reject": {
      validateDecisionHash(command.decisionHash);

      throw new CliIntegrityError(
        `${command.kind} is unavailable because RuntimeApi exposes no approval decision operation`,
        {
          runId: command.runId,
          operatorAction:
            "Upgrade the runtime to an approval-decision API; this CLI will not fabricate approval state."
        }
      );
    }
  }
}

function executionForCommandResult(
  result: CommandResult,
  jsonMode: boolean
): CliExecution {
  const exitCode = exitCodeForOutcome(result.outcome);

  if (!jsonMode) {
    return {
      exitCode,
      stdout: result.stdout,
      stderr: ""
    };
  }

  const error =
    result.outcome === "ok"
      ? undefined
      : errorRecordForOutcome({
          outcome: result.outcome,
          message: result.errorMessage ?? result.outcome,
          runId: result.runId,
          operatorAction: result.operatorAction
        });

  if (result.outcome !== "ok") {
    return {
      exitCode,
      stdout: "",
      stderr: `${JSON.stringify(error, null, 2)}\n`
    };
  }

  const pending = pendingFromPayload(result.data);

  return {
    exitCode,
    stdout: encodeEnvelope({
      command: result.command,
      outcome: result.outcome,
      ...(result.runId === undefined ? {} : { runId: result.runId }),
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(pending === undefined ? {} : { pending }),
      ...(result.diagnostics === undefined
        ? {}
        : { diagnostics: result.diagnostics }),
      ...(error === undefined ? {} : { error })
    }),
    stderr: ""
  };
}

function executionForError(error: unknown, jsonMode: boolean): CliExecution {
  const outcome = classifyError(error);
  const exitCode = exitCodeForOutcome(outcome);

  if (jsonMode) {
    return {
      exitCode,
      stdout: "",
      stderr: `${JSON.stringify(errorRecordFor(error), null, 2)}\n`
    };
  }

  if (error instanceof CliUsageError) {
    return {
      exitCode,
      stdout: "",
      stderr: `${error.message}\n\n${usage()}\n`
    };
  }

  return {
    exitCode,
    stdout: "",
    stderr: `Error: ${messageForError(error)}\n`
  };
}

function parseCommand(
  argv: readonly string[],
  options: { defaultDeadlineMs: number }
): ParsedCommand {
  const [command, ...rest] = argv;

  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    const parsed =
      command === undefined || command === "help"
        ? parseArguments(rest, {
            valueFlags: ["deadline"],
            booleanFlags: ["json", "ci"]
          })
        : { flags: {}, positionals: [] };

    return {
      kind: "help",
      json: parsed.flags.json === true,
      ci: parsed.flags.ci === true,
      deadlineMs: parsePositiveIntegerFlag({
        value: stringFlag(parsed, "deadline"),
        flagName: "deadline",
        defaultValue: options.defaultDeadlineMs
      })
    };
  }

  switch (command) {
    case "run":
      return parseRun(rest, options.defaultDeadlineMs);
    case "status":
    case "events":
    case "replay":
    case "report":
      return parseRunLookup(command, rest, options.defaultDeadlineMs);
    case "approve":
    case "reject":
      return parseApprovalDecision(command, rest, options.defaultDeadlineMs);
    case "answer":
      return parseAnswer(rest, options.defaultDeadlineMs);
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

function parseRun(argv: readonly string[], defaultDeadlineMs: number): ParsedCommand {
  const parsed = parseArguments(argv, {
    valueFlags: ["cwd", "task", "harness", "deadline"],
    booleanFlags: ["json", "ci"]
  });
  const cwd = stringFlag(parsed, "cwd");
  const task = stringFlag(parsed, "task");
  const harnessId = stringFlag(parsed, "harness") ?? DEFAULT_HARNESS_ID;

  if (parsed.positionals.length > 0) {
    throw new CliUsageError("run does not accept positional arguments");
  }

  if (cwd === undefined) {
    throw new CliUsageError("run requires --cwd <path>");
  }

  if (task === undefined) {
    throw new CliUsageError("run requires --task <task>");
  }

  if (task.trim().length === 0 || containsUnsafeControl(task)) {
    throw new CliInputError("--task must be non-empty text without control characters");
  }

  return {
    kind: "run",
    cwd,
    task,
    harnessId,
    json: parsed.flags.json === true,
    ci: parsed.flags.ci === true,
    deadlineMs: deadlineFromParsed(parsed, defaultDeadlineMs)
  };
}

function parseRunLookup(
  kind: "status" | "events" | "replay" | "report",
  argv: readonly string[],
  defaultDeadlineMs: number
): ParsedCommand {
  const parsed = parseArguments(argv, {
    valueFlags: ["root", "limit", "deadline", "redaction-profile"],
    booleanFlags: ["json", "ci"]
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(`${kind} requires exactly one <run-id>`);
  }

  const runId = parsed.positionals[0];

  if (runId === undefined) {
    throw new CliUsageError(`${kind} requires exactly one <run-id>`);
  }

  const profile = redactionProfileFromFlag(stringFlag(parsed, "redaction-profile"));

  return {
    kind,
    runId,
    rootDir: stringFlag(parsed, "root"),
    json: parsed.flags.json === true,
    ci: parsed.flags.ci === true,
    limit:
      kind === "events" || kind === "replay"
        ? parseLimit(stringFlag(parsed, "limit"))
        : undefined,
    deadlineMs: deadlineFromParsed(parsed, defaultDeadlineMs),
    redactionProfile: profile
  };
}

function parseApprovalDecision(
  kind: "approve" | "reject",
  argv: readonly string[],
  defaultDeadlineMs: number
): ParsedCommand {
  const parsed = parseArguments(argv, {
    valueFlags: ["approval", "decision-hash", "message", "root", "deadline"],
    booleanFlags: ["json", "ci"]
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(`${kind} requires exactly one <run-id>`);
  }

  const runId = parsed.positionals[0];
  const approvalId = stringFlag(parsed, "approval");
  const decisionHash = stringFlag(parsed, "decision-hash");

  if (runId === undefined) {
    throw new CliUsageError(`${kind} requires exactly one <run-id>`);
  }

  if (approvalId === undefined) {
    throw new CliUsageError(`${kind} requires --approval <approval-id>`);
  }

  if (decisionHash === undefined) {
    throw new CliUsageError(`${kind} requires --decision-hash <hash>`);
  }

  if (approvalId.trim().length === 0) {
    throw new CliInputError("--approval cannot be empty", { runId });
  }

  validateDecisionHash(decisionHash, runId);

  return {
    kind,
    runId,
    approvalId,
    decisionHash,
    message: stringFlag(parsed, "message"),
    rootDir: stringFlag(parsed, "root"),
    json: parsed.flags.json === true,
    ci: parsed.flags.ci === true,
    deadlineMs: deadlineFromParsed(parsed, defaultDeadlineMs)
  };
}

function parseAnswer(
  argv: readonly string[],
  defaultDeadlineMs: number
): ParsedCommand {
  const parsed = parseArguments(argv, {
    valueFlags: ["question", "answer", "root", "deadline"],
    booleanFlags: ["json", "ci"]
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("answer requires exactly one <run-id>");
  }

  const runId = parsed.positionals[0];
  const questionId = stringFlag(parsed, "question");
  const answer = stringFlag(parsed, "answer");

  if (runId === undefined) {
    throw new CliUsageError("answer requires exactly one <run-id>");
  }

  if (questionId === undefined) {
    throw new CliUsageError("answer requires --question <question-id>");
  }

  if (answer === undefined) {
    throw new CliUsageError("answer requires --answer <text>");
  }

  if (questionId.trim().length === 0 || answer.trim().length === 0) {
    throw new CliInputError("--question and --answer cannot be empty", { runId });
  }

  return {
    kind: "answer",
    runId,
    questionId,
    answer,
    rootDir: stringFlag(parsed, "root"),
    json: parsed.flags.json === true,
    ci: parsed.flags.ci === true,
    deadlineMs: deadlineFromParsed(parsed, defaultDeadlineMs)
  };
}

function parseArguments(
  argv: readonly string[],
  options: {
    valueFlags: readonly string[];
    booleanFlags: readonly string[];
  }
): ParsedArguments {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  const valueFlags = new Set(options.valueFlags);
  const booleanFlags = new Set(options.booleanFlags);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (!token.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${token}`);
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : raw.slice(equalsIndex + 1);

    if (valueFlags.has(name)) {
      const value = inlineValue ?? argv[index + 1];

      if (value === undefined || value.length === 0) {
        throw new CliUsageError(`--${name} requires a value`);
      }

      if (inlineValue === undefined) {
        index += 1;
      }

      flags[name] = value;
      continue;
    }

    if (booleanFlags.has(name)) {
      if (inlineValue !== undefined && inlineValue !== "true") {
        throw new CliUsageError(`--${name} does not accept a value`);
      }

      flags[name] = true;
      continue;
    }

    throw new CliUsageError(`Unknown option: --${name}`);
  }

  return {
    flags,
    positionals
  };
}

function stringFlag(
  parsed: ParsedArguments,
  name: string
): string | undefined {
  const value = parsed.flags[name];

  return typeof value === "string" ? value : undefined;
}

function lookupOptions(rootDir: string | undefined) {
  return rootDir === undefined ? {} : { rootDir };
}

function renderRunStarted(
  handle: Awaited<ReturnType<CliRuntime["startRun"]>>
) {
  return lines([
    "Run started",
    `Run: ${handle.runId}`,
    `Status: ${handle.state.status}`,
    `Phase: ${handle.state.phase}`,
    `Harness: ${formatHarness(handle.state.harness)}`,
    `Root: ${handle.paths.rootDir}`
  ]);
}

function renderStatus(state: Awaited<ReturnType<CliRuntime["getRun"]>>) {
  return lines([
    `Run: ${state.runId}`,
    `Status: ${state.status}`,
    `Phase: ${state.phase}`,
    `Harness: ${formatHarness(state.harness)}`,
    `Last event: ${state.lastEventId}`,
    `Artifacts: ${state.artifacts.length}`,
    `Pending approvals: ${state.pendingApprovals.length}`,
    `Pending questions: ${state.pendingQuestions.length}`
  ]);
}

function renderEvents(
  runId: string,
  events: Awaited<ReturnType<CliRuntime["getEvents"]>>,
  bounded?: { truncated: boolean; shown: number; total: number }
) {
  if (events.length === 0) {
    return lines([`Run: ${runId}`, "Events: none"]);
  }

  return lines([
    `Run: ${runId}`,
    `Events: ${events.length}`,
    ...events.map(
      (event) =>
        `${event.sequence} ${sanitizeText(event.type)} ${event.id} ${event.timestamp}`
    ),
    ...(bounded?.truncated === true
      ? [`Output truncated: showing ${bounded.shown} of ${bounded.total} events.`]
      : [])
  ]);
}

function renderReplay(
  replayed: Awaited<ReturnType<CliRuntime["replay"]>>,
  bounded?: { truncated: boolean; shown: number; total: number }
) {
  return lines([
    `Run: ${replayed.state.runId}`,
    `Status: ${replayed.state.status}`,
    `Phase: ${replayed.state.phase}`,
    `Events replayed: ${replayed.events.length}`,
    `Last event: ${replayed.state.lastEventId}`,
    ...(bounded?.truncated === true
      ? [`Output truncated: showing ${bounded.shown} of ${bounded.total} events.`]
      : [])
  ]);
}

function renderReport(
  report: Awaited<ReturnType<CliRuntime["writeRunReport"]>>
) {
  return lines([
    `Run: ${report.runId}`,
    `Summary: ${report.summaryPath}`,
    "",
    sanitizeText(report.markdown.trimEnd())
  ]);
}

function renderAnswerResult(evidence: EvidenceRecord) {
  return lines([
    "Answer recorded",
    `Evidence: ${evidence.id}`,
    `Class: ${evidence.class}`,
    `Authority: ${evidence.authority}`
  ]);
}

function formatHarness(state: {
  id: string;
  version: string;
  specHash: string;
}) {
  return `${state.id}@${state.version} (${state.specHash})`;
}

function lines(values: readonly string[]) {
  return `${values.join("\n")}\n`;
}

function ok(stdout: string): CliExecution {
  return {
    exitCode: 0,
    stdout,
    stderr: ""
  };
}

function usage() {
  return [
    "Usage:",
    "  specwright run --cwd <path> --task <task> [--harness <id-or-path>] [--json] [--ci] [--deadline <ms>]",
    "  specwright status <run-id> [--root <path>] [--json] [--ci] [--deadline <ms>]",
    "  specwright events <run-id> [--root <path>] [--limit <n>] [--redaction-profile <shared-log|operator>] [--json] [--ci] [--deadline <ms>]",
    "  specwright replay <run-id> [--root <path>] [--limit <n>] [--json] [--ci] [--deadline <ms>]",
    "  specwright report <run-id> [--root <path>] [--redaction-profile <shared-log|operator>] [--json] [--ci] [--deadline <ms>]",
    "  specwright approve <run-id> --approval <approval-id> --decision-hash <hash> [--message <text>] [--root <path>] [--json]",
    "  specwright reject <run-id> --approval <approval-id> --decision-hash <hash> [--message <text>] [--root <path>] [--json]",
    "  specwright answer <run-id> --question <question-id> --answer <text> [--root <path>] [--json]"
  ].join("\n");
}

function normalizeContext(
  input: CliExecutionOptions["context"]
): CliExecutionContext {
  if (
    input !== undefined &&
    "principal" in input &&
    input.principal !== undefined &&
    "tenant" in input &&
    input.tenant !== undefined &&
    "ci" in input &&
    input.ci !== undefined
  ) {
    return input as CliExecutionContext;
  }

  return resolveExecutionContext(input as CliExecutionContextInput | undefined);
}

function commandNameFromArgv(argv: readonly string[]): string {
  return argv[0] ?? "help";
}

function authorityForCommand(command: RuntimeCommand["kind"]): CommandAuthority {
  switch (command) {
    case "run":
    case "report":
      return "privileged";
    case "approve":
    case "reject":
    case "answer":
      return "decision";
    case "status":
    case "events":
    case "replay":
      return "read";
  }
}

function deadlineFromParsed(
  parsed: ParsedArguments,
  defaultDeadlineMs: number
): number {
  return parsePositiveIntegerFlag({
    value: stringFlag(parsed, "deadline"),
    flagName: "deadline",
    defaultValue: defaultDeadlineMs
  });
}

function redactionProfileFromFlag(
  value: string | undefined
): RedactionProfile {
  if (value === undefined || value === "shared-log") {
    return "shared-log";
  }

  if (value === "operator") {
    return "operator";
  }

  throw new CliInputError("--redaction-profile must be shared-log or operator");
}

function validateHarnessId(harnessId: string): void {
  if (harnessId !== DEFAULT_HARNESS_ID) {
    throw new CliInputError(`Unknown harness: ${harnessId}`);
  }
}

function validateDecisionHash(value: string, runId?: string): void {
  if (!/^[A-Za-z0-9:_-]{8,}$/.test(value)) {
    throw new CliInputError("--decision-hash is malformed", { runId });
  }
}

function containsUnsafeControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function pendingFromPayload(data: unknown) {
  if (data !== undefined && typeof data === "object" && data !== null) {
    if ("state" in data) {
      return pendingFromState((data as { state?: unknown }).state);
    }

    return pendingFromState(data);
  }

  return undefined;
}

function answerEvidenceRecord(
  command: Extract<ParsedCommand, { kind: "answer" }>,
  context: CliExecutionContext
): EvidenceRecord {
  return EvidenceRecordSchema.parse({
    id: `cli:answer:${command.runId}:${command.questionId}`,
    class: "human_decision",
    claim: sanitizeText(command.answer),
    sourceRefs: [
      {
        id: command.questionId,
        authority: "user",
        redactionClass: "operator",
        metadata: {
          questionId: command.questionId,
          actor: context.principal.id
        }
      }
    ],
    confidence: "high",
    authority: "user",
    createdBy: {
      phase: "cli",
      actionId: "answer"
    },
    redactionPolicy: "operator",
    metadata: {
      questionId: command.questionId,
      actor: context.principal.id,
      tenant: context.tenant.id
    }
  });
}
