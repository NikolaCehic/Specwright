# CLI Command Taxonomy Decision

Status: accepted for downstream packet planning
Work unit: FEAT-002A-cli-command-taxonomy-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation authority for the Specwright productization sequence
Product/package assumptions: Specwright is a governed agent workflow runtime, and `@specwright/cli` is the public package that owns the installed `specwright` command.

## Decision

The Specwright CLI is the reference runtime-control adapter. Its public surface should organize governed workflow operations around runtime-owned behavior, not around private package internals or ad hoc scripts.

The current command names remain reserved product names:

- `doctor`
- `run`
- `status`
- `events`
- `replay`
- `report`
- `tool call`
- `eval run`
- `gate evaluate`
- `approve`
- `reject`
- `answer`

The first public CLI release should add the smallest complete product shell around those commands:

| Command family | Wave | Purpose | Runtime or package dependency |
| --- | --- | --- | --- |
| `help` | Current/supporting | Show command usage and global conventions | CLI package |
| `init` | First wave | Create a local Specwright project config and starter harness references | Naming/config gate, docs gate |
| `doctor` | First wave | Diagnose package install, build artifacts, config, runtime store, host setup, and policy prerequisites | CLI, package, CI, docs gates |
| `run` | First wave | Start and eventually drive a full governed lifecycle run | Runtime lifecycle orchestrator gate |
| `status` | Current/first wave | Read runtime state for a run | `RuntimeApi.getRun` |
| `events` | Current/first wave | Read bounded, redacted event history | `RuntimeApi.getEvents` |
| `replay` | Current/first wave | Replay a run; add verification mode before public release | `RuntimeApi.replay`, release/compatibility gate |
| `report` | Current/first wave | Write and read run reports | `RuntimeApi.writeRunReport` |
| `approve` | Current/first wave | Resolve pending approvals through runtime-owned approval records | `RuntimeApi.recordApproval`, human-loop gate |
| `reject` | Current/first wave | Reject pending approvals through runtime-owned approval records | `RuntimeApi.recordApproval`, human-loop gate |
| `answer` | Current/first wave with runtime upgrade | Record human answers; move from evidence-backed interim behavior to runtime-owned question records | Human-loop gate |
| `tool call` | First wave | Invoke brokered tools through runtime policy and capability controls | `RuntimeApi.callTool`, capability gates |
| `eval run` | First wave | Run governed evals through runtime APIs | `RuntimeApi.runEval`, eval/release gates |
| `gate evaluate` | First wave | Evaluate lifecycle gates through runtime APIs | `RuntimeApi.evaluateGate`, gate/lifecycle gates |
| `config` | First wave | Inspect, validate, and explain effective CLI/runtime configuration | Naming/config gate |
| `harness list` / `harness verify` | First wave | Inspect known harnesses and validate harness references | Harness-loader and docs gates |
| `export` / `audit` | Later wave | Produce portable audit/export bundles and operator evidence views | Operations/release/docs gates |
| `harness install` / `harness update` | Later wave | Install or update harness packages once SDK/marketplace rules exist | SDK/marketplace and package gates |
| `migrate` | Later wave | Run explicit state/config migrations with rollback posture | Naming/release/docs gates |
| shell completions | Later wave | Generate shell completion scripts | CLI docs and package gates |
| host install helpers | Later wave | Install command packs for Codex, Claude Code, OpenCode, HermesAgent, and generic hosts | Host command-pack gate |

## Current CLI Inventory

Live source on this stacked branch shows:

| Current command | Runtime operation | Mutates runtime state | Current public posture |
| --- | --- | --- | --- |
| `doctor` | Local read-only diagnostics | No | Implemented as the first product-shell command; it diagnoses source-checkout, build-artifact, config, and package readiness without mutating runtime state. |
| `run` | `startRun` | Yes | Keep name. Public behavior must expand from start-only to full lifecycle when the orchestrator exists. |
| `status` | `getRun` | No | Keep name. |
| `events` | `getEvents` | No | Keep name with bounded output and redaction profile rules. |
| `replay` | `replay` | No | Keep name. Add verification mode before public release. |
| `report` | `writeRunReport` | Yes | Keep name. Split write/read/export behavior only if the docs and report packets require it. |
| `tool call` | `callTool` | Yes | Implemented as a privileged runtime adapter; JSON args are parsed before dispatch, and brokered denial/approval/failure results keep their result envelope with classified outcomes. |
| `eval run` | `runEval` | Yes | Implemented as a privileged runtime adapter; JSON output returns the eval verdict envelope, and blocking verdicts use classified nonzero outcomes while preserving verdict data. |
| `gate evaluate` | `evaluateGate` | Yes | Implemented as a privileged runtime adapter; JSON output returns the gate verdict and lifecycle instruction envelope, and blocking verdicts use classified nonzero outcomes while preserving result data. |
| `approve` | `recordApproval` | Yes | Keep name. Visible command must only resolve currently pending approvals. |
| `reject` | `recordApproval` | Yes | Keep name. Visible command must only resolve currently pending approvals. |
| `answer` | `recordEvidence` | Yes | Keep name, but final product behavior belongs to runtime-owned human question records. |

`help` is parsed by the CLI but is not part of the output-envelope command union because it is usage text rather than a runtime operation.

## Runtime Prerequisite Map

| Target command | Existing runtime substrate | Required before implementation |
| --- | --- | --- |
| `tool call` | `RuntimeApi.callTool` | Implemented on this stacked branch for explicit tool requests, JSON args, idempotency keys, requester phase, auth/deadline posture, broker result envelopes, and classified denial/approval/failure outcomes. Capability reference docs and richer examples remain downstream. |
| `eval run` | `RuntimeApi.runEval` | Implemented on this stacked branch for string eval identifiers, JSON verdict envelopes, auth/deadline posture, and classified blocking verdicts. Dataset/reporting docs and release-gate examples remain downstream. |
| `gate evaluate` | `RuntimeApi.evaluateGate` | Implemented on this stacked branch for string gate identifiers, JSON result envelopes, auth/deadline posture, lifecycle instruction rendering, and classified blocking verdicts. Phase overrides and broader command-reference examples remain downstream. |
| artifact record/read commands, if added | `RuntimeApi.recordArtifact` | Artifact command naming decision, schema selection, source binding, and docs. |
| `export` / `audit` | `RuntimeApi.generateReport`, operations packages, reports packages | Audit bundle format, retention/security policy, release compatibility, and docs. |
| full-lifecycle `run` | `startRun` plus future orchestrator | Phase runner, pending-state projection, retry/resume policy, eval/gate scheduling, and crash recovery. |
| runtime-owned `answer` | Current CLI uses `recordEvidence` | Human-question RuntimeApi method, event semantics, pending queue, replay behavior, and adapter parity. |

## Approval And Human-Input Posture

`approve` and `reject` stay visible public command names.

On the current stacked branch, they call `RuntimeApi.recordApproval` and fail closed for stale, missing, malformed, or already-resolved approval decisions. If the approval API is absent in a downstream base, the commands must remain contract-reserved and fail closed rather than fabricating approval state in the CLI.

`answer` stays visible, but its current evidence-record implementation is not the final product model. The target model is runtime-owned human question and answer records with durable pending-state projection, replay semantics, adapter parity, and audit evidence. That implementation belongs to the human-input runtime API packet.

## Config And Root Discovery

First-wave behavior keeps explicit `--cwd <path>` for run creation and `--root <path>` for run lookup commands.

Public config discovery is deferred to the naming/config gate. The target behavior is:

- `init` creates a canonical local Specwright config root after the naming gate approves the directory and file layout.
- Commands may run from nested project paths only after upward root discovery is deterministic and tested.
- Missing config, multiple candidate roots, unauthorized roots, and unsupported legacy layouts must produce classified errors with actionable operator messages.
- Explicit `--cwd` and `--root` flags remain available as deterministic overrides.

## UX And Output Policy

The CLI should standardize these conventions before any new command is public:

- Every mutating or runtime-observing command supports `--json`.
- JSON output uses a versioned envelope with `command`, `outcome`, optional `runId`, optional `data`, optional `pending`, optional `diagnostics`, and structured `error`.
- Human output is concise, sanitized, and free of raw restricted content.
- `--ci` selects noninteractive posture and should never widen authority.
- `--deadline <ms>` applies to all runtime operations.
- Read commands that can emit many records support bounded output and diagnostics when truncated.
- Redaction profiles are explicit, and privileged widening requires authenticated authority.
- Help text follows the same grouping and flag vocabulary as command reference docs.
- Errors use stable outcome classes and operator actions.

Current outcome classes and exit codes are:

| Outcome | Exit code | Retryable |
| --- | ---: | --- |
| `ok` | 0 | No |
| `usage_error` | 2 | No |
| `input_validation` | 3 | No |
| `denied` | 4 | No |
| `blocked` | 5 | Yes |
| `gate_failure` | 6 | No |
| `not_found` | 7 | No |
| `runtime_error` | 8 | No |
| `timeout` | 9 | Yes |
| `integrity` | 10 | No |
| `auth` | 11 | No |

New commands must reuse these classes unless a later CLI output-contract packet explicitly extends the namespace.

## Test And Documentation Requirements

No command is public-product complete until a later implementation packet adds or verifies:

- Parser, validation, success, auth, timeout, and classified-failure tests.
- JSON output-contract fixtures and schema validation.
- Human-output smoke tests where the command has human output.
- Runtime operation mapping tests that prove the CLI stays a thin adapter.
- Redaction, bounded-read, pending-state, and approval/human-input tests where applicable.
- Command reference documentation with examples, flags, output envelopes, exit codes, expected failures, and CI behavior.
- Fresh install smoke coverage after `@specwright/cli` is publishable.

## Deferred Implementation Owners

| Work | Owner |
| --- | --- |
| Public CLI package and installed command | `FEAT-001A` implementation packets |
| Command implementation for `init`, `config`, and command reference docs | `FEAT-002C` or CLI implementation packet |
| Full-lifecycle `run` | `FEAT-003A` lifecycle orchestrator packets |
| Runtime-owned approval/question APIs | `FEAT-004A`, building on `AUD-004A` |
| MCP server command relationship | `FEAT-005A` |
| Host command-pack helpers | `FEAT-006A` |
| Capability-backed `tool call` | `FEAT-007A` and capability-pack packets |
| Harness install/update and SDK marketplace flow | `FEAT-008A` |
| Durable config/store defaults | `FEAT-009A` |
| Memory commands, if any | `FEAT-010A` |
| Adapter parity and release gate | `FEAT-011A`, `FEAT-013A` |
| Public server-mode command relationship | `FEAT-012A` |
| Migration commands | `FEAT-014A` |
| Docs and install UX | `FEAT-015A` |

## Source Trace

| Claim | Source |
| --- | --- |
| CLI must become a stable product surface for project chat, terminals, and agent command surfaces | raw features log `F2`, `FEAT-EPIC-002` |
| Current commands are `doctor`, `run`, `status`, `events`, `replay`, `report`, `tool call`, `eval run`, `gate evaluate`, `approve`, `reject`, and `answer` | `packages/adapters-cli/src/index.ts`, CLI tests |
| Current output envelopes cover the runtime command union and outcome classes | `packages/adapters-cli/src/output-contract.ts`, `packages/adapters-cli/src/outcome.ts` |
| Current stacked CLI maps approval commands to `recordApproval` | `packages/adapters-cli/src/index.ts`, `packages/adapters-cli/src/index.test.ts`, upstream `AUD-004A` stack |
| Runtime exposes artifact APIs plus additional report/export APIs that still lack first-class CLI command families, while `tool call`, `eval run`, and `gate evaluate` now map to runtime tool/eval/gate APIs | `packages/runtime/src/index.ts`, `packages/adapters-cli/src/index.ts` |
| README still documents direct local Bun invocation and the intended installed command name | `README.md` |
| Public command targets include init, doctor, harness commands, full-lifecycle run, tool/eval/gate commands, durable approval/answer, export/audit, verified replay, config, completions, and host-install helpers | raw features log `F2` |

## Diff Boundary

This record does not approve or implement CLI source changes, runtime API changes, output-contract fixture rewrites, package/bin changes, README changes, install docs, generated artifacts, CI, release workflows, tags, GitHub settings, npm publish operations, raw-source edits, or wiki status edits. Those remain separate packets and gates.
