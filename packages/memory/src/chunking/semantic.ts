import { z } from "zod";
import type { CandidateChunk } from "../chunk";
import type { MemoryDocument } from "../document";
import { MemoryError } from "../errors";
import { hashValue } from "../hash";
import type { ChunkingStrategy } from "./index";
import { tokenizeText } from "./tokenizer";

export const SemanticChunkingConfigSchema = z
  .object({
    boundaryModelId: z.string().min(1),
    boundaryModelVersion: z.string().min(1),
    threshold: z.number().min(0).max(1),
    minChunkSize: z.number().int().positive(),
    maxChunkSize: z.number().int().positive()
  })
  .strict()
  .superRefine((config, context) => {
    if (config.minChunkSize > config.maxChunkSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minChunkSize"],
        message: "minChunkSize must be less than or equal to maxChunkSize"
      });
    }
  });
export type SemanticChunkingConfig = z.infer<
  typeof SemanticChunkingConfigSchema
>;

interface SentenceRecord {
  readonly text: string;
  readonly span: {
    readonly start: number;
    readonly end: number;
  };
  readonly tokens: ReadonlySet<string>;
}

function parseConfig(config: unknown): SemanticChunkingConfig {
  if (
    config === null ||
    typeof config !== "object" ||
    typeof (config as Record<string, unknown>).boundaryModelId !== "string" ||
    typeof (config as Record<string, unknown>).boundaryModelVersion !== "string"
  ) {
    throw new MemoryError({
      code: "strategy_unpinned",
      field: "semantic.boundaryModel",
      condition: "missing",
      message:
        "Semantic chunking requires pinned boundaryModelId and boundaryModelVersion"
    });
  }

  const parsed = SemanticChunkingConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_document",
      field: "semantic.config",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export const SemanticChunkingStrategy = {
  id: "semantic",
  configSchema: SemanticChunkingConfigSchema,
  version(config: unknown) {
    const parsed = parseConfig(config);
    return hashValue({
      strategy: "semantic",
      boundaryModelId: parsed.boundaryModelId,
      boundaryModelVersion: parsed.boundaryModelVersion,
      threshold: parsed.threshold,
      minChunkSize: parsed.minChunkSize,
      maxChunkSize: parsed.maxChunkSize
    });
  },
  chunk(document: MemoryDocument, config: unknown): CandidateChunk[] {
    const parsed = parseConfig(config);
    const sentences = collectSentences(document.content);
    if (sentences.length === 0) {
      throw new MemoryError({
        code: "invalid_document",
        field: "content",
        condition: "empty_sentences",
        message: "Document content produced no semantic sentences"
      });
    }

    const chunks: CandidateChunk[] = [];
    let startIndex = 0;

    for (let index = 1; index < sentences.length; index += 1) {
      const current = sentences[index];
      const previous = sentences[index - 1];
      if (current === undefined || previous === undefined) {
        continue;
      }

      const currentSpan = spanForSentenceRange(sentences, startIndex, index);
      const distance = 1 - jaccard(previous.tokens, current.tokens);
      const shouldSplit =
        currentSpan.end - currentSpan.start >= parsed.maxChunkSize ||
        (currentSpan.end - currentSpan.start >= parsed.minChunkSize &&
          distance >= parsed.threshold);

      if (shouldSplit) {
        chunks.push(
          chunkForSentenceRange(document.content, sentences, startIndex, index, {
            boundaryDistance: distance,
            boundaryModelId: parsed.boundaryModelId,
            boundaryModelVersion: parsed.boundaryModelVersion
          })
        );
        startIndex = index;
      }
    }

    chunks.push(
      chunkForSentenceRange(
        document.content,
        sentences,
        startIndex,
        sentences.length,
        {
          boundaryDistance: null,
          boundaryModelId: parsed.boundaryModelId,
          boundaryModelVersion: parsed.boundaryModelVersion
        }
      )
    );

    return chunks;
  }
} satisfies ChunkingStrategy<SemanticChunkingConfig>;

function collectSentences(text: string): SentenceRecord[] {
  const pattern = /[^.!?\n]+(?:[.!?]+|\n|$)/gu;
  const sentences: SentenceRecord[] = [];

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index;
    if (index === undefined) {
      continue;
    }

    const leading = raw.search(/\S/u);
    if (leading < 0) {
      continue;
    }

    const trailingMatch = /\s*$/u.exec(raw);
    const trailing = trailingMatch?.[0].length ?? 0;
    const start = index + leading;
    const end = index + raw.length - trailing;
    const sentenceText = text.slice(start, end);
    sentences.push({
      text: sentenceText,
      span: { start, end },
      tokens: new Set(
        tokenizeText(sentenceText).map((token) => token.value.toLowerCase())
      )
    });
  }

  return sentences;
}

function spanForSentenceRange(
  sentences: readonly SentenceRecord[],
  start: number,
  end: number
) {
  const first = sentences[start];
  const last = sentences[end - 1];
  if (first === undefined || last === undefined) {
    throw new MemoryError({
      code: "invalid_chunk",
      field: "semantic.sentences",
      condition: "empty_range",
      message: "Cannot compute span for empty sentence range"
    });
  }

  return {
    start: first.span.start,
    end: last.span.end
  };
}

function chunkForSentenceRange(
  text: string,
  sentences: readonly SentenceRecord[],
  start: number,
  end: number,
  metadata: Record<string, unknown>
): CandidateChunk {
  const span = spanForSentenceRange(sentences, start, end);
  return {
    text: text.slice(span.start, span.end),
    span,
    metadata
  };
}

function jaccard(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : intersection / union;
}
