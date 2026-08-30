# @j1nn0/agent-budget-pi

## What it is

`@j1nn0/agent-budget-pi` is a minimal Pi adapter for holding caller-declared budget records in the current Pi session. It provides the `/agent-budget` human command namespace and four model-callable tools. Phase 1 stores only the records the caller supplies; it does not perform automatic accounting.

## Relationship to the core

`@j1nn0/agent-budget` is the frozen, harness-agnostic core judge. Every numeric acceptance and every verdict delegates to `judgeBudget({ consumed, limit })`. The core applies the inclusive boundary `consumed >= limit`, returns `within_budget` or `exhausted`, and reports the unclamped arithmetic remainder `limit - consumed`.

The adapter adds only session storage, identifier and envelope validation, command/tool routing, and display formatting. It never replaces the core's numeric validation with its own rules, and it never stores verdicts.

## Installation

Install the published adapter from the registry:

```sh
pi install npm:@j1nn0/agent-budget-pi
```

Add `-l` to install it project-locally instead of for your user.

### From a local checkout (development)

From a local checkout, build it from the repository root:

```sh
cd /abs/path/to/agent-primitives
PACKAGE_DIR=$PWD/packages/agent-budget-pi
pnpm install
pnpm --filter @j1nn0/agent-budget-pi build
```

Install it locally by absolute path for ongoing use:

```sh
pi install "$PACKAGE_DIR" -l
```

Or load the built extension directly for one run without installing it in Pi settings:

```sh
pi -e "$PACKAGE_DIR/dist/extension.js"
```

## Commands

The extension registers one command namespace, `/agent-budget`. A bare command is the same as `status`:

```text
/agent-budget
/agent-budget status
/agent-budget set <id> --consumed <number> --limit <number>
/agent-budget remove <id>
/agent-budget judge
/agent-budget clear
/agent-budget clear --yes
```

`set` is a whole-record create-or-replace upsert. It requires both numeric flags; partial updates do not exist. The id is opaque, must contain no whitespace, and is preserved exactly. Numeric flags may be space-separated or use `--consumed=5` and `--limit=5` forms. `status` and the bare command display records, `judge` displays transient verdicts, and `clear` is human-only and requires `--yes` when records exist.

## Tools

The model can use exactly these four tools:

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `agent_budget_get` | none | Returns the current-session record summary. |
| `agent_budget_set` | `id`, `consumed`, and `limit` required; no extra keys | Creates or replaces one whole record and persists only when values change. |
| `agent_budget_remove` | `id` required | Removes one record by exact id and persists only when it exists. |
| `agent_budget_judge` | none | Returns transient verdict text without mutating state or appending an entry. |

Every tool states that it does not count tool calls, tokens, cost, retries, elapsed time, or sub-agent launches automatically; consumption is caller-declared, units belong to the caller, and verdicts are never stored.

## Session model

The caller owns the counters and increments them explicitly before supplying a new whole record to `set`. The adapter never counts tool calls, tokens, cost, time, retries, sub-agents, or any other activity. Creation, replacement, removal, clearing, and judging occur only through their explicit command or tool boundaries.

## Persistence and sessions

State is stored as a full snapshot in one Pi custom session entry per actual mutation. The entry uses custom type `agent-budget-state` and schema version `1`:

```json
{
  "schemaVersion": 1,
  "budgets": [
    { "id": "tokens", "consumed": 12.5, "limit": 20 }
  ]
}
```

Persisted records have exactly `id`, `consumed`, and `limit` keys. Records retain insertion order. On `session_start`, the adapter selects the newest matching entry in the current branch. A malformed envelope, malformed record, invalid identifier, invalid core number, or duplicate id makes the whole newest state invalid; the adapter warns and starts with fresh state. It never repairs by appending, never falls back to an older matching entry, and never uses entries from another branch.

## Clear semantics

`clear` is human-only. Without `--yes`, it warns that the operation would remove the current records and changes nothing. `/agent-budget clear --yes` clears all budgets and appends exactly one empty snapshot when something existed. Clearing an already-empty registry reports `nothing to clear` and appends nothing.

## Privacy

Ids and numeric values are caller-controlled and are displayed and persisted verbatim. The adapter performs no telemetry, network access, or storage outside the Pi session entries described above. Scrub sensitive labels or values yourself before putting them in a session.

## What the adapter does not know or do

The adapter does not know the units of a quantity, what contributes to `consumed`, whether a threshold should warn, whether multiple dimensions should be combined, when a budget should reset, or whether a declaration reflects real spend. It has no timestamps, thresholds, dimensions, automatic counting of any kind, provider pricing, forecasting, or verdict persistence. It does not count tool calls, tokens, cost, elapsed time, retries, or sub-agent launches; it does not call providers or models, inspect activity, or verify external truth.

## Coexistence with the other Pi adapters

This adapter can be loaded alongside the other Pi adapters in this repository. Each uses an independent command namespace, tool family, and session entry type:

| Adapter | Command | Tools | Session entry |
| --- | --- | --- | --- |
| Context Guard | `/context-guard` | none | `agent-context-guard-state` |
| Agent State | `/agent-state` | `agent_state_*` | `agent-state-state` |
| Agent Progress | `/agent-progress` | `agent_progress_*` | `agent-progress-state` |
| Agent Retry Guard | `/agent-retry` | `agent_retry_*` | `agent-retry-state` |
| Agent Evidence | `/agent-evidence` | `agent_evidence_*` | `agent-evidence-state` |
| Agent Handoff | `/agent-handoff` | `agent_handoff_*` | `agent-handoff-state` |
| Agent Budget | `/agent-budget` | `agent_budget_*` | `agent-budget-state` |

It has no dependency on the other adapters, does not merge their state, and does not map their entries.

## Limitations

Version 0.1 supports a session-scoped registry only. It has no cross-session store beyond Pi branch persistence, and `set` replaces whole records rather than applying partial updates. Judgments are transient text and are never persisted. Phase 1 adds no automatic accounting and no non-Pi harness support.
