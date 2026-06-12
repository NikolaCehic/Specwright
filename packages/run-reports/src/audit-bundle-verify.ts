import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUDIT_BUNDLE_CHUNKS_DIR,
  AUDIT_BUNDLE_MANIFEST_FILE,
  AuditBundleError,
  auditBundleManifestBody,
  hashAuditBundleCanonical,
  parseAuditBundleChunk,
  parseBundleManifest,
  stableAuditBundleJson,
  type AuditBundleChunk,
  type BundleManifest,
  type ChunkDescriptor
} from "./audit-bundle";

export type BundleVerificationFailure =
  | {
      kind: "manifest_hash_mismatch";
      expected: string;
      actual: string;
    }
  | {
      kind: "chunk_hash_mismatch";
      runId: string;
      expected: string;
      actual: string;
    }
  | {
      kind: "missing_chunk";
      runId: string;
      chunkPath: string;
    }
  | {
      kind: "extra_chunk";
      chunkPath: string;
    }
  | {
      kind: "unscoped_or_cross_tenant";
      runId?: string | undefined;
      message: string;
    }
  | {
      kind: "non_attestable_certified_clean";
      runId: string;
      message: string;
    }
  | {
      kind: "event_range_mismatch";
      runId?: string | undefined;
      message: string;
    }
  | {
      kind: "invalid_manifest";
      message: string;
    }
  | {
      kind: "invalid_chunk";
      runId?: string | undefined;
      chunkPath?: string | undefined;
      message: string;
    };

export type BundleVerificationResult = {
  valid: boolean;
  manifest?: BundleManifest | undefined;
  failures: BundleVerificationFailure[];
};

export async function verifyAuditBundle(
  bundlePath: string
): Promise<BundleVerificationResult> {
  const failures: BundleVerificationFailure[] = [];
  let manifest: BundleManifest;

  try {
    const rawManifest = await readFile(
      join(bundlePath, AUDIT_BUNDLE_MANIFEST_FILE),
      "utf8"
    );
    manifest = parseBundleManifest(JSON.parse(rawManifest) as unknown);
  } catch (error) {
    return {
      valid: false,
      failures: [
        {
          kind: "invalid_manifest",
          message: errorMessage(error)
        }
      ]
    };
  }

  const actualManifestHash = hashAuditBundleCanonical(
    auditBundleManifestBody(manifest)
  );

  if (actualManifestHash !== manifest.manifestHash) {
    failures.push({
      kind: "manifest_hash_mismatch",
      expected: manifest.manifestHash,
      actual: actualManifestHash
    });
  }

  if (
    manifest.tenant.trim().length === 0 ||
    manifest.scope.trim().length === 0 ||
    manifest.requester.trim().length === 0
  ) {
    failures.push({
      kind: "unscoped_or_cross_tenant",
      message: "Manifest requester, tenant, and scope must be non-empty."
    });
  }

  const aggregateRange = aggregateEventRange(
    manifest.chunks.map((descriptor) => descriptor.eventRange)
  );

  if (!eventRangesEqual(aggregateRange, manifest.eventRange)) {
    failures.push({
      kind: "event_range_mismatch",
      message: "Manifest eventRange does not match the aggregate chunk event range."
    });
  }

  const expectedChunkPaths = new Set(
    manifest.chunks.map((descriptor) => descriptor.chunkPath)
  );
  const observedChunkPaths = await listObservedChunkPaths(bundlePath);

  for (const observedPath of observedChunkPaths) {
    if (!expectedChunkPaths.has(observedPath)) {
      failures.push({
        kind: "extra_chunk",
        chunkPath: observedPath
      });
    }
  }

  for (const descriptor of manifest.chunks) {
    const chunk = await readAndVerifyChunk({
      bundlePath,
      manifest,
      descriptor,
      failures
    });

    if (chunk === undefined) {
      continue;
    }

    failures.push(...semanticChunkFailures(manifest, descriptor, chunk));
  }

  return {
    valid: failures.length === 0,
    manifest,
    failures
  };
}

async function readAndVerifyChunk(input: {
  bundlePath: string;
  manifest: BundleManifest;
  descriptor: ChunkDescriptor;
  failures: BundleVerificationFailure[];
}): Promise<AuditBundleChunk | undefined> {
  let rawChunk: string;

  try {
    rawChunk = await readFile(
      join(input.bundlePath, input.descriptor.chunkPath),
      "utf8"
    );
  } catch (error) {
    input.failures.push({
      kind: "missing_chunk",
      runId: input.descriptor.runId,
      chunkPath: input.descriptor.chunkPath
    });

    return undefined;
  }

  const actualChunkHash = hashAuditBundleCanonicalText(rawChunk);

  if (actualChunkHash !== input.descriptor.chunkHash) {
    input.failures.push({
      kind: "chunk_hash_mismatch",
      runId: input.descriptor.runId,
      expected: input.descriptor.chunkHash,
      actual: actualChunkHash
    });
  }

  try {
    const parsed = parseAuditBundleChunk(JSON.parse(rawChunk) as unknown);
    const canonicalChunkHash = hashAuditBundleCanonical(
      JSON.parse(stableAuditBundleJson(parsed)) as unknown
    );

    if (
      actualChunkHash === input.descriptor.chunkHash &&
      canonicalChunkHash !== input.descriptor.chunkHash
    ) {
      input.failures.push({
        kind: "chunk_hash_mismatch",
        runId: input.descriptor.runId,
        expected: input.descriptor.chunkHash,
        actual: canonicalChunkHash
      });
    }

    return parsed;
  } catch (error) {
    input.failures.push({
      kind: "invalid_chunk",
      runId: input.descriptor.runId,
      chunkPath: input.descriptor.chunkPath,
      message: errorMessage(error)
    });

    return undefined;
  }
}

function semanticChunkFailures(
  manifest: BundleManifest,
  descriptor: ChunkDescriptor,
  chunk: AuditBundleChunk
): BundleVerificationFailure[] {
  const failures: BundleVerificationFailure[] = [];

  if (
    chunk.runId !== descriptor.runId ||
    chunk.tenant !== manifest.tenant ||
    chunk.scope !== manifest.scope ||
    chunk.trustLabels.tenant !== manifest.tenant ||
    chunk.trustLabels.scope !== manifest.scope ||
    chunk.trustLabels.runId !== chunk.runId
  ) {
    failures.push({
      kind: "unscoped_or_cross_tenant",
      runId: descriptor.runId,
      message: "Chunk run, tenant, or scope does not match the manifest."
    });
  }

  if (!eventRangesEqual(chunk.eventRange, descriptor.eventRange)) {
    failures.push({
      kind: "event_range_mismatch",
      runId: descriptor.runId,
      message: "Chunk eventRange does not match the manifest descriptor eventRange."
    });
  }

  if (
    descriptor.attestation.status === "attestable" &&
    chunkCarriesRecordedGap(chunk)
  ) {
    failures.push({
      kind: "non_attestable_certified_clean",
      runId: descriptor.runId,
      message:
        "Chunk is certified attestable while coverage or reconciliation records still contain gaps."
    });
  }

  if (descriptor.attestation.status !== chunk.attestation.status) {
    failures.push({
      kind: "invalid_chunk",
      runId: descriptor.runId,
      chunkPath: descriptor.chunkPath,
      message: "Chunk attestation does not match manifest descriptor."
    });
  }

  return failures;
}

function chunkCarriesRecordedGap(chunk: AuditBundleChunk) {
  const coverageGap =
    chunk.coverageVerdict === undefined ||
    !chunk.coverageVerdict.complete ||
    !chunk.coverageVerdict.attributed ||
    chunk.coverageVerdict.gaps.length > 0;
  const reconciliationGap =
    chunk.reconciliation === undefined ||
    chunk.reconciliation.verdict !== "consistent" ||
    chunk.reconciliation.gaps.length > 0 ||
    chunk.reconciliation.mismatches.length > 0;

  return coverageGap || reconciliationGap;
}

function aggregateEventRange(
  ranges: readonly AuditBundleChunk["eventRange"][]
): AuditBundleChunk["eventRange"] {
  const nonEmpty = ranges.filter((range) => range.eventCount > 0);

  if (nonEmpty.length === 0) {
    return {
      firstSequence: 0,
      lastSequence: -1,
      eventCount: 0
    };
  }

  return {
    firstSequence: Math.min(...nonEmpty.map((range) => range.firstSequence)),
    lastSequence: Math.max(...nonEmpty.map((range) => range.lastSequence)),
    eventCount: nonEmpty.reduce((sum, range) => sum + range.eventCount, 0)
  };
}

function eventRangesEqual(
  left: AuditBundleChunk["eventRange"],
  right: AuditBundleChunk["eventRange"]
) {
  return (
    left.firstSequence === right.firstSequence &&
    left.lastSequence === right.lastSequence &&
    left.eventCount === right.eventCount
  );
}

async function listObservedChunkPaths(bundlePath: string): Promise<string[]> {
  try {
    const names = await readdir(join(bundlePath, AUDIT_BUNDLE_CHUNKS_DIR));

    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${AUDIT_BUNDLE_CHUNKS_DIR}/${name}`)
      .sort();
  } catch (error) {
    if (error instanceof AuditBundleError) {
      throw error;
    }

    return [];
  }
}

function hashAuditBundleCanonicalText(value: string): `sha256:${string}` {
  return `sha256:${cryptoDigest(value)}`;
}

function cryptoDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
