# Specwright

Specwright is a standalone product for strict, portable agent harness runtimes.
It gives teams a runtime-owned way to run source-bound work: the runtime owns run
state, lifecycle transitions, tool policy, evidence rules, artifacts, evals, and
replayable run packages. Host adapters are thin clients that call the runtime
and render its responses.

The architecture source of truth is the local Obsidian vault configured for this
workspace. This repository should not be treated as a replacement for that
vault. When the code and vault disagree, the vault wins until a scoped
implementation update reconciles the repo.

## Package Map

- `packages/schemas`: shared Zod contracts for harness specs, runtime events,
  run state, tools, evidence, artifacts, evals, and gates.
- `packages/run-store`: file-first run package creation, append-only events,
  materialized state, and replay projection.
- `packages/harness-loader`: declarative harness package loading and validation.
- `packages/policy-engine`: deterministic policy verdicts.
- `packages/gate-engine`: lifecycle gate verdicts and phase advancement
  instructions.
- `packages/tool-broker`: capability boundary for v0 filesystem tools
  (`fs.list` and `fs.read`).
- `packages/eval-runner`: deterministic fixture eval execution.
- `packages/evidence-store`: evidence recording for source facts, assumptions,
  human decisions, and unresolved unknowns.
- `packages/artifact-store`: schema-valid MVP artifact recording.
- `packages/trace-recorder`: trace span recording for runtime-observable work.
- `packages/run-reports`: summary generation from run package projections.
- `packages/runtime`: orchestration facade that wires stores, loader, policy,
  brokered tools, evals, gates, artifacts, traces, and reports.
- `packages/adapters-cli`: reference CLI adapter. It remains a runtime client,
  not an owner of lifecycle behavior.
- `harnesses/default`: the Default Harness v0 declarative package.

## Install

Install dependencies with Bun:

```bash
bun install
```

## Build, Test, And Typecheck

Build all workspace packages in dependency order:

```bash
bun run build
```

Run the root test suite:

```bash
bun test
```

Run TypeScript checks:

```bash
bun run typecheck
```

## V0 Proof

Run the single v0 proof command:

```bash
bun run proof:v0
```

The proof command builds the workspace and runs the simple-app E2E fixture. That
fixture starts a run, loads the default harness, records source-bound evidence
and artifacts, calls `fs.list` and `fs.read` through `ToolBroker`, evaluates
gates and evals, writes `summary.md`, and replays the run from the append-only
event log.

## Current MVP Limitations

- Default Harness v0 is a narrow source-bound planning fixture, not a full
  frontend-contract harness.
- The brokered v0 capability set is limited to `fs.list` and `fs.read`.
- There are no model calls, embeddings, browser or Playwright tools, shell
  execution, git mutation, MCP adapter, approvals, or handoff packet workflows
  in this slice.
- The CLI adapter is the reference adapter only; it should preserve runtime
  semantics rather than implement lifecycle behavior itself.
- Runtime outputs are meant to prove strictness, replayability, and source
  binding before product ambition.
