#!/usr/bin/env bun
import { resolve } from "node:path";
import { createRuntime } from "@specwright/runtime";
import {
  createMcpAdapter,
  type McpAuthOptions,
  type McpObservabilityOptions,
  type SubjectClaim
} from "./index.js";
import {
  MCP_STDIO_SERVER_NAME,
  MCP_STDIO_PROTOCOL_VERSION,
  serveMcpStdio,
  type McpStdioRequestContext,
  type StdioStreamWriter
} from "./stdio.js";

const stdioProcess = process as typeof process & {
  stdin: AsyncIterable<Uint8Array>;
  cwd(): string;
};

type BinOptions =
  | {
      ok: true;
      mode: "serve";
      rootDir: string;
      workspaceRoot?: string | undefined;
      auth: McpAuthOptions;
      observability: McpObservabilityOptions;
      requestContext?: McpStdioRequestContext | undefined;
    }
  | {
      ok: true;
      mode: "host-config";
      config: string;
    }
  | {
      ok: false;
      exitCode: number;
      message: string;
    };

type BinParseError = Extract<BinOptions, { ok: false }>;

const options = parseOptions(process.argv.slice(2), stdioProcess.cwd());

if (!options.ok) {
  process.stderr.write(`${options.message}\n`);
  process.exitCode = options.exitCode;
} else if (options.mode === "host-config") {
  process.stdout.write(`${options.config}\n`);
} else {
  const runtime = createRuntime({
    rootDir: options.rootDir,
    workspaceRoot: options.workspaceRoot ?? options.rootDir
  });
  const adapter = createMcpAdapter(runtime, {
    auth: options.auth,
    observability: options.observability
  });

  await serveMcpStdio({
    adapter,
    stdin: stdioProcess.stdin,
    stdout: process.stdout as StdioStreamWriter,
    stderr: process.stderr as StdioStreamWriter,
    requestContext: options.requestContext
  });
}

function parseOptions(argv: readonly string[], cwd: string): BinOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      ok: false,
      exitCode: 0,
      message: usage()
    };
  }

  const flags = parseFlags(argv);
  const profile = flags.profile;
  const root = flags.root;
  const workspaceRoot = flags["workspace-root"];
  const rootValidation = validateRoot(root, workspaceRoot);

  if (!rootValidation.ok) {
    return rootValidation;
  }

  const hostConfig = stringFlag(flags, "print-host-config");

  if (hostConfig !== undefined) {
    return hostConfigOptions(flags, hostConfig, rootValidation, cwd);
  }

  if (profile === "local-stdio") {
    return {
      ok: true,
      mode: "serve",
      rootDir: rootValidation.rootDir,
      ...(rootValidation.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: rootValidation.workspaceRoot }),
      auth: {
        mode: "disabled"
      },
      observability: observabilityOptions(rootValidation.rootDir, flags, {
        clientId: "local-stdio",
        subjectId: "local-user",
        tenantId: "local",
        grantedScopes: [],
        runMode: "assisted"
      })
    };
  }

  if (profile === "ci") {
    return ciProfileOptions(flags, rootValidation);
  }

  return {
    ok: false,
    exitCode: 2,
    message:
      "Missing explicit MCP profile. Use --profile local-stdio or --profile ci."
  };
}

function validateRoot(
  root: string | true | undefined,
  workspaceRoot: string | true | undefined
):
  | {
      ok: true;
      rootDir: string;
      workspaceRoot?: string | undefined;
    }
  | BinParseError {
  if (typeof root !== "string") {
    return {
      ok: false,
      exitCode: 2,
      message: "Missing required --root <path> for the MCP stdio server."
    };
  }

  if (workspaceRoot !== undefined && typeof workspaceRoot !== "string") {
    return {
      ok: false,
      exitCode: 2,
      message: "--workspace-root requires a path."
    };
  }

  return {
    ok: true,
    rootDir: resolve(root),
    ...(workspaceRoot === undefined
      ? {}
      : {
          workspaceRoot: resolve(workspaceRoot)
        })
  };
}

function ciProfileOptions(
  flags: Record<string, string | true>,
  rootValidation: Extract<ReturnType<typeof validateRoot>, { ok: true }>
): BinOptions {
  const profile = ciProfileSettings(flags);

  if (!profile.ok) {
    return profile;
  }

  const {
    clientId,
    tenantId,
    grantedScopes,
    subjectId,
    effectiveSubjectScopes,
    runMode
  } = profile;
  const credential = {
    profile: "ci",
    clientId,
    tenantId,
    scopes: grantedScopes,
    runMode
  };
  const principal = {
    clientId,
    tenantId,
    grantedScopes,
    runMode
  };
  const subject = {
    subjectId,
    tenantId,
    claimRef: `ci:${clientId}`,
    issuedBy: MCP_STDIO_SERVER_NAME
  };

  return {
    ok: true,
    mode: "serve",
    rootDir: rootValidation.rootDir,
    ...(rootValidation.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: rootValidation.workspaceRoot }),
    auth: {
      mode: "authenticated",
      credentialVerifier(candidate) {
        return sameCredential(candidate, credential) ? principal : null;
      },
      requireSubject: true,
      subjectVerifier(claim: SubjectClaim) {
        return claim.subjectId === subject.subjectId &&
          claim.tenantId === subject.tenantId
          ? {
              subjectId: subject.subjectId,
              tenantId: subject.tenantId,
              scopes: effectiveSubjectScopes,
              sourceTrust: {
                profile: "ci"
              }
            }
          : false;
      },
      tenantResolver() {
        return tenantId;
      }
    },
    observability: observabilityOptions(rootValidation.rootDir, flags, {
      clientId,
      subjectId,
      tenantId,
      grantedScopes,
      runMode
    }),
    requestContext: {
      credential,
      subject
    }
  };
}

function ciProfileSettings(
  flags: Record<string, string | true>
):
  | {
      ok: true;
      clientId: string;
      tenantId: string;
      grantedScopes: string[];
      subjectId: string;
      effectiveSubjectScopes: string[];
      runMode: "autonomous" | "assisted" | "read_only";
    }
  | BinParseError {
  const clientId = stringFlag(flags, "client-id");
  const tenantId = stringFlag(flags, "tenant-id");
  const scopes = listFlag(flags, "scopes");
  const subjectScopes = listFlag(flags, "subject-scopes") ?? scopes;
  const runMode = runModeFlag(flags);

  if (clientId === undefined) {
    return missingCiFlag("--client-id <id>");
  }

  if (tenantId === undefined) {
    return missingCiFlag("--tenant-id <id>");
  }

  if (scopes === undefined || scopes.length === 0) {
    return missingCiFlag("--scopes <comma-separated-scopes>");
  }

  if (runMode === undefined) {
    return {
      ok: false,
      exitCode: 2,
      message: "--run-mode must be autonomous, assisted, or read_only."
    };
  }

  const grantedScopes = scopes;
  const subjectId = stringFlag(flags, "subject-id") ?? clientId;
  const effectiveSubjectScopes = subjectScopes ?? grantedScopes;

  return {
    ok: true,
    clientId,
    tenantId,
    grantedScopes,
    subjectId,
    effectiveSubjectScopes,
    runMode
  };
}

function hostConfigOptions(
  flags: Record<string, string | true>,
  host: string,
  rootValidation: Extract<ReturnType<typeof validateRoot>, { ok: true }>,
  cwd: string
): BinOptions {
  const profile = flags.profile;
  const hostTarget = hostConfigTarget(host);

  if (hostTarget === undefined) {
    return {
      ok: false,
      exitCode: 2,
      message:
        "--print-host-config must be codex, claude-code, opencode, or generic."
    };
  }

  if (profile === "local-stdio") {
    return {
      ok: true,
      mode: "host-config",
      config: renderHostConfig(
        hostTarget,
        launchSpec(flags, cwd, [
          "--profile",
          "local-stdio",
          "--root",
          rootValidation.rootDir,
          ...(rootValidation.workspaceRoot === undefined
            ? []
            : ["--workspace-root", rootValidation.workspaceRoot])
        ])
      )
    };
  }

  if (profile === "ci") {
    const parsed = ciProfileSettings(flags);

    if (!parsed.ok) {
      return parsed;
    }

    return {
      ok: true,
      mode: "host-config",
      config: renderHostConfig(
        hostTarget,
        launchSpec(flags, cwd, [
          "--profile",
          "ci",
          "--root",
          rootValidation.rootDir,
          ...(rootValidation.workspaceRoot === undefined
            ? []
            : ["--workspace-root", rootValidation.workspaceRoot]),
          "--client-id",
          parsed.clientId,
          "--tenant-id",
          parsed.tenantId,
          "--scopes",
          parsed.grantedScopes.join(","),
          "--subject-id",
          parsed.subjectId,
          "--subject-scopes",
          parsed.effectiveSubjectScopes.join(","),
          "--run-mode",
          parsed.runMode
        ])
      )
    };
  }

  return {
    ok: false,
    exitCode: 2,
    message:
      "Missing explicit MCP profile. Use --profile local-stdio or --profile ci."
  };
}

type HostConfigTarget = "codex" | "claude-code" | "opencode" | "generic";

type LaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
};

type ObservabilityIdentity = {
  clientId: string;
  subjectId: string;
  tenantId: string;
  grantedScopes: readonly string[];
  runMode: "autonomous" | "assisted" | "read_only";
};

function observabilityOptions(
  rootDir: string,
  flags: Record<string, string | true>,
  identity: ObservabilityIdentity
): McpObservabilityOptions {
  return {
    rootDir,
    session: {
      ...(stringFlag(flags, "session-id") === undefined
        ? {}
        : { sessionId: stringFlag(flags, "session-id") }),
      clientId: identity.clientId,
      subjectId: identity.subjectId,
      tenantId: identity.tenantId,
      grantedScopes: [...identity.grantedScopes],
      runMode: identity.runMode,
      transport: "stdio",
      protocolVersion: MCP_STDIO_PROTOCOL_VERSION
    }
  };
}

function hostConfigTarget(value: string): HostConfigTarget | undefined {
  return value === "codex" ||
    value === "claude-code" ||
    value === "opencode" ||
    value === "generic"
    ? value
    : undefined;
}

function launchSpec(
  flags: Record<string, string | true>,
  cwd: string,
  profileArgs: readonly string[]
): LaunchSpec {
  const command = stringFlag(flags, "launcher") ?? "bun";
  const entry = stringFlag(flags, "entry") ?? "packages/adapters-mcp/dist/bin.js";
  const resolvedEntry = entry.includes("/") ? resolve(cwd, entry) : entry;

  return {
    command,
    args: [resolvedEntry, ...profileArgs],
    cwd
  };
}

function renderHostConfig(target: HostConfigTarget, spec: LaunchSpec) {
  if (target === "codex") {
    return renderCodexConfig(spec);
  }

  if (target === "opencode") {
    return JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          specwright: {
            type: "local",
            command: [spec.command, ...spec.args],
            cwd: spec.cwd,
            enabled: true
          }
        }
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      mcpServers: {
        specwright: {
          type: "stdio",
          command: spec.command,
          args: spec.args,
          env: {}
        }
      }
    },
    null,
    2
  );
}

function renderCodexConfig(spec: LaunchSpec) {
  return [
    '[mcp_servers."specwright"]',
    "enabled = true",
    `command = ${tomlString(spec.command)}`,
    `args = ${tomlStringArray(spec.args)}`,
    `cwd = ${tomlString(spec.cwd)}`,
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 60"
  ].join("\n");
}

function tomlStringArray(values: readonly string[]) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function stringFlag(flags: Record<string, string | true>, name: string) {
  const value = flags[name];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function listFlag(flags: Record<string, string | true>, name: string) {
  const value = stringFlag(flags, name);

  if (value === undefined) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function runModeFlag(flags: Record<string, string | true>) {
  const value = stringFlag(flags, "run-mode") ?? "assisted";

  if (value === "autonomous" || value === "assisted" || value === "read_only") {
    return value;
  }

  return undefined;
}

function sameCredential(candidate: unknown, expected: Record<string, unknown>) {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }

  return JSON.stringify(candidate) === JSON.stringify(expected);
}

function missingCiFlag(flag: string): BinParseError {
  return {
    ok: false,
    exitCode: 2,
    message: `Missing required ${flag} for --profile ci.`
  };
}

function parseFlags(argv: readonly string[]) {
  const flags: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === undefined || !value.startsWith("--")) {
      continue;
    }

    const name = value.slice(2);
    const next = argv[index + 1];

    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return flags;
}

function usage() {
  return [
    `${MCP_STDIO_SERVER_NAME}`,
    "",
    "Usage:",
    `  ${MCP_STDIO_SERVER_NAME} --profile local-stdio --root <path> [--workspace-root <path>]`,
    `  ${MCP_STDIO_SERVER_NAME} --profile ci --root <path> --client-id <id> --tenant-id <id> --scopes <scopes>`,
    `  ${MCP_STDIO_SERVER_NAME} --print-host-config <host> --profile <profile> --root <path>`,
    "",
    "Hosts: codex, claude-code, opencode, generic.",
    "This executable speaks MCP JSON-RPC over stdio. Stdout is reserved for MCP messages while serving; the host-config helper prints snippets to stdout."
  ].join("\n");
}
