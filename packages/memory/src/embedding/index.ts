export {
  DEFAULT_LOCAL_EMBEDDING_DESCRIPTOR,
  DeterministicLocalEmbeddingProvider
} from "./local-deterministic";
export type { DeterministicLocalEmbeddingProviderOptions } from "./local-deterministic";
export {
  EmbeddingProviderRegistry,
  assertVectorDims,
  embedChunksChecked,
  embedQueryChecked,
  embeddingDescriptorKey
} from "./provider";
export type { EmbeddingProvider } from "./provider";
