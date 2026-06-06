# Quarantine A Harness Package Version

1. Call `HarnessRegistry.quarantine({ packageId, version, reason })`.
2. The registry purges derived cache entries for the version's `specHash`.
3. New current-version resolution must skip the quarantined version.
4. Replay and audit access by pinned `specHash` remains available from retained immutable bytes.

Failure codes: `version_not_resolvable`, `invalid_lifecycle_transition`, `cache_poisoned`.
