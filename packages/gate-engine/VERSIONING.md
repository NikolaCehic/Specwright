# Gate Engine Versioning

This package versions gate behavior as an evaluator identity plus a declared compatibility changelog.

## Current Versions

- `GATE_CONTRACT_VERSION` is `1.0.0` in [src/gate-contract-version.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/gate-contract-version.ts).
- `GATE_ENGINE_EVALUATOR_VERSION` is `1.0.0` in [src/gate-contract-version.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/gate-contract-version.ts).
- `DEFAULT_GATE_ENGINE_EVALUATOR` stays byte-stable as `gate-engine:specwright.gate-engine@1.0.0#gate-contract=1.0.0` in [src/evaluator-identity.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/evaluator-identity.ts).
- The structured canonical ref for the same semantics is `gate-engine:specwright.gate-engine@1.0.0#gate-contract=1.0.0`.

## Evaluator Identity

- `GateEngineEvaluatorIdentitySchema` defines the structured replay anchor in [src/evaluator-identity.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/evaluator-identity.ts).
- `serializeCanonicalEvaluatorRef(...)` emits the structured ref.
- `serializeEvaluatorRef(...)` emits the preferred stored ref. For the baseline `1.0.0` semantics, the preferred ref is `gate-engine:specwright.gate-engine@1.0.0#gate-contract=1.0.0`.
- `parseEvaluatorRef(...)` resolves the structured ref. Unknown refs return `undefined` and must fail closed on replay.

## Compatibility Classes

The package declares six compatibility classes in [src/compatibility.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/compatibility.ts):

- `patch-compatible`
- `additive-compatible`
- `forward-compatible`
- `backward-compatible`
- `migration-required`
- `breaking`

The append-only changelog lives in [src/engine-changelog.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/engine-changelog.ts). The baseline `1.0.0` entry is `forward-compatible`.

## Change Rules

- A verdict-semantic change must bump `GATE_ENGINE_EVALUATOR_VERSION`. That rule is encoded by `VERDICT_SEMANTICS_VERSION_RULE` and `assertVerdictSemanticsVersionBump(...)` in [src/gate-contract-version.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/gate-contract-version.ts).
- `assertEngineChangelogInvariants(...)` verifies that changelog versions increase, the latest changelog version matches the evaluator version, verdict-semantic changes bump the version, and `migration-required` or `breaking` entries declare a `migrationDescriptorId`.
- The current packet preserves existing verdict semantics, so the stored default ref does not change.

## Definition Hashing And Mid-Run Change Detection

- `hashGateDefinition(...)` in [src/definition-hash.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/definition-hash.ts) hashes the governed semantic projection of the resolved gate definition with stable key ordering, excluding ignored non-governed extras.
- `detectDefinitionChange(...)` in [src/definition-change.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/definition-change.ts) compares a run's pinned definition hash to the current resolved definition and emits the pure `gate.definition.changed` signal when they differ.
- The engine emits the signal only. Writing any runtime event remains out of scope for this package and belongs to the runtime consumer.

## Replay

- Recorded `gate-engine:specwright.gate-engine@1.0.0#gate-contract=1.0.0` verdicts replay against the structured `1.0.0` semantics.
- Replay coverage lives in [src/replay.test.ts](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/src/replay.test.ts) and the governed fixture [fixtures/recorded-verdict-replay](/Users/nikolacehic/Documents/Specwright/packages/gate-engine/fixtures/recorded-verdict-replay).
- An unresolvable recorded evaluator ref is treated as an audit gap and must fail closed rather than fabricate a re-derived verdict.
