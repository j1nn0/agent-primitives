# @j1nn0/agent-context-guard

## What

`@j1nn0/agent-context-guard` records important context items, creates JSON-safe snapshots, and verifies a candidate context with an injected verifier. It is an ESM-only package with zero runtime dependencies.

The package does not own a model, provider, storage system, or framework integration. It provides a small boundary between the context an application considers important and the context available after compaction, summarization, or handoff.

This package is a **decision engine**. It does not observe agent lifecycle events, capture compaction boundaries, or reinject lost context, and installing it does not by itself protect a running agent. Something must call it at the right moment; automatic enforcement belongs to harness-specific integrations such as Pi extensions, OpenCode plugins, and lifecycle hooks.

## Why

A candidate context can look plausible while silently dropping a constraint, requirement, decision, or fact. A guard lets an application register those items before a context transformation, carry a deterministic snapshot across a process or language boundary, and inspect a verification report afterward.

Verification is deliberately separate from storage. The built-in literal verifier is conservative and local; applications can inject a verifier that has access to their own checking logic.

## Installation

Install this package from the registry (once a release is on npm) or from a local checkout. For a local checkout, build it, then install the built package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-context-guard build
pnpm add file:/path/to/agent-primitives/packages/context-guard
```

For a registry installation, add the package with your package manager:

- pnpm: `pnpm add @j1nn0/agent-context-guard`
- npm: `npm install @j1nn0/agent-context-guard`
- Yarn: `yarn add @j1nn0/agent-context-guard`

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Register a goal and a critical constraint, then verify a candidate context. The candidate below retains the goal but drops the constraint, so the report is not okay and the constraint appears in both `lost` and `criticalFailures`.

```ts
import {
  createContextGuard,
  createLiteralVerifier,
} from '@j1nn0/agent-context-guard';

const guard = createContextGuard();
guard.add({
  id: 'goal',
  kind: 'goal',
  content: 'Ship the migration safely.',
});
guard.add({
  id: 'constraint',
  kind: 'constraint',
  content: 'Do not expose credentials.',
  critical: true,
});

const candidateContext = 'The goal remains: Ship the migration safely.';
const report = await guard.verify(candidateContext, {
  verifier: createLiteralVerifier(),
});

console.log({
  ok: report.ok,
  lost: report.lost,
  criticalFailures: report.criticalFailures,
});
```

The guard does not print or include `candidateContext` in the report. The sample prints only report fields.

## Snapshot

`guard.snapshot()` returns plain JSON data:

- `schemaVersion` is always `1`.
- `items` are in insertion order.
- Each item has `id`, `kind`, `content`, and a boolean `critical` field.
- Snapshots contain no `Map`, `Set`, class instance, function, symbol, `undefined`, timestamp, or generated identifier.
- Returned snapshots and items are copies. Mutating a returned value does not mutate the guard.

A snapshot can be serialized and restored by the surrounding application or another process. `verifyContext` accepts the snapshot without requiring the original guard.

```ts
import { createContextGuard } from '@j1nn0/agent-context-guard';

const guard = createContextGuard([
  {
    id: 'decision',
    kind: 'decision',
    content: 'Use the primary database for writes.',
  },
]);
const snapshot = guard.snapshot();
const encoded = JSON.stringify(snapshot);
const decoded = JSON.parse(encoded);

console.log(decoded.schemaVersion, decoded.items[0].critical);
```

## Literal verifier

`createLiteralVerifier()` performs one synchronous batch pass over all snapshot items. It normalizes Unicode whitespace by collapsing runs to one space and trimming by default, lowercases both sides by default, and then checks whether each item content is a substring of the candidate context.

Use `caseSensitive: true` to keep case significant or `normalizeWhitespace: false` to require the original whitespace. A match is `preserved`; a non-match is `lost`.

Under the defaults a match is not a verbatim match: `KEEP    BACKUPS` matches `keep backups`. The reason strings therefore say "after the configured normalization", and how strict that comparison is depends on the two options above.

```ts
import {
  createContextGuard,
  createLiteralVerifier,
  verifyContext,
} from '@j1nn0/agent-context-guard';

const guard = createContextGuard([
  {
    id: 'constraint',
    kind: 'constraint',
    content: 'Keep backups enabled',
  },
]);
const report = await verifyContext({
  snapshot: guard.snapshot(),
  context: 'Keep   backups\nenabled during the migration.',
  verifier: createLiteralVerifier(),
});

console.log(report.preserved);
```

The literal verifier is substring matching, not a model-based interpretation of the text. It cannot detect a preserved meaning behind reworded text, which is why it never reports `changed`; reworded text is simply `lost` to this verifier.

## Custom verifier

Pass any object with a `verify` function. It receives all snapshot items and the candidate context in one call. The function may return findings synchronously or asynchronously. The library validates and normalizes the returned findings before producing the report.

```ts
import {
  createContextGuard,
  verifyContext,
} from '@j1nn0/agent-context-guard';
import type { ContextVerifier } from '@j1nn0/agent-context-guard';

const guard = createContextGuard([
  {
    id: 'requirement',
    kind: 'requirement',
    content: 'Every request has an owner.',
  },
]);
const verifier: ContextVerifier = {
  verify({ items }) {
    return items.map((item) => ({
      itemId: item.id,
      status: 'preserved' as const,
      reason: 'The application check passed.',
    }));
  },
};

const report = await verifyContext({
  snapshot: guard.snapshot(),
  context: 'candidate text',
  verifier,
});
console.log(report.ok);
```

A custom verifier should keep candidate context and item content out of its own error messages and reason strings. The library never rethrows verifier errors and does not copy thrown error messages into the report.

## Verification statuses

The report contains one finding per snapshot item, in snapshot order, plus ID buckets:

| Status | Meaning |
| --- | --- |
| `preserved` | The verifier says the item survived. |
| `changed` | The verifier says the item changed. The literal verifier never emits this status. |
| `lost` | The verifier says the item is absent or not retained by its checking rule. |
| `unknown` | The item could not be evaluated safely. |

`ok` is true **only when** `changed`, `lost`, `unknown`, and `issues` are all empty. A non-critical loss therefore still makes `ok` false. `criticalFailures` contains critical item IDs whose final status is not `preserved`.

Verifier output is fail-safe. A thrown or rejected verifier, a missing finding, a malformed finding, an unknown item ID, an unsupported status, or conflicting findings cannot silently preserve an item. Unverifiable items become `unknown`, never `preserved`, and structural problems in verifier output are recorded in `issues`.

A structurally invalid finding taints the item it names: if the verifier returns both a valid finding and an invalid one for the same item, that item ends up `unknown` rather than keeping the valid status. Per-item output that is partly broken is not trustworthy per item, and a caller deciding what to recover reads `criticalFailures`, so a tainted critical item has to appear there. A finding naming an ID that is not in the snapshot taints nothing — it is discarded and recorded in `issues`. A non-string `reason` is dropped on its own; the finding's status still counts.

## Critical items

Set `critical: true` on an item that must survive the context transition. A critical item with status `changed`, `lost`, or `unknown` is added to `criticalFailures` and makes `ok` false. Non-critical items still affect `ok` through their status buckets; a non-critical `lost` item also makes `ok` false.

`criticalFailures` is an ID list, not a score. The library does not calculate an integrity score or infer importance from the item text.

## Privacy

The library is intentionally side-effect free:

- no telemetry or analytics;
- no network calls;
- no filesystem access;
- no persistence;
- no console output;
- no global state.

The candidate context is never copied into a verification report or into library-generated error messages. Thrown verifier errors are discarded rather than rethrown or included in `issues`. Library errors contain only a code and short structural information such as an item ID; they do not include item content or candidate context.

A custom verifier controls its own reason strings and error construction, so application code should keep sensitive context out of those strings as well.

## Limitations

Version 0.1 deliberately does not:

- compact or summarize context;
- provide memory or context storage;
- repair or inject missing context;
- calculate an integrity score;
- perform semantic verification without an injected verifier;
- persist snapshots or reports;
- provide a CLI;
- provide an MCP adapter.

The built-in literal verifier only checks substring presence after its configured normalization. Applications that need stronger checks must inject their own verifier and should treat its output as untrusted input to the same fail-safe report normalization.

## API overview

The package root exports these runtime values:

- `createContextGuard(items?)` returns a guard with `add`, `addAll`, `get`, `list`, `has`, `remove`, `clear`, `size`, `snapshot`, and `verify` methods.
- `createLiteralVerifier(options?)` accepts optional `caseSensitive` and `normalizeWhitespace` booleans.
- `verifyContext(input)` verifies a `ContextSnapshot` with an injected `ContextVerifier`.
- `ContextGuardError` is thrown for `duplicate_item_id` and `invalid_input` validation failures. Its `code` field identifies the failure and its optional `itemId` identifies a duplicate.

The package also exports the public TypeScript types `ContextItemKind`, `VerificationStatus`, `ContextGuardErrorCode`, `ContextItemInput`, `ContextItem`, `ContextSnapshot`, `ContextVerifier`, `ContextVerifierInput`, `VerificationFinding`, `VerificationReport`, `VerifyContextInput`, `VerifyOptions`, `LiteralVerifierOptions`, and `ContextGuard`.
