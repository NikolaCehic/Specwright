#!/usr/bin/env bun
import { resolve } from "node:path";
import { createRuntime } from "@specwright/runtime";
import { createMcpAdapter } from "./index.js";
import {
  MCP_STDIO_SERVER_NAME,
  serveMcpStdio,
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
    auth: {
      mode: "disabled"
    }
  });

  await serveMcpStdio({
    adapter,
    stdin: stdioProcess.stdin,
    stdout: process.stdout as StdioStreamWriter,
    stderr: process.stderr as StdioStreamWriter
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

  if (profile !== "local-stdio") {
    return {
      ok: false,
      exitCode: 2,
      message:
        "Missing explicit MCP profile. Use --profile local-stdio for the local stdio server."
    };
  }

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
    "",
    "This executable speaks MCP JSON-RPC over stdio. Stdout is reserved for MCP messages."
  ].join("\n");
}
