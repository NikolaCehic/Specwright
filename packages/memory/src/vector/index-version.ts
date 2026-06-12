import { z } from "zod";
import {
  DenseIndexVersionDescriptorSchema,
  EmbeddingDescriptorSchema,
  HnswAnnParamsSchema
} from "../dense-contracts";
import { Sha256HashSchema, hashValue } from "../hash";

export const DENSE_INDEX_FORMAT_VERSION = "1.0.0";

export const DenseIndexVersionInputSchema = z
  .object({
    corpusSnapshotHash: Sha256HashSchema,
    embedding: EmbeddingDescriptorSchema,
    annParams: HnswAnnParamsSchema,
    chunkingStrategyVersions: z.array(Sha256HashSchema).min(1),
    indexFormatVersion: z.literal(DENSE_INDEX_FORMAT_VERSION)
  })
  .strict();
export type DenseIndexVersionInput = z.infer<
  typeof DenseIndexVersionInputSchema
>;

export function buildDenseIndexVersion(input: DenseIndexVersionInput): string {
  return hashValue({
    ...DenseIndexVersionInputSchema.parse({
      ...input,
      chunkingStrategyVersions: [...input.chunkingStrategyVersions].sort()
    })
  });
}

export function parseDenseIndexVersionDescriptor(input: unknown) {
  return DenseIndexVersionDescriptorSchema.parse(input);
}
