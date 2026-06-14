# Adapter Parity Expansion Decision

Status: accepted for downstream packet planning
Work unit: FEAT-011A-adapter-parity-expansion-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation and productization authority for the Specwright sequence
Default-authority assumption: the CLI remains the reference adapter until a named adapter passes the shared conformance corpus and is admitted by release gates.

## Decision

Specwright should expand adapter parity from a CLI-only reference suite into a governed multi-host conformance program, but it must not advertise every reserved host as supported immediately.

The first implementation order is:

1. `cli` remains the required reference adapter and defines the observable behavior bar.
2. `mcp` is the first parity expansion after MCP packaging, server deployability, and auth posture are product-ready.
3. `codex` command-pack adapter follows after the host command-pack contract and installer posture are accepted.
4. `claude-code` command-pack adapter follows the same host command-pack gate.
5. `opencode` adapter follows after command-pack parity and host metadata behavior are proven.
6. Generic host adapter SDK follows after SDK and marketplace contracts can validate third-party adapter packages.
7. HermesAgent remains deferred until a host kind, adapter contract, conformance fixture, and public support posture exist.
8. `gemini-cli` remains a reserved host kind for evaluation, not a product support promise.

Adapter support means runtime-observable behavior matches the reference corpus for the adapter's declared tier. A schema enum, command-pack idea, or individual conformance marker is not enough to call an adapter supported.

## CLI Reference Bar

The CLI adapter is the product reference because it exercises the local runtime through the public command surface and records normalized outcomes against run-store ground truth.

Every required adapter must match the CLI reference for:

- run creation and persisted run state;
- status projection and machine-readable output shape;
- event listing, bounded reads, and truncation diagnostics;
- replay projection over the same persisted event log;
- report generation and report-summary location semantics;
- not-found, validation, and unsupported-operation failures;
- approval or human-input blockers;
- telemetry outcome mapping;
- redaction, diagnostics, and audit evidence that can be compared across hosts.

The reference bar can evolve, but it must evolve through shared conformance cases, not through host-specific assertions hidden in one adapter package.

## Common Adapter Contract

Every adapter must implement a common contract before it can enter the supported matrix.

| Contract area | Required decision |
| --- | --- |
| Command invocation | Each adapter maps host commands or tool calls to canonical runtime operations with stable inputs, outputs, deadlines, cancellation, and idempotency expectations. |
| Runtime operation mapping | Required operations include start, status, events, replay, report, approval or human-input response, and failure lookup. Optional operations must be declared explicitly. |
| Host metadata | Outcomes record host kind, adapter name, adapter version, host version when available, invocation mode, workspace root, and capability flags. |
| Event semantics | Adapters preserve runtime event order, event ids, status transitions, replay behavior, and bounded-read diagnostics. |
| Approvals and human input | Adapters surface pending approvals and questions without auto-approving, bypassing policy, or inventing unavailable host UI. |
| File access | Adapters declare read/write availability and fail closed when the host cannot provide required workspace access. |
| Auth and principal | Adapters record the local, team, service, or host principal used for the call and deny server/team operations when principal context is missing. |
| Errors and status | Adapters normalize validation errors, not-found results, unsupported capabilities, blocked states, permission denials, and runtime failures into the shared outcome vocabulary. |
| Output envelopes | Machine-readable output is stable enough for conformance comparison and does not require host-specific scraping. |
| Telemetry | Spans and telemetry outcomes are comparable across adapters and do not leak secrets or host-only internals. |
| Audit and provenance | Adapter outcomes cite run ids, event ids, command/tool names, host metadata, policy decisions, and redaction profile versions where applicable. |
| Redaction | Host logs, diagnostics, outputs, and telemetry use the same redaction posture as CLI-visible product output. |
| Limits | Adapters enforce size, event, token, timeout, polling, retry, and concurrency limits with explicit blocked or truncated outcomes. |
| Capability declarations | Adapter packages declare supported operations, optional host capabilities, unsupported behavior, and required product gates. |
| Compatibility | Adapter versions declare compatible Specwright package and schema ranges, and release gates reject unsupported combinations. |

Adapters may add host-native conveniences only after the common contract passes. Native UI is an enhancement, not a parity substitute.

## Parity Tiers

Adapter parity is tiered so product docs can be honest without freezing future host work.

| Tier | Meaning | Release posture |
| --- | --- | --- |
| Reference | CLI behavior that defines the shared corpus. | Required for every release. |
| Required adapter | Adapter must pass the required corpus before the product advertises support. | Blocking once support is advertised. |
| Partial adapter | Adapter has one or more narrow conformance markers but does not pass the full required corpus. | Not advertised as supported; docs may name it as experimental or internal only. |
| Optional capability | Adapter passes the required corpus but lacks host-native extras such as streaming or rich approval UI. | Supportable if fallback behavior is explicit. |
| Experimental | Adapter is under evaluation and may change without compatibility promises. | Non-blocking and excluded from public support claims. |
| Deferred | Adapter is intentionally not implemented in the current wave. | No release claim. |

Required parity includes run lifecycle, status, events, replay, report, validation failures, not-found failures, pending approvals, unsupported-capability handling, redaction, audit, bounded reads, and normalized telemetry outcome mapping.

Optional parity may include streaming events, host-native approval UI, host install helpers, rich diagnostics, server-push updates, memory/capability setup helpers, and host-specific convenience commands.

Deferred parity includes durable memory defaults, remote/team server backends, SDK marketplace installation, command-pack installers, and host-specific UI beyond adapter contract needs.

Unsupported operations must fail as unsupported, blocked, or unavailable. They must not silently degrade into a different operation or make the run appear healthier than it is.

## Adapter Support Matrix

| Adapter or host | First posture | Product requirement |
| --- | --- | --- |
| `cli` | Reference and required. | Keep registered in the shared corpus and block release on corpus failures. |
| `mcp` | First expansion target, currently partial. | Register as an adapter only after MCP package/server/auth gates and the required corpus pass. |
| `codex` | Deferred host command-pack adapter. | Requires host command-pack contract, installer posture, common adapter contract, conformance fixtures, and support docs. |
| `claude-code` | Deferred host command-pack adapter. | Same gate as Codex, with host metadata and approval UX mapped explicitly. |
| `opencode` | Deferred host command-pack adapter. | Requires command-pack parity, host metadata, file access behavior, and normalized outputs. |
| `gemini-cli` | Reserved/evaluation only. | Existing host kind does not create support; requires a later adapter proposal and corpus admission. |
| HermesAgent | Deferred, no current host kind. | Requires schema decision, adapter package contract, fixtures, conformance, docs, and release admission. |
| Generic host adapter | Later SDK/marketplace extension. | Requires SDK validation, marketplace metadata, compatibility policy, and third-party adapter conformance harnesses. |

The public support matrix should distinguish supported, partial, experimental, reserved, and deferred states rather than collapsing them into one list of logos.

## MCP Relationship

MCP is an important adapter target, but the current MCP parity signal is intentionally narrow.

The current `contract.cli-parity` conformance marker proves that one MCP get-run flow can preserve CLI status semantics over the same real runtime run. That is useful evidence for shared runtime semantics, but it is not full adapter parity.

MCP becomes a required adapter only when it:

- registers in the shared adapter-parity suite;
- runs the same required corpus as the CLI reference;
- proves start, status, events, replay, report, approval/human-input, and failure behavior;
- preserves output envelopes and event ordering;
- carries server/auth/principal metadata where relevant;
- has release gates and public support docs that describe supported and unsupported modes.

MCP server deployability, installability, auth, and packaging remain separate prerequisites. This decision does not move MCP from partial evidence to full product support.

## Fallback Behavior

Adapters must make unavailable host capabilities visible.

| Missing host capability | Required fallback |
| --- | --- |
| Native approval UI | Return pending or blocked state with the canonical approval/question payload and a supported CLI/MCP follow-up path when available. |
| Streaming events | Use bounded polling or event snapshots with truncation markers and stable last-event ids. |
| Workspace file access | Fail closed with a setup/actionable error; do not guess a different root. |
| Write access | Report unavailable or blocked for mutating operations; do not rewrite through hidden local paths. |
| Auth or principal | Use local principal only for local mode; deny team/server operations until principal context exists. |
| Durable backend | Report memory, replay, or server feature unavailable rather than falling back to volatile state for product claims. |
| Host command pack | Mark host commands unsupported until the command-pack gate exists. |
| Output schema support | Return a normalized adapter error; do not emit unstructured host text as machine output. |
| Telemetry or audit sink | Preserve local audit/provenance evidence and report missing host telemetry as a capability gap. |

Fallbacks are part of the conformance contract. A host can be supported with conservative fallbacks, but only when those fallbacks are explicit, tested, and documented.

## Conformance And Release Gates

`@specwright/adapter-parity` should own the shared conformance corpus and normalized outcome vocabulary.

The corpus should cover:

- required run lifecycle cases;
- required failure and blocked-state cases;
- adapter-agnostic assertions against run-store ground truth;
- normalized machine output and telemetry outcomes;
- approval and human-input blocker behavior;
- redaction and diagnostics;
- adapter capability declarations and unsupported-operation behavior.

Before a host is advertised as supported, its adapter must pass the required corpus in CI and in release validation. Experimental adapters can run advisory conformance, but their failures must not be hidden behind support claims.

This record does not add CI or release gates. It decides the posture that later implementation packets must enforce.

## Schema And Host-Kind Consequences

The current host-kind schema names `codex`, `claude-code`, `gemini-cli`, `opencode`, `cli`, and `mcp`. That enum is a compatibility substrate, not a public support matrix.

No host-kind schema change is made by this record.

HermesAgent should not be added casually. A later schema/generated-artifact packet must decide its exact host kind spelling, compatibility impact, generated contract updates, fixtures, docs, and migration posture.

## Public Support Matrix Ownership

The public support matrix belongs to docs/install UX and release documentation, not to adapter internals.

The matrix should eventually be generated or checked against an adapter conformance manifest that includes:

- adapter id and package name;
- support state;
- parity tier;
- supported operations;
- optional host capabilities;
- unsupported operations and fallbacks;
- required setup;
- compatible Specwright versions;
- conformance run id or release evidence;
- owner and support policy.

Until that source exists, decision records may guide packet order, but public docs must avoid promising hosts that have not passed the support gate.

## Current Repo Evidence

Live source on this stacked branch shows:

- `@specwright/adapter-parity` defines logical operations for start, status, events, replay, report, and approval.
- The parity suite records normalized outcomes, telemetry outcomes, diagnostics, and run-store ground truth.
- `createCliReferenceAdapter` is the only registered adapter factory.
- `registeredParityAdapters()` returns only the CLI reference adapter, and the adapter-parity test asserts the registry contains only `cli`.
- The parity corpus currently checks at least seven adapter-agnostic outcomes across start, status, events, replay, report, status-not-found, and approval blocker behavior.
- MCP conformance includes `contract.cli-parity`, and a real-runtime test compares an MCP get-run response with CLI status over the same run.
- `HostKindSchema` currently enumerates `codex`, `claude-code`, `gemini-cli`, `opencode`, `cli`, and `mcp`.
- Searches found no current HermesAgent host kind, adapter package, or parity registration.
- Existing release, package taxonomy, MCP packaging, host command-pack, SDK, durable backend, and memory decisions all remain separate gates that adapter parity must compose with.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Required adapter contract types and capability manifest | Adapter-parity implementation packet |
| MCP adapter registration in shared corpus | MCP adapter and adapter-parity packets after server packaging gates |
| Codex, Claude Code, and OpenCode command-pack adapters | Host command-pack implementation packets |
| Gemini CLI evaluation adapter | Later adapter proposal if product chooses to support it |
| HermesAgent host-kind and adapter decision | Schema/generated-contract plus adapter proposal packets |
| Generic host adapter SDK | SDK/marketplace packets after adapter contract stabilization |
| Public support matrix | Docs/install UX and release documentation packets |
| Release and CI blocking gates | Release compatibility and CI packets |
| Approval/human-input adapter UX | Human-input runtime APIs plus adapter implementation packets |
| Memory/capability setup through adapters | Capability-pack, memory, and adapter packets |

## Source Trace

| Claim | Source |
| --- | --- |
| Adapter parity must expand beyond CLI and prove identical runtime-observable behavior across hosts | raw features log `F11`, `FEAT-EPIC-011` |
| Supported host list, parity tiers, contract, fallback behavior, and release posture are required before implementation | `FEAT-TASK-011.1` through `FEAT-TASK-011.5` |
| Current adapter registry is CLI only | `packages/adapter-parity/src/index.ts`, `packages/adapter-parity/src/index.test.ts` |
| Current MCP parity evidence is narrow and local to a get-run/status comparison | `packages/adapters-mcp/src/conformance/index.ts`, `packages/adapters-mcp/src/conformance.test.ts` |
| Host kind schema already reserves several host names but not HermesAgent | `packages/schemas/src/index.ts`, `packages/schemas/contracts/json-schema/specwright.adapter.host-kind.json` |
| Host command packs, SDK/marketplace, MCP packaging, memory, durable backend, and release gates are separate decisions | existing decision records in `docs/` |

## Diff Boundary

This record does not approve or implement adapter packages, host command packs, MCP server changes, runtime changes, package manifests, schema/generated changes, conformance fixtures, tests, CLI commands, SDK marketplace behavior, memory/capability setup, public docs beyond this decision record, CI/release workflows, GitHub settings, package publishing, raw-source edits, or wiki status edits. Those remain separate packets and gates.
