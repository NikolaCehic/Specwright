export {
  CODE_ANALYZER_CONFIG,
  CodeLexicalAnalyzer,
  LEXICAL_ANALYZER_VERSION,
  LexicalAnalyzerConfigSchema,
  LexicalAnalyzerIdSchema,
  LexicalTokenSchema,
  PROSE_ANALYZER_CONFIG,
  ProseLexicalAnalyzer,
  analyzeText,
  createLexicalAnalyzer,
  normalizeTerm,
  parseLexicalAnalyzerConfig
} from "./analyzer";
export type {
  LexicalAnalyzer,
  LexicalAnalyzerConfig,
  LexicalAnalyzerId,
  LexicalToken
} from "./analyzer";
export {
  compareCandidates,
  inverseDocumentFrequency,
  scoreBM25,
  scoreBM25Candidates
} from "./bm25";
export type { LexicalScoreCandidate } from "./bm25";
export {
  BM25ConfigSchema,
  DEFAULT_BM25_CONFIG,
  parseBM25Config
} from "./config";
export type { BM25Config } from "./config";
export {
  LexicalIndexedChunkSchema,
  buildLexicalIndex,
  buildLexicalIndexFromStore,
  getPosting
} from "./inverted-index";
export type {
  BuildLexicalIndexFromStoreInput,
  BuildLexicalIndexInput,
  LexicalIndex,
  LexicalIndexedChunk,
  LexicalPosting,
  LexicalTermStats
} from "./inverted-index";
export {
  LEXICAL_INDEX_FORMAT_VERSION,
  LexicalIndexVersionInputSchema,
  buildLexicalIndexVersion
} from "./index-version";
export type { LexicalIndexVersionInput } from "./index-version";
export { scoreProximity, scoreProximityCandidates } from "./proximity";
export {
  LexicalHitSchema,
  LexicalHitScoresSchema,
  LexicalMemoryProvenanceSchema,
  LexicalRetrievalResultSchema,
  LexicalRetriever,
  LexicalRetrieverQuerySchema,
  LexicalStructuralFilterSchema,
  normalizeQueryText,
  retrieveLexical
} from "./retriever";
export type {
  LexicalHit,
  LexicalHitScores,
  LexicalMemoryProvenance,
  LexicalRetrievalResult,
  LexicalRetrieverQuery,
  LexicalStructuralFilter
} from "./retriever";
