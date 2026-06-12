import { z } from "zod";
import { Sha256HashSchema, hashValue } from "../hash";
import { LexicalAnalyzerConfigSchema } from "./analyzer";
import { BM25ConfigSchema } from "./config";

export const LEXICAL_INDEX_FORMAT_VERSION = "1.0.0";

export const LexicalIndexVersionInputSchema = z
  .object({
    corpusSnapshotHash: Sha256HashSchema,
    chunkingStrategyVersions: z.array(Sha256HashSchema).min(1),
    analyzer: LexicalAnalyzerConfigSchema,
    bm25: BM25ConfigSchema,
    indexFormatVersion: z.literal(LEXICAL_INDEX_FORMAT_VERSION)
  })
  .strict();
export type LexicalIndexVersionInput = z.infer<
  typeof LexicalIndexVersionInputSchema
>;

export function buildLexicalIndexVersion(
  input: LexicalIndexVersionInput
): string {
  const parsed = LexicalIndexVersionInputSchema.parse({
    ...input,
    chunkingStrategyVersions: [...input.chunkingStrategyVersions].sort()
  });

  return hashValue(parsed);
}
