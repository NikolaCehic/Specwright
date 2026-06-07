import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSpecHash,
  HarnessLoaderError,
  InMemoryTrustStore,
  loadHarnessPackage,
  loadHarnessPackageWithRecord,
  type HarnessTrustEvent,
  type TrustRejectReason,
  type TrustStore
} from "./index";
import {
  makeSignedHarnessPackage,
  validHarnessFiles,
  writeHarnessPackage
} from "../test/fixtures/trust-fixtures";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "specwright-harness-trust-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("harness package trust verification", () => {
  test("loads a correctly signed trusted package and records provenance", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);
    const events: HarnessTrustEvent[] = [];

    const record = await loadHarnessPackageWithRecord({
      packageDir: fixture.packageDir,
      signature: fixture.signature,
      trustStore: fixture.trustStore,
      strict: true,
      trustNow: "2026-05-29T00:00:00.000Z",
      loadedAt: "2026-05-29T00:00:00.000Z",
      onTrustEvent: (event) => {
        events.push(event);
      }
    });

    expect(record.trust).toMatchObject({
      status: "verified",
      publisherId: fixture.publisherId,
      signingKeyId: fixture.signingKeyId,
      trustStoreVersion: fixture.trustStoreData.version,
      specHash: fixture.specHash
    });
    expect(record.trust?.signatureRef).toStartWith("sig-sha256:");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "harness.trust.verified",
      payload: {
        publisherId: fixture.publisherId,
        signingKeyId: fixture.signingKeyId,
        signatureRef: record.trust?.signatureRef,
        trustStoreVersion: fixture.trustStoreData.version,
        specHash: record.snapshot.specHash,
        verdict: "verified"
      }
    });

    const metadata = record.snapshot.metadata as {
      fixture?: string;
      provenance?: {
        author?: string;
        trust?: Record<string, unknown>;
      };
    };
    expect(metadata.fixture).toBe("trust");
    expect(metadata.provenance?.author).toBe("loader-test");
    expect(metadata.provenance?.trust).toEqual(record.trust?.provenance);
    expect(Object.isFrozen(record.snapshot)).toBe(true);
  });

  test("binds trust attestation to the final dependency-folded specHash", async () => {
    const files = dependencyBearingHarnessFiles();
    const dependencyResolver = reviewedDependencyResolver();
    const fixture = await makeSignedHarnessPackage(rootDir, {
      name: "signed-with-dependency",
      files,
      loadOptions: {
        dependencyResolver
      }
    });

    const record = await loadHarnessPackageWithRecord({
      packageDir: fixture.packageDir,
      signature: fixture.signature,
      trustStore: fixture.trustStore,
      strict: true,
      trustNow: "2026-05-29T00:00:00.000Z",
      loadedAt: "2026-05-29T00:00:00.000Z",
      dependencyResolver
    });

    expect(record.dependencies.resolved).toHaveLength(1);
    expect(record.trust?.specHash).toBe(record.snapshot.specHash);
    expect(record.trust?.specHash).toBe(fixture.specHash);
  });

  test("rejects dependency packages signed only over local package files", async () => {
    const files = dependencyBearingHarnessFiles();
    const dependencyResolver = reviewedDependencyResolver();
    const localFileOnlySpecHash = computeSpecHash(sourceFilesFromRecord(files));
    const fixture = await makeSignedHarnessPackage(rootDir, {
      name: "signed-with-local-only-hash",
      files,
      loadOptions: {
        dependencyResolver
      },
      attestationOverrides: {
        specHash: localFileOnlySpecHash
      }
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z",
        dependencyResolver
      },
      "spec_hash_mismatch"
    );
  });

  test("rejects an unsigned package in strict trust mode", async () => {
    const packageDir = await writeHarnessPackage(
      rootDir,
      "unsigned",
      validHarnessFiles()
    );

    await expectTrustRejected(
      {
        packageDir,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "unsigned_in_strict_mode"
    );
  });

  test("rejects a tampered package when the specHash no longer matches", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);

    await writeFile(
      join(fixture.packageDir, "tools/fs.read.yaml"),
      `${validHarnessFiles()["tools/fs.read.yaml"].trimStart()}\n# tampered after signing\n`
    );

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "spec_hash_mismatch"
    );
  });

  test("rejects a package from an untrusted publisher", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir, {
      publisherId: "publisher.unknown",
      trustStoreEntries: []
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "untrusted_publisher"
    );
  });

  test("rejects a package signed by an unknown key for a trusted publisher", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);
    const knownPublisherUnknownKeyStore = new InMemoryTrustStore({
      version: fixture.trustStoreData.version,
      entries: [
        {
          ...fixture.trustStoreData.entries[0],
          signingKeyId: "key.other"
        }
      ]
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: knownPublisherUnknownKeyStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "unknown_key"
    );
  });

  test("rejects a revoked signing key", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir, {
      trustEntryOverrides: {
        status: "revoked"
      }
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "revoked_key"
    );
  });

  test("rejects an expired signing key", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir, {
      trustEntryOverrides: {
        status: "expired"
      }
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "expired_key"
    );
  });

  test("rejects a bad Ed25519 signature", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);
    const otherFixture = await makeSignedHarnessPackage(rootDir, {
      name: "other-signed"
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: {
          ...fixture.signature,
          signature: otherFixture.signature.signature
        },
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "bad_signature"
    );
  });

  test("rejects an unsupported signature algorithm", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: {
          ...fixture.signature,
          algorithm: "rsa-pss"
        },
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "unsupported_algorithm"
    );
  });

  test("rejects a valid signature with mismatched attestation metadata", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir, {
      attestationOverrides: {
        schemaVersion: "specwright.harness.v1"
      }
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "attestation_mismatch"
    );
  });

  test("rejects malformed signature envelope metadata", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: {
          ...fixture.signature,
          signature: "not-base64"
        },
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "malformed_trust_metadata"
    );
  });

  test("rejects malformed trust store entries", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir);
    const malformedTrustStore = {
      version: "trust-store.malformed",
      hasPublisher: () => true,
      resolve: () => ({
        ...fixture.trustStoreData.entries[0],
        algorithm: "rsa-pss"
      })
    } as unknown as TrustStore;

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: malformedTrustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "malformed_trust_metadata"
    );
  });

  test("rejects an expired signature attestation", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir, {
      attestationOverrides: {
        notAfter: "2026-05-28T00:00:00.000Z"
      }
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "signature_expired"
    );
  });

  test("rejects a not-yet-valid signature attestation", async () => {
    const fixture = await makeSignedHarnessPackage(rootDir, {
      attestationOverrides: {
        notBefore: "2026-05-30T00:00:00.000Z"
      }
    });

    await expectTrustRejected(
      {
        packageDir: fixture.packageDir,
        signature: fixture.signature,
        trustStore: fixture.trustStore,
        strict: true,
        trustNow: "2026-05-29T00:00:00.000Z"
      },
      "signature_not_yet_valid"
    );
  });
});

async function expectTrustRejected(
  options: Parameters<typeof loadHarnessPackage>[0] & {
    packageDir: string;
  },
  reason: TrustRejectReason
) {
  const events: HarnessTrustEvent[] = [];
  const error = await captureError(() =>
    loadHarnessPackage({
      ...options,
      onTrustEvent: (event) => {
        events.push(event);
      }
    })
  );

  expect(error).toBeInstanceOf(HarnessLoaderError);
  expect((error as HarnessLoaderError).code).toBe("trust_rejected");
  expect((error as HarnessLoaderError).reason).toBe(reason);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "harness.trust.rejected",
    payload: {
      reason,
      failClosed: true
    }
  });
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}

function dependencyBearingHarnessFiles() {
  const files = validHarnessFiles();

  return {
    ...files,
    "harness.yaml": `${files["harness.yaml"].replace(
      "metadata:\n  fixture: trust",
      "metadata:\n  fixture: trust\n  trustTier: first-party"
    )}
dependencies:
  - name: specwright.dep.alpha
    versionRange: 1.0.0
    pinnedHash: sha256:433c9d4f8f84eea4656559cb7cb3040fa74023a7fc0668f9b05d79fa4bf3dead
    trustTier: first-party
`
  };
}

function reviewedDependencyResolver() {
  return {
    resolve() {
      return [
        {
          name: "specwright.dep.alpha",
          version: "1.0.0",
          contentHash:
            "sha256:433c9d4f8f84eea4656559cb7cb3040fa74023a7fc0668f9b05d79fa4bf3dead",
          trustTier: "first-party" as const
        }
      ];
    }
  };
}

function sourceFilesFromRecord(files: Record<string, string>) {
  return Object.entries(files)
    .map(([relativePath, raw]) => ({
      relativePath,
      raw: raw.trimStart()
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
