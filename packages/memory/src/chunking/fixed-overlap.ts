import { z } from "zod";
import type { CandidateChunk } from "../chunk";
import type { MemoryDocument } from "../document";
import { MemoryError } from "../errors";
import { hashValue } from "../hash";
import type { ChunkingStrategy } from "./index";
import {
  TOKENIZER_ID,
  TOKENIZER_VERSION,
  spanForTokens,
  tokenizeText
} from "./tokenizer";

export const FixedOverlapChunkingConfigSchema = z
  .object({
    chunkSize: z.number().int().positive(),
    overlap: z.number().int().min(0),
    tokenizerId: z.literal(TOKENIZER_ID).default(TOKENIZER_ID),
    tokenizerVersion: z.literal(TOKENIZER_VERSION).default(TOKENIZER_VERSION)
  })
  .strict()
  .superRefine((config, context) => {
    if (config.overlap >= config.chunkSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overlap"],
        message: "overlap must be less than chunkSize"
      });
    }
  });
export type FixedOverlapChunkingConfig = z.infer<
  typeof FixedOverlapChunkingConfigSchema
>;

function parseConfig(config: unknown): FixedOverlapChunkingConfig {
  const parsed = FixedOverlapChunkingConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_document",
      field: "fixedOverlap.config",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export const FixedOverlapChunkingStrategy = {
  id: "fixed-overlap",
  configSchema: FixedOverlapChunkingConfigSchema,
  version(config: unknown) {
    const parsed = parseConfig(config);
    return hashValue({
      strategy: "fixed-overlap",
      chunkSize: parsed.chunkSize,
      overlap: parsed.overlap,
      tokenizerId: parsed.tokenizerId,
      tokenizerVersion: parsed.tokenizerVersion
    });
  },
  chunk(document: MemoryDocument, config: unknown): CandidateChunk[] {
    const parsed = parseConfig(config);
    const tokens = tokenizeText(document.content);
    if (tokens.length === 0) {
      throw new MemoryError({
        code: "invalid_document",
        field: "content",
        condition: "empty_tokens",
        message: "Document content produced no tokens"
      });
    }

    const chunks: CandidateChunk[] = [];
    const step = parsed.chunkSize - parsed.overlap;

    for (let start = 0; start < tokens.length; start += step) {
      const end = Math.min(start + parsed.chunkSize, tokens.length);
      const window = tokens.slice(start, end);
      const span = spanForTokens(window);
      const text = document.content.slice(span.start, span.end);
      chunks.push({
        text,
        span,
        tokenSpan: {
          start,
          end
        },
        metadata: {
          tokenizerId: parsed.tokenizerId,
          tokenizerVersion: parsed.tokenizerVersion
        }
      });

      if (end === tokens.length) {
        break;
      }
    }

    return chunks;
  }
} satisfies ChunkingStrategy<FixedOverlapChunkingConfig>;
