import { z } from "zod";
import { MetadataSchema } from "@specwright/schemas";

const nonEmptyString = z.string().min(1);

export const MemoryClassSchema = z.enum([
  "working",
  "episodic",
  "semantic",
  "procedural"
]);
export type MemoryClass = z.infer<typeof MemoryClassSchema>;

export const TrustLabelSchema = z.enum([
  "user",
  "repo",
  "design",
  "external",
  "model",
  "generated"
]);
export type TrustLabel = z.infer<typeof TrustLabelSchema>;

export const MemoryCorpusSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    class: MemoryClassSchema,
    tenantId: nonEmptyString,
    snapshotId: nonEmptyString,
    version: nonEmptyString,
    metadata: MetadataSchema.optional()
  })
  .strict();
export type MemoryCorpus = z.infer<typeof MemoryCorpusSchema>;
