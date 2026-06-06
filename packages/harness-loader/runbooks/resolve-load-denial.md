# Resolve A Load Denial By Code

1. Read the `HarnessLoaderError.code`, `reason`, and `details`.
2. For `resource_limit_exceeded`, reduce package size or request reviewed limit changes.
3. For `promotion_unapproved`, add missing validation, trust, or approval evidence.
4. For `invalid_lifecycle_transition`, use only allowed registry transitions.
5. For `cache_poisoned`, discard the cache entry and re-derive from retained bytes.
6. For `version_not_resolvable`, restore the exact archived bytes for the pinned `specHash`.

Verification: rerun the denied operation and confirm no snapshot is served until the root cause is fixed.
