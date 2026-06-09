# Policy Governance

The policy engine is deterministic and side-effect-free. Policy behavior changes through committed fixtures, reviewed bundle changes, and the package validation gate. There is no runtime edit path in this package.

## Validation Gate

Run the package gate before reviewing a policy change:

```bash
bun run --cwd packages/policy-engine validate:policy
```

The gate discovers every committed directory under `packages/policy-engine/fixtures/`, validates verdict fixtures with `PolicyBundleSchema`, `loadPolicyBundles`, and `PolicyVerdictSchema`, re-evaluates each verdict fixture, checks exact equality including `decisionHash`, verifies repeated evaluation byte stability, enforces domain coverage, verifies replay records, and asserts required mutation cases are stricter-or-deny.

## Acknowledging Decision Hash Changes

Golden `decisionHash` changes are blocking until explicitly acknowledged. A reviewer should treat a hash delta as behavior movement unless the diff explains why it is expected.

Acknowledgement procedure:

1. Run `bun run --cwd packages/policy-engine validate:policy` and inspect the failing fixture names.
2. Review the request, policy bundle, expected verdict, matched rules, constraints, and obligations for each changed fixture.
3. Classify the change using the review matrix below.
4. If the change is intended, regenerate only the manifest with:

```bash
bun run --cwd packages/policy-engine validate:policy -- --bless
```

5. Commit the changed `packages/policy-engine/decision-hash-baseline.json` with the fixture or policy change that caused the acknowledged delta.

The bless command does not repair invalid fixtures. It only refreshes the acknowledged hash manifest after the corpus already validates.

## Review Matrix

| Change class | Required review | Gate evidence |
| --- | --- | --- |
| Add or tighten a `toolPolicy`, `budgetPolicy`, scope, or obligation | policy owner | fixture proves stricter-or-equal outcome |
| Loosen any rule, such as `deny` to `allow` or `approval_required` to `allow` | policy owner and security review | bounded fixture update plus mutation coverage proves the movement is intended |
| Change `runtime_invariant` rules, `LAYER_ORDER`, `DECISION_EFFECTS`, or `actionRisk()` defaults | runtime maintainer and security review | full fixture and replay corpus pass with acknowledged hash deltas |
| Change verdict or bundle contract shape | runtime maintainer and contract owner | compatibility classification, schema validation, migration or replay evidence |
| Host policy snapshot behavior change | operator | recorded host constraint remains dominant; host deny still wins |

Loosening changes carry the heaviest review because they move the system toward allow. They need a bounded rationale, fixture evidence for the intended allow, and a negative mutation or replay case proving the change does not widen unrelated actions.

## Domain Coverage

Each verdict fixture has a `meta.json` role and domain. The gate enforces allow, deny, and approval-or-constraint coverage for every verdict domain currently present:

- `approval-governance`
- `budget-governance`
- `capability-admission`
- `replay-governance`
- `scope-governance`

Load-failure fixtures are still discovered and gated, but their role is bundle-load governance rather than verdict-domain coverage.

## Operational Interpretation

Gate failures are interpreted as follows:

| Failure | Meaning | Operator action |
| --- | --- | --- |
| Fixture missing required files | The corpus is ambiguous | add the missing file or mark the directory with a valid non-verdict role |
| Bundle load failure in a verdict fixture | The fixture cannot reach evaluation safely | fix the bundle or reclassify the fixture as a load-failure case |
| Expected verdict schema failure | The golden verdict is not a valid contract artifact | repair the fixture before review |
| Recomputed verdict mismatch | Policy behavior changed | review the matched rules and expected verdict, then update the fixture only if intended |
| Baseline mismatch | Hash movement is not acknowledged | run the review procedure and commit the regenerated manifest when approved |
| Domain coverage failure | A policy domain lacks allow, deny, or approval/constraint proof | add or reclassify fixtures before merge |
| Mutation failure | A tightening mutation moved toward allow or did not become stricter | block the change and review for fail-open behavior |
| Replay mismatch | Historical decision equivalence changed or an expected replay failure is not classified | review input drift, bundle pinning, and migration impact |

Repository branch protection must mark the policy validation workflow as required in GitHub settings for the gate to become merge-blocking.
