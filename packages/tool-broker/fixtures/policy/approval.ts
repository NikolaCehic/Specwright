import type { FixturePolicyBundle } from "@specwright/policy-engine";
import type { ApprovalDecision } from "@specwright/schemas";

export const TOOL_BROKER_APPROVAL_ID =
  "approval.fixture.fs_read_sensitive_file";

export const toolBrokerAllowPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.readonly",
  description: "Allows read-only filesystem tools in evidence.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fs.list": {
      default: "allow",
      risk: "low",
      reason: "fs.list is allowed for broker fixture reads",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    },
    "fs.read": {
      default: "allow",
      risk: "low",
      reason: "fs.read is allowed for broker fixture reads",
      allowedPhases: ["source_discovery", "evidence", "verification"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"],
      constraints: [
        {
          kind: "maxBytes",
          value: 64
        }
      ]
    }
  }
};

export const toolBrokerDenyReadPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.deny-read",
  description: "Denies fs.read for policy denial coverage.",
  toolPolicy: {
    "fs.read": {
      default: "deny",
      risk: "low",
      reason: "Fixture denies fs.read",
      allowedPhases: ["evidence"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    }
  }
};

export const toolBrokerApprovalRequiredPolicyBundle: FixturePolicyBundle = {
  id: "fixture.tool-broker.approval-required",
  description: "Requires human approval for fs.read fixture calls.",
  scopes: ["workspace:read"],
  toolPolicy: {
    "fs.read": {
      default: "approval_required",
      risk: "low",
      reason: "Fixture requires human approval for fs.read",
      approvalId: TOOL_BROKER_APPROVAL_ID,
      allowedPhases: ["evidence"],
      requiredScopes: ["workspace:read"],
      allowedScopes: ["workspace:read"]
    }
  }
};

export const toolBrokerMatchingApprovalDecision: ApprovalDecision = {
  approvalId: TOOL_BROKER_APPROVAL_ID,
  decision: "approved",
  humanMessage: "Approved for the fixture read.",
  decidedAt: "2026-06-01T00:00:00.000Z"
};

export const toolBrokerApprovedWithChangesDecision: ApprovalDecision = {
  approvalId: TOOL_BROKER_APPROVAL_ID,
  decision: "approved_with_changes",
  humanMessage: "Approved with fixture constraints.",
  decidedAt: "2026-06-01T00:00:00.000Z",
  constraints: {
    maxBytes: 32
  }
};

export const toolBrokerMismatchedApprovalDecision: ApprovalDecision = {
  approvalId: "approval.fixture.unrelated",
  decision: "approved",
  humanMessage: "Approved for a different approval request.",
  decidedAt: "2026-06-01T00:00:00.000Z"
};

export const toolBrokerRejectedApprovalDecision: ApprovalDecision = {
  approvalId: TOOL_BROKER_APPROVAL_ID,
  decision: "rejected",
  humanMessage: "Rejected for the fixture read.",
  decidedAt: "2026-06-01T00:00:00.000Z"
};

export const toolBrokerElapsedApprovalDeadlineAt =
  "2000-01-01T00:00:00.000Z";
