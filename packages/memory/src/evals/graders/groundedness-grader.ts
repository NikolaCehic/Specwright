import type { EvalFinding, EvalVerdict } from "@specwright/schemas";
import type { RankedHit, RetrievalResult } from "../../ranking";
import {
  activeTombstones,
  loadRetrievalEvalDataset,
  type RetrievalClaimSupport,
  type RetrievalEvalDataset,
  type RetrievalGroundedClaim
} from "./dataset";
import {
  buildMemoryEvalVerdict,
  buildRetrievalRepairTask,
  makeMemoryEvalFinding,
  uniqueStrings
} from "./verdict";

export const GROUNDEDNESS_GRADER_REF =
  "specwright.memory.groundedness-grader@1.0.0";

export const GROUNDEDNESS_CLAIM_UNTRACED_CODE =
  "groundedness.claim_untraced";
export const GROUNDEDNESS_LOW_TRUST_SOURCE_CODE =
  "groundedness.low_trust_source";
export const GROUNDEDNESS_SELF_RETRIEVAL_CODE =
  "groundedness.self_retrieval";
export const FAITHFULNESS_MISMATCH_CODE = "faithfulness.mismatch";

const lowTrustAuthorities = new Set(["generated", "model", "external"]);
const evidenceRequiredClaimLevels = new Set(["source_fact", "derived_fact"]);

export interface GradeGroundednessInput {
  readonly dataset: unknown;
  readonly resultsByQueryId:
    | ReadonlyMap<string, RetrievalResult>
    | Readonly<Record<string, RetrievalResult>>;
  readonly evalId?: string;
  readonly targetRef?: string;
  readonly traceId?: string;
}

export interface GradeLoadedGroundednessInput {
  readonly dataset: RetrievalEvalDataset;
  readonly resultsByQueryId:
    | ReadonlyMap<string, RetrievalResult>
    | Readonly<Record<string, RetrievalResult>>;
  readonly evalId?: string;
  readonly targetRef?: string;
  readonly traceId?: string;
}

export function gradeGroundedness(input: GradeGroundednessInput): EvalVerdict {
  const loaded = loadRetrievalEvalDataset(input.dataset);
  if (loaded.status === "failed") {
    return buildMemoryEvalVerdict({
      evalId: input.evalId ?? "memory.groundedness",
      targetRef: input.targetRef ?? "memory:groundedness",
      status: "fail",
      findings: [loaded.finding],
      evidenceRefs: [],
      producedBy: {
        kind: "deterministic",
        ref: GROUNDEDNESS_GRADER_REF
      },
      repairTask: buildRetrievalRepairTask({
        task: "Restore or review the retrieval eval dataset before groundedness grading.",
        targetRef: input.targetRef ?? "memory:groundedness",
        findingCodes: [loaded.finding.code ?? "dataset.load_failed"]
      }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId })
    });
  }

  return gradeLoadedGroundedness({
    ...input,
    dataset: loaded.dataset
  });
}

export function gradeLoadedGroundedness(
  input: GradeLoadedGroundednessInput
): EvalVerdict {
  const targetRef = input.targetRef ?? `memory-dataset:${input.dataset.datasetId}`;
  const resultMap = asResultMap(input.resultsByQueryId);
  const hitIndex = indexHits(input.dataset, resultMap);
  const findings = input.dataset.claims.flatMap((claim) =>
    findingsForClaim(claim, hitIndex, targetRef)
  );
  const findingCodes = uniqueStrings(
    findings.map((finding) => finding.code ?? "eval.finding")
  );

  return buildMemoryEvalVerdict({
    evalId: input.evalId ?? `${input.dataset.evalId}.groundedness`,
    targetRef,
    status: findings.length === 0 ? "pass" : "fail",
    findings,
    evidenceRefs: uniqueStrings([
      `memory-dataset:${input.dataset.datasetId}@${input.dataset.version}`,
      ...input.dataset.claims.flatMap((claim) =>
        claim.support.map((support) => sourceRefEvidenceRef(support.sourceRef))
      )
    ]),
    producedBy: {
      kind: "deterministic",
      ref: GROUNDEDNESS_GRADER_REF
    },
    ...(findings.length === 0
      ? {}
      : {
          repairTask: buildRetrievalRepairTask({
            task: "Resolve groundedness and faithfulness failures before treating memory output as authoritative.",
            targetRef,
            findingCodes
          })
        }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId })
  });
}

function findingsForClaim(
  claim: RetrievalGroundedClaim,
  hitIndex: ReadonlyMap<string, RankedHit>,
  targetRef: string
): EvalFinding[] {
  const findings: EvalFinding[] = [];
  const tracedHits = claim.support
    .map((support) => hitIndex.get(supportKey(support)))
    .filter((hit): hit is RankedHit => hit !== undefined);

  if (tracedHits.length !== claim.support.length) {
    findings.push(
      makeMemoryEvalFinding({
        message: `Claim ${claim.id} does not trace to every required indexed source`,
        code: GROUNDEDNESS_CLAIM_UNTRACED_CODE,
        targetRef,
        repairHint:
          "Bind the claim to sourceRef/sourceHash values present in the pinned retrieval result.",
        metadata: {
          claimId: claim.id,
          missingSupport: claim.support
            .filter((support) => hitIndex.get(supportKey(support)) === undefined)
            .map((support) => ({
              chunkId: support.chunkId,
              sourceRef: support.sourceRef,
              sourceHash: support.sourceHash
            }))
        }
      })
    );
  }

  if (
    evidenceRequiredClaimLevels.has(claim.claimLevel) &&
    tracedHits.length > 0 &&
    tracedHits.every((hit) => lowTrustAuthorities.has(hit.trustLabel)) &&
    claim.independentEvidenceRefs.length === 0
  ) {
    findings.push(
      makeMemoryEvalFinding({
        message: `Claim ${claim.id} is supported only by low-trust retrieved sources`,
        code: GROUNDEDNESS_LOW_TRUST_SOURCE_CODE,
        targetRef,
        repairHint:
          "Add independent evidence or demote the claim level; retrieved low-trust hits cannot become source facts by themselves.",
        metadata: {
          claimId: claim.id,
          claimLevel: claim.claimLevel,
          supportTrustLabels: tracedHits.map((hit) => hit.trustLabel)
        }
      })
    );
  }

  if (
    claim.selfArtifactId !== undefined &&
    claim.selfArtifactId === claim.owningArtifactId &&
    claim.independentEvidenceRefs.length === 0
  ) {
    findings.push(
      makeMemoryEvalFinding({
        message: `Claim ${claim.id} cites its owning artifact through memory without independent evidence`,
        code: GROUNDEDNESS_SELF_RETRIEVAL_CODE,
        targetRef,
        repairHint:
          "Use external evidence, repo/design sources, or lower the claim authority; self-retrieval is not grounding.",
        metadata: {
          claimId: claim.id,
          owningArtifactId: claim.owningArtifactId,
          selfArtifactId: claim.selfArtifactId
        }
      })
    );
  }

  for (const support of claim.support) {
    if (
      support.modelVisibleSourceHash !== undefined &&
      support.modelVisibleSourceHash !== support.sourceHash
    ) {
      findings.push(
        makeMemoryEvalFinding({
          message: `Claim ${claim.id} model-visible support hash does not match the recorded source hash`,
          code: FAITHFULNESS_MISMATCH_CODE,
          targetRef,
          repairHint:
            "Recompute model-visible evidence from the redacted source view or refresh the support hash.",
          metadata: {
            claimId: claim.id,
            chunkId: support.chunkId,
            expectedSourceHash: support.sourceHash,
            modelVisibleSourceHash: support.modelVisibleSourceHash
          }
        })
      );
    }
  }

  return findings;
}

function indexHits(
  dataset: RetrievalEvalDataset,
  resultsByQueryId: ReadonlyMap<string, RetrievalResult>
): ReadonlyMap<string, RankedHit> {
  const tombstoned = activeTombstones(dataset);
  const indexed = new Map<string, RankedHit>();

  for (const query of dataset.queries) {
    for (const hit of resultsByQueryId.get(query.id)?.hits ?? []) {
      if (!tombstoned.has(hit.chunkId)) {
        indexed.set(hitKey(hit), hit);
      }
    }
  }

  return indexed;
}

function asResultMap(
  input: GradeGroundednessInput["resultsByQueryId"]
): ReadonlyMap<string, RetrievalResult> {
  return input instanceof Map ? input : new Map(Object.entries(input));
}

function supportKey(support: RetrievalClaimSupport): string {
  return [
    support.chunkId,
    sourceRefEvidenceRef(support.sourceRef),
    support.sourceHash
  ].join("\u001f");
}

function hitKey(hit: RankedHit): string {
  return [hit.chunkId, sourceRefEvidenceRef(hit.sourceRef), hit.sourceHash].join(
    "\u001f"
  );
}

function sourceRefEvidenceRef(
  sourceRef: RetrievalClaimSupport["sourceRef"]
): string {
  if (typeof sourceRef === "string") {
    return sourceRef;
  }

  return (
    sourceRef.id ??
    sourceRef.uri ??
    sourceRef.path ??
    sourceRef.contentHash ??
    JSON.stringify(sourceRef)
  );
}
