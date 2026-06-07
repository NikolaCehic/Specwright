import { z } from "zod";
import { type TrustStore } from "../trust";
import {
  CapabilitySurfaceSchema,
  classifyTransition,
  type CapabilitySurface,
  type CompatibilityClass
} from "./classify";
import {
  DEFAULT_COMPATIBILITY_MATRIX,
  DEFAULT_RUNTIME_VERSION,
  CompatibilityMatrixError,
  lookupCompatibilityMatrix,
  isLoadableCompatibilityClass,
  type CompatibilityMatrix
} from "./matrix";
import {
  MigrationDescriptorError,
  applyMigrationDescriptor,
  parseMigrationDescriptor,
  type MigrationDescriptor,
  type MigrationResult,
  type MigrationSourceFile
} from "./migration";

const nonEmptyString = z.string().min(1);

export const CompatibilityManifestEnvelopeSchema = z
  .object({
    version: nonEmptyString,
    schemaVersion: nonEmptyString
  })
  .passthrough();

export type CompatibilityManifestEnvelope = z.infer<
  typeof CompatibilityManifestEnvelopeSchema
>;

export type CompatibilitySourceFile = MigrationSourceFile & {
  absolutePath?: string;
};

export type CompatibilityAdmission = {
  matrixId: string;
  matrixRowId: string;
  runtimeVersion: string;
  declaredSchemaVersion: string;
  targetSchemaVersion: string;
  packageVersion: string;
  compatibilityClass: string;
  loaderBehavior: "load" | "migrate";
  migration?: {
    descriptorId: string;
    originalSpecHash: string;
    migratedSpecHash: string;
    signatureRef: string;
    trustStoreVersion: string;
  };
};

export type AdmitHarnessCompatibilityOptions = {
  rawManifest: unknown;
  files: readonly CompatibilitySourceFile[];
  targetSchemaVersion: string;
  runtimeVersion?: string;
  matrix?: CompatibilityMatrix;
  migrationDescriptor?: unknown;
  migrationTrustStore?: TrustStore;
  migrationNow?: Date | string;
  computeSpecHash(files: readonly MigrationSourceFile[]): string;
};

export class CompatibilityAdmissionError extends Error {
  readonly code: "compatibility_denied" | "unsupported_schema_version";
  readonly reason: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: "compatibility_denied" | "unsupported_schema_version",
    reason: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CompatibilityAdmissionError";
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

export type AdmittedHarnessCompatibility = {
  files: CompatibilitySourceFile[];
  manifestFile: CompatibilitySourceFile;
  admission: CompatibilityAdmission;
};

export function parseCompatibilityManifestEnvelope(rawManifest: unknown) {
  const parsed = CompatibilityManifestEnvelopeSchema.safeParse(rawManifest);

  if (!parsed.success) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "malformed_compatibility_manifest",
      `Harness manifest compatibility envelope is invalid: ${parsed.error.message}`,
      {
        schema: "CompatibilityManifestEnvelopeSchema",
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

export function admitHarnessCompatibility(
  options: AdmitHarnessCompatibilityOptions
): AdmittedHarnessCompatibility {
  const manifest = parseCompatibilityManifestEnvelope(options.rawManifest);
  const matrix = options.matrix ?? DEFAULT_COMPATIBILITY_MATRIX;
  const runtimeVersion = options.runtimeVersion ?? DEFAULT_RUNTIME_VERSION;
  const matrixRow = lookupMatrix(matrix, {
    runtimeVersion,
    harnessSchemaVersion: manifest.schemaVersion,
    packageVersion: manifest.version
  });
  const classified = classifyAdmission({
    rawManifest: options.rawManifest,
    manifest,
    matrixRowId: matrixRow.id,
    targetSchemaVersion: options.targetSchemaVersion,
    runtimeVersion,
    matrixSupportClass: matrixRow.supportClass,
    matrixLoaderBehavior: matrixRow.loaderBehavior,
    sourceCapabilitySurface: matrixRow.sourceCapabilitySurface,
    targetCapabilitySurface: matrixRow.targetCapabilitySurface
  });

  rejectMatrixClassifierMismatch({
    matrixRowId: matrixRow.id,
    matrixSupportClass: matrixRow.supportClass,
    matrixLoaderBehavior: matrixRow.loaderBehavior,
    classified,
    declaredSchemaVersion: manifest.schemaVersion,
    targetSchemaVersion: options.targetSchemaVersion
  });

  if (
    matrixRow.loaderBehavior === "load" &&
    isLoadableCompatibilityClass(matrixRow.supportClass)
  ) {
    if (manifest.schemaVersion !== options.targetSchemaVersion) {
      throw new CompatibilityAdmissionError(
        "compatibility_denied",
        "schema_version_load_mismatch",
        `Matrix row ${matrixRow.id} cannot load ${manifest.schemaVersion} as ${options.targetSchemaVersion}`,
        {
          matrixRowId: matrixRow.id,
          declaredSchemaVersion: manifest.schemaVersion,
          targetSchemaVersion: options.targetSchemaVersion
        }
      );
    }

    const manifestFile = requiredManifestFile(options.files);

    return {
      files: cloneFiles(options.files),
      manifestFile,
      admission: {
        matrixId: matrix.matrixId,
        matrixRowId: matrixRow.id,
        runtimeVersion,
        declaredSchemaVersion: manifest.schemaVersion,
        targetSchemaVersion: options.targetSchemaVersion,
        packageVersion: manifest.version,
        compatibilityClass: matrixRow.supportClass,
        loaderBehavior: "load"
      }
    };
  }

  if (matrixRow.loaderBehavior !== "migrate") {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "matrix_denied",
      `Compatibility matrix row ${matrixRow.id} denies ${manifest.schemaVersion}`,
      {
        matrixRowId: matrixRow.id,
        supportClass: matrixRow.supportClass,
        loaderBehavior: matrixRow.loaderBehavior
      }
    );
  }

  if (options.migrationDescriptor === undefined) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "missing_migration_descriptor",
      `Schema version ${manifest.schemaVersion} requires a signed migration descriptor`,
      {
        matrixRowId: matrixRow.id,
        declaredSchemaVersion: manifest.schemaVersion,
        targetSchemaVersion: options.targetSchemaVersion
      }
    );
  }

  if (options.migrationTrustStore === undefined) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "missing_migration_trust_store",
      `Schema version ${manifest.schemaVersion} requires a migration trust store`,
      {
        matrixRowId: matrixRow.id,
        declaredSchemaVersion: manifest.schemaVersion
      }
    );
  }

  const descriptor = parseDescriptor(options.migrationDescriptor);
  rejectDescriptorMismatch(
    descriptor,
    manifest.schemaVersion,
    options.targetSchemaVersion
  );
  const migration = applyDescriptor(
    options,
    descriptor,
    options.migrationTrustStore
  );
  const manifestFile = requiredManifestFile(migration.files);

  return {
    files: mergeMigratedFiles(options.files, migration.files),
    manifestFile,
    admission: {
      matrixId: matrix.matrixId,
      matrixRowId: matrixRow.id,
      runtimeVersion,
      declaredSchemaVersion: manifest.schemaVersion,
      targetSchemaVersion: options.targetSchemaVersion,
      packageVersion: manifest.version,
      compatibilityClass: matrixRow.supportClass,
      loaderBehavior: "migrate",
      migration: {
        descriptorId: migration.descriptorId,
        originalSpecHash: migration.originalSpecHash,
        migratedSpecHash: migration.migratedSpecHash,
        signatureRef: migration.signatureRef,
        trustStoreVersion: migration.trustStoreVersion
      }
    }
  };
}

function lookupMatrix(
  matrix: CompatibilityMatrix,
  input: {
    runtimeVersion: string;
    harnessSchemaVersion: string;
    packageVersion: string;
  }
) {
  try {
    return lookupCompatibilityMatrix(matrix, input);
  } catch (error) {
    if (!(error instanceof CompatibilityMatrixError)) {
      throw error;
    }

    throw new CompatibilityAdmissionError(
      error.reason === "no_matrix_cell"
        ? "unsupported_schema_version"
        : "compatibility_denied",
      error.reason,
      error.message,
      error.details
    );
  }
}

function classifyAdmission(input: {
  rawManifest: unknown;
  manifest: CompatibilityManifestEnvelope;
  matrixRowId: string;
  targetSchemaVersion: string;
  runtimeVersion: string;
  matrixSupportClass: CompatibilityClass;
  matrixLoaderBehavior: "load" | "migrate" | "deny";
  sourceCapabilitySurface: unknown;
  targetCapabilitySurface: unknown;
}) {
  const sourceCapabilitySurface =
    !isRecord(input.sourceCapabilitySurface)
      ? undefined
      : CapabilitySurfaceSchema.parse(input.sourceCapabilitySurface);
  if (
    input.matrixLoaderBehavior === "load" &&
    requiresExplicitSourceCapabilitySurface(input.matrixSupportClass) &&
    sourceCapabilitySurface === undefined
  ) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "missing_source_capability_surface",
      `Compatibility matrix row ${input.matrixRowId} must declare a source capability surface for ${input.matrixSupportClass} load admission`,
      {
        matrixRowId: input.matrixRowId,
        supportClass: input.matrixSupportClass,
        loaderBehavior: input.matrixLoaderBehavior,
        declaredSchemaVersion: input.manifest.schemaVersion,
        targetSchemaVersion: input.targetSchemaVersion
      }
    );
  }

  const targetCapabilitySurface =
    (isRecord(input.targetCapabilitySurface)
      ? CapabilitySurfaceSchema.parse(input.targetCapabilitySurface)
      : undefined) ??
    (sourceCapabilitySurface === undefined
      ? undefined
      : capabilitySurfaceFromManifest(input.rawManifest));

  return classifyTransition({
    declaredSchemaVersion: input.manifest.schemaVersion,
    targetSchemaVersion: input.targetSchemaVersion,
    packageVersion: input.manifest.version,
    runtimeVersion: input.runtimeVersion,
    normalizedContentEqual: input.matrixSupportClass === "content-stable",
    metadataOnly: input.matrixSupportClass === "patch-compatible",
    additiveOnly: input.matrixSupportClass === "additive-compatible",
    replayVerified: input.matrixSupportClass === "replay-compatible",
    schemaVersionChanged:
      input.manifest.schemaVersion !== input.targetSchemaVersion,
    interpretable: input.matrixSupportClass !== "breaking",
    ...(sourceCapabilitySurface === undefined
      ? {}
      : { sourceCapabilitySurface }),
    ...(targetCapabilitySurface === undefined ? {} : { targetCapabilitySurface })
  });
}

function requiresExplicitSourceCapabilitySurface(value: CompatibilityClass) {
  return value === "additive-compatible" || value === "replay-compatible";
}

function rejectMatrixClassifierMismatch(input: {
  matrixRowId: string;
  matrixSupportClass: CompatibilityClass;
  matrixLoaderBehavior: "load" | "migrate" | "deny";
  classified: CompatibilityClass;
  declaredSchemaVersion: string;
  targetSchemaVersion: string;
}) {
  if (
    input.classified === "migration-required" &&
    (input.matrixSupportClass !== "migration-required" ||
      input.matrixLoaderBehavior !== "migrate")
  ) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "classifier_requires_migration",
      `Compatibility classifier requires migration for matrix row ${input.matrixRowId}`,
      input
    );
  }

  if (
    input.classified === "breaking" &&
    input.matrixLoaderBehavior !== "deny"
  ) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "classifier_breaking_transition",
      `Compatibility classifier rejected matrix row ${input.matrixRowId} as breaking`,
      input
    );
  }
}

function capabilitySurfaceFromManifest(rawManifest: unknown): CapabilitySurface {
  const record = isRecord(rawManifest) ? rawManifest : {};
  const tools = isRecord(record.tools) ? record.tools : undefined;
  const runtime = isRecord(record.runtime) ? record.runtime : {};

  return {
    tools: Array.isArray(record.tools)
      ? refsFrom(record.tools)
      : stringArray(tools?.allow),
    requireApproval: stringArray(tools?.requireApproval),
    runtimeAuthority: {
      ...(typeof runtime.strict === "boolean" ? { strict: runtime.strict } : {}),
      ...(typeof runtime.failClosed === "boolean"
        ? { failClosed: runtime.failClosed }
        : {}),
      ...(typeof runtime.modelOutputAuthority === "string"
        ? { modelOutputAuthority: runtime.modelOutputAuthority }
        : {})
    }
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function refsFrom(value: readonly unknown[]) {
  return value.map(referenceId).filter((id): id is string => id !== undefined);
}

function referenceId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return (
    stringValue(value.id) ??
    stringValue(value.ref) ??
    stringValue(value.tool) ??
    stringValue(value.toolId)
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDescriptor(input: unknown) {
  try {
    return parseMigrationDescriptor(input);
  } catch (error) {
    if (!(error instanceof MigrationDescriptorError)) {
      throw error;
    }

    throw migrationAdmissionError(error);
  }
}

function applyDescriptor(
  options: AdmitHarnessCompatibilityOptions,
  descriptor: MigrationDescriptor,
  trustStore: TrustStore
): MigrationResult {
  try {
    return applyMigrationDescriptor({
      descriptor,
      files: options.files,
      trustStore,
      computeSpecHash: options.computeSpecHash,
      ...(options.migrationNow === undefined
        ? {}
        : { now: options.migrationNow })
    });
  } catch (error) {
    if (!(error instanceof MigrationDescriptorError)) {
      throw error;
    }

    throw migrationAdmissionError(error);
  }
}

function migrationAdmissionError(error: MigrationDescriptorError) {
  return new CompatibilityAdmissionError(
    "compatibility_denied",
    error.reason,
    error.message,
    error.details
  );
}

function rejectDescriptorMismatch(
  descriptor: MigrationDescriptor,
  declaredSchemaVersion: string,
  targetSchemaVersion: string
) {
  if (
    descriptor.sourceSchemaVersion !== declaredSchemaVersion ||
    descriptor.targetSchemaVersion !== targetSchemaVersion ||
    descriptor.transform.from !== declaredSchemaVersion ||
    descriptor.transform.to !== targetSchemaVersion
  ) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "migration_descriptor_mismatch",
      `Migration descriptor ${descriptor.migrationId} does not match ${declaredSchemaVersion} -> ${targetSchemaVersion}`,
      {
        migrationId: descriptor.migrationId,
        descriptorSourceSchemaVersion: descriptor.sourceSchemaVersion,
        descriptorTargetSchemaVersion: descriptor.targetSchemaVersion,
        declaredSchemaVersion,
        targetSchemaVersion
      }
    );
  }
}

function mergeMigratedFiles(
  original: readonly CompatibilitySourceFile[],
  migrated: readonly MigrationSourceFile[]
): CompatibilitySourceFile[] {
  const migratedByPath = new Map(
    migrated.map((file) => [file.relativePath, file])
  );

  return original.map((file) => {
    const migratedFile = migratedByPath.get(file.relativePath);

    if (migratedFile === undefined) {
      return {
        ...file
      };
    }

    return {
      ...file,
      raw: migratedFile.raw
    };
  });
}

function cloneFiles(files: readonly CompatibilitySourceFile[]) {
  return files.map((file) => ({ ...file }));
}

function requiredManifestFile(files: readonly CompatibilitySourceFile[]) {
  const manifestFile = files.find(
    (file) => file.relativePath === "harness.yaml"
  );

  if (manifestFile === undefined) {
    throw new CompatibilityAdmissionError(
      "compatibility_denied",
      "missing_migrated_manifest",
      "Compatibility admission did not produce harness.yaml"
    );
  }

  return manifestFile;
}
