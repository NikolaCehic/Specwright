import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  ArtifactSchemaRefSchema,
  EvalDefinitionSchema,
  GateDefinitionSchema,
  HarnessManifestSchema,
  HarnessSchemaVersionSchema,
  HarnessSnapshotSchema,
  PhaseDefinitionSchema,
  PolicyBundleSchema,
  PromptAssetRefSchema,
  RoleDefinitionSchema,
  ToolDefinitionSchema,
  type ArtifactSchemaRef,
  type EvalDefinition,
  type GateDefinition,
  type HarnessManifest,
  type HarnessReference,
  type HarnessSchemaVersion,
  type HarnessSnapshot,
  type PhaseDefinition,
  type PolicyBundle,
  type PromptAssetRef,
  type RoleDefinition,
  type ToolDefinition
} from "@specwright/schemas";
import {
  buildTrustRejectedEvent,
  buildTrustVerifiedEvent,
  TrustRejectedError,
  verifyPackageTrust
} from "./trust";
import type {
  HarnessTrustEvent,
  SignatureEnvelope,
  TrustStore,
  TrustVerdict
} from "./trust";

export {
  AttestationSchema,
  HarnessTrustEventSchema,
  HarnessTrustRejectedEventSchema,
  HarnessTrustVerifiedEventSchema,
  InMemoryTrustStore,
  SignatureEnvelopeSchema,
  TrustProvenanceSchema,
  TrustRejectReasonSchema,
  TrustStoreEntrySchema,
  TrustStoreSchema,
  canonicalizeAttestation,
  loadTrustStoreFromFile,
  verifyPackageTrust
} from "./trust";
export type {
  Attestation,
  HarnessTrustEvent,
  SignatureEnvelope,
  TrustProvenance,
  TrustRejectReason,
  TrustStore,
  TrustStoreData,
  TrustStoreEntry,
  TrustVerdict
} from "./trust";

export const HARNESS_MANIFEST_FILE = "harness.yaml";
export const SUPPORTED_HARNESS_SCHEMA_VERSION: HarnessSchemaVersion =
  "specwright.harness.v0";

export type LoadHarnessPackageOptions = {
  packageDir: string;
  loadedAt?: Date | string;
  signature?: SignatureEnvelope;
  trustStore?: TrustStore;
  strict?: boolean;
  trustNow?: Date | string;
  onTrustEvent?(event: HarnessTrustEvent): void | Promise<void>;
};

export type HarnessLoadRecord = {
  snapshot: HarnessSnapshot;
  trust?: TrustVerdict;
};

export type HarnessLoaderErrorCode =
  | "duplicate_id"
  | "invalid_artifact_schema"
  | "invalid_definition"
  | "invalid_graph"
  | "invalid_loaded_at"
  | "invalid_manifest"
  | "invalid_prompt"
  | "missing_harness_manifest"
  | "missing_reference"
  | "parse_error"
  | "trust_rejected"
  | "unsupported_schema_version";

export class HarnessLoaderError extends Error {
  readonly code: HarnessLoaderErrorCode;
  readonly reason: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: HarnessLoaderErrorCode,
    message: string,
    cause?: unknown,
    context: {
      reason?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = "HarnessLoaderError";
    this.code = code;
    this.reason = context.reason;
    this.details = context.details;

    if (cause !== undefined) {
      Object.assign(this, { cause });
    }
  }
}

export type SourceFile = {
  absolutePath: string;
  relativePath: string;
  raw: string;
};

type DefinitionWithSource = {
  id: string;
  sourcePath?: unknown;
};

type PlainRecord = Record<string, unknown>;

type CollectionKey =
  | "phases"
  | "gates"
  | "policies"
  | "tools"
  | "artifacts"
  | "evals"
  | "roles"
  | "prompts";

type GraphEdge = {
  from: string;
  to: string;
};

export async function loadHarnessPackage(
  input: string | LoadHarnessPackageOptions
): Promise<HarnessSnapshot> {
  const record = await loadHarnessPackageWithRecord(input);

  return record.snapshot;
}

export async function loadHarnessPackageWithRecord(
  input: string | LoadHarnessPackageOptions
): Promise<HarnessLoadRecord> {
  const packageDir = resolve(
    typeof input === "string" ? input : input.packageDir
  );
  const loadedAt = normalizeLoadedAt(
    typeof input === "string" ? undefined : input.loadedAt
  );
  const loadedFiles: SourceFile[] = [];
  const manifestFile = await readRequiredFile(
    packageDir,
    HARNESS_MANIFEST_FILE
  );
  loadedFiles.push(manifestFile);

  const manifest = parseManifest(manifestFile);
  const manifestSchemaVersion = manifest.schemaVersion;

  if (manifestSchemaVersion !== SUPPORTED_HARNESS_SCHEMA_VERSION) {
    throw new HarnessLoaderError(
      "unsupported_schema_version",
      `Unsupported harness schemaVersion ${manifestSchemaVersion}`
    );
  }

  const [
    phaseFiles,
    gateFiles,
    policyFiles,
    toolFiles,
    artifactSchemaFiles,
    evalFiles,
    roleFiles,
    promptFiles
  ] = await Promise.all([
    readOptionalDirectory(packageDir, "phases", [".yaml", ".yml", ".json"]),
    readOptionalDirectory(packageDir, "gates", [".yaml", ".yml", ".json"]),
    readOptionalDirectory(packageDir, "policies", [".yaml", ".yml", ".json"]),
    readOptionalDirectory(packageDir, "tools", [".yaml", ".yml", ".json"]),
    readOptionalDirectory(packageDir, "artifact-schemas", [".json"]),
    readOptionalDirectory(packageDir, "evals", [".yaml", ".yml", ".json"]),
    readOptionalDirectory(packageDir, "roles", [".yaml", ".yml", ".json"]),
    readOptionalDirectory(packageDir, "prompts", [".md"])
  ]);

  loadedFiles.push(
    ...phaseFiles,
    ...gateFiles,
    ...policyFiles,
    ...toolFiles,
    ...artifactSchemaFiles,
    ...evalFiles,
    ...roleFiles,
    ...promptFiles
  );

  const phases = orderDefinitions(
    [
      ...inlineDefinitions(
        manifest.phases,
        "phase",
        HARNESS_MANIFEST_FILE,
        parsePhaseDefinition
      ),
      ...phaseFiles.map((file) => parsePhaseDefinition(parseDataFile(file), file))
    ],
    manifestReferences(manifest.phases)
  );
  const gates = orderDefinitions(
    [
      ...inlineDefinitions(
        manifest.gates,
        "gate",
        HARNESS_MANIFEST_FILE,
        parseGateDefinition
      ),
      ...gateFiles.map((file) => parseGateDefinition(parseDataFile(file), file))
    ],
    manifestReferences(manifest.gates)
  );
  const policies = orderDefinitions(
    [
      ...inlineDefinitions(
        manifest.policies,
        "policy",
        HARNESS_MANIFEST_FILE,
        parsePolicyBundle
      ),
      ...policyFiles.map((file) => parsePolicyBundle(parseDataFile(file), file))
    ],
    manifestReferences(manifest.policies)
  );
  const tools = orderDefinitions(
    [
      ...inlineToolDefinitions(manifest),
      ...toolFiles.map((file) => parseToolDefinition(parseDataFile(file), file))
    ],
    manifestToolReferences(manifest)
  );
  const artifacts = orderDefinitions(
    artifactSchemaFiles.map((file) => parseArtifactSchemaFile(file)),
    [
      ...manifestReferences(manifest.artifacts),
      ...manifestReferences(manifest.artifactSchemas)
    ]
  );
  const evals = orderDefinitions(
    [
      ...inlineDefinitions(
        manifest.evals,
        "eval",
        HARNESS_MANIFEST_FILE,
        parseEvalDefinition
      ),
      ...evalFiles.map((file) => parseEvalDefinition(parseDataFile(file), file))
    ],
    manifestReferences(manifest.evals)
  );
  const roles = orderDefinitions(
    [
      ...inlineDefinitions(
        manifest.roles,
        "role",
        HARNESS_MANIFEST_FILE,
        parseRoleDefinition
      ),
      ...roleFiles.map((file) => parseRoleDefinition(parseDataFile(file), file))
    ],
    manifestReferences(manifest.roles)
  );
  const prompts = orderDefinitions(
    promptFiles.map((file) => parsePromptFile(file)),
    manifestReferences(manifest.prompts)
  );

  assertUniqueIds("phase", phases);
  assertUniqueIds("gate", gates);
  assertUniqueIds("policy", policies);
  assertUniqueIds("tool", tools);
  assertUniqueIds("artifact schema", artifacts);
  assertUniqueIds("eval", evals);
  assertUniqueIds("role", roles);
  assertUniqueIds("prompt", prompts);

  validateManifestReferences(manifest, {
    phases,
    gates,
    policies,
    tools,
    artifacts,
    evals,
    roles,
    prompts
  });
  validateDefinitions({
    manifest,
    phases,
    gates,
    policies,
    tools,
    artifacts,
    evals,
    roles,
    prompts
  });

  const specHash = computeSpecHash(loadedFiles);
  const trust = await verifyTrustIfConfigured({ input, loadedFiles, manifest });
  const snapshot = HarnessSnapshotSchema.parse({
    id: manifest.id,
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    specHash,
    loadedAt,
    runtime: manifest.runtime,
    phases,
    gates,
    policies,
    tools,
    artifacts,
    evals,
    roles,
    prompts,
    metadata: mergeTrustProvenance(manifest.metadata, trust)
  });

  return {
    snapshot: deepFreeze(snapshot),
    ...(trust === undefined ? {} : { trust })
  };
}

async function verifyTrustIfConfigured(context: {
  input: string | LoadHarnessPackageOptions;
  loadedFiles: readonly SourceFile[];
  manifest: HarnessManifest;
}) {
  if (typeof context.input === "string") {
    return undefined;
  }

  const trustConfigured =
    context.input.signature !== undefined ||
    context.input.trustStore !== undefined ||
    context.input.strict === true;

  if (!trustConfigured) {
    return undefined;
  }

  try {
    const trust = verifyPackageTrust({
      loadedFiles: context.loadedFiles,
      manifest: context.manifest,
      strict: context.input.strict ?? true,
      computeSpecHash,
      ...(context.input.signature === undefined
        ? {}
        : { envelope: context.input.signature }),
      ...(context.input.trustStore === undefined
        ? {}
        : { trustStore: context.input.trustStore }),
      ...(context.input.trustNow === undefined
        ? {}
        : { now: context.input.trustNow })
    });

    if (trust !== undefined) {
      await emitTrustEvent(context.input, buildTrustVerifiedEvent(trust));
    }

    return trust;
  } catch (error) {
    if (!(error instanceof TrustRejectedError)) {
      throw error;
    }

    await emitTrustEvent(context.input, buildTrustRejectedEvent(error));

    throw new HarnessLoaderError(
      "trust_rejected",
      `Harness package trust rejected: ${error.reason}`,
      error,
      {
        reason: error.reason,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    );
  }
}

async function emitTrustEvent(
  options: LoadHarnessPackageOptions,
  event: HarnessTrustEvent
) {
  await options.onTrustEvent?.(event);
}

function mergeTrustProvenance(
  metadata: unknown,
  trust: TrustVerdict | undefined
) {
  if (trust === undefined) {
    return metadata;
  }

  const merged = isRecord(metadata) ? { ...metadata } : {};
  const provenance = isRecord(merged.provenance)
    ? { ...merged.provenance }
    : {};

  merged.provenance = {
    ...provenance,
    trust: trust.provenance
  };

  return merged;
}

function parseManifest(file: SourceFile): HarnessManifest {
  const parsed = parseDataFile(file);
  const result = HarnessManifestSchema.safeParse(parsed);

  if (!result.success) {
    throw new HarnessLoaderError(
      "invalid_manifest",
      `Harness manifest ${file.relativePath} is invalid: ${result.error.message}`,
      result.error
    );
  }

  return result.data;
}

function parsePhaseDefinition(
  parsed: unknown,
  file: SourceFile
): PhaseDefinition {
  return parseDefinition(
    "phase",
    parsed,
    file,
    PhaseDefinitionSchema.safeParse.bind(PhaseDefinitionSchema)
  );
}

function parseGateDefinition(
  parsed: unknown,
  file: SourceFile
): GateDefinition {
  return parseDefinition(
    "gate",
    parsed,
    file,
    GateDefinitionSchema.safeParse.bind(GateDefinitionSchema)
  );
}

function parsePolicyBundle(
  parsed: unknown,
  file: SourceFile
): PolicyBundle {
  return parseDefinition(
    "policy",
    parsed,
    file,
    PolicyBundleSchema.safeParse.bind(PolicyBundleSchema)
  );
}

function parseToolDefinition(
  parsed: unknown,
  file: SourceFile
): ToolDefinition {
  const tool = parseDefinition(
    "tool",
    parsed,
    file,
    ToolDefinitionSchema.safeParse.bind(ToolDefinitionSchema)
  );

  if (!hasOwn(tool, "inputSchema") || !hasOwn(tool, "outputSchema")) {
    throw new HarnessLoaderError(
      "invalid_definition",
      `Tool ${tool.id} must declare inputSchema and outputSchema`
    );
  }

  return tool;
}

function parseEvalDefinition(
  parsed: unknown,
  file: SourceFile
): EvalDefinition {
  return parseDefinition(
    "eval",
    parsed,
    file,
    EvalDefinitionSchema.safeParse.bind(EvalDefinitionSchema)
  );
}

function parseRoleDefinition(
  parsed: unknown,
  file: SourceFile
): RoleDefinition {
  return parseDefinition(
    "role",
    parsed,
    file,
    RoleDefinitionSchema.safeParse.bind(RoleDefinitionSchema)
  );
}

function parseArtifactSchemaFile(file: SourceFile): ArtifactSchemaRef {
  let schema: unknown;

  try {
    schema = JSON.parse(file.raw);
  } catch (error) {
    throw new HarnessLoaderError(
      "parse_error",
      `Could not parse artifact schema ${file.relativePath}`,
      error
    );
  }

  if (!isRecord(schema)) {
    throw new HarnessLoaderError(
      "invalid_artifact_schema",
      `Artifact schema ${file.relativePath} must be a JSON object`
    );
  }

  const id = stringValue(schema.id) ?? stringValue(schema.$id);
  const version = stringValue(schema.version);

  if (id === undefined) {
    throw new HarnessLoaderError(
      "invalid_artifact_schema",
      `Artifact schema ${file.relativePath} must declare id or $id`
    );
  }

  if (version === undefined) {
    throw new HarnessLoaderError(
      "invalid_artifact_schema",
      `Artifact schema ${file.relativePath} must declare version`
    );
  }

  const parsed = ArtifactSchemaRefSchema.safeParse({
    id,
    version,
    path: file.relativePath,
    schema
  });

  if (!parsed.success) {
    throw new HarnessLoaderError(
      "invalid_artifact_schema",
      `Artifact schema ${file.relativePath} is invalid: ${parsed.error.message}`,
      parsed.error
    );
  }

  return parsed.data;
}

function parsePromptFile(file: SourceFile): PromptAssetRef {
  const frontmatter = parseMarkdownFrontmatter(file);
  const id =
    stringValue(frontmatter.data.id) ??
    stripKnownExtension(basename(file.relativePath));
  const description = stringValue(frontmatter.data.description);
  const prompt = {
    id,
    path: file.relativePath,
    content: frontmatter.content,
    contentHash: hashString(frontmatter.content),
    ...(description === undefined ? {} : { description }),
    metadata: metadataFromFrontmatter(frontmatter.data)
  };
  const parsed = PromptAssetRefSchema.safeParse(prompt);

  if (!parsed.success) {
    throw new HarnessLoaderError(
      "invalid_prompt",
      `Prompt ${file.relativePath} is invalid: ${parsed.error.message}`,
      parsed.error
    );
  }

  return parsed.data;
}

function parseDefinition<TDefinition extends DefinitionWithSource>(
  label: string,
  parsed: unknown,
  file: SourceFile,
  safeParse: (value: unknown) =>
    | { success: true; data: TDefinition }
    | { success: false; error: Error }
): TDefinition {
  if (!isRecord(parsed)) {
    throw new HarnessLoaderError(
      "invalid_definition",
      `${capitalize(label)} definition ${file.relativePath} must be an object`
    );
  }

  const result = safeParse({
    ...parsed,
    sourcePath: file.relativePath
  });

  if (!result.success) {
    throw new HarnessLoaderError(
      "invalid_definition",
      `${capitalize(label)} definition ${file.relativePath} is invalid: ${result.error.message}`,
      result.error
    );
  }

  return result.data;
}

function inlineDefinitions<TDefinition extends DefinitionWithSource>(
  entries: HarnessReference[] | undefined,
  label: string,
  sourcePath: string,
  parser: (parsed: unknown, file: SourceFile) => TDefinition
): TDefinition[] {
  const inlineFile = {
    absolutePath: sourcePath,
    relativePath: sourcePath,
    raw: ""
  };

  return (entries ?? [])
    .filter(isRecord)
    .map((entry) => parser(entry, inlineFile))
    .map((definition) => ({
      ...definition,
      sourcePath
    }));
}

function inlineToolDefinitions(manifest: HarnessManifest): ToolDefinition[] {
  if (!Array.isArray(manifest.tools)) {
    return [];
  }

  return inlineDefinitions(
    manifest.tools,
    "tool",
    HARNESS_MANIFEST_FILE,
    parseToolDefinition
  );
}

function parseDataFile(file: SourceFile): unknown {
  const extension = extname(file.relativePath);

  try {
    if (extension === ".json") {
      return JSON.parse(file.raw);
    }

    return parseSimpleYaml(file.raw);
  } catch (error) {
    throw new HarnessLoaderError(
      "parse_error",
      `Could not parse ${file.relativePath}`,
      error
    );
  }
}

async function readRequiredFile(
  packageDir: string,
  relativePath: string
): Promise<SourceFile> {
  try {
    return await readSourceFile(packageDir, relativePath);
  } catch (error) {
    if (error instanceof HarnessLoaderError) {
      throw error;
    }

    throw new HarnessLoaderError(
      "missing_harness_manifest",
      `Missing required ${relativePath}`,
      error
    );
  }
}

async function readOptionalDirectory(
  packageDir: string,
  dir: string,
  extensions: readonly string[]
): Promise<SourceFile[]> {
  const absoluteDir = resolve(packageDir, dir);
  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .filter((path) => extensions.includes(extname(path)))
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(files.map((path) => readSourceFile(packageDir, path)));
}

async function readSourceFile(
  packageDir: string,
  relativePath: string
): Promise<SourceFile> {
  const absolutePath = resolve(packageDir, relativePath);
  const root = resolve(packageDir);
  const normalizedRelative = normalizeRelativePath(relative(root, absolutePath));

  if (normalizedRelative.startsWith("..")) {
    throw new HarnessLoaderError(
      "parse_error",
      `Refusing to load ${relativePath} outside harness package`
    );
  }

  return {
    absolutePath,
    relativePath: normalizedRelative,
    raw: await readFile(absolutePath, "utf8")
  };
}

function validateManifestReferences(
  manifest: HarnessManifest,
  collections: {
    phases: readonly PhaseDefinition[];
    gates: readonly GateDefinition[];
    policies: readonly PolicyBundle[];
    tools: readonly ToolDefinition[];
    artifacts: readonly ArtifactSchemaRef[];
    evals: readonly EvalDefinition[];
    roles: readonly RoleDefinition[];
    prompts: readonly PromptAssetRef[];
  }
) {
  assertReferencesExist("phase", manifestReferences(manifest.phases), collections.phases);
  assertReferencesExist("gate", manifestReferences(manifest.gates), collections.gates);
  assertReferencesExist(
    "policy",
    manifestReferences(manifest.policies),
    collections.policies
  );
  assertReferencesExist("tool", manifestToolReferences(manifest), collections.tools);
  assertReferencesExist(
    "artifact schema",
    [
      ...manifestReferences(manifest.artifacts),
      ...manifestReferences(manifest.artifactSchemas)
    ],
    collections.artifacts
  );
  assertReferencesExist("eval", manifestReferences(manifest.evals), collections.evals);
  assertReferencesExist("role", manifestReferences(manifest.roles), collections.roles);
  assertReferencesExist(
    "prompt",
    manifestReferences(manifest.prompts),
    collections.prompts
  );
}

function validateDefinitions(context: {
  manifest: HarnessManifest;
  phases: readonly PhaseDefinition[];
  gates: readonly GateDefinition[];
  policies: readonly PolicyBundle[];
  tools: readonly ToolDefinition[];
  artifacts: readonly ArtifactSchemaRef[];
  evals: readonly EvalDefinition[];
  roles: readonly RoleDefinition[];
  prompts: readonly PromptAssetRef[];
}) {
  const phaseIds = idSet(context.phases);
  const gateIds = idSet(context.gates);
  const policyIds = idSet(context.policies);
  const toolIds = idSet(context.tools);
  const artifactIds = idSet(context.artifacts);
  const evalIds = idSet(context.evals);
  const roleIds = idSet(context.roles);
  const promptIds = idSet(context.prompts);
  const edges: GraphEdge[] = [];

  for (const phase of context.phases) {
    assertReferencesInSet("phase gate", phase.id, refsFrom(phase.gates), gateIds);
    assertReferencesInSet("phase tool", phase.id, refsFrom(phase.tools), toolIds);
    assertReferencesInSet("phase eval", phase.id, refsFrom(phase.evals), evalIds);
    assertReferencesInSet(
      "phase artifact schema",
      phase.id,
      [
        ...refsFrom(phase.artifacts),
        ...refsFrom(phase.artifactSchemas)
      ],
      artifactIds
    );

    for (const next of phaseReferences(phase.next)) {
      assertReferencesInSet("phase next", phase.id, [next], phaseIds);
      edges.push({
        from: phase.id,
        to: next
      });
    }

    for (const dependency of [
      ...stringArray(phase.dependsOn),
      ...stringArray(phase.after)
    ]) {
      assertReferencesInSet("phase dependency", phase.id, [dependency], phaseIds);
      edges.push({
        from: dependency,
        to: phase.id
      });
    }
  }

  const initialPhase = context.manifest.initialPhase ?? context.manifest.startPhase;

  if (initialPhase !== undefined) {
    assertReferencesInSet("initial phase", "harness", [initialPhase], phaseIds);
  }

  assertAcyclicPhaseGraph(edges);

  for (const gate of context.gates) {
    if (gate.phase !== undefined) {
      assertReferencesInSet("gate phase", gate.id, [gate.phase], phaseIds);
    }

    for (const check of gate.checks ?? []) {
      assertStructuredReferences(check, gate.id, {
        artifactIds,
        evalIds,
        gateIds,
        policyIds,
        promptIds,
        roleIds,
        toolIds
      });
    }
  }

  for (const policy of context.policies) {
    assertReferencesInSet("policy tool", policy.id, refsFrom(policy.tools), toolIds);
    assertReferencesInSet("policy gate", policy.id, refsFrom(policy.gates), gateIds);
    assertReferencesInSet("policy eval", policy.id, refsFrom(policy.evals), evalIds);
    assertReferencesInSet(
      "policy artifact schema",
      policy.id,
      refsFrom(policy.artifactSchemas),
      artifactIds
    );
  }

  for (const evaluation of context.evals) {
    assertReferencesInSet(
      "eval artifact schema",
      evaluation.id,
      [
        ...refsFrom(evaluation.artifactSchemas),
        ...refsFrom(evaluation.artifacts),
        ...refsFrom(evaluation.requiredArtifacts),
        ...refsFrom(evaluation.targetArtifacts)
      ],
      artifactIds
    );
    assertReferencesInSet("eval gate", evaluation.id, refsFrom(evaluation.gates), gateIds);
    assertReferencesInSet("eval tool", evaluation.id, refsFrom(evaluation.tools), toolIds);
    assertReferencesInSet(
      "eval prompt",
      evaluation.id,
      refsFrom(evaluation.prompts),
      promptIds
    );
  }

  for (const role of context.roles) {
    assertReferencesInSet("role prompt", role.id, refsFrom(role.prompts), promptIds);
  }
}

function assertStructuredReferences(
  value: PlainRecord,
  ownerId: string,
  sets: {
    artifactIds: ReadonlySet<string>;
    evalIds: ReadonlySet<string>;
    gateIds: ReadonlySet<string>;
    policyIds: ReadonlySet<string>;
    promptIds: ReadonlySet<string>;
    roleIds: ReadonlySet<string>;
    toolIds: ReadonlySet<string>;
  }
) {
  assertReferencesInSet(
    "gate check artifact schema",
    ownerId,
    refsFrom(value.artifactSchemas),
    sets.artifactIds
  );
  assertReferencesInSet(
    "gate check eval",
    ownerId,
    refsFrom(value.evals),
    sets.evalIds
  );
  assertReferencesInSet(
    "gate check gate",
    ownerId,
    refsFrom(value.gates),
    sets.gateIds
  );
  assertReferencesInSet(
    "gate check policy",
    ownerId,
    refsFrom(value.policies),
    sets.policyIds
  );
  assertReferencesInSet(
    "gate check prompt",
    ownerId,
    refsFrom(value.prompts),
    sets.promptIds
  );
  assertReferencesInSet(
    "gate check role",
    ownerId,
    refsFrom(value.roles),
    sets.roleIds
  );
  assertReferencesInSet(
    "gate check tool",
    ownerId,
    refsFrom(value.tools),
    sets.toolIds
  );

  for (const [key, referenced] of Object.entries(value)) {
    const reference = referenceId(referenced);

    if (reference === undefined) {
      continue;
    }

    if (key.endsWith("Tool") || key.endsWith("ToolId") || key === "toolId") {
      assertReferencesInSet("gate check tool", ownerId, [reference], sets.toolIds);
    }

    if (key.endsWith("Eval") || key.endsWith("EvalId") || key === "evalId") {
      assertReferencesInSet("gate check eval", ownerId, [reference], sets.evalIds);
    }

    if (
      key.endsWith("ArtifactSchema") ||
      key.endsWith("ArtifactSchemaId") ||
      key === "artifactSchemaId"
    ) {
      assertReferencesInSet(
        "gate check artifact schema",
        ownerId,
        [reference],
        sets.artifactIds
      );
    }

    if (key.endsWith("Prompt") || key.endsWith("PromptId") || key === "promptId") {
      assertReferencesInSet(
        "gate check prompt",
        ownerId,
        [reference],
        sets.promptIds
      );
    }
  }
}

function assertAcyclicPhaseGraph(edges: readonly GraphEdge[]) {
  const outgoing = new Map<string, string[]>();

  for (const edge of edges) {
    const edgesFromNode = outgoing.get(edge.from) ?? [];
    edgesFromNode.push(edge.to);
    outgoing.set(edge.from, edgesFromNode);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, path: readonly string[]) {
    if (visiting.has(id)) {
      throw new HarnessLoaderError(
        "invalid_graph",
        `Phase graph contains a cycle: ${[...path, id].join(" -> ")}`
      );
    }

    if (visited.has(id)) {
      return;
    }

    visiting.add(id);

    for (const next of outgoing.get(id) ?? []) {
      visit(next, [...path, id]);
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (const id of outgoing.keys()) {
    visit(id, []);
  }
}

function assertUniqueIds(
  label: string,
  definitions: readonly DefinitionWithSource[]
) {
  const seen = new Map<string, DefinitionWithSource>();

  for (const definition of definitions) {
    const existing = seen.get(definition.id);

    if (existing !== undefined) {
      throw new HarnessLoaderError(
        "duplicate_id",
        `Duplicate ${label} id ${definition.id} in ${sourcePath(existing)} and ${sourcePath(definition)}`
      );
    }

    seen.set(definition.id, definition);
  }
}

function assertReferencesExist<TDefinition extends DefinitionWithSource>(
  label: string,
  references: readonly string[],
  definitions: readonly TDefinition[]
) {
  assertReferencesInSet(label, "harness", references, idSet(definitions));
}

function assertReferencesInSet(
  label: string,
  ownerId: string,
  references: readonly string[],
  ids: ReadonlySet<string>
) {
  for (const reference of references) {
    if (!ids.has(reference)) {
      throw new HarnessLoaderError(
        "missing_reference",
        `Missing ${label} reference ${reference} declared by ${ownerId}`
      );
    }
  }
}

function idSet<TDefinition extends DefinitionWithSource>(
  definitions: readonly TDefinition[]
) {
  return new Set(definitions.map((definition) => definition.id));
}

function orderDefinitions<TDefinition extends DefinitionWithSource>(
  definitions: readonly TDefinition[],
  preferredOrder: readonly string[]
): TDefinition[] {
  const ordered: TDefinition[] = [];
  const emitted = new Set<TDefinition>();

  for (const id of preferredOrder) {
    for (const definition of definitions) {
      if (definition.id !== id || emitted.has(definition)) {
        continue;
      }

      ordered.push(definition);
      emitted.add(definition);
    }
  }

  for (const definition of [...definitions].sort(compareBySourceThenId)) {
    if (!emitted.has(definition)) {
      ordered.push(definition);
      emitted.add(definition);
    }
  }

  return ordered;
}

function compareBySourceThenId(
  left: DefinitionWithSource,
  right: DefinitionWithSource
) {
  return (
    sourcePath(left).localeCompare(sourcePath(right)) ||
    left.id.localeCompare(right.id)
  );
}

function manifestReferences(
  references: HarnessReference[] | undefined
): string[] {
  return refsFrom(references);
}

function manifestToolReferences(manifest: HarnessManifest): string[] {
  if (Array.isArray(manifest.tools)) {
    return refsFrom(manifest.tools);
  }

  if (isRecord(manifest.tools)) {
    return [
      ...stringArray(manifest.tools.allow),
      ...stringArray(manifest.tools.requireApproval)
    ];
  }

  return [];
}

function refsFrom(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(referenceId).filter((id): id is string => id !== undefined);
  }

  const id = referenceId(value);

  return id === undefined ? [] : [id];
}

function referenceId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of [
    "id",
    "ref",
    "gate",
    "gateId",
    "tool",
    "toolId",
    "eval",
    "evalId",
    "artifact",
    "artifactId",
    "artifactSchema",
    "artifactSchemaId",
    "schema",
    "schemaId",
    "prompt",
    "promptId",
    "role",
    "roleId",
    "policy",
    "policyId"
  ]) {
    const valueAtKey = stringValue(value[key]);

    if (valueAtKey !== undefined) {
      return valueAtKey;
    }
  }

  return undefined;
}

function phaseReferences(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  return stringArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourcePath(definition: DefinitionWithSource) {
  return typeof definition.sourcePath === "string"
    ? definition.sourcePath
    : "unknown source";
}

function normalizeLoadedAt(value: Date | string | undefined) {
  if (value === undefined) {
    return new Date().toISOString();
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new HarnessLoaderError(
      "invalid_loaded_at",
      `Invalid loadedAt value ${String(value)}`
    );
  }

  return date.toISOString();
}

export function computeSpecHash(
  files: readonly Pick<SourceFile, "relativePath" | "raw">[]
) {
  const payload = [...files]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(
      (file) =>
        `${file.relativePath}\0${file.raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")}`
    )
    .join("\0");

  return hashString(payload);
}

function hashString(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (!isFreezable(value) || Object.isFrozen(value)) {
    return value;
  }

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }

  return Object.freeze(value);
}

function isFreezable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function parseMarkdownFrontmatter(file: SourceFile) {
  const normalized = file.raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return {
      data: {},
      content: normalized
    };
  }

  const end = normalized.indexOf("\n---\n", 4);

  if (end === -1) {
    throw new HarnessLoaderError(
      "invalid_prompt",
      `Prompt ${file.relativePath} has unterminated frontmatter`
    );
  }

  const frontmatter = normalized.slice(4, end);
  const content = normalized.slice(end + "\n---\n".length);
  const data = parseSimpleYaml(frontmatter);

  if (!isRecord(data)) {
    throw new HarnessLoaderError(
      "invalid_prompt",
      `Prompt ${file.relativePath} frontmatter must be an object`
    );
  }

  return {
    data,
    content
  };
}

function metadataFromFrontmatter(frontmatter: PlainRecord) {
  const metadata = { ...frontmatter };
  delete metadata.id;
  delete metadata.description;

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function stripKnownExtension(path: string) {
  return path.replace(/\.(md|yaml|yml|json)$/u, "");
}

function normalizeRelativePath(path: string) {
  return path.replace(/\\/g, "/");
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

type YamlLine = {
  indent: number;
  text: string;
};

function parseSimpleYaml(raw: string): unknown {
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(toYamlLine)
    .filter((line): line is YamlLine => line !== undefined);

  if (lines.length === 0) {
    return {};
  }

  const parser = new SimpleYamlParser(lines);
  const value = parser.parseBlock(lines[0]?.indent ?? 0);
  parser.assertComplete();

  return value;
}

function toYamlLine(rawLine: string): YamlLine | undefined {
  if (rawLine.includes("\t")) {
    throw new Error("YAML tabs are not supported");
  }

  const indent = rawLine.match(/^ */u)?.[0].length ?? 0;
  const text = stripYamlComment(rawLine.slice(indent)).trimEnd();

  if (text.trim().length === 0) {
    return undefined;
  }

  return {
    indent,
    text: text.trimStart()
  };
}

function stripYamlComment(value: string) {
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\"" || char === "'") {
      quote = quote === char ? undefined : quote ?? char;
    }

    if (char === "#" && quote === undefined) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

class SimpleYamlParser {
  private index = 0;

  constructor(private readonly lines: readonly YamlLine[]) {}

  parseBlock(indent: number): unknown {
    const line = this.peek();

    if (line === undefined) {
      return {};
    }

    if (line.indent < indent) {
      return {};
    }

    if (line.text.startsWith("- ")) {
      return this.parseSequence(line.indent);
    }

    return this.parseMapping(line.indent);
  }

  assertComplete() {
    if (this.index < this.lines.length) {
      const line = this.lines[this.index];
      throw new Error(`Unexpected YAML line: ${line?.text ?? ""}`);
    }
  }

  private parseMapping(indent: number): PlainRecord {
    const output: PlainRecord = {};

    while (this.index < this.lines.length) {
      const line = this.peek();

      if (line === undefined || line.indent < indent) {
        break;
      }

      if (line.indent > indent) {
        throw new Error(`Unexpected indentation before ${line.text}`);
      }

      if (line.text.startsWith("- ")) {
        break;
      }

      this.consumePair(output, line.text, indent);
    }

    return output;
  }

  private parseSequence(indent: number): unknown[] {
    const output: unknown[] = [];

    while (this.index < this.lines.length) {
      const line = this.peek();

      if (line === undefined || line.indent < indent) {
        break;
      }

      if (line.indent > indent) {
        throw new Error(`Unexpected indentation before ${line.text}`);
      }

      if (!line.text.startsWith("- ")) {
        break;
      }

      const rest = line.text.slice(2).trim();
      this.index += 1;

      if (rest.length === 0) {
        output.push(this.parseIndentedChild(indent));
        continue;
      }

      if (looksLikePair(rest)) {
        const item: PlainRecord = {};
        this.consumePairText(item, rest, indent + 2);

        while (this.index < this.lines.length) {
          const next = this.peek();

          if (next === undefined || next.indent <= indent) {
            break;
          }

          if (next.text.startsWith("- ")) {
            throw new Error(`Sequence item needs a key before ${next.text}`);
          }

          this.consumePair(item, next.text, next.indent);
        }

        output.push(item);
        continue;
      }

      output.push(parseYamlScalar(rest));
    }

    return output;
  }

  private parseIndentedChild(parentIndent: number): unknown {
    const next = this.peek();

    if (next === undefined || next.indent <= parentIndent) {
      return null;
    }

    return this.parseBlock(next.indent);
  }

  private consumePair(output: PlainRecord, text: string, indent: number) {
    this.index += 1;
    this.consumePairText(output, text, indent);
  }

  private consumePairText(output: PlainRecord, text: string, indent: number) {
    const pair = splitYamlPair(text);

    if (pair === undefined) {
      throw new Error(`Expected YAML key/value pair at ${text}`);
    }

    if (pair.value.length === 0) {
      output[pair.key] = this.parseIndentedChild(indent);
      return;
    }

    if (isBlockScalar(pair.value)) {
      output[pair.key] = this.readBlockScalar(indent, pair.value.startsWith(">"));
      return;
    }

    output[pair.key] = parseYamlScalar(pair.value);
  }

  private readBlockScalar(parentIndent: number, folded: boolean) {
    const lines: string[] = [];

    while (this.index < this.lines.length) {
      const line = this.peek();

      if (line === undefined || line.indent <= parentIndent) {
        break;
      }

      this.index += 1;
      lines.push(" ".repeat(line.indent - parentIndent - 2) + line.text);
    }

    return folded ? lines.join(" ").trimEnd() : `${lines.join("\n")}\n`;
  }

  private peek() {
    return this.lines[this.index];
  }
}

function splitYamlPair(text: string) {
  const colonIndex = text.indexOf(":");

  if (colonIndex <= 0) {
    return undefined;
  }

  return {
    key: unquoteString(text.slice(0, colonIndex).trim()),
    value: text.slice(colonIndex + 1).trim()
  };
}

function looksLikePair(text: string) {
  const colonIndex = text.indexOf(":");

  if (colonIndex <= 0) {
    return false;
  }

  const key = text.slice(0, colonIndex).trim();

  return /^["']?[$A-Z_a-z][-$.\w]*["']?$/u.test(key);
}

function isBlockScalar(value: string) {
  return value === "|" || value === "|-" || value === ">" || value === ">-";
}

function parseYamlScalar(value: string): unknown {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null" || value === "~") {
    return null;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInline(value.slice(1, -1)).map(parseYamlScalar);
  }

  if (value.startsWith("{") && value.endsWith("}")) {
    return parseInlineObject(value);
  }

  if (isQuoted(value)) {
    return unquoteString(value);
  }

  if (/^-?(0|[1-9]\d*)(\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  return value;
}

function parseInlineObject(value: string): PlainRecord {
  try {
    const parsed = JSON.parse(value);

    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the limited YAML-style object parser.
  }

  const output: PlainRecord = {};

  for (const entry of splitInline(value.slice(1, -1))) {
    const pair = splitYamlPair(entry);

    if (pair === undefined) {
      throw new Error(`Invalid inline object entry ${entry}`);
    }

    output[pair.key] = parseYamlScalar(pair.value);
  }

  return output;
}

function splitInline(value: string) {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\"" || char === "'") {
      quote = quote === char ? undefined : quote ?? char;
    }

    if (quote === undefined) {
      if (char === "[" || char === "{") {
        depth += 1;
      }

      if (char === "]" || char === "}") {
        depth -= 1;
      }

      if (char === "," && depth === 0) {
        items.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim().length > 0) {
    items.push(current.trim());
  }

  return items;
}

function isQuoted(value: string) {
  return (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}

function unquoteString(value: string) {
  if (!isQuoted(value)) {
    return value;
  }

  const quote = value[0];
  const unquoted = value.slice(1, -1);

  return quote === "\"" ? unquoted.replace(/\\"/g, "\"") : unquoted;
}
