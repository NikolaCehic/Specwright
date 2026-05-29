import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactRecordSchema,
  type ArtifactFileRef,
  type ArtifactRecord,
  type ClaimLevel,
  type MvpArtifactType
} from "@specwright/schemas";
import { getRunStorePaths } from "@specwright/run-store";

export const ARTIFACT_INDEX_FILE = "index.jsonl";
export const ARTIFACT_RECORDS_DIR = "records";

export const MVP_ARTIFACT_FILENAMES = {
  "run-input": "run-input.json",
  "source-inventory": "source-inventory.json",
  "evidence-graph": "evidence-graph.json",
  plan: "plan.json",
  "eval-report": "eval-report.json",
  summary: "summary.md"
} satisfies Record<MvpArtifactType, string>;

export type ArtifactStoreErrorCode =
  | "artifact_exists"
  | "artifact_not_found"
  | "generated_self_citation"
  | "invalid_artifact"
  | "unsupported_claim";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type ArtifactStorePaths = {
  runDir: string;
  artifactsDir: string;
  recordsDir: string;
  indexPath: string;
};

export type ArtifactStoreOptions = {
  rootDir?: string | undefined;
  runId: string;
};

export type ArtifactRecordInput = Omit<ArtifactRecord, "metadata"> & {
  metadata?: Record<string, unknown> | undefined;
};

export type AppendArtifactOptions = ArtifactStoreOptions & {
  record: ArtifactRecordInput;
};

export type ReadArtifactOptions = ArtifactStoreOptions & {
  artifactId: string;
};

type ArtifactIndexEntry = {
  artifactId: string;
  artifactType: MvpArtifactType;
  uri: string;
};

export class ArtifactStore {
  readonly rootDir: string | undefined;
  readonly runId: string;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.runId = options.runId;
  }

  async append(record: ArtifactRecordInput): Promise<ArtifactRecord> {
    return appendArtifact({
      rootDir: this.rootDir,
      runId: this.runId,
      record
    });
  }

  async read(artifactId: string): Promise<ArtifactRecord> {
    return readArtifact({
      rootDir: this.rootDir,
      runId: this.runId,
      artifactId
    });
  }

  async list(): Promise<ArtifactRecord[]> {
    return listArtifacts({
      rootDir: this.rootDir,
      runId: this.runId
    });
  }

  paths(): ArtifactStorePaths {
    return getArtifactStorePaths(this.rootDir, this.runId);
  }
}

export function getArtifactStorePaths(
  rootDir: string | undefined,
  runId: string
): ArtifactStorePaths {
  const runPaths = getRunStorePaths(rootDir, runId);
  const recordsDir = join(runPaths.artifactsDir, ARTIFACT_RECORDS_DIR);

  return {
    runDir: runPaths.runDir,
    artifactsDir: runPaths.artifactsDir,
    recordsDir,
    indexPath: join(runPaths.artifactsDir, ARTIFACT_INDEX_FILE)
  };
}

export async function appendArtifact(
  options: AppendArtifactOptions
): Promise<ArtifactRecord> {
  const paths = getArtifactStorePaths(options.rootDir, options.runId);
  const record = validateArtifactRecord(
    withArtifactDefaults(options.record, paths)
  );
  const recordUri = artifactRecordUri(record.artifactId);

  await mkdir(paths.recordsDir, { recursive: true });

  if (record.content !== undefined && record.fileRef !== undefined) {
    await writeArtifactContent(paths, record);
  }

  try {
    await writeFile(
      join(paths.artifactsDir, recordUri),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: "wx" }
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ArtifactStoreError(
        "artifact_exists",
        `Artifact record ${record.artifactId} already exists`,
        error
      );
    }

    throw error;
  }

  await appendJsonLine(paths.indexPath, {
    artifactId: record.artifactId,
    artifactType: record.artifactType,
    uri: recordUri
  } satisfies ArtifactIndexEntry);

  return record;
}

export async function readArtifact(
  options: ReadArtifactOptions
): Promise<ArtifactRecord> {
  const paths = getArtifactStorePaths(options.rootDir, options.runId);
  const uri = artifactRecordUri(options.artifactId);
  let record: ArtifactRecord;

  try {
    record = parseArtifactRecord(
      await readFile(join(paths.artifactsDir, uri), "utf8"),
      options.artifactId
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ArtifactStoreError(
        "artifact_not_found",
        `Artifact record ${options.artifactId} was not found`,
        error
      );
    }

    throw error;
  }

  if (record.content !== undefined || record.fileRef === undefined) {
    return record;
  }

  return {
    ...record,
    content: await readArtifactContent(paths, record)
  };
}

export async function listArtifacts(
  options: ArtifactStoreOptions
): Promise<ArtifactRecord[]> {
  const paths = getArtifactStorePaths(options.rootDir, options.runId);
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
      readArtifact({
        rootDir: options.rootDir,
        runId: options.runId,
        artifactId: entry.artifactId
      })
    )
  );
}

export function validateArtifactRecord(record: ArtifactRecord): ArtifactRecord {
  const parsed = ArtifactRecordSchema.safeParse(record);

  if (!parsed.success) {
    throw new ArtifactStoreError(
      "invalid_artifact",
      "Artifact record does not match the artifact schema",
      parsed.error
    );
  }

  assertClaimSupport(parsed.data);
  assertNoSelfCitation(parsed.data);

  return parsed.data;
}

function withArtifactDefaults(
  input: ArtifactRecordInput,
  paths: ArtifactStorePaths
): ArtifactRecord {
  const fileRef =
    input.fileRef === undefined && input.content !== undefined
      ? defaultFileRef(paths, input.artifactType)
      : input.fileRef;
  const normalizedFileRef =
    fileRef === undefined ? undefined : normalizeFileRef(paths, fileRef);
  const evidenceRefs = uniqueStrings(input.evidenceRefs);
  const metadata = {
    ...(input.metadata ?? {}),
    evidenceRefs,
    producedBy: input.producedBy
  };
  const candidate = {
    ...input,
    evidenceRefs,
    ...(normalizedFileRef === undefined ? {} : { fileRef: normalizedFileRef }),
    metadata
  };

  return candidate as ArtifactRecord;
}

function assertClaimSupport(record: ArtifactRecord) {
  if (
    record.claimLevel !== undefined &&
    requiresEvidence(record.claimLevel) &&
    record.evidenceRefs.length === 0
  ) {
    throw new ArtifactStoreError(
      "unsupported_claim",
      `${record.claimLevel} artifact claims must include evidenceRefs`
    );
  }

  for (const claim of record.importantClaims ?? []) {
    if (requiresEvidence(claim.claimLevel) && claim.evidenceRefs.length === 0) {
      throw new ArtifactStoreError(
        "unsupported_claim",
        `${claim.claimLevel} important claims must include evidenceRefs`
      );
    }

    if (
      claim.claimLevel === "source_fact" &&
      (claim.authority === "model" || claim.authority === "generated")
    ) {
      throw new ArtifactStoreError(
        "unsupported_claim",
        "source_fact claims cannot use model or generated authority"
      );
    }
  }
}

function assertNoSelfCitation(record: ArtifactRecord) {
  const evidenceRefs = [
    ...record.evidenceRefs,
    ...(record.importantClaims ?? []).flatMap((claim) => claim.evidenceRefs)
  ];

  for (const evidenceRef of evidenceRefs) {
    if (isSelfCitation(record, evidenceRef)) {
      throw new ArtifactStoreError(
        "generated_self_citation",
        `Artifact ${record.artifactId} cannot cite itself as evidence`
      );
    }
  }
}

function isSelfCitation(record: ArtifactRecord, evidenceRef: string) {
  const selfRefs = [
    record.artifactId,
    `artifact:${record.artifactId}`,
    `artifact:${record.artifactType}`,
    record.fileRef?.uri,
    record.fileRef === undefined ? undefined : `artifact:${record.fileRef.uri}`
  ].filter((value): value is string => value !== undefined);

  return selfRefs.some(
    (selfRef) => evidenceRef === selfRef || evidenceRef.startsWith(`${selfRef}#`)
  );
}

function requiresEvidence(claimLevel: ClaimLevel) {
  return (
    claimLevel === "source_fact" ||
    claimLevel === "derived_fact" ||
    claimLevel === "inference" ||
    claimLevel === "human_decision"
  );
}

async function writeArtifactContent(
  paths: ArtifactStorePaths,
  record: ArtifactRecord
) {
  if (record.fileRef === undefined) {
    return;
  }

  const path = pathForArtifactUri(paths, record.fileRef.uri);

  try {
    await writeFile(path, serializeArtifactContent(record), { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new ArtifactStoreError(
        "artifact_exists",
        `Artifact content already exists at ${record.fileRef.uri}`,
        error
      );
    }

    throw error;
  }
}

async function readArtifactContent(
  paths: ArtifactStorePaths,
  record: ArtifactRecord
) {
  if (record.fileRef === undefined) {
    return undefined;
  }

  let raw: string;

  try {
    raw = await readFile(pathForArtifactUri(paths, record.fileRef.uri), "utf8");
  } catch (error) {
    throw new ArtifactStoreError(
      "artifact_not_found",
      `Artifact content ${record.fileRef.uri} was not found`,
      error
    );
  }

  if (record.artifactType === "summary") {
    return raw;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function serializeArtifactContent(record: ArtifactRecord) {
  if (record.artifactType === "summary") {
    return typeof record.content === "string"
      ? record.content
      : `${JSON.stringify(record.content, null, 2)}\n`;
  }

  return typeof record.content === "string"
    ? record.content
    : `${JSON.stringify(record.content, null, 2)}\n`;
}

function defaultFileRef(
  paths: ArtifactStorePaths,
  artifactType: MvpArtifactType
): ArtifactFileRef {
  const filename = MVP_ARTIFACT_FILENAMES[artifactType];
  const uri = `artifacts/${filename}`;

  return {
    uri,
    path: pathForArtifactUri(paths, uri)
  };
}

function normalizeFileRef(
  paths: ArtifactStorePaths,
  fileRef: ArtifactFileRef
): ArtifactFileRef {
  const uri = normalizeArtifactUri(fileRef.uri);

  return {
    ...fileRef,
    uri,
    path: pathForArtifactUri(paths, uri)
  };
}

function normalizeArtifactUri(uri: string) {
  if (uri.startsWith("/") || uri.includes("\\") || uri.includes("..")) {
    throw new ArtifactStoreError(
      "invalid_artifact",
      "Artifact file refs must stay inside the run artifacts directory"
    );
  }

  return uri.startsWith("artifacts/") ? uri : `artifacts/${uri}`;
}

function pathForArtifactUri(paths: ArtifactStorePaths, uri: string) {
  const normalized = normalizeArtifactUri(uri);
  const relativePath = normalized.slice("artifacts/".length);

  if (relativePath.length === 0) {
    throw new ArtifactStoreError(
      "invalid_artifact",
      "Artifact file ref must point to a file"
    );
  }

  return join(paths.artifactsDir, relativePath);
}

function parseArtifactRecord(raw: string, expectedId: string) {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ArtifactStoreError(
      "invalid_artifact",
      `Artifact record ${expectedId} contains invalid JSON`,
      error
    );
  }

  const record = validateArtifactRecord(parsedJson as ArtifactRecord);

  if (record.artifactId !== expectedId) {
    throw new ArtifactStoreError(
      "invalid_artifact",
      `Artifact record ${record.artifactId} did not match expected id ${expectedId}`
    );
  }

  return record;
}

function parseIndex(raw: string): ArtifactIndexEntry[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw new ArtifactStoreError(
        "invalid_artifact",
        `Artifact index line ${index + 1} contains invalid JSON`,
        error
      );
    }

    if (
      !isRecord(parsedJson) ||
      typeof parsedJson.artifactId !== "string" ||
      parsedJson.artifactId.length === 0 ||
      typeof parsedJson.artifactType !== "string" ||
      parsedJson.artifactType.length === 0 ||
      typeof parsedJson.uri !== "string" ||
      parsedJson.uri.length === 0
    ) {
      throw new ArtifactStoreError(
        "invalid_artifact",
        `Artifact index line ${index + 1} is invalid`
      );
    }

    return parsedJson as ArtifactIndexEntry;
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

function artifactRecordUri(id: string) {
  return `${ARTIFACT_RECORDS_DIR}/${encodeURIComponent(id)}.json`;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}
