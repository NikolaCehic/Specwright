# Roll Back A Bad Promotion

1. Identify the bad package id, version, and promoted `specHash`.
2. Call `HarnessRegistry.quarantine(...)` for emergency isolation or `HarnessRegistry.deprecate(...)` for normal rollback.
3. Confirm `resolveCurrentTrusted(packageId)` now returns the prior trusted version.
4. Confirm any in-flight or historical run pinned to the bad version's `specHash` still resolves with `resolveSnapshot(specHash)`.

Failure codes: `version_not_resolvable`, `invalid_lifecycle_transition`, `cache_poisoned`.
