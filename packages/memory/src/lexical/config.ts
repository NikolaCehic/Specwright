import { z } from "zod";
import { MemoryError } from "../errors";

export const BM25ConfigSchema = z
  .object({
    k1: z.number().finite().positive().max(10),
    b: z.number().finite().min(0).max(1)
  })
  .strict();
export type BM25Config = z.infer<typeof BM25ConfigSchema>;

export const DEFAULT_BM25_CONFIG = {
  k1: 1.2,
  b: 0.75
} satisfies BM25Config;

export function parseBM25Config(input: unknown = DEFAULT_BM25_CONFIG): BM25Config {
  const parsed = BM25ConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_lexical_index",
      field: "bm25",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "bm25"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}
