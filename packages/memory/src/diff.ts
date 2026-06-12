import type { Chunk } from "./chunk";
import { parseChunk } from "./chunk";

export interface ChunkDiffEntry {
  readonly key: string;
  readonly previous?: Chunk;
  readonly next?: Chunk;
}

export interface ChunkDiff {
  readonly added: ChunkDiffEntry[];
  readonly removed: ChunkDiffEntry[];
  readonly changed: ChunkDiffEntry[];
  readonly unchanged: ChunkDiffEntry[];
}

export function diffChunks(
  previous: readonly unknown[],
  next: readonly unknown[]
): ChunkDiff {
  const previousChunks = previous.map(parseChunk);
  const nextChunks = next.map(parseChunk);
  const previousByKey = mapByStableIdentity(previousChunks);
  const nextByKey = mapByStableIdentity(nextChunks);
  const keys = [...new Set([...previousByKey.keys(), ...nextByKey.keys()])].sort();

  const added: ChunkDiffEntry[] = [];
  const removed: ChunkDiffEntry[] = [];
  const changed: ChunkDiffEntry[] = [];
  const unchanged: ChunkDiffEntry[] = [];

  for (const key of keys) {
    const previousChunk = previousByKey.get(key);
    const nextChunk = nextByKey.get(key);

    if (previousChunk === undefined && nextChunk !== undefined) {
      added.push({ key, next: nextChunk });
      continue;
    }

    if (previousChunk !== undefined && nextChunk === undefined) {
      removed.push({ key, previous: previousChunk });
      continue;
    }

    if (previousChunk === undefined || nextChunk === undefined) {
      continue;
    }

    if (
      previousChunk.contentHash !== nextChunk.contentHash ||
      previousChunk.text !== nextChunk.text
    ) {
      changed.push({
        key,
        previous: previousChunk,
        next: nextChunk
      });
    } else {
      unchanged.push({
        key,
        previous: previousChunk,
        next: nextChunk
      });
    }
  }

  return { added, removed, changed, unchanged };
}

function mapByStableIdentity(chunks: readonly Chunk[]): Map<string, Chunk> {
  const map = new Map<string, Chunk>();
  for (const chunk of chunks) {
    map.set(stableIdentity(chunk), chunk);
  }
  return map;
}

function stableIdentity(chunk: Chunk): string {
  return [
    chunk.documentId,
    chunk.chunkingStrategy.id,
    chunk.chunkingStrategy.version,
    chunk.ordinal,
    chunk.span.start,
    chunk.span.end
  ].join(":");
}
