# @j1nn0/agent-state

## What

`@j1nn0/agent-state` records where a piece of agent work currently stands. It keeps an optional objective, insertion-ordered work items with explicit statuses, and insertion-ordered decisions. It creates deterministic JSON-safe snapshots, restores them after a serialization boundary, and summarizes the current work-item counts. It is an ESM-only package with zero runtime dependencies.

The package records the position declared by its caller. It does not decide whether that position is correct, whether the work is progressing, or whether a completion claim is justified.

This package is a **state record**, not an agent framework. It does not own a model, provider, runtime lifecycle, persistence system, or framework integration. Something must call it at the right moment; automatic lifecycle behavior belongs to harness-specific integrations outside this package.

## Why

An application often needs a small, explicit answer to a simple question: what has the work reached so far? A state record keeps that answer in plain data without turning it into a history, a retry policy, or an evidence judgment.

Work-item status is one field on each item. `blocked` therefore answers what is currently blocked without introducing a second blockers collection. Decisions are a separate insertion-ordered collection because they are part of the declared current record, not status transitions or an event log.

## Installation

Install this package from the registry or from a local checkout. For a local checkout, build it, then install the built package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-state build
pnpm add file:/path/to/agent-primitives/packages/agent-state
```

For a registry installation, add the package with your package manager:

- pnpm: `pnpm add @j1nn0/agent-state`
- npm: `npm install @j1nn0/agent-state`
- Yarn: `yarn add @j1nn0/agent-state`

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Create a state record, update caller-declared statuses, and record a decision:

```ts
import {
  createAgentState,
  summarizeAgentState,
} from '@j1nn0/agent-state';

const state = createAgentState({
  objective: 'Ship the migration safely.',
  workItems: [
    { id: 'schema', content: 'Update the database schema.' },
    { id: 'cutover', content: 'Run the production cutover.' },
  ],
});

state.setWorkItemStatus('schema', 'in_progress');
state.addDecision({
  id: 'database',
  content: 'Use the primary database for writes.',
});

const snapshot = state.snapshot();
console.log(snapshot);
console.log(summarizeAgentState(snapshot));
```

A work item without a status starts as `open`. The only supported statuses are `open`, `in_progress`, `blocked`, and `done`.

## The model

The state record contains:

- an optional `objective` string;
- `workItems`, each with a caller-supplied `id`, non-empty `content`, and a required normalized `status`;
- `decisions`, each with a caller-supplied `id` and non-empty `content`.

Work-item and decision IDs are unique within their own collection. A work item and a decision may use the same ID. Listings and snapshots preserve insertion order; the package never sorts or generates identifiers.

Any work-item status can be set to any other status. There are no transition rules, completion predicates, percentages, owners, priorities, timestamps, or next-action fields. The caller owns that policy.

Methods return copies, and values passed to the factory or mutation methods are copied into the record. Mutating an input, a returned item, a returned list, or a returned snapshot cannot mutate the internal state.

## Snapshot and restore

`state.snapshot()` returns plain data with schema version `1`:

- `schemaVersion` is always `1`;
- `objective` is present only when one was supplied;
- `workItems` and `decisions` are arrays in insertion order;
- work items always include `id`, `content`, and `status`;
- snapshots contain no `Map`, class instance, function, timestamp, generated ID, host information, or process information.

The snapshot can cross a JSON boundary and be restored after the surrounding application validates or stores it:

```ts
import {
  createAgentState,
  restoreAgentState,
} from '@j1nn0/agent-state';

const state = createAgentState({ objective: 'Publish the release.' });
state.addWorkItem({ id: 'check', content: 'Run the release checks.' });

const encoded = JSON.stringify(state.snapshot());
const decoded: unknown = JSON.parse(encoded);
const restored = restoreAgentState(decoded);

console.log(restored.snapshot());
```

`restoreAgentState` treats its input as untrusted. It requires a plain object, schema version `1`, a string objective when present, arrays for both collections, valid item shapes and statuses, and unique IDs within each collection. Validation is all-or-nothing.

## Summary

`summarizeAgentState(snapshot)` counts work items by their current declared status and returns only `open`, `in_progress`, `blocked`, `done`, and `total` counts:

```ts
import {
  createAgentState,
  summarizeAgentState,
} from '@j1nn0/agent-state';

const state = createAgentState();
state.addWorkItem({ id: 'one', content: 'First task.' });
state.addWorkItem({ id: 'two', content: 'Second task.' });
state.setWorkItemStatus('two', 'done');

console.log(summarizeAgentState(state.snapshot()));
// { open: 1, in_progress: 0, blocked: 0, done: 1, total: 2 }
```

The summary has no ratio, percentage, delta, or time-derived value. It does not infer whether the work is moving forward.

## Invariants and errors

The package validates IDs and content as non-empty strings after trimming only for the emptiness check; their original string values are retained. Status values outside the four-value union are invalid. Initial arrays are validated before any state is created, so duplicate IDs or malformed entries cannot leave a partially initialized record.

`AgentStateError` is thrown for validation and lookup failures. Its `code` is one of:

- `invalid_input` for malformed values, empty IDs or content, unsupported statuses, and malformed snapshots;
- `duplicate_item_id` when an ID already exists in its collection;
- `unknown_item_id` when changing the status of a missing work item.

The error also has an `itemId` when the failure identifies a particular work item or decision ID. Error messages contain only short structural information; item content is not copied into errors.

## Relationship to the other primitives

Agent state and Context Guard are independent core primitives with different jobs. Agent state records the caller-declared current position. Context Guard records important context and verifies whether a candidate context retains it. Agent state does not preserve knowledge against context loss and does not depend on `@j1nn0/agent-context-guard`.

The boundary with the other planned primitives is deliberate:

- **Progress** can later judge movement over time; Agent state has no history, timestamps, rounds, deltas, or inferred advancement.
- **Retry guard** can later reason about repeated failures and retries; Agent state has no retry counters or attempt policy.
- **Evidence** can later judge whether a completion claim is justified; Agent state records `done` only when the caller declares it.
- **Handoff** can later define how one agent takes over; Agent state does not generate handoff messages or orchestrate agents.

## Privacy and side effects

The library is intentionally side-effect free:

- no telemetry or analytics;
- no network calls;
- no filesystem access;
- no persistence;
- no console output;
- no global state.

The caller decides whether and where to serialize or persist a snapshot. The package does not log objective text, work-item content, decisions, or provider data.

## Limitations

Version 0.1 deliberately does not:

- preserve context through compaction or summarization;
- observe agent lifecycle events;
- provide a persistence layer;
- calculate progress or completion confidence;
- enforce workflow or status transition policy;
- decide whether `done` is supported by evidence;
- generate handoffs or coordinate agents;
- provide a CLI or an MCP adapter.

## API overview

The package root exports these runtime values:

- `createAgentState(input?)` returns an object with `addWorkItem`, `setWorkItemStatus`, `getWorkItem`, `listWorkItems`, `removeWorkItem`, `addDecision`, `listDecisions`, and `snapshot` methods.
- `restoreAgentState(snapshot)` validates and rebuilds an agent state record from untrusted plain data.
- `summarizeAgentState(snapshot)` returns current status counts.
- `AgentStateError` is thrown for invalid input, duplicate IDs, and unknown work-item IDs.

The package also exports the public TypeScript types `WorkItemStatus`, `AgentStateErrorCode`, `WorkItemInput`, `WorkItem`, `DecisionInput`, `Decision`, `AgentStateInput`, `AgentStateSnapshot`, `AgentStateSummary`, and `AgentState`.
