import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendJsonLine, getRunStorePaths } from "@specwright/run-store";
import {
  McpAuditRecordSchema,
  type McpAuditRecord
} from "./schemas";

export const MCP_AUDIT_DIR = "mcp-audit";
export const MCP_AUDIT_FILE = "mcp-audit.jsonl";
export const MCP_AUDIT_INDEX_FILE = "audit.jsonl";
export const MCP_AUDIT_SESSIONS_DIR = "sessions";

export type McpAuditWriter = {
  write(record: McpAuditRecord): Promise<McpAuditRecord>;
};

export type McpAuditWriterOptions = {
  rootDir?: string | undefined;
};

export type ReadMcpAuditRecordsOptions = {
  rootDir?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  includeIndex?: boolean | undefined;
};

export type McpAuditWriteErrorCode =
  | "invalid_audit_record"
  | "audit_write_failed"
  | "audit_read_failed";

export class McpAuditWriteError extends Error {
  readonly code: McpAuditWriteErrorCode;

  constructor(code: McpAuditWriteErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "McpAuditWriteError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export function createMcpAuditWriter(
  options: McpAuditWriterOptions = {}
): McpAuditWriter {
  return {
    async write(record) {
      return appendMcpAuditRecord({
        rootDir: options.rootDir,
        record
      });
    }
  };
}

export async function appendMcpAuditRecord(input: {
  rootDir?: string | undefined;
  record: McpAuditRecord;
}): Promise<McpAuditRecord> {
  const parsed = McpAuditRecordSchema.safeParse(input.record);

  if (!parsed.success) {
    throw new McpAuditWriteError(
      "invalid_audit_record",
      "MCP audit record failed schema validation before write.",
      parsed.error
    );
  }

  const paths = auditPathsForRecord(input.rootDir, parsed.data);

  try {
    await appendToJsonl(paths.primaryPath, parsed.data);

    if (paths.indexPath !== paths.primaryPath) {
      await appendToJsonl(paths.indexPath, parsed.data);
    }

    if (
      paths.sessionPath !== undefined &&
      paths.sessionPath !== paths.primaryPath &&
      paths.sessionPath !== paths.indexPath
    ) {
      await appendToJsonl(paths.sessionPath, parsed.data);
    }
  } catch (error) {
    throw new McpAuditWriteError(
      "audit_write_failed",
      "MCP audit record could not be written durably.",
      error
    );
  }

  return parsed.data;
}

export async function readMcpAuditRecords(
  options: ReadMcpAuditRecordsOptions = {}
): Promise<McpAuditRecord[]> {
  const paths = new Set<string>();

  if (options.runId !== undefined) {
    paths.add(getMcpRunAuditPath(options.rootDir, options.runId));
  }

  if (options.sessionId !== undefined) {
    paths.add(getMcpSessionAuditPath(options.rootDir, options.sessionId));
  }

  if (options.includeIndex ?? paths.size === 0) {
    paths.add(getMcpAuditIndexPath(options.rootDir));
  }

  const records: McpAuditRecord[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    for (const record of await readAuditJsonl(path)) {
      if (!seen.has(record.recordId)) {
        records.push(record);
        seen.add(record.recordId);
      }
    }
  }

  return records.sort(compareAuditRecords);
}

export async function readAllMcpAuditRecords(
  rootDir?: string | undefined
): Promise<McpAuditRecord[]> {
  const indexRecords = await readMcpAuditRecords({
    rootDir,
    includeIndex: true
  });

  if (indexRecords.length > 0) {
    return indexRecords;
  }

  const auditPaths = await discoverAuditPaths(rootDir);
  const records: McpAuditRecord[] = [];
  const seen = new Set<string>();

  for (const path of auditPaths) {
    for (const record of await readAuditJsonl(path)) {
      if (!seen.has(record.recordId)) {
        records.push(record);
        seen.add(record.recordId);
      }
    }
  }

  return records.sort(compareAuditRecords);
}

export function getMcpAuditRoot(rootDir?: string | undefined) {
  return join(resolve(rootDir ?? "."), ".specwright", MCP_AUDIT_DIR);
}

export function getMcpAuditIndexPath(rootDir?: string | undefined) {
  return join(getMcpAuditRoot(rootDir), MCP_AUDIT_INDEX_FILE);
}

export function getMcpRunAuditPath(
  rootDir: string | undefined,
  runId: string
) {
  return join(getRunStorePaths(rootDir, runId).runDir, MCP_AUDIT_FILE);
}

export function getMcpSessionAuditPath(
  rootDir: string | undefined,
  sessionId: string
) {
  return join(
    getMcpAuditRoot(rootDir),
    MCP_AUDIT_SESSIONS_DIR,
    safePathSegment(sessionId),
    MCP_AUDIT_FILE
  );
}

async function appendToJsonl(path: string, record: McpAuditRecord) {
  await mkdir(dirnamePath(path), { recursive: true });
  await appendJsonLine(path, record);
}

async function readAuditJsonl(path: string): Promise<McpAuditRecord[]> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw new McpAuditWriteError(
      "audit_read_failed",
      "MCP audit file could not be read.",
      error
    );
  }

  const records: McpAuditRecord[] = [];
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const parsedJson = JSON.parse(line) as unknown;
    const parsed = McpAuditRecordSchema.safeParse(parsedJson);

    if (!parsed.success) {
      throw new McpAuditWriteError(
        "invalid_audit_record",
        "MCP audit file contains a record that no longer validates.",
        parsed.error
      );
    }

    records.push(parsed.data);
  }

  return records;
}

async function discoverAuditPaths(rootDir?: string | undefined) {
  const root = resolve(rootDir ?? ".");
  const runRoot = join(root, ".specwright", "runs");
  const paths: string[] = [getMcpAuditIndexPath(root)];

  try {
    for (const runId of await readdir(runRoot)) {
      paths.push(getMcpRunAuditPath(root, runId));
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  return paths;
}

function auditPathsForRecord(
  rootDir: string | undefined,
  record: McpAuditRecord
) {
  const indexPath = getMcpAuditIndexPath(rootDir);
  const sessionPath =
    record.sessionId === undefined
      ? undefined
      : getMcpSessionAuditPath(rootDir, record.sessionId);
  const primaryPath =
    "runId" in record && record.runId !== undefined
      ? getMcpRunAuditPath(rootDir, record.runId)
      : sessionPath ?? indexPath;

  return {
    primaryPath,
    indexPath,
    sessionPath
  };
}

function compareAuditRecords(left: McpAuditRecord, right: McpAuditRecord) {
  const byTimestamp = left.timestamp.localeCompare(right.timestamp);

  if (byTimestamp !== 0) {
    return byTimestamp;
  }

  return left.recordId.localeCompare(right.recordId);
}

function dirnamePath(path: string) {
  const index = path.lastIndexOf("/");

  return index === -1 ? "." : path.slice(0, index);
}

function safePathSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
