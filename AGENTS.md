# Specwright Supervisor Protocol

## Project Identity

This project is **Specwright**.

Specwright is the successor project guided by the Obsidian vault at:

```txt
/Users/nikolacehic/Desktop/Archetype-Harness-Wiki
```

That vault is the source of truth for architecture, lifecycle, runtime boundaries, policies, gates, handoffs, evals, and roadmap decisions.

## Supervisor Chat Role

The main Specwright chat acts as the orchestration and supervisor layer.

It owns:

- project-level continuity
- interpretation of the vault
- scope decomposition
- handoff packet creation
- review of scoped-chat completion reports
- reconciliation of scoped work against the vault

It does not blindly trust scoped chats. Handoffs are evaluated by observable outputs.

## Scoped Chat Role

A scoped chat receives one bounded task.

It must:

- read this file first
- read only the vault pages named in its handoff packet
- treat the vault as source truth
- stay inside the assigned scope
- avoid unrelated refactors
- report changed files, checks, skipped checks, and unresolved questions

Scoped chats should not search the web for Archetype-related context unless the supervisor explicitly permits it.

## Source Truth Rule

For Archetype and Specwright architecture, use only:

- this repository
- the supervisor-provided handoff packet
- `/Users/nikolacehic/Desktop/Archetype-Harness-Wiki`

If a claim is not supported by those sources, mark it as an assumption or ask the supervisor.

## Handoff Packet Shape

The supervisor should give scoped chats a compact packet:

```txt
Task:
Goal:
Non-goals:
Allowed files:
Forbidden files:
Vault pages to read:
Relevant decisions:
Acceptance checks:
Completion report required:
```

Packets should be small, explicit, and scoped to one piece of work.

## Completion Report Shape

Every scoped chat should return:

```txt
Status:
Files changed:
Vault pages used:
Decisions followed:
Checks run:
Checks skipped:
Assumptions:
Open questions:
```

The supervisor uses this report to decide whether work is accepted, repaired, or split into another packet.

## Non-Negotiables

- Runtime owns lifecycle behavior.
- Host adapters are thin runtime clients.
- All external capabilities go through `ToolBroker`.
- `PolicyEngine` is deterministic and side-effect-free.
- `GateEngine` controls lifecycle advancement.
- Event logs are append-only source of truth.
- Artifacts are schema-valid and evidence-bound.
- Model output is proposal, not authority.
- Human approval authorizes decisions but does not turn unsupported claims into source facts.

## Initial Build Bias

Prefer the vault roadmap:

1. shared schemas
2. file-first run store
3. harness loader
4. policy engine fixtures
5. gate engine fixtures
6. tool broker with `fs.list` and `fs.read`
7. minimal eval runner
8. CLI reference adapter
9. MCP adapter

Keep the first implementation narrow enough to prove runtime strictness before product ambition.
