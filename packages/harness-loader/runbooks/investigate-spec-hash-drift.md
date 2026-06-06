# Investigate SpecHash Drift

1. Freeze promotion for the affected package id and version.
2. Compare the prior promoted `specHash` with the newly observed hash and retained bytes.
3. If the version label points to different bytes, reject promotion with `version_immutable` and quarantine the candidate source.
4. Verify historical runs still resolve by their pinned `specHash`.

Failure codes: `version_immutable`, `cache_poisoned`, `version_not_resolvable`.
