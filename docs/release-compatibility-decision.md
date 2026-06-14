# Release Compatibility Decision

Status: accepted for downstream packet planning
Work unit: FEAT-013A-release-compatibility-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Product/package assumptions: Specwright is a governed agent workflow runtime; first-wave public packages are `@specwright/cli`, `@specwright/runtime`, `@specwright/harness-loader`, and `@specwright/schemas`; `@specwright/mcp-server` is a later public package target.

## Decision

Specwright needs one product-level release compatibility system above the existing package-local primitives.

The release system should define:

- Semver rules for public packages, runtime contracts, schema contracts, protocol contracts, run packages, harnesses, adapters, host command packs, configuration formats, SDK extensions, and capability packs.
- A product compatibility matrix that is manually curated at first and later partially generated from schema, harness, MCP, adapter, package, and release evidence.
- A release checklist that blocks public release until CI, package dry runs, compatibility reports, changelog/migration notes, provenance, rollback review, and docs checks are complete.
- A provenance story that binds Git tags, GitHub releases, package artifacts, npm provenance, compatibility reports, changelog entries, and audit evidence to the same source revision.
- A downgrade and rollback posture that preserves replayability and tenant safety instead of promising unsupported rollback for incompatible contract changes.

This decision record does not create release automation. It defines the release policy that later release, CI, package, docs, and compatibility packets must implement.

## Semver Policy

Specwright follows semver for public packages and uses stricter compatibility gates for runtime-observable behavior.

| Version class | Product rule |
| --- | --- |
| Major | Required for removed or renamed public APIs, removed contract ids, incompatible runtime event semantics, incompatible run-package format changes, unsupported config migrations, adapter/host behavior that breaks the CLI reference contract, MCP protocol breaks, or security changes that intentionally reject formerly accepted public behavior. |
| Minor | Allowed for additive public APIs, new commands, new MCP tools/resources/prompts, new schemas, new adapter/host packs, new capability packs, new report fields, and forward-compatible contract additions that older supported consumers can ignore. |
| Patch | Allowed for bug fixes, documentation corrections, internal refactors, redaction tightening that does not require migration, deterministic output fixes within an existing contract, and compatibility-test coverage additions. |
| Prerelease | Required before first public release and for any package or surface whose compatibility contract is still experimental, host-specific, or not covered by the product matrix. |
| Experimental | Allowed only behind explicit labels in the compatibility matrix. Experimental surfaces can change without semver compatibility promises, but they cannot be documented as generally supported. |

Internal classifier labels such as `patch-compatible`, `additive-compatible`, `forward-compatible`, `backward-compatible`, `migration-required`, and `breaking` feed release review, but they do not by themselves determine a public version bump. The release decision must consider all public surfaces affected by a change.

## Compatibility Surfaces

The product compatibility matrix must cover each public or planned surface explicitly.

| Surface | First policy | Owner |
| --- | --- | --- |
| Public package names and entrypoints | Required before first publish. Package names, bins, exports, files, Node/Bun support, and dependency rewrite rules are release-gated. | Package taxonomy and release packets |
| Runtime API | Required. Public RuntimeApi methods, event effects, failure classes, and replay behavior are semver-governed. | Runtime and adapter-parity packets |
| Schema contracts | Required. Contract ids, hashes, redaction classes, event payloads, generated validators, and compatibility reports are release-gated. | Schemas package and release packets |
| Harness manifests and harness packages | Required. Harness schema versions, migration descriptors, trust store behavior, and loader admission are matrix rows. | Harness-loader and SDK packets |
| Run packages | Required. Event ledger format, projection compatibility, retention state, audit bundles, and replay fixtures are release-gated. | Run-store, run-reports, operations |
| CLI commands and output | Required. Command names, flags, JSON envelopes, exit classes, redaction posture, and human-output changes are release-gated. | CLI taxonomy and docs packets |
| MCP contracts | Required once the server package exists. Protocol version range, tool/resource/prompt contract versions, deprecations, and migration notes are matrix rows. | MCP server and adapter packets |
| Host command packs | Required before support is advertised. Pack manifests, install paths, command ids, permission profiles, and host compatibility tags are matrix rows. | Host command-pack packets |
| Config and naming formats | Required before public init/migration commands. Canonical config layout, legacy support, warnings, migration command posture, and rollback behavior are matrix rows. | Naming migration and CLI packets |
| SDK and marketplace extensions | Deferred until SDK governance is accepted. Extension APIs, registry trust, example compatibility, and marketplace policy become matrix rows then. | SDK and release packets |
| Capability packs | Deferred until capability-pack taxonomy is accepted. Capability manifests, isolation tiers, permissions, runners, and safety defaults become matrix rows then. | Capability-pack and release packets |
| Public server mode | Deferred until server-mode policy is accepted. Transport, auth, tenant isolation, queueing, persistence, and operations compatibility become matrix rows then. | Server-mode and release packets |

No surface should be omitted from the matrix. Unsupported, deferred, experimental, and private surfaces must be labeled so the public promise is legible.

## Matrix Ownership

The first product compatibility matrix should live in repo docs as a reviewed source-of-truth table, then gain generated inputs as implementation packets mature.

| Matrix input | Current posture |
| --- | --- |
| Manual product matrix | Missing. This is the first release-policy target for a later docs/release packet. |
| Schema compatibility report | Exists as an internal generated artifact. Current report shows 1 additive-compatible contract, 11 migration-required contracts, 88 unchanged contracts, 12 changed contract ids, 11 migration requirements, 11 unsupported historical versions, and a "migration review required before release" summary. |
| Harness-loader matrix | Exists as package-local substrate with current load and historical migrate rows. It is not a full product matrix. |
| Operations compatibility classifier | Exists for release-change classification and promotion/rollback review. It is not a public semver policy. |
| Operations release promotion and rollback | Exists for tenant-scoped promotion, replay fixture checks, approvals, rollback state, and audit records. It is not package publishing automation. |
| Gate-engine changelog entry schema | Exists as package-local schema for compatibility-classed gate-engine changes. It is not the product changelog. |
| MCP versioning | Exists for a pinned protocol range and tool/resource/prompt contract metadata. It is not an executable MCP server release policy yet. |

The later implementation should keep the manual product matrix reviewable while letting generated reports attach evidence. Generated reports can block release, but a human-readable product matrix remains required for public docs and support promises.

## Changelog And Migration Notes

Every public release must have a changelog entry and release note.

Required sections:

- Summary.
- Public packages changed.
- Runtime/API changes.
- Schema and generated contract changes.
- CLI command and output changes.
- MCP/server changes.
- Host command-pack changes.
- Harness, SDK, and capability-pack changes.
- Config and migration notes.
- Security and redaction changes.
- Compatibility matrix changes.
- Breaking changes and deprecations.
- Upgrade steps.
- Downgrade and rollback notes.
- Verification checklist and provenance links.

Breaking-change entries must name the affected surface, previous behavior, new behavior, migration path, compatibility class, test evidence, and removal/deprecation dates when applicable.

Migration notes must be runnable or explicitly manual. If a migration command does not exist yet, the release must say so and block public support for that upgrade path.

## Release Checklist

No public release should proceed until the checklist is complete.

| Step | Required evidence |
| --- | --- |
| Source revision | Clean branch, reviewed PR, protected branch result, and exact commit SHA. |
| CI | Required checks for build, typecheck, policy validation, dependency checks, source-cycle checks, unused-code guardrails, package tests, schema compatibility, adapter parity, MCP conformance, release readiness, and docs/install smoke as applicable. |
| Package dry run | Pack artifacts, file lists, entrypoints, declarations, bins, dependency rewrites, private-file exclusions, and install smoke in a clean project. |
| Compatibility report | Product matrix diff, schema compatibility report, harness compatibility rows, adapter parity evidence, MCP contract/versioning evidence, host-pack compatibility evidence, and run-package replay evidence. |
| Changelog and migration notes | Release notes with compatibility and migration sections. |
| Docs | Install, command, MCP, host, capability, security, approval, troubleshooting, and release docs updated for supported surfaces. |
| Provenance | Git tag, GitHub release, package provenance, artifact hashes, generated report hashes, and audit evidence linked to the same source revision. |
| Security and redaction | Secret scan or equivalent release review, redaction-sensitive diff review, and auth/profile review for server or hosted surfaces. |
| Rollback review | Downgrade support, rollback limitations, tenant rollout posture, replay fixtures, and unsupported rollback warnings recorded. |
| Publish approval | Human release approval recorded before tag, GitHub release, npm publish, or public package promotion. |

## Provenance Requirements

Release artifacts must be traceable.

- Git tags must be immutable release anchors after publication.
- GitHub releases must link the tag, release notes, compatibility matrix, package list, and verification evidence.
- npm packages must use provenance when available and must not publish workspace-only dependency specifiers.
- Package tarballs must have captured file lists and artifact hashes.
- Generated compatibility reports must be regenerated from the release revision and referenced from the release notes.
- Audit evidence must include CI results, package dry-run output, matrix decisions, migration-review decisions, and approval records.
- Any manual override must record the actor, reason, affected surfaces, expiration if any, and rollback plan.

## Downgrade And Rollback

Specwright supports rollback only when compatibility evidence says rollback is safe.

| Scenario | Policy |
| --- | --- |
| Patch-compatible change | Rollback may be supported if run-package replay and package install smoke pass. |
| Additive-compatible change | Rollback may be supported only when new fields, commands, tools, or contracts are optional and ignored by older supported consumers. |
| Forward-compatible change | Older producers with newer readers can be supported, but downgrade of readers may be blocked. |
| Backward-compatible change | New producers with older readers can be supported only when matrix rows and tests prove it. |
| Migration-required change | Public release must include migration notes and may block downgrade unless a signed reverse migration exists. |
| Breaking change | Major release required. Downgrade is unsupported unless a separate rollback plan and compatibility shim are accepted. |

Run packages and audit ledgers remain authoritative. No rollback path may rewrite append-only ledgers, erase provenance, or silently reinterpret historical runs.

## Deprecation Lifecycle

Deprecations require a visible lifecycle:

1. Announce with replacement, migration note, affected surfaces, and earliest removal release.
2. Add compatibility matrix rows and tests that prove old and new behavior for the support window.
3. Warn through CLI/MCP/host/docs surfaces where applicable without widening authority.
4. Block removal until the release checklist includes migration evidence.
5. Remove only in a major release unless the surface was explicitly experimental.

## Current Repo Evidence

Live source and GitHub state on this branch show:

- There are no local or remote tags.
- There are no GitHub releases.
- There are no open GitHub issues.
- The current open PR set is the draft stacked productization chain #74 through #90.
- `main` is protected with strict required status checks, but only `Policy validation` is required.
- Current `origin/main` is `b77c6b0be404e646d908d860409336a6d1f8c5e9` and has zero check runs and zero commit statuses.
- Root scripts include build, test, typecheck, proof, dependency, cycle, package packlist dry-run, unused-code, and core-test commands, but no root release, publish, changelog, full release dry-run, or release-readiness command.
- The root package is private.
- All 17 workspace packages are private and versioned `0.0.0`.
- First-wave package manifests now have npm-facing metadata and provenance-oriented `publishConfig`, and `check:pack` verifies their npm packlists; all packages remain private and workspace dependency rewriting, full release dry-run, install smoke, and release approval remain unresolved.
- No top-level changelog, release notes, release checklist, package provenance policy, or product-level compatibility matrix was found.
- Internal compatibility primitives exist in operations, schemas, harness-loader, gate-engine, and MCP adapter packages, but they do not yet form a public release discipline.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Public package versions, dependency rewrites, full package dry-run, and install smoke | Package implementation and release packets |
| Authoritative required checks and release CI | CI decision and release automation packets |
| Branch protection, release branch policy, and GitHub settings | GitHub/repository governance packets |
| Product compatibility matrix docs | Release compatibility plus docs/install UX packets |
| Schema contract-diff CI and generated report policy | Schemas and release packets |
| Runtime/API compatibility tests | Runtime and adapter-parity packets |
| MCP compatibility and server release posture | MCP server and release packets |
| Host command-pack compatibility | Host command-pack packets |
| Naming/config migration compatibility | Naming migration and CLI packets |
| SDK and marketplace compatibility | SDK governance packet |
| Capability-pack compatibility and safety tiers | Capability-pack packet |
| Durable backend migration, backup, restore, and archive policy | Durable backend and release packets |
| Release notes, changelog, docs, and troubleshooting | Docs/install UX packet |

## Source Trace

| Claim | Source |
| --- | --- |
| Release system needs semver, matrices, changelog, migrations, and validation | raw features log `F13`, `FEAT-EPIC-013`, `FEAT-TASK-013.1` through `FEAT-TASK-013.5` |
| Public package set is staged and package publishability is unresolved | `docs/package-taxonomy-decision.md`, package manifest inventory |
| Release readiness gaps include tags, releases, checks, package provenance, changelog, and compatibility policy | repository release-readiness test and live GitHub checks |
| Operations package has compatibility classification and tenant promotion/rollback substrate | `packages/operations/src/compatibility.ts`, `packages/operations/src/release.ts` |
| Schema package generates a contract compatibility report with migration review currently required | `packages/schemas/src/compatibility.ts`, schema compatibility report |
| Harness-loader has compatibility matrix and migration admission substrate | `packages/harness-loader/src/compatibility/matrix.ts`, `packages/harness-loader/src/compatibility/admission.ts` |
| Gate-engine has compatibility-classed changelog entry schema | `packages/gate-engine/src/compatibility.ts` |
| MCP adapter has protocol range and contract versioning substrate | `packages/adapters-mcp/src/versioning/index.ts` |
| Host command-pack compatibility depends on the host decision record | `docs/host-command-pack-decision.md` |

## Diff Boundary

This record does not approve or implement source changes, generated compatibility artifact updates, package manifest edits, changelog or release-note files, CI workflows, release scripts, tags, GitHub releases, branch protection changes, GitHub settings, npm publish operations, package provenance setup, raw-source edits, wiki status edits, or compatibility-matrix automation. Those remain separate packets and gates.
