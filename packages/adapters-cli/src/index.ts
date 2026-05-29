import { createRuntime, type RuntimeApi } from "@specwright/runtime";

export type CliRuntime = Pick<
  RuntimeApi,
  "startRun" | "getRun" | "getEvents" | "replay" | "writeRunReport"
>;

export type CliExecution = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ParsedCommand =
  | {
      kind: "help";
    }
  | {
      kind: "run";
      cwd: string;
      task: string;
      harnessId: string;
      json: boolean;
    }
  | {
      kind: "status" | "events" | "replay" | "report";
      runId: string;
      rootDir?: string | undefined;
      json: boolean;
    };

type ParsedArguments = {
  flags: Record<string, string | true>;
  positionals: string[];
};

const DEFAULT_HARNESS_ID = "default";
const CLI_VERSION = "0.0.0";

export async function executeCli(
  argv: readonly string[],
  runtime: CliRuntime = createRuntime()
): Promise<CliExecution> {
  try {
    const command = parseCommand(argv);

    if (command.kind === "help") {
      return ok(`${usage()}\n`);
    }

    const stdout = await executeCommand(command, runtime);

    return ok(stdout);
  } catch (error) {
    if (error instanceof CliUsageError) {
      return fail(`${error.message}\n\n${usage()}\n`);
    }

    return fail(`Error: ${messageForError(error)}\n`);
  }
}

async function executeCommand(
  command: Exclude<ParsedCommand, { kind: "help" }>,
  runtime: CliRuntime
): Promise<string> {
  switch (command.kind) {
    case "run": {
      const handle = await runtime.startRun({
        task: command.task,
        cwd: command.cwd,
        harnessId: command.harnessId,
        host: {
          kind: "cli",
          version: CLI_VERSION
        }
      });

      return command.json
        ? json({
            runId: handle.runId,
            state: handle.state,
            harness: handle.harness,
            paths: handle.paths
          })
        : renderRunStarted(handle);
    }

    case "status": {
      const state = await runtime.getRun(
        command.runId,
        lookupOptions(command.rootDir)
      );

      return command.json ? json(state) : renderStatus(state);
    }

    case "events": {
      const events = await runtime.getEvents(
        command.runId,
        lookupOptions(command.rootDir)
      );

      return command.json ? json(events) : renderEvents(command.runId, events);
    }

    case "replay": {
      const replayed = await runtime.replay(
        command.runId,
        lookupOptions(command.rootDir)
      );

      return command.json ? json(replayed) : renderReplay(replayed);
    }

    case "report": {
      const report = await runtime.writeRunReport(
        command.runId,
        lookupOptions(command.rootDir)
      );

      return command.json ? json(report) : renderReport(report);
    }
  }
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;

  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    return {
      kind: "help"
    };
  }

  switch (command) {
    case "run":
      return parseRun(rest);
    case "status":
    case "events":
    case "replay":
    case "report":
      return parseRunLookup(command, rest);
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

function parseRun(argv: readonly string[]): ParsedCommand {
  const parsed = parseArguments(argv, {
    valueFlags: ["cwd", "task", "harness"],
    booleanFlags: ["json"]
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

  return {
    kind: "run",
    cwd,
    task,
    harnessId,
    json: parsed.flags.json === true
  };
}

function parseRunLookup(
  kind: "status" | "events" | "replay" | "report",
  argv: readonly string[]
): ParsedCommand {
  const parsed = parseArguments(argv, {
    valueFlags: ["root"],
    booleanFlags: ["json"]
  });

  if (parsed.positionals.length !== 1) {
    throw new CliUsageError(`${kind} requires exactly one <run-id>`);
  }

  const runId = parsed.positionals[0];

  if (runId === undefined) {
    throw new CliUsageError(`${kind} requires exactly one <run-id>`);
  }

  return {
    kind,
    runId,
    rootDir: stringFlag(parsed, "root"),
    json: parsed.flags.json === true
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
  events: Awaited<ReturnType<CliRuntime["getEvents"]>>
) {
  if (events.length === 0) {
    return lines([`Run: ${runId}`, "Events: none"]);
  }

  return lines([
    `Run: ${runId}`,
    `Events: ${events.length}`,
    ...events.map(
      (event) =>
        `${event.sequence} ${event.type} ${event.id} ${event.timestamp}`
    )
  ]);
}

function renderReplay(replayed: Awaited<ReturnType<CliRuntime["replay"]>>) {
  return lines([
    `Run: ${replayed.state.runId}`,
    `Status: ${replayed.state.status}`,
    `Phase: ${replayed.state.phase}`,
    `Events replayed: ${replayed.events.length}`,
    `Last event: ${replayed.state.lastEventId}`
  ]);
}

function renderReport(
  report: Awaited<ReturnType<CliRuntime["writeRunReport"]>>
) {
  return lines([
    `Run: ${report.runId}`,
    `Summary: ${report.summaryPath}`,
    "",
    report.markdown.trimEnd()
  ]);
}

function formatHarness(state: {
  id: string;
  version: string;
  specHash: string;
}) {
  return `${state.id}@${state.version} (${state.specHash})`;
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

function fail(stderr: string): CliExecution {
  return {
    exitCode: 1,
    stdout: "",
    stderr
  };
}

function messageForError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return [
    "Usage:",
    "  specwright run --cwd <path> --task <task> [--harness <id-or-path>] [--json]",
    "  specwright status <run-id> [--root <path>] [--json]",
    "  specwright events <run-id> [--root <path>] [--json]",
    "  specwright replay <run-id> [--root <path>] [--json]",
    "  specwright report <run-id> [--root <path>] [--json]"
  ].join("\n");
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
