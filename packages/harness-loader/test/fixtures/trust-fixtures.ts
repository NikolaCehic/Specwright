import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  InMemoryTrustStore,
  SUPPORTED_HARNESS_SCHEMA_VERSION,
  canonicalizeAttestation,
  loadHarnessPackage,
  type Attestation,
  type LoadHarnessPackageOptions,
  type SignatureEnvelope,
  type TrustStoreData,
  type TrustStoreEntry
} from "../../src/index";

export type SignedHarnessPackageFixture = {
  packageDir: string;
  publisherId: string;
  signingKeyId: string;
  specHash: string;
  signature: SignatureEnvelope;
  trustStore: InMemoryTrustStore;
  trustStoreData: TrustStoreData;
  publicKeyPem: string;
};

export type MakeSignedHarnessPackageOptions = {
  name?: string;
  files?: Record<string, string>;
  publisherId?: string;
  signingKeyId?: string;
  trustStoreVersion?: string;
  trustEntryOverrides?: Partial<TrustStoreEntry>;
  trustStoreEntries?: TrustStoreData["entries"];
  attestationOverrides?: Partial<Attestation>;
  envelopeOverrides?: Partial<Omit<SignatureEnvelope, "attestation">>;
  loadOptions?: Omit<LoadHarnessPackageOptions, "packageDir">;
};

export async function makeSignedHarnessPackage(
  rootDir: string,
  options: MakeSignedHarnessPackageOptions = {}
): Promise<SignedHarnessPackageFixture> {
  const publisherId = options.publisherId ?? "publisher.alpha";
  const signingKeyId = options.signingKeyId ?? "key.alpha";
  const trustStoreVersion = options.trustStoreVersion ?? "trust-store.v1";
  const packageDir = await writeHarnessPackage(
    rootDir,
    options.name ?? "signed",
    options.files ?? validHarnessFiles()
  );
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({
    type: "spki",
    format: "pem"
  });
  const snapshot = await loadHarnessPackage({
    packageDir,
    loadedAt: "2026-05-29T00:00:00.000Z",
    ...(options.loadOptions ?? {})
  });
  const attestation: Attestation = {
    publisherId,
    specHash: snapshot.specHash,
    schemaVersion: snapshot.schemaVersion,
    ...options.attestationOverrides
  };
  const signatureBytes = sign(
    null,
    canonicalizeAttestation(attestation),
    keyPair.privateKey
  );
  const signature: SignatureEnvelope = {
    publisherId,
    signingKeyId,
    algorithm: "ed25519",
    signature: signatureBytes.toString("base64"),
    attestation,
    ...options.envelopeOverrides
  };
  const trustEntry: TrustStoreEntry = {
    publisherId,
    signingKeyId,
    publicKey: publicKeyPem,
    algorithm: "ed25519",
    status: "active",
    ...options.trustEntryOverrides
  };
  const trustStoreData: TrustStoreData = {
    version: trustStoreVersion,
    entries: options.trustStoreEntries ?? [trustEntry]
  };

  return {
    packageDir,
    publisherId,
    signingKeyId,
    specHash: snapshot.specHash,
    signature,
    trustStore: new InMemoryTrustStore(trustStoreData),
    trustStoreData,
    publicKeyPem
  };
}

export function validHarnessFiles() {
  return {
    "harness.yaml": `
id: specwright.default
version: 0.1.0
schemaVersion: ${SUPPORTED_HARNESS_SCHEMA_VERSION}
metadata:
  fixture: trust
  provenance:
    author: loader-test
runtime:
  strict: true
  eventLog: append-only
phases:
  - id: intake
    gates:
      - intake.exit
    tools:
      - fs.read
    artifactSchemas:
      - run-input
    evals:
      - eval.required
    next: evidence
  - id: evidence
    gates:
      - evidence.exit
gates:
  - intake.exit
  - evidence.exit
tools:
  allow:
    - fs.read
artifactSchemas:
  - run-input
evals:
  - eval.required
prompts:
  - planner.system
`,
    "gates/evidence.exit.yaml": `
id: evidence.exit
phase: evidence
kind: exit
required: true
checks:
  - id: has-evidence
    type: deterministic
`,
    "gates/intake.exit.yaml": `
id: intake.exit
phase: intake
kind: exit
required: true
checks:
  - id: task-known
    type: deterministic
`,
    "tools/fs.read.yaml": `
id: fs.read
version: 0.1.0
inputSchema:
  type: object
  required:
    - path
outputSchema:
  type: object
`,
    "artifact-schemas/run-input.json": JSON.stringify(
      {
        id: "run-input",
        version: "0.1.0",
        type: "object",
        required: ["task"],
        properties: {
          task: {
            type: "string"
          }
        }
      },
      null,
      2
    ),
    "evals/required.yaml": `
id: eval.required
artifactSchemas:
  - run-input
tools:
  - fs.read
prompts:
  - planner.system
`,
    "prompts/planner.system.md": `---
id: planner.system
description: Minimal planning prompt
---
Create source-bound plans only.
`
  };
}

export async function writeHarnessPackage(
  rootDir: string,
  name: string,
  files: Record<string, string>
) {
  const packageDir = join(rootDir, name);

  for (const [relativePath, contents] of Object.entries(files)) {
    const targetPath = join(packageDir, relativePath);

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contents.trimStart());
  }

  return packageDir;
}
