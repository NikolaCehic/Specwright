import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EvidenceRecordSchema,
  type EvidenceRecord,
  type SourceRef
} from "@specwright/schemas";
import { getRunStorePaths } from "@specwright/run-store";

export const EVIDENCE_INDEX_FILE = "index.jsonl";
export const EVIDENCE_RECORDS_DIR = "records";

export type EvidenceStoreErrorCode =
  | "evidence_exists"
  | "evidence_not_found"
  | "invalid_evidence"
  | "unsupported_source_fact";

export class EvidenceStoreError extends Error {
  readonly code: EvidenceStoreErrorCode;

  constructor(code: EvidenceStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "EvidenceStoreError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type EvidenceStorePaths = {
  runDir: string;
  evidenceDir: string;
  recordsDir: string;
  indexPath: string;
};

export type EvidenceStoreOptions = {
  rootDir?: string | undefined;
  runId: string;
};

export type AppendEvidenceOptions = EvidenceStoreOptions & {
  record: EvidenceRecord;
};

export type ReadEvidenceOptions = EvidenceStoreOptions & {
  evidenceId: string;
};

type EvidenceIndexEntry = {
  id: string;
  uri: string;
};

export class EvidenceStore {
  readonly rootDir: string | undefined;
  readonly runId: string;

  constructor(options: EvidenceStoreOptions) {
    this.rootDir = options.rootDir;
    this.runId = options.runId;
  }

  async append(record: EvidenceRecord): Promise<EvidenceRecord> {
    return appendEvidence({
      rootDir: this.rootDir,
      runId: this.runId,
      record
    });
  }

  async read(evidenceId: string): Promise<EvidenceRecord> {
    return readEvidence({
      rootDir: this.rootDir,
      runId: this.runId,
      evidenceId
    });
  }

  async list(): Promise<EvidenceRecord[]> {
    return listEvidence({
      rootDir: this.rootDir,
      runId: this.runId
    });
  }

  paths(): EvidenceStorePaths {
    return getEvidenceStorePaths(this.rootDir, this.runId);
  }
}

export function getEvidenceStorePaths(
  rootDir: string | undefined,
  runId: string
): EvidenceStorePaths {
  const runPaths = getRunStorePaths(rootDir, runId);
  const recordsDir = join(runPaths.evidenceDir, EVIDENCE_RECORDS_DIR);

  return {
    runDir: runPaths.runDir,
    evidenceDir: runPaths.evidenceDir,
    recordsDir,
    indexPath: join(runPaths.evidenceDir, EVIDENCE_INDEX_FILE)
  };
}

export async function appendEvidence(
  options: AppendEvidenceOptions
): Promise<EvidenceRecord> {
  const record = validateEvidenceRecord(withEvidenceDefaults(options.record));
  const paths = getEvidenceStorePaths(options.rootDir, options.runId);
  const uri = evidenceRecordUri(record.id);

  await mkdir(paths.recordsDir, { recursive: true });

  try {
    await writeFile(
      join(paths.evidenceDir, uri),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: "wx" }
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new EvidenceStoreError(
        "evidence_exists",
        `Evidence record ${record.id} already exists`,
        error
      );
    }

    throw error;
  }

  await appendJsonLine(paths.indexPath, {
    id: record.id,
    uri
  } satisfies EvidenceIndexEntry);

  return record;
}

export async function readEvidence(
  options: ReadEvidenceOptions
): Promise<EvidenceRecord> {
  const paths = getEvidenceStorePaths(options.rootDir, options.runId);
  const uri = evidenceRecordUri(options.evidenceId);

  try {
    return parseEvidenceRecord(
      await readFile(join(paths.evidenceDir, uri), "utf8"),
      options.evidenceId
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new EvidenceStoreError(
        "evidence_not_found",
        `Evidence record ${options.evidenceId} was not found`,
        error
      );
    }

    throw error;
  }
}

export async function listEvidence(
  options: EvidenceStoreOptions
): Promise<EvidenceRecord[]> {
  const paths = getEvidenceStorePaths(options.rootDir, options.runId);
  let rawIndex: string;

  try {
    rawIndex = await readFile(paths.indexPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const entries = parseIndex(rawIndex);

  return Promise.all(
    entries.map((entry) =>
      parseEvidenceRecord(
        readFile(join(paths.evidenceDir, entry.uri), "utf8"),
        entry.id
      )
    )
  );
}

export function validateEvidenceRecord(record: EvidenceRecord): EvidenceRecord {
  const parsed = EvidenceRecordSchema.safeParse(record);

  if (!parsed.success) {
    const unsupportedSourceFactIssue = parsed.error.issues.find((issue) =>
      isUnsupportedSourceFactMessage(issue.message)
    );

    if (unsupportedSourceFactIssue !== undefined) {
      throw new EvidenceStoreError(
        "unsupported_source_fact",
        unsupportedSourceFactIssue.message,
        parsed.error
      );
    }

    throw new EvidenceStoreError(
      "invalid_evidence",
      "Evidence record does not match the evidence schema",
      parsed.error
    );
  }

  return parsed.data;
}

function withEvidenceDefaults(record: EvidenceRecord): EvidenceRecord {
  return {
    ...record,
    redactionPolicy: record.redactionPolicy ?? "operator",
    sourceRefs: record.sourceRefs.map((sourceRef) =>
      normalizeSourceRef(sourceRef, record)
    )
  };
}

function normalizeSourceRef(
  sourceRef: SourceRef,
  record: EvidenceRecord
): SourceRef {
  if (typeof sourceRef === "string") {
    return sourceRef;
  }

  return {
    ...sourceRef,
    authority: sourceRef.authority ?? record.authority,
    redactionClass: sourceRef.redactionClass ?? "operator",
    ...(sourceRef.captureToolCallId === undefined &&
    record.createdBy.toolCallId !== undefined
      ? { captureToolCallId: record.createdBy.toolCallId }
      : {})
  };
}

function isUnsupportedSourceFactMessage(message: string) {
  return (
    message.endsWith("evidence must include sourceRefs") ||
    message === "conflict evidence must include at least two sourceRefs" ||
    message === "source_fact evidence cannot use model or generated authority" ||
    message === "source_fact evidence sourceRefs must carry trusted authority"
  );
}

function parseEvidenceRecord(
  rawOrPromise: string | Promise<string>,
  expectedId: string
): Promise<EvidenceRecord>;
function parseEvidenceRecord(rawOrPromise: string, expectedId: string): EvidenceRecord;
function parseEvidenceRecord(
  rawOrPromise: string | Promise<string>,
  expectedId: string
) {
  if (typeof rawOrPromise !== "string") {
    return rawOrPromise.then((raw) => parseEvidenceRecord(raw, expectedId));
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawOrPromise) as unknown;
  } catch (error) {
    throw new EvidenceStoreError(
      "invalid_evidence",
      `Evidence record ${expectedId} contains invalid JSON`,
      error
    );
  }

  const record = validateEvidenceRecord(parsedJson as EvidenceRecord);

  if (record.id !== expectedId) {
    throw new EvidenceStoreError(
      "invalid_evidence",
      `Evidence record ${record.id} did not match expected id ${expectedId}`
    );
  }

  return record;
}

function parseIndex(raw: string): EvidenceIndexEntry[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw new EvidenceStoreError(
        "invalid_evidence",
        `Evidence index line ${index + 1} contains invalid JSON`,
        error
      );
    }

    if (
      !isRecord(parsedJson) ||
      typeof parsedJson.id !== "string" ||
      parsedJson.id.length === 0 ||
      typeof parsedJson.uri !== "string" ||
      parsedJson.uri.length === 0
    ) {
      throw new EvidenceStoreError(
        "invalid_evidence",
        `Evidence index line ${index + 1} is invalid`
      );
    }

    return {
      id: parsedJson.id,
      uri: parsedJson.uri
    };
  });
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

function evidenceRecordUri(id: string) {
  return `${EVIDENCE_RECORDS_DIR}/${encodeURIComponent(id)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}
