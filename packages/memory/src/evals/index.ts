import { EvalDefinitionSchema, type EvalDefinition } from "@specwright/schemas";
import {
  GROUNDEDNESS_GRADER_REF,
  RETRIEVAL_QUALITY_GRADER_REF
} from "./graders";

export * from "./graders";

export const MEMORY_RETRIEVAL_QUALITY_EVAL_ID =
  "memory.semantic.retrieval_quality.v1";
export const MEMORY_GROUNDEDNESS_EVAL_ID = "memory.semantic.groundedness.v1";
export const MEMORY_RETRIEVAL_EVAL_DATASET_ID =
  "memory.semantic.hybrid_retrieval_quality.v1";

export const MEMORY_RETRIEVAL_QUALITY_EVAL_DEFINITION =
  EvalDefinitionSchema.parse({
    id: MEMORY_RETRIEVAL_QUALITY_EVAL_ID,
    description:
      "Blocking deterministic retrieval-quality gate over a content-addressed memory eval dataset.",
    type: "deterministic",
    blocking: true,
    severity: "blocking",
    datasetRef: {
      id: MEMORY_RETRIEVAL_EVAL_DATASET_ID,
      version: "1.0.0",
      path: "packages/memory/evals/datasets/semantic-hybrid-quality-v1.json"
    },
    grader: {
      ref: RETRIEVAL_QUALITY_GRADER_REF,
      kind: "deterministic",
      outputSchemaRef: "specwright.lifecycle.eval-verdict"
    },
    target: {
      artifactId: "memory.indexVersion"
    },
    gates: ["memory.index_promotion"],
    metadata: {
      corpusClass: "semantic",
      metrics: ["recall@k", "nDCG@k", "MRR", "precision@k"]
    }
  }) as EvalDefinition;

export const MEMORY_GROUNDEDNESS_EVAL_DEFINITION =
  EvalDefinitionSchema.parse({
    id: MEMORY_GROUNDEDNESS_EVAL_ID,
    description:
      "Blocking deterministic groundedness and faithfulness gate for memory-backed claims.",
    type: "deterministic",
    blocking: true,
    severity: "blocking",
    datasetRef: {
      id: MEMORY_RETRIEVAL_EVAL_DATASET_ID,
      version: "1.0.0",
      path: "packages/memory/evals/datasets/semantic-hybrid-quality-v1.json"
    },
    grader: {
      ref: GROUNDEDNESS_GRADER_REF,
      kind: "deterministic",
      outputSchemaRef: "specwright.lifecycle.eval-verdict"
    },
    target: {
      artifactId: "memory.claims"
    },
    gates: ["memory.index_promotion"],
    metadata: {
      corpusClass: "semantic",
      checks: [
        "claim_untraced",
        "low_trust_source",
        "self_retrieval",
        "faithfulness"
      ]
    }
  }) as EvalDefinition;

export const MEMORY_RETRIEVAL_EVAL_DEFINITIONS = [
  MEMORY_RETRIEVAL_QUALITY_EVAL_DEFINITION,
  MEMORY_GROUNDEDNESS_EVAL_DEFINITION
] as const;
