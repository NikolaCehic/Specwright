import type {
  GateLifecycleInstruction,
  GateRepairTask
} from "@specwright/schemas";

export type GovernedRepairEnvelope = {
  allowedTools?: string[];
  blockedTools?: string[];
};

export type BoundedRepairEnvelopeResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

export function assertBoundedRepairEnvelope(
  governed: GovernedRepairEnvelope | undefined,
  repairTask: Pick<GateRepairTask, "gateId" | "allowedTools" | "blockedTools">
): BoundedRepairEnvelopeResult {
  const governedAllowedTools = governed?.allowedTools ?? [];
  const governedBlockedTools = governed?.blockedTools ?? [];
  const repairAllowedTools = repairTask.allowedTools ?? [];
  const repairBlockedTools = repairTask.blockedTools ?? [];
  const governedAllowedBlockedCollision = governedAllowedTools.filter((tool) =>
    governedBlockedTools.includes(tool)
  );
  const widenedAllowedTools = repairAllowedTools.filter(
    (tool) => !governedAllowedTools.includes(tool)
  );
  const droppedBlockedTools = governedBlockedTools.filter(
    (tool) => !repairBlockedTools.includes(tool)
  );
  const allowedBlockedCollision = repairAllowedTools.filter((tool) =>
    repairBlockedTools.includes(tool)
  );

  if (governedAllowedBlockedCollision.length > 0) {
    return {
      ok: false,
      reason: `Repair task for gate ${
        repairTask.gateId ?? "unknown"
      } cannot be emitted because its governed tool envelope is internally contradictory`
    };
  }

  if (widenedAllowedTools.length > 0) {
    return {
      ok: false,
      reason: `Repair task for gate ${
        repairTask.gateId ?? "unknown"
      } exceeded its governed allowed tool envelope`
    };
  }

  if (droppedBlockedTools.length > 0) {
    return {
      ok: false,
      reason: `Repair task for gate ${
        repairTask.gateId ?? "unknown"
      } dropped blocked tools from its governed envelope`
    };
  }

  if (allowedBlockedCollision.length > 0) {
    return {
      ok: false,
      reason: `Repair task for gate ${
        repairTask.gateId ?? "unknown"
      } produced an internally contradictory tool envelope`
    };
  }

  return { ok: true };
}

export function repairInstructionForBoundedEnvelope(input: {
  gateId: string;
  governed: GovernedRepairEnvelope | undefined;
  repairTask: GateRepairTask;
}): GateLifecycleInstruction {
  const boundedRepair = assertBoundedRepairEnvelope(
    input.governed,
    input.repairTask
  );

  if (!boundedRepair.ok) {
    return {
      kind: "fail_run",
      gateId: input.gateId,
      reason: boundedRepair.reason
    };
  }

  return {
    kind: "create_repair_task",
    gateId: input.gateId,
    repairTask: input.repairTask
  };
}
