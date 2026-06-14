# MCP Server Packaging Decision

Status: accepted for downstream packet planning
Work unit: FEAT-005A-mcp-server-packaging-decision-record
Date: 2026-06-14
Decision authority: user-approved documentation authority for the Specwright productization sequence
Product/package/CLI assumptions: Specwright is a governed agent workflow runtime; `@specwright/cli` owns the installed CLI command; `@specwright/mcp-server` is reserved as the public MCP server package target.

## Decision

Specwright should ship a dedicated executable MCP server package named `@specwright/mcp-server`. The current `@specwright/adapters-mcp` package remains the in-process adapter library and protocol substrate. The server package should be a thin process/transport wrapper around that adapter, not a second runtime and not a hidden CLI shortcut layer.

Package and binary posture:

| Surface | Decision |
| --- | --- |
| `@specwright/mcp-server` | Public later-wave package that owns the MCP server executable and host setup contract. |
| `@specwright/adapters-mcp` | Internal or advanced library substrate for protocol dispatch, catalog, auth composition, limits, observability, and tests. It may carry an adapter-scoped local stdio executable for implementation smoke tests, but that binary is not the public server package contract. |
| Server executable name | Deferred to the package implementation packet, with preference for a package-local executable that is unambiguous in host config. |
| `createMcpServer` export | Current alias remains source evidence only. It must not be marketed as a transport/process server until a real server wrapper exists. |

## Transport Scope

First-wave transport is stdio only.

Stdio is the right first transport because it is the common local integration path for MCP-capable coding hosts and avoids introducing network listener security before auth, deployment, and server-mode gates are ready.

Deferred transports:

- HTTP.
- SSE.
- WebSocket.
- Long-running remote daemon mode.
- Hosted/team runtime server mode.

Remote or network transports require an authenticated profile, server-mode decision, lifecycle tests, and release/security review before implementation.

## Auth Profiles

The server must fail closed when a profile is ambiguous.

| Profile | First-wave posture |
| --- | --- |
| Local stdio | Allowed as a local-only profile with no network listener. It may use the adapter's disabled auth mode only when the process is launched by the local user and all runtime roots are explicit. |
| CI | Config-required. Principal, tenant, allowed roots, scopes, and redaction posture must be explicit before mutating tools run. |
| Enterprise authenticated | Required for any multi-user, remote, shared, or networked transport. Credential verification, subject binding, tenant checks, scopes, and audit identity are mandatory. |
| Local dev | May be a named profile, but it must render in config as local-only and non-networked. |

The current adapter default normalizes to disabled security unless authenticated mode is configured. That is acceptable as an in-process library default, but the executable server package must make profile selection explicit in startup validation.

## Tool Catalog Boundary

The MCP server should expose runtime operations, not CLI commands.

First server wave may expose the current enabled adapter catalog:

| MCP tool | Runtime operation | Mutates |
| --- | --- | --- |
| `specwright_start_run` | `startRun` | Yes |
| `specwright_get_run` | `getRun` | No |
| `specwright_get_events` | `getEvents` | No |
| `specwright_replay` | `replay` | No |
| `specwright_call_tool` | `callTool` | Yes |
| `specwright_run_eval` | `runEval` | Yes |
| `specwright_record_evidence` | `recordEvidence` | Yes |
| `specwright_record_artifact` | `recordArtifact` | Yes |
| `specwright_evaluate_gate` | `evaluateGate` | Yes |
| `specwright_generate_report` | `generateReport` | No |
| `specwright_write_report` | `writeRunReport` | Yes |

Human-loop tools remain disabled until FEAT-004 implementation exists:

- `specwright_get_next_action`
- `specwright_answer_question`
- `specwright_record_approval`

Resources and prompts may use the current adapter catalog, provided they remain read-only resources and runtime action descriptors rather than hidden command execution shortcuts.

## Host Setup Scope

First-wave docs and smoke tests should cover stdio setup for:

- Codex.
- Claude Code.
- OpenCode.
- Generic MCP clients that support local stdio server commands.

HermesAgent setup is deferred until host-kind, command-pack, and adapter-priority decisions include it explicitly.

Host setup snippets belong to the MCP server implementation/docs packet, not this decision packet. Each snippet must include the package command, local profile, project root/config expectations, and a warning that remote transports are not first-wave.

Implementation update: the first executable packets add `specwright-mcp-adapter` in `@specwright/adapters-mcp` as a repo-local stdio wrapper around `createMcpAdapter`. It requires `--profile local-stdio --root <path>` for local mode or `--profile ci --root <path> --client-id <id> --tenant-id <id> --scopes <scopes>` for CI mode, reads newline-delimited JSON-RPC from stdin, writes only protocol messages to stdout while serving, and keeps the dedicated public `@specwright/mcp-server` package deferred.

Implementation update: the adapter-local executable can print source-checkout host snippets with `--print-host-config <host>` for `codex`, `claude-code`, `opencode`, and `generic`. The snippets cover local stdio and CI stdio launch arguments only; remote, HTTP/SSE, managed, and enterprise network profiles remain deferred to the public server-mode/security packets.

## Process Lifecycle Requirements

The executable server packet must define and test:

- Startup config validation before accepting protocol messages.
- MCP initialize and capability negotiation.
- Clean stdout/stderr behavior for stdio transport.
- Graceful drain on shutdown.
- Cancellation propagation where the transport/client supports it.
- Runtime operation deadlines and timeouts.
- Session accounting and correlation IDs.
- Backpressure/load-shed behavior instead of unbounded queues.
- Audit and trace flush before process exit.
- Redaction-safe errors for protocol and runtime failures.
- No persistence of authority in process-local caches after restart.

The current in-process adapter has strong dispatch, limits, auth, observability, and conformance substrate, but it does not by itself satisfy process lifecycle requirements.

## Integration Test Posture

Later MCP server implementation must add a staged test stack:

| Test level | Required coverage |
| --- | --- |
| In-process adapter tests | Continue covering catalog, dispatch, auth, resources, prompts, limits, versioning, external mediation, and observability. |
| Spawned stdio process tests | Start the executable, perform initialize, list tools, call read and mutating tools, validate JSON-RPC/protocol behavior, and shut down cleanly. |
| Negative transport tests | Invalid JSON, unknown methods, invalid tool args, disabled tools, missing config, bad profile, unauthorized scopes, timeout, cancellation, and backpressure. |
| Host smoke tests | Verify documented stdio config for each supported host where feasible, with unsupported hosts recorded as deferred. |
| Release checks | Ensure package tarball contains executable server assets, declarations where relevant, and no private workspace-only dependency leakage. |

## Current Repo Evidence

Live source on this stacked branch shows:

- `@specwright/adapters-mcp` is private `0.0.0` and has `main`, `types`, `exports`, `files`, and an adapter-scoped `specwright-mcp-adapter` bin.
- No `@specwright/mcp-server` package exists.
- `@specwright/cli` is the only package manifest with a `specwright` executable bin.
- `McpAdapter` is an in-process TypeScript API with `tools`, `resources`, `prompts`, optional `observability`, and `dispatch`.
- `createMcpServer` is currently an alias to `createMcpAdapter`; process transport is owned by the adapter-scoped stdio wrapper, not by this alias.
- Dispatch handles `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get`.
- Security defaults to disabled unless authenticated mode is explicitly configured.
- Future human-loop MCP tools are present as disabled catalog entries.

## Downstream Owners

| Work | Owner |
| --- | --- |
| Public server package manifest, executable, and package metadata | FEAT-005 implementation packet plus FEAT-001 package implementation |
| Stdio transport implementation | FEAT-005 implementation packet |
| HTTP/SSE or other network transports | Runtime server mode and MCP follow-up packets |
| Auth profiles and credential verification for remote/shared use | FEAT-005 plus FEAT-012 server-mode/security packets |
| Human-loop MCP tools | FEAT-004 implementation before FEAT-005 enablement |
| Host config snippets and install UX | Adapter-local source-checkout snippets are implemented for FEAT-005; installed-package host setup and command packs remain FEAT-006 and FEAT-015 |
| Release, provenance, compatibility, and package dry-run | FEAT-013 |
| CI checks and required status contexts | OPT-001 and release packets |

## Source Trace

| Claim | Source |
| --- | --- |
| Specwright needs an executable MCP server, not only adapter library code | raw features log `F5`, `FEAT-EPIC-005` |
| Future package shape is either `@specwright/mcp-server` or an MCP adapter bin | raw features log `F5` |
| Current MCP package is an in-process adapter with an adapter-scoped local stdio bin and host-config helper | `packages/adapters-mcp/package.json`, `packages/adapters-mcp/src/index.ts`, `packages/adapters-mcp/src/bin.ts`, `packages/adapters-mcp/src/stdio.ts` |
| Current server-named factory is only an alias | `packages/adapters-mcp/src/index.ts` |
| Existing adapter dispatch, resources, prompts, auth, limits, observability, and disabled future tools are useful substrate | `packages/adapters-mcp/src/index.ts`, adapter tests |
| Current package taxonomy reserves `@specwright/mcp-server` as a later public target | `docs/package-taxonomy-decision.md` |
| CLI command taxonomy says MCP should expose runtime operations, not private command shortcuts | `docs/cli-command-taxonomy-decision.md` |

## Diff Boundary

This record does not approve or implement a new package, package manifest changes, MCP bins, transport code, server processes, host snippets, docs beyond this decision record, auth behavior changes, runtime/CLI changes, generated artifacts, CI, release workflows, GitHub settings, npm publish operations, raw-source edits, or wiki status edits. Those remain separate packets and gates.
