# @j1nn0/agent-supervisor-pi

## Status

This package is experimental, private, and not published to npm.

This **is now a Pi extension**. The Kernel runtime is active after installation: it normalizes Pi lifecycle events, tracks Root Requests, owns Supervisor persistence, resolves the feature plan, and owns intervention transport.

There are still **no autonomous product features** in S1. The current built-in feature count is **zero**, so installing S1 alone **does not yet improve task effectiveness**. What S1 delivers is the control plane that S2 features will run on.

The Supervisor registers **no model-callable tools**. The model cannot operate the Supervisor; only a human operator can, through one command namespace.

The default global mode is `autonomous`, so the intended product profile requires no setup. Features are independently configurable.

S2 introduces the first autonomous behavior.

## Kernel runtime

The extension entrypoint is `./dist/extension.js`. Its default export registers the production profile, which has no built-in features. A named `createAgentSupervisorExtension({ features })` factory exists for tests and future built-ins; it is not a supported public API.

Only the Kernel touches Pi. Features receive no `pi` handle, no extension context, and no `sendUserMessage` or `appendEntry`. The Kernel owns runtime lifecycle, persistence, and intervention transport.

### Kernel capabilities

The Kernel provides `kernel:observation`, `kernel:persistence`, and `kernel:intervention`. `kernel:assessment` is not provided; auxiliary LLM assessment is a later stage.

A feature may `require` a `kernel:*` capability. A feature may **not** `provide` one: a descriptor whose `provides` contains any `kernel:*` capability is hard-rejected. Non-kernel capability namespaces stay open and are not tied to feature IDs.

### Observation pipeline

Pi event objects never reach a feature. The Kernel normalizes them:

| Pi event | Observation kind |
| --- | --- |
| `input` (`interactive` / `rpc`) | `root-request-started` |
| `tool_call` | `before-tool-call` |
| `tool_result` | `tool-result` |
| `turn_end` | `turn-ended` |
| `agent_settled` | `agent-settled` |
| `session_start` | `session-started` |
| `session_shutdown` | `session-shutdown` |
| `session_before_compact` | `before-compact` |
| `session_compact` | `compacted` |
| `session_compact_failed` | `compaction-failed` |
| `context` | `context-changed` |

An `input` whose source is `extension` produces no observation; it only reactivates the current Root Request.

Observation IDs and sequences are deterministic and runtime-local (`observation-0`, `observation-1`, …). Time is never an ordering authority.

Payloads carry metadata only. Tool input and tool result content appear solely as canonical SHA-256 digests, and a value that cannot be canonicalized yields a `null` digest rather than an error. Prompt text, tool inputs, tool results, assistant responses, stdout, file contents, and compaction error text never enter an observation payload.

### Root Requests

An `interactive` or `rpc` input starts a new Root Request with a deterministic ID (`root-1`, `root-2`, …). An `extension` input never starts one: it rejoins the current Root Request, including after that root has settled. `agent_settled` marks the current root `settled` but keeps its ID, so a Supervisor follow-up stays in the same episode.

A session start leaves the current root `null`; a resumed session never reactivates a stale root. The next Root Request sequence is persisted, so IDs are not reused across a resume.

### Facts

Facts are **root-local and ephemeral**. They are never persisted. Within one Root Request a fact emitted in one dispatch is visible to later dispatches; a new Root Request clears the buffer and resets the fact sequence.

### Feature runtime

Only features whose effective mode is `autonomous` or `observe` are instantiated, in ascending feature-ID order. Effective configuration resolves as structural config parsing, then plan resolution, then the module's own `validateConfig`, then runtime creation. A module without `validateConfig` receives `settings ?? null`. The result must be JSON-safe.

Runtime status is `active`, `off`, `unavailable`, or `quarantined`. A failure is isolated to one feature and never terminates the agent or the Supervisor:

| Situation | Result |
| --- | --- |
| `validateConfig` throws or returns non-JSON-safe | `unavailable` / `configuration-invalid` |
| persisted state schema differs from the module codec | `unavailable` / `schema-mismatch` |
| restored state fails the module codec | `unavailable` / `state-invalid` |
| `create()` throws | `unavailable` / `initialization-failed` |
| `onObservation` throws or emits an invalid emission | `quarantined` / `observation-failed` |
| a stateless module emits `nextState` | `quarantined` / `state-emission-without-codec` |

A quarantined feature performs no further work and proposes no further intervention for the rest of the session.

Kernel health is `healthy` or `degraded`, and it means only whether the Kernel itself can operate safely — a runtime sequence that cannot be recovered or persisted, a Kernel contract violation, a persistence write failure, or an intervention transport failure. Every failure in the table above is feature-local and leaves kernel health `healthy`. While degraded the Supervisor suppresses autonomous intervention and behaves observe-only, and the agent keeps running.

### Intervention transport

`arbitrateInterventions` remains the only winner-selection authority. The Kernel executes at most one winner per isolated group and never merges messages.

Delivery and boundary must be compatible; an incompatible proposal is a hard contract rejection:

| Delivery | Allowed boundary | Message |
| --- | --- | --- |
| `block` | `tool-call` | required |
| `steer` | `tool-call`, `stream` | required |
| `follow-up` | `stream`, `settled` | required |
| `none` | any | optional |

A winning `block` is returned to Pi from the tool-call handler. `steer` and `follow-up` are delivered through `sendUserMessage` with the matching `deliverAs`. `none` performs no external action. Proposals from `observe` features never reach transport.

### Persistence

Two reserved session custom types, both excluded from LLM context:

- `agent-supervisor-config` holds `SupervisorConfigV1`. When no entry exists, the effective configuration is the install-and-forget default and **nothing is persisted**. A change that has no effect appends nothing.
- `agent-supervisor-state` holds explicitly discriminated runtime and feature records. A runtime record carries the next Root Request sequence. A feature record carries one feature's state envelope. Records for features that are not currently registered are preserved.

A runtime record is written only when the sequence changes; a feature record only when a feature emits a new state.

### State history authority

Session state is append-only, so a malformed record written once stays on the branch forever. The Kernel therefore never treats the whole history as concurrently authoritative. It reads the history as separate logical streams, each resolved by **latest record wins**: one runtime-sequence stream, and one stream per feature ID.

For a feature, only the last record for that ID decides. If it is valid the state is restored and the feature runs normally; if it is invalid that feature alone becomes `unavailable` with reason `state-invalid`. Superseded earlier records — invalid or valid — have no effect in either direction. This is true for unregistered feature IDs too: their diagnostic is retained so a later registration does not treat stale invalid state as valid.

Feature-state corruption never degrades kernel health. A healthy sibling stays autonomous and can still win and execute an intervention.

### Runtime sequence recovery

The next Root Request sequence comes from the last valid runtime record, or `1` when there is none. Records after that point which are runtime-shaped but invalid, or whose stream cannot be determined at all, are each counted as one possible sequence advance, because every runtime append advances the sequence by exactly one:

```text
recoveredNext = lastValidNext + possibleAdvancesAfterIt
```

Records provably scoped to a feature are not counted. Over-skipping an unused numeric root ID is acceptable; reusing an ID that may already have been issued is not. So a valid record saying `2`, followed by one corrupt runtime record, recovers to `3` — `root-2` is skipped because the corrupt record may be the append that accompanied it.

When the count is above zero the Kernel repairs itself automatically on load: it appends one valid runtime record carrying the recovered sequence and stays healthy. No operator command is involved, and old entries are never rewritten or deleted. If that append fails the Kernel degrades instead and does not claim recovery. Because the repair record then becomes the last valid runtime record, a later resume finds nothing after it and writes nothing more — the repair is durable, not repeated. A load that needs no repair appends nothing at all.

`/agent-supervisor status` distinguishes the cases: a `Runtime state:` line reports `normal`, `recovered`, or `recovery failed`, and an `Invalid persisted feature state:` line names any feature whose latest record is invalid.

### Root Request reservation

Allocation is write-ahead. The Kernel reserves the next sequence through Pi before the ID exists anywhere else:

```text
persist reservation(sequence + 1)
  -> accepted: publish root-<sequence>, advance the sequence, reset root-local facts, emit root-request-started
  -> rejected: publish nothing
```

Until the reservation is accepted the candidate ID is not reachable from `currentRoot`, from an observation's `rootRequestId`, from a fact, from a feature's `onObservation`, from feature state, or from status output.

If the reservation is rejected the Kernel degrades and the request becomes **untracked**: `currentRoot` is `null`, root-local facts are cleared, no `root-request-started` is emitted, and the remaining observations for that request carry `rootRequestId: null`. There is deliberately no synthetic `root-unknown` identity for features to reason about. The user's request still runs normally — Supervisor persistence trouble never blocks the agent.

A rejected reservation does not consume the candidate. Because the ID was never published, a later request in the same process may reserve it again and publish it exactly once.

Two guarantees follow, and only these two:

- A new Root Request is published only after Pi accepts the runtime sequence reservation.
- Any Supervisor state derived from a successfully published root is ordered after that root's runtime reservation in Pi session history.

Both are properties of Pi's session-entry acceptance and ordering, not of physical storage. `appendEntry` is synchronous and signals rejection by throwing, and entry order is preserved in the session branch and in the session file — but it performs no `fsync`, and a brand-new file-backed session defers its first physical write until the first assistant message. So this is an acceptance-and-ordering contract, not a crash-durability claim: the Supervisor does not promise that a published root survives arbitrary storage failure, only that it is never published when Pi rejects the reservation.

### Operator command

One namespace, `/agent-supervisor`. It registers no tools and never opens a confirmation or selection dialog; an explicit command applies immediately.

```text
/agent-supervisor
/agent-supervisor status
/agent-supervisor mode autonomous|observe|off
/agent-supervisor feature <id> autonomous|observe|off|default
```

`/agent-supervisor` alone is `status`. `feature <id> default` removes only the mode override and keeps that feature's settings, returning it to its descriptor default.

While the top-level persisted configuration is corrupt, a `feature` command is refused and the operator is told to repair the global mode first, so a feature-only edit can never regenerate a global `autonomous` configuration. An explicit `mode` command in that state is treated as an operator repair: because a corrupt document cannot be trusted to yield feature settings, the repair writes a fresh configuration with the selected mode and **no feature entries**, so any feature settings from an earlier configuration are superseded rather than guessed at. Older entries remain in session history but no longer take effect. A `feature` command for an unregistered ID is refused and never creates a configuration entry.

A healthy agent run produces zero Supervisor notifications. Output appears only for `status` and as a short confirmation after an explicit successful command.

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

S1 delivers the Kernel control plane and deliberately omits:

- every autonomous product feature, including retry-loop behavior and completion gating;
- auxiliary LLM assessment and any model call of the Supervisor's own;
- automatic state/progress behavior;
- context recovery;
- automatic handoff;
- the benchmark runner and any real benchmark execution;
- npm release.
