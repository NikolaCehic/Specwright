import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactRecordSchema,
  isSelfCitingEvidenceRef,
  type ArtifactFileRef,
  type ArtifactClaim,
  type ArtifactRecord,
  type ArtifactType
} from "@specwright/schemas";
import { getRunStorePaths } from "@specwright/run-store";

export const ARTIFACT_INDEX_FILE = "index.jsonl";
export const ARTIFACT_RECORDS_DIR = "records";

export const production_ARTIFACT_FILENAMES = {
  "run-input": "run-input.json",
  "source-inventory": "source-inventory.json",
  "evidence-graph": "evidence-graph.json",
  plan: "plan.json",
  "eval-report": "eval-report.json",
  summary: "summary.md"
} satisfies Record<ArtifactType, string>;

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

export type ArtifactClaimInput = Omit<
  ArtifactClaim,
  | "owningArtifactId"
  | "fieldPath"
  | "owningSection"
  | "verificationStatus"
  | "redactionPolicy"
> &
  Partial<
    Pick<
      ArtifactClaim,
      | "owningArtifactId"
      | "fieldPath"
      | "owningSection"
      | "verificationStatus"
      | "redactionPolicy"
    >
  >;

export type ArtifactRecordInput = Omit<
  ArtifactRecord,
  "metadata" | "importantClaims" | "redactionPolicy"
> & {
  metadata?: Record<string, unknown> | undefined;
  importantClaims?: ArtifactClaimInput[] | undefined;
  redactionPolicy?: ArtifactRecord["redactionPolicy"] | undefined;
};

export type AppendArtifactOptions = ArtifactStoreOptions & {
  record: ArtifactRecordInput;
};

export type ReadArtifactOptions = ArtifactStoreOptions & {
  artifactId: string;
};

type ArtifactIndexEntry = {
  artifactId: string;
  artifactType: ArtifactType;
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
    const mappedError = artifactStoreErrorFromSchema(record, parsed.error);

    if (mappedError !== undefined) {
      throw mappedError;
    }

    throw new ArtifactStoreError(
      "invalid_artifact",
      "Artifact record does not match the artifact schema",
      parsed.error
    );
  }

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
  const redactionPolicy = input.redactionPolicy ?? "operator";
  const candidate = {
    ...input,
    evidenceRefs,
    redactionPolicy,
    importantClaims: normalizeImportantClaims(
      input.artifactId,
      input.importantClaims,
      redactionPolicy
    ),
    ...(normalizedFileRef === undefined ? {} : { fileRef: normalizedFileRef }),
    metadata
  };

  return candidate as ArtifactRecord;
}

function normalizeImportantClaims(
  artifactId: string,
  importantClaims: readonly ArtifactClaimInput[] | undefined,
  redactionPolicy: ArtifactRecord["redactionPolicy"]
): ArtifactClaim[] | undefined {
  if (importantClaims === undefined) {
    return undefined;
  }

  return importantClaims.map((claim, index) => ({
    ...claim,
    owningArtifactId: claim.owningArtifactId ?? artifactId,
    fieldPath:
      claim.fieldPath ??
      (claim.owningSection === undefined
        ? `importantClaims.${index}`
        : undefined),
    verificationStatus: claim.verificationStatus ?? "unverified",
    redactionPolicy: claim.redactionPolicy ?? redactionPolicy
  }));
}

function artifactStoreErrorFromSchema(
  record: ArtifactRecord,
  error: unknown
): ArtifactStoreError | undefined {
  if (!isZodErrorLike(error)) {
    return undefined;
  }

  if (
    record.evidenceRefs.some((ref) => isSelfCitingEvidenceRef(record, ref)) ||
    (record.importantClaims ?? []).some((claim) =>
      claim.evidenceRefs.some((ref) => isSelfCitingEvidenceRef(record, ref))
    ) ||
    error.issues.some((issue) => issue.message.includes("cannot cite itself"))
  ) {
    return new ArtifactStoreError(
      "generated_self_citation",
      `Artifact ${record.artifactId} cannot cite itself as evidence`,
      error
    );
  }

  const unsupportedClaimIssue = error.issues.find((issue) =>
    isUnsupportedClaimMessage(issue.message)
  );

  if (unsupportedClaimIssue !== undefined) {
    return new ArtifactStoreError(
      "unsupported_claim",
      unsupportedClaimIssue.message,
      error
    );
  }

  return undefined;
}

function isUnsupportedClaimMessage(message: string) {
  return (
    message.endsWith("artifact claims must include evidenceRefs") ||
    message.endsWith("important claims must include evidenceRefs") ||
    message === "source_fact claims cannot use model or generated authority"
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
  artifactType: ArtifactType
): ArtifactFileRef {
  const filename = production_ARTIFACT_FILENAMES[artifactType];
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

function isZodErrorLike(
  error: unknown
): error is { issues: Array<{ message: string }> } {
  return (
    isRecord(error) &&
    Array.isArray(error.issues) &&
    error.issues.every(
      (issue) => isRecord(issue) && typeof issue.message === "string"
    )
  );
}

function isNodeError(error: unknown): error is { code: string } {
  return isRecord(error) && typeof error.code === "string";
}
