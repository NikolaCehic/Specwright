# Tool Broker Governance Gate

The broker conformance gate protects the executable capability surface. It runs
the committed fixture corpus, compares every deterministic status/error/provenance
field against `provenance-baseline.json`, enforces coverage for every registered
capability, checks workspace containment, and replays recorded `tool.*` events
under the current registry.

## Running The Gate

```bash
bun run --cwd packages/tool-broker conformance:broker
```

The gate is offline and deterministic. It uses the real `ToolBroker.callTool()`,
the default registry, the committed fixture workspace, the shared request/result
schemas, and the recorded replay corpus. It does not call models, hosts, or the
network.

## Acknowledging A Golden Delta

A status, `error.code`, `argsHash`, `resultHash`, `cacheStatus`, or `toolVersion`
change is blocking unless the PR explicitly updates the golden data. To bless a
deliberate change:

```bash
SPECWRIGHT_BLESS_BROKER_CONFORMANCE=1 bun test packages/tool-broker/src/conformance-runner.test.ts
```

Then review and commit the changed fixture `expected.json` files and
`packages/tool-broker/provenance-baseline.json` in the same PR as the code or
fixture change. Do not hand-edit hashes. Do not update the baseline without a
review note explaining why the changed behavior is intended.

## Review Matrix

| Change class | Examples | Required review |
| --- | --- | --- |
| Additive fixture | new allow/deny/failure case for an existing capability | broker maintainer |
| Behavior-changing | status, `error.code`, `argsHash`, `resultHash`, or `cacheStatus` delta | broker maintainer plus explicit baseline acknowledgement |
| Risk-raising | higher capability `risk`, broader `requestedScopes`, looser limits, relaxed containment, relaxed redaction | security review plus bounded negative fixture |
| New capability | new `CapabilityDefinition` in the registry | allow, deny, and failure/redaction fixtures before merge |
| Replay migration | historical `tool.*` event no longer resolves under the current registry | migration note plus fail-closed replay fixture |

The broker itself remains the only capability path. Reviewers should reject any
change that bypasses `ToolBroker.callTool()`, rewrites recorded replay events as
authority, silently rehashes historical provenance, or turns an unsupported tier
into execution without a sanctioned runner contract.
