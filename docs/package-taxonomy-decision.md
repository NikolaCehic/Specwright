# Package Taxonomy Decision

Status: accepted for downstream packet planning
Work unit: FEAT-001A-package-taxonomy-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation authority for the Specwright productization sequence
Positioning assumption: Specwright is a governed agent workflow runtime, as recorded in `docs/product-positioning-decision.md`.

## Decision

Specwright will publish a small product-facing package set first, with internal runtime planes kept private until each surface has a stable consumer contract, release policy, and install smoke path.

The public taxonomy is:

| Target package | Wave | Intended consumers | Responsibility | Current source |
| --- | --- | --- | --- | --- |
| `@specwright/cli` | First wave | End users, host command installers, CI jobs | Own the `specwright` executable, product command map, local project initialization, diagnostics, run control, and JSON output contracts | Current CLI source under `packages/adapters-cli`, promoted by the package identity packet |
| `@specwright/runtime` | First wave | Adapter authors, governed workflow integrators, advanced platform teams | Own the RuntimeApi, lifecycle contracts, policy/gate/eval orchestration boundary, run-control APIs, and adapter-facing runtime behavior | Current `@specwright/runtime` |
| `@specwright/harness-loader` | First wave | Harness authors, CLI/runtime integrations | Load, validate, and resolve harness definitions used by the runtime and CLI | Current `@specwright/harness-loader` |
| `@specwright/schemas` | First wave | Package consumers, harness authors, adapter authors | Publish stable TypeScript types and validation schemas shared across runtime, harnesses, run events, artifacts, policies, and adapters | Current `@specwright/schemas` |
| `@specwright/mcp-server` | Later wave, public target | MCP host users and adapter integrators | Own the executable MCP server package, transport setup, host config entrypoints, auth posture, and deployable server lifecycle | New package or wrapper around current `@specwright/adapters-mcp` after `G-MCP-001` |

The first publishable slice should ship CLI, runtime, harness loader, and schemas together. The MCP server name is reserved as a public package target, but publishing it is deferred until the executable server packet decides transport, binary, auth, lifecycle, and host setup.

## Package Roles

### Product-Facing Public Packages

| Package | Publish posture | Required before publish |
| --- | --- | --- |
| `@specwright/cli` | Public first-wave package | Stable command taxonomy, a `bin` entry for `specwright`, built `dist`, declaration files, command-level JSON output contracts, exit-code namespace, docs owner, package metadata, install smoke |
| `@specwright/runtime` | Public first-wave package | Adapter-facing API review, stable exports, built `dist`, declaration files, runtime compatibility policy, package metadata, contract tests |
| `@specwright/harness-loader` | Public first-wave package | Stable harness validation exports, built `dist`, declaration files, compatibility policy with schemas/runtime, package metadata |
| `@specwright/schemas` | Public first-wave package | Stable schema exports, declaration files, compatibility policy, generated artifact policy, package metadata |
| `@specwright/mcp-server` | Public later-wave package | `G-MCP-001`, deployable server entrypoint, host setup posture, auth model, binary or transport policy, install smoke, release compatibility checks |

### Deferred Public Package Families

| Family | Decision |
| --- | --- |
| Adapter packages | Deferred. CLI is promoted into `@specwright/cli`; MCP server becomes `@specwright/mcp-server` later. Other adapters need parity and host gates before becoming public packages. |
| Capability packs | Deferred behind `G-CAPACK-001`. Publish only after capability taxonomy, isolation tiers, policy defaults, and compatibility gates are accepted. |
| Command packs for Codex, Claude Code, OpenCode, and HermesAgent | Deferred behind `G-HOST-001`. They should not be published until command format, installation path, update model, and parity expectations are decided. |
| SDK or extension marketplace packages | Deferred behind `G-SDK-001`. SDK distribution should follow package taxonomy, capability taxonomy, host command packs, and release compatibility decisions. |
| Memory/retrieval package | Deferred. It can become public after memory default posture, durability, embedding/provider expectations, and capability grants are settled. |

### Internal Implementation Packages

These packages remain internal for the first publishable slice. They may be consumed by public packages through bundled or dependency-managed internals, but they are not product-facing install targets yet.

| Current package | First-wave status | Reason |
| --- | --- | --- |
| `@specwright/adapter-parity` | Internal/deferred | Parity corpus and release-gate semantics are not yet productized. |
| `@specwright/cli` | Public CLI package source in `packages/adapters-cli` | Current implementation owns the only `specwright` bin and now uses the public product package name. |
| `@specwright/adapters-mcp` | Source for later `@specwright/mcp-server` | Current package is an in-process library with no bin; executable server packaging is deferred. |
| `@specwright/artifact-store` | Internal | Runtime implementation plane; public contract should flow through runtime and schemas first. |
| `@specwright/eval-runner` | Internal/deferred | Eval product surface and release gate need CLI/runtime decisions before separate publishing. |
| `@specwright/evidence-store` | Internal | Runtime evidence implementation plane without separate external consumer contract yet. |
| `@specwright/gate-engine` | Internal/deferred | Gate semantics should be exposed through runtime and CLI until a standalone gate package is justified. |
| `@specwright/memory` | Deferred | Memory-as-capability posture and default broker policy are still separate feature decisions. |
| `@specwright/operations` | Internal/deferred | Operational contracts need docs, release, and hosted/team posture before public publishing. |
| `@specwright/policy-engine` | Internal/deferred | Policy can become public later if policy-authoring APIs stabilize; first wave exposes runtime behavior. |
| `@specwright/run-reports` | Internal/deferred | Report generation should be exposed through CLI/runtime until report API, docs, and compatibility policy mature. |
| `@specwright/run-store` | Internal/deferred | Persistent run layout and migration policy are still gated by naming and compatibility decisions. |
| `@specwright/tool-broker` | Internal/deferred | Capability-broker public API depends on capability-pack taxonomy and isolation-tier policy. |
| `@specwright/trace-recorder` | Internal | Trace recording is runtime infrastructure without a standalone product contract in the first wave. |

## Current-To-Target Mapping

| Current package | Target package or posture | Notes |
| --- | --- | --- |
| `packages/adapters-cli` source | `@specwright/cli` | The package identity is promoted in place while the folder remains stable for scoped implementation history. The public package must expose a `bin` entry for `specwright`. |
| `@specwright/runtime` | `@specwright/runtime` | Keep name. Public API review and dependency rewriting are required before publish. |
| `@specwright/harness-loader` | `@specwright/harness-loader` | Keep name. Publish with runtime and schemas because harness loading is a first-run requirement. |
| `@specwright/schemas` | `@specwright/schemas` | Keep name. Publish as the shared contract package. |
| `@specwright/adapters-mcp` | `@specwright/mcp-server` later | Current in-process adapter may remain internal or become an implementation dependency of the server package. |
| Other `@specwright/*` packages | Internal or deferred public packages | Promote only after a packet names consumers, exports, semver compatibility, docs, and install tests. |

## Entrypoint And Bin Policy

- Every public package must publish built JavaScript and declaration files from `dist`.
- Every public package must define `main`, `types`, `exports`, and `files`.
- Public packages must not expose deep internal paths unless those paths are documented compatibility surfaces.
- `@specwright/cli` owns the public `specwright` command. No other first-wave package should define a competing `specwright` bin.
- `@specwright/mcp-server` may own an MCP-specific executable only after `G-MCP-001` decides whether the server is a separate package, a bin on the MCP adapter package, or both.
- Runtime entrypoints should remain adapter-facing and deterministic; host-specific setup belongs in CLI, MCP server, or host command-pack packages.
- Package exports must be reviewed with contract tests before semver publication.

## Metadata And Publish Rules

Before any package leaves private workspace status, the implementation packet must add or verify:

- `private: false` only for approved public packages.
- Real semver versions, aligned across first-wave packages unless release policy decides otherwise.
- `license`, `repository`, `keywords`, and package-specific README content.
- `engines` for supported Node and package-manager expectations.
- `publishConfig` including intended registry, access, provenance posture, and tag policy.
- No `workspace:*` specifiers in published artifacts; internal workspace dependencies must be rewritten, bundled, or published in a compatible package set.
- Built `dist` artifacts and declaration files included by `files`.
- npm provenance and GitHub release/tag policy owned by the release packet.

## Install Smoke And Publish Dry Run

Install smoke and publish dry-run are assigned, not implemented here.

| Workflow | Owner | Scope |
| --- | --- | --- |
| Fresh-project install smoke | `FEAT-001B` or package implementation packet | Verify `npm`, `npx`, `bunx`, packed tarball installation, and the documented `specwright` smoke command in a clean project. |
| Host command install smoke | `FEAT-006A` / `G-HOST-001` | Verify Codex, Claude Code, OpenCode, HermesAgent, and generic host command-pack install paths after host package format is decided. |
| Publish dry-run | `FEAT-013A` / `G-REL-001` plus package implementation packet | Verify `npm pack` or equivalent dry-run output, provenance inputs, dependency rewriting, tag policy, and changelog/release-note linkage. |
| Compatibility check | `FEAT-013A` / `G-REL-001` | Verify runtime, schemas, harness-loader, CLI, MCP, adapter, and run-package contract compatibility before release. |

## Live Manifest Evidence

Evidence was refreshed from the current repository on 2026-06-14:

- Root package is private and has no root `version`.
- There are 17 package manifests under `packages/*`.
- All 17 workspace packages are private and have `version: "0.0.0"`.
- All 17 workspace packages currently define `main`, `types`, `exports`, and `files`.
- Only `@specwright/cli` defines a `bin`, mapping `specwright` to `./dist/bin.js`.
- No workspace package currently defines `publishConfig`, `license`, or `repository`.
- 16 packages use `workspace:*` in production dependencies; all 17 use `workspace:*` when dev dependencies are included.
- README install/use flow is source-checkout oriented and invokes built CLI output directly, while naming `specwright` as the intended installed command.

## Source Trace

| Claim | Source |
| --- | --- |
| Specwright needs public packages for CLI, runtime, MCP server, harness loader, and schemas, with optional adapter/capability splits | raw features log `F1` |
| The package set must become installable, versioned, externally consumable, and smoke-tested | `FEAT-EPIC-001`, `FEAT-TASK-001.1` through `FEAT-TASK-001.5` |
| Current repo is a Bun source checkout rather than an installable product | raw audit log `A5`, `AUD-005A` evidence |
| Current CLI package source owns the only `specwright` bin | package manifest inventory |
| Current MCP adapter is an in-process package with no deployable server bin | `AUD-011A` evidence and package manifest inventory |
| Release tags, provenance, changelog, compatibility policy, and dry-run behavior remain release-system work | raw features log `F13`, `G-REL-001` |
| Host command packs, capability packs, SDK distribution, docs/install UX, and MCP server packaging are separate gates | `G-HOST-001`, `G-CAPACK-001`, `G-SDK-001`, `G-DOCS-001`, `G-MCP-001` |

## Diff Boundary

This record does not approve or implement package manifest edits, package renames, privacy/version changes, dependency rewrites, `bin` changes, export changes, README edits, install docs, CI, release workflows, tags, GitHub settings, npm publish operations, generated artifacts, or wiki/raw-source edits. Those remain separate packets and gates.
