import { createHash } from "node:crypto";
import { tokenizeText } from "../chunking";
import type { EmbeddingDescriptor } from "../dense-contracts";
import { parseEmbeddingDescriptor } from "../dense-contracts";
import type { EmbeddingProvider } from "./provider";

export interface DeterministicLocalEmbeddingProviderOptions {
  readonly dims?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly modelVersion?: string;
  readonly seed?: string;
}

export const DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR = {
  provider: "specwright-local",
  model: "hashed-token-projection",
  modelVersion: "1.0.0",
  dims: 32,
  distanceMetric: "cosine"
} satisfies EmbeddingDescriptor;

export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  private readonly seed: string;

  constructor(options: DeterministicLocalEmbeddingProviderOptions = {}) {
    this.descriptor = parseEmbeddingDescriptor({
      provider: options.provider ?? DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR.provider,
      model: options.model ?? DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR.model,
      modelVersion:
        options.modelVersion ?? DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR.modelVersion,
      dims: options.dims ?? DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR.dims,
      distanceMetric: DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR.distanceMetric
    });
    this.seed = options.seed ?? "specwright-local-embedding-v1";
  }

  async embedChunks(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedText(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embedText(text);
  }

  embedText(text: string): Float32Array {
    const vector = new Float32Array(this.descriptor.dims);
    const terms = tokenizeText(text.normalize("NFC"))
      .map((token) =>
        token.value
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .toLocaleLowerCase("en-US")
      )
      .filter((term) => /[\p{L}\p{N}_]/u.test(term));

    if (terms.length === 0) {
      return vector;
    }

    for (const term of terms) {
      for (let dimension = 0; dimension < this.descriptor.dims; dimension += 1) {
        vector[dimension] = readVectorValue(vector, dimension) + projectedWeight({
          seed: this.seed,
          modelVersion: this.descriptor.modelVersion,
          term,
          dimension
        });
      }
    }

    normalizeInPlace(vector);
    return vector;
  }
}

function projectedWeight(input: {
  readonly seed: string;
  readonly modelVersion: string;
  readonly term: string;
  readonly dimension: number;
}): number {
  const hash = createHash("sha256")
    .update(
      `${input.seed}|${input.modelVersion}|${input.term}|${input.dimension}`
    )
    .digest("hex");
  const unsigned = Number.parseInt(hash.slice(0, 8), 16);
  return unsigned / 0xffffffff - 0.5;
}

function normalizeInPlace(vector: Float32Array): void {
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }

  const norm = Math.sqrt(magnitude);
  if (norm === 0) {
    return;
  }

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = readVectorValue(vector, index) / norm;
  }
}

function readVectorValue(vector: Float32Array, index: number): number {
  const value = vector[index];
  return value === undefined ? 0 : value;
}
