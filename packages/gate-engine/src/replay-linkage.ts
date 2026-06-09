import type {
  GateLifecycleInstruction,
  GateRepairTask,
  GateVerdict
} from "@specwright/schemas";

export type PriorFailingGateVerdictRef = {
  eventId?: string | undefined;
  verdict: GateVerdict & { decisionHash: string };
  instruction?: GateLifecycleInstruction | undefined;
  repairTask?: GateRepairTask | undefined;
  causationId?: string | undefined;
};

export type PriorFailingVerdictLink = {
  gateId: string;
  phase: string;
  decisionHash: string;
  findingIds: string[];
  createdFromFindingIds: string[];
  eventId?: string | undefined;
  repairTaskId?: string | undefined;
  successGate?: string | undefined;
  causationId?: string | undefined;
};

export type GateAuditGap = {
  code: "unlinked_reevaluation_pass";
  gateId: string;
  decisionHash: string;
  message: string;
};

export type ReplayLinkageGuardResult = {
  priorFailingVerdict?: PriorFailingVerdictLink | undefined;
  causationId?: string | undefined;
  auditGaps: GateAuditGap[];
};

export type ReplayLinkageInput = {
  verdict: GateVerdict & { decisionHash: string };
  instruction?: GateLifecycleInstruction | undefined;
  priorFailure?: PriorFailingGateVerdictRef | undefined;
  isReevaluation?: boolean | undefined;
  causationId?: string | undefined;
};

export function linkReevaluation(
  input: ReplayLinkageInput
): PriorFailingVerdictLink | undefined {
  if (!input.isReevaluation || input.priorFailure === undefined) {
    return undefined;
  }

  const priorVerdict = input.priorFailure.verdict;

  if (priorVerdict.status !== "fail" || priorVerdict.findings.length === 0) {
    return undefined;
  }

  const repairTask =
    input.priorFailure.repairTask ??
    repairTaskFromInstruction(input.priorFailure.instruction);
  const findingIds = priorVerdict.findings.map((finding) => finding.id);
  const repairFindingIds = repairTask?.createdFromFindingIds ?? [];
  const createdFromFindingIds =
    repairFindingIds.length === 0 ? findingIds : repairFindingIds;
  const causationId = input.causationId ?? input.priorFailure.causationId;

  return {
    gateId: priorVerdict.gateId,
    phase: priorVerdict.phase,
    decisionHash: priorVerdict.decisionHash,
    findingIds,
    createdFromFindingIds,
    ...(input.priorFailure.eventId === undefined
      ? {}
      : { eventId: input.priorFailure.eventId }),
    ...(repairTask === undefined
      ? {}
      : {
          repairTaskId: repairTask.id,
          successGate: repairTask.successGate
        }),
    ...(causationId === undefined ? {} : { causationId })
  };
}

export function assertLinkable(
  input: ReplayLinkageInput
): ReplayLinkageGuardResult {
  const priorFailingVerdict = linkReevaluation(input);
  const auditGaps: GateAuditGap[] = [];
  const causationId = priorFailingVerdict?.causationId ?? input.causationId;

  if (
    input.isReevaluation === true &&
    input.verdict.status === "pass" &&
    priorFailingVerdict === undefined
  ) {
    auditGaps.push({
      code: "unlinked_reevaluation_pass",
      gateId: input.verdict.gateId,
      decisionHash: input.verdict.decisionHash,
      message: `Re-evaluation pass for gate ${input.verdict.gateId} lacks a linkable prior failing verdict`
    });
  }

  return {
    ...(priorFailingVerdict === undefined ? {} : { priorFailingVerdict }),
    ...(causationId === undefined ? {} : { causationId }),
    auditGaps
  };
}

function repairTaskFromInstruction(
  instruction: GateLifecycleInstruction | undefined
): GateRepairTask | undefined {
  return instruction?.kind === "create_repair_task"
    ? instruction.repairTask
    : undefined;
}
