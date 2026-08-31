# @j1nn0/agent-supervisor-pi

## Status

This package is experimental, private, and not published to npm. It contains pure TypeScript contracts and unit tests for a future Autonomous Agent Supervisor.

This is **not yet a Pi extension**. There is no extension entrypoint, no Pi event wiring, and installing this package currently provides **no autonomous behavior**. S0-A defines contracts and unit tests only.

The eventual product goal is install-and-forget autonomous improvement. The default global mode is `autonomous`, so the intended product profile requires no setup.

## Feature model

The feature set is open-ended. Features are independently configurable: each feature has its own `autonomous`, `observe`, or `off` mode, subject to a global mode that acts as a ceiling.

- `autonomous` permits autonomous operation when dependencies and conflicts resolve.
- `observe` permits shadow evaluation without autonomous execution.
- `off` disables the feature.
- `unavailable` is a runtime resolution result, never a persisted user setting.

Maturity describes how a feature should be introduced:

- `experimental`: new behavior, normally introduced in `observe` mode. An experimental feature may not default to `autonomous`.
- `validated`: benchmark evidence exists.
- `default`: worth enabling autonomously in the install-and-forget profile.

An `observe` feature still receives observations and may produce facts and intervention proposals. Its proposals are shadow evaluation only and are never executed. Kernel arbitration owns intervention execution; features never call Pi APIs such as `sendMessage`, `sendUserMessage`, blocking, or aborting directly.

No feature may directly invoke another feature. There is no `getFeature` or `callFeature` API. Features communicate only through the observation bus, the fact bus, and intervention proposals routed through the kernel.

## Identifiers

Feature IDs use a strict lowercase segment grammar:

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

A segment must start with a lowercase letter. Dashes cannot be leading, trailing, or doubled. Examples: `feature-a` and `provider-x`.

Capability IDs, fact kinds, and reason codes use exactly two such segments separated by one colon:

```text
<segment>:<segment>
```

Examples include `provider-x:ready`, `feature-a:signal`, and `feature-a:review`. `kernel` matches the segment grammar syntactically but is a reserved authority/source namespace: no registered feature may use the feature ID `kernel`. Feature facts own `<feature-id>:*`, feature intervention reason codes own `<feature-id>:*`, and only kernel-sourced facts may use `kernel:*`.

Observation kinds are unprefixed segment IDs. Built-in kinds are available as a constant, but future kinds can be added without changing the type contract.

## Configuration

The install-and-forget default is:

```json
{
  "schemaVersion": 1,
  "mode": "autonomous",
  "features": {}
}
```

Each feature entry may contain a mode and JSON-safe settings. The kernel checks only that settings are JSON-safe; a registered feature owns semantic settings validation.

A well-formed entry for an unknown future feature, other than a reserved ID such as `kernel`, is preserved rather than rejected, so its setting can be reused when that feature ships. An invalid per-feature entry, including invalid settings, is excluded and isolated to that feature; a reserved `kernel` entry is likewise excluded with a distinct reserved-ID diagnostic, and sibling entries remain usable. A corrupt top-level configuration is degraded to an `observe` ceiling. It never silently falls back to global `autonomous`.

## Registry and plan resolution

The registry hard-rejects duplicate feature IDs; registration is never last-wins. Plans list features in ascending ID order and are independent of registration order and configuration key insertion order.

Capability dependencies resolve by least fixed point. Kernel capabilities and capabilities provided by satisfied features become available across passes. An unrooted dependency cycle fails safe: every remaining member is `unavailable` with `dependency-unsatisfied`. Conflicts are resolved before dependencies; when both enabled candidates conflict, **both** become `unavailable` with `conflict`. No winner is selected automatically.

## Dispatch and fact visibility

The dispatcher validates feature identities as registrable IDs and rejects invalid or duplicate IDs before invoking any runtime. It invokes subscribed, available features in ascending feature-ID order. It buffers emitted facts and proposals, validates them, and assigns fact sequences in dispatch order. A feature cannot emit a proposal on behalf of another feature.

### SAME-DISPATCH FACT VISIBILITY RULE

All features handling one observation see the same pre-dispatch fact snapshot, and facts emitted during that dispatch become visible only after it finishes. A feature's newly emitted facts are therefore never visible to another feature handling the same observation.

Fact identity and ordering are kernel-owned. Feature fact candidates carry only a namespaced kind, evidence references, and JSON-safe data; the kernel stamps the record ID, sequence, source feature, and root request.

## Intervention arbitration

Arbitration groups proposals by boundary. Tool-call proposals are additionally isolated by target tool-call ID; stream and settled proposals use a `null` target. A tool-call proposal never competes with a settled proposal, and different tool-call targets never compete.

`arbitrateInterventions` validates every incoming proposal itself before grouping; a malformed proposal is a hard contract rejection.

Only proposals from `autonomous` features are eligible to win. Proposals from `observe` features are placed in `observedOnly` and cannot win or suppress anything. Proposals from `off`, `unavailable`, or unknown features are `ineligible`.

Intent rank is semantic and always dominates numeric priority:

| Rank | Intent |
| ---: | --- |
| 5 | `stop` |
| 4 | `handoff` |
| 3 | `change-strategy` |
| 2 | `verify` |
| 1 | `continue` |

Within one intent, the tie-break order is:

1. priority descending;
2. source feature ID ascending;
3. reason code ascending.

Each isolated group elects its own winner. Other eligible proposals are `suppressed`; messages are not merged.

## Privacy invariant

Supervisor operational persistence must never be assumed to hold full observation history, full transcripts, full tool results, raw stdout, or raw file contents. Persisted state is the small, JSON-safe, feature-owned envelope only. The contracts in this package do not add filesystem access, network access, telemetry, or model calls.

## Deterministic benchmark contract

S0-B adds a pure, dependency-free benchmark data contract, frozen release policy, exact aggregation, and JSON-safe evaluator. The evaluator validates the dataset first, binds the plan policy ID, evaluates all 14 hard gates in fixed order, and applies `fail` before `insufficient-data` before `pass`. See [`BENCHMARK.md`](BENCHMARK.md) for the contract.

The checked-in benchmark fixture is synthetic control data for contract tests only. It is not evidence of model quality or a real benchmark run; no runner, provider call, network access, filesystem access, or telemetry is included, and no performance claim is made.

## Reserved initial names

`kernel` is a permanently reserved authority/source namespace, not a feature ID that a future or third-party feature may claim.

The planned initial built-in feature IDs are:

- `retry-loop-breaker`
- `completion-gate`
- `auto-state`
- `auto-progress`
- `auto-evidence`
- `context-continuity`
- `auto-budget`
- `auto-handoff`

The feature set is open-ended. These are planned initial built-ins, not an exhaustive enum. None of them is implemented yet.

## Not in this stage

S0-A deliberately omits:

- the Pi extension runtime and event wiring;
- retry-loop behavior and completion-gating behavior;
- auxiliary LLM assessment;
- automatic state/progress behavior;
- context recovery;
- automatic handoff;
- real benchmark execution;
- npm release.
