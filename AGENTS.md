# Specwright Agent Instructions

## Project Identity

This project is **Specwright**.

Use this repository as the primary source of truth unless the user explicitly provides another source for the current task.

## Working Rules

- Keep changes scoped to the user's request.
- Prefer existing repository patterns over new abstractions.
- Do not import external project context unless the user supplies it in the task.
- Treat generated model output as a proposal until it is validated by code, tests, schemas, or user approval.
- Report changed files, checks run, skipped checks, assumptions, and open questions when completing scoped implementation work.

## Implementation Quality Bar

- Do not treat application work as an MVP, v0, thin slice, slim vertical, demo, or happy-path-only implementation unless the user explicitly asks for that reduced scope.
- Build for enterprise-grade use: reliable under realistic load, observable, secure by default, and explicit about operational boundaries.
- Build for failure, not just one successful flow. Include error paths, degraded states, retry/recovery behavior, validation, malformed input handling, and permission or policy failures where relevant.
- Keep implementations testable, maintainable, and scalable. Prefer clear module boundaries, deterministic behavior, focused tests, and code that can grow without becoming fragile.
- Performance is part of correctness. Avoid unnecessary work, unbounded operations, avoidable memory growth, and designs that will obviously collapse under scale.

## Runtime Principles

- Runtime owns lifecycle behavior.
- Host adapters are thin runtime clients.
- External capabilities go through `ToolBroker`.
- `PolicyEngine` is deterministic and side-effect-free.
- `GateEngine` controls lifecycle advancement.
- Event logs are append-only source of truth.
- Artifacts are schema-valid and evidence-bound.
