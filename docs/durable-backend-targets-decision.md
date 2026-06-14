# Durable Backend Targets Decision

Status: accepted for downstream packet planning
Work unit: FEAT-009A-durable-backend-targets-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Backend assumption: existing file-backed run packages are the first durable local substrate; no new database, object store, package dependency, server mode, or runtime wiring is approved by this record.

## Decision

Specwright should use a staged durable-backend strategy:

1. Treat the existing file-first run package as the first local durable backend for runs, artifacts, evidence, trace files, reports, checkpoints, migrations, retention records, legal holds, archives, and administration audit records.
2. Keep in-memory stores available for tests, deterministic fixtures, and short-lived demos only.
3. Require product, server, team, managed, and enterprise paths to use an explicit durable backend or fail with a visible unsupported/unsafe-default state until the backend exists.
4. Define pluggable store interfaces before adding database, object-store, queue, lock, or hosted-service dependencies.
5. Defer remote/team backends until public server mode, authentication, tenant isolation, locking, consistency, backup/restore, and release compatibility decisions are accepted.

This packet does not select SQLite, Postgres, Redis, S3/blob storage, a managed service, or a hosted marketplace backend. Those choices must be made by backend implementation packets after interface contracts and conformance tests exist.

## Store Families

| Store family | First durable posture | Deferred target |
| --- | --- | --- |
| Runs and state projections | Existing file-backed run package remains first wave. | Alternative local/remote run-store adapters after conformance tests. |
| Events, checkpoints, migrations, and integrity | Existing JSONL/event integrity, checkpoint, migration, and version records remain authoritative. | Cross-backend integrity verifier and migration tooling. |
| Artifacts, evidence, traces, reports, and eval outputs | Stored under run-package-owned paths in the first local durable path. | Blob/object storage only after artifact/evidence ownership and retention semantics are portable. |
| Administration approvals and audit records | Existing run-store administration files remain the first durable approval/audit substrate. | Dedicated approval/human-input store after FEAT-004 follow-up work. |
| Harness registry entries | Current in-memory registry is not product durable. First backend target is a local durable registry store with retained package bytes, lifecycle records, dependency dependents, and trusted snapshot refs. | Remote registry backend after server/team auth and locks exist. |
| Trust registry | Current in-memory/file-loaded trust store is not a product registry. First backend target is a local durable trust-store index with key lifecycle and revocation evidence. | Enterprise trust service or remote registry after tenant governance. |
| Broker cache | Current broker cache defaults to in-memory. First durable target is a local content-addressed cache with provenance, redaction, invalidation, and TTL/version metadata. | Shared cache only after tenant isolation and cache-poisoning controls exist. |
| Memory corpus and indexes | Current memory runtime uses in-memory documents, chunks, tombstones, cache, events, spans, and dense index state. Durable memory is a separate required packet before memory can be default product capability. | Local durable corpus/index backend, then remote/team memory backend. |
| Locks and leases | Not a first-wave source implementation. | Required before remote/team backends and server queues. |
| Queues and server state | Not a first-wave source implementation. | Public runtime server mode must own queues, workers, sessions, and shared pending state. |
| Tenant roots and configuration | Operations tenancy already partitions filesystem work under tenant roots. | Product config, CLI/server flags, and migration from local to team mode remain separate packets. |

No omitted store family is implicitly approved. A later packet must either implement a store interface with conformance coverage or explicitly keep the family deferred.

## Environment Defaults

| Environment | Allowed store posture |
| --- | --- |
| Unit tests and deterministic fixtures | In-memory stores are allowed when tests assert fail-closed and restart behavior separately. |
| Demos and examples | In-memory stores are allowed only with visible ephemeral-state language and no production claims. |
| Local development | Existing file-backed run packages are allowed. In-memory registry/cache/memory stores require an explicit dev-only profile or warning. |
| Local product usage | Durable local stores are required for run packages and should become required for registry, cache, approvals, and memory before those features are advertised. |
| CI | In-memory stores are allowed for isolated tests, but product smoke tests must exercise durable local stores. |
| Team/server mode | In-memory stores are forbidden for authoritative state. Backend configuration, tenant roots, locks, and recovery behavior are required. |
| Managed or hosted service | In-memory stores are forbidden. Durable stores, backups, retention, legal hold, audit export, and tenant isolation are required. |
| Air-gapped enterprise | Local durable stores and exportable audit/backup bundles are required before support is advertised. |

Unsafe in-memory defaults must become operator-visible before product paths expose them. This record assigns warning UX to later CLI/server/docs packets rather than adding warnings here.

## Local Durable Backend Target

The first local durable target is filesystem-backed, because the run-store already has a versioned file backend and operational semantics. A SQLite-style local backend is a valid later implementation target, but it is not selected until store interfaces and conformance tests show where relational storage adds product value.

The local durable backend target must provide:

- atomic writes or explicit two-phase staging for authoritative records;
- replayable append-only logs where history matters;
- content hashes for artifacts, evidence, cache entries, and memory chunks;
- version records with backend adapter ids;
- checkpoint/rebuild behavior where projections can drift;
- tenant-root confinement;
- backup/restore and archive/export commands or APIs;
- integrity verification that fails closed on partial writes, tampering, and missing records.

Current file-backed run packages already satisfy part of this target for run history. Registry, trust, cache, approval, memory, lock, queue, and server state still need durable interfaces and implementation packets.

## Remote And Team Backend Path

Remote/team backends are later-wave targets. They must not be implied by the current local code.

Before a remote/team backend ships, Specwright must define:

- authenticated principals, service identities, and tenant scopes;
- tenant partitioning, cross-tenant denial, and redaction-safe aggregate behavior;
- locks, leases, idempotency keys, and conflict handling;
- consistency expectations for events, approvals, registry promotion, memory updates, cache invalidation, and archive/restore;
- offline export/import, backup restore, and disaster recovery;
- migration from local durable stores to team/server stores;
- observability and audit export for every backend operation;
- compatibility and rollback rules across backend versions;
- conformance tests that run against local and remote adapters.

Public runtime server mode owns queue, session, worker, and shared-pending-state decisions. Durable backend work must not pre-commit server transport or hosted-service architecture.

## Store Interfaces And Ownership

| Interface area | Owner |
| --- | --- |
| Run package store | `@specwright/run-store`, with future adapter interfaces added behind compatibility tests. |
| Artifact/evidence/trace/report storage | Runtime/run-store/report packages, with schemas owning record contracts. |
| Administration approval/audit store | `@specwright/run-store` administration first, human-input runtime APIs later. |
| Harness registry and trust registry | `@specwright/harness-loader` owns interfaces; durable backend packet owns implementations. |
| Tool result cache | `@specwright/tool-broker` owns cache interface and provenance rules; durable cache packet owns local/shared stores. |
| Memory corpus/index/cache/event/span stores | `@specwright/memory` owns interfaces; memory-default and durable-backend packets own product wiring. |
| Locks, queues, server state | Public runtime server mode owns contracts before backend implementation. |
| Tenant partitioning and release/backups | `@specwright/operations` owns governance semantics; backend packets implement adapters. |
| Product configuration | CLI/server/docs packets own user-facing config discovery and warnings. |

Store interfaces must be narrow, deterministic, and testable. They should expose persistence, recovery, integrity, and compatibility behavior, not leak implementation-specific database clients.

## Migration And Versioning

Every durable backend must carry version metadata before it can hold product state.

Required migration rules:

- each store family has a store schema version and backend adapter version;
- upgrades run through a dry-run verifier before mutating authoritative data;
- downgrade behavior is explicit: supported, export-only, or blocked;
- migration records include source version, target version, operator approval when required, integrity before/after, and rollback posture;
- migration failures preserve original bytes/records or leave a tombstone/audit record explaining the failure;
- local-to-team migration must preserve tenant ids, run ids, event hashes, approval records, trust state, cache invalidation inputs, memory tombstones, and release compatibility metadata;
- breaking backend changes require release notes, compatibility matrix rows, and historical replay fixtures;
- naming/config migration remains separate and cannot be bundled into durable backend code without its own approval.

The existing run-store version record and migration primitives are the model for other store families, not proof that those families are already durable.

## Backup, Restore, Archive, Retention, And Audit Export

Durability is not just persistence. Product backends must be operable.

| Operation | Required posture |
| --- | --- |
| Backup | Capture all authoritative records for selected tenants/runs/stores with hashes, versions, and redaction-safe manifests. |
| Restore | Verify backup integrity before write, restore atomically, and record audit evidence. |
| Archive | Preserve required records, write tombstones where live data moves, and keep restore paths deterministic. |
| Hard delete | Require retention eligibility, approvals, legal-hold checks, and durable audit evidence. |
| Legal hold | Block archive/delete where applicable and persist conflict evidence. |
| Audit export | Bundle events, traces, records, external calls, redactions, hashes, provenance gaps, and backend metadata. |
| Disaster recovery | Document recovery point, recovery time, consistency, and manual operator steps before support claims. |

Existing run-store retention, legal-hold, archive, restore, hard-delete, and audit-export primitives are first-wave evidence. Other store families must add equivalent operational posture before product promotion.

## Integrity And Conformance Tests

Backend implementations must ship with a shared conformance matrix.

| Test class | Required coverage |
| --- | --- |
| Persistence and restart | Write records, restart/recreate adapter, and prove reads match by hash and schema. |
| Atomicity and partial failure | Interrupted writes, staged writes, rollback, orphan cleanup, and no partial authoritative promotion. |
| Concurrency | Competing appends, registry promotions, cache writes, memory ingest/search, approvals, locks, and queue claims. |
| Tenant isolation | Cross-tenant reads/writes deny without leaking content or existence. |
| Integrity | Hash-chain verification, content hashes, spec hashes, tombstone checks, and tamper detection. |
| Migration | Upgrade, failed upgrade, unsupported downgrade, local-to-team export/import, and historical replay. |
| Backup/restore/archive | Round-trip backup, restore, archive, legal hold, retention expiry, and audit export. |
| Cache/replay | Cache key inputs, invalidation, stale-output rejection, redaction, and replay compatibility. |
| Unsafe defaults | In-memory profile warnings, forbidden production/server mode, and demo/test-only classification. |
| Compatibility | Backend adapter version matrix, package release rows, and fixture coverage for every public store. |

No durable backend is product-ready until it passes the matrix for its store family and environment class.

## Current Repo Evidence

Live source on this stacked branch shows:

- `@specwright/run-store` uses a file backend versioned as `specwright.backend.file.v1`.
- Run packages include events, state, trace, decisions, summary, checkpoints, migrations, retention records, legal holds, tombstones, metrics, archive manifests, and administration audit records.
- Run-store integrity verifies event ledgers, detects tampering, rebuilds projections, writes checkpoints, and preserves original data on migration failures.
- Run-store administration operations include retention seal, archive, restore, legal hold placement/release, hard delete, migration apply, audit export, quarantine, and projection rebuild, with dual-control approval and integrity snapshots.
- Operations tenancy partitions jobs under tenant roots and denies unscoped or invalid tenant jobs.
- `HarnessRegistry` defaults to `InMemoryRegistryStore` when no durable registry store is supplied.
- `InMemoryTrustStore` exists for trust metadata loading and test fixtures.
- `ToolBroker` defaults to `InMemoryToolResultCacheStore`.
- `InMemoryChunkStore` stores memory chunks and document membership in maps.
- `MemoryBrokerRuntime` stores documents, chunks, tombstones, cache, events, spans, and dense index state in in-memory maps/arrays.
- Package manifests show no first-party SQLite, Postgres, MySQL, Redis, S3/blob, Dynamo, DuckDB, Drizzle, Prisma, or equivalent backend package dependency.
- Audit source A13 confirms memory capabilities exist but runtime default wiring does not make memory a durable default capability.
- Optimization source O15 confirms in-memory stores are useful for tests but insufficient for product paths.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Store interface contracts for every store family | Durable backend implementation packet |
| File-backed registry, trust, cache, and approval stores | Durable local backend packet |
| Durable memory corpus/index/cache/event/span stores | Memory default plus durable backend packets |
| SQLite-style or relational local backend evaluation | Later backend packet after conformance matrix |
| Remote/team backend contract | Public server mode plus durable backend packets |
| Locks, leases, queues, and worker state | Public server mode packet |
| CLI/server configuration and unsafe-default warnings | CLI/server/docs packets |
| Backup, restore, archive, retention, legal hold, and audit export across all stores | Operations and durable backend packets |
| Local-to-team migration | Durable backend plus release compatibility packets |
| Naming/config migration | Naming migration packet |
| CI conformance matrix | CI/local command matrix follow-up |
| Public docs and install UX | Docs/install UX packet |
| Package dependencies and publish metadata | Package/release packets |

## Source Trace

| Claim | Source |
| --- | --- |
| Product usage requires durable stores for runs, registry entries, state, memory, and artifacts | `FEAT-EPIC-009` |
| Store interfaces, local backend, remote backend, migration strategy, and conformance tests are required | `FEAT-TASK-009.1` through `FEAT-TASK-009.5` |
| F9 requires durable registry, memory/corpus, cache, approval store, tenant roots, local-to-team migration, backup/restore/archive, and integrity checks | raw features log `F9` |
| In-memory defaults are useful for tests but risky for product paths | raw optimization log `O15`, `OPT-EPIC-015` |
| Memory exists but is not wired as a durable default runtime capability | raw audit log `A13`, `AUD-EPIC-013` |
| Run-store is currently file-backed and versioned | `packages/run-store/src/index.ts` |
| Registry, trust, broker cache, and memory runtime still have in-memory defaults | `packages/harness-loader/src/*`, `packages/tool-broker/src/index.ts`, `packages/memory/src/*` |
| Remote/team/server persistence remains a separate gate | FEAT-012A public runtime server-mode packet dossier |
| Package dependencies and release posture remain separate gates | existing package and release decision records |

## Diff Boundary

This record does not approve or implement backend code, database dependencies, object-store dependencies, package manifests, generated contracts, migrations, runtime wiring, CLI/server configuration, memory default wiring, registry persistence, cache persistence, queue/lock/server state, docs beyond this decision record, tests, fixtures, CI/release workflows, GitHub settings, package publishing, raw-source edits, or wiki status edits. Those remain separate packets and gates.
