import { createHash, createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  TrustStoreEntrySchema,
  type TrustStore,
  type TrustStoreEntry
} from "../trust";

const nonEmptyString = z.string().min(1);
const specHashString = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const base64String = nonEmptyString.refine((value) => {
  try {
    decodeBase64(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a base64-encoded value");

export const MigrationDescriptorSignatureSchema = z
  .object({
    publisherId: nonEmptyString,
    signingKeyId: nonEmptyString,
    algorithm: z.literal("ed25519"),
    signature: base64String,
    signatureRef: nonEmptyString.optional()
  })
  .strict();

export type MigrationDescriptorSignature = z.infer<
  typeof MigrationDescriptorSignatureSchema
>;

const ContractVersionRefSchema = z
  .object({
    contractId: nonEmptyString,
    version: nonEmptyString
  })
  .strict();

const MigrationTransformSchema = z
  .object({
    operation: z.literal("replace-manifest-schema-version"),
    from: nonEmptyString,
    to: nonEmptyString
  })
  .strict();

export const MigrationDescriptorBodySchema = z
  .object({
    migrationId: nonEmptyString,
    source: ContractVersionRefSchema,
    target: ContractVersionRefSchema,
    sourceSchemaVersion: nonEmptyString,
    targetSchemaVersion: nonEmptyString,
    migrationType: z.literal("deterministic-text-transform"),
    transform: MigrationTransformSchema,
    dataLoss: z.enum(["none", "metadata-only", "lossy"]),
    authorityChanges: z.array(nonEmptyString),
    redactionChanges: z.array(nonEmptyString),
    validation: z
      .object({
        before: z.array(nonEmptyString),
        after: z.array(nonEmptyString)
      })
      .strict(),
    rollbackStrategy: nonEmptyString,
    replayFixtures: z.array(nonEmptyString),
    operatorApprovalRequired: z.boolean(),
    expectedMigratedSpecHash: specHashString
  })
  .strict();

export type MigrationDescriptorBody = z.infer<
  typeof MigrationDescriptorBodySchema
>;

export const MigrationDescriptorSchema = MigrationDescriptorBodySchema.extend({
  signature: MigrationDescriptorSignatureSchema
}).strict();

export type MigrationDescriptor = z.infer<typeof MigrationDescriptorSchema>;

export type MigrationSourceFile = {
  relativePath: string;
  raw: string;
};

export type MigrationResult = {
  descriptorId: string;
  originalSpecHash: string;
  migratedSpecHash: string;
  files: MigrationSourceFile[];
  signatureRef: string;
  trustStoreVersion: string;
};

export type VerifyMigrationDescriptorOptions = {
  descriptor: unknown;
  trustStore?: TrustStore;
  now?: Date | string;
};

export type ApplyMigrationDescriptorOptions = {
  descriptor: MigrationDescriptor;
  files: readonly MigrationSourceFile[];
  trustStore: TrustStore;
  now?: Date | string;
  computeSpecHash(files: readonly MigrationSourceFile[]): string;
};

export type MigrationRejectReason =
  | "malformed_descriptor"
  | "missing_trust_store"
  | "untrusted_publisher"
  | "unknown_key"
  | "revoked_key"
  | "expired_key"
  | "unsupported_algorithm"
  | "bad_signature"
  | "transform_failed"
  | "attestation_mismatch";

export class MigrationDescriptorError extends Error {
  readonly reason: MigrationRejectReason;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    reason: MigrationRejectReason,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "MigrationDescriptorError";
    this.reason = reason;
    this.details = details;
  }
}

export function applyMigrationDescriptor(
  options: ApplyMigrationDescriptorOptions
): MigrationResult {
  const verification = verifyMigrationDescriptor({
    descriptor: options.descriptor,
    trustStore: options.trustStore,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const originalSpecHash = options.computeSpecHash(options.files);
  const files = applyDeterministicTransform(options.descriptor, options.files);
  const migratedSpecHash = options.computeSpecHash(files);

  if (migratedSpecHash !== options.descriptor.expectedMigratedSpecHash) {
    throw new MigrationDescriptorError(
      "attestation_mismatch",
      `Migration ${options.descriptor.migrationId} produced ${migratedSpecHash}, expected ${options.descriptor.expectedMigratedSpecHash}`,
      {
        migrationId: options.descriptor.migrationId,
        expected: options.descriptor.expectedMigratedSpecHash,
        actual: migratedSpecHash
      }
    );
  }

  return {
    descriptorId: options.descriptor.migrationId,
    originalSpecHash,
    migratedSpecHash,
    files,
    signatureRef: verification.signatureRef,
    trustStoreVersion: verification.trustStoreVersion
  };
}

export function verifyMigrationDescriptor(
  options: VerifyMigrationDescriptorOptions
) {
  const descriptor = parseMigrationDescriptor(options.descriptor);

  if (descriptor.signature.algorithm !== "ed25519") {
    throw new MigrationDescriptorError(
      "unsupported_algorithm",
      `Unsupported migration descriptor signature algorithm ${descriptor.signature.algorithm}`,
      signatureDetails(descriptor)
    );
  }

  if (options.trustStore === undefined) {
    throw new MigrationDescriptorError(
      "missing_trust_store",
      "Migration descriptor verification requires a trust store",
      signatureDetails(descriptor)
    );
  }

  const entry = resolveSigningEntry(options.trustStore, descriptor);
  rejectInvalidEntry(entry, options.now);
  const canonicalBody = canonicalizeMigrationDescriptor(descriptor);
  const signature = decodeBase64(descriptor.signature.signature);

  if (!verify(null, canonicalBody, parsePublicKey(entry.publicKey), signature)) {
    throw new MigrationDescriptorError(
      "bad_signature",
      `Migration descriptor ${descriptor.migrationId} signature did not verify`,
      signatureDetails(descriptor, options.trustStore.version)
    );
  }

  return {
    descriptor,
    signatureRef:
      descriptor.signature.signatureRef ??
      deriveSignatureRef(descriptor.signature.signature),
    trustStoreVersion: options.trustStore.version
  };
}

export function parseMigrationDescriptor(input: unknown): MigrationDescriptor {
  const parsed = MigrationDescriptorSchema.safeParse(input);

  if (!parsed.success) {
    throw new MigrationDescriptorError(
      "malformed_descriptor",
      `Migration descriptor is invalid: ${parsed.error.message}`,
      {
        schema: "MigrationDescriptorSchema",
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

export function canonicalizeMigrationDescriptor(input: unknown) {
  const bodyOnly = MigrationDescriptorBodySchema.safeParse(input);

  if (bodyOnly.success) {
    return canonicalJson(bodyOnly.data);
  }

  const descriptor = parseMigrationDescriptor(input);
  const { signature: _signature, ...body } = descriptor;

  return canonicalJson(body);
}

function applyDeterministicTransform(
  descriptor: MigrationDescriptor,
  files: readonly MigrationSourceFile[]
): MigrationSourceFile[] {
  const transform = descriptor.transform;
  let replaced = false;

  const migrated = files.map((file) => {
    if (file.relativePath !== "harness.yaml") {
      return {
        relativePath: file.relativePath,
        raw: file.raw
      };
    }

    const from = `schemaVersion: ${transform.from}`;
    const to = `schemaVersion: ${transform.to}`;

    if (!file.raw.includes(from)) {
      return {
        relativePath: file.relativePath,
        raw: file.raw
      };
    }

    replaced = true;

    return {
      relativePath: file.relativePath,
      raw: file.raw.replace(from, to)
    };
  });

  if (!replaced) {
    throw new MigrationDescriptorError(
      "transform_failed",
      `Migration ${descriptor.migrationId} did not find schemaVersion ${transform.from}`,
      {
        migrationId: descriptor.migrationId,
        from: transform.from,
        to: transform.to
      }
    );
  }

  return migrated;
}

function resolveSigningEntry(
  trustStore: TrustStore,
  descriptor: MigrationDescriptor
): TrustStoreEntry {
  const resolved = trustStore.resolve(
    descriptor.signature.publisherId,
    descriptor.signature.signingKeyId
  );

  if (resolved === undefined) {
    throw new MigrationDescriptorError(
      trustStore.hasPublisher?.(descriptor.signature.publisherId) === true
        ? "unknown_key"
        : "untrusted_publisher",
      `No trusted migration signing key ${descriptor.signature.signingKeyId} for publisher ${descriptor.signature.publisherId}`,
      signatureDetails(descriptor, trustStore.version)
    );
  }

  const parsed = TrustStoreEntrySchema.safeParse(resolved);

  if (!parsed.success) {
    throw new MigrationDescriptorError(
      "malformed_descriptor",
      `Resolved migration trust store entry is invalid: ${parsed.error.message}`,
      {
        ...signatureDetails(descriptor, trustStore.version),
        schema: "TrustStoreEntrySchema",
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

function rejectInvalidEntry(entry: TrustStoreEntry, nowValue: Date | string | undefined) {
  const now = normalizeNow(nowValue);

  if (entry.algorithm !== "ed25519") {
    throw new MigrationDescriptorError(
      "unsupported_algorithm",
      `Unsupported migration signing key algorithm ${entry.algorithm}`,
      {
        publisherId: entry.publisherId,
        signingKeyId: entry.signingKeyId
      }
    );
  }

  if (entry.status === "revoked") {
    throw new MigrationDescriptorError(
      "revoked_key",
      `Migration signing key ${entry.signingKeyId} is revoked`,
      {
        publisherId: entry.publisherId,
        signingKeyId: entry.signingKeyId
      }
    );
  }

  if (entry.status === "expired") {
    throw new MigrationDescriptorError(
      "expired_key",
      `Migration signing key ${entry.signingKeyId} is expired`,
      {
        publisherId: entry.publisherId,
        signingKeyId: entry.signingKeyId
      }
    );
  }

  if (entry.notBefore !== undefined && new Date(entry.notBefore) > now) {
    throw new MigrationDescriptorError(
      "expired_key",
      `Migration signing key ${entry.signingKeyId} is not yet valid`,
      {
        publisherId: entry.publisherId,
        signingKeyId: entry.signingKeyId,
        notBefore: entry.notBefore
      }
    );
  }

  if (entry.notAfter !== undefined && new Date(entry.notAfter) <= now) {
    throw new MigrationDescriptorError(
      "expired_key",
      `Migration signing key ${entry.signingKeyId} is expired`,
      {
        publisherId: entry.publisherId,
        signingKeyId: entry.signingKeyId,
        notAfter: entry.notAfter
      }
    );
  }
}

function normalizeNow(value: Date | string | undefined) {
  if (value === undefined) {
    return new Date();
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new MigrationDescriptorError(
      "malformed_descriptor",
      `Invalid migration verification time ${String(value)}`,
      {
        field: "now"
      }
    );
  }

  return date;
}

function parsePublicKey(publicKey: string) {
  const trimmed = publicKey.trim();

  if (trimmed.startsWith("-----BEGIN")) {
    return createPublicKey(trimmed);
  }

  return createPublicKey({
    key: decodeBase64(trimmed),
    format: "der",
    type: "spki"
  });
}

function signatureDetails(
  descriptor: MigrationDescriptor,
  trustStoreVersion?: string
) {
  return {
    migrationId: descriptor.migrationId,
    publisherId: descriptor.signature.publisherId,
    signingKeyId: descriptor.signature.signingKeyId,
    ...(trustStoreVersion === undefined ? {} : { trustStoreVersion })
  };
}

function deriveSignatureRef(signature: string) {
  return `sig-sha256:${createHash("sha256")
    .update(decodeBase64(signature).toString("base64"))
    .digest("hex")}`;
}

function decodeBase64(value: string) {
  const compact = value.replace(/\s+/gu, "");
  const decoded = Buffer.from(compact, "base64");

  if (decoded.length === 0) {
    throw new Error("Base64 value decoded to an empty byte array");
  }

  const normalizedInput = compact.replace(/=+$/u, "");
  const normalizedOutput = decoded.toString("base64").replace(/=+$/u, "");

  if (normalizedInput !== normalizedOutput) {
    throw new Error("Invalid base64 encoding");
  }

  return decoded;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);

  return `{${entries.join(",")}}`;
}
