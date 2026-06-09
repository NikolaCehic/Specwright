# Specwright Default Harness v0

This declarative package is the first strict runtime fixture for Specwright. It
defines a minimal source-bound planning run through phases, gates, policies,
tools, artifact schemas, and eval definitions.

`gates/verification.model_review.yaml` remains in the package as a constrained
model-assisted example with explicit schemas, redacted inputs, and broker-facing
provenance. It is intentionally not wired into the active v0 runtime path until
the runtime can execute brokered async gate evaluation end to end. Broad
generation remains intentionally omitted: `model.generate` is still not part of
the package, and planning artifacts remain source-bound runtime artifacts until
that wider capability is separately governed.
