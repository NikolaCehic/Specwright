# Docs And Install UX Decision

Status: accepted for downstream packet planning
Work unit: FEAT-015A-docs-install-ux-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Default-authority assumption: public docs must describe only supported install, command, host, adapter, server, capability, and release surfaces; pre-release source-checkout guidance stays visibly separate from product install promises.

## Decision

Specwright needs user-facing documentation that lets a new user install, run, debug, and extend the product without reading the codebase, but the first docs implementation must follow the package, CLI, host, server, capability, and release gates rather than inventing support.

The approved docs posture is:

1. Keep README as the product overview and source-checkout contributor path until package/release gates make a public install path true.
2. Make repo `docs/` the first source of truth for product decision records and later user docs; a generated docs site can follow from the same files.
3. Treat the current direct Bun CLI path as pre-release source-checkout guidance, not an install-in-60-seconds public quickstart.
4. Make the first public quickstart package-manager based only after package publishing, CLI bin, install smoke, and release provenance gates pass.
5. Document CLI and MCP first, because they are the current real adapter surfaces.
6. Defer Codex, Claude Code, OpenCode, HermesAgent, managed/server, SDK/marketplace, and broad capability-pack setup docs until their implementation and support gates pass.

Docs should be product evidence, not theater. Every page that says "supported" needs a matching package, command, adapter, test, smoke path, and release/version owner.

## Documentation Destinations

| Destination | First posture | Product requirement |
| --- | --- | --- |
| README | Product overview, architecture summary, source-checkout setup, and links to generated/user docs. | Must not remain the only install guide after package publish. |
| Repo `docs/` | First checked-in home for decision records and later user docs. | User docs should live beside source, use stable page ownership, and be eligible for link/smoke checks. |
| Docs site | Deferred. | May publish from repo docs after IA, link checks, versioning, and release ownership exist. |
| Package READMEs | Deferred. | Package READMEs should be generated or checked against package exports, CLI references, and release metadata. |
| Generated reference | Deferred. | CLI/MCP/schema/capability references should be generated from source contracts where practical. |
| Specwright Wiki | Internal audit/planning knowledge base only. | Public docs must not depend on the audit wiki or raw logs. |

The docs tree should separate decision records from user-facing guides so implementation planning does not masquerade as product documentation.

## Information Architecture

First-wave user docs should be organized around the shortest verified user path and the currently supported surfaces.

| Page family | First-wave content | Deferred content |
| --- | --- | --- |
| Overview | What Specwright is, what it is not, supported modes, current maturity, and support matrix links. | Pricing, managed service, marketplace, and enterprise procurement. |
| Quickstart | Source-checkout quickstart today; package-manager quickstart after publish/install gates. | Host-specific one-click setup and managed/server start. |
| Install | Runtime prerequisites, supported package manager, workspace build, CLI bin status, version check, and smoke command. | Package registry install, mirrors, air-gapped install, and hosted onboarding. |
| First run | Run the simple fixture, inspect status/events/replay/report, understand run package output. | Arbitrary project scaffolding, browser/model/git/write capabilities, and server mode. |
| CLI reference | Supported commands, flags, outputs, exit codes, redaction profiles, deadlines, CI behavior, and current harness limits. | Planned commands, package scaffolds, host setup commands, server admin commands. |
| MCP adapter | Tools/resources/prompts, auth modes, runtime-operation mapping, conformance limits, and adapter/server distinction. | Executable MCP server deployment and host config docs. |
| Host setup | CLI and generic MCP first. | Codex, Claude Code, OpenCode, HermesAgent, and command-pack docs after host support gates. |
| Security and approval model | Policy, broker, approvals, human input, auth, redaction, tenant, and audit concepts tied to implemented behavior. | Server/team auth, managed service admin, and external runner setup. |
| Capability model | Default filesystem capabilities and fail-closed unsupported tiers. | Write/shell/git/browser/model/memory execution docs after sanctioned runners exist. |
| Harness authoring | Default harness explanation and manifest concepts. | SDK scaffolds, arbitrary harness selection, marketplace publishing, and migration guides. |
| Examples | Fixture-based example first. | Minimal project, TypeScript app, monorepo, docs repo, harness extension, host setup, and server examples. |
| Troubleshooting | Install/build/test/CLI/runtime/MCP/policy/capability/release/migration error taxonomy. | Hosted service incidents and enterprise support runbooks. |
| Release policy | Link to release compatibility decision and current pre-release limitations. | Changelog, tags, package provenance, deprecation notices, and versioned docs after release gates. |

Every first-wave page should include a "supported now" section and a "not yet supported" section when a common user expectation is intentionally deferred.

## Install-To-First-Run Path

The current shortest successful path is a source checkout, not a published package install.

Today, docs may describe this pre-release path:

1. clone the repository;
2. install dependencies with Bun;
3. build packages;
4. run `bun run proof:v0` or call the built CLI adapter directly against `fixtures/simple-app`;
5. inspect status, events, replay, and report output.

The first public "Install in 60 seconds" quickstart must wait until:

- a public package or CLI package name is approved by package taxonomy and release gates;
- the installed `specwright` command works from a clean project without source checkout paths;
- install smoke tests pass on a clean fixture project;
- package provenance, changelog, version, and rollback posture exist;
- docs describe expected output and common failure recovery;
- unsupported capabilities and hosts are visibly labeled.

Until those conditions are true, public docs must not tell users to run package-manager install commands as if the product were published.

## Host Setup Coverage

| Host/surface | First docs posture | Required gate |
| --- | --- | --- |
| CLI | Document first as the reference local surface. | CLI command taxonomy, install smoke, output-contract tests, and release docs. |
| Generic MCP client | Document adapter usage and limitations after MCP packaging docs clarify executable/server gaps. | MCP packaging/deployability and adapter parity gates. |
| Codex | Deferred. | Host command-pack decision, adapter parity, install command, fixtures, and support matrix. |
| Claude Code | Deferred. | Host command-pack decision, adapter parity, install command, fixtures, and support matrix. |
| OpenCode | Deferred. | Host command-pack decision, adapter parity, install command, fixtures, and support matrix. |
| HermesAgent | Deferred. | Host kind/schema decision, adapter package, command pack or integration, fixtures, and support matrix. |
| Managed/server mode | Deferred. | Public runtime server, auth, queue, durable backend, observability, and release gates. |

Host setup docs must be generated from or checked against the public support matrix once that matrix exists. A reserved host kind or backlog item is not enough for a setup guide.

## Command, Config, And Reference Boundary

The first CLI reference can cover only commands present in current CLI usage and tests:

- `doctor`
- `run`
- `status`
- `events`
- `replay`
- `report`
- `eval run`
- `gate evaluate`
- `approve`
- `reject`
- `answer`

Reference docs must state current limitations:

- package-manager invocation is not yet the public path while packages remain private;
- direct Bun CLI invocation is a source-checkout path;
- arbitrary non-default harness selection is not supported despite the `--harness` flag accepting an id-or-path shape;
- capability execution is limited by broker registration and sanctioned runner availability;
- memory and embeddings are governed declarations until runner/default-capability gates pass;
- MCP is an adapter library, not a deployable server package;
- public server commands, host commands, SDK scaffolds, marketplace commands, and release/publish commands are deferred.

The current code supports CLI approval and rejection through `RuntimeApi.recordApproval` on this stacked branch, and README source-checkout CLI guidance now reflects that fail-closed approval behavior. Full public command-reference docs remain a later docs implementation packet.

Config/reference docs should wait for an approved project config, package manifest metadata, capability-pack schema, SDK schema, server config, and generated reference strategy.

## Troubleshooting Taxonomy

Troubleshooting docs should be organized by failure class and recovery owner.

| Category | First coverage |
| --- | --- |
| Install/package | Bun version, dependency install, private package limitations, build order, missing bin, package registry not yet published. |
| Source checkout | clone/build/test/proof paths, fixture cwd, generated artifacts, and stale local build output. |
| CLI input | missing args, malformed decision hashes, unknown harness, path/root errors, deadlines, redaction profile, JSON output, and exit codes. |
| Runtime/run-store | missing run id, broken event ledger, replay failure, report failure, retention/legal-hold denial, and migration incompatibility. |
| Approval/human input | pending approvals/questions, stale approvals, wrong decision hash, rejected decisions, timeouts, and audit requirements. |
| Adapter/MCP | disabled versus authenticated mode, scopes, tenant resolver, external MCP allowlist, provenance gaps, and adapter/server distinction. |
| Capability/broker | unsupported isolation tier, undeclared tool, policy denial, approval required, output schema invalid, redaction failure, and cache/replay behavior. |
| Auth/server | deferred for public server docs, with current MCP auth caveats only. |
| Release/compatibility | pre-release status, compatibility classes, migration-required changes, downgrade/rollback status, and package provenance gaps. |
| Naming/migration | legacy state-directory migration posture and canonical naming limitations without exposing stale internal paths as new setup instructions. |
| CI/docs | local command matrix, proof command, test/typecheck/build, link checks, smoke checks, and docs drift detection. |

Troubleshooting should prefer structured error codes, exit codes, and operator actions from source contracts over prose-only guesses.

## Example Repository Posture

The current runnable example is `fixtures/simple-app`. It should remain the first proof fixture until product examples are created and verified.

| Example | First posture | Verification requirement |
| --- | --- | --- |
| Simple fixture | Supported source-checkout proof fixture. | `bun run proof:v0` and simple-app E2E. |
| Minimal project | Deferred. | Clean install smoke, first-run output, and no source-checkout paths. |
| TypeScript app | Deferred. | Framework-neutral setup, artifact expectations, and source-bound evals. |
| Monorepo | Deferred. | Workspace root detection, package-bound task examples, and bounded file reads. |
| Docs repo | Deferred. | Docs-only capability pack or harness support. |
| Harness extension | Deferred. | SDK/harness authoring, validation, trust, and package tests. |
| Host setup | Deferred. | Host command-pack support and adapter parity. |
| Server/team mode | Deferred. | Server auth, queues, durable backend, observability, and deployment tests. |

Examples must be kept runnable in CI before they become public docs.

## Verification Strategy

Docs verification should become a release gate in waves.

| Gate | First requirement |
| --- | --- |
| Source-checkout smoke | `bun install`, `bun run build`, `bun run proof:v0`, CLI help, doctor, first run, status, events, replay, report. |
| Package install smoke | Deferred until packages are publishable; run from a clean temp project without repo-relative paths. |
| CLI reference check | Compare docs against `specwright help`, output schemas, and CLI tests. |
| MCP reference check | Compare docs against MCP tool/resource/prompt lists, auth tests, and conformance rows. |
| Link check | Required before public docs site or release docs. |
| Example CI | Each example gets a named smoke command and expected artifact/output. |
| Host setup check | Required per host before host setup docs are marked supported. |
| Release docs check | Changelog, compatibility matrix, package provenance, migration notes, and support matrix must match release metadata. |
| Drift check | Docs should fail when command help, package names, support matrix, or generated references change without docs updates. |

Manual review remains useful, but public docs should not rely only on manual acceptance.

## Source Of Truth And Versioning

Docs need clear owners for facts.

| Fact | Source of truth |
| --- | --- |
| Package names, versions, bin names, publishability | Package manifests plus release metadata. |
| CLI commands and flags | CLI parser/help output, output schemas, and CLI tests. |
| Runtime operations | Runtime API types, schemas, and adapter parity corpus. |
| MCP tools/resources/prompts/auth | MCP adapter source, conformance tests, and packaging decision. |
| Host support | Adapter parity/support matrix and host command-pack conformance. |
| Capability support | Tool broker registry, capability-pack taxonomy, and sanctioned runner tests. |
| Memory support | Memory default capability, durable backend, and memory eval gates. |
| Server support | Public runtime server decision, server implementation tests, auth/queue/durable backend gates. |
| Examples | Example directories and CI smoke commands. |
| Troubleshooting | Structured errors, exit codes, operator actions, conformance fixtures, and known limitations. |
| Release policy | Release compatibility decision, changelog, tags, provenance, and rollback checks. |

Versioned docs should align with release tags once releases exist. Before releases, docs must label the repo as pre-release/source-checkout and avoid stable compatibility promises.

## Current Repo Evidence

Live source on this stacked branch shows:

- README is technically strong and primarily source-checkout oriented: clone, Bun install, build, test, proof, and direct local CLI adapter invocation.
- README says the intended installed command is `specwright`, while the simplest path today is direct `bun packages/adapters-cli/dist/bin.js`.
- README source-checkout CLI guidance includes `doctor`, `eval run`, `gate evaluate`, and now reflects that `approve` and `reject` route through `RuntimeApi.recordApproval` with fail-closed stale/missing approval behavior.
- `docs/` contains decision records and the runtime hero image, not a complete public install/user guide set.
- All 17 workspace packages are private `0.0.0`; first-wave packages have npm-facing metadata; only `@specwright/cli` declares a `specwright` bin.
- CLI usage exposes `doctor`, `run`, `status`, `events`, `replay`, `report`, `eval run`, `gate evaluate`, `approve`, `reject`, and `answer`.
- CLI tests reject an unknown harness id before runtime start, so docs must not promise arbitrary harness selection yet.
- The current runnable example inventory is `fixtures/simple-app`; no `examples/` directory, monorepo example, docs-repo example, TypeScript app example, host setup example, or harness extension example exists.
- Package-level Markdown files such as schema contracts, tool-broker governance, policy governance, and gate versioning are internal governance/contract docs, not user install docs.
- Existing product, package, CLI, MCP packaging, host command-pack, capability-pack, SDK, durable backend, memory, adapter parity, server, release, naming, CI, and wiki decisions remain separate gates.

## Downstream Owners

| Work | Owner |
| --- | --- |
| README public install rewrite and stale approval wording cleanup | Docs implementation packet after CLI/package facts are locked |
| `docs/quickstart.md` and source-checkout guide | Docs implementation packet |
| Package-manager install quickstart | Package/release/docs packets after publishable package and install smoke |
| CLI command reference generation/check | CLI taxonomy plus docs verification packets |
| MCP setup and adapter/server distinction docs | MCP packaging plus docs packets |
| Codex, Claude Code, OpenCode, and HermesAgent setup docs | Host command-pack plus adapter parity packets |
| Capability model and capability-pack authoring docs | Capability-pack and tool-broker packets |
| Harness authoring guide and SDK extension docs | Harness-loader, SDK, and marketplace packets |
| Memory docs | Memory default capability plus durable backend packets |
| Server/team/managed/air-gapped docs | Public runtime server plus operations packets |
| Example repositories and CI smoke projects | Examples/docs verification packets |
| Troubleshooting taxonomy and structured-error index | Docs plus package-specific owner packets |
| Link checks, docs drift checks, examples CI, and release docs gates | CI/release/docs packets |
| Docs site publishing | Docs site packet after repo docs stabilize |
| GitHub settings, package publishing, tags, releases, and wiki status edits | Release/GitHub/wiki operations packets |

## Source Trace

| Claim | Source |
| --- | --- |
| Docs/install UX must include quickstart, install, host setup, command reference, adapter guides, troubleshooting, and examples | raw features log `F15`, `FEAT-EPIC-015` |
| Tasks require shortest-successful-path quickstart, host install guides, command/config reference, troubleshooting/diagnostics, and example repositories | `FEAT-TASK-015.1` through `FEAT-TASK-015.5` |
| Current README is checkout-oriented and not a package-manager install guide | README |
| Current packages are private and only the CLI adapter declares a bin | root and workspace package manifests |
| Current CLI commands and limitations come from source/help/tests | `packages/adapters-cli/src/index.ts`, `packages/adapters-cli/src/index.test.ts` |
| Current runnable example inventory is only the simple fixture | `fixtures/simple-app` inventory |
| Current repo docs are decision records plus the hero image, not complete user docs | `docs/` inventory |
| Package governance Markdown is internal contract/governance material | package Markdown inventory |
| Package, CLI, MCP, host, capability, SDK, memory, server, release, naming, CI, and wiki docs depend on separate gates | existing decision records in `docs/` |

## Diff Boundary

This record does not approve or implement README edits, user docs pages beyond this decision record, package READMEs, examples, fixtures, generated references, docs-site files, package manifest changes, package publishing, install scripts, CLI command changes, MCP/server behavior, host command packs, capability packs, SDK/marketplace behavior, memory defaults, migration behavior, release workflows, CI checks, GitHub settings, tags/releases, raw-source edits, or wiki status edits. Those remain separate packets and gates.
