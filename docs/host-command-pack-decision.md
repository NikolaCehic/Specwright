# Host Command-Pack Decision

Status: accepted for downstream packet planning
Work unit: FEAT-006A-host-command-pack-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Product/package/CLI/MCP assumptions: Specwright is a governed agent workflow runtime; `@specwright/cli` owns the installed command surface; `@specwright/mcp-server` is the later public MCP server package target; host packs are thin adapters over those surfaces.

## Decision

Specwright should ship host command packs in a staged order, starting with Codex.

The approved host order is:

1. Codex.
2. Claude Code.
3. OpenCode.
4. Generic MCP-capable hosts.
5. HermesAgent after a host-kind contract and adapter contract are approved.
6. Gemini CLI after a product owner explicitly approves support beyond the reserved host kind.

Codex is first because it is the clearest operator path for the current productization work, raw F6 names a Codex skill or command pack first, and the existing workflow already depends on a repo-local CLI/MCP/runtime boundary that Codex can invoke without inventing a new runtime.

## Host-Kind And Integration Boundary

Reserved host kinds are not implemented integrations.

| Surface | Current contract posture | Command-pack posture |
| --- | --- | --- |
| `codex` | Reserved in `HostKindSchema` | First implementation target. |
| `claude-code` | Reserved in `HostKindSchema` | Second implementation target. |
| `opencode` | Reserved in `HostKindSchema` | Third implementation target. |
| `mcp` | Reserved in `HostKindSchema` | Supported through the MCP server package and config helpers, not a host command pack by itself. |
| `cli` | Reserved in `HostKindSchema` | Reference adapter and command target used by host packs. |
| `gemini-cli` | Reserved in `HostKindSchema` | Deferred. The schema value does not create first-wave support. |
| HermesAgent | Not present in `HostKindSchema` | Deferred until a schema value, adapter contract, and install story are approved. |
| Generic host adapter SDK | No host-specific schema value | Later SDK and adapter-parity work, not first-wave command-pack work. |

No host pack should claim support until its files, install path, permissions, command mapping, and compatibility tests exist.

## Shared Pack Format

Each host command pack should follow one logical format even when host file names differ.

| Pack component | Required content |
| --- | --- |
| Manifest metadata | Pack id, host kind, Specwright package range, CLI command range, MCP server range if used, minimum host version when known, compatibility tags, install mode, and update channel. |
| Command definitions | Stable command ids for audit, implement, verify, repair, packet handoff, run status, events, replay, report, approval, answer, config, and doctor workflows where the host can support them. |
| Invocation binding | The exact CLI command, MCP server operation, or staged combination used by each host command. |
| Permission profile | Filesystem roots, shell allowance, network allowance, MCP allowance, write behavior, approval requirements, and denied-by-default behavior. |
| Install descriptor | Host-specific destination paths, project bootstrap files, config helper inputs, uninstall behavior, update behavior, and idempotency expectations. |
| Output contract | JSON envelope expectations, human output posture, redaction behavior, pending-action rendering, and error classes. |
| Compatibility tags | Runtime version, schema contract version, command taxonomy version, MCP profile, capability profile, naming/config profile, and release channel. |
| Test fixture | Minimal command-pack fixture plus expected host config rendering for dry-run validation. |

Host-specific files may be different, but the manifest fields, command ids, permission vocabulary, and compatibility tags must remain comparable across hosts.

## Invocation Path

First-wave host packs invoke public product surfaces rather than private workspace internals.

| Operation class | First-wave invocation |
| --- | --- |
| Run lifecycle, status, events, replay, reports, approvals, answers, evals, gates, and brokered tool calls | Prefer `@specwright/cli` commands once the command exists and has a JSON output contract. |
| Host runtime control from MCP-capable clients | Use `@specwright/mcp-server` stdio once the executable server package exists. |
| Human approval and answer flow | Use runtime-owned methods and projections from the human-input runtime packet. Do not fabricate pending state in host scripts. |
| Direct Runtime API calls | Deferred to an adapter SDK packet. Host command packs should not import private runtime packages directly. |
| Full workflow orchestration | Deferred to lifecycle orchestrator and host implementation packets. Command packs should call approved product commands, not duplicate orchestration logic. |

The staged path is CLI first for command packs, MCP stdio for host clients that have native MCP configuration, and direct runtime SDK only after adapter-parity and SDK gates accept a stable contract.

## Permission And Safety Model

Host command packs must preserve Specwright runtime authority.

- Default posture is deny by default.
- A command pack may request only the host permissions needed to launch the CLI or MCP server and read/write within the configured project roots.
- Shell execution is limited to approved package commands or generated launch commands; arbitrary shell authority requires a capability-pack decision and runtime policy approval.
- Network access is denied unless the invoked product surface has an authenticated profile and the relevant capability or server-mode packet authorizes it.
- Filesystem writes are confined to runtime-approved output roots, report paths, config paths, or patch staging areas approved by capability gates.
- MCP config helpers must render explicit local stdio profiles. They must not create remote listeners or shared server credentials.
- Approval UI hooks must flow through runtime-owned approval APIs and events. Host-local prompts cannot silently widen authority.
- Every command must classify unsupported, missing, stale, or ambiguous runtime state as blocked, denied, or not found rather than guessing.
- Host packs must emit redaction-safe output and avoid leaking restricted evidence, secrets, raw prompts, or unbounded event history.

## Per-Host Expectations

| Host | Expected pack shape | First-wave scope | Deferred scope |
| --- | --- | --- | --- |
| Codex | Codex skill or command pack, install command, project bootstrap, MCP config helper, and workflow commands | Audit, implement, verify, repair, packet handoff, run status/events/replay/report, approvals, answers, config, and doctor commands mapped to CLI or MCP | Real host automation beyond dry-run, direct Runtime API import, and any workflow-supervisor dependency |
| Claude Code | Slash commands, MCP server config, permission mapping, and project bootstrap files | Same logical command ids as Codex where the host supports them | Host-specific automation until slash-command packaging and permission tests exist |
| OpenCode | Command or module adapter, config bridge, and tool-policy bridge | Same logical command ids where OpenCode can invoke CLI or MCP | Native module behavior that bypasses runtime policy |
| Generic MCP clients | Config helper and smoke-tested stdio launch shape | Runtime operation access through `@specwright/mcp-server` | Host-specific command UX |
| HermesAgent | Host-kind contract proposal, adapter contract, install story, then command pack | Deferred | Any command-pack files before schema and adapter approval |
| Gemini CLI | Reserved-host evaluation only | Deferred | Shipping commands or docs that imply supported Gemini CLI integration |

## Compatibility Tests

Host pack implementation packets must add staged compatibility coverage before support is advertised.

| Test level | Required coverage |
| --- | --- |
| Structure validation | Manifest schema, command ids, permission profile, install descriptor, compatibility tags, and output-contract metadata. |
| Host config dry run | Render host config without writing by default; validate paths, launch commands, local profile, and idempotency. |
| CLI smoke | Invoke the mapped CLI commands with fixtures or temporary run roots and verify JSON envelopes and exit classes. |
| MCP smoke | Launch the stdio server when available, initialize, list tools, call representative read and mutating runtime operations, and shut down cleanly. |
| Permission negative tests | Denied writes, denied shell, denied network, missing profile, stale approval, unsupported command, invalid root, and missing package. |
| Cross-host parity | Prove each supported host command maps to the same runtime-observable behavior as the CLI reference adapter. |
| Release packaging | Verify command-pack assets are included in package tarballs or installer artifacts and do not depend on private workspace-only paths. |
| Optional real-host automation | Run only after the host CLI is available and stable in CI or a documented local smoke environment. |

## Downstream Owners

| Work | Owner |
| --- | --- |
| Codex command pack and installer | FEAT-006 implementation packet after CLI and MCP package prerequisites are ready |
| Claude Code command pack | FEAT-006 host-specific follow-up |
| OpenCode command/module adapter | FEAT-006 host-specific follow-up |
| HermesAgent host-kind and adapter contract | Schema and adapter-parity packets before host-pack work |
| Gemini CLI support decision | Product and adapter-parity packet before host-pack work |
| Generic host adapter SDK | SDK and adapter-parity packets |
| MCP config helpers | MCP server implementation plus host command-pack packets |
| Install and troubleshooting docs | Documentation/install UX packet |
| Capability widening for shell, write, network, browser, model, and git operations | Capability-pack packets and runtime policy gates |
| Release compatibility and tarball checks | Release/provenance packet |

## Current Repo Evidence

Live source on this stacked branch shows:

- `HostKindSchema` includes `codex`, `claude-code`, `gemini-cli`, `opencode`, `cli`, and `mcp`.
- The generated JSON Schema for host kinds contains the same enum values.
- HermesAgent is not currently represented as a host kind.
- Repo search found no concrete Codex, Claude Code, OpenCode, HermesAgent, or Gemini CLI command-pack files.
- The CLI is the reference runtime-control adapter.
- The MCP adapter preserves runtime-operation parity and the MCP server package decision reserves a deployable stdio server as a later public package target.
- Existing package and CLI decision records defer host command-pack implementation behind this decision.

## Source Trace

| Claim | Source |
| --- | --- |
| Host packs are required for Codex, Claude Code, OpenCode, HermesAgent, and future hosts | raw features log `F6`, `FEAT-EPIC-006` |
| Reserved host kinds are distinct from usable integrations | raw features log `F6` |
| Current host-kind values are Codex, Claude Code, Gemini CLI, OpenCode, CLI, and MCP | `packages/schemas/src/index.ts`, host-kind JSON Schema |
| HermesAgent is absent from the current host-kind contract | host-kind schema evidence |
| CLI remains the reference product command surface | `docs/cli-command-taxonomy-decision.md`, README |
| MCP host setup depends on a later executable server package | `docs/mcp-server-packaging-decision.md` |
| Public packages and command packs are deferred until package, CLI, host, release, and docs gates are accepted | `docs/package-taxonomy-decision.md` |

## Diff Boundary

This record does not approve or implement host command-pack files, slash commands, Codex skills, OpenCode modules, HermesAgent adapters, Gemini CLI packs, MCP config snippets, schema host-kind changes, generated contracts, package manifests, CLI/MCP/runtime source changes, capability widening, docs beyond this decision record, CI, release workflows, GitHub settings, npm publish operations, raw-source edits, or wiki status edits. Those remain separate packets and gates.
