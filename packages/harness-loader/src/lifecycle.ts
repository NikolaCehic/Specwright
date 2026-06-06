import { z } from "zod";
import { HarnessLoaderError } from "./errors";
import type { TrustVerdict } from "./trust";

const nonEmptyString = z.string().min(1);
const isoDateTimeString = z.string().datetime({ offset: true });

export const RegistryLifecycleStateSchema = z.enum([
  "candidate",
  "trusted",
  "deprecated",
  "quarantined",
  "revoked"
]);
export type RegistryLifecycleState = z.infer<typeof RegistryLifecycleStateSchema>;

export const PromotionApprovalSchema = z
  .object({
    approvalId: nonEmptyString,
    approvedBy: nonEmptyString,
    approvedAt: isoDateTimeString,
    decision: z.literal("approved"),
    reviewRef: nonEmptyString.optional()
  })
  .strict();
export type PromotionApproval = z.infer<typeof PromotionApprovalSchema>;

export type DryRunValidationEvidence = {
  status: "passed";
  specHash: string;
  validatedAt: string;
};

export type LifecycleTransitionEvidence = {
  dryRunValidation?: DryRunValidationEvidence | undefined;
  trust?: TrustVerdict | undefined;
  approval?: PromotionApproval | undefined;
  reason?: string | undefined;
};

export function assertLifecycleTransition(input: {
  from: RegistryLifecycleState;
  to: RegistryLifecycleState;
  evidence?: LifecycleTransitionEvidence | undefined;
}) {
  if (input.from === input.to) {
    return;
  }

  if (input.to === "quarantined" || input.to === "revoked") {
    return;
  }

  if (input.from === "trusted" && input.to === "deprecated") {
    return;
  }

  if (input.from === "candidate" && input.to === "trusted") {
    assertPromotionEvidence(input.evidence);
    return;
  }

  throwInvalidTransition(input.from, input.to);
}

function assertPromotionEvidence(
  evidence: LifecycleTransitionEvidence | undefined
) {
  if (evidence?.dryRunValidation?.status !== "passed") {
    throw new HarnessLoaderError(
      "promotion_unapproved",
      "Candidate promotion requires successful dry-run validation",
      undefined,
      {
        reason: "missing_dry_run_validation"
      }
    );
  }

  if (evidence.trust?.status !== "verified") {
    throw new HarnessLoaderError(
      "promotion_unapproved",
      "Candidate promotion requires verified publisher trust",
      undefined,
      {
        reason: "missing_trust_verification"
      }
    );
  }

  const approval = PromotionApprovalSchema.safeParse(evidence.approval);

  if (!approval.success) {
    throw new HarnessLoaderError(
      "promotion_unapproved",
      "Candidate promotion requires recorded promotion approval",
      approval.error,
      {
        reason: "missing_recorded_approval"
      }
    );
  }
}

function throwInvalidTransition(
  from: RegistryLifecycleState,
  to: RegistryLifecycleState
): never {
  throw new HarnessLoaderError(
    "invalid_lifecycle_transition",
    `Invalid harness registry lifecycle transition ${from} -> ${to}`,
    undefined,
    {
      reason: "transition_not_allowed",
      details: {
        from,
        to
      }
    }
  );
}
