# Capability-Pack Taxonomy Decision

Status: accepted for downstream packet planning
Work unit: FEAT-007A-capability-pack-taxonomy-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Default-capability assumption: the current runtime default remains read-only filesystem list/read; broader authority requires explicit capability-pack implementation, policy, tests, and release compatibility.

## Decision

Specwright capability packs should be productized as explicit, versioned bundles that declare capability definitions, harness grants, checks, safety posture, detection rules, and compatibility tags. A pack may recommend authority, but it cannot grant authority by itself. Runtime execution still flows through `ToolBroker`, policy evaluation, approval handling, redaction, provenance, cache/replay controls, and sanctioned runner contracts.

The first implementation order should be:

1. Base repository pack.
2. TypeScript and JavaScript pack.
3. Docs-only pack.
4. Python pack.
5. Monorepo pack.
6. Package-manager and test-runner pack.
7. Git pack.
8. Patch/write pack.
9. Browser pack.
10. Model, embeddings, memory, and external MCP packs.
11. Secret scanning/redaction and artifact-writer packs.

The first five packs should focus on detection, read-only discovery, checks, and safe command planning. Mutating capabilities remain deferred until their runners, policies, approvals, and negative fixtures exist.

## First Pack Families

| Pack family | Supported project types | First posture | Deferred authority |
| --- | --- | --- | --- |
| Base repository | Any repository with files and optional VCS metadata | Read-only discovery, workspace inventory, package/config detection, source-map hints, and report scaffolding | Writes, shell, git mutation, package install, and network |
| TypeScript and JavaScript | npm, pnpm, yarn, bun, TS/JS monorepos, Node packages, web apps | Detect manifests, scripts, lockfiles, tsconfig, test/lint/build commands, and source roots | Running package scripts, installing packages, browser tests, code edits |
| Docs-only | Markdown/docs repos, docs folders inside code repos, changelog/release docs | Detect docs tree, link/reference structure, generated-doc boundaries, and prose checks | Doc rewriting and publish/deploy actions |
| Python | Python packages, scripts, pyproject/setup/requirements projects | Detect env files, package metadata, tests, linters, and source roots | Virtualenv creation, package install, test execution, code edits |
| Monorepo | Workspaces, multi-package repos, mixed language repos | Detect package graph, workspace manifests, ownership boundaries, and command fan-out risks | Cross-package writes, package manager execution, cache invalidation |
| Package-manager/test runner | Projects with declared scripts or test tools | Command catalog and dry-run plan | Shell/package/test execution |
| Git | Repos with VCS metadata | Read branch/status/diff metadata after git-read policy exists | Branch, commit, push, tag, release, and destructive operations |
| Patch/write | Repos that accept staged source edits | Patch plan and write-root analysis | Staged writes, patch application, rollback, and generated-file updates |
| Browser | Web apps with local dev server or URL targets | Browser test plan and artifact expectations | Browser automation and screenshots |
| Model/embeddings/memory | Projects that opt into retrieval or model-assisted workflows | Advisory retrieval and model-call plan | Brokered model calls, embedding search, durable memory mutation |
| External MCP | Projects that opt into external tool mediation | Manifest validation and allowlist review | External MCP execution |
| Secret scan/redaction and artifact writer | Any pack with egress or artifact output | Redaction profile and artifact schema plan | Secret scanning, artifact writes, and publishable report output |

## Manifest Shape

Every capability pack must have a manifest with these fields before it can be selected by `specwright init`, a host pack, or an SDK marketplace flow.

| Field | Required content |
| --- | --- |
| Pack identity | Stable pack id, display name, version, compatibility class, lifecycle status, owner, and support tier. |
| Project support | Languages, frameworks, package managers, repository shapes, file patterns, and incompatible traits. |
| Dependencies | Required Specwright package ranges, command taxonomy version, schema contract version, runtime/broker version, and optional host/server requirements. |
| Capability declarations | Tool ids, capability kinds, requested scopes, risk level, isolation tier, cache posture, mutability, durability, and adapter requirements. |
| Harness grants | Allowed tools, denied tools, approval-required tools, policy layers, runtime-invariant tool ids, and over-grant behavior. |
| Checks | Detection checks, config validation, command availability checks, contract tests, smoke tests, and negative tests. |
| Permissions | Filesystem roots, write confinement, shell posture, network allowlist, git posture, browser posture, model budget, secret/redaction profile, and tenant boundaries. |
| Approvals | Approval ids, approver roles, timeout/deadline posture, stale approval handling, and audit evidence requirements. |
| Detection metadata | Confidence scoring, user confirmation prompt metadata, init-flow recommendation copy, conflict rules, and config persistence keys. |
| Compatibility tags | Product release, schema contracts, CLI/MCP/host compatibility, runner versions, output-contract version, and known migration requirements. |
| Distribution metadata | Whether the pack is repo-local, package-distributed, SDK extension, marketplace entry, or private enterprise pack. |

Pack manifests must be schema-validated before use. Unknown manifest fields are allowed only in an extension namespace that the SDK governance packet approves.

## Authority Model

Capability packs never bypass the broker.

| Capability family | Authority rule |
| --- | --- |
| Filesystem read/list | Existing sanctioned tier-0 behavior may be reused when policy and grants allow it. |
| Filesystem write/edit and patch | Requires staged write confinement, path containment, rollback plan, approval posture, output validation, and generated-file policy. |
| Shell, package manager, and test runners | Requires sandbox evidence, command allowlist, environment redaction, timeout/cancellation, stdout/stderr egress rules, and approval for mutating commands. |
| Git read/write | Read operations require repo-root confinement and redacted output. Mutating operations require explicit approval, branch policy, remote policy, and release/GitHub ownership. |
| Browser automation | Requires local target/URL allowlist, screenshot/video artifact policy, network profile, timeout/cancellation, and no credential capture. |
| Network | Deny by default. Any allowlist must be explicit, tenant scoped, audited, and tied to a purpose. |
| Model calls | Requires model budget, prompt/redaction profile, provenance, output schema validation, no source authority elevation, and replay classification. |
| Embeddings and memory | Requires tenant/corpus grants, redaction before indexing, tombstone/replay semantics, durable backend posture, and sanctioned tier-1 runner. |
| External MCP | Requires tenant manifest, server/tool allowlist, non-authoritative output handling, quarantine on drift, and sanctioned tier-4 runner. |
| Secret scanning/redaction | Required before broad egress, artifact writing, shell output, network output, or model-visible context expansion. |
| Artifact writing | Requires artifact schemas, write-root confinement, provenance, hash binding, and report/replay compatibility. |

Unsupported isolation tiers remain fail-closed until a sanctioned runner contract exists. A pack manifest can declare a future capability, but selection must classify it as unavailable until the runner, policy, fixtures, and release matrix row exist.

## Detection And Selection

Pack selection should be explainable and reversible.

- Detection runs in read-only mode by default.
- Each candidate pack reports matched files, confidence, required authority, unavailable prerequisites, and conflicts.
- `specwright init` recommends packs but asks for confirmation before persisting configuration.
- CI mode may use an explicit pack list but must fail closed on ambiguous detection.
- Conflicting packs must produce a conflict report rather than silently merging authority.
- Selected packs persist by stable pack id and version range, not by host-specific command names.
- Host command packs may surface pack recommendations, but the CLI/runtime owns persistence.
- Pack upgrades require compatibility checks and migration notes under the release policy.

## Contract Tests

No capability pack is product-ready without executable acceptance coverage.

| Test class | Required coverage |
| --- | --- |
| Manifest validation | Required fields, unknown-field policy, compatibility tags, version ranges, and extension namespace behavior. |
| Detection fixtures | Positive and negative project fixtures for each supported project type. |
| Grant enforcement | Requested tools and definitions must fit harness grants; over-grants and runtime-invariant violations fail closed. |
| Broker execution | Tool ids resolve only through `ToolBroker`; unsupported tiers fail before adapter execution. |
| Policy and approvals | Deny, approval-required, approved, rejected, stale approval, timeout, and policy-error paths. |
| Redaction and provenance | Args, outputs, errors, artifacts, cache entries, and spans remain redaction-safe and hash-bound. |
| Replay/cache behavior | Cache eligibility, invalidation inputs, replay compatibility, and historical event migration behavior. |
| Containment | Workspace traversal, symlink escape, remote/network egress, and tenant boundary failures. |
| Command availability | CLI/MCP/host commands that expose pack behavior must be present, documented, and mapped to runtime operations. |
| Compatibility matrix | Pack version, runner version, schema contracts, CLI/MCP/host compatibility, and release channel rows. |

## Distribution Posture

Distribution is staged.

| Stage | Policy |
| --- | --- |
| Repo-local internal fixtures | First implementation target for pack schemas, fixtures, and contract tests. |
| Internal package or templates | Allowed after manifest schema and detection tests exist. |
| Public packages | Deferred until package taxonomy, release compatibility, docs/install UX, and provenance rules are implemented. |
| SDK extension | Deferred until SDK/marketplace governance is accepted. |
| Marketplace listing | Deferred until trust, review, signatures, compatibility matrix, and revocation policy exist. |
| Enterprise private packs | Allowed only after tenant, provenance, and support boundaries are documented. |

Capability packs should not become public install targets before package metadata, provenance, compatibility, docs, and smoke tests exist.

## Current Repo Evidence

Live source on this stacked branch shows:

- The default `ToolBroker` registry contains only `fs.list` and `fs.read`.
- The default sanctioned capabilities are low-risk, read-only, deny network, forbid subprocesses, and use workspace-readonly confinement.
- Capability kinds already include filesystem, git, browser, model, embeddings, memory, cache, shell, MCP, network, and human.
- Only filesystem tier execution is sanctioned in the current in-process broker; memory, model, MCP, browser, network, shell, and other unsupported tiers fail closed without a runner.
- Default harness grants allow `eval.run`, `fs.list`, and `fs.read`, while runtime-invariant denied examples include write, git, network, and shell tool ids.
- Memory defines `memory.ingest`, `memory.search`, `embeddings.search`, `memory.get`, and `memory.forget`, but the current broker fails closed for tier-1 memory before adapter execution.
- External MCP capability definitions can be registered from an allowlisted tenant manifest and mediated through a runtime broker factory, but they are not default capability packs.
- Repo search found no actual capability-pack packages, manifests, templates, public docs, or distribution metadata.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Capability-pack manifest schema and fixtures | Capability-pack implementation packet |
| Base repository pack | Capability-pack implementation packet after manifest schema |
| TypeScript, JavaScript, Python, docs-only, and monorepo packs | Language/project pack packets |
| Package-manager, test-runner, shell, git, browser, network, model, memory, embeddings, external MCP, secret scan, and artifact writer packs | Capability-family packets with separate security review |
| Sanctioned tier-1, tier-3, and tier-4 runners | Tool-broker and capability runner packets |
| Default runtime capability baseline changes | Runtime capability baseline gate |
| Memory default capability | Memory default capability decision and durable backend packets |
| SDK/marketplace packaging | SDK governance packet |
| CLI init/detection UX | CLI and docs/install UX packets |
| MCP/server exposure | MCP server and public server-mode packets |
| Host command-pack exposure | Host command-pack packet |
| Release compatibility rows and provenance | Release compatibility packet |
| Public install docs and troubleshooting | Docs/install UX packet |

## Source Trace

| Claim | Source |
| --- | --- |
| Capability packs are needed for arbitrary codebases and common workflows | raw features log `F7`, `FEAT-EPIC-007` |
| Pack manifests need metadata, dependencies, languages, tools, checks, and permissions | `FEAT-TASK-007.1` |
| Base, TypeScript, Python, docs-only, and monorepo packs are backlog targets | `FEAT-TASK-007.2`, `FEAT-TASK-007.3` |
| Pack selection and detection are required during init | `FEAT-TASK-007.4` |
| Contract tests must cover discovery, config validation, command availability, and failure modes | `FEAT-TASK-007.5` |
| Current default broker capability baseline is read-only filesystem list/read | `packages/tool-broker/src/index.ts`, capability registry tests |
| Harness grants fail closed on over-granted authority | `packages/harness-loader/src/capability-grant.ts`, grant fixtures |
| Memory and external MCP are substrates, not default packs | memory broker capability tests, external MCP adapter sources |
| Release and package distribution are separate gates | `docs/package-taxonomy-decision.md`, `docs/release-compatibility-decision.md` |

## Diff Boundary

This record does not approve or implement capability-pack packages, manifests, schemas, generated contracts, fixtures, broker registry changes, runtime default changes, harness grant changes, default harness changes, memory wiring, external MCP default wiring, CLI/MCP/host command changes, docs beyond this decision record, package metadata, SDK marketplace behavior, CI workflows, release operations, GitHub settings, raw-source edits, or wiki status edits. Those remain separate packets and gates.
