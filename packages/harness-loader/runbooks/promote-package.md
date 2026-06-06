# Promote A Harness Package Version

1. Stage the package bytes with `HarnessRegistry.stageCandidate({ packageId, version, packageDir })`.
2. Run `HarnessRegistry.promote(...)` with strict trust inputs, versioned limits, and a recorded `PromotionApproval`.
3. Promotion succeeds only after dry-run validation, verified publisher signature, and approval evidence.
4. Verify the returned lifecycle state is `trusted` and the returned `specHash` resolves with `resolveSnapshot(specHash)`.

Failure codes: `promotion_unapproved`, `trust_rejected`, `resource_limit_exceeded`, `invalid_lifecycle_transition`, `version_immutable`.
