import type { Chunk } from "./chunk";
import { parseChunk } from "./chunk";
import { chunkDocument } from "./chunking";
import type { ChunkingStrategyRegistry } from "./chunking";
import type { MemoryDocument } from "./document";
import { parseMemoryDocument } from "./document";
import { MemoryError } from "./errors";
import type { Sha256Hash } from "./hash";

export const ChunkStoreKeySchema = {
  contentPrefix: "content",
  documentPrefix: "document"
} as const;

export interface IngestDocumentInput {
  readonly document: unknown;
  readonly strategyId: string;
  readonly config: unknown;
  readonly store?: InMemoryChunkStore;
  readonly registry?: ChunkingStrategyRegistry;
}

export interface IngestDocumentResult {
  readonly document: MemoryDocument;
  readonly chunks: Chunk[];
  readonly contentHashes: Sha256Hash[];
}

interface ContentEntry {
  readonly contentHash: Sha256Hash;
  readonly text: string;
}

export class InMemoryChunkStore {
  private readonly contentByHash = new Map<Sha256Hash, ContentEntry>();
  private readonly chunksById = new Map<string, Chunk>();
  private readonly documentMembership = new Map<string, string[]>();

  put(chunks: readonly unknown[]): Chunk[] {
    const parsedChunks = chunks.map(parseChunk);
    const batchContent = new Map<Sha256Hash, string>();

    for (const chunk of parsedChunks) {
      const existingText =
        this.contentByHash.get(chunk.contentHash)?.text ??
        batchContent.get(chunk.contentHash);

      if (existingText !== undefined && existingText !== chunk.text) {
        throw new MemoryError({
          code: "hash_collision",
          field: "contentHash",
          condition: chunk.contentHash,
          message: `Content hash collision for ${chunk.contentHash}`
        });
      }

      batchContent.set(chunk.contentHash, chunk.text);
    }

    const clonedChunks = parsedChunks.map(cloneChunk);
    for (const [contentHash, text] of batchContent) {
      if (!this.contentByHash.has(contentHash)) {
        this.contentByHash.set(contentHash, {
          contentHash,
          text
        });
      }
    }

    for (const chunk of clonedChunks) {
      this.chunksById.set(chunk.chunkId, chunk);
    }

    const byDocument = new Map<string, Chunk[]>();
    for (const chunk of clonedChunks) {
      const existing = byDocument.get(chunk.documentId) ?? [];
      existing.push(chunk);
      byDocument.set(chunk.documentId, existing);
    }

    for (const [documentId, documentChunks] of byDocument) {
      const nextIds = [
        ...(this.documentMembership.get(documentId) ?? []),
        ...documentChunks.map((chunk) => chunk.chunkId)
      ];
      this.documentMembership.set(documentId, uniqueSortedChunkIds(nextIds, this.chunksById));
    }

    return clonedChunks;
  }

  ingestDocument(input: Omit<IngestDocumentInput, "store">): IngestDocumentResult {
    return ingestDocument({
      ...input,
      store: this
    });
  }

  get(contentHash: Sha256Hash): Chunk | undefined {
    const entry = this.contentByHash.get(contentHash);
    if (entry === undefined) {
      return undefined;
    }

    const firstChunk = [...this.chunksById.values()].find(
      (chunk) => chunk.contentHash === contentHash
    );
    return firstChunk === undefined ? undefined : cloneChunk(firstChunk);
  }

  getByChunkId(chunkId: string): Chunk | undefined {
    const chunk = this.chunksById.get(chunkId);
    return chunk === undefined ? undefined : cloneChunk(chunk);
  }

  listByDocument(documentId: string): Chunk[] {
    return (this.documentMembership.get(documentId) ?? [])
      .map((chunkId) => this.chunksById.get(chunkId))
      .filter((chunk): chunk is Chunk => chunk !== undefined)
      .sort(compareChunks)
      .map(cloneChunk);
  }

  contentEntryCount(): number {
    return this.contentByHash.size;
  }

  chunkCount(): number {
    return this.chunksById.size;
  }

  contentHashes(): Sha256Hash[] {
    return [...this.contentByHash.keys()].sort();
  }
}

export function ingestDocument(input: IngestDocumentInput): IngestDocumentResult {
  const document = parseMemoryDocument(input.document);
  const chunkInput =
    input.registry === undefined
      ? {
          document,
          strategyId: input.strategyId,
          config: input.config
        }
      : {
          document,
          strategyId: input.strategyId,
          config: input.config,
          registry: input.registry
        };
  const chunks = chunkDocument({
    ...chunkInput
  });
  const stored = input.store?.put(chunks) ?? chunks.map(cloneChunk);

  return {
    document,
    chunks: stored,
    contentHashes: stored.map((chunk) => chunk.contentHash)
  };
}

function uniqueSortedChunkIds(
  chunkIds: readonly string[],
  chunksById: ReadonlyMap<string, Chunk>
): string[] {
  return [...new Set(chunkIds)].sort((left, right) => {
    const leftChunk = chunksById.get(left);
    const rightChunk = chunksById.get(right);
    if (leftChunk === undefined || rightChunk === undefined) {
      return left.localeCompare(right);
    }
    return compareChunks(leftChunk, rightChunk);
  });
}

function compareChunks(left: Chunk, right: Chunk): number {
  return (
    left.ordinal - right.ordinal ||
    left.span.start - right.span.start ||
    left.span.end - right.span.end ||
    left.chunkId.localeCompare(right.chunkId)
  );
}

function cloneChunk(chunk: Chunk): Chunk {
  return parseChunk(JSON.parse(JSON.stringify(chunk)) as unknown);
}
