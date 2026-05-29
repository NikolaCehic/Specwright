import { z } from "zod";
import type { ZodTypeAny } from "zod";

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

export const EvalVerdictStatusSchema = z.enum([
  "pass",
  "fail",
  "needs_review",
  "skipped"
]);
export type EvalVerdictStatus = z.infer<typeof EvalVerdictStatusSchema>;

export const EvalSeveritySchema = z.enum(["advisory", "blocking"]);
export type EvalSeverity = z.infer<typeof EvalSeveritySchema>;

export const ApprovalDecisionValueSchema = z.enum([
  "approved",
  "rejected",
  "approved_with_changes"
]);
export type ApprovalDecisionValue = z.infer<
  typeof ApprovalDecisionValueSchema
>;

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
    metadata: MetadataSchema.optional()
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const HumanQuestionSchema = z
  .object({
    questionId: nonEmptyString,
    prompt: nonEmptyString,
    metadata: MetadataSchema.optional()
  })
  .strict();
export type HumanQuestion = z.infer<typeof HumanQuestionSchema>;

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

const RuntimeEventEnvelopeSchema = z
  .object({
    id: nonEmptyString,
    runId: nonEmptyString,
    type: nonEmptyString,
    timestamp: z.string().datetime({ offset: true }),
    sequence: z.number().int().nonnegative(),
    traceId: nonEmptyString,
    causationId: nonEmptyString.optional(),
    correlationId: nonEmptyString.optional(),
    payload: z.unknown()
  })
  .strict();

export const RuntimeEventSchema = RuntimeEventEnvelopeSchema;

export function runtimeEventSchema<TPayloadSchema extends ZodTypeAny>(
  payloadSchema: TPayloadSchema
) {
  return RuntimeEventEnvelopeSchema.extend({
    payload: payloadSchema
  });
}

type RuntimeEventEnvelope = z.infer<typeof RuntimeEventSchema>;

export type RuntimeEvent<TPayload = unknown> = Omit<
  RuntimeEventEnvelope,
  "payload"
> & {
  payload: TPayload;
};

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

export const SourceRefSchema = z.union([
  nonEmptyString,
  z
    .object({
      id: nonEmptyString.optional(),
      uri: nonEmptyString.optional(),
      path: nonEmptyString.optional(),
      locator: nonEmptyString.optional(),
      contentHash: nonEmptyString.optional(),
      metadata: MetadataSchema.optional()
    })
    .passthrough()
]);
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
    metadata: MetadataSchema.optional()
  })
  .strict();
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
    metadata: MetadataSchema.optional()
  })
  .strict();
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
  });
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const EvalFindingSchema = z
  .object({
    message: nonEmptyString,
    code: nonEmptyString.optional(),
    targetRef: nonEmptyString.optional(),
    path: nonEmptyString.optional(),
    severity: EvalSeveritySchema.optional(),
    evidenceRefs: z.array(nonEmptyString).optional(),
    repairHint: nonEmptyString.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();
export type EvalFinding = z.infer<typeof EvalFindingSchema>;

export const EvalProducedBySchema = z
  .object({
    kind: z.enum(["deterministic", "model_assisted", "human"]),
    ref: nonEmptyString
  })
  .strict();
export type EvalProducedBy = z.infer<typeof EvalProducedBySchema>;

export const RepairTaskSchema = z
  .object({
    task: nonEmptyString,
    targetRef: nonEmptyString.optional(),
    constraints: MetadataSchema.optional()
  })
  .strict();
export type RepairTask = z.infer<typeof RepairTaskSchema>;

export const EvalVerdictSchema = z
  .object({
    evalId: nonEmptyString,
    targetRef: nonEmptyString,
    status: EvalVerdictStatusSchema,
    severity: EvalSeveritySchema,
    findings: z.array(EvalFindingSchema),
    evidenceRefs: z.array(nonEmptyString),
    producedBy: EvalProducedBySchema,
    repairTask: RepairTaskSchema.optional()
  })
  .strict();
export type EvalVerdict = z.infer<typeof EvalVerdictSchema>;

export const ApprovalDecisionSchema = z
  .object({
    approvalId: nonEmptyString,
    decision: ApprovalDecisionValueSchema,
    humanMessage: nonEmptyString.optional(),
    constraints: MetadataSchema.optional()
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
