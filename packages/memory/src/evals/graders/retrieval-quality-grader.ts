import type { EvalFinding, EvalVerdict } from "@specwright/schemas";
import type { RetrievalResult } from "../../ranking";
import {
  DATASET_PINNED_VERSION_MISSING_CODE,
  activeTombstones,
  loadRetrievalEvalDataset,
  queryHashOrId,
  type RetrievalEvalDataset
} from "./dataset";
import {
  scoreRetrievalMetrics,
  type RetrievalMetricScores
} from "./metrics";
import {
  buildMemoryEvalVerdict,
  buildRetrievalRepairTask,
  makeMemoryEvalFinding,
  uniqueStrings
} from "./verdict";

export const RETRIEVAL_QUALITY_GRADER_REF =
  "specwright.memory.retrieval-quality-grader@1.0.0";

export const RETRIEVAL_QUERY_RESULT_MISSING_CODE =
  "retrieval.query_result.missing";
export const RETRIEVAL_INDEX_VERSION_MISMATCH_CODE =
  "retrieval.index_version.mismatch";
export const RETRIEVAL_TOMBSTONED_HIT_RETURNED_CODE =
  "retrieval.tombstoned_hit_returned";
export const RETRIEVAL_RECALL_BELOW_THRESHOLD_CODE =
  "retrieval.recall_at_k.below_threshold";
export const RETRIEVAL_NDCG_BELOW_THRESHOLD_CODE =
  "retrieval.ndcg_at_k.below_threshold";
export const RETRIEVAL_MRR_BELOW_THRESHOLD_CODE =
  "retrieval.mrr.below_threshold";
export const RETRIEVAL_PRECISION_BELOW_THRESHOLD_CODE =
  "retrieval.precision_at_k.below_threshold";

export interface GradeRetrievalQualityInput {
  readonly dataset: unknown;
  readonly resultsByQueryId:
    | ReadonlyMap<string, RetrievalResult>
    | Readonly<Record<string, RetrievalResult>>;
  readonly availableIndexVersions?: readonly string[];
  readonly evalId?: string;
  readonly targetRef?: string;
  readonly traceId?: string;
}

export interface GradeRetrievalQualityLoadedInput {
  readonly dataset: RetrievalEvalDataset;
  readonly resultsByQueryId:
    | ReadonlyMap<string, RetrievalResult>
    | Readonly<Record<string, RetrievalResult>>;
  readonly availableIndexVersions?: readonly string[];
  readonly evalId?: string;
  readonly targetRef?: string;
  readonly traceId?: string;
}

export function gradeRetrievalQuality(
  input: GradeRetrievalQualityInput
): EvalVerdict {
  const loaded = loadRetrievalEvalDataset(input.dataset);
  if (loaded.status === "failed") {
    return buildMemoryEvalVerdict({
      evalId: input.evalId ?? "memory.retrieval_quality",
      targetRef: input.targetRef ?? "memory:index-promotion",
      status: "fail",
      findings: [loaded.finding],
      evidenceRefs: [],
      producedBy: {
        kind: "deterministic",
        ref: RETRIEVAL_QUALITY_GRADER_REF
      },
      repairTask: buildRetrievalRepairTask({
        task: "Restore or review the retrieval eval dataset before promotion.",
        targetRef: input.targetRef ?? "memory:index-promotion",
        findingCodes: [loaded.finding.code ?? "dataset.load_failed"]
      }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId })
    });
  }

  return gradeLoadedRetrievalQuality({
    ...input,
    dataset: loaded.dataset
  });
}

export function gradeLoadedRetrievalQuality(
  input: GradeRetrievalQualityLoadedInput
): EvalVerdict {
  const targetRef =
    input.targetRef ?? `memory-index:${input.dataset.pinned.indexVersion}`;
  const findings: EvalFinding[] = [];
  const resultsByQueryId = asResultMap(input.resultsByQueryId);
  const availableVersions = new Set(input.availableIndexVersions ?? []);

  if (
    input.availableIndexVersions !== undefined &&
    !availableVersions.has(input.dataset.pinned.indexVersion)
  ) {
    findings.push(
      makeMemoryEvalFinding({
        message: `Pinned retrieval index ${input.dataset.pinned.indexVersion} is not available for replay`,
        code: DATASET_PINNED_VERSION_MISSING_CODE,
        targetRef,
        repairHint:
          "Replay the recorded retrieval output from the pinned index or restore the indexed version before grading.",
        metadata: {
          datasetId: input.dataset.datasetId,
          expectedIndexVersion: input.dataset.pinned.indexVersion,
          availableIndexVersions: [...availableVersions].sort()
        }
      })
    );
  }

  for (const query of input.dataset.queries) {
    const result = resultsByQueryId.get(query.id);
    if (result === undefined) {
      findings.push(
        makeMemoryEvalFinding({
          message: `Retrieval result for query ${query.id} is missing`,
          code: RETRIEVAL_QUERY_RESULT_MISSING_CODE,
          targetRef: `memory-query:${query.id}`,
          repairHint:
            "Grade only against a complete recorded RetrievalResult set for every eval query.",
          metadata: {
            datasetId: input.dataset.datasetId,
            queryId: query.id,
            queryHash: queryHashOrId(query)
          }
        })
      );
      continue;
    }

    if (result.provenance.indexVersion !== input.dataset.pinned.indexVersion) {
      findings.push(
        makeMemoryEvalFinding({
          message: `Retrieval result for query ${query.id} came from ${result.provenance.indexVersion}, not pinned ${input.dataset.pinned.indexVersion}`,
          code: RETRIEVAL_INDEX_VERSION_MISMATCH_CODE,
          targetRef: `memory-query:${query.id}`,
          repairHint:
            "Use recorded hits from the dataset-pinned index version; do not substitute the current index.",
          metadata: {
            datasetId: input.dataset.datasetId,
            queryId: query.id,
            expectedIndexVersion: input.dataset.pinned.indexVersion,
            actualIndexVersion: result.provenance.indexVersion
          }
        })
      );
    }
  }

  findings.push(
    ...findTombstonedHits(input.dataset, resultsByQueryId, targetRef)
  );

  const hitsByQueryId = new Map(
    input.dataset.queries.map((query) => [
      query.id,
      resultsByQueryId.get(query.id)?.hits ?? []
    ])
  );
  const metrics = scoreRetrievalMetrics({
    queries: input.dataset.queries,
    hitsByQueryId,
    recallK: input.dataset.thresholds.recallAtK.k,
    precisionK: input.dataset.thresholds.precisionAtK.k,
    mrrK: input.dataset.thresholds.mrr.k,
    ndcgK: input.dataset.thresholds.ndcgAtK.k
  });

  findings.push(
    ...findMetricThresholdFailures(input.dataset, metrics, targetRef)
  );

  const findingCodes = uniqueStrings(
    findings.map((finding) => finding.code ?? "eval.finding")
  );

  return buildMemoryEvalVerdict({
    evalId: input.evalId ?? input.dataset.evalId,
    targetRef,
    status: findings.length === 0 ? "pass" : "fail",
    findings,
    evidenceRefs: evidenceRefsForDataset(input.dataset),
    producedBy: {
      kind: "deterministic",
      ref: RETRIEVAL_QUALITY_GRADER_REF
    },
    ...(findings.length === 0
      ? {}
      : {
          repairTask: buildRetrievalRepairTask({
            task: `Do not promote retrieval index ${input.dataset.pinned.indexVersion} until retrieval-quality eval failures are resolved.`,
            targetRef,
            findingCodes
          })
        }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId })
  });
}

function findMetricThresholdFailures(
  dataset: RetrievalEvalDataset,
  metrics: RetrievalMetricScores,
  targetRef: string
): EvalFinding[] {
  return [
    metricFinding({
      code: RETRIEVAL_RECALL_BELOW_THRESHOLD_CODE,
      label: "recall@k",
      measured: metrics.recallAtK,
      threshold: dataset.thresholds.recallAtK.minimum,
      k: dataset.thresholds.recallAtK.k,
      dataset,
      targetRef,
      details: metrics.details
    }),
    metricFinding({
      code: RETRIEVAL_NDCG_BELOW_THRESHOLD_CODE,
      label: "nDCG@k",
      measured: metrics.ndcgAtK,
      threshold: dataset.thresholds.ndcgAtK.minimum,
      k: dataset.thresholds.ndcgAtK.k,
      dataset,
      targetRef,
      details: metrics.details
    }),
    metricFinding({
      code: RETRIEVAL_MRR_BELOW_THRESHOLD_CODE,
      label: "MRR",
      measured: metrics.mrr,
      threshold: dataset.thresholds.mrr.minimum,
      k: dataset.thresholds.mrr.k,
      dataset,
      targetRef,
      details: metrics.details
    }),
    metricFinding({
      code: RETRIEVAL_PRECISION_BELOW_THRESHOLD_CODE,
      label: "precision@k",
      measured: metrics.precisionAtK,
      threshold: dataset.thresholds.precisionAtK.minimum,
      k: dataset.thresholds.precisionAtK.k,
      dataset,
      targetRef,
      details: metrics.details
    })
  ].filter((finding): finding is EvalFinding => finding !== undefined);
}

function metricFinding(input: {
  readonly code: string;
  readonly label: string;
  readonly measured: number;
  readonly threshold: number;
  readonly k: number;
  readonly dataset: RetrievalEvalDataset;
  readonly targetRef: string;
  readonly details: RetrievalMetricScores["details"];
}): EvalFinding | undefined {
  if (input.measured >= input.threshold) {
    return undefined;
  }

  return makeMemoryEvalFinding({
    message: `Retrieval ${input.label} ${formatMetric(input.measured)} is below threshold ${formatMetric(input.threshold)}`,
    code: input.code,
    targetRef: input.targetRef,
    repairHint:
      "Retune retrieval, rebuild the pinned index, or review ground truth through governance before promotion.",
    metadata: {
      datasetId: input.dataset.datasetId,
      datasetVersion: input.dataset.version,
      indexVersion: input.dataset.pinned.indexVersion,
      measured: input.measured,
      threshold: input.threshold,
      k: input.k,
      queryDetails: input.details
    }
  });
}

function findTombstonedHits(
  dataset: RetrievalEvalDataset,
  resultsByQueryId: ReadonlyMap<string, RetrievalResult>,
  targetRef: string
): EvalFinding[] {
  const tombstoned = activeTombstones(dataset);
  if (tombstoned.size === 0) {
    return [];
  }

  const returned = new Set<string>();
  for (const query of dataset.queries) {
    for (const hit of resultsByQueryId.get(query.id)?.hits ?? []) {
      if (tombstoned.has(hit.chunkId)) {
        returned.add(hit.chunkId);
      }
    }
  }

  if (returned.size === 0) {
    return [];
  }

  return [
    makeMemoryEvalFinding({
      message: "Retrieval result returned tombstoned chunks during replay",
      code: RETRIEVAL_TOMBSTONED_HIT_RETURNED_CODE,
      targetRef,
      repairHint:
        "Apply erasure suppression before grading or rebuild the recorded fixture without forgotten chunks.",
      metadata: {
        datasetId: dataset.datasetId,
        tombstonedChunkIds: [...returned].sort()
      }
    })
  ];
}

function asResultMap(
  input: GradeRetrievalQualityInput["resultsByQueryId"]
): ReadonlyMap<string, RetrievalResult> {
  return input instanceof Map ? input : new Map(Object.entries(input));
}

function evidenceRefsForDataset(dataset: RetrievalEvalDataset): string[] {
  return uniqueStrings([
    `memory-dataset:${dataset.datasetId}@${dataset.version}`,
    `memory-index:${dataset.pinned.indexVersion}`
  ]);
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6);
}
