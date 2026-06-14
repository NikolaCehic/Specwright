# Naming Migration Policy Decision

Status: accepted for downstream packet planning
Work unit: FEAT-014A-archetype-specwright-migration-policy-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Product/CLI/release/docs assumptions: Specwright is the canonical product name; `specwright` is the installed CLI command target; release compatibility and docs/install UX remain separate packets.

## Decision

New Specwright projects should use a canonical Specwright state directory. Existing projects that use the legacy Archetype state directory must remain readable during a deprecation window and must migrate through an explicit CLI-owned migration command before the default runtime storage path changes.

The migration is not automatic. It must be operator-initiated, dry-run capable, reversible when safe, and blocked when legal hold, retention, integrity, or conflict checks say migration would be unsafe.

This decision record does not change runtime paths. It records the policy and downstream packet map required before any storage behavior changes.

## Canonical Layout

The canonical Specwright state directory should own product runtime state, project configuration, and local integration metadata. The first layout should reserve these areas:

| Area | Purpose | First owner |
| --- | --- | --- |
| `runs` | Active and completed run packages, event ledgers, projections, evidence, artifacts, reports, traces, evals, and policy records. | Run-store and runtime packets |
| `archives` | Archived run packages, tombstones, restore metadata, and retention audit evidence. | Run-store retention packets |
| `config` | Project configuration, profile selection, root policy, redaction profile, and local runtime settings. | CLI config packet |
| `memory` | Local memory indexes, corpus manifests, embedding metadata, tombstones, and replay pins when memory is enabled. | Memory and durable-backend packets |
| `command-packs` | Installed host command-pack metadata and compatibility tags. | Host command-pack packet |
| `capability-packs` | Installed capability-pack manifests, runner metadata, and safety profiles. | Capability-pack packet |
| `server` | Future local or team runtime server state, auth profile metadata, queue metadata, and process bookkeeping. | Server-mode and durable-backend packets |
| `migrations` | Migration plans, dry-run reports, approval records, rollback manifests, and migration audit evidence. | CLI migration and operations packets |

The exact filenames inside each area remain implementation details until the owning packet defines fixtures and compatibility tests.

## Legacy Support Policy

Legacy Archetype state directories remain supported as read-compatible input during the first public migration window.

| State | Policy |
| --- | --- |
| Clean new project | `specwright init` creates only the canonical Specwright state directory after the CLI config packet is implemented. |
| Legacy-only project | Runtime read paths may continue to read legacy state until migration support ships. The CLI should warn once per command family after warning behavior is implemented. |
| Canonical-only project | Runtime and CLI use canonical state after the storage-path implementation packet changes defaults. |
| Mixed project | Commands fail closed until `specwright migrate-store --resolve-conflicts` or a documented manual resolution path succeeds. |
| Partially migrated project | Commands fail closed unless a rollback manifest proves the prior state can be restored or a resume operation can complete safely. |
| Sealed, retained, archived, or legally held runs | Migration is blocked unless the retention/legal-hold packet explicitly allows a metadata-only migration without moving authoritative bytes. |

The support window must be announced in release notes before any rejection behavior ships. Rejection of legacy-only projects requires a major-version or explicitly experimental-surface removal decision under the release compatibility policy.

## Migration Command Posture

The migration command should be owned by the public CLI and implemented as a thin command over run-store and operations APIs.

Target command:

- `specwright migrate-store`

Required modes:

| Mode | Behavior |
| --- | --- |
| Dry run | Inspect roots, inventory legacy and canonical state, classify conflicts, estimate affected runs, and write no data. |
| Apply | Copy or move state through atomic staging, validate migrated run packages, write migration records, and preserve rollback manifests. |
| Resume | Continue a previously interrupted migration only when the migration plan and hashes still match. |
| Rollback | Restore prior layout when rollback evidence exists and no retained or legally held state would be violated. |
| Verify | Re-read migrated state, replay representative runs, validate reports/audit bundles, and emit a stable JSON result. |

The command must never silently delete legacy state. Deletion or archival of old state belongs to a later retention/release packet after backup, legal hold, and rollback policy are implemented.

## Safety Model

Migration must be fail-closed.

- Dry run is the default posture for ambiguous roots.
- All filesystem writes occur through staged directories or temp paths before a final atomic switch.
- Every copied or moved run package must preserve event ledger bytes unless an approved run-package migration descriptor says otherwise.
- Existing run-package migration primitives may update projections or derived records, but not authoritative events.
- Legal holds and retention state dominate migration convenience.
- Archive and hard-delete state must not be rewritten without operations approval records.
- Mixed legacy/canonical roots require explicit conflict resolution.
- Migration records must include source layout, target layout, package hashes, actor, timestamp, tool version, decision hash, and rollback reference.
- CLI output must use stable JSON envelopes and classified failures.
- MCP, host packs, reports, and docs must not assume migration support until the CLI command and compatibility tests exist.

## Fixture And Output Contract Posture

Existing fixtures and output contracts stay on the current runtime default until a named implementation packet updates them.

| Surface | Policy |
| --- | --- |
| CLI output-contract fixtures | Preserve current expected paths until the runtime default changes under a dedicated migration implementation packet. |
| MCP audit and observability tests | Preserve current path behavior until MCP compatibility rows and migration tests exist. |
| Run-store fixtures | Preserve existing fixtures; add new before/after migration fixtures in a later packet. |
| Reports and audit bundles | Preserve current paths in existing fixtures; add compatibility assertions for migrated projects later. |
| Generated artifacts | Do not regenerate solely for this decision record. Schema/report generation belongs to implementation packets. |
| Docs | The migration guide belongs to the docs/install UX packet after command behavior is implemented. |

## Downstream Packet Map

| Work | Owner |
| --- | --- |
| Canonical layout implementation and config root discovery | CLI config/naming implementation packet |
| Runtime default path change | Run-store/runtime migration implementation packet |
| Legacy read shim and warnings | Run-store, CLI, MCP, and host adapter packets |
| `specwright migrate-store` command | CLI migration packet backed by run-store and operations APIs |
| Conflict detection, resume, rollback, and legal-hold handling | Run-store retention plus operations packets |
| Fixture and output-contract updates | CLI, MCP, run-store, reports, and test packets |
| Product compatibility matrix rows | Release compatibility packet |
| Migration guide and troubleshooting | Docs/install UX packet |
| Host command-pack update notes | Host command-pack packet |
| Durable backend migration relationship | Durable backend packet |

Every FEAT-014 task is assigned: layout to CLI/config and run-store packets, command design to CLI migration, compatibility shims to runtime/adapter packets, tests to migration fixture packets, and guide work to docs/install UX.

## AUD-015A Relationship

AUD-015A remains the executable inventory companion. This policy record uses that inventory as evidence and does not replace it.

Current inventory evidence on this stacked branch:

- The run-store default still points to the legacy Archetype state directory.
- The tracked-file scan finds 15 legacy-name files including ignore policy, or 14 excluding ignore policy.
- The tracked-file scan finds 8 canonical-name files.
- Direct production legacy path construction is limited to run-store, run-reports retention, MCP audit writer, and MCP observability correlation sites.
- Canonical state-path evidence is limited to MCP packet test helpers; other canonical-name matches are product identifiers or grant/migration identifiers.
- There is no approved product migration command yet.

## Release And Deprecation Relationship

Release compatibility owns deprecation timing and public support promises.

The first release that documents migration support must include:

- Supported source and target layouts.
- Whether the migration command is preview, experimental, or stable.
- Dry-run and rollback limitations.
- Known unsupported mixed-layout cases.
- Legal-hold and retention limitations.
- Fixture compatibility and output-contract changes.
- Removal date, if legacy behavior is ever scheduled for rejection.

No release may remove legacy read support without a compatibility-matrix row, migration guide, test evidence, and release approval.

## Source Trace

| Claim | Source |
| --- | --- |
| Product identity should converge on Specwright state naming while preserving migration behavior | raw features log `F14`, `FEAT-EPIC-014` |
| FEAT-014 requires canonical layout, migration command design, compatibility behavior, tests, and guide | `FEAT-TASK-014.1` through `FEAT-TASK-014.5` |
| Legacy naming remains inventoried and must be assigned to migration policy | `AUD-015A` naming migration inventory test |
| Runtime default still uses the legacy state directory | `packages/run-store/src/index.ts`, AUD-015A inventory |
| Migration must preserve authoritative ledgers and fail closed on unsafe migrations | run-store migration and retention tests |
| Release/deprecation promises belong to the release compatibility policy | `docs/release-compatibility-decision.md` |
| CLI command ownership and config discovery belong to CLI/naming packets | `docs/cli-command-taxonomy-decision.md` |

## Diff Boundary

This record does not approve or implement runtime path changes, compatibility shims, warning behavior, migration command code, fixture rewrites, output-contract updates, report path updates, MCP behavior changes, docs pages, generated artifacts, package manifest edits, CI workflow changes, release operations, GitHub settings, raw-source edits, or wiki status edits. Those remain separate packets and gates.
