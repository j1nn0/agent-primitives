# @j1nn0/agent-handoff-pi

## What it is

`@j1nn0/agent-handoff-pi` is a minimal Pi harness adapter for persisting caller-declared handoff packets in the current session. It provides one human command namespace, `/agent-handoff`, and three explicit model-callable tools. The adapter records only values supplied by a caller or model; it never generates packets automatically or judges completion.

## Relationship to the core

`@j1nn0/agent-handoff` is the harness-agnostic core primitive. **Every packet validation delegates to its `createHandoff(...)` function.** The adapter does not reimplement packet semantics and never stores derived values.

Before every successful packet creation, the adapter validates the raw packet via `createHandoff(raw)` in a guarded step. If the core rejects it, the mutation is rejected, state is unchanged, and no session entry is appended. For persistence restore, the adapter validates the outer envelope (`schemaVersion`, `packets` array) and each raw packet via `createHandoff(raw)`, and rejects duplicate packet ids across the registry. This makes the core validator authoritative.

The adapter is tested against `@earendil-works/pi-coding-agent` `0.84.2`. Its Pi peer dependency intentionally remains wide (`*`).

## Installation

Install the published adapter from the registry:

```sh
pi install npm:@j1nn0/agent-handoff-pi
```

Add `-l` to install it project-locally instead of for your user.

### From a local checkout (development)

For development or local use, build from the repository root, then install the package by absolute path:

```sh
PACKAGE_DIR=/abs/path/to/agent-primitives/packages/agent-handoff-pi
pnpm install
pnpm --filter @j1nn0/agent-handoff-pi build
pi install "$PACKAGE_DIR" -l
```

For a one-run load without installing it in Pi settings:

```sh
pi -e "$PACKAGE_DIR/dist/extension.js"
```

The package manifest also advertises `./dist/extension.js` through Pi's `pi.extensions` entry.

## Commands

The extension registers exactly one command namespace, `/agent-handoff`. A bare command is the same as `status`:

```text
/agent-handoff
/agent-handoff status
/agent-handoff show <id>
/agent-handoff remove <id>
/agent-handoff clear
/agent-handoff clear --yes
```

`status` and the bare command show the same summary as `agent_handoff_get`. They do not create or judge. `show` prints one packet in detail. `remove` deletes one packet by exact id. `clear` requires `--yes` and is human-only.

Packet creation is model-only via `agent_handoff_create`; there is no human `create` command in Phase 1. To create a packet as a human, use the model tool or add a future `create` subcommand.

## Tools

The model can use exactly these three tools:

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `agent_handoff_get` | none | Returns the raw summary for the current session. |
| `agent_handoff_create` | `schemaVersion` 1, `id`, `source`, `goal` required; `destination`, `constraints`, `openItems`, `evidenceReferences` optional | Creates one caller-declared packet after core validation and id-uniqueness check. |
| `agent_handoff_remove` | `id` required string | Removes one packet after validation. |

All three tools state that they do not generate packets automatically, summarize context, select successors, judge completion, or call Evidence/State/Progress/Retry/Context Guard.

## Session model

Handoff packets have an explicit lifecycle. A caller creates or removes packets; the adapter never infers or generates them. There is no automatic packet generation from session context, task completion, or evidence verdicts.

## Persistence and sessions

The adapter persists one raw snapshot per state-changing operation as a Pi custom session entry with custom type `agent-handoff-state` and schema version `1`:

```text
{
  schemaVersion: 1,
  packets: [
    { schemaVersion: 1, id: 'handoff-42', source: 'engineer', destination: 'reviewer', goal: 'Review PR 42', constraints: ['Check diff'], openItems: ['Confirm deploy note'], evidenceReferences: ['tests-run-123'] }
  ]
}
```

Only the core-validated packets are stored. Derived summaries are never persisted.

On `session_start`, the adapter selects the newest matching custom entry in the current Pi branch and validates it strictly. Wrong schema versions, non-array `packets`, extra top-level keys, malformed packets (via `createHandoff`), or duplicate packet ids across the registry are invalid. A malformed newest entry produces one warning—`Agent Handoff: persisted state was invalid; starting with fresh state.`—then starts with an empty state. It is not repair-appended, and an older valid entry is never used as a fallback. A branch with no matching entry starts fresh without a warning. New sessions are isolated and do not use unrelated branch entries.

Round-trip restoration through JSON serialization is tested against Pi `0.84.x` behavior.

## Clear semantics

`clear` is a human-only operation. Without `--yes` it warns and changes nothing. `/agent-handoff clear --yes` wipes all packets and appends exactly one entry only when something existed. Clearing an already-fresh state is a no-op and appends nothing. There is no model-facing clear tool.

## Privacy

All packet fields—`goal`, `constraints`, `openItems`, `source`, `destination`, and `evidenceReferences`—are caller-controlled and may carry sensitive content. The adapter displays and persists packet prose verbatim. There is no automatic redaction. Callers must scrub sensitive content before transmission or sharing. Do not assume any field is safe to log.

## Relationship to Evidence

This adapter never reads Evidence state and never maps evidence verdicts automatically. A caller may supply `evidenceReferences` as opaque identifiers when creating a packet, but there is no automatic linkage, verification, or injection of evidence content or verdicts. A future consumer may resolve those references explicitly at handoff consumption time.

## Relationship to Agent State

This adapter never reads or writes Agent State and does not map work items or decisions automatically. The two adapters retain independent session entries and explicit lifecycles. Phase 1 carries no Agent State references; packet fields are limited to the core `HandoffPacket` shape.

## Relationship to Progress

This adapter never reads Progress state and never maps milestones or verdicts automatically.

## Relationship to Retry Guard

This adapter never reads Retry Guard state, starts retries, or maps verdicts automatically.

## Relationship to Context Guard

This adapter never injects handoff packets into context and does not change Context Guard policy. Loading the adapter does not change prompt construction or context decisions.

## What the adapter does not know or do

The adapter does not know whether a packet is complete, safe to act on, or whether its prose is accurate. It does not call providers or models, make network calls, execute commands, inspect tool results, collect telemetry, inject context, generate packets, select successors, or verify external truth. Packet validation is delegated entirely to the core `createHandoff` function; the adapter only checks the outer envelope and packet-id uniqueness.

## Coexistence with the other Pi adapters

This adapter can be loaded alongside the four existing adapters plus context-guard-pi. It uses independent namespaces:

| Adapter | Command | Tools | Session entry |
| --- | --- | --- | --- |
| Context Guard Pi | `/context-guard` | none | `agent-context-guard-state` |
| Agent State Pi | `/agent-state` | `agent_state_*` | `agent-state-state` |
| Agent Progress Pi | `/agent-progress` | `agent_progress_*` | `agent-progress-state` |
| Agent Retry Guard Pi | `/agent-retry` | `agent_retry_*` | `agent-retry-state` |
| Agent Evidence Pi | `/agent-evidence` | `agent_evidence_*` | `agent-evidence-state` |
| Agent Handoff Pi | `/agent-handoff` | `agent_handoff_*` | `agent-handoff-state` |

It has no dependency on the other adapters, does not merge their state, and does not map their entries.

## Limitations

Version 0.1 supports a packet registry per Pi session and no cross-session store beyond Pi branch persistence. Packet creation is model-only in Phase 1. The adapter delegates all packet validation to the core and only checks outer envelope and id uniqueness. There is no packet-replace operation—remove and then create the replacement. There is no automatic packet generation, successor selection, completion judgment, or coupling to other primitives.
