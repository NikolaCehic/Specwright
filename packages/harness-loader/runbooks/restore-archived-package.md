# Restore An Archived Harness Package

1. Locate the archived immutable package bytes for the requested `specHash`.
2. Rehydrate the registry store with the exact relative paths and bytes.
3. Call `resolveSnapshot(specHash)` and require a successful cache re-verification through `computeSpecHash`.
4. If bytes do not match the requested hash, reject the restore and keep the run non-resolvable.

Failure codes: `version_not_resolvable`, `cache_poisoned`.
