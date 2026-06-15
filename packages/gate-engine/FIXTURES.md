# Gate Engine Fixtures

The `packages/gate-engine/fixtures/` directory is the conformance contract for this package.

## Governance Surface

- [fixtures/MANIFEST.json](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/fixtures/MANIFEST.json) records every governed fixture directory and the sha256 of each top-level JSON artifact inside it.
- `collectFixtureGovernanceState(...)`, `readFixtureGovernanceManifest(...)`, and `assertFixtureGovernance(...)` live in [src/fixture-governance.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/fixture-governance.ts).
- The guard test is [src/index.fixtures.test.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/index.fixtures.test.ts).

## What Is Governed

Every top-level `.json` file inside a fixture directory is governed. Today that includes:

- `request.json`
- `expected-result.json`
- `expected-audit.json`
- `recorded-result.json`
- replay pair files under `repair-loop-relinked/`
- the new Packet 06 fixtures `definition-changed/` and `recorded-verdict-replay/`

The manifest currently covers 26 fixture directories: the 24 pre-existing directories in the package plus `definition-changed` and `recorded-verdict-replay`.

## Fail-Closed Rules

- If the fixture corpus on disk does not match `MANIFEST.json`, the suite fails closed.
- If governed fixture drift is present without a migration descriptor, the suite fails closed.
- If a migration descriptor is present but its `affectedFixtures` list does not exactly match the changed fixtures, the suite fails closed.
- A descriptor with an empty `rationale` is invalid.

## Migration Descriptors

- Descriptor shape and validation live in [src/migration-descriptor.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/migration-descriptor.ts).
- This packet does not commit a live descriptor because it preserves the existing evaluator ref and existing fixture verdicts.
- Future governed fixture edits should pair the changed manifest entries with a valid `MigrationDescriptor` and a non-empty rationale before they are treated as admissible.

## Operational Intent

- Do not rewrite a fixture to force the suite green.
- Treat fixture updates as contract changes.
- Keep `MANIFEST.json` synchronized with the committed fixture corpus.
