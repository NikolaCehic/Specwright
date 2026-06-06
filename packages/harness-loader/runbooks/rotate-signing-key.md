# Rotate A Publisher Signing Key

1. Add the new active publisher key to the tenant trust store and mark old compromised keys revoked or expired.
2. Re-sign affected candidate package versions with the new signing key.
3. Promote each re-signed candidate through `HarnessRegistry.promote(...)` with fresh approval.
4. Leave historical attestations and retained bytes intact so old pinned `specHash` values remain auditable.

Failure codes: `trust_rejected`, `promotion_unapproved`, `version_immutable`.
