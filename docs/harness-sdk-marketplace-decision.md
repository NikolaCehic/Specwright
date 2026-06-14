# Harness SDK And Marketplace Decision

Status: accepted for downstream packet planning
Work unit: FEAT-008A-harness-sdk-marketplace-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Package/distribution assumption: the SDK and marketplace model follows the package taxonomy, capability-pack taxonomy, and release-compatibility decisions; no SDK package or marketplace is created by this record.

## Decision

Specwright should productize an SDK and extension distribution model in staged waves:

1. Define the SDK contract vocabulary for harness packages, capability packs, validators, adapters, commands, stores, policies, gates, evals, and docs/examples.
2. Reserve a public `@specwright/sdk` package as the eventual authoring entrypoint, but do not create it until package metadata, exports, release compatibility, docs, and install smoke checks are ready.
3. Use the existing harness-loader governance primitives as the first trusted-package substrate: manifest validation, trust verification, capability grants, dependency pinning, compatibility admission, migration descriptors, and registry lifecycle.
4. Start distribution with a curated local registry/index and package-registry metadata, not a hosted marketplace.
5. Make source-bound planning the first reference extension example because the default harness already proves that shape without widening runtime authority.

The SDK is an authoring and validation surface. It must not become a runtime bypass. Extensions can declare capabilities, commands, hooks, or stores only through manifests and contracts that the runtime, broker, policy engine, compatibility matrix, and release gates admit.

## SDK Boundary

| Boundary | Decision | Downstream owner |
| --- | --- | --- |
| Package shape | Reserve `@specwright/sdk` as a later public package that re-exports stable authoring types, validators, manifest helpers, test harnesses, and template entrypoints. | Package implementation packet after package taxonomy and release gates. |
| Current exports | Do not expose new public SDK exports from existing packages in this packet. Existing `@specwright/harness-loader` and `@specwright/schemas` exports remain implementation substrate. | SDK implementation packet. |
| Generated contracts | Reuse generated schema and registry artifacts only after the contract-registry owner approves SDK-facing export policy. | Shared-schema/package release packets. |
| Runtime API access | SDK consumers do not call private runtime internals. Runtime-facing behavior must go through public runtime APIs, adapters, CLI, or MCP/server surfaces once those are accepted. | Runtime, adapter-parity, CLI, and server packets. |
| Templates | Templates are allowed only after manifest schema, validation, package metadata, and fixture tests exist. | SDK scaffold packet plus docs/install UX. |
| Marketplace client | Deferred. The first wave should validate metadata and local/curated indexes before any hosted marketplace API. | Registry/marketplace implementation packet. |

The SDK package should be publishable only after it has a compatibility policy, package metadata, docs, install smoke coverage, and a release matrix row.

## Extension Kinds

| Extension kind | First posture | Deferred work |
| --- | --- | --- |
| Harness packages | First supported extension vocabulary. A package declares phases, gates, policies, tools, artifacts, evals, roles, prompts, metadata, dependencies, grants, trust, and compatibility. | Public packaging, examples, docs, and arbitrary CLI selection. |
| Capability packs | Supported as a manifest and validation target after FEAT-007A. Packs declare project support, checks, capability requests, grants, permissions, detection metadata, and distribution metadata. | Runtime capability execution, mutating tools, runner implementations, and public pack publishing. |
| Validators | First SDK implementation target after package setup. Validators check manifests, trust metadata, grant bounds, dependencies, compatibility, migrations, and package tests. | CLI command wiring, marketplace admission service, and docs. |
| Adapters | Vocabulary reserved. Adapter extensions require a common adapter contract and parity tiers before SDK exposure. | Codex, Claude Code, OpenCode, HermesAgent, MCP, and CLI adapter packages beyond the reference CLI. |
| Commands | Vocabulary reserved for CLI and host command packs. Commands must map to approved product commands and output contracts. | New CLI commands, host commands, scaffold commands, and command-pack installers. |
| Stores and backends | Vocabulary reserved for durable registry, run, artifact, memory, cache, approval, and corpus stores. | Durable backend interfaces, migrations, locks, tenant roots, and backup/restore. |
| Policies, gates, and evals | Vocabulary reserved for governed extension points. They must carry schema contracts, authority semantics, fixtures, and compatibility classes. | Public authoring helpers, marketplace review rules, and release admission. |
| Docs and examples | Source-bound planning is first. Code review, implementation, security review, PR verification, docs audit, frontend QA, and release readiness examples are later waves. | Example packages, tutorial docs, public templates, and smoke projects. |

No extension kind is product-supported until its contract, validation, tests, compatibility posture, and distribution metadata exist.

## Governance And Trust Model

SDK and marketplace governance must preserve the existing harness-loader fail-closed posture.

| Governance area | Required rule |
| --- | --- |
| Publisher identity | Every distributable extension has a publisher id, signing key id, review authority, support owner, and lifecycle state. |
| Signing and trust | Strict admission requires signed attestations, a trusted key, matching spec hash, valid signature dates, and supported algorithm metadata. |
| Promotion approval | Registry promotion requires staged package bytes, dry-run validation, verified trust evidence, and recorded approval. |
| Grant registry | Extension authority is bounded by a grant registry. Over-granted tools, policy effects, policy layers, runtime-invariant tool ids, or missing grants fail closed. |
| Dependency pinning | Dependencies must resolve to reviewed pins with content hashes and trust tiers where applicable. Unresolved, unpinned, mismatched, or conflicting dependencies fail closed. |
| Compatibility admission | Runtime version, harness schema version, package version, support class, loader behavior, and migration requirements must match an approved compatibility matrix row. |
| Migration descriptors | Required migrations need signed descriptors, trust-store validation, source/target schema agreement, and hash-bound migrated output. |
| Quarantine and revocation | Quarantine and revocation remove trusted-cache entries and prevent stale dependency dependents from remaining trusted by implication. |
| Review state | Marketplace entries must expose draft, candidate, trusted, deprecated, quarantined, and revoked states rather than presenting every package as installable. |
| Provenance | Listing, validation, promotion, install, and execution claims must cite hashes, signatures, registry version, compatibility row, and validation evidence. |

Marketplace review is an authority boundary. A listing can recommend an extension, but runtime execution still requires policy, grants, approvals, broker support, and compatibility admission.

## Validation And Scaffolding

The first SDK implementation should make validation boring and strict before it makes extension creation easy.

| Validation class | Required coverage |
| --- | --- |
| Manifest validation | Required fields, schema version, package id/version, metadata, declared extension kind, unknown-field policy, and extension namespace behavior. |
| Permission and grant validation | Requested tools, tool definitions, approval-required tools, policy effects, policy layers, runtime-invariant ids, and over-grant denial. |
| Command schema validation | Command ids, inputs, outputs, redaction profile, exit/outcome classes, and unsupported command behavior. |
| Runtime hook validation | Hook names, event shapes, authority boundaries, lifecycle placement, idempotency expectations, and failure classification. |
| Contract compatibility | Contract registry status, extension points, compatibility class, migration descriptor refs, generated artifacts, and conformance fixtures. |
| Dependency and trust validation | Reviewed pins, content hashes, trust tiers, signatures, attestations, publisher identity, and revocation state. |
| Package tests | Positive/negative fixtures, dry-run validation, fail-closed paths, redaction/provenance checks, cache/replay posture, and install-smoke readiness. |

`specwright harness init` is a product-worthy command, but it belongs to a later CLI/scaffold packet. That packet must decide the command name, template files, package manager support, docs, generated fixtures, and whether it writes a local project config.

## Registry And Marketplace Metadata

The first marketplace model should be a curated registry/index that can be checked into source, loaded from a package, or mirrored by an enterprise tenant. A hosted marketplace can come later.

| Metadata field | Required content |
| --- | --- |
| Listing identity | Extension id, display name, kind, version, publisher id, support owner, lifecycle state, review state, and support tier. |
| Compatibility | Specwright package ranges, schema contract versions, runtime version range, harness schema version, capability-pack profile, host/server requirements, and migration requirements. |
| Authority | Requested tools, capability kinds, risk level, policy layers, approval requirements, sandbox/isolation tier, network posture, shell posture, write posture, and denied-by-default behavior. |
| Trust signals | Signature ref, signing key id, trust-store version, attestation hash, package spec hash, review approval id, dependency pin status, and quarantine/revocation state. |
| Installation | Package registry name, tarball or source ref, install command template, peer dependencies, supported package managers, and offline/enterprise mirror notes. |
| Validation | Manifest validation status, compatibility status, package test status, conformance fixture refs, install-smoke status, and known unsupported modes. |
| Documentation | Summary, use cases, examples, changelog ref, migration notes, troubleshooting refs, and security notes. |

Marketplace search and install UX should never hide blocked prerequisites. If a pack requires a missing runner, unsupported host, unavailable command, or unresolved release matrix row, the listing must say so.

## Compatibility Relationship

SDK and marketplace compatibility is additive to the existing release decision.

- SDK package versions must align with product release compatibility.
- Extension manifests must declare the Specwright contract versions they target.
- Harness package admission must use the harness compatibility matrix before load or migration.
- Contract changes use the compatibility classes from the operations and schema registry surfaces.
- Backward extensions are allowed only at declared extension points.
- Breaking or migration-required changes need migration descriptors, fixtures, and release notes before marketplace promotion.
- Marketplace listings must separate compatible, migratable, deprecated, quarantined, and revoked entries.
- Example extensions are compatibility fixtures, not marketing-only samples.

## Example Extension Scope

The first reference extension should be a source-bound planning harness package.

Why this example goes first:

- The current default harness already demonstrates a source-bound planning flow.
- It uses read-only filesystem list/read plus eval execution and denies write, shell, git, and network authority by omission.
- It can prove manifests, trust metadata, grants, dependencies, compatibility, package tests, and docs without requiring mutating runners.
- It is a bridge from the current v0 fixture toward an installable extension story.

Later examples should be added in this order only after their prerequisites exist: code review, PR verification, docs audit, implementation, security review, frontend QA, and release readiness.

## Current Repo Evidence

Live source on this stacked branch shows:

- The repository has 17 private workspace packages.
- No package directory matching SDK, marketplace, extension, scaffold, or template exists.
- `@specwright/harness-loader` exports manifest loading, trust verification, capability grants, dependency pinning, compatibility admission/matrix, migration descriptors, registry lifecycle, provenance, limits, and snapshot cache primitives.
- `HarnessRegistry` stages candidates, promotes only after dry-run validation, verified trust evidence, and recorded approval, and supports deprecate, quarantine, revoke, and trusted resolution paths.
- Trust verification uses publisher ids, signing key ids, ed25519 signatures, trust-store versions, attestations, spec hashes, and strict-mode rejection for unsigned packages.
- Capability grants define allowed tools, approval-required tools, tool definitions, policy effects, policy layers, and runtime-invariant tool ids; missing or over-broad grants fail closed.
- Dependency resolution requires reviewed pins and content hashes; unresolved, unpinned, mismatched, conflicting, or trust-tier-invalid dependencies fail closed.
- Compatibility admission checks runtime version, harness schema version, package version, support class, loader behavior, and signed migration descriptors when migration is required.
- `harnesses/default` is the only harness fixture found. It permits `fs.list`, `fs.read`, and `eval.run`, with write, shell, git, and network denied by omission.
- CLI help advertises `--harness <id-or-path>`, but the current CLI validation accepts only the default harness id.
- Schema registry contracts expose extension-point metadata, compatibility classes, generated artifacts, conformance fixtures, and public/internal status, but no SDK-facing package boundary has been created.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Public SDK package, exports, package metadata, and install smoke | Package and SDK implementation packets |
| SDK manifest and marketplace schemas | SDK implementation plus shared-schema packets |
| Extension validation command | CLI and SDK validation packets |
| `specwright harness init` scaffold command | CLI taxonomy and SDK scaffold packets |
| Curated registry/index and marketplace metadata | SDK registry/marketplace packet |
| Hosted marketplace service | Public server or managed-service packet after tenant/auth decisions |
| Capability-pack SDK integration | Capability-pack implementation packets |
| Adapter extension contracts | Adapter-parity packet |
| Command extension contracts | CLI and host command-pack packets |
| Durable store extension contracts | Durable backend packet |
| Public examples and tutorials | Docs/install UX packet after reference extension works |
| Release compatibility rows, changelog, provenance, and publish gates | Release compatibility packet |
| GitHub settings, tags, package publish, and marketplace publication | Release/GitHub operations packets |

## Source Trace

| Claim | Source |
| --- | --- |
| Specwright needs an SDK, extension interfaces, validation tooling, and marketplace or registry model | raw features log `F8`, `FEAT-EPIC-008` |
| Extension interfaces should cover adapters, capability packs, commands, stores, and validators | `FEAT-TASK-008.1` |
| A scaffolding command and template are backlog targets | raw features log `F8`, `FEAT-TASK-008.2` |
| Extension validation must cover manifests, compatibility, permissions, command schemas, and runtime hooks | `FEAT-TASK-008.3` |
| Marketplace metadata needs listing fields, version constraints, trust signals, and install commands | `FEAT-TASK-008.4` |
| First examples should prove source-bound planning and later common workflows | raw features log `F8`, `FEAT-TASK-008.5` |
| Harness-loader already has trust, registry lifecycle, grants, dependency pins, compatibility, and migration primitives | `packages/harness-loader/src/*` |
| No SDK, marketplace, extension, scaffold, or template package directory exists today | package inventory search |
| CLI harness selection is not yet arbitrary despite help text | `packages/adapters-cli/src/index.ts` |
| Package taxonomy, capability packs, release compatibility, host packs, server mode, and docs/install UX are separate gates | existing decision records in `docs/` |

## Diff Boundary

This record does not approve or implement SDK packages, marketplace services, registry indexes, package manifests, generated contracts, source modules, scaffold templates, validation commands, example extensions, harness fixture changes, CLI/MCP/host code, runtime behavior, broker registry changes, capability execution, store backends, docs beyond this decision record, CI/release workflows, GitHub settings, package publishing, raw-source edits, or wiki status edits. Those remain separate packets and gates.
