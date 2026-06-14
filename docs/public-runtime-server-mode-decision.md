# Public Runtime Server Mode Decision

Status: accepted for downstream packet planning
Work unit: FEAT-012A-public-runtime-server-mode-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Default-authority assumption: public runtime server mode is a future governed product surface; the current in-process runtime, CLI adapter, and MCP adapter are substrate, not a deployable public runtime server.

## Decision

Specwright should support public runtime server mode in staged deployment modes, but the first implementation must be a separate server product surface with explicit auth, queueing, persistence, observability, and release gates.

The approved posture is:

1. Keep local-only workspace mode on the in-process runtime and CLI adapter until a server package exists.
2. Keep CI mode on CLI/in-process execution until server startup, shutdown, credentials, logs, and deterministic artifacts are specified.
3. Make self-managed team server the first true public server target.
4. Defer managed service until the team server contract, tenant model, billing/operations controls, hosted isolation, and release gates are proven.
5. Defer air-gapped enterprise until offline install, local identity provider integration, audit export, retention/legal-hold, backup/restore, and release provenance are proven.

Public server support means a client can connect to a long-lived runtime service, authenticate, start a run, observe lifecycle events, resolve approvals or questions, read artifacts/evidence/reports according to authorization, and resume after interruption without relying on process-local state.

## Deployment Modes

| Mode | First posture | Product requirement |
| --- | --- | --- |
| Local-only workspace | Existing CLI/in-process runtime remains the supported local path. | A local dev server may be added later only after it uses the same server contract and safe defaults. |
| CI | Existing CLI/in-process runtime remains the supported CI path. | A CI server mode must be ephemeral, non-interactive by default, credential-scoped, and artifact-deterministic. |
| Self-managed team server | First public server target. | Requires server package/process boundary, HTTP plus event stream transport, auth, tenant/project scopes, queues, durable persistence, observability, docs, and release gates. |
| Managed service | Deferred. | Requires hosted multi-tenant isolation, tenant lifecycle, customer admin model, service SLOs, billing/quotas, abuse controls, support runbooks, and hosted release process. |
| Air-gapped enterprise | Deferred. | Requires offline package provenance, mirrored dependencies, local identity provider support, local audit export, backup/restore, data retention controls, and regulated deployment docs/tests. |

The operations package already names embedded single-tenant, hosted multi-tenant, and air-gapped regulated deployment modes. Those are useful primitives, not a server support claim.

## Package And Process Boundary

The eventual public server should be a new package and process boundary, not a hidden mode inside the runtime package or MCP adapter.

| Boundary | Decision |
| --- | --- |
| Package | Reserve a future `@specwright/server` package or equivalent package-taxonomy-approved name. Do not create it here. |
| Process | Server mode runs as a long-lived process with explicit lifecycle, health, shutdown, and readiness semantics. |
| Runtime integration | The server wraps public `RuntimeApi` operations and approved stores; it does not reach around runtime, broker, policy, run-store, or report contracts. |
| CLI relationship | CLI may later receive server administration and connection commands, but local CLI remains usable without a server. |
| MCP relationship | MCP remains an adapter/protocol surface. It can be hosted by or alongside the server later, but MCP is not itself the runtime server. |
| Host command packs | Host packs call approved CLI/MCP/server surfaces. They do not own server lifecycle or auth policy. |
| SDK/marketplace | Server plugins and third-party extensions require SDK validation and compatibility gates before loading. |

Server source, package metadata, executable bins, process lifecycle, deployment scripts, and package publishing remain downstream implementation work.

## Public API Surface

The server API should be a canonical runtime protocol with method names, request schemas, response envelopes, event envelopes, and error taxonomy that can be transported over HTTP and event streams without changing semantics.

| Surface | First server decision |
| --- | --- |
| Runs | Start run, get run, list authorized runs, replay run, cancel run, and resume/reconnect by run id. Cancel and list need new runtime/server contracts before implementation. |
| Phases | Read phase state and lifecycle events. Phase mutation remains runtime-owned and policy-governed. |
| Events | Stream runtime events, fetch bounded event pages, replay from cursor, and expose last-event id for resume. |
| Approvals and human input | Read pending approval/question state and submit decisions/answers through the approved runtime APIs. No auto-approval or host-only bypass. |
| Tools/capabilities | Call brokered tools only through runtime policy, capability declarations, approvals, and audit/provenance records. |
| Memory | Deferred until memory default capability, durable corpus/index storage, runner, and adapter UX gates are accepted. |
| Artifacts | Read and record artifacts through runtime/store contracts with redaction and authorization. |
| Evidence | Read and record evidence through runtime/store contracts with source authority and redaction. |
| Evals and gates | Run evals and evaluate gates through runtime APIs with dataset, decision-hash, and policy constraints. |
| Reports | Generate and write reports with stable output envelopes and run-package provenance. |
| Admin | Health, readiness, version, compatibility, tenant status, retention/legal-hold, audit export, backup/restore, and release checks require explicit admin scopes. |

The current `RuntimeApi` already exposes start, read, events, replay, tool call, eval, evidence, artifact, approval, gate, report generation, and report writing operations. The server protocol must map to those operations first and add new operations only through separate schema/runtime packets.

## Transport Model

The first transport target should be HTTP for request/response operations plus SSE for runtime lifecycle event streaming.

| Transport | Decision |
| --- | --- |
| HTTP | First request/response transport for start, read, replay, tool, eval, evidence, artifact, approval, gate, report, and admin operations. |
| SSE | First event-stream transport for lifecycle events and approval/question updates with cursor resume. |
| WebSocket | Deferred until bidirectional host UX requires it and auth/backpressure semantics are proven. |
| MCP transport | Separate adapter relationship; may bridge to server later but does not define server mode. |
| Stdio wrapper | Deferred to local tooling/host integration if needed. |
| Hosted API | Deferred to managed-service packet. |

Transport implementations must produce the same outcome envelopes and event ids. A client should not need to know whether an operation came from HTTP or another approved transport to interpret runtime state.

## Auth, Authorization, And Tenant Model

Public server mode must never inherit disabled authentication defaults.

| Area | Decision |
| --- | --- |
| Authentication | All team, managed, and air-gapped server calls require a verified credential. Local development may use an explicit local-only unsafe profile only behind a visible opt-in. |
| Token shape | Token implementation is deferred, but tokens must resolve to client id, subject when applicable, tenant id, project/workspace access, scopes, expiry, issuer, and key/version provenance. |
| Subject verification | User-delegated actions require subject verification, not only service credential verification. |
| Scopes | Required scopes include run start/read, event read, replay, tool call, evidence read/write, artifact read/write, eval run, gate evaluate, report read/write, approval/question action, memory action, admin, audit export, retention/legal-hold, and release operations. |
| Tenant access | Every server operation is tenant-scoped. Cross-tenant reads are denied unless an explicit governance grant and redacted aggregate contract applies. |
| Project access | Project/workspace access must be checked before run creation, run reads, artifact reads, memory access, tool calls, and report export. |
| Unsafe operations | Shell, network, write, memory mutation, external MCP, package-manager, git, and admin operations require policy, capability, approval, and audit gates. |
| Failure behavior | Missing credential, invalid credential, missing subject, scope overreach, tenant mismatch, project mismatch, stale token, policy denial, or unavailable verifier fails closed before runtime mutation. |

The MCP adapter already has authenticated-mode primitives with credential verifier, subject verifier, tenant resolver, and scopes. Those primitives are useful evidence, but the public runtime server needs its own safe default and cannot rely on MCP disabled-auth examples.

## Queueing And Runtime Control

Server mode needs durable queue semantics before team or hosted support can be advertised.

| Queue/control area | Decision |
| --- | --- |
| Run queue | Required for team and managed server modes. It must support admission control, concurrency limits, priority, deadlines, idempotency keys, cancellation, and durable state transitions. |
| Approval queue | Required for approvals and human questions. It must preserve request ids, decision hashes, deadlines, requester/principal context, and audit provenance. |
| Cancellation | Requires a runtime/server contract for cancel intent, terminal state, cleanup, and retry eligibility. |
| Retry | Retrying a failed or interrupted action requires idempotency identity, previous side-effect classification, and policy re-evaluation. |
| Backpressure | Server returns bounded retry-after or blocked responses when queues, event streams, storage, or policy dependencies are overloaded. |
| Resume | Clients resume from run id plus event cursor. Server restart survival depends on durable queues and run-store state. |
| Ordering | Event order remains authoritative from the run-store/event ledger. Queue order is operational metadata, not a replacement for runtime events. |

Single-process local experiments may exercise the API, but they are not sufficient for team-server support without durable queue and resume behavior.

## Persistence And Resume Dependency

Current file-backed run packages remain the authoritative run record for local and development scenarios. Public team and managed server modes need additional durable backend work.

| State | First posture |
| --- | --- |
| Run packages | Use run-store packages for event ledger, projection, replay, reports, retention, migration, metrics, and audit classes. |
| Queue state | Deferred to durable backend implementation; must not be process-local for team/managed support. |
| Approval state | Deferred to durable approval queue/store implementation; must preserve decision hashes and deadlines. |
| Tenant/project registry | Deferred to durable backend and operations packets. |
| Artifact/evidence stores | Existing stores remain substrate; server auth, tenancy, redaction, export, and backup rules need server packets. |
| Memory/corpus/index state | Deferred until memory and durable backend decisions are implemented. |
| Locks and concurrency | Deferred to durable backend implementation; required before multi-worker or multi-node server mode. |
| Backup/restore/archive | Deferred to operations and durable backend packets, with run-store retention/legal-hold as substrate. |

The server must not promise restart survival, cross-worker execution, or tenant safety on volatile process-local state.

## Observability And Operations

Server mode is operational only if observability and administration are first-class.

| Responsibility | Owner/posture |
| --- | --- |
| Audit export | Server implementation must compose run-store audit classes, MCP observability where relevant, operations audit, and redaction rules. |
| Metrics endpoint | Deferred implementation, but required before team/managed support. Metrics must separate tenant, run, queue, policy, adapter, storage, and transport dimensions without leaking restricted content. |
| Trace/span policy | Server calls must emit trace spans linked to runtime events, policy decisions, adapter calls, and external invocations. |
| Health/readiness | Required before deployment docs: startup config, credential verifier, store connectivity, queue readiness, and compatibility state. |
| Retention/legal hold | Server admin APIs must use run-store retention/legal-hold controls and deny destructive actions without governed approval. |
| Release compatibility | Server releases must use package/schema/runtime/adapter/run-package compatibility gates and rollback posture before public support. |
| Redaction | Logs, metrics, traces, errors, event streams, audit bundles, and exports carry redaction profiles. |
| Incident recovery | Later packets must define backup/restore, queue drain, replay repair, reindex/rebuild, tenant quarantine, and release rollback runbooks. |

Operations primitives for tenancy, audit, compatibility, release promotion, and rollback are available as substrate, but server runbooks and endpoints are not implemented by this record.

## Relationship To Existing Surfaces

| Surface | Relationship |
| --- | --- |
| Runtime API | In-process integration facade and first protocol mapping source. Not a network server. |
| CLI adapter | Local client and CI path today. Later server commands can connect to server mode after CLI taxonomy approval. |
| MCP adapter | Adapter library that exposes runtime tools/resources/prompts. It is not a server deployment story by itself. |
| Adapter parity | Server clients and MCP/host adapters must pass parity gates before support claims. |
| Durable backend | Required for tenant/project registry, queues, locks, approval state, memory/corpus state, and multi-worker safety. |
| Memory | Server exposure waits for default capability, durable memory, runner, redaction, and eval gates. |
| SDK/marketplace | Server extension loading waits for SDK validation, trust, compatibility, and marketplace metadata. |
| Docs/install UX | Public server docs wait for implementation, smoke tests, safe defaults, support matrix, and release gates. |
| Release compatibility | Server support requires compatibility rows, migration/downgrade posture, changelog, provenance, and rollback checks. |

## Current Repo Evidence

Live source on this stacked branch shows:

- The workspace has packages for runtime, CLI adapter, MCP adapter, stores, operations, memory, reports, schemas, tool broker, and adapter parity, but no first-party server package.
- Repository searches found no public HTTP/SSE/WebSocket runtime server entrypoint.
- `RuntimeApi` is an in-process TypeScript facade with operations for start, get, events, replay, tool calls, evals, evidence, artifacts, approval, gates, and reports.
- README states the CLI is the local workspace path and MCP exposes runtime tools/resources/prompts without becoming a second runtime.
- MCP deployability tests separate adapter readiness from missing server gaps such as package/bin, transports, host configuration, safe default auth profile, process lifecycle, and transport integration tests.
- MCP authenticated mode supports credential verification, subject verification, tenant resolution, and scopes, while disabled mode remains available for adapter examples/tests.
- Run-store uses file-backed run packages with event ledgers, state projection, replay, reports, retention, legal holds, metrics/audit record classes, archive, hard delete, and migration records.
- Operations exposes tenant scopes, embedded/hosted/air-gapped deployment-mode primitives, tenant partitioning, cross-tenant denial/audit, release promotion, rollback, and compatibility classification.
- Existing product, package, CLI, MCP packaging, host command-pack, capability-pack, SDK, durable backend, memory, adapter parity, release, naming, CI, and docs decisions remain separate gates.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Server package name, bin, exports, and package metadata | Package taxonomy plus server implementation packets |
| Canonical server protocol schemas and error taxonomy | Server API plus shared-schema packets |
| HTTP and SSE transport implementation | Server transport packet |
| Auth/token source, credential verifier, subject verifier, tenant/project authorization | Server auth packet plus operations/security review |
| Run queue, approval queue, cancellation, retry, backpressure, and resume | Server queue/runtime-control packet |
| Durable tenant/project registry, queue state, approval state, locks, and backup/restore | Durable backend plus operations packets |
| CLI server commands and CI server behavior | CLI taxonomy and server CLI packets |
| MCP bridge to server mode | MCP packaging/server integration packet |
| Host command-pack server integrations | Host command-pack packets |
| Memory/capability exposure through server | Capability-pack, memory, and server packets |
| Metrics, audit export, health, retention/legal-hold, and runbooks | Server observability/operations packets |
| Public docs, examples, deployment guides, and install UX | Docs/install UX packet after implementation |
| CI/release gates, provenance, compatibility rows, and rollback tests | Release and CI packets |
| GitHub settings, package publish, tags, and hosted deployment | Release/GitHub operations packets |
| Wiki status edits | Wiki reconciliation packet |

## Source Trace

| Claim | Source |
| --- | --- |
| Public runtime server mode should support long-lived/shared/remote execution with safe APIs, auth, persistence, and observability | raw features log `F12`, `FEAT-EPIC-012` |
| Server tasks require API surface, auth/authz, streaming events, persistence integration, and deployment docs/tests | `FEAT-TASK-012.1` through `FEAT-TASK-012.5` |
| Raw backlog names local-only, CI, team server, managed service, and air-gapped enterprise modes plus auth, tenancy, queues, audit, metrics, storage, retention/legal-hold, and compatibility checks | raw features log `F12` |
| Current runtime API is an in-process facade, not a network server | `packages/runtime/src/index.ts` |
| Current CLI and MCP adapter surfaces are adapter/client surfaces, not the public runtime server package | README, `packages/adapters-mcp/src/index.test.ts` |
| MCP authenticated mode is useful security substrate but disabled auth remains an adapter option | `packages/adapters-mcp/src/index.ts`, `packages/adapters-mcp/src/index.test.ts` |
| Current run-store provides file-backed run packages, replay, metrics/audit classes, retention/legal-hold, archive/delete, and migration primitives | `packages/run-store/src/index.ts` |
| Current operations package provides tenancy, audit, release, rollback, and compatibility primitives | `packages/operations/src/*` |
| Durable backend, adapter parity, memory, release, docs, CI, package, MCP packaging, and host integrations remain separate gates | existing decision records in `docs/` |

## Diff Boundary

This record does not approve or implement a server package, executable bin, package manifest changes, source modules, protocol schemas, HTTP/SSE/WebSocket transports, auth/token source, credential verifier, tenant/project registry, queues, metrics endpoint, durable backend integration, runtime defaults, CLI/MCP/host code, capability-pack behavior, memory defaults, generated artifacts, tests, docs beyond this decision record, CI/release workflows, GitHub settings, package publishing, hosted deployment, raw-source edits, or wiki status edits. Those remain separate packets and gates.
