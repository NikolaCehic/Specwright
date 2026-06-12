import { z } from "zod";
import type { Span } from "../chunk";

export const TOKENIZER_ID = "specwright-unicode-tokenizer";
export const TOKENIZER_VERSION = "1.0.0";

export const TokenSchema = z
  .object({
    value: z.string().min(1),
    span: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0)
      })
      .strict()
  })
  .strict();
export type Token = z.infer<typeof TokenSchema>;

const tokenPattern = /\p{L}[\p{L}\p{N}_'-]*|\p{N}+(?:[.,]\p{N}+)*|[^\s]/gu;

export function tokenizeText(text: string): Token[] {
  const tokens: Token[] = [];

  for (const match of text.matchAll(tokenPattern)) {
    const value = match[0];
    const start = match.index;
    if (start === undefined || value.length === 0) {
      continue;
    }

    tokens.push({
      value,
      span: {
        start,
        end: start + value.length
      }
    });
  }

  return tokens;
}

export function spanForTokens(tokens: readonly Token[]): Span {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first === undefined || last === undefined) {
    return { start: 0, end: 0 };
  }

  return {
    start: first.span.start,
    end: last.span.end
  };
}
