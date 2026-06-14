#!/usr/bin/env bun
import { resolve } from "node:path";
import { createRuntime } from "@specwright/runtime";
import {
  createMcpAdapter,
  type McpAuthOptions,
  type SubjectClaim
} from "./index.js";
import {
  MCP_STDIO_SERVER_NAME,
  serveMcpStdio,
  type McpStdioRequestContext,
  type StdioStreamWriter
} from "./stdio.js";

const stdioProcess = process as typeof process & {
  stdin: AsyncIterable<Uint8Array>;
};

type BinOptions =
  | {
      ok: true;
      rootDir: string;
      workspaceRoot?: string | undefined;
      auth: McpAuthOptions;
      requestContext?: McpStdioRequestContext | undefined;
    }
  | {
      ok: false;
      exitCode: number;
      message: string;
    };

const options = parseOptions(process.argv.slice(2));

if (!options.ok) {
  process.stderr.write(`${options.message}\n`);
  process.exitCode = options.exitCode;
} else {
  const runtime = createRuntime({
    rootDir: options.rootDir,
    workspaceRoot: options.workspaceRoot ?? options.rootDir
  });
  const adapter = createMcpAdapter(runtime, {
    auth: options.auth
  });

  await serveMcpStdio({
    adapter,
    stdin: stdioProcess.stdin,
    stdout: process.stdout as StdioStreamWriter,
    stderr: process.stderr as StdioStreamWriter,
    requestContext: options.requestContext
  });
}

function parseOptions(argv: readonly string[]): BinOptions {
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

  if (profile === "local-stdio") {
    return {
      ok: true,
      rootDir: rootValidation.rootDir,
      ...(rootValidation.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: rootValidation.workspaceRoot }),
      auth: {
        mode: "disabled"
      }
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
  | Extract<BinOptions, { ok: false }> {
  if (typeof root !== "string") {
    return {
      ok: false,
      exitCode: 2,
      message: "Missing required --root <path> for the local stdio server."
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
    requestContext: {
      credential,
      subject
    }
  };
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

function missingCiFlag(flag: string): BinOptions {
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
    "",
    "This executable speaks MCP JSON-RPC over stdio. Stdout is reserved for MCP messages."
  ].join("\n");
}
