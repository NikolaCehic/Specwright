import { MemoryError } from "../errors";
import type { EmbeddingDescriptor } from "../dense-contracts";
import { parseEmbeddingDescriptor } from "../dense-contracts";

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  embedChunks(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

interface ProviderEntry {
  readonly provider: EmbeddingProvider;
  readonly deprecated: boolean;
}

export class EmbeddingProviderRegistry {
  private readonly providers = new Map<string, ProviderEntry>();

  register(
    provider: EmbeddingProvider,
    options: { readonly deprecated?: boolean } = {}
  ): void {
    const descriptor = parseEmbeddingDescriptor(provider.descriptor);
    const key = embeddingDescriptorKey(descriptor);
    if (this.providers.has(key)) {
      throw new MemoryError({
        code: "invalid_embedding_descriptor",
        field: "embedding",
        condition: key,
        message: `Duplicate embedding provider registration for ${key}`
      });
    }

    this.providers.set(key, {
      provider,
      deprecated: options.deprecated ?? false
    });
  }

  deprecate(descriptor: EmbeddingDescriptor): void {
    const key = embeddingDescriptorKey(parseEmbeddingDescriptor(descriptor));
    const entry = this.providers.get(key);
    if (entry === undefined) {
      throw staleEmbeddingModel(key);
    }

    this.providers.set(key, {
      provider: entry.provider,
      deprecated: true
    });
  }

  resolve(descriptor: EmbeddingDescriptor): EmbeddingProvider {
    const parsed = parseEmbeddingDescriptor(descriptor);
    const key = embeddingDescriptorKey(parsed);
    const entry = this.providers.get(key);
    if (entry === undefined || entry.deprecated) {
      throw staleEmbeddingModel(key);
    }

    return entry.provider;
  }

  list(): EmbeddingDescriptor[] {
    return [...this.providers.values()]
      .map((entry) => entry.provider.descriptor)
      .sort((left, right) =>
        embeddingDescriptorKey(left).localeCompare(embeddingDescriptorKey(right))
      );
  }
}

export function embeddingDescriptorKey(descriptor: EmbeddingDescriptor): string {
  return `${descriptor.provider}/${descriptor.model}/${descriptor.modelVersion}/${descriptor.dims}/${descriptor.distanceMetric}`;
}

export function assertVectorDims(
  vector: Float32Array,
  expectedDims: number,
  field: string
): void {
  if (vector.length !== expectedDims) {
    throw new MemoryError({
      code: "dimension_mismatch",
      field,
      condition: `${vector.length}!=${expectedDims}`,
      message: `Vector dimension ${vector.length} does not match expected dimension ${expectedDims}`
    });
  }
}

export async function embedChunksChecked(
  provider: EmbeddingProvider,
  texts: readonly string[]
): Promise<Float32Array[]> {
  try {
    const vectors = await provider.embedChunks(texts);
    if (vectors.length !== texts.length) {
      throw new MemoryError({
        code: "embedding_provider_unavailable",
        field: "embedChunks",
        condition: "count_mismatch",
        message: `Embedding provider returned ${vectors.length} vectors for ${texts.length} chunks`
      });
    }

    vectors.forEach((vector, index) =>
      assertVectorDims(vector, provider.descriptor.dims, `chunks.${index}`)
    );
    return vectors;
  } catch (error) {
    if (error instanceof MemoryError) {
      throw error;
    }

    throw new MemoryError({
      code: "embedding_provider_unavailable",
      field: "embedChunks",
      condition: "provider_error",
      message: error instanceof Error ? error.message : "Embedding provider failed"
    });
  }
}

export async function embedQueryChecked(
  provider: EmbeddingProvider,
  text: string
): Promise<Float32Array> {
  try {
    const vector = await provider.embedQuery(text);
    assertVectorDims(vector, provider.descriptor.dims, "query");
    return vector;
  } catch (error) {
    if (error instanceof MemoryError) {
      throw error;
    }

    throw new MemoryError({
      code: "embedding_provider_unavailable",
      field: "embedQuery",
      condition: "provider_error",
      message: error instanceof Error ? error.message : "Embedding provider failed"
    });
  }
}

function staleEmbeddingModel(key: string): MemoryError {
  return new MemoryError({
    code: "stale_embedding_model",
    field: "embedding",
    condition: key,
    message: `Embedding provider version is not registered or is deprecated: ${key}`
  });
}
