import {
  EvalFindingSchema,
  EvalVerdictSchema,
  RepairTaskSchema,
  type EvalFinding,
  type EvalProducedBy,
  type EvalSeverity,
  type EvalVerdict,
  type EvalVerdictStatus,
  type RepairTask
} from "@specwright/schemas";

export interface BuildMemoryEvalVerdictInput {
  readonly evalId: string;
  readonly targetRef: string;
  readonly status: Exclude<EvalVerdictStatus, "repaired">;
  readonly severity?: EvalSeverity;
  readonly findings?: readonly EvalFinding[];
  readonly evidenceRefs?: readonly string[];
  readonly producedBy?: EvalProducedBy;
  readonly repairTask?: RepairTask;
  readonly traceId?: string;
}

export function buildMemoryEvalVerdict(
  input: BuildMemoryEvalVerdictInput
): EvalVerdict {
  return EvalVerdictSchema.parse({
    evalId: input.evalId,
    targetRef: input.targetRef,
    status: input.status,
    severity: input.severity ?? "blocking",
    findings: input.findings ?? [],
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    producedBy: input.producedBy ?? {
      kind: "deterministic",
      ref: "specwright.memory.retrieval-quality-grader@1.0.0"
    },
    ...(input.repairTask === undefined ? {} : { repairTask: input.repairTask }),
    ...(input.traceId === undefined ? {} : { provenance: { traceId: input.traceId } })
  });
}

export function makeMemoryEvalFinding(input: {
  readonly message: string;
  readonly code: string;
  readonly targetRef: string;
  readonly severity?: EvalSeverity;
  readonly evidenceRefs?: readonly string[];
  readonly repairHint?: string;
  readonly path?: string;
  readonly metadata?: Record<string, unknown>;
}): EvalFinding {
  return EvalFindingSchema.parse({
    message: input.message,
    code: input.code,
    targetRef: input.targetRef,
    severity: input.severity ?? "blocking",
    ...(input.evidenceRefs === undefined
      ? {}
      : { evidenceRefs: uniqueStrings(input.evidenceRefs) }),
    ...(input.repairHint === undefined ? {} : { repairHint: input.repairHint }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata })
  });
}

export function buildRetrievalRepairTask(input: {
  readonly task: string;
  readonly targetRef: string;
  readonly findingCodes: readonly string[];
}): RepairTask {
  return RepairTaskSchema.parse({
    task: input.task,
    targetRef: input.targetRef,
    createdFromFindingIds: input.findingCodes,
    allowedTools: [],
    blockedTools: ["memory.search", "embeddings.search"],
    constraints: {
      allowedRepairScope:
        "Retune retrieval configuration, rebuild/re-embed the pinned index, or update reviewed eval ground truth through governance before promotion.",
      failedFindingCodes: input.findingCodes
    },
    producedBy: {
      kind: "deterministic",
      ref: "specwright.memory.retrieval-quality-grader@1.0.0"
    }
  });
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
