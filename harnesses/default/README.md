# Specwright Default Harness v0

This declarative package is the first strict runtime fixture for Specwright. It
defines a minimal source-bound planning run through phases, gates, policies,
tools, artifact schemas, and eval definitions.

`model.generate` is intentionally omitted in v0. The current package set has
filesystem capabilities and deterministic eval execution, but not a declared
model tool schema or broker adapter. Planning artifacts remain source-bound
runtime artifacts; model proposal support can be added as a later explicit tool
declaration.
