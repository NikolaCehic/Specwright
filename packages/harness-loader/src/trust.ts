import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import type { HarnessManifest } from "@specwright/schemas";
import { z } from "zod";

const nonEmptyString = z.string().min(1);
const isoDateTimeString = z.string().datetime({ offset: true });
const specHashString = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const TrustRejectReasonSchema = z.enum([
  "untrusted_publisher",
  "unknown_key",
  "revoked_key",
  "expired_key",
  "bad_signature",
  "unsupported_algorithm",
  "attestation_mismatch",
  "spec_hash_mismatch",
  "unsigned_in_strict_mode",
  "malformed_trust_metadata",
  "signature_expired",
  "signature_not_yet_valid"
]);
export type TrustRejectReason = z.infer<typeof TrustRejectReasonSchema>;

export const TrustStoreEntrySchema = z
  .object({
    publisherId: nonEmptyString,
    signingKeyId: nonEmptyString,
    publicKey: nonEmptyString,
    algorithm: z.literal("ed25519"),
    status: z.enum(["active", "revoked", "expired"]),
    notBefore: isoDateTimeString.optional(),
    notAfter: isoDateTimeString.optional()
  })
  .strict();
export type TrustStoreEntry = z.infer<typeof TrustStoreEntrySchema>;

export const TrustStoreSchema = z
  .object({
    version: nonEmptyString,
    entries: z.array(TrustStoreEntrySchema)
  })
  .strict();
export type TrustStoreData = z.infer<typeof TrustStoreSchema>;

export const AttestationSchema = z
  .object({
    publisherId: nonEmptyString,
    specHash: specHashString,
    schemaVersion: nonEmptyString,
    notBefore: isoDateTimeString.optional(),
    notAfter: isoDateTimeString.optional()
  })
  .strict();
export type Attestation = z.infer<typeof AttestationSchema>;

const base64String = nonEmptyString.refine((value) => {
  try {
    decodeBase64(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a base64-encoded value");

export const SignatureEnvelopeSchema = z
  .object({
    publisherId: nonEmptyString,
    signingKeyId: nonEmptyString,
    algorithm: nonEmptyString,
    signature: base64String,
    signatureRef: nonEmptyString.optional(),
    attestation: AttestationSchema
  })
  .strict();
export type SignatureEnvelope = z.infer<typeof SignatureEnvelopeSchema>;

export const TrustProvenanceSchema = z
  .object({
    publisherId: nonEmptyString,
    signingKeyId: nonEmptyString,
    signatureRef: nonEmptyString,
    trustStoreVersion: nonEmptyString
  })
  .strict();
export type TrustProvenance = z.infer<typeof TrustProvenanceSchema>;

const HarnessTrustVerifiedPayloadSchema = z
  .object({
    publisherId: nonEmptyString,
    signingKeyId: nonEmptyString,
    algorithm: z.literal("ed25519"),
    signatureRef: nonEmptyString,
    trustStoreVersion: nonEmptyString,
    specHash: specHashString,
    verdict: z.literal("verified")
  })
  .strict();

const HarnessTrustRejectedPayloadSchema = z
  .object({
    publisherId: nonEmptyString.optional(),
    signingKeyId: nonEmptyString.optional(),
    reason: TrustRejectReasonSchema,
    trustStoreVersion: nonEmptyString.optional(),
    failClosed: z.literal(true),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const HarnessTrustVerifiedEventSchema = z
  .object({
    type: z.literal("harness.trust.verified"),
    payload: HarnessTrustVerifiedPayloadSchema
  })
  .strict();

export const HarnessTrustRejectedEventSchema = z
  .object({
    type: z.literal("harness.trust.rejected"),
    payload: HarnessTrustRejectedPayloadSchema
  })
  .strict();

export const HarnessTrustEventSchema = z.union([
  HarnessTrustVerifiedEventSchema,
  HarnessTrustRejectedEventSchema
]);
export type HarnessTrustEvent = z.infer<typeof HarnessTrustEventSchema>;

export type TrustStore = {
  version: string;
  resolve(
    publisherId: string,
    signingKeyId: string
  ): TrustStoreEntry | undefined;
  hasPublisher?(publisherId: string): boolean;
};

export type TrustVerdict = {
  status: "verified";
  publisherId: string;
  signingKeyId: string;
  algorithm: "ed25519";
  signatureRef: string;
  trustStoreVersion: string;
  specHash: string;
  provenance: TrustProvenance;
};

export type VerifyPackageTrustOptions = {
  manifest: HarnessManifest;
  envelope?: unknown;
  trustStore?: TrustStore;
  strict?: boolean;
  now?: Date | string;
  expectedSpecHash: string;
};

type TrustRejectionContext = {
  publisherId?: string;
  signingKeyId?: string;
  trustStoreVersion?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class TrustRejectedError extends Error {
  readonly reason: TrustRejectReason;
  readonly publisherId: string | undefined;
  readonly signingKeyId: string | undefined;
  readonly trustStoreVersion: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    reason: TrustRejectReason,
    message: string,
    context: TrustRejectionContext = {}
  ) {
    super(message);
    this.name = "TrustRejectedError";
    this.reason = reason;
    this.publisherId = context.publisherId;
    this.signingKeyId = context.signingKeyId;
    this.trustStoreVersion = context.trustStoreVersion;
    this.details = context.details;

    if (context.cause !== undefined) {
      Object.assign(this, { cause: context.cause });
    }
  }
}

export class InMemoryTrustStore implements TrustStore {
  readonly version: string;
  private readonly entriesByPublisher = new Map<
    string,
    Map<string, TrustStoreEntry>
  >();

  constructor(input: unknown) {
    const parsed = TrustStoreSchema.safeParse(input);

    if (!parsed.success) {
      throw new TrustRejectedError(
        "malformed_trust_metadata",
        `Trust store metadata is invalid: ${parsed.error.message}`,
        {
          details: {
            schema: "TrustStoreSchema"
          },
          cause: parsed.error
        }
      );
    }

    this.version = parsed.data.version;

    for (const entry of parsed.data.entries) {
      const publisherEntries =
        this.entriesByPublisher.get(entry.publisherId) ?? new Map();
      publisherEntries.set(entry.signingKeyId, entry);
      this.entriesByPublisher.set(entry.publisherId, publisherEntries);
    }
  }

  resolve(publisherId: string, signingKeyId: string) {
    return this.entriesByPublisher.get(publisherId)?.get(signingKeyId);
  }

  hasPublisher(publisherId: string) {
    return this.entriesByPublisher.has(publisherId);
  }
}

export async function loadTrustStoreFromFile(path: string) {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new TrustRejectedError(
      "malformed_trust_metadata",
      `Could not read trust store ${path}`,
      {
        details: {
          path
        },
        cause: error
      }
    );
  }

  return new InMemoryTrustStore(parsedJson);
}

export function verifyPackageTrust(
  options: VerifyPackageTrustOptions
): TrustVerdict | undefined {
  const strict = options.strict ?? true;

  if (options.envelope === undefined) {
    if (!strict) {
      return undefined;
    }

    throw new TrustRejectedError(
      "unsigned_in_strict_mode",
      "Harness package is unsigned in strict trust mode"
    );
  }

  const envelope = parseSignatureEnvelope(options.envelope);

  if (envelope.algorithm !== "ed25519") {
    throw new TrustRejectedError(
      "unsupported_algorithm",
      `Unsupported signature algorithm ${envelope.algorithm}`,
      envelopeContext(envelope)
    );
  }

  if (options.trustStore === undefined) {
    throw new TrustRejectedError(
      "untrusted_publisher",
      `Publisher ${envelope.publisherId} is not trusted by a configured trust store`,
      envelopeContext(envelope)
    );
  }

  const trustStoreVersion = parseTrustStoreVersion(options.trustStore);
  const entry = resolveTrustStoreEntry(options.trustStore, envelope);
  const entryContext = envelopeContext(envelope, trustStoreVersion);

  if (entry === undefined) {
    throw new TrustRejectedError(
      options.trustStore.hasPublisher?.(envelope.publisherId) === true
        ? "unknown_key"
        : "untrusted_publisher",
      `No trusted signing key ${envelope.signingKeyId} for publisher ${envelope.publisherId}`,
      entryContext
    );
  }

  if (entry.status === "revoked") {
    throw new TrustRejectedError(
      "revoked_key",
      `Signing key ${entry.signingKeyId} for publisher ${entry.publisherId} is revoked`,
      entryContext
    );
  }

  const now = normalizeNow(options.now);

  if (entry.status === "expired") {
    throw new TrustRejectedError(
      "expired_key",
      `Signing key ${entry.signingKeyId} for publisher ${entry.publisherId} is expired`,
      entryContext
    );
  }

  rejectOutsideValidityWindow(entry.notBefore, entry.notAfter, now, entryContext);

  const canonicalAttestation = canonicalizeAttestation(envelope.attestation);
  const signature = decodeBase64(envelope.signature);

  if (
    !verifyEd25519Signature(
      canonicalAttestation,
      entry.publicKey,
      signature,
      entryContext
    )
  ) {
    throw new TrustRejectedError(
      "bad_signature",
      `Signature for publisher ${envelope.publisherId} did not verify`,
      entryContext
    );
  }

  rejectInvalidSignatureWindow(envelope.attestation, now, entryContext);

  if (
    envelope.attestation.publisherId !== envelope.publisherId ||
    envelope.attestation.schemaVersion !== options.manifest.schemaVersion
  ) {
    throw new TrustRejectedError(
      "attestation_mismatch",
      "Signature attestation does not match the package manifest",
      {
        ...entryContext,
        details: {
          attestedPublisherId: envelope.attestation.publisherId,
          envelopePublisherId: envelope.publisherId,
          attestedSchemaVersion: envelope.attestation.schemaVersion,
          manifestSchemaVersion: options.manifest.schemaVersion
        }
      }
    );
  }

  const specHash = options.expectedSpecHash;

  if (envelope.attestation.specHash !== specHash) {
    throw new TrustRejectedError(
      "spec_hash_mismatch",
      "Signed attestation specHash does not match loaded package bytes",
      {
        ...entryContext,
        details: {
          attestedSpecHash: envelope.attestation.specHash,
          actualSpecHash: specHash
        }
      }
    );
  }

  const signatureRef =
    envelope.signatureRef ?? deriveSignatureRef(envelope.signature);
  const provenance = TrustProvenanceSchema.parse({
    publisherId: envelope.publisherId,
    signingKeyId: envelope.signingKeyId,
    signatureRef,
    trustStoreVersion
  });

  return {
    status: "verified",
    publisherId: envelope.publisherId,
    signingKeyId: envelope.signingKeyId,
    algorithm: "ed25519",
    signatureRef,
    trustStoreVersion,
    specHash,
    provenance
  };
}

export function buildTrustVerifiedEvent(verdict: TrustVerdict) {
  return HarnessTrustVerifiedEventSchema.parse({
    type: "harness.trust.verified",
    payload: {
      publisherId: verdict.publisherId,
      signingKeyId: verdict.signingKeyId,
      algorithm: verdict.algorithm,
      signatureRef: verdict.signatureRef,
      trustStoreVersion: verdict.trustStoreVersion,
      specHash: verdict.specHash,
      verdict: verdict.status
    }
  });
}

export function buildTrustRejectedEvent(
  error: TrustRejectedError
): HarnessTrustEvent {
  return HarnessTrustRejectedEventSchema.parse({
    type: "harness.trust.rejected",
    payload: {
      ...(error.publisherId === undefined
        ? {}
        : { publisherId: error.publisherId }),
      ...(error.signingKeyId === undefined
        ? {}
        : { signingKeyId: error.signingKeyId }),
      reason: error.reason,
      ...(error.trustStoreVersion === undefined
        ? {}
        : { trustStoreVersion: error.trustStoreVersion }),
      failClosed: true,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  });
}

export function canonicalizeAttestation(attestation: Attestation) {
  return canonicalJson(AttestationSchema.parse(attestation));
}

function parseSignatureEnvelope(envelope: unknown) {
  const parsed = SignatureEnvelopeSchema.safeParse(envelope);

  if (!parsed.success) {
    throw new TrustRejectedError(
      "malformed_trust_metadata",
      `Signature envelope is invalid: ${parsed.error.message}`,
      {
        details: {
          schema: "SignatureEnvelopeSchema"
        },
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

function parseTrustStoreVersion(trustStore: TrustStore) {
  if (typeof trustStore.version !== "string" || trustStore.version.length === 0) {
    throw new TrustRejectedError(
      "malformed_trust_metadata",
      "Trust store version must be a non-empty string",
      {
        details: {
          schema: "TrustStore"
        }
      }
    );
  }

  return trustStore.version;
}

function resolveTrustStoreEntry(
  trustStore: TrustStore,
  envelope: SignatureEnvelope
) {
  const resolved = trustStore.resolve(
    envelope.publisherId,
    envelope.signingKeyId
  );

  if (resolved === undefined) {
    return undefined;
  }

  const parsed = TrustStoreEntrySchema.safeParse(resolved);

  if (!parsed.success) {
    throw new TrustRejectedError(
      "malformed_trust_metadata",
      `Resolved trust store entry is invalid: ${parsed.error.message}`,
      {
        ...envelopeContext(envelope, trustStore.version),
        details: {
          schema: "TrustStoreEntrySchema"
        },
        cause: parsed.error
      }
    );
  }

  return parsed.data;
}

function verifyEd25519Signature(
  canonicalAttestation: string,
  publicKey: string,
  signature: Uint8Array,
  context: TrustRejectionContext
) {
  try {
    return verify(null, canonicalAttestation, parsePublicKey(publicKey), signature);
  } catch (error) {
    throw new TrustRejectedError(
      "malformed_trust_metadata",
      "Trust store public key could not be parsed",
      {
        ...context,
        details: {
          schema: "TrustStoreEntrySchema"
        },
        cause: error
      }
    );
  }
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

function rejectOutsideValidityWindow(
  notBefore: string | undefined,
  notAfter: string | undefined,
  now: Date,
  context: TrustRejectionContext
) {
  if (notBefore !== undefined && new Date(notBefore).getTime() > now.getTime()) {
    throw new TrustRejectedError(
      "expired_key",
      "Signing key is not yet valid",
      {
        ...context,
        details: {
          validity: "not_before",
          notBefore
        }
      }
    );
  }

  if (notAfter !== undefined && new Date(notAfter).getTime() <= now.getTime()) {
    throw new TrustRejectedError("expired_key", "Signing key is expired", {
      ...context,
      details: {
        validity: "not_after",
        notAfter
      }
    });
  }
}

function rejectInvalidSignatureWindow(
  attestation: Attestation,
  now: Date,
  context: TrustRejectionContext
) {
  if (
    attestation.notBefore !== undefined &&
    new Date(attestation.notBefore).getTime() > now.getTime()
  ) {
    throw new TrustRejectedError(
      "signature_not_yet_valid",
      "Signature attestation is not yet valid",
      {
        ...context,
        details: {
          notBefore: attestation.notBefore
        }
      }
    );
  }

  if (
    attestation.notAfter !== undefined &&
    new Date(attestation.notAfter).getTime() <= now.getTime()
  ) {
    throw new TrustRejectedError(
      "signature_expired",
      "Signature attestation is expired",
      {
        ...context,
        details: {
          notAfter: attestation.notAfter
        }
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
    throw new TrustRejectedError(
      "malformed_trust_metadata",
      `Invalid trust verification time ${String(value)}`,
      {
        details: {
          field: "now"
        }
      }
    );
  }

  return date;
}

function envelopeContext(
  envelope: SignatureEnvelope,
  trustStoreVersion?: string
) {
  return {
    publisherId: envelope.publisherId,
    signingKeyId: envelope.signingKeyId,
    ...(trustStoreVersion === undefined ? {} : { trustStoreVersion })
  };
}

function deriveSignatureRef(signature: string) {
  const digest = createHash("sha256")
    .update(decodeBase64(signature).toString("base64"))
    .digest("hex");

  return `sig-sha256:${digest}`;
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
