# Shared Schemas Contract Inventory

Inventory for Scope 01, Packet 01. Source is `packages/schemas/src/index.ts`; the packet seed table was treated as a hypothesis.

Vault pages used:

- `/Users/nikolacehic/Desktop/Specwright-Wiki/02-Scopes/01-Shared-Schemas/00-Contract-Layer-Index.md`
- `/Users/nikolacehic/Desktop/Specwright-Wiki/02-Scopes/01-Shared-Schemas/01-Boundary-And-Ownership.md`
- `/Users/nikolacehic/Desktop/Specwright-Wiki/02-Scopes/01-Shared-Schemas/02-Contract-Domain-Model.md`
- `/Users/nikolacehic/Desktop/Specwright-Wiki/09-Roadmap/Build-Packets/01-01-Contract-Inventory-And-Taxonomy.md`

## Taxonomy Legend

Primary families: `identity`, `lifecycle`, `event`, `harness`, `capability`, `governance`, `verification`, `evidence`, `artifact`, `observability`, `adapter`, `compatibility`.

Durability values:

- `durable`: may be persisted, replayed, audited, or included in a durable contract.
- `derived`: rebuildable projection from durable authority.
- `transient`: request/helper shape used in memory or at an ingress boundary.
- `embedded`: primitive whose durability follows the enclosing contract.

Unknown-field posture is recorded under extension points. `metadata` means the declared metadata field is the extension point. `passthrough` means unknown object keys are currently accepted. `strict` means unknown object keys are rejected. `none` means no declared extension point.

## Classified Export Inventory

<!-- contracts-inventory:start -->
| Export | Kind | Primary family | Secondary family | Public/internal | Owning scope | Durable? | Extension points | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MetadataSchema` | schema | compatibility | observability | public | 01 Shared Schemas | embedded | arbitrary string keys | Shared metadata extension primitive. |
| `Metadata` | type | compatibility | observability | public | 01 Shared Schemas | embedded | same as schema | Inferred type for `MetadataSchema`. |
| `HostKindSchema` | enum | adapter | none | public | 08 CLI Adapter / 09 MCP Adapter | durable | none | Host identifier used by run input. |
| `HostKind` | type | adapter | none | public | 08 CLI Adapter / 09 MCP Adapter | durable | same as schema | Inferred type for `HostKindSchema`. |
| `RunStatusSchema` | enum | lifecycle | none | public | 02 Run Store | durable | none | Run progression status. |
| `RunStatus` | type | lifecycle | none | public | 02 Run Store | durable | same as schema | Inferred type for `RunStatusSchema`. |
| `ToolCallStatusSchema` | enum | capability | none | public | 06 Tool Broker | durable | none | Tool result status. |
| `ToolCallStatus` | type | capability | none | public | 06 Tool Broker | durable | same as schema | Inferred type for `ToolCallStatusSchema`. |
| `CacheStatusSchema` | enum | capability | observability | public | 06 Tool Broker / 11 Trace Recorder | durable | none | Cache status in tool provenance and trace metadata. |
| `CacheStatus` | type | capability | observability | public | 06 Tool Broker / 11 Trace Recorder | durable | same as schema | Inferred type for `CacheStatusSchema`. |
| `ClaimLevelSchema` | enum | evidence | artifact | public | 07 Evidence / Artifact Store | durable | none | Claim authority level. |
| `ClaimLevel` | type | evidence | artifact | public | 07 Evidence / Artifact Store | durable | same as schema | Inferred type for `ClaimLevelSchema`. |
| `EvidenceClassSchema` | enum | evidence | none | public | 07 Evidence Store | durable | none | Evidence record class. |
| `EvidenceClass` | type | evidence | none | public | 07 Evidence Store | durable | same as schema | Inferred type for `EvidenceClassSchema`. |
| `EvidenceConfidenceSchema` | enum | evidence | artifact | public | 07 Evidence Store | durable | none | Evidence and artifact claim confidence. |
| `EvidenceConfidence` | type | evidence | artifact | public | 07 Evidence Store | durable | same as schema | Inferred type for `EvidenceConfidenceSchema`. |
| `SourceAuthoritySchema` | enum | evidence | governance | public | 07 Evidence Store | durable | none | Authority carried by source-backed claims. |
| `SourceAuthority` | type | evidence | governance | public | 07 Evidence Store | durable | same as schema | Inferred type for `SourceAuthoritySchema`. |
| `RedactionClassSchema` | enum | evidence | governance | public | 01 Shared Schemas | durable | none | Visibility class for artifact/evidence trust labels. |
| `RedactionClass` | type | evidence | governance | public | 01 Shared Schemas | durable | same as schema | Inferred type for `RedactionClassSchema`. |
| `redactionClassRank` | function | evidence | governance | public | 01 Shared Schemas | transient | none | Deterministic ordering helper for redaction classes. |
| `redactionClassAtLeast` | function | evidence | governance | public | 01 Shared Schemas | transient | none | Compares redaction classes by contract ordering. |
| `isRedactionAtLeast` | const | evidence | governance | public | 01 Shared Schemas | transient | none | Alias for comparing redaction classes by minimum visibility. |
| `claimLevelRequiresEvidence` | function | artifact | evidence | public | 01 Shared Schemas | transient | none | Shared predicate for important-claim evidence requirements. |
| `evidenceClassRequiresSourceRefs` | function | evidence | artifact | public | 01 Shared Schemas | transient | none | Shared predicate for evidence-class source-ref requirements. |
| `isTrustedSourceAuthority` | function | evidence | governance | public | 01 Shared Schemas | transient | none | Shared predicate for source authority trustedness. |
| `EvalVerdictStatusSchema` | enum | verification | lifecycle | public | 07 Eval Runner | durable | none | Eval result status. |
| `EvalVerdictStatus` | type | verification | lifecycle | public | 07 Eval Runner | durable | same as schema | Inferred type for `EvalVerdictStatusSchema`. |
| `EvalSeveritySchema` | enum | verification | lifecycle | public | 07 Eval Runner / 05 Gate Engine | durable | none | Blocking/advisory eval severity. |
| `EvalSeverity` | type | verification | lifecycle | public | 07 Eval Runner / 05 Gate Engine | durable | same as schema | Inferred type for `EvalSeveritySchema`. |
| `ApprovalDecisionValueSchema` | enum | governance | lifecycle | public | 04 Policy Engine / approvals | durable | none | Human approval decision value. |
| `ApprovalDecisionValue` | type | governance | lifecycle | public | 04 Policy Engine / approvals | durable | same as schema | Inferred type for `ApprovalDecisionValueSchema`. |
| `AttachmentRefSchema` | schema | identity | adapter | public | 02 Run Store / 08 CLI Adapter | durable | metadata; strict | Attachment reference on run input. |
| `AttachmentRef` | type | identity | adapter | public | 02 Run Store / 08 CLI Adapter | durable | same as schema | Inferred type for `AttachmentRefSchema`. |
| `HarnessSchemaVersionSchema` | const | compatibility | harness | public | 03 Harness Loader | durable | none | Literal harness schema version. |
| `HarnessSchemaVersion` | type | compatibility | harness | public | 03 Harness Loader | durable | same as schema | Inferred type for `HarnessSchemaVersionSchema`. |
| `HarnessReferenceSchema` | schema | identity | harness | public | 03 Harness Loader | durable | object variant passthrough | Harness reference primitive. |
| `HarnessReference` | type | identity | harness | public | 03 Harness Loader | durable | same as schema | Inferred type for `HarnessReferenceSchema`. |
| `GateKindSchema` | enum | lifecycle | harness | public | 05 Gate Engine / 03 Harness Loader | durable | none | Gate lifecycle role. |
| `GateKind` | type | lifecycle | harness | public | 05 Gate Engine / 03 Harness Loader | durable | same as schema | Inferred type for `GateKindSchema`. |
| `GateCheckTypeSchema` | enum | verification | harness | public | 05 Gate Engine | durable | none | Gate check classification. |
| `GateCheckType` | type | verification | harness | public | 05 Gate Engine | durable | same as schema | Inferred type for `GateCheckTypeSchema`. |
| `PhaseDefinitionSchema` | schema | harness | lifecycle | public | 03 Harness Loader | durable | metadata; passthrough | Declarative phase definition. |
| `PhaseDefinition` | type | harness | lifecycle | public | 03 Harness Loader | durable | same as schema | Inferred type for `PhaseDefinitionSchema`. |
| `GateDefinitionSchema` | schema | harness | verification | public | 05 Gate Engine / 03 Harness Loader | durable | metadata; passthrough | Declarative gate definition. |
| `GateDefinition` | type | harness | verification | public | 05 Gate Engine / 03 Harness Loader | durable | same as schema | Inferred type for `GateDefinitionSchema`. |
| `PolicyBundleSchema` | schema | governance | harness | public | 04 Policy Engine / 03 Harness Loader | durable | metadata; passthrough | Declarative policy bundle. |
| `PolicyBundle` | type | governance | harness | public | 04 Policy Engine / 03 Harness Loader | durable | same as schema | Inferred type for `PolicyBundleSchema`. |
| `ToolDefinitionSchema` | schema | capability | harness | public | 06 Tool Broker / 03 Harness Loader | durable | metadata; passthrough | Declarative tool definition with unknown IO schemas. |
| `ToolDefinition` | type | capability | harness | public | 06 Tool Broker / 03 Harness Loader | durable | same as schema | Inferred type for `ToolDefinitionSchema`. |
| `ArtifactSchemaRefSchema` | schema | artifact | harness | public | Artifact Store / 03 Harness Loader | durable | metadata; passthrough | Harness artifact schema reference. |
| `ArtifactSchemaRef` | type | artifact | harness | public | Artifact Store / 03 Harness Loader | durable | same as schema | Inferred type for `ArtifactSchemaRefSchema`. |
| `EvalDefinitionSchema` | schema | verification | harness | public | 07 Eval Runner / 03 Harness Loader | durable | metadata; passthrough | Declarative eval definition. |
| `EvalDefinition` | type | verification | harness | public | 07 Eval Runner / 03 Harness Loader | durable | same as schema | Inferred type for `EvalDefinitionSchema`. |
| `RoleDefinitionSchema` | schema | harness | none | public | 03 Harness Loader | durable | metadata; passthrough | Declarative role definition. |
| `RoleDefinition` | type | harness | none | public | 03 Harness Loader | durable | same as schema | Inferred type for `RoleDefinitionSchema`. |
| `PromptAssetRefSchema` | schema | harness | artifact | public | 03 Harness Loader | durable | metadata; passthrough | Prompt asset reference and content hash. |
| `PromptAssetRef` | type | harness | artifact | public | 03 Harness Loader | durable | same as schema | Inferred type for `PromptAssetRefSchema`. |
| `HarnessManifestToolsSchema` | schema | capability | harness | public | 03 Harness Loader / 06 Tool Broker | durable | object variant passthrough | Manifest tool allow/approval section. |
| `HarnessManifestTools` | type | capability | harness | public | 03 Harness Loader / 06 Tool Broker | durable | same as schema | Inferred type for `HarnessManifestToolsSchema`. |
| `HarnessManifestSchema` | schema | harness | compatibility | public | 03 Harness Loader | durable | metadata; passthrough | Harness package manifest. |
| `HarnessManifest` | type | harness | compatibility | public | 03 Harness Loader | durable | same as schema | Inferred type for `HarnessManifestSchema`. |
| `HarnessSnapshotSchema` | schema | harness | compatibility | public | 03 Harness Loader | durable | metadata; strict | Loaded harness snapshot with `specHash`. |
| `HarnessSnapshot` | type | harness | compatibility | public | 03 Harness Loader | durable | same as schema | Inferred type for `HarnessSnapshotSchema`. |
| `BudgetStateSchema` | schema | governance | lifecycle | public | 02 Run Store / 04 Policy Engine | derived | arbitrary metadata map | Current budget projection alias. |
| `BudgetState` | type | governance | lifecycle | public | 02 Run Store / 04 Policy Engine | derived | same as schema | Inferred type for `BudgetStateSchema`. |
| `ApprovalRequestSchema` | schema | governance | lifecycle | public | 04 Policy Engine / 05 Gate Engine | derived | metadata; strict | Pending approval request projection. |
| `ApprovalRequest` | type | governance | lifecycle | public | 04 Policy Engine / 05 Gate Engine | derived | same as schema | Inferred type for `ApprovalRequestSchema`. |
| `HumanQuestionSchema` | schema | governance | lifecycle | public | 05 Gate Engine / approvals | derived | metadata; strict | Pending human clarification projection. |
| `HumanQuestion` | type | governance | lifecycle | public | 05 Gate Engine / approvals | derived | same as schema | Inferred type for `HumanQuestionSchema`. |
| `ArtifactRefSchema` | schema | artifact | evidence | public | 02 Run Store / Artifact Store | derived | metadata; strict | Artifact reference in run state and events. |
| `ArtifactRef` | type | artifact | evidence | public | 02 Run Store / Artifact Store | derived | same as schema | Inferred type for `ArtifactRefSchema`. |
| `RunInputSchema` | schema | lifecycle | adapter | public | 02 Run Store / Runtime | durable | metadata; constraints; strict | Runtime run ingress contract. |
| `RunInput` | type | lifecycle | adapter | public | 02 Run Store / Runtime | durable | same as schema | Inferred type for `RunInputSchema`. |
| `RunStateSchema` | schema | lifecycle | event | public | 02 Run Store | derived | strict | Rebuildable state projection. |
| `RunState` | type | lifecycle | event | public | 02 Run Store | derived | same as schema | Inferred type for `RunStateSchema`. |
| `RuntimeEventSchema` | schema | event | observability | public | 02 Run Store | durable | strict typed payload union; metadata defaults | Discriminated runtime event contract family keyed by `type`. |
| `runtimeEventSchema` | function | event | compatibility | public | 01 Shared Schemas / 02 Run Store | transient | caller supplied payload schema | Helper for typed event envelopes. |
| `RuntimeEvent` | type | event | observability | public | 02 Run Store | durable | payload generic | Generic runtime event type. |
| `ToolCallRequestSchema` | schema | capability | governance | public | 06 Tool Broker | durable | strict | Tool invocation request. |
| `ToolCallRequest` | type | capability | governance | public | 06 Tool Broker | durable | same as schema | Inferred type for `ToolCallRequestSchema`. |
| `ToolCallResultSchema` | schema | capability | observability | public | 06 Tool Broker | durable | strict | Tool result with provenance envelope. |
| `ToolCallResult` | type | capability | observability | public | 06 Tool Broker | durable | same as schema | Inferred type for `ToolCallResultSchema`. |
| `ArtifactInputSchema` | schema | artifact | evidence | public | Artifact Store | transient | strict | Artifact write input before durable record. |
| `ArtifactInput` | type | artifact | evidence | public | Artifact Store | transient | same as schema | Inferred type for `ArtifactInputSchema`. |
| `SourceRefSchema` | schema | evidence | identity | public | 07 Evidence Store | durable | object variant metadata; passthrough | Source pointer primitive. |
| `SourceRef` | type | evidence | identity | public | 07 Evidence Store | durable | same as schema | Inferred type for `SourceRefSchema`. |
| `RedactionPolicy` | type | evidence | governance | public | 01 Shared Schemas | durable | same as schema | Inferred type for artifact/evidence redaction policy fields. |
| `CreatedBySchema` | schema | evidence | observability | public | 07 Evidence Store | durable | strict | Evidence producer reference. |
| `CreatedBy` | type | evidence | observability | public | 07 Evidence Store | durable | same as schema | Inferred type for `CreatedBySchema`. |
| `EvidenceRecordSchema` | schema | evidence | observability | public | 07 Evidence Store | durable | metadata; strict | Canonical evidence record. |
| `EvidenceRecord` | type | evidence | observability | public | 07 Evidence Store | durable | same as schema | Inferred type for `EvidenceRecordSchema`. |
| `MvpArtifactTypeSchema` | enum | artifact | compatibility | public | Artifact Store | durable | none | v0 artifact type enum. |
| `MvpArtifactType` | type | artifact | compatibility | public | Artifact Store | durable | same as schema | Inferred type for `MvpArtifactTypeSchema`. |
| `ArtifactFileRefSchema` | schema | artifact | identity | public | Artifact Store | durable | metadata; strict | Artifact file pointer. |
| `ArtifactFileRef` | type | artifact | identity | public | Artifact Store | durable | same as schema | Inferred type for `ArtifactFileRefSchema`. |
| `ArtifactProducedBySchema` | schema | artifact | observability | public | Artifact Store | durable | strict | Artifact producer reference. |
| `ArtifactProducedBy` | type | artifact | observability | public | Artifact Store | durable | same as schema | Inferred type for `ArtifactProducedBySchema`. |
| `ArtifactClaimSchema` | schema | artifact | evidence | public | Artifact Store / 07 Evidence Store | durable | metadata; strict | Source-backed artifact claim. |
| `ArtifactClaim` | type | artifact | evidence | public | Artifact Store / 07 Evidence Store | durable | same as schema | Inferred type for `ArtifactClaimSchema`. |
| `ArtifactRecordSchema` | schema | artifact | evidence | public | Artifact Store | durable | metadata required; strict | Canonical artifact record. |
| `ArtifactRecord` | type | artifact | evidence | public | Artifact Store | durable | same as schema | Inferred type for `ArtifactRecordSchema`. |
| `isSelfCitingEvidenceRef` | function | artifact | evidence | public | 01 Shared Schemas | transient | none | Shared predicate for artifact self-citation checks. |
| `EvalFindingSchema` | schema | verification | evidence | public | 07 Eval Runner | durable | metadata; strict | Eval finding inside verdicts. |
| `EvalFinding` | type | verification | evidence | public | 07 Eval Runner | durable | same as schema | Inferred type for `EvalFindingSchema`. |
| `EvalProducedBySchema` | schema | verification | observability | public | 07 Eval Runner | durable | strict | Eval producer reference. |
| `EvalProducedBy` | type | verification | observability | public | 07 Eval Runner | durable | same as schema | Inferred type for `EvalProducedBySchema`. |
| `RepairTaskSchema` | schema | lifecycle | verification | public | 05 Gate Engine / 07 Eval Runner | durable | constraints; strict | Repair instruction contract. |
| `RepairTask` | type | lifecycle | verification | public | 05 Gate Engine / 07 Eval Runner | durable | same as schema | Inferred type for `RepairTaskSchema`. |
| `EvalVerdictSchema` | schema | verification | lifecycle | public | 07 Eval Runner | durable | strict | Eval verdict and optional repair task. |
| `EvalVerdict` | type | verification | lifecycle | public | 07 Eval Runner | durable | same as schema | Inferred type for `EvalVerdictSchema`. |
| `ApprovalDecisionSchema` | schema | governance | lifecycle | public | 04 Policy Engine / approvals | durable | constraints; strict | Human approval decision. |
| `ApprovalDecision` | type | governance | lifecycle | public | 04 Policy Engine / approvals | durable | same as schema | Inferred type for `ApprovalDecisionSchema`. |
| `RuntimeEventContractMetadataSchema` | schema | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | strict | Event contract id, version, and schema hash metadata. |
| `RuntimeEventContractMetadata` | type | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred type for `RuntimeEventContractMetadataSchema`. |
| `RunStartedEventPayloadSchema` | schema | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `run.started`. |
| `RunStartedEventPayload` | type | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `run.started`. |
| `HarnessLoadedEventPayloadSchema` | schema | event | harness | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `harness.loaded`. |
| `HarnessLoadedEventPayload` | type | event | harness | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `harness.loaded`. |
| `PhaseEnteredEventPayloadSchema` | schema | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `phase.entered`. |
| `PhaseEnteredEventPayload` | type | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `phase.entered`. |
| `PhaseTransitionedEventPayloadSchema` | schema | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `phase.transitioned`. |
| `PhaseTransitionedEventPayload` | type | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `phase.transitioned`. |
| `EvidenceRecordedEventPayloadSchema` | schema | event | evidence | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `evidence.recorded`. |
| `EvidenceRecordedEventPayload` | type | event | evidence | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `evidence.recorded`. |
| `ArtifactRecordedEventPayloadSchema` | schema | event | artifact | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `artifact.recorded`. |
| `ArtifactRecordedEventPayload` | type | event | artifact | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `artifact.recorded`. |
| `ToolRequestedEventPayloadSchema` | schema | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `tool.requested`. |
| `ToolRequestedEventPayload` | type | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `tool.requested`. |
| `ToolCompletedEventPayloadSchema` | schema | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `tool.completed`. |
| `ToolCompletedEventPayload` | type | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `tool.completed`. |
| `ToolAuthorizedEventPayloadSchema` | schema | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `tool.authorized`. |
| `ToolAuthorizedEventPayload` | type | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `tool.authorized`. |
| `ToolDeniedEventPayloadSchema` | schema | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `tool.denied`. |
| `ToolDeniedEventPayload` | type | event | capability | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `tool.denied`. |
| `GateEvaluatedEventPayloadSchema` | schema | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `gate.evaluated`. |
| `GateEvaluatedEventPayload` | type | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `gate.evaluated`. |
| `EvalCompletedEventPayloadSchema` | schema | event | verification | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `eval.completed`. |
| `EvalCompletedEventPayload` | type | event | verification | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `eval.completed`. |
| `RunCompletedEventPayloadSchema` | schema | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `run.completed`. |
| `RunCompletedEventPayload` | type | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `run.completed`. |
| `RunFailedEventPayloadSchema` | schema | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `run.failed`. |
| `RunFailedEventPayload` | type | event | lifecycle | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `run.failed`. |
| `PolicyEvaluatedEventPayloadSchema` | schema | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `policy.evaluated`. |
| `PolicyEvaluatedEventPayload` | type | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `policy.evaluated`. |
| `DecisionRecordedEventPayloadSchema` | schema | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `decision.recorded`. |
| `DecisionRecordedEventPayload` | type | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `decision.recorded`. |
| `HumanInputRequestedEventPayloadSchema` | schema | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `human.input_requested`. |
| `HumanInputRequestedEventPayload` | type | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `human.input_requested`. |
| `HumanAnswerRecordedEventPayloadSchema` | schema | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | strict | Payload contract for `human.answer_recorded`. |
| `HumanAnswerRecordedEventPayload` | type | event | governance | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred payload type for `human.answer_recorded`. |
| `EVENT_PAYLOAD_SCHEMAS` | const | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | registered payload schemas | Deterministic event type to payload schema registry. |
| `EventPayloadSchemas` | type | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | same as const | Type of the event payload schema registry. |
| `RuntimeEventType` | type | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | none | Union of registered runtime event type names. |
| `RuntimeEventPayload` | type | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | same as schemas | Union of registered runtime event payloads. |
| `KNOWN_RUNTIME_EVENT_TYPES` | const | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | none | Deterministic list of registered runtime event types. |
| `RuntimeEventEnvelopeSchema` | schema | event | observability | public | 01 Shared Schemas / 02 Run Store | durable | strict; metadata optional | Runtime event envelope helper with optional compatibility metadata. |
| `RuntimeEventContract` | type | event | observability | public | 01 Shared Schemas / 02 Run Store | durable | same as schema | Inferred discriminated runtime event union. |
| `RuntimeEventPayloadByType` | type | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | same as schemas | Payload lookup type keyed by runtime event type. |
| `RUNTIME_EVENT_CONTRACTS` | const | event | compatibility | public | 01 Shared Schemas / 02 Run Store | durable | registered schemas and metadata | Deterministic event contract registry with id, version, schema hash, and payload schema. |
| `isRuntimeEventType` | function | event | compatibility | public | 01 Shared Schemas / 02 Run Store | transient | registry lookup | Type guard for registered runtime event types. |
| `runtimeEventContractForType` | function | event | compatibility | public | 01 Shared Schemas / 02 Run Store | transient | registry lookup | Returns registered event contract metadata and payload schema by type. |
<!-- contracts-inventory:end -->

## Public Contracts

All 152 current exports are public product contracts or public helper surfaces:

`ApprovalDecision`, `ApprovalDecisionSchema`, `ApprovalDecisionValue`, `ApprovalDecisionValueSchema`, `ApprovalRequest`, `ApprovalRequestSchema`, `ArtifactClaim`, `ArtifactClaimSchema`, `ArtifactFileRef`, `ArtifactFileRefSchema`, `ArtifactInput`, `ArtifactInputSchema`, `ArtifactProducedBy`, `ArtifactProducedBySchema`, `ArtifactRecord`, `ArtifactRecordSchema`, `ArtifactRecordedEventPayload`, `ArtifactRecordedEventPayloadSchema`, `ArtifactRef`, `ArtifactRefSchema`, `ArtifactSchemaRef`, `ArtifactSchemaRefSchema`, `AttachmentRef`, `AttachmentRefSchema`, `BudgetState`, `BudgetStateSchema`, `CacheStatus`, `CacheStatusSchema`, `ClaimLevel`, `ClaimLevelSchema`, `CreatedBy`, `CreatedBySchema`, `DecisionRecordedEventPayload`, `DecisionRecordedEventPayloadSchema`, `EVENT_PAYLOAD_SCHEMAS`, `EvalCompletedEventPayload`, `EvalCompletedEventPayloadSchema`, `EvalDefinition`, `EvalDefinitionSchema`, `EvalFinding`, `EvalFindingSchema`, `EvalProducedBy`, `EvalProducedBySchema`, `EvalSeverity`, `EvalSeveritySchema`, `EvalVerdict`, `EvalVerdictSchema`, `EvalVerdictStatus`, `EvalVerdictStatusSchema`, `EventPayloadSchemas`, `EvidenceClass`, `EvidenceClassSchema`, `EvidenceConfidence`, `EvidenceConfidenceSchema`, `EvidenceRecord`, `EvidenceRecordSchema`, `EvidenceRecordedEventPayload`, `EvidenceRecordedEventPayloadSchema`, `GateCheckType`, `GateCheckTypeSchema`, `GateDefinition`, `GateDefinitionSchema`, `GateEvaluatedEventPayload`, `GateEvaluatedEventPayloadSchema`, `GateKind`, `GateKindSchema`, `HarnessLoadedEventPayload`, `HarnessLoadedEventPayloadSchema`, `HarnessManifest`, `HarnessManifestSchema`, `HarnessManifestTools`, `HarnessManifestToolsSchema`, `HarnessReference`, `HarnessReferenceSchema`, `HarnessSchemaVersion`, `HarnessSchemaVersionSchema`, `HarnessSnapshot`, `HarnessSnapshotSchema`, `HostKind`, `HostKindSchema`, `HumanAnswerRecordedEventPayload`, `HumanAnswerRecordedEventPayloadSchema`, `HumanInputRequestedEventPayload`, `HumanInputRequestedEventPayloadSchema`, `HumanQuestion`, `HumanQuestionSchema`, `KNOWN_RUNTIME_EVENT_TYPES`, `Metadata`, `MetadataSchema`, `MvpArtifactType`, `MvpArtifactTypeSchema`, `PhaseDefinition`, `PhaseDefinitionSchema`, `PhaseEnteredEventPayload`, `PhaseEnteredEventPayloadSchema`, `PhaseTransitionedEventPayload`, `PhaseTransitionedEventPayloadSchema`, `PolicyBundle`, `PolicyBundleSchema`, `PolicyEvaluatedEventPayload`, `PolicyEvaluatedEventPayloadSchema`, `PromptAssetRef`, `PromptAssetRefSchema`, `RUNTIME_EVENT_CONTRACTS`, `RepairTask`, `RepairTaskSchema`, `RoleDefinition`, `RoleDefinitionSchema`, `RunCompletedEventPayload`, `RunCompletedEventPayloadSchema`, `RunFailedEventPayload`, `RunFailedEventPayloadSchema`, `RunInput`, `RunInputSchema`, `RunStartedEventPayload`, `RunStartedEventPayloadSchema`, `RunState`, `RunStateSchema`, `RunStatus`, `RunStatusSchema`, `RuntimeEvent`, `RuntimeEventContract`, `RuntimeEventContractMetadata`, `RuntimeEventContractMetadataSchema`, `RuntimeEventEnvelopeSchema`, `RuntimeEventPayload`, `RuntimeEventPayloadByType`, `RuntimeEventSchema`, `RuntimeEventType`, `SourceAuthority`, `SourceAuthoritySchema`, `SourceRef`, `SourceRefSchema`, `ToolAuthorizedEventPayload`, `ToolAuthorizedEventPayloadSchema`, `ToolCallRequest`, `ToolCallRequestSchema`, `ToolCallResult`, `ToolCallResultSchema`, `ToolCallStatus`, `ToolCallStatusSchema`, `ToolCompletedEventPayload`, `ToolCompletedEventPayloadSchema`, `ToolDefinition`, `ToolDefinitionSchema`, `ToolDeniedEventPayload`, `ToolDeniedEventPayloadSchema`, `ToolRequestedEventPayload`, `ToolRequestedEventPayloadSchema`, `isRuntimeEventType`, `runtimeEventContractForType`, `runtimeEventSchema`.

## Internal Contracts

None of the current exported symbols are marked internal. Package-private helpers such as `nonEmptyString`, `harnessReferenceArray`, and `nextPhaseReferenceSchema` are intentionally not exported and are not part of this inventory.

## Defects And Follow-Up Decisions

### Duplicate Durable Concepts In `packages/schemas`

- `CreatedBySchema` and `ArtifactProducedBySchema` encode the same `phase`, `actionId`, and optional `toolCallId` producer concept separately. The domain model names this shared primitive `ProducedBy`; a later packet should decide whether to unify it.
- `ClaimLevelSchema` and `EvidenceClassSchema` intentionally overlap most values, but only `EvidenceClassSchema` includes `conflict`. Keep the distinction unless artifact claims also need conflict semantics.
- `BudgetStateSchema` is currently an alias of `MetadataSchema`, so a durable lifecycle/governance projection has no domain-specific shape yet.

### Ownerless Exported Contracts

- None found in the current `packages/schemas` export set. Every exported symbol has a primary family and owning scope above.

### Private Duplications Or Missing Shared Contracts In Other Packages

- `packages/gate-engine/src/index.ts:39` defines local `HumanQuestion` with `id`, `gateId`, `phase`, `question`, and `requiredFor`, while `packages/schemas` exports `HumanQuestionSchema` with `questionId`, `prompt`, and `metadata`.
- `packages/gate-engine/src/index.ts:48` defines local `ApprovalRequest` with `id`, `gateId`, `phase`, `reason`, and `requiredFor`, while `packages/schemas` exports `ApprovalRequestSchema` with `approvalId`, optional `reason`, and `metadata`.
- `packages/gate-engine/src/index.ts:56` defines local `RepairTask` with gate-specific fields that diverge from `RepairTaskSchema`.
- `packages/gate-engine/src/index.ts:69` defines local `GateVerdict` and `packages/gate-engine/src/index.ts:86` defines local `GateLifecycleInstruction`; both are lifecycle decision contracts named in the vault but not yet in `packages/schemas`.
- `packages/gate-engine/src/index.ts:144` defines a local `PolicyVerdict` projection even though policy verdicts are governance decision contracts.
- `packages/policy-engine/src/index.ts:48` defines local `PolicyRequest`, and `packages/policy-engine/src/index.ts:92` defines local `PolicyVerdict` plus constraints, obligations, and rule matches. These are deterministic governance contracts named in the vault but not yet in `packages/schemas`.
- `packages/run-store/src/index.ts:79` still defines a local `RunStartedPayload` compatibility type, while typed runtime event payload authority now lives in `packages/schemas` as of Packet 01-02.
- `packages/trace-recorder/src/index.ts:44` defines `TraceSpan`, and `packages/trace-recorder/src/index.ts:59` defines `TraceFile`. These are durable observability records but are not yet shared schema contracts.
- `packages/eval-runner/src/index.ts:22` defines `EvalRunnerInput`, and `packages/eval-runner/src/index.ts:77` defines `RunEvalRequest`. Eval verdicts are shared, but eval request and target input contracts remain local.
- `packages/run-reports/src/index.ts:31` defines `RunReport`. Reports are egress projections named by the vault, but no report/reference contract currently exists in `packages/schemas`.
- `packages/tool-broker/src/index.ts:134` defines local `CapabilityDefinition`, and `packages/tool-broker/src/index.ts:245` defines local `ToolCallContext`. `ToolDefinitionSchema`, `ToolCallRequestSchema`, and `ToolCallResultSchema` exist, but broker registry/context authority is still package-local.
