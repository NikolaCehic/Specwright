import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { RUNTIME_EVENT_SCHEMA_HASHES } from "./generated/event-hashes";

const nonEmptyString = z.string().min(1);

export const MetadataSchema = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof MetadataSchema>;

export const HostKindSchema = z.enum([
  "codex",
  "claude-code",
  "gemini-cli",
  "opencode",
  "cli",
  "mcp"
]);
export type HostKind = z.infer<typeof HostKindSchema>;

export const RunStatusSchema = z.enum([
  "running",
  "paused",
  "blocked",
  "completed",
  "failed"
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ToolCallStatusSchema = z.enum([
  "success",
  "denied",
  "approval_required",
  "failed"
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const CacheStatusSchema = z.enum(["hit", "miss", "bypass"]);
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

export const ClaimLevelSchema = z.enum([
  "source_fact",
  "derived_fact",
  "inference",
  "assumption",
  "human_decision",
  "unknown"
]);
export type ClaimLevel = z.infer<typeof ClaimLevelSchema>;

export const EvidenceClassSchema = z.enum([
  "source_fact",
  "derived_fact",
  "inference",
  "assumption",
  "human_decision",
  "unknown",
  "conflict"
]);
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

export const EvidenceConfidenceSchema = z.enum(["low", "medium", "high"]);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;

export const SourceAuthoritySchema = z.enum([
  "user",
  "repo",
  "design",
  "external",
  "model",
  "generated"
]);
export type SourceAuthority = z.infer<typeof SourceAuthoritySchema>;

export const RedactionClassSchema = z.enum([
  "model",
  "adapter",
  "operator",
  "audit",
  "restricted",
  "secret"
]);
export type RedactionClass = z.infer<typeof RedactionClassSchema>;

const redactionClassOrder = {
  model: 0,
  adapter: 1,
  operator: 2,
  audit: 3,
  restricted: 4,
  secret: 5
} satisfies Record<RedactionClass, number>;

export function redactionClassRank(redactionClass: RedactionClass) {
  return redactionClassOrder[redactionClass];
}

export function redactionClassAtLeast(
  candidate: RedactionClass,
  minimum: RedactionClass
) {
  return redactionClassRank(candidate) >= redactionClassRank(minimum);
}

export const isRedactionAtLeast = redactionClassAtLeast;

export function claimLevelRequiresEvidence(level: ClaimLevel) {
  switch (level) {
    case "source_fact":
    case "derived_fact":
    case "inference":
    case "human_decision":
      return true;
    case "assumption":
    case "unknown":
      return false;
    default:
      assertNever(level);
  }
}

export function evidenceClassRequiresSourceRefs(evidenceClass: EvidenceClass) {
  switch (evidenceClass) {
    case "source_fact":
    case "derived_fact":
      return true;
    case "inference":
    case "assumption":
    case "human_decision":
    case "unknown":
    case "conflict":
      return false;
    default:
      assertNever(evidenceClass);
  }
}

export function isTrustedSourceAuthority(authority: SourceAuthority) {
  switch (authority) {
    case "user":
    case "repo":
    case "design":
    case "external":
      return true;
    case "model":
    case "generated":
      return false;
    default:
      assertNever(authority);
  }
}

export const DecisionStatusSchema = z.enum([
  "allow",
  "deny",
  "approval_required",
  "pass",
  "fail",
  "needs_review",
  "skipped",
  "repaired"
]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const EvalVerdictStatusSchema = z.enum([
  "pass",
  "fail",
  "needs_review",
  "skipped",
  "repaired"
]);
export type EvalVerdictStatus = z.infer<typeof EvalVerdictStatusSchema>;

export const DecisionSeveritySchema = z.enum(["advisory", "blocking"]);
export type DecisionSeverity = z.infer<typeof DecisionSeveritySchema>;

export const EvalSeveritySchema = DecisionSeveritySchema;
export type EvalSeverity = z.infer<typeof EvalSeveritySchema>;

export const ApprovalDecisionValueSchema = z.enum([
  "approved",
  "rejected",
  "approved_with_changes"
]);
export type ApprovalDecisionValue = z.infer<
  typeof ApprovalDecisionValueSchema
>;

export const DecisionEvidenceRefsSchema = z.array(nonEmptyString);
export type DecisionEvidenceRefs = z.infer<typeof DecisionEvidenceRefsSchema>;

export const DecisionProducedBySchema = z
  .object({
    kind: z.enum(["deterministic", "model_assisted", "human"]),
    ref: nonEmptyString
  })
  .strict();
export type DecisionProducedBy = z.infer<typeof DecisionProducedBySchema>;

export const DecisionProvenanceSchema = z
  .object({
    runId: nonEmptyString.optional(),
    phase: nonEmptyString.optional(),
    evaluatedAt: z.string().datetime({ offset: true }).optional(),
    decisionHash: nonEmptyString.optional(),
    causationIds: z.array(nonEmptyString).optional(),
    traceId: nonEmptyString.optional()
  })
  .strict();
export type DecisionProvenance = z.infer<typeof DecisionProvenanceSchema>;

export const DecisionFindingSchema = z
  .object({
    id: nonEmptyString.optional(),
    code: nonEmptyString.optional(),
    message: nonEmptyString,
    severity: DecisionSeveritySchema.optional(),
    targetRef: nonEmptyString.optional(),
    evidenceRefs: DecisionEvidenceRefsSchema.optional(),
    repairHint: nonEmptyString.optional(),
    path: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type DecisionFinding = z.infer<typeof DecisionFindingSchema>;

export const DecisionConstraintSchema = z
  .object({
    kind: nonEmptyString,
    value: z.unknown(),
    sourceRuleId: nonEmptyString.optional()
  })
  .strict();
export type DecisionConstraint = z.infer<typeof DecisionConstraintSchema>;

export const DecisionObligationSchema = z
  .object({
    kind: nonEmptyString,
    params: MetadataSchema.optional(),
    sourceRuleId: nonEmptyString.optional()
  })
  .strict();
export type DecisionObligation = z.infer<typeof DecisionObligationSchema>;

export const PolicyVerdictStatusSchema = z.enum([
  "allow",
  "deny",
  "approval_required"
]);
export type PolicyVerdictStatus = z.infer<typeof PolicyVerdictStatusSchema>;

export const PolicyRuleLayerSchema = z.enum([
  "runtime_invariant",
  "host",
  "workspace",
  "harness",
  "phase",
  "capability",
  "run_mode",
  "approval"
]);
export type PolicyRuleLayer = z.infer<typeof PolicyRuleLayerSchema>;

export const PolicyRuleEffectSchema = z.enum([
  "allow",
  "deny",
  "approval_required",
  "constrain",
  "obligate"
]);
export type PolicyRuleEffect = z.infer<typeof PolicyRuleEffectSchema>;

const PolicyRiskSchema = z.enum(["low", "medium", "high", "critical"]);

export const PolicyRuleMatchSchema = z
  .object({
    ruleId: nonEmptyString,
    layer: PolicyRuleLayerSchema,
    effect: PolicyRuleEffectSchema,
    reason: nonEmptyString
  })
  .strict();
export type PolicyRuleMatch = z.infer<typeof PolicyRuleMatchSchema>;

export const PolicyConstraintSchema = DecisionConstraintSchema.extend({
  sourceRuleId: nonEmptyString
});
export type PolicyConstraint = z.infer<typeof PolicyConstraintSchema>;

export const PolicyObligationSchema = DecisionObligationSchema.extend({
  kind: z.enum([
    "record_event",
    "redact",
    "stage_write",
    "run_eval",
    "require_evidence",
    "attach_trace",
    "mark_external_source",
    "request_human_review"
  ]),
  sourceRuleId: nonEmptyString
});
export type PolicyObligation = z.infer<typeof PolicyObligationSchema>;

export const PolicyVerdictSchema = z
  .object({
    status: PolicyVerdictStatusSchema,
    approvalId: nonEmptyString.optional(),
    reasons: z.array(nonEmptyString),
    constraints: z.array(PolicyConstraintSchema),
    obligations: z.array(PolicyObligationSchema),
    matchedRules: z.array(PolicyRuleMatchSchema),
    decisionHash: nonEmptyString,
    requestHash: nonEmptyString.optional(),
    policyBundleHash: nonEmptyString.optional(),
    resolutionLayerOrder: z.array(PolicyRuleLayerSchema).optional(),
    provenance: DecisionProvenanceSchema.optional()
  })
  .strict();
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>;

export const GateVerdictStatusSchema = z.enum([
  "pass",
  "fail",
  "needs_review"
]);
export type GateVerdictStatus = z.infer<typeof GateVerdictStatusSchema>;

export const GateSeveritySchema = DecisionSeveritySchema;
export type GateSeverity = z.infer<typeof GateSeveritySchema>;

export const GateRequiredActionSchema = z.enum([
  "repair",
  "clarify",
  "approve",
  "fail_run"
]);
export type GateRequiredAction = z.infer<typeof GateRequiredActionSchema>;

export const GateObligationSchema = DecisionObligationSchema.extend({
  kind: z.enum([
    "run_eval",
    "request_clarification",
    "create_repair_task",
    "promote_artifact",
    "attach_evidence",
    "mark_assumption"
  ]),
  sourceRuleId: nonEmptyString.optional()
});
export type GateObligation = z.infer<typeof GateObligationSchema>;

export const GateFindingSchema = DecisionFindingSchema.extend({
  id: nonEmptyString,
  severity: GateSeveritySchema,
  evidenceRefs: DecisionEvidenceRefsSchema
});
export type GateFinding = z.infer<typeof GateFindingSchema>;

export const GateVerdictSchema = z
  .object({
    gateId: nonEmptyString,
    phase: nonEmptyString,
    status: GateVerdictStatusSchema,
    severity: GateSeveritySchema,
    reasons: z.array(nonEmptyString),
    findings: z.array(GateFindingSchema),
    evidenceRefs: DecisionEvidenceRefsSchema,
    requiredAction: GateRequiredActionSchema.optional(),
    obligations: z.array(GateObligationSchema),
    evaluatedAt: z.string().datetime({ offset: true }),
    evaluator: DecisionProducedBySchema,
    decisionHash: nonEmptyString.optional(),
    provenance: DecisionProvenanceSchema.optional()
  })
  .strict();
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

export const AttachmentRefSchema = z
  .object({
    id: nonEmptyString,
    kind: nonEmptyString,
    uri: nonEmptyString.optional(),
    path: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const HarnessSchemaVersionSchema = z.literal("specwright.harness.v0");
export type HarnessSchemaVersion = z.infer<typeof HarnessSchemaVersionSchema>;

export const HarnessReferenceSchema = z.union([
  nonEmptyString,
  z
    .object({
      id: nonEmptyString
    })
    .passthrough()
]);
export type HarnessReference = z.infer<typeof HarnessReferenceSchema>;

export const GateKindSchema = z.enum([
  "entry",
  "exit",
  "action",
  "artifact",
  "eval",
  "repair"
]);
export type GateKind = z.infer<typeof GateKindSchema>;

export const GateCheckTypeSchema = z.enum([
  "deterministic",
  "schema",
  "policy",
  "eval",
  "evidence",
  "model_assisted",
  "human_review"
]);
export type GateCheckType = z.infer<typeof GateCheckTypeSchema>;

const harnessReferenceArray = z.array(HarnessReferenceSchema);

const nextPhaseReferenceSchema = z.union([
  nonEmptyString,
  z.array(nonEmptyString)
]);

export const PhaseDefinitionSchema = z
  .object({
    id: nonEmptyString,
    description: nonEmptyString.optional(),
    gates: harnessReferenceArray.optional(),
    tools: harnessReferenceArray.optional(),
    evals: harnessReferenceArray.optional(),
    artifacts: harnessReferenceArray.optional(),
    artifactSchemas: harnessReferenceArray.optional(),
    next: nextPhaseReferenceSchema.optional(),
    dependsOn: z.array(nonEmptyString).optional(),
    after: z.array(nonEmptyString).optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;

export const GateDefinitionSchema = z
  .object({
    id: nonEmptyString,
    phase: nonEmptyString.optional(),
    kind: GateKindSchema.optional(),
    required: z.boolean().optional(),
    description: nonEmptyString.optional(),
    inputs: MetadataSchema.optional(),
    checks: z.array(z.record(z.string(), z.unknown())).optional(),
    onFail: z.unknown().optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type GateDefinition = z.infer<typeof GateDefinitionSchema>;

export const PolicyBundleSchema = z
  .object({
    id: nonEmptyString,
    schemaVersion: nonEmptyString.optional(),
    description: nonEmptyString.optional(),
    scopes: z.array(nonEmptyString).optional(),
    rules: z.array(z.record(z.string(), z.unknown())).optional(),
    tools: harnessReferenceArray.optional(),
    gates: harnessReferenceArray.optional(),
    evals: harnessReferenceArray.optional(),
    artifactSchemas: harnessReferenceArray.optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;

export const ToolDefinitionSchema = z
  .object({
    id: nonEmptyString,
    version: nonEmptyString.optional(),
    description: nonEmptyString.optional(),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ArtifactSchemaRefSchema = z
  .object({
    id: nonEmptyString,
    version: nonEmptyString,
    path: nonEmptyString,
    schema: z.unknown(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type ArtifactSchemaRef = z.infer<typeof ArtifactSchemaRefSchema>;

export const EvalDefinitionSchema = z
  .object({
    id: nonEmptyString,
    description: nonEmptyString.optional(),
    targetArtifacts: harnessReferenceArray.optional(),
    requiredArtifacts: harnessReferenceArray.optional(),
    artifacts: harnessReferenceArray.optional(),
    artifactSchemas: harnessReferenceArray.optional(),
    gates: harnessReferenceArray.optional(),
    tools: harnessReferenceArray.optional(),
    prompts: harnessReferenceArray.optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type EvalDefinition = z.infer<typeof EvalDefinitionSchema>;

export const RoleDefinitionSchema = z
  .object({
    id: nonEmptyString,
    description: nonEmptyString.optional(),
    prompts: harnessReferenceArray.optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const PromptAssetRefSchema = z
  .object({
    id: nonEmptyString,
    path: nonEmptyString,
    content: z.string(),
    contentHash: nonEmptyString,
    description: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type PromptAssetRef = z.infer<typeof PromptAssetRefSchema>;

export const HarnessManifestToolsSchema = z.union([
  harnessReferenceArray,
  z
    .object({
      allow: z.array(nonEmptyString).optional(),
      requireApproval: z.array(nonEmptyString).optional()
    })
    .passthrough()
]);
export type HarnessManifestTools = z.infer<typeof HarnessManifestToolsSchema>;

export const HarnessManifestSchema = z
  .object({
    id: nonEmptyString,
    version: nonEmptyString,
    schemaVersion: HarnessSchemaVersionSchema,
    runtime: MetadataSchema.optional(),
    phases: harnessReferenceArray.optional(),
    gates: harnessReferenceArray.optional(),
    policies: harnessReferenceArray.optional(),
    tools: HarnessManifestToolsSchema.optional(),
    artifacts: harnessReferenceArray.optional(),
    artifactSchemas: harnessReferenceArray.optional(),
    evals: harnessReferenceArray.optional(),
    roles: harnessReferenceArray.optional(),
    prompts: harnessReferenceArray.optional(),
    initialPhase: nonEmptyString.optional(),
    startPhase: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .passthrough();
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

export const HarnessSnapshotSchema = z
  .object({
    id: nonEmptyString,
    version: nonEmptyString,
    schemaVersion: HarnessSchemaVersionSchema,
    specHash: nonEmptyString,
    loadedAt: z.string().datetime({ offset: true }),
    runtime: MetadataSchema.optional(),
    phases: z.array(PhaseDefinitionSchema),
    gates: z.array(GateDefinitionSchema),
    policies: z.array(PolicyBundleSchema),
    tools: z.array(ToolDefinitionSchema),
    artifacts: z.array(ArtifactSchemaRefSchema),
    evals: z.array(EvalDefinitionSchema),
    roles: z.array(RoleDefinitionSchema),
    prompts: z.array(PromptAssetRefSchema),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type HarnessSnapshot = z.infer<typeof HarnessSnapshotSchema>;

export const BudgetStateSchema = MetadataSchema;
export type BudgetState = z.infer<typeof BudgetStateSchema>;

export const ApprovalRequestSchema = z
  .object({
    approvalId: nonEmptyString,
    reason: nonEmptyString.optional(),
    subjectRef: nonEmptyString.optional(),
    requestedAction: nonEmptyString.optional(),
    riskSummary: nonEmptyString.optional(),
    policyVerdictRef: nonEmptyString.optional(),
    constraints: MetadataSchema.optional(),
    requiredFor: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const HumanQuestionSchema = z
  .object({
    questionId: nonEmptyString,
    prompt: nonEmptyString,
    subjectRef: nonEmptyString.optional(),
    allowedDecisionValues: z.array(nonEmptyString).optional(),
    requiredExpertise: nonEmptyString.optional(),
    requiredFor: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type HumanQuestion = z.infer<typeof HumanQuestionSchema>;

export const HumanReviewSchema = z
  .object({
    id: nonEmptyString,
    gateId: nonEmptyString.optional(),
    phase: nonEmptyString.optional(),
    subjectRef: nonEmptyString.optional(),
    question: nonEmptyString,
    allowedDecisionValues: z.array(nonEmptyString).optional(),
    requiredExpertise: nonEmptyString.optional(),
    requiredFor: nonEmptyString,
    expectedAnswerSchema: nonEmptyString.optional(),
    reviewResult: nonEmptyString.optional(),
    constraints: MetadataSchema.optional(),
    comments: nonEmptyString.optional(),
    unresolvedQuestions: z.array(nonEmptyString).optional(),
    causationIds: z.array(nonEmptyString).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type HumanReview = z.infer<typeof HumanReviewSchema>;

export const GateHumanQuestionSchema = HumanReviewSchema.extend({
  gateId: nonEmptyString,
  phase: nonEmptyString
});
export type GateHumanQuestion = z.infer<typeof GateHumanQuestionSchema>;

export const GateApprovalRequestSchema = z
  .object({
    id: nonEmptyString,
    gateId: nonEmptyString,
    phase: nonEmptyString,
    reason: nonEmptyString,
    requiredFor: nonEmptyString,
    riskSummary: nonEmptyString.optional(),
    constraints: MetadataSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type GateApprovalRequest = z.infer<typeof GateApprovalRequestSchema>;

export const ArtifactRefSchema = z
  .object({
    artifactId: nonEmptyString,
    artifactType: nonEmptyString,
    evidenceRefs: z.array(nonEmptyString).optional(),
    uri: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const RunInputSchema = z
  .object({
    task: nonEmptyString,
    cwd: nonEmptyString.optional(),
    harnessId: nonEmptyString,
    host: z
      .object({
        kind: HostKindSchema,
        version: nonEmptyString.optional()
      })
      .strict(),
    attachments: z.array(AttachmentRefSchema).optional(),
    constraints: MetadataSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type RunInput = z.infer<typeof RunInputSchema>;

export const RunStateSchema = z
  .object({
    runId: nonEmptyString,
    status: RunStatusSchema,
    phase: nonEmptyString,
    harness: z
      .object({
        id: nonEmptyString,
        version: nonEmptyString,
        specHash: nonEmptyString
      })
      .strict(),
    budgets: BudgetStateSchema,
    pendingApprovals: z.array(ApprovalRequestSchema),
    pendingQuestions: z.array(HumanQuestionSchema),
    artifacts: z.array(ArtifactRefSchema),
    lastEventId: nonEmptyString
  })
  .strict();
export type RunState = z.infer<typeof RunStateSchema>;

export const ToolCallRequestSchema = z
  .object({
    toolId: nonEmptyString,
    args: z.unknown(),
    reason: nonEmptyString,
    idempotencyKey: nonEmptyString,
    requestedBy: z
      .object({
        phase: nonEmptyString,
        gateId: nonEmptyString.optional(),
        evalId: nonEmptyString.optional(),
        modelCallId: nonEmptyString.optional()
      })
      .strict()
  })
  .strict();
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export const ToolCallResultSchema = z
  .object({
    toolCallId: nonEmptyString,
    status: ToolCallStatusSchema,
    output: z.unknown().optional(),
    error: z
      .object({
        code: nonEmptyString,
        message: nonEmptyString,
        retryable: z.boolean()
      })
      .strict()
      .optional(),
    provenance: z
      .object({
        toolId: nonEmptyString,
        toolVersion: nonEmptyString,
        argsHash: nonEmptyString,
        resultHash: nonEmptyString.optional(),
        cacheStatus: CacheStatusSchema,
        traceId: nonEmptyString
      })
      .strict()
  })
  .strict();
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

export const ArtifactInputSchema = z
  .object({
    artifactType: nonEmptyString,
    content: z.unknown(),
    evidenceRefs: z.array(nonEmptyString),
    claimLevel: ClaimLevelSchema.optional(),
    producedBy: z
      .object({
        phase: nonEmptyString,
        actionId: nonEmptyString
      })
      .strict()
  })
  .strict();
export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;

const RedactionPolicySchema = z.union([
  RedactionClassSchema,
  z.record(nonEmptyString, RedactionClassSchema)
]);
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>;

const SourceRefObjectSchema = z
  .object({
    id: nonEmptyString.optional(),
    uri: nonEmptyString.optional(),
    path: nonEmptyString.optional(),
    locator: nonEmptyString.optional(),
    contentHash: nonEmptyString.optional(),
    authority: SourceAuthoritySchema,
    captureToolCallId: nonEmptyString.optional(),
    redactionClass: RedactionClassSchema,
    snapshotTimestamp: z.string().datetime({ offset: true }).optional(),
    externalTrustPolicy: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((sourceRef, context) => {
    if (
      sourceRef.id === undefined &&
      sourceRef.uri === undefined &&
      sourceRef.path === undefined &&
      sourceRef.contentHash === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source refs must include id, uri, path, or contentHash"
      });
    }

    if (
      sourceRef.authority === "external" &&
      sourceRef.externalTrustPolicy === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "external source refs must include externalTrustPolicy"
      });
    }
  });

export const SourceRefSchema = z.union([nonEmptyString, SourceRefObjectSchema]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const CreatedBySchema = z
  .object({
    phase: nonEmptyString,
    actionId: nonEmptyString,
    toolCallId: nonEmptyString.optional()
  })
  .strict();
export type CreatedBy = z.infer<typeof CreatedBySchema>;

export const EvidenceRecordSchema = z
  .object({
    id: nonEmptyString,
    class: EvidenceClassSchema,
    claim: nonEmptyString,
    sourceRefs: z.array(SourceRefSchema),
    confidence: EvidenceConfidenceSchema,
    authority: SourceAuthoritySchema,
    createdBy: CreatedBySchema,
    extractionMethod: nonEmptyString.optional(),
    validationStatus: nonEmptyString.optional(),
    referencedArtifactRefs: z.array(nonEmptyString).optional(),
    referencedToolCallIds: z.array(nonEmptyString).optional(),
    redactionPolicy: RedactionPolicySchema,
    conflictGroup: nonEmptyString.optional(),
    unknownReason: nonEmptyString.optional(),
    supersedesEvidenceId: nonEmptyString.optional(),
    supersededByEvidenceId: nonEmptyString.optional(),
    supersessionReason: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((record, context) => {
    if (
      evidenceClassRequiresSourceRefs(record.class) &&
      record.sourceRefs.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${record.class} evidence must include sourceRefs`,
        path: ["sourceRefs"]
      });
    }

    if (record.class === "conflict") {
      if (record.conflictGroup === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "conflict evidence must include conflictGroup",
          path: ["conflictGroup"]
        });
      }

      if (record.sourceRefs.length < 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "conflict evidence must include at least two sourceRefs",
          path: ["sourceRefs"]
        });
      }
    }

    if (record.class === "unknown" && record.unknownReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unknown evidence must include unknownReason",
        path: ["unknownReason"]
      });
    }

    if (
      record.class === "source_fact" &&
      !isTrustedSourceAuthority(record.authority)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_fact evidence cannot use model or generated authority",
        path: ["authority"]
      });
    }

    if (record.class === "source_fact") {
      for (const [index, sourceRef] of record.sourceRefs.entries()) {
        if (!sourceRefCarriesTrustedAuthority(sourceRef)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "source_fact evidence sourceRefs must carry trusted authority",
            path: ["sourceRefs", index]
          });
        }
      }
    }
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const MvpArtifactTypeSchema = z.enum([
  "run-input",
  "source-inventory",
  "evidence-graph",
  "plan",
  "eval-report",
  "summary"
]);
export type MvpArtifactType = z.infer<typeof MvpArtifactTypeSchema>;

export const ArtifactFileRefSchema = z
  .object({
    uri: nonEmptyString,
    path: nonEmptyString.optional(),
    contentType: nonEmptyString.optional(),
    contentHash: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type ArtifactFileRef = z.infer<typeof ArtifactFileRefSchema>;

export const ArtifactProducedBySchema = z
  .object({
    phase: nonEmptyString,
    actionId: nonEmptyString,
    toolCallId: nonEmptyString.optional()
  })
  .strict();
export type ArtifactProducedBy = z.infer<typeof ArtifactProducedBySchema>;

export const ArtifactClaimSchema = z
  .object({
    claim: nonEmptyString,
    claimLevel: ClaimLevelSchema,
    evidenceRefs: z.array(nonEmptyString),
    confidence: EvidenceConfidenceSchema,
    authority: SourceAuthoritySchema,
    owningArtifactId: nonEmptyString,
    fieldPath: nonEmptyString.optional(),
    owningSection: nonEmptyString.optional(),
    verificationStatus: z.enum([
      "unverified",
      "supported",
      "unsupported",
      "conflicted",
      "unknown"
    ]),
    redactionPolicy: RedactionPolicySchema,
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((claim, context) => {
    if (
      claim.fieldPath === undefined &&
      claim.owningSection === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "important claims must include fieldPath or owningSection"
      });
    }

    if (
      claimLevelRequiresEvidence(claim.claimLevel) &&
      claim.evidenceRefs.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${claim.claimLevel} important claims must include evidenceRefs`,
        path: ["evidenceRefs"]
      });
    }

    if (
      claim.claimLevel === "source_fact" &&
      !isTrustedSourceAuthority(claim.authority)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_fact claims cannot use model or generated authority",
        path: ["authority"]
      });
    }
  });
export type ArtifactClaim = z.infer<typeof ArtifactClaimSchema>;

export const ArtifactRecordSchema = z
  .object({
    artifactId: nonEmptyString,
    artifactType: MvpArtifactTypeSchema,
    content: z.unknown().optional(),
    fileRef: ArtifactFileRefSchema.optional(),
    evidenceRefs: z.array(nonEmptyString),
    claimLevel: ClaimLevelSchema.optional(),
    importantClaims: z.array(ArtifactClaimSchema).optional(),
    producedBy: ArtifactProducedBySchema,
    redactionPolicy: RedactionPolicySchema,
    metadata: MetadataSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (record.content === undefined && record.fileRef === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Artifact records must include content or fileRef"
      });
    }

    if (
      record.claimLevel !== undefined &&
      claimLevelRequiresEvidence(record.claimLevel) &&
      record.evidenceRefs.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${record.claimLevel} artifact claims must include evidenceRefs`,
        path: ["evidenceRefs"]
      });
    }

    for (const [index, evidenceRef] of record.evidenceRefs.entries()) {
      if (isSelfCitingEvidenceRef(record, evidenceRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Artifact ${record.artifactId} cannot cite itself as evidence`,
          path: ["evidenceRefs", index]
        });
      }
    }

    for (const [claimIndex, claim] of (
      record.importantClaims ?? []
    ).entries()) {
      if (claim.owningArtifactId !== record.artifactId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "important claims must reference their owning artifact",
          path: ["importantClaims", claimIndex, "owningArtifactId"]
        });
      }

      for (const [evidenceRefIndex, evidenceRef] of claim.evidenceRefs.entries()) {
        if (isSelfCitingEvidenceRef(record, evidenceRef)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Artifact ${record.artifactId} cannot cite itself as evidence`,
            path: [
              "importantClaims",
              claimIndex,
              "evidenceRefs",
              evidenceRefIndex
            ]
          });
        }
      }
    }
  });
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export function isSelfCitingEvidenceRef(
  record: Pick<ArtifactRecord, "artifactId" | "artifactType" | "fileRef">,
  evidenceRef: string
) {
  const selfRefs = [
    record.artifactId,
    `artifact:${record.artifactId}`,
    `artifact:${record.artifactType}`,
    record.fileRef?.uri,
    record.fileRef === undefined ? undefined : `artifact:${record.fileRef.uri}`
  ].filter((value): value is string => value !== undefined);

  return selfRefs.some(
    (selfRef) => evidenceRef === selfRef || evidenceRef.startsWith(`${selfRef}#`)
  );
}

function sourceRefCarriesTrustedAuthority(sourceRef: SourceRef) {
  return (
    typeof sourceRef !== "string" &&
    isTrustedSourceAuthority(sourceRef.authority)
  );
}

export const EvalFindingSchema = DecisionFindingSchema;
export type EvalFinding = z.infer<typeof EvalFindingSchema>;

export const EvalProducedBySchema = DecisionProducedBySchema;
export type EvalProducedBy = z.infer<typeof EvalProducedBySchema>;

export const RepairTaskSchema = z
  .object({
    id: nonEmptyString.optional(),
    repairId: nonEmptyString.optional(),
    task: nonEmptyString.optional(),
    gateId: nonEmptyString.optional(),
    failedPhase: nonEmptyString.optional(),
    targetRef: nonEmptyString.optional(),
    sourceFindingId: nonEmptyString.optional(),
    problem: nonEmptyString.optional(),
    requiredCorrection: nonEmptyString.optional(),
    requiredEvidenceRefs: DecisionEvidenceRefsSchema.optional(),
    allowedTools: z.array(nonEmptyString).optional(),
    blockedTools: z.array(nonEmptyString).optional(),
    allowedRefs: z.array(nonEmptyString).optional(),
    acceptanceChecks: z.array(nonEmptyString).optional(),
    successGate: nonEmptyString.optional(),
    successEval: nonEmptyString.optional(),
    createdFromFindingIds: z.array(nonEmptyString).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    escalationRule: nonEmptyString.optional(),
    producedBy: DecisionProducedBySchema.optional(),
    constraints: MetadataSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((task, context) => {
    if (task.task === undefined && task.problem === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repair tasks require task or problem",
        path: ["task"]
      });
    }
  });
export type RepairTask = z.infer<typeof RepairTaskSchema>;

export const GateRepairTaskSchema = RepairTaskSchema.superRefine(
  (task, context) => {
    const requiredFields = [
      "id",
      "gateId",
      "failedPhase",
      "problem",
      "requiredEvidenceRefs",
      "allowedTools",
      "blockedTools",
      "successGate",
      "createdFromFindingIds"
    ] as const;

    for (const field of requiredFields) {
      if (task[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gate repair tasks require ${field}`,
          path: [field]
        });
      }
    }
  }
);
export type GateRepairTask = z.infer<typeof GateRepairTaskSchema>;

export const EvalVerdictContractSchema = z
  .object({
    evalId: nonEmptyString,
    targetRef: nonEmptyString,
    status: EvalVerdictStatusSchema,
    severity: EvalSeveritySchema,
    findings: z.array(EvalFindingSchema),
    evidenceRefs: z.array(nonEmptyString),
    producedBy: EvalProducedBySchema,
    repairTask: RepairTaskSchema.optional(),
    provenance: DecisionProvenanceSchema.optional()
  })
  .strict();
export type EvalVerdictContract = z.infer<typeof EvalVerdictContractSchema>;
export type EvalVerdict = Omit<EvalVerdictContract, "status"> & {
  status: Exclude<EvalVerdictStatus, "repaired">;
};
export const EvalVerdictSchema = EvalVerdictContractSchema as z.ZodType<
  EvalVerdict,
  z.ZodTypeDef,
  unknown
>;

export const ApprovalDecisionSchema = z
  .object({
    approvalId: nonEmptyString,
    decision: ApprovalDecisionValueSchema,
    humanMessage: nonEmptyString.optional(),
    decidedAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    constraints: MetadataSchema.optional(),
    resultingConstraints: MetadataSchema.optional(),
    causationIds: z.array(nonEmptyString).optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((decision, context) => {
    const metadata = decision.metadata;

    if (
      metadata !== undefined &&
      (metadata.claimLevel === "source_fact" ||
        metadata.authority === "source_fact" ||
        metadata.sourceAuthority === "source_fact")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "approval decisions cannot assert source facts",
        path: ["metadata"]
      });
    }
  });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

const RuntimeEventIntegritySchema = z
  .object({
    algo: nonEmptyString,
    hash: nonEmptyString,
    prevHash: nonEmptyString
  })
  .strict();
export type RuntimeEventIntegrity = z.infer<typeof RuntimeEventIntegritySchema>;

const runtimeEventEnvelopeFields = {
  id: nonEmptyString,
  runId: nonEmptyString,
  timestamp: z.string().datetime({ offset: true }),
  sequence: z.number().int().nonnegative(),
  traceId: nonEmptyString,
  causationId: nonEmptyString.optional(),
  correlationId: nonEmptyString.optional(),
  integrity: RuntimeEventIntegritySchema.optional()
};

const RUNTIME_EVENT_CONTRACT_VERSION = "1";

const runtimeEventSchemaHashes = RUNTIME_EVENT_SCHEMA_HASHES;

export const RuntimeEventContractMetadataSchema = z
  .object({
    contractId: nonEmptyString,
    contractVersion: nonEmptyString,
    schemaHash: nonEmptyString
  })
  .strict();
export type RuntimeEventContractMetadata = z.infer<
  typeof RuntimeEventContractMetadataSchema
>;

export const RunStartedEventPayloadSchema = z
  .object({
    input: RunInputSchema,
    harness: RunStateSchema.shape.harness,
    initialPhase: nonEmptyString,
    budgets: BudgetStateSchema
  })
  .strict();
export type RunStartedEventPayload = z.infer<
  typeof RunStartedEventPayloadSchema
>;

export const HarnessLoadedEventPayloadSchema = z
  .object({
    harness: HarnessSnapshotSchema
  })
  .strict();
export type HarnessLoadedEventPayload = z.infer<
  typeof HarnessLoadedEventPayloadSchema
>;

export const PhaseEnteredEventPayloadSchema = z
  .object({
    phase: nonEmptyString,
    reason: nonEmptyString.optional()
  })
  .strict();
export type PhaseEnteredEventPayload = z.infer<
  typeof PhaseEnteredEventPayloadSchema
>;

export const PhaseTransitionedEventPayloadSchema = z
  .object({
    phase: nonEmptyString.optional(),
    fromPhase: nonEmptyString.optional(),
    toPhase: nonEmptyString.optional(),
    from: nonEmptyString.optional(),
    to: nonEmptyString.optional(),
    reason: nonEmptyString.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.phase === undefined &&
      payload.toPhase === undefined &&
      payload.to === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "phase.transitioned requires phase, toPhase, or to"
      });
    }
  });
export type PhaseTransitionedEventPayload = z.infer<
  typeof PhaseTransitionedEventPayloadSchema
>;

export const EvidenceRecordedEventPayloadSchema = z
  .object({
    evidence: EvidenceRecordSchema
  })
  .strict();
export type EvidenceRecordedEventPayload = z.infer<
  typeof EvidenceRecordedEventPayloadSchema
>;

export const ArtifactRecordedEventPayloadSchema = z
  .object({
    artifact: ArtifactRefSchema
  })
  .strict();
export type ArtifactRecordedEventPayload = z.infer<
  typeof ArtifactRecordedEventPayloadSchema
>;

export const ToolRequestedEventPayloadSchema = z
  .object({
    request: ToolCallRequestSchema
  })
  .strict();
export type ToolRequestedEventPayload = z.infer<
  typeof ToolRequestedEventPayloadSchema
>;

const ToolCallRequestSnapshotSchema = z
  .object({
    toolId: nonEmptyString,
    args: z.unknown().optional(),
    reason: nonEmptyString.optional(),
    idempotencyKey: nonEmptyString.optional(),
    requestedBy: z
      .object({
        phase: nonEmptyString,
        gateId: nonEmptyString.optional(),
        evalId: nonEmptyString.optional(),
        modelCallId: nonEmptyString.optional()
      })
      .strict()
  })
  .strict();

export const ToolCompletedEventPayloadSchema = z
  .object({
    request: ToolCallRequestSnapshotSchema,
    result: ToolCallResultSchema
  })
  .strict();
export type ToolCompletedEventPayload = z.infer<
  typeof ToolCompletedEventPayloadSchema
>;

const PolicyRequestSchema = z
  .object({
    requestId: nonEmptyString,
    runId: nonEmptyString,
    phase: nonEmptyString,
    action: z
      .object({
        kind: nonEmptyString,
        toolId: nonEmptyString.optional(),
        args: MetadataSchema.optional(),
        requestedScopes: z.array(nonEmptyString).optional(),
        risk: z.enum(["low", "medium", "high", "critical"]).optional(),
        budgetCosts: z.record(z.string(), z.number()).optional()
      })
      .strict(),
    runMode: nonEmptyString.optional(),
    snapshots: MetadataSchema.optional()
  })
  .strict();

export const ToolAuthorizedEventPayloadSchema = z
  .object({
    approvalId: nonEmptyString.optional(),
    request: ToolCallRequestSnapshotSchema.optional(),
    policyStatus: PolicyVerdictStatusSchema.optional(),
    policyVerdict: PolicyVerdictSchema.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.approvalId === undefined &&
      payload.request === undefined &&
      payload.policyVerdict === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "tool.authorized requires approvalId, request, or policyVerdict"
      });
    }
  });
export type ToolAuthorizedEventPayload = z.infer<
  typeof ToolAuthorizedEventPayloadSchema
>;

export const ToolDeniedEventPayloadSchema = z
  .object({
    approvalId: nonEmptyString.optional(),
    request: ToolCallRequestSnapshotSchema.optional(),
    result: ToolCallResultSchema.optional(),
    policyStatus: PolicyVerdictStatusSchema.optional(),
    policyVerdict: PolicyVerdictSchema.optional(),
    reason: nonEmptyString.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.approvalId === undefined &&
      payload.request === undefined &&
      payload.result === undefined &&
      payload.policyVerdict === undefined &&
      payload.reason === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "tool.denied requires request/result, approvalId, policyVerdict, or reason"
      });
    }
  });
export type ToolDeniedEventPayload = z.infer<
  typeof ToolDeniedEventPayloadSchema
>;

export const GateLifecycleInstructionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("continue"),
      gateId: nonEmptyString
    })
    .strict(),
  z
    .object({
      kind: z.literal("transition_phase"),
      gateId: nonEmptyString,
      targetPhase: nonEmptyString
    })
    .strict(),
  z
    .object({
      kind: z.literal("pause_for_human"),
      gateId: nonEmptyString,
      question: GateHumanQuestionSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("request_approval"),
      gateId: nonEmptyString,
      approvalRequest: GateApprovalRequestSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_repair_task"),
      gateId: nonEmptyString,
      repairTask: GateRepairTaskSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("fail_run"),
      gateId: nonEmptyString,
      reason: nonEmptyString
    })
    .strict()
]);
export type GateLifecycleInstruction = z.infer<
  typeof GateLifecycleInstructionSchema
>;

export const GateEvaluatedEventPayloadSchema = z
  .object({
    gateId: nonEmptyString,
    verdict: GateVerdictSchema,
    instruction: GateLifecycleInstructionSchema
  })
  .strict();
export type GateEvaluatedEventPayload = z.infer<
  typeof GateEvaluatedEventPayloadSchema
>;

const EvalRunnerInputSchema = z
  .object({
    artifacts: z
      .union([z.record(z.string(), MetadataSchema), z.array(MetadataSchema)])
      .optional(),
    evidence: MetadataSchema.optional()
  })
  .strict();

const RunEvalRequestSchema = z
  .object({
    evalId: nonEmptyString.optional(),
    evalDefinition: EvalDefinitionSchema.optional(),
    evalDefinitions: z
      .union([z.array(EvalDefinitionSchema), z.record(z.string(), EvalDefinitionSchema)])
      .optional(),
    input: EvalRunnerInputSchema.optional(),
    evaluatorRef: nonEmptyString.optional()
  })
  .strict();

export const EvalCompletedEventPayloadSchema = z
  .object({
    evalId: nonEmptyString,
    request: RunEvalRequestSchema.optional(),
    verdict: EvalVerdictSchema
  })
  .strict();
export type EvalCompletedEventPayload = z.infer<
  typeof EvalCompletedEventPayloadSchema
>;

export const RunCompletedEventPayloadSchema = z
  .object({
    reason: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type RunCompletedEventPayload = z.infer<
  typeof RunCompletedEventPayloadSchema
>;

export const RunFailedEventPayloadSchema = z
  .object({
    reason: nonEmptyString,
    errorCode: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type RunFailedEventPayload = z.infer<
  typeof RunFailedEventPayloadSchema
>;

export const POLICY_EVALUATED_EVENT_TYPE = "policy.evaluated";

export const PolicyEvaluatedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    runId: nonEmptyString,
    phase: nonEmptyString,
    actionKind: nonEmptyString,
    toolId: nonEmptyString.optional(),
    risk: PolicyRiskSchema,
    status: PolicyVerdictStatusSchema,
    matchedRules: z.array(PolicyRuleMatchSchema),
    decidingLayer: PolicyRuleLayerSchema,
    constraints: z.array(PolicyConstraintSchema),
    obligations: z.array(PolicyObligationSchema),
    approvalId: nonEmptyString.optional(),
    requestHash: nonEmptyString,
    policyBundleHash: nonEmptyString,
    decisionHash: nonEmptyString,
    argsHash: nonEmptyString,
    bundleSetRef: nonEmptyString,
    bundleVersions: z.array(nonEmptyString)
  })
  .strict();
export type PolicyEvaluatedEventPayload = z.infer<
  typeof PolicyEvaluatedEventPayloadSchema
>;

export const DecisionRecordedEventPayloadSchema = z
  .object({
    approvalId: nonEmptyString,
    decision: ApprovalDecisionSchema.optional(),
    subject: nonEmptyString.optional(),
    reason: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type DecisionRecordedEventPayload = z.infer<
  typeof DecisionRecordedEventPayloadSchema
>;

export const HumanInputRequestedEventPayloadSchema = z
  .object({
    question: HumanQuestionSchema.optional(),
    humanQuestion: HumanQuestionSchema.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.question === undefined && payload.humanQuestion === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human.input_requested requires question or humanQuestion"
      });
    }
  });
export type HumanInputRequestedEventPayload = z.infer<
  typeof HumanInputRequestedEventPayloadSchema
>;

export const HumanAnswerRecordedEventPayloadSchema = z
  .object({
    questionId: nonEmptyString.optional(),
    humanQuestionId: nonEmptyString.optional(),
    answer: z.union([nonEmptyString, MetadataSchema]),
    answeredBy: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.questionId === undefined &&
      payload.humanQuestionId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human.answer_recorded requires questionId or humanQuestionId"
      });
    }
  });
export type HumanAnswerRecordedEventPayload = z.infer<
  typeof HumanAnswerRecordedEventPayloadSchema
>;

export const EVENT_PAYLOAD_SCHEMAS = {
  "artifact.recorded": ArtifactRecordedEventPayloadSchema,
  "decision.recorded": DecisionRecordedEventPayloadSchema,
  "eval.completed": EvalCompletedEventPayloadSchema,
  "evidence.recorded": EvidenceRecordedEventPayloadSchema,
  "gate.evaluated": GateEvaluatedEventPayloadSchema,
  "harness.loaded": HarnessLoadedEventPayloadSchema,
  "human.answer_recorded": HumanAnswerRecordedEventPayloadSchema,
  "human.input_requested": HumanInputRequestedEventPayloadSchema,
  "phase.entered": PhaseEnteredEventPayloadSchema,
  "phase.transitioned": PhaseTransitionedEventPayloadSchema,
  "policy.evaluated": PolicyEvaluatedEventPayloadSchema,
  "run.completed": RunCompletedEventPayloadSchema,
  "run.failed": RunFailedEventPayloadSchema,
  "run.started": RunStartedEventPayloadSchema,
  "tool.authorized": ToolAuthorizedEventPayloadSchema,
  "tool.completed": ToolCompletedEventPayloadSchema,
  "tool.denied": ToolDeniedEventPayloadSchema,
  "tool.requested": ToolRequestedEventPayloadSchema
} as const;
export type EventPayloadSchemas = typeof EVENT_PAYLOAD_SCHEMAS;
export type RuntimeEventType = keyof EventPayloadSchemas;
export type RuntimeEventPayload = {
  [TType in RuntimeEventType]: z.infer<EventPayloadSchemas[TType]>;
}[RuntimeEventType];

export const KNOWN_RUNTIME_EVENT_TYPES = Object.keys(
  EVENT_PAYLOAD_SCHEMAS
) as RuntimeEventType[];

function contractIdForEventType(type: RuntimeEventType) {
  return `specwright.event.${type}`;
}

function eventContractMetadataSchema<TType extends RuntimeEventType>(
  type: TType
) {
  return {
    contractId: z.literal(contractIdForEventType(type)).default(
      contractIdForEventType(type)
    ),
    contractVersion: z
      .literal(RUNTIME_EVENT_CONTRACT_VERSION)
      .default(RUNTIME_EVENT_CONTRACT_VERSION),
    schemaHash: z
      .literal(runtimeEventSchemaHashes[type])
      .default(runtimeEventSchemaHashes[type])
  };
}

function runtimeEventVariantSchema<TType extends RuntimeEventType>(
  type: TType,
  payloadSchema: EventPayloadSchemas[TType]
) {
  return z
    .object({
      ...runtimeEventEnvelopeFields,
      type: z.literal(type),
      ...eventContractMetadataSchema(type),
      payload: payloadSchema
    })
    .strict();
}

export const RuntimeEventEnvelopeSchema = z
  .object({
    ...runtimeEventEnvelopeFields,
    type: nonEmptyString,
    contractId: nonEmptyString.optional(),
    contractVersion: nonEmptyString.optional(),
    schemaHash: nonEmptyString.optional(),
    payload: z.unknown()
  })
  .strict();

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  runtimeEventVariantSchema(
    "artifact.recorded",
    EVENT_PAYLOAD_SCHEMAS["artifact.recorded"]
  ),
  runtimeEventVariantSchema(
    "decision.recorded",
    EVENT_PAYLOAD_SCHEMAS["decision.recorded"]
  ),
  runtimeEventVariantSchema(
    "eval.completed",
    EVENT_PAYLOAD_SCHEMAS["eval.completed"]
  ),
  runtimeEventVariantSchema(
    "evidence.recorded",
    EVENT_PAYLOAD_SCHEMAS["evidence.recorded"]
  ),
  runtimeEventVariantSchema(
    "gate.evaluated",
    EVENT_PAYLOAD_SCHEMAS["gate.evaluated"]
  ),
  runtimeEventVariantSchema(
    "harness.loaded",
    EVENT_PAYLOAD_SCHEMAS["harness.loaded"]
  ),
  runtimeEventVariantSchema(
    "human.answer_recorded",
    EVENT_PAYLOAD_SCHEMAS["human.answer_recorded"]
  ),
  runtimeEventVariantSchema(
    "human.input_requested",
    EVENT_PAYLOAD_SCHEMAS["human.input_requested"]
  ),
  runtimeEventVariantSchema(
    "phase.entered",
    EVENT_PAYLOAD_SCHEMAS["phase.entered"]
  ),
  runtimeEventVariantSchema(
    "phase.transitioned",
    EVENT_PAYLOAD_SCHEMAS["phase.transitioned"]
  ),
  runtimeEventVariantSchema(
    "policy.evaluated",
    EVENT_PAYLOAD_SCHEMAS["policy.evaluated"]
  ),
  runtimeEventVariantSchema(
    "run.completed",
    EVENT_PAYLOAD_SCHEMAS["run.completed"]
  ),
  runtimeEventVariantSchema("run.failed", EVENT_PAYLOAD_SCHEMAS["run.failed"]),
  runtimeEventVariantSchema(
    "run.started",
    EVENT_PAYLOAD_SCHEMAS["run.started"]
  ),
  runtimeEventVariantSchema(
    "tool.authorized",
    EVENT_PAYLOAD_SCHEMAS["tool.authorized"]
  ),
  runtimeEventVariantSchema(
    "tool.completed",
    EVENT_PAYLOAD_SCHEMAS["tool.completed"]
  ),
  runtimeEventVariantSchema("tool.denied", EVENT_PAYLOAD_SCHEMAS["tool.denied"]),
  runtimeEventVariantSchema(
    "tool.requested",
    EVENT_PAYLOAD_SCHEMAS["tool.requested"]
  )
]);

export type RuntimeEventContract = z.infer<typeof RuntimeEventSchema>;
export type RuntimeEvent<TPayload = RuntimeEventPayload> = [RuntimeEventPayload] extends [
  TPayload
]
  ? RuntimeEventContract
  : Omit<z.infer<typeof RuntimeEventEnvelopeSchema>, "payload"> & {
      payload: TPayload;
    };

export type RuntimeEventPayloadByType = {
  [TType in RuntimeEventType]: Extract<
    RuntimeEventContract,
    { type: TType }
  >["payload"];
};

export const RUNTIME_EVENT_CONTRACTS = Object.fromEntries(
  KNOWN_RUNTIME_EVENT_TYPES.map((type) => [
    type,
    {
      contractId: contractIdForEventType(type),
      contractVersion: RUNTIME_EVENT_CONTRACT_VERSION,
      schemaHash: runtimeEventSchemaHashes[type],
      payloadSchema: EVENT_PAYLOAD_SCHEMAS[type]
    }
  ])
) as {
  [TType in RuntimeEventType]: RuntimeEventContractMetadata & {
    payloadSchema: EventPayloadSchemas[TType];
  };
};

export function isRuntimeEventType(type: string): type is RuntimeEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_PAYLOAD_SCHEMAS, type);
}

export function runtimeEventContractForType(type: string) {
  return isRuntimeEventType(type) ? RUNTIME_EVENT_CONTRACTS[type] : undefined;
}

export function runtimeEventSchema<TPayloadSchema extends ZodTypeAny>(
  payloadSchema: TPayloadSchema
) {
  return RuntimeEventEnvelopeSchema.extend({
    payload: payloadSchema
  });
}

export const PolicyEvaluatedEventSchema = runtimeEventSchema(
  PolicyEvaluatedEventPayloadSchema
);

function assertNever(value: never): never {
  throw new Error(`Unhandled contract value: ${String(value)}`);
}
