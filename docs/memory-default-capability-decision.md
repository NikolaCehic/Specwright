# Memory Default Capability Decision

Status: accepted for downstream packet planning
Work unit: FEAT-010A-memory-default-capability-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Default-authority assumption: memory is not default-on in the current runtime; product memory requires explicit grants, a sanctioned tier-1 runner, durable corpus/index storage, and adapter UX before it can be advertised as a default capability.

## Decision

Specwright memory should become a first-class product capability, but the first product posture is default-available-but-disabled, not default-on.

Memory may be present in the package set and capability catalog, but it remains unavailable to ordinary runtime execution until a harness, project config, or server policy explicitly enables it with:

1. tenant and corpus grants;
2. durable corpus and index storage;
3. a sanctioned tier-1 memory and embeddings runner;
4. redaction, tombstone, retention, and export controls;
5. pinned provider, model, and index versions;
6. retrieval-quality and groundedness gates;
7. adapter-visible operator UX for import, update, search, forget, export, and diagnostics.

Retrieval remains advisory context. Memory search results are not source authority unless a later product/security decision explicitly changes that boundary.

## Operation Set

| Operation | First posture | Product requirement |
| --- | --- | --- |
| Ingest/write | Supported as a high-risk capability definition. | Requires memory steward approval or tightly scoped service grant, durable write path, redaction before storage, source refs, and provenance. |
| Search | Supported as a read capability definition. | Requires tenant/corpus grants, cache provenance, redacted output, index-version pinning, and advisory-source labeling. |
| Embeddings search | Supported as a dense retrieval capability definition. | Requires provider/model/index pins and no raw vector exposure. |
| Read/get | Supported as a low-risk read capability definition. | Requires corpus grant, output redaction, provenance, and cache/replay safety. |
| Forget/delete | Supported as a high-risk admin capability definition. | Requires steward/admin grant, tombstones, cache/index invalidation, replay suppression, audit evidence, and retention policy compatibility. |
| Summarize | Deferred. | Must be added as an explicit operation with output schemas, source-bound grounding, and eval gates. |
| Namespace/list | Deferred. | Must be added with tenant/project/corpus visibility rules and no content leakage. |
| Import/update | Deferred to CLI/server/operator UX packets. | Must support dry-run, source refs, hash diffing, durable writes, and index promotion gates. |
| Export | Deferred to retention/audit/export packets. | Must support redaction, retention, legal hold, tenant scope, and provenance manifests. |
| Admin diagnostics | Deferred. | Must expose index, corpus, tombstone, provider, and eval status without leaking restricted content. |

Existing `memory.ingest`, `memory.search`, `embeddings.search`, `memory.get`, and `memory.forget` definitions are the seed surface. They are not enough by themselves for a product-ready memory default.

## Identity And Namespace Model

Memory authority is scoped, not ambient.

| Boundary | Rule |
| --- | --- |
| Tenant | Every memory call carries a tenant id. Cross-tenant access is denied and must not leak content or existence. |
| Project | Project memory belongs to a configured project identity and cannot be reused across repositories by path coincidence. |
| User and actor | Writes, imports, updates, forgets, and exports record the requesting actor and approval context. |
| Agent and adapter | Adapter identity is recorded for access, provenance, and compatibility, but adapters do not own memory policy. |
| Run and task | Runs may attach memory evidence/provenance, but run-local context does not grant future corpus authority. |
| Corpus | Corpus ids are the primary read/write/admin grant boundary. A caller can read, write, or admin only listed corpora. |
| Subject | Forget/erasure targets use subject, document, and chunk identifiers with tombstones and replay suppression. |
| Harness | Harness manifests may request memory grants, but grants are admitted only by policy and capability approval. |
| Capability pack | Capability packs may recommend corpus setup or memory checks, but cannot grant memory by themselves. |

The memory namespace model must compose with durable backend tenant roots and future server/team mode without changing past event authority.

## Broker And Runtime Exposure

Memory should enter the product through `ToolBroker`, not through direct runtime imports.

| Surface | Decision |
| --- | --- |
| Default runtime | Do not wire memory into the default runtime in this packet. Runtime exposure is opt-in only after a memory runner and durable backend are accepted. |
| Default broker registry | Do not add memory definitions to the default registry in this packet. Future registration must be gated by grants, policy, and runner support. |
| Harness grants | Default harness grants remain filesystem/eval only. Memory requires explicit harness/project grants. |
| Runtime API | Runtime may expose memory status and brokered calls later, but should not expose direct memory-store mutation methods as public shortcuts. |
| Capability packs | Capability packs can declare memory requirements only after FEAT-007A follow-up schemas and checks exist. |
| Server mode | Team/server memory requires server auth, durable backend, tenant isolation, queues/locks, and audit export. |

Default-available means product code can discover memory support and explain what is missing. It does not mean the runtime executes memory by default.

## Sanctioned Runner

Memory and embeddings are tier-1 capability kinds. They need a sanctioned tier-1 runner before runtime execution.

Required runner behavior:

- execute only through `ToolBroker` after request schema validation and policy evaluation;
- fail closed on missing grants, unsupported tier, policy denial, stale approval, invalid schemas, redaction failure, or durable-store unavailability;
- pass least-context inputs to the memory adapter;
- enforce tenant, corpus, actor, and redaction profile constraints;
- pin provider, model, index, corpus snapshot, and adapter versions in provenance;
- record memory events, spans, audit refs, cache status, tombstones, and replay suppression;
- apply deadlines, size limits, token limits, and cancellation;
- never return raw vectors, secrets, unredacted content, or unbounded result sets.

Until this runner exists, memory definitions remain declarations and tests may exercise the memory package directly.

## Durable Corpus And Index Dependency

Memory cannot be a product default while authoritative state is process-local.

| State | Product requirement |
| --- | --- |
| Documents and chunks | Durable, content-addressed, tenant-scoped store with source refs and redaction metadata. |
| Tombstones | Durable admin record that suppresses live retrieval and replay. |
| Dense indexes | Durable/rebuildable index segments with provider/model/index pins and corruption detection. |
| Lexical indexes | Deterministic rebuild from durable chunks with versioned analyzer and BM25/proximity config. |
| Cache | Tenant/corpus/index-version-aware cache with invalidation and redaction-safe replay. |
| Events and spans | Durable memory event/audit/span records that can be exported with run evidence. |
| Eval datasets | Content-addressed datasets with golden verdicts and drift detection. |

In-memory memory stores remain valid for unit tests and short-lived demos only. Local product mode requires a durable local backend. Team/server mode requires the remote/team backend decisions from FEAT-009A and FEAT-012A follow-ups.

## Embedding Provider And Replay Policy

Provider configuration is explicit.

- The deterministic local provider may remain the fixture and bootstrap provider.
- No external embedding provider is selected by this record.
- Product provider profiles must declare provider id, model id, model version, dimensions, tokenizer/chunking compatibility, rate/budget policy, redaction posture, and offline/air-gapped behavior.
- Every indexed corpus records provider id, model id, model version, index version, chunking strategy version, analyzer version, corpus snapshot hash, and tombstone set.
- Replays use pinned versions. Missing, stale, downgraded, or tombstoned indexes fail closed.
- Provider or model changes create new indexes; old indexes remain readable only through compatibility policy.
- Retrieval results are advisory and must remain linked to source refs, trust labels, content hashes, and redaction profiles.

## Adapter And Operator UX

Adapter exposure is assigned, not implemented here.

| Surface | First product responsibility |
| --- | --- |
| CLI | Later commands for corpus status, import, update, search, forget, export, and doctor checks. |
| MCP | Later tools/resources for brokered memory operations after server packaging and auth posture are accepted. |
| Host command packs | Later host commands should call approved CLI/MCP/runtime surfaces, not memory internals. |
| Runtime server | Later server mode owns shared memory queues, auth, tenant scopes, locks, and audit export. |
| SDK/marketplace | Later SDK helpers may validate memory-capable extensions but cannot bypass policy. |
| Docs/install UX | Later docs must explain advisory retrieval, corpus setup, privacy, erasure, and troubleshooting. |

The first operator UX should prioritize corpus import/update dry-runs, index status, forget/erasure, and diagnostics before broad memory search shortcuts.

## Safety Controls

Memory safety is mandatory, not decorative.

| Control | Required posture |
| --- | --- |
| Redaction | Redact before ingest and before output/cache/audit exposure; carry redaction profile versions in provenance. |
| Tenant isolation | Enforce tenant and corpus grants before touching memory state. |
| Permission checks | Read, write, admin, embeddings, import, export, and forget permissions are distinct. |
| Source authority | Retrieved memory is advisory unless separately elevated by policy with explicit source evidence. |
| Retention and erasure | Forget uses tombstones and replay suppression; hard deletion/export follow retention and legal-hold policy. |
| Cache invalidation | Writes and tombstones invalidate affected corpus/index cache entries. |
| Injection defense | Treat stored text as data, detect prompt-injection patterns, and report blocked or downgraded retrieval. |
| Provenance | Every hit carries source refs, hashes, retriever provenance, index/provider pins, trace/span refs, and trust labels. |
| Output bounds | Limit result count, tokens, bytes, and raw content exposure. |
| Failure mode | Missing durable store, missing grant, stale index, schema-invalid output, redaction failure, and provider drift fail closed. |

## Quality Gates And Reporting

Memory index promotion must be gated.

| Gate | Required signal |
| --- | --- |
| Retrieval quality | Recall, precision, MRR, and graded nDCG over content-addressed eval datasets. |
| Groundedness | Claims must trace to trusted retrieved evidence and fail on untraced, low-trust, self-retrieval, or faithfulness gaps. |
| Index promotion | New index versions promote only after quality and groundedness gates pass. |
| Injection reporting | Reports show blocked, downgraded, or quarantined retrieval caused by unsafe input or source text. |
| Replay compatibility | Historical memory-backed decisions replay against pinned corpus/index/model versions or fail closed. |
| Repair posture | Repairs can retune retrieval, rebuild/re-embed pinned indexes, or update reviewed ground truth through governance; they cannot use memory search to repair unsupported memory findings. |

Existing memory eval definitions are the seed gates. Product release gates must wire them into runtime, CI, and release workflows later.

## Current Repo Evidence

Live source on this stacked branch shows:

- `@specwright/memory` exports memory broker helpers, capability definitions, policy bundle helpers, schemas, ranking contracts, and eval definitions.
- Memory capability ids are `memory.ingest`, `memory.search`, `embeddings.search`, `memory.get`, and `memory.forget`.
- `memory.ingest` and `memory.forget` are high-risk definitions; `memory.search` and `embeddings.search` are medium-risk; `memory.get` is low-risk.
- The memory policy bundle constrains calls by tenant, read/write/admin corpus grants, redaction profile, allowed phases, and steward approval for high-risk mutations.
- `MemoryBrokerRuntime` stores documents, chunks, tombstones, cache, events, spans, and dense index state in in-memory maps/arrays.
- `ToolBroker` fails unsupported isolation tiers before invoking the adapter; memory broker tests assert tier-1 memory fails with `unsupported_isolation_tier` and does not call the memory runtime.
- The runtime package manifest does not depend on `@specwright/memory`.
- The default `ToolBroker` registry contains only `fs.list` and `fs.read`.
- The default harness grants `fs.list`, `fs.read`, and `eval.run`, not memory.
- README states memory and embeddings are governed capability definitions, unsupported isolation tiers fail closed without a sanctioned runner, and retrieval is advisory context rather than source authority.
- CLI and MCP adapter source searches found no first-party memory command/tool exposure outside memory package definitions and tests.
- Memory eval exports include retrieval-quality and groundedness gates for index promotion.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Memory operation schema additions for summarize, namespace/list, import/update, export, and diagnostics | Memory API implementation packet |
| Tier-1 memory and embeddings runner | Tool-broker/capability runner packet |
| Default broker/runtime registration | Runtime capability packet after runner and durable backend |
| Durable memory corpus/index/cache/event/span stores | Durable backend plus memory implementation packets |
| Embedding provider profile and external provider support | Memory provider packet plus release/security review |
| Corpus import/update/search/forget/export commands | CLI, server, and docs packets |
| MCP and host memory exposure | MCP/server and host command-pack packets |
| Capability-pack and SDK memory integration | Capability-pack and SDK packets |
| Eval gate wiring and report visibility | Memory eval, run reports, CI, and release packets |
| Retention, legal hold, erasure, and audit export | Operations/run-store/run-reports plus memory packet |
| Public docs and install UX | Docs/install UX packet |

## Source Trace

| Claim | Source |
| --- | --- |
| Memory should become a default brokered product capability with durable stores, identity, namespaces, and adapter access | `FEAT-EPIC-010` |
| Memory API, identity/namespace, broker wiring, durable backend, and safety controls are required | `FEAT-TASK-010.1` through `FEAT-TASK-010.5` |
| Current memory is mature in isolation but not in default runtime, and tier-1 memory fails closed without a sanctioned runner | raw features log `F10`, raw audit log `A13` |
| Product memory needs corpus tenancy, import/update UX, replay pins, erasure commands, eval gates, and injection reporting | raw features log `F10` |
| Runtime product paths should not silently rely on volatile in-memory stores | raw optimization log `O15` |
| Current memory package exposes broker, capabilities, policy, schemas, ranking, and evals | `packages/memory/src/*` |
| Runtime, default broker, and default harness do not grant memory today | runtime package manifest, `packages/tool-broker/src/index.ts`, default harness fixture |
| Retrieval is advisory context, not source authority | README |
| Durable backend and default capability choices are separate gates | `docs/durable-backend-targets-decision.md`, `docs/capability-pack-taxonomy-decision.md` |

## Diff Boundary

This record does not approve or implement memory runtime wiring, default broker registry changes, default harness grants, tier-1 runner code, durable memory backend, embedding provider configuration, package manifest changes, dependencies, generated contracts, memory source changes, memory tests, CLI/MCP/server commands, host command packs, SDK marketplace behavior, docs beyond this decision record, CI/release workflows, GitHub settings, package publishing, raw-source edits, or wiki status edits. Those remain separate packets and gates.
