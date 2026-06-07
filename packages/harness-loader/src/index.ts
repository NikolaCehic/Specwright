import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
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
import {
  buildGrantDeniedEvaluation,
  buildGrantEvaluatedEvent,
  DEFAULT_GRANT_SOURCE,
  evaluateGrant,
  extractRequestedSurface,
  firstDeniedCapability,
  grantAuthorizesVersion,
  parseCapabilityGrant,
  CapabilityGrantResolutionError
} from "./capability-grant";
import type {
  CapabilityGrant,
  GrantDenialReason,
  GrantEvaluation,
  GrantSource,
  HarnessGrantEvent
} from "./capability-grant";
import {
  DEFAULT_DEPENDENCY_RESOLVER,
  DependencyResolutionError,
  buildDependenciesPinnedEvent,
  canonicalDependencyHashSegments,
  resolveAndPinDependencies
} from "./dependency-resolver";
import type {
  DependencyResolution,
  HarnessDependencyEvent,
  HarnessDependencyResolver,
  ResolvedDependency
} from "./dependency-resolver";
import {
  CompatibilityAdmissionError,
  admitHarnessCompatibility
} from "./compatibility/admission";
import {
  DEFAULT_COMPATIBILITY_MATRIX,
  DEFAULT_RUNTIME_VERSION
} from "./compatibility/matrix";
import type {
  CompatibilityAdmission,
  CompatibilitySourceFile
} from "./compatibility/admission";
import type { CompatibilityMatrix } from "./compatibility/matrix";
import type { MigrationDescriptor } from "./compatibility/migration";
import { HarnessLoaderError } from "./errors";
import type { HarnessLoaderErrorCode } from "./errors";
import { createHarnessPackageReadLimiter, createLimitStageObserver } from "./limits";
import type { HarnessLoaderLimitsInput, HarnessPackageReadLimiter } from "./limits";

export {
  HarnessLoaderError
} from "./errors";
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
export {
  CapabilityGrantIssuerSchema,
  CapabilityGrantRegistrySchema,
  CapabilityGrantResolutionError,
  CapabilityGrantSchema,
  DEFAULT_GRANT_SOURCE,
  HarnessGrantEvaluatedEventSchema,
  RegistryGrantSource,
  buildGrantEvaluatedEvent,
  evaluateGrant,
  extractRequestedSurface,
  loadCapabilityGrantRegistryFromFile,
  parseCapabilityGrant
} from "./capability-grant";
export {
  DEFAULT_DEPENDENCY_RESOLVER,
  DependencyRegistrySchema,
  DependencyResolutionError,
  FixtureBackedHarnessDependencyResolver,
  HarnessDependenciesPinnedEventSchema,
  HarnessDependencyDeclarationSchema,
  RegistryDependencyResolver,
  ResolvedDependencySchema,
  ReviewedDependencyPinSchema,
  buildDependenciesPinnedEvent,
  canonicalizeResolvedDependencies,
  dependencyContentHash,
  loadDependencyRegistryFromFile,
  loadFixtureDependencyResolverFromFile,
  parseDependencyDeclarations,
  resolveAndPinDependencies
} from "./dependency-resolver";
export {
  ClassifyTransitionInputSchema,
  CompatibilityClassSchema,
  classifyTransition,
  detectCapabilitySurfaceWidening
} from "./compatibility/classify";
export {
  CompatibilityManifestEnvelopeSchema,
  admitHarnessCompatibility,
  parseCompatibilityManifestEnvelope
} from "./compatibility/admission";
export {
  CompatibilityMatrixRowSchema,
  CompatibilityMatrixSchema,
  DEFAULT_COMPATIBILITY_MATRIX,
  DEFAULT_RUNTIME_VERSION,
  LoaderBehaviorSchema,
  loadCompatibilityMatrixFromFile,
  lookupCompatibilityMatrix
} from "./compatibility/matrix";
export {
  MigrationDescriptorBodySchema,
  MigrationDescriptorSchema,
  MigrationDescriptorSignatureSchema,
  applyMigrationDescriptor,
  canonicalizeMigrationDescriptor,
  parseMigrationDescriptor,
  verifyMigrationDescriptor
} from "./compatibility/migration";
export {
  HARNESS_LOADER_EVENT_TYPES,
  HarnessCompatibilityDecidedEventSchema,
  HarnessDependenciesPinnedAuditEventSchema,
  HarnessGrantEvaluatedAuditEventSchema,
  HarnessLoadDeniedEventSchema,
  HarnessLoadRequestedEventSchema,
  HarnessLoaderAuditEventSchema,
  HarnessRedactionAppliedEventSchema,
  HarnessSecurityFailedAuditEventSchema,
  HarnessSnapshotFrozenEventSchema,
  HarnessTrustRejectedAuditEventSchema,
  HarnessTrustVerifiedAuditEventSchema,
  HarnessValidatedEventSchema,
  HarnessValidationFailedEventSchema,
  assertHarnessLoaderAuditEvent,
  buildHarnessLoaderAuditEvent
} from "./events";
export {
  HARNESS_LOADER_VALIDATOR_BUILD_ID,
  HarnessLoadProvenanceError,
  HarnessLoadProvenanceSchema,
  HarnessProvenanceDataClassSchema,
  SpecHashDriftLedger,
  assembleHarnessLoadProvenance,
  assertRedactionEventsCoverSubstitutions,
  assessHarnessRunAuditability,
  createSpecHashDriftLedger,
  hashHarnessLoadProvenance
} from "./provenance";
export { loadHarnessPackageObserved, verifySpecHash } from "./observe";
export {
  DEFAULT_HARNESS_LOADER_LIMITS,
  HarnessLoaderLimitsSchema,
  assertFetchedPackageWithinLimits,
  createHarnessPackageReadLimiter,
  createLimitStageObserver,
  normalizeHarnessLoaderLimits
} from "./limits";
export { SnapshotCache, createSnapshotCache } from "./cache";
export {
  PromotionApprovalSchema,
  RegistryLifecycleStateSchema,
  assertLifecycleTransition
} from "./lifecycle";
export {
  HarnessRegistry,
  InMemoryRegistryStore
} from "./registry";
export type {
  HarnessLoaderErrorCode
} from "./errors";
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
export type {
  CapabilityGrant,
  CapabilityGrantIssuer,
  CapabilityGrantRegistry,
  CapabilityGrantSummary,
  GrantDenialReason,
  GrantEvaluation,
  GrantSource,
  HarnessGrantEvent,
  RequestedCapabilitySurface
} from "./capability-grant";
export type {
  DependencyRegistry,
  DependencyRejectReason,
  DependencyResolution,
  HarnessDependencyDeclaration,
  HarnessDependencyEvent,
  HarnessDependencyResolver,
  ResolvedDependency,
  ReviewedDependencyPin
} from "./dependency-resolver";
export type {
  CapabilitySurface,
  CapabilityWidening,
  ClassifyTransitionInput,
  CompatibilityClass
} from "./compatibility/classify";
export type {
  CompatibilityAdmission,
  CompatibilityManifestEnvelope
} from "./compatibility/admission";
export type {
  CompatibilityMatrix,
  CompatibilityMatrixRow,
  LoaderBehavior
} from "./compatibility/matrix";
export type {
  MigrationDescriptor,
  MigrationDescriptorBody,
  MigrationDescriptorSignature,
  MigrationResult
} from "./compatibility/migration";
export type {
  HarnessDefinitionCounts,
  HarnessLoaderAuditEvent,
  HarnessLoaderAuditEventPayload,
  HarnessLoaderEventType,
  HarnessRedactionHashReference
} from "./events";
export type {
  HarnessLoadProvenance,
  HarnessLoadProvenanceErrorCode,
  HarnessProvenanceDataClass,
  HarnessRunAuditability,
  SpecHashDriftSignal,
  StringProvenanceValue,
  UnknownProvenanceValue
} from "./provenance";
export type {
  HarnessObservedRunContext,
  HarnessRedactionRecording,
  HarnessTraceRecorderLike,
  HarnessTraceSpanInput,
  LoadHarnessPackageObservedOptions,
  LoadHarnessPackageObservedResult
} from "./observe";
export type {
  HarnessLoaderLimitViolation,
  HarnessLoaderLimits,
  HarnessLoaderLimitsInput,
  HarnessPackageLimitSummary
} from "./limits";
export type {
  SnapshotCacheComputeSpecHash,
  SnapshotCacheEntry,
  SnapshotCacheOptions
} from "./cache";
export type {
  DryRunValidationEvidence,
  LifecycleTransitionEvidence,
  PromotionApproval,
  RegistryLifecycleState
} from "./lifecycle";
export type {
  HarnessRegistryLoader,
  HarnessRegistryLoaderInput,
  HarnessRegistryOptions,
  PreparedPromotion,
  PromoteInput,
  RegistryLifecycleRecord,
  RegistryPackageKey,
  RegistryPromotedVersion,
  RegistryStore,
  RegistryStoredBytes,
  StageCandidateInput
} from "./registry";

export const HARNESS_MANIFEST_FILE = "harness.yaml";
export const SUPPORTED_HARNESS_SCHEMA_VERSION: HarnessSchemaVersion =
  "specwright.harness.v0";

export type HarnessLoadStageKind =
  | "harness.fetch"
  | "harness.verify_trust"
  | "harness.parse"
  | "harness.validate"
  | "harness.resolve_deps"
  | "harness.compatibility"
  | "harness.grant_check"
  | "harness.freeze";

export type HarnessLoadStageObserver = <TValue>(
  stage: HarnessLoadStageKind,
  metadata: Record<string, unknown>,
  operation: () => TValue | Promise<TValue>
) => Promise<TValue>;

export type LoadHarnessPackageOptions = {
  packageDir: string;
  loadedAt?: Date | string;
  signature?: SignatureEnvelope;
  trustStore?: TrustStore;
  strict?: boolean;
  trustNow?: Date | string;
  onTrustEvent?(event: HarnessTrustEvent): void | Promise<void>;
  grantSource?: GrantSource;
  onGrantEvent?(event: HarnessGrantEvent): void | Promise<void>;
  dependencyResolver?: HarnessDependencyResolver;
  onDependencyEvent?(event: HarnessDependencyEvent): void | Promise<void>;
  runtimeVersion?: string;
  compatibilityMatrix?: CompatibilityMatrix;
  migrationDescriptor?: MigrationDescriptor;
  migrationTrustStore?: TrustStore;
  migrationNow?: Date | string;
  onLoadStage?: HarnessLoadStageObserver;
};

export type LoadHarnessPackageWithLimitsOptions = LoadHarnessPackageOptions & {
  limits?: HarnessLoaderLimitsInput | undefined;
};

type LoadHarnessPackageInternalOptions = LoadHarnessPackageOptions & {
  readLimiter?: HarnessPackageReadLimiter | undefined;
};

export type HarnessLoadRecord = {
  snapshot: HarnessSnapshot;
  loadedFiles: readonly SourceFile[];
  grant: GrantEvaluation;
  dependencies: DependencyResolution;
  compatibility: CompatibilityAdmission;
  trust?: TrustVerdict;
};

export type SourceFile = {
  absolutePath: string;
  relativePath: string;
  raw: string;
};

type FetchedHarnessFiles = {
  manifestFile: SourceFile;
  phaseFiles: SourceFile[];
  gateFiles: SourceFile[];
  policyFiles: SourceFile[];
  toolFiles: SourceFile[];
  artifactSchemaFiles: SourceFile[];
  evalFiles: SourceFile[];
  roleFiles: SourceFile[];
  promptFiles: SourceFile[];
  loadedFiles: SourceFile[];
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

export async function loadHarnessPackageWithLimits(
  input: string | LoadHarnessPackageWithLimitsOptions
): Promise<HarnessLoadRecord> {
  const options =
    typeof input === "string" ? { packageDir: input } : input;
  const { limits, ...loadOptions } = options;
  const readLimiter = createHarnessPackageReadLimiter(limits);
  const limitedOptions: LoadHarnessPackageInternalOptions = {
    ...loadOptions,
    readLimiter,
    onLoadStage: createLimitStageObserver({
      limits,
      observer: loadOptions.onLoadStage
    })
  };

  return loadHarnessPackageWithRecord(limitedOptions);
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
  const fetched = await runLoadStage(
    input,
    "harness.fetch",
    {
      sourceUri: packageDir,
      transport: "file"
    },
    async () => {
      const readLimiter = internalOptions(input)?.readLimiter;
      const manifestFile = await readRequiredFile(
        packageDir,
        HARNESS_MANIFEST_FILE,
        readLimiter
      );
      const directoryFiles =
        readLimiter === undefined
          ? await readHarnessDirectories(packageDir)
          : await readHarnessDirectoriesSerial(packageDir, readLimiter);
      const {
        phaseFiles,
        gateFiles,
        policyFiles,
        toolFiles,
        artifactSchemaFiles,
        evalFiles,
        roleFiles,
        promptFiles
      } = directoryFiles;
      const loadedFiles = [
        manifestFile,
        ...phaseFiles,
        ...gateFiles,
        ...policyFiles,
        ...toolFiles,
        ...artifactSchemaFiles,
        ...evalFiles,
        ...roleFiles,
        ...promptFiles
      ];

      return {
        manifestFile,
        phaseFiles,
        gateFiles,
        policyFiles,
        toolFiles,
        artifactSchemaFiles,
        evalFiles,
        roleFiles,
        promptFiles,
        loadedFiles
      };
    }
  );
  let loadedFiles: SourceFile[] = [...fetched.loadedFiles];
  let activeFiles = splitLoadedFiles(loadedFiles);
  let manifestFile = activeFiles.manifestFile;
  const rawManifest = parseDataFile(manifestFile);

  const compatibility = await runLoadStage(
    input,
    "harness.compatibility",
    {},
    () =>
      enforceCompatibilityAdmission({
        input,
        rawManifest,
        loadedFiles
      })
  );
  loadedFiles = compatibility.files;
  activeFiles = splitLoadedFiles(loadedFiles);
  manifestFile = activeFiles.manifestFile;

  const parsed = await runLoadStage(input, "harness.parse", {}, () => {
    const manifest = parseManifest(manifestFile);
    const manifestSchemaVersion = manifest.schemaVersion;

    if (manifestSchemaVersion !== SUPPORTED_HARNESS_SCHEMA_VERSION) {
      throw new HarnessLoaderError(
        "unsupported_schema_version",
        `Unsupported harness schemaVersion ${manifestSchemaVersion}`
      );
    }

    const phases = orderDefinitions(
      [
        ...inlineDefinitions(
          manifest.phases,
          "phase",
          HARNESS_MANIFEST_FILE,
          parsePhaseDefinition
        ),
        ...activeFiles.phaseFiles.map((file) =>
          parsePhaseDefinition(parseDataFile(file), file)
        )
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
        ...activeFiles.gateFiles.map((file) =>
          parseGateDefinition(parseDataFile(file), file)
        )
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
        ...activeFiles.policyFiles.map((file) =>
          parsePolicyBundle(parseDataFile(file), file)
        )
      ],
      manifestReferences(manifest.policies)
    );
    const tools = orderDefinitions(
      [
        ...inlineToolDefinitions(manifest),
        ...activeFiles.toolFiles.map((file) =>
          parseToolDefinition(parseDataFile(file), file)
        )
      ],
      manifestToolReferences(manifest)
    );
    const artifacts = orderDefinitions(
      activeFiles.artifactSchemaFiles.map((file) => parseArtifactSchemaFile(file)),
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
        ...activeFiles.evalFiles.map((file) =>
          parseEvalDefinition(parseDataFile(file), file)
        )
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
        ...activeFiles.roleFiles.map((file) =>
          parseRoleDefinition(parseDataFile(file), file)
        )
      ],
      manifestReferences(manifest.roles)
    );
    const prompts = orderDefinitions(
      activeFiles.promptFiles.map((file) => parsePromptFile(file)),
      manifestReferences(manifest.prompts)
    );

    return {
      manifest,
      phases,
      gates,
      policies,
      tools,
      artifacts,
      evals,
      roles,
      prompts
    };
  });
  const counts = definitionCounts(parsed);

  await runLoadStage(input, "harness.validate", { definitionCounts: counts }, () => {
    assertUniqueIds("phase", parsed.phases);
    assertUniqueIds("gate", parsed.gates);
    assertUniqueIds("policy", parsed.policies);
    assertUniqueIds("tool", parsed.tools);
    assertUniqueIds("artifact schema", parsed.artifacts);
    assertUniqueIds("eval", parsed.evals);
    assertUniqueIds("role", parsed.roles);
    assertUniqueIds("prompt", parsed.prompts);

    validateManifestReferences(parsed.manifest, {
      phases: parsed.phases,
      gates: parsed.gates,
      policies: parsed.policies,
      tools: parsed.tools,
      artifacts: parsed.artifacts,
      evals: parsed.evals,
      roles: parsed.roles,
      prompts: parsed.prompts
    });
    validateDefinitions(parsed);
  });

  const grant = await runLoadStage(
    input,
    "harness.grant_check",
    {},
    () =>
      enforceCapabilityGrant({
        input,
        manifest: parsed.manifest,
        policies: parsed.policies,
        tools: parsed.tools
      })
  );
  const dependencies = await runLoadStage(
    input,
    "harness.resolve_deps",
    {},
    () =>
      enforceDependencyResolution({
        input,
        manifest: parsed.manifest
      })
  );
  const finalSpecHash = computeSpecHash(loadedFiles, dependencies.resolved);
  const trust = await runLoadStage(
    input,
    "harness.verify_trust",
    {},
    () =>
      verifyTrustIfConfigured({
        input,
        manifest: parsed.manifest,
        expectedSpecHash: finalSpecHash
      })
  );
  const frozen = await runLoadStage(
    input,
    "harness.freeze",
    { definitionCounts: counts },
    () => {
      const snapshot = HarnessSnapshotSchema.parse({
        id: parsed.manifest.id,
        version: parsed.manifest.version,
        schemaVersion: parsed.manifest.schemaVersion,
        specHash: finalSpecHash,
        loadedAt,
        runtime: parsed.manifest.runtime,
        phases: parsed.phases,
        gates: parsed.gates,
        policies: parsed.policies,
        tools: parsed.tools,
        artifacts: parsed.artifacts,
        evals: parsed.evals,
        roles: parsed.roles,
        prompts: parsed.prompts,
        metadata: mergeTrustProvenance(parsed.manifest.metadata, trust)
      });

      return {
        specHash: finalSpecHash,
        snapshot
      };
    }
  );

  await emitDependencyEvent(input, parsed.manifest, frozen.specHash, dependencies);

  return {
    snapshot: deepFreeze(frozen.snapshot),
    loadedFiles,
    grant,
    dependencies,
    compatibility: compatibility.admission,
    ...(trust === undefined ? {} : { trust })
  };
}

async function runLoadStage<TValue>(
  input: string | LoadHarnessPackageOptions,
  stage: HarnessLoadStageKind,
  metadata: Record<string, unknown>,
  operation: () => TValue | Promise<TValue>
): Promise<TValue> {
  if (typeof input === "string" || input.onLoadStage === undefined) {
    return operation();
  }

  return input.onLoadStage(stage, metadata, operation);
}

function internalOptions(
  input: string | LoadHarnessPackageOptions
): LoadHarnessPackageInternalOptions | undefined {
  return typeof input === "string"
    ? undefined
    : (input as LoadHarnessPackageInternalOptions);
}

function definitionCounts(collections: {
  phases: readonly PhaseDefinition[];
  gates: readonly GateDefinition[];
  policies: readonly PolicyBundle[];
  tools: readonly ToolDefinition[];
  artifacts: readonly ArtifactSchemaRef[];
  evals: readonly EvalDefinition[];
  roles: readonly RoleDefinition[];
  prompts: readonly PromptAssetRef[];
}) {
  return {
    phases: collections.phases.length,
    gates: collections.gates.length,
    policies: collections.policies.length,
    tools: collections.tools.length,
    artifacts: collections.artifacts.length,
    evals: collections.evals.length,
    roles: collections.roles.length,
    prompts: collections.prompts.length
  };
}

function enforceCompatibilityAdmission(context: {
  input: string | LoadHarnessPackageOptions;
  rawManifest: unknown;
  loadedFiles: readonly SourceFile[];
}) {
  try {
    const admitted = admitHarnessCompatibility({
      rawManifest: context.rawManifest,
      files: context.loadedFiles,
      targetSchemaVersion: SUPPORTED_HARNESS_SCHEMA_VERSION,
      runtimeVersion:
        typeof context.input === "string"
          ? DEFAULT_RUNTIME_VERSION
          : context.input.runtimeVersion ?? DEFAULT_RUNTIME_VERSION,
      matrix:
        typeof context.input === "string"
          ? DEFAULT_COMPATIBILITY_MATRIX
          : context.input.compatibilityMatrix ?? DEFAULT_COMPATIBILITY_MATRIX,
      ...(typeof context.input === "string" ||
      context.input.migrationDescriptor === undefined
        ? {}
        : { migrationDescriptor: context.input.migrationDescriptor }),
      ...(typeof context.input === "string" ||
      context.input.migrationTrustStore === undefined
        ? {}
        : { migrationTrustStore: context.input.migrationTrustStore }),
      ...(typeof context.input === "string" ||
      context.input.migrationNow === undefined
        ? {}
        : { migrationNow: context.input.migrationNow }),
      computeSpecHash
    });

    return {
      files: admitted.files.map(sourceFileFromCompatibilityFile),
      manifestFile: sourceFileFromCompatibilityFile(admitted.manifestFile),
      admission: admitted.admission
    };
  } catch (error) {
    if (!(error instanceof CompatibilityAdmissionError)) {
      throw error;
    }

    throw new HarnessLoaderError(
      error.code,
      `Harness compatibility admission failed: ${error.reason}`,
      error,
      {
        reason: error.reason,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    );
  }
}

function sourceFileFromCompatibilityFile(
  file: CompatibilitySourceFile
): SourceFile {
  return {
    absolutePath: file.absolutePath ?? file.relativePath,
    relativePath: file.relativePath,
    raw: file.raw
  };
}

function splitLoadedFiles(files: readonly SourceFile[]) {
  const manifestFile = files.find(
    (file) => file.relativePath === HARNESS_MANIFEST_FILE
  );

  if (manifestFile === undefined) {
    throw new HarnessLoaderError(
      "missing_harness_manifest",
      `Missing required ${HARNESS_MANIFEST_FILE}`
    );
  }

  return {
    manifestFile,
    phaseFiles: filesForDirectory(files, "phases"),
    gateFiles: filesForDirectory(files, "gates"),
    policyFiles: filesForDirectory(files, "policies"),
    toolFiles: filesForDirectory(files, "tools"),
    artifactSchemaFiles: filesForDirectory(files, "artifact-schemas"),
    evalFiles: filesForDirectory(files, "evals"),
    roleFiles: filesForDirectory(files, "roles"),
    promptFiles: filesForDirectory(files, "prompts")
  };
}

function filesForDirectory(files: readonly SourceFile[], directory: string) {
  const prefix = `${directory}/`;

  return files
    .filter((file) => file.relativePath.startsWith(prefix))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function verifyTrustIfConfigured(context: {
  input: string | LoadHarnessPackageOptions;
  manifest: HarnessManifest;
  expectedSpecHash: string;
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
      manifest: context.manifest,
      strict: context.input.strict ?? true,
      expectedSpecHash: context.expectedSpecHash,
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

async function enforceCapabilityGrant(context: {
  input: string | LoadHarnessPackageOptions;
  manifest: HarnessManifest;
  policies: readonly PolicyBundle[];
  tools: readonly ToolDefinition[];
}): Promise<GrantEvaluation> {
  const requested = extractRequestedSurface({
    manifest: context.manifest,
    policies: context.policies,
    tools: context.tools
  });
  const grantSource =
    typeof context.input === "string"
      ? DEFAULT_GRANT_SOURCE
      : context.input.grantSource ?? DEFAULT_GRANT_SOURCE;
  let resolvedGrant: CapabilityGrant | undefined;

  try {
    resolvedGrant = await grantSource.resolveGrant(
      context.manifest.id,
      context.manifest.version
    );
  } catch (error) {
    const reason =
      error instanceof CapabilityGrantResolutionError
        ? error.reason
        : "grant_resolution_error";
    const evaluation = buildGrantDeniedEvaluation({
      requested,
      reason,
      deniedCapabilities: [`grant:${reason}`]
    });

    await emitGrantEvent(context.input, context.manifest, evaluation);
    throw grantDeniedError(context.manifest, evaluation, error, reason);
  }

  if (resolvedGrant === undefined) {
    const evaluation = buildGrantDeniedEvaluation({
      requested,
      reason: "missing_grant",
      deniedCapabilities: [`grant:${context.manifest.id}@${context.manifest.version}`]
    });

    await emitGrantEvent(context.input, context.manifest, evaluation);
    throw grantDeniedError(context.manifest, evaluation, undefined, "missing_grant");
  }

  let grant: CapabilityGrant;

  try {
    grant = parseCapabilityGrant(resolvedGrant);
  } catch (error) {
    const reason =
      error instanceof CapabilityGrantResolutionError
        ? error.reason
        : "malformed_grant";
    const evaluation = buildGrantDeniedEvaluation({
      requested,
      reason,
      deniedCapabilities: [`grant:${reason}`]
    });

    await emitGrantEvent(context.input, context.manifest, evaluation);
    throw grantDeniedError(context.manifest, evaluation, error, reason);
  }

  if (
    grant.packageId !== context.manifest.id ||
    !grantAuthorizesVersion(grant, context.manifest.version)
  ) {
    const evaluation = buildGrantDeniedEvaluation({
      requested,
      grant,
      reason: "grant_not_applicable",
      deniedCapabilities: [
        `grant:${grant.grantId}:${context.manifest.id}@${context.manifest.version}`
      ]
    });

    await emitGrantEvent(context.input, context.manifest, evaluation);
    throw grantDeniedError(
      context.manifest,
      evaluation,
      undefined,
      "grant_not_applicable"
    );
  }

  const evaluation = evaluateGrant(requested, grant);

  await emitGrantEvent(context.input, context.manifest, evaluation);

  if (!evaluation.granted) {
    throw grantDeniedError(
      context.manifest,
      evaluation,
      undefined,
      "capability_outside_grant"
    );
  }

  return evaluation;
}

async function emitGrantEvent(
  input: string | LoadHarnessPackageOptions,
  manifest: HarnessManifest,
  evaluation: GrantEvaluation
) {
  if (typeof input === "string") {
    return;
  }

  await input.onGrantEvent?.(
    buildGrantEvaluatedEvent(manifest.id, manifest.version, evaluation)
  );
}

function grantDeniedError(
  manifest: HarnessManifest,
  evaluation: GrantEvaluation,
  cause: unknown,
  reason: GrantDenialReason
) {
  const offendingCapability = firstDeniedCapability(evaluation);

  return new HarnessLoaderError(
    "grant_denied",
    `Capability grant denied for ${manifest.id}@${manifest.version}: ${offendingCapability}`,
    cause,
    {
      reason,
      details: {
        offendingCapability,
        deniedCapabilities: evaluation.deniedCapabilities,
        overGrant: evaluation.overGrant,
        ...(evaluation.grant === undefined ? {} : { grant: evaluation.grant })
      }
    }
  );
}

async function enforceDependencyResolution(context: {
  input: string | LoadHarnessPackageOptions;
  manifest: HarnessManifest;
}): Promise<DependencyResolution> {
  const resolver =
    typeof context.input === "string"
      ? DEFAULT_DEPENDENCY_RESOLVER
      : context.input.dependencyResolver ?? DEFAULT_DEPENDENCY_RESOLVER;

  try {
    const resolution = await resolveAndPinDependencies({
      manifest: context.manifest,
      resolver,
      strict: dependencyStrictMode(context.manifest)
    });

    return resolution;
  } catch (error) {
    if (!(error instanceof DependencyResolutionError)) {
      throw error;
    }

    throw dependencyDeniedError(context.manifest, error);
  }
}

async function emitDependencyEvent(
  input: string | LoadHarnessPackageOptions,
  manifest: HarnessManifest,
  specHash: string,
  resolution: DependencyResolution
) {
  if (typeof input === "string" || resolution.resolved.length === 0) {
    return;
  }

  await input.onDependencyEvent?.(
    buildDependenciesPinnedEvent(
      manifest.id,
      manifest.version,
      specHash,
      resolution
    )
  );
}

function dependencyDeniedError(
  manifest: HarnessManifest,
  error: DependencyResolutionError
) {
  const dependencyName = error.dependencyName ?? "unknown";

  return new HarnessLoaderError(
    "dependency_unresolved",
    `Dependency resolution failed for ${manifest.id}@${manifest.version}: ${dependencyName} (${error.reason})`,
    error,
    {
      reason: error.reason,
      details: {
        dependencyName,
        ...(error.details === undefined ? {} : error.details)
      }
    }
  );
}

function dependencyStrictMode(manifest: HarnessManifest) {
  return !isRecord(manifest.runtime) || manifest.runtime.strict !== false;
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

  assertLocalArtifactSchemaRefs(schema, file);

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

function assertLocalArtifactSchemaRefs(schema: unknown, file: SourceFile) {
  const remoteRef = findNonLocalJsonSchemaRef(schema);

  if (remoteRef === undefined) {
    return;
  }

  throw new HarnessLoaderError(
    "invalid_artifact_schema",
    `Artifact schema ${file.relativePath} contains non-local $ref ${remoteRef}`,
    undefined,
    {
      reason: "remote_ref_denied",
      details: {
        path: file.relativePath,
        ref: remoteRef
      }
    }
  );
}

const JSON_SCHEMA_REF_KEYS = ["$ref", "$dynamicRef", "$recursiveRef"] as const;

function findNonLocalJsonSchemaRef(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNonLocalJsonSchemaRef(item);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of JSON_SCHEMA_REF_KEYS) {
    const ref = value[key];

    if (typeof ref === "string" && !ref.startsWith("#")) {
      return ref;
    }
  }

  for (const item of Object.values(value)) {
    const found = findNonLocalJsonSchemaRef(item);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
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
  relativePath: string,
  readLimiter?: HarnessPackageReadLimiter | undefined
): Promise<SourceFile> {
  try {
    return await readSourceFile(packageDir, relativePath, readLimiter);
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

async function readHarnessDirectories(packageDir: string) {
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

  return {
    phaseFiles,
    gateFiles,
    policyFiles,
    toolFiles,
    artifactSchemaFiles,
    evalFiles,
    roleFiles,
    promptFiles
  };
}

async function readHarnessDirectoriesSerial(
  packageDir: string,
  readLimiter: HarnessPackageReadLimiter
) {
  return {
    phaseFiles: await readOptionalDirectory(
      packageDir,
      "phases",
      [".yaml", ".yml", ".json"],
      readLimiter
    ),
    gateFiles: await readOptionalDirectory(
      packageDir,
      "gates",
      [".yaml", ".yml", ".json"],
      readLimiter
    ),
    policyFiles: await readOptionalDirectory(
      packageDir,
      "policies",
      [".yaml", ".yml", ".json"],
      readLimiter
    ),
    toolFiles: await readOptionalDirectory(
      packageDir,
      "tools",
      [".yaml", ".yml", ".json"],
      readLimiter
    ),
    artifactSchemaFiles: await readOptionalDirectory(
      packageDir,
      "artifact-schemas",
      [".json"],
      readLimiter
    ),
    evalFiles: await readOptionalDirectory(
      packageDir,
      "evals",
      [".yaml", ".yml", ".json"],
      readLimiter
    ),
    roleFiles: await readOptionalDirectory(
      packageDir,
      "roles",
      [".yaml", ".yml", ".json"],
      readLimiter
    ),
    promptFiles: await readOptionalDirectory(
      packageDir,
      "prompts",
      [".md"],
      readLimiter
    )
  };
}

async function readOptionalDirectory(
  packageDir: string,
  dir: string,
  extensions: readonly string[],
  readLimiter?: HarnessPackageReadLimiter | undefined
): Promise<SourceFile[]> {
  const absoluteDir = resolve(packageDir, dir);
  const root = resolve(packageDir);
  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    await assertResolvedPathInsidePackage(root, absoluteDir, dir);
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => join(dir, entry.name))
    .filter((path) => extensions.includes(extname(path)))
    .sort((a, b) => a.localeCompare(b));

  if (readLimiter === undefined) {
    return Promise.all(files.map((path) => readSourceFile(packageDir, path)));
  }

  const loaded: SourceFile[] = [];

  for (const path of files) {
    loaded.push(await readSourceFile(packageDir, path, readLimiter));
  }

  return loaded;
}

async function readSourceFile(
  packageDir: string,
  relativePath: string,
  readLimiter?: HarnessPackageReadLimiter | undefined
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

  await assertResolvedPathInsidePackage(root, absolutePath, normalizedRelative);

  readLimiter?.reserveFile(normalizedRelative);

  const file = {
    absolutePath,
    relativePath: normalizedRelative,
    raw: await readFile(absolutePath, "utf8")
  };

  readLimiter?.observeFile(file);

  return file;
}

async function assertResolvedPathInsidePackage(
  root: string,
  absolutePath: string,
  relativePath: string
) {
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(absolutePath)
  ]);
  const normalizedRealRelative = normalizeRelativePath(
    relative(realRoot, realTarget)
  );

  if (
    normalizedRealRelative === ".." ||
    normalizedRealRelative.startsWith("../")
  ) {
    throw new HarnessLoaderError(
      "parse_error",
      `Refusing to load ${relativePath} outside harness package`,
      undefined,
      {
        reason: "path_escape",
        details: {
          path: relativePath,
          target: realTarget
        }
      }
    );
  }
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
  files: readonly Pick<SourceFile, "relativePath" | "raw">[],
  dependencies: readonly ResolvedDependency[] = []
) {
  const filePayload = [...files]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(
      (file) =>
        `${file.relativePath}\0${file.raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")}`
    )
    .join("\0");
  const dependencySegments = canonicalDependencyHashSegments(dependencies);
  const payload =
    dependencySegments.length === 0
      ? filePayload
      : [
          filePayload,
          "schemaVersion",
          SUPPORTED_HARNESS_SCHEMA_VERSION,
          "dependencies",
          ...dependencySegments
        ].join("\0");

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
