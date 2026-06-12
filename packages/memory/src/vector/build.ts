import { MemoryError } from "../errors";
import type { Sha256Hash } from "../hash";
import type { EmbeddingProvider } from "../embedding";
import type { DenseVectorIndex } from "./ann-index";
import { buildDenseVectorIndex, verifyDenseVectorIndexIntegrity } from "./ann-index";

export class DenseVectorIndexStore {
  private readonly indexes = new Map<Sha256Hash, DenseVectorIndex>();
  private liveVersion: Sha256Hash | undefined;

  putPinned(index: DenseVectorIndex): void {
    verifyDenseVectorIndexIntegrity(index);
    this.indexes.set(index.indexVersion, index);
  }

  promote(indexVersion: Sha256Hash): void {
    if (!this.indexes.has(indexVersion)) {
      throw new MemoryError({
        code: "version_unavailable",
        field: "indexVersion",
        condition: indexVersion,
        message: `Dense index version is not available: ${indexVersion}`
      });
    }

    this.liveVersion = indexVersion;
  }

  putAndPromote(index: DenseVectorIndex): void {
    this.putPinned(index);
    this.promote(index.indexVersion);
  }

  resolve(indexVersion?: Sha256Hash): DenseVectorIndex {
    const version = indexVersion ?? this.liveVersion;
    if (version === undefined) {
      throw new MemoryError({
        code: "version_unavailable",
        field: "indexVersion",
        condition: "live",
        message: "No live dense index version is available"
      });
    }

    const index = this.indexes.get(version);
    if (index === undefined) {
      throw new MemoryError({
        code: "version_unavailable",
        field: "indexVersion",
        condition: version,
        message: `Dense index version is not available: ${version}`
      });
    }

    return index;
  }

  get(indexVersion: Sha256Hash): DenseVectorIndex | undefined {
    return this.indexes.get(indexVersion);
  }

  liveIndexVersion(): Sha256Hash | undefined {
    return this.liveVersion;
  }

  listVersions(): Sha256Hash[] {
    return [...this.indexes.keys()].sort();
  }
}

export interface BuildAndSwapDenseIndexInput {
  readonly store: DenseVectorIndexStore;
  readonly chunks: readonly unknown[];
  readonly provider: EmbeddingProvider;
  readonly annParams?: unknown;
  readonly indexId?: string;
  readonly simulateInterruptBeforeSwap?: boolean;
}

export interface BuildAndSwapDenseIndexResult {
  readonly status: "promoted";
  readonly previousLiveIndexVersion?: Sha256Hash;
  readonly liveIndexVersion: Sha256Hash;
  readonly index: DenseVectorIndex;
}

export async function buildAndSwapDenseIndex(
  input: BuildAndSwapDenseIndexInput
): Promise<BuildAndSwapDenseIndexResult> {
  const previousLiveIndexVersion = input.store.liveIndexVersion();
  const index = await buildDenseVectorIndex({
    chunks: input.chunks,
    provider: input.provider,
    ...(input.annParams === undefined ? {} : { annParams: input.annParams }),
    ...(input.indexId === undefined ? {} : { indexId: input.indexId })
  });
  verifyDenseVectorIndexIntegrity(index);

  if (input.simulateInterruptBeforeSwap === true) {
    throw new MemoryError({
      code: "interrupted_build",
      field: "denseIndex",
      condition: index.indexVersion,
      message: "Dense index build interrupted before atomic live pointer swap"
    });
  }

  input.store.putAndPromote(index);
  return {
    status: "promoted",
    ...(previousLiveIndexVersion === undefined
      ? {}
      : { previousLiveIndexVersion }),
    liveIndexVersion: index.indexVersion,
    index
  };
}
