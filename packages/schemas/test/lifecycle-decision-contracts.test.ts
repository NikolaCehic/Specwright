import { describe, expect, test } from "bun:test";
import {
  ApprovalDecisionSchema,
  DecisionFindingSchema,
  DecisionProducedBySchema,
  DecisionSeveritySchema,
  DecisionStatusSchema,
  EvalFindingSchema,
  EvalProducedBySchema,
  EvalSeveritySchema,
  EvalVerdictContractSchema,
  EvalVerdictSchema,
  GateApprovalRequestSchema,
  GateLifecycleInstructionSchema,
  GateSeveritySchema,
  GateVerdictSchema,
  HumanReviewSchema,
  PolicyVerdictSchema,
  RepairTaskSchema
} from "../src/index";

describe("lifecycle decision contracts", () => {
  test("shares decision primitives across eval and gate contracts", () => {
    expect(DecisionStatusSchema.options).toContain("repaired");
    expect(EvalFindingSchema).toBe(DecisionFindingSchema);
    expect(EvalProducedBySchema).toBe(DecisionProducedBySchema);
    expect(EvalSeveritySchema).toBe(DecisionSeveritySchema);
    expect(GateSeveritySchema).toBe(DecisionSeveritySchema);
  });

  test("validates policy verdicts with matched rules and decision hash", () => {
    const verdict = PolicyVerdictSchema.parse({
      status: "approval_required",
      approvalId: "approval.shell",
      reasons: ["shell.exec requires explicit approval"],
      constraints: [
        {
          kind: "timeoutMs",
          value: 120000,
          sourceRuleId: "tool.shell.exec.default"
        }
      ],
      obligations: [
        {
          kind: "record_event",
          params: {
            eventType: "policy.evaluated"
          },
          sourceRuleId: "tool.shell.exec.default"
        }
      ],
      matchedRules: [
        {
          ruleId: "tool.shell.exec.default",
          layer: "capability",
          effect: "approval_required",
          reason: "shell.exec requires explicit approval"
        }
      ],
      decisionHash: "sha256:policy-decision"
    });

    expect(verdict.matchedRules[0]?.ruleId).toBe("tool.shell.exec.default");
    expect(verdict.decisionHash).toBe("sha256:policy-decision");
  });

  test("validates gate verdicts and lifecycle instructions", () => {
    const verdict = GateVerdictSchema.parse({
      gateId: "artifact_schema",
      phase: "verification",
      status: "fail",
      severity: "blocking",
      reasons: ["Artifact schema validation failed"],
      findings: [
        {
          id: "plan_schema_valid",
          severity: "blocking",
          message: "Artifact schema validation failed",
          targetRef: "artifact:plan",
          evidenceRefs: ["evidence:plan"],
          repairHint: "Add all schema-required fields before promotion."
        }
      ],
      evidenceRefs: ["evidence:plan"],
      requiredAction: "repair",
      obligations: [],
      evaluatedAt: "1970-01-01T00:00:00.000Z",
      evaluator: {
        kind: "deterministic",
        ref: "specwright.gate-engine.v0"
      }
    });
    const instruction = GateLifecycleInstructionSchema.parse({
      kind: "create_repair_task",
      gateId: "artifact_schema",
      repairTask: {
        id: "repair.artifact_schema",
        gateId: "artifact_schema",
        failedPhase: "verification",
        problem: "Artifact schema validation failed",
        requiredEvidenceRefs: ["evidence:plan"],
        allowedTools: ["fs.read"],
        blockedTools: ["shell.exec"],
        successGate: "artifact_schema",
        createdFromFindingIds: ["plan_schema_valid"],
        targetRef: "artifact:plan"
      }
    });

    expect(verdict.evaluator).toEqual({
      kind: "deterministic",
      ref: "specwright.gate-engine.v0"
    });
    expect(instruction.kind).toBe("create_repair_task");
  });

  test("validates eval verdicts, repaired status, repair tasks, and human review", () => {
    expect(
      EvalVerdictContractSchema.parse({
        evalId: "artifact_schema_eval",
        targetRef: "artifact:plan",
        status: "repaired",
        severity: "blocking",
        findings: [],
        evidenceRefs: ["evidence:repair"],
        producedBy: {
          kind: "deterministic",
          ref: "specwright.eval-runner.v0"
        },
        repairTask: {
          task: "Attach accepted repair evidence",
          targetRef: "artifact:plan",
          constraints: {
            gate: "artifact_schema"
          }
        }
      }).status
    ).toBe("repaired");
    expect(EvalVerdictSchema.safeParse({
      evalId: "artifact_schema_eval",
      targetRef: "artifact:plan",
      status: "repaired",
      severity: "blocking",
      findings: [],
      evidenceRefs: ["evidence:repair"],
      producedBy: {
        kind: "deterministic",
        ref: "specwright.eval-runner.v0"
      }
    }).success).toBe(true);
    expect(
      RepairTaskSchema.parse({
        id: "repair.artifact_schema",
        gateId: "artifact_schema",
        failedPhase: "verification",
        problem: "Artifact schema validation failed",
        requiredEvidenceRefs: ["evidence:plan"],
        allowedTools: [],
        blockedTools: [],
        successGate: "artifact_schema",
        createdFromFindingIds: ["plan_schema_valid"]
      }).problem
    ).toBe("Artifact schema validation failed");
    expect(
      HumanReviewSchema.parse({
        id: "question.context_sufficiency",
        gateId: "context_sufficiency",
        phase: "evidence",
        question: "Confirm the source authority.",
        requiredFor: "gate:context_sufficiency"
      }).requiredFor
    ).toBe("gate:context_sufficiency");
    expect(
      GateApprovalRequestSchema.parse({
        id: "approval.context_sufficiency",
        gateId: "context_sufficiency",
        phase: "evidence",
        reason: "Manual approval is required.",
        requiredFor: "gate:context_sufficiency"
      }).id
    ).toBe("approval.context_sufficiency");
  });

  test("rejects invalid decision contracts fail-closed", () => {
    expect(
      PolicyVerdictSchema.safeParse({
        status: "maybe",
        reasons: [],
        constraints: [],
        obligations: [],
        matchedRules: [],
        decisionHash: "sha256:policy-decision"
      }).success
    ).toBe(false);
    expect(
      EvalVerdictContractSchema.safeParse({
        evalId: "artifact_schema_eval",
        targetRef: "artifact:plan",
        status: "pass",
        severity: "blocking",
        findings: [],
        evidenceRefs: []
      }).success
    ).toBe(false);
    expect(
      DecisionFindingSchema.safeParse({
        severity: "blocking",
        evidenceRefs: []
      }).success
    ).toBe(false);
  });

  test("approval decisions cannot assert source facts", () => {
    expect(
      ApprovalDecisionSchema.safeParse({
        approvalId: "approval.source_fact",
        decision: "approved",
        metadata: {
          claimLevel: "source_fact"
        }
      }).success
    ).toBe(false);
    expect(
      ApprovalDecisionSchema.parse({
        approvalId: "approval.shell",
        decision: "approved_with_changes",
        constraints: {
          allowCommandPrefix: "bun test"
        }
      }).decision
    ).toBe("approved_with_changes");
  });
});
