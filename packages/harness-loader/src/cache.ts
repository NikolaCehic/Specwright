import { HarnessLoaderError } from "./errors";
import {
  DEFAULT_HARNESS_LOADER_LIMITS,
  normalizeHarnessLoaderLimits,
  type HarnessLoaderLimitsInput
} from "./limits";
import type {
  HarnessLoadRecord,
  ResolvedDependency,
  SourceFile
} from "./index";
import type { HarnessSnapshot } from "@specwright/schemas";

export type SnapshotCacheComputeSpecHash = (
  files: readonly Pick<SourceFile, "relativePath" | "raw">[],
  dependencies?: readonly ResolvedDependency[]
) => string;

export type SnapshotCacheEntry = {
  specHash: string;
  snapshot: HarnessSnapshot;
  files: readonly Pick<SourceFile, "relativePath" | "raw">[];
  dependencies: readonly ResolvedDependency[];
  createdAt: number;
  lastAccessedAt: number;
};

export type SnapshotCacheOptions = {
  computeSpecHash: SnapshotCacheComputeSpecHash;
  limits?: HarnessLoaderLimitsInput | undefined;
  now?(): number;
};

export class SnapshotCache {
  private readonly entries = new Map<string, SnapshotCacheEntry>();
  private readonly computeSpecHash: SnapshotCacheComputeSpecHash;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: SnapshotCacheOptions) {
    const limits = normalizeHarnessLoaderLimits(options.limits);
    this.computeSpecHash = options.computeSpecHash;
    this.now = options.now ?? Date.now;
    this.maxEntries = limits.cacheMaxEntries;
    this.ttlMs = limits.cacheTtlMs;
  }

  get size() {
    return this.entries.size;
  }

  put(record: HarnessLoadRecord) {
    const timestamp = this.now();
    const entry: SnapshotCacheEntry = {
      specHash: record.snapshot.specHash,
      snapshot: record.snapshot,
      files: record.loadedFiles.map((file) => ({
        relativePath: file.relativePath,
        raw: file.raw
      })),
      dependencies: [...record.dependencies.resolved],
      createdAt: timestamp,
      lastAccessedAt: timestamp
    };

    this.verifyEntry(entry);
    this.entries.set(entry.specHash, entry);
    this.evictOverflow();
  }

  get(specHash: string): HarnessSnapshot | undefined {
    const entry = this.entries.get(specHash);

    if (entry === undefined) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(specHash);
      return undefined;
    }

    try {
      this.verifyEntry(entry);
    } catch (error) {
      this.entries.delete(specHash);
      throw error;
    }

    entry.lastAccessedAt = this.now();

    return entry.snapshot;
  }

  delete(specHash: string) {
    return this.entries.delete(specHash);
  }

  clear() {
    this.entries.clear();
  }

  has(specHash: string) {
    return this.entries.has(specHash);
  }

  poisonForTest(specHash: string, replacementFiles: readonly SourceFile[]) {
    const entry = this.entries.get(specHash);

    if (entry === undefined) {
      return false;
    }

    this.entries.set(specHash, {
      ...entry,
      files: replacementFiles.map((file) => ({
        relativePath: file.relativePath,
        raw: file.raw
      }))
    });

    return true;
  }

  private verifyEntry(entry: SnapshotCacheEntry) {
    const actual = this.computeSpecHash(entry.files, entry.dependencies);

    if (actual !== entry.specHash || entry.snapshot.specHash !== entry.specHash) {
      throw new HarnessLoaderError(
        "cache_poisoned",
        `Cached harness snapshot ${entry.specHash} did not re-verify`,
        undefined,
        {
          reason: "spec_hash_mismatch",
          details: {
            expected: entry.specHash,
            actual,
            snapshotSpecHash: entry.snapshot.specHash
          }
        }
      );
    }
  }

  private isExpired(entry: SnapshotCacheEntry) {
    return this.now() - entry.createdAt > this.ttlMs;
  }

  private evictOverflow() {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort(
        (left, right) => left.lastAccessedAt - right.lastAccessedAt
      )[0];

      if (oldest === undefined) {
        return;
      }

      this.entries.delete(oldest.specHash);
    }
  }
}

export function createSnapshotCache(
  computeSpecHash: SnapshotCacheComputeSpecHash,
  limits?: HarnessLoaderLimitsInput
) {
  return new SnapshotCache({
    computeSpecHash,
    limits: limits ?? DEFAULT_HARNESS_LOADER_LIMITS
  });
}
