# Human-Input Runtime APIs Decision

Status: accepted for downstream packet planning
Work unit: FEAT-004A-human-input-runtime-apis-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation authority for the Specwright productization sequence
Related implementation slices: AUD-004A landed `RuntimeApi.recordApproval`; AUD-004B adds the first runtime-owned human-loop projection and answer APIs.

## Decision

Specwright human input is a runtime-owned contract. Adapters may render prompts, approvals, and next actions, but they must not invent state, resolve approvals outside the runtime, or treat CLI-only evidence records as durable human-loop semantics.

The approved method posture is:

| RuntimeApi method | Wave | Decision |
| --- | --- | --- |
| `recordApproval(runId, approvalDecision)` | Implemented first slice | Records `decision.recorded` only when the approval is pending. |
| `recordHumanAnswer(runId, answer)` | Implemented first human-loop wave | Runtime-owned answer operation that records `human.answer_recorded` and clears pending questions through event projection. |
| `getNextAction(runId)` | Implemented first human-loop wave | Read projection that reports the next pending approval, human question, repair task, or no-op state. |
| `listPendingApprovals(runId)` | Implemented first human-loop wave | Read projection over authoritative run state. |
| `listPendingQuestions(runId)` | Implemented first human-loop wave | Read projection over authoritative run state. |
| `resolveApprovalState(runId)` | Implemented first human-loop wave | Read projection summarizing pending queues, next action, blocked state, and resolved state. |
| request/create human-input methods | Deferred | Runtime requests should initially come from lifecycle/gate/tool/eval events. A direct public method to create arbitrary human questions is deferred until lifecycle and server-mode contracts require it. |

## Schema Posture

Existing schema primitives are the starting substrate, not a blanket approval to skip contract review.

| Contract | Current substrate | Decision |
| --- | --- | --- |
| Approval request | `ApprovalRequestSchema` | Use for pending approval projection. A later schema packet must decide whether prompt text, choices, explicit timeout/default behavior, risk, and metadata need first-class fields instead of metadata-only encoding. |
| Approval decision | `ApprovalDecisionSchema` | Use for `recordApproval`. Pending-item validation is implemented; decision-hash, subject/principal, deadline, and segregation constraints remain follow-up runtime/schema work. |
| Human question | `HumanQuestionSchema` | Use for pending question projection. It supports prompt, optional subject, allowed decision values, expertise, required-for, and metadata. |
| Human answer | `HumanAnswerRecordedEventPayloadSchema` | Use for append-only answer events. `recordHumanAnswer` must validate question identity and answer shape before appending. |
| Human input request | `HumanInputRequestedEventPayloadSchema` | Use for runtime-created pending questions. |
| Next action | New runtime projection type | Needs a runtime-owned schema before MCP/server/host adapters expose it as a protocol surface. |

Schema/generated-artifact edits are not part of this packet. If existing schemas cannot encode first-wave behavior without overloading metadata, a later schema packet owns the public contract and generated refresh.

## Human-Input Flow Posture

First full FEAT-004 wave:

- Freeform text answers.
- Structured choice answers when a pending question carries allowed decision values.
- Approval decisions with optional human message.
- One question or approval resolution per runtime call.
- Pending-list reads for approvals and questions.
- Next-action read projection for adapters and operators.

Deferred:

- File/path selection.
- Attachments.
- Multi-question batch resolution.
- Rich host UI components.
- Server-pushed notifications.
- Cross-run approval queues.
- Delegated approval groups or escalation routing beyond recorded principal rules.

## Event And Replay Semantics

Human-loop state must be derived from append-only events:

| Event | Runtime meaning |
| --- | --- |
| `human.input_requested` | Adds or updates a pending human question. |
| `human.answer_recorded` | Records an answer and clears the matching pending question. |
| `decision.recorded` | Records an approval decision and clears the matching pending approval. |

Implementation rules:

- No adapter may clear pending state without an authoritative runtime event.
- `recordApproval` and `recordHumanAnswer` must reject missing, stale, duplicate, already-resolved, mismatched, or expired pending items.
- Replay must produce the same pending-state projection from the same event log.
- A replayed or imported decision is not valid for a different run, approval, subject, decision hash, principal, or pending item.
- Event payloads must be sufficient for audit and provenance without relying on a host transcript.

## Pending State And Resume Policy

Pending approvals and questions are durable run-state projections, not process-local waits.

The first implementation wave must:

- Persist pending requests as events.
- Read pending state from replayable run state.
- Survive process restart when the run store is available.
- Treat deadlines as runtime-enforced authority, not UI hints.
- Surface pending state through `getNextAction`, `listPendingApprovals`, and `listPendingQuestions`.
- Keep retry/resume behavior deterministic and auditable.

Remote backends, distributed queues, notifications, and server-mode resume policies remain owned by durable backend and runtime server packets.

## Security And Audit Policy

Approval and human-input resolution must enforce:

- Decision-hash binding to the pending request when present.
- Subject binding to the governed action or artifact.
- Principal binding for the human actor who resolves the item.
- Tenant/root binding through the run lookup context.
- Expiry/deadline checks before mutation.
- Segregation of duties where policy or administration rules require it.
- No-self-approval when the requesting actor is barred from resolving the request.
- Duplicate resolution rejection or idempotent replay with identical event identity, never silent overwrite.
- Immutable event records with causation/provenance references.
- Redaction-safe output envelopes for adapters.
- Classified errors for missing, stale, mismatched, expired, denied, and unauthorized resolutions.

Run-store administration already demonstrates dual-control approval checks for administration operations. That evidence is a useful design precedent, not a substitute for product-level RuntimeApi human-loop enforcement.

## Adapter Scope

| Surface | Decision |
| --- | --- |
| CLI | Keep `approve`, `reject`, and `answer` public command names. `approve` and `reject` use `recordApproval`; `answer` uses `recordHumanAnswer`. |
| MCP | Expose `specwright_get_next_action`, `specwright_answer_question`, and `specwright_record_approval` as stable local RuntimeApi-backed tools after runtime methods and conformance tests exist. |
| Host command packs | Defer rendering and resolution hooks to host command-pack decisions. Hosts must call the runtime contract rather than maintain private approval queues. |
| Runtime server mode | Defer protocol endpoints, auth, queueing, and process lifecycle to the server-mode packet. |
| SDK and marketplace | Defer extension hooks until SDK governance and compatibility rules exist. |
| Docs/install UX | Defer user-facing instructions until CLI/MCP/host/server behavior is implemented and tested. |

## Current Repo Substrate

Live source on this stacked branch shows:

- `RuntimeApi` exposes `recordApproval`, `recordHumanAnswer`, `getNextAction`, `listPendingApprovals`, `listPendingQuestions`, `resolveApprovalState`, plus run, event, replay, tool, eval, evidence, artifact, gate, and report operations.
- `recordApproval` appends `decision.recorded` only for a pending approval and rejects missing/already-resolved approvals.
- `recordHumanAnswer` appends `human.answer_recorded` only for a pending question and rejects missing/already-resolved questions.
- CLI `approve` and `reject` call `recordApproval` and classify stale/missing approvals as integrity failures.
- CLI `answer` calls `recordHumanAnswer` and classifies stale/missing questions as integrity failures.
- MCP exposes next-action, answer, and approval tools as stable local RuntimeApi-backed bindings.
- Schemas already include approval request, human question, approval decision, human input requested, and human answer recorded payload primitives.
- Run-store projection tracks pending approvals/questions from events and removes them on matching answer or decision events.

## Relationship To AUD-004A/AUD-004B

AUD-004A provided the narrow `recordApproval` defect fix. AUD-004B provides the first runtime-owned human-loop API implementation. FEAT-004A keeps ownership of:

- pending/resume semantics
- lifecycle/server/host interaction
- full security and audit policy
- schema/generated changes if needed
- docs, conformance, release, and CI requirements

Workers must not treat AUD-004A/AUD-004B as completion of FEAT-004's full security, server, host, generated-contract, and release posture.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Runtime human-loop hardening and generated contracts | FEAT-004 implementation packet |
| Lifecycle creation of approval/question events | FEAT-003A lifecycle orchestrator packets |
| CLI command behavior and output contracts | FEAT-002 implementation packets |
| MCP/server/host hardening beyond local RuntimeApi tools | FEAT-005A and FEAT-012A |
| Host rendering and command packs | FEAT-006A |
| Durable backend and distributed resume | FEAT-009A |
| Adapter parity and support matrix | FEAT-011A |
| Server protocol endpoints | FEAT-012A |
| Release compatibility and migration notes | FEAT-013A |
| Docs/install/troubleshooting | FEAT-015A |
| CI/release enforcement | OPT-001A and release packets |

## Source Trace

| Claim | Source |
| --- | --- |
| Approvals, clarifications, and human input must be runtime capabilities, not only CLI syntax | raw features log `F4`, `FEAT-EPIC-004` |
| Target method names include next action, human answer, approval, pending lists, and approval-state resolution | raw features log `F4` |
| Decision-hash, principal, deadline, segregation, no-self-approval, immutable events, and stale/replay rejection are required semantics | raw features log `F4` |
| Current stacked runtime includes first-wave human-loop methods | `packages/runtime/src/index.ts`, upstream `AUD-004A`/`AUD-004B` stack |
| CLI answer is runtime-event backed | `packages/adapters-cli/src/index.ts`, CLI tests |
| MCP human-loop tools are enabled as local RuntimeApi bindings | `packages/adapters-mcp/src/index.ts`, MCP tests |
| Schema and run-store primitives already support pending human-loop projections | `packages/schemas/src/index.ts`, `packages/run-store/src/index.ts` |

## Diff Boundary

This record does not approve or implement generated schema contracts, server/host behavior beyond local RuntimeApi and MCP bindings, durable queues, lifecycle orchestration beyond existing event projections, README/install docs, package manifests, release workflows, GitHub settings, npm publish operations, raw-source wiki edits, or full security hardening. Those remain separate packets and gates.
