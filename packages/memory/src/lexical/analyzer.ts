import { z } from "zod";
import { SpanSchema } from "../chunk";
import { tokenizeText } from "../chunking/tokenizer";
import { MemoryError } from "../errors";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0);

export const LEXICAL_ANALYZER_VERSION = "1.0.0";

export const LexicalAnalyzerIdSchema = z.enum([
  "specwright-prose",
  "specwright-code"
]);
export type LexicalAnalyzerId = z.infer<typeof LexicalAnalyzerIdSchema>;

export const LexicalAnalyzerConfigSchema = z
  .object({
    id: LexicalAnalyzerIdSchema,
    version: z.literal(LEXICAL_ANALYZER_VERSION),
    lowercase: z.boolean(),
    stopwords: z.boolean(),
    stemming: z.boolean(),
    asciiFold: z.boolean(),
    preserveCase: z.boolean(),
    preserveIdentifiers: z.boolean()
  })
  .strict()
  .superRefine((config, context) => {
    if (config.id === "specwright-prose") {
      if (
        !config.lowercase ||
        !config.stopwords ||
        !config.stemming ||
        !config.asciiFold ||
        config.preserveCase ||
        config.preserveIdentifiers
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "prose analyzer must lowercase, stopword-filter, stem, and ascii-fold"
        });
      }
    }

    if (config.id === "specwright-code") {
      if (
        config.lowercase ||
        config.stopwords ||
        config.stemming ||
        config.asciiFold ||
        !config.preserveCase ||
        !config.preserveIdentifiers
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "code analyzer must preserve case and identifiers"
        });
      }
    }
  });
export type LexicalAnalyzerConfig = z.infer<typeof LexicalAnalyzerConfigSchema>;

export const LexicalTokenSchema = z
  .object({
    term: nonEmptyString,
    original: nonEmptyString,
    position: nonNegativeInteger,
    span: SpanSchema
  })
  .strict();
export type LexicalToken = z.infer<typeof LexicalTokenSchema>;

export interface LexicalAnalyzer {
  readonly config: LexicalAnalyzerConfig;
  analyze(text: string): LexicalToken[];
}

export const PROSE_ANALYZER_CONFIG = {
  id: "specwright-prose",
  version: LEXICAL_ANALYZER_VERSION,
  lowercase: true,
  stopwords: true,
  stemming: true,
  asciiFold: true,
  preserveCase: false,
  preserveIdentifiers: false
} satisfies LexicalAnalyzerConfig;

export const CODE_ANALYZER_CONFIG = {
  id: "specwright-code",
  version: LEXICAL_ANALYZER_VERSION,
  lowercase: false,
  stopwords: false,
  stemming: false,
  asciiFold: false,
  preserveCase: true,
  preserveIdentifiers: true
} satisfies LexicalAnalyzerConfig;

const stopwords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "with"
]);

export function parseLexicalAnalyzerConfig(
  input: unknown
): LexicalAnalyzerConfig {
  const parsed = LexicalAnalyzerConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryError({
      code: "invalid_analyzer_config",
      field: "analyzer",
      condition: "schema",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "analyzer"}: ${issue.message}`)
        .join("; ")
    });
  }

  return parsed.data;
}

export function createLexicalAnalyzer(
  input: unknown = PROSE_ANALYZER_CONFIG
): LexicalAnalyzer {
  const config = parseLexicalAnalyzerConfig(input);
  return {
    config,
    analyze(text: string): LexicalToken[] {
      return analyzeText(text, config);
    }
  };
}

export const ProseLexicalAnalyzer = createLexicalAnalyzer(PROSE_ANALYZER_CONFIG);
export const CodeLexicalAnalyzer = createLexicalAnalyzer(CODE_ANALYZER_CONFIG);

export function analyzeText(
  text: string,
  config: LexicalAnalyzerConfig
): LexicalToken[] {
  const normalizedInput = text.normalize("NFC");
  const tokens = tokenizeText(normalizedInput);
  const analyzed: LexicalToken[] = [];

  for (const token of tokens) {
    if (!isLexicalToken(token.value, config)) {
      continue;
    }

    const term = normalizeTerm(token.value, config);
    if (term.length === 0 || (config.stopwords && stopwords.has(term))) {
      continue;
    }

    analyzed.push(
      LexicalTokenSchema.parse({
        term,
        original: token.value,
        position: analyzed.length,
        span: token.span
      })
    );
  }

  return analyzed;
}

export function normalizeTerm(
  value: string,
  config: LexicalAnalyzerConfig
): string {
  let term = config.asciiFold ? foldAscii(value) : value;
  if (config.lowercase) {
    term = term.toLocaleLowerCase("en-US");
  }

  if (config.stemming) {
    term = stemEnglishTerm(term);
  }

  return term;
}

function isLexicalToken(
  value: string,
  config: LexicalAnalyzerConfig
): boolean {
  if (config.preserveIdentifiers) {
    return /[\p{L}\p{N}_]/u.test(value);
  }

  return /[\p{L}\p{N}]/u.test(value);
}

function foldAscii(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "");
}

function stemEnglishTerm(term: string): string {
  if (term.length <= 3 || !/[aeiouy]/u.test(term)) {
    return term;
  }

  const protectedSuffixes = ["ss", "us"];
  if (term.endsWith("ies") && term.length > 4) {
    return `${term.slice(0, -3)}y`;
  }

  if (term.endsWith("sses") && term.length > 5) {
    return term.slice(0, -2);
  }

  for (const suffix of ["ingly", "edly", "ing", "ed"]) {
    if (term.endsWith(suffix)) {
      const stem = term.slice(0, -suffix.length);
      if (stem.length >= 3 && /[aeiouy]/u.test(stem)) {
        return collapseDoubledConsonant(stem);
      }
    }
  }

  for (const suffix of ["ation", "ment", "ness", "able", "ible", "ally", "ly"]) {
    if (term.endsWith(suffix) && term.length - suffix.length >= 4) {
      return term.slice(0, -suffix.length);
    }
  }

  if (
    term.endsWith("s") &&
    term.length > 4 &&
    !protectedSuffixes.some((suffix) => term.endsWith(suffix))
  ) {
    return term.slice(0, -1);
  }

  return term;
}

function collapseDoubledConsonant(value: string): string {
  if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/u.test(value)) {
    return value.slice(0, -1);
  }

  return value;
}
