# @j1nn0/agent-progress

## What

`@j1nn0/agent-progress` judges whether caller-declared work is actually moving forward. It compares an ordered current observation of opaque milestone identifiers with an ordered cumulative baseline and reports progress only when the declared set strictly grows. It also reports withdrawals for information and returns the new cumulative set for the caller's next round. It is an ESM-only package with zero runtime dependencies.

The package evaluates explicit observations supplied by its caller. It does not inspect milestone meaning, observe a runtime, or decide whether a milestone is valuable. It is a **progress judgment**, not a tracker, workflow engine, retry policy, or agent framework.

## Why

An application can observe many kinds of churn while work appears busy: the same claims can be reordered, repeated, reworded, or declared again after being dropped. A cumulative set gives the caller a small, deterministic answer to the narrower question that matters here: has this observation introduced an identifier that has never been recorded before?

The caller owns the observation boundary and the cumulative loop. The primitive makes the cumulative update explicit in `recordedMilestones`, so a caller does not have to reconstruct it and accidentally turn a withdrawal followed by a re-declaration into fresh progress.

## Installation

Install this package from the registry or from a local checkout. For a local checkout, build it, then install the built package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-progress build
pnpm add file:/path/to/agent-primitives/packages/agent-progress
```

For a registry installation, add the package with your package manager:

- pnpm: `pnpm add @j1nn0/agent-progress`
- npm: `npm install @j1nn0/agent-progress`
- Yarn: `yarn add @j1nn0/agent-progress`

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Supply a current observation and, after the first round, feed back the cumulative `recordedMilestones` returned by the previous verdict:

```ts
import { judgeProgress } from '@j1nn0/agent-progress';
import type { ProgressObservation } from '@j1nn0/agent-progress';

let recorded: ProgressObservation | undefined;
const observations: readonly ProgressObservation[] = [
  { milestones: ['planned'] },
  { milestones: ['planned', 'implemented'] },
  { milestones: ['implemented', 'planned'] },
];

for (const current of observations) {
  const verdict = judgeProgress({
    ...(recorded === undefined ? {} : { previous: recorded }),
    current,
  });
  console.log(verdict);
  recorded = { milestones: verdict.recordedMilestones };
}
```

The first call has no baseline and returns `unknown`. The second call returns `progress` because `implemented` is new. The third call returns `no_progress`: reordering the same cumulative set is churn, not advance.

## The model

A progress observation is an ordered array of opaque milestone identifiers:

```ts
interface ProgressObservation {
  readonly milestones: readonly string[];
}
```

The judge input has a required `current` observation and an optional `previous` observation. `previous` is the cumulative set of every milestone recorded so far, not merely the immediately preceding observation. The caller starts a loop with an empty baseline when it has one:

```ts
let recorded: ProgressObservation = { milestones: [] };
const verdict = judgeProgress({ previous: recorded, current: observed });
recorded = { milestones: verdict.recordedMilestones };
```

A present-but-empty baseline means that work started with no recorded milestones. It is valid information and can produce either `progress` or `no_progress`; it is not the same as a missing baseline.

`current` is the complete set of identifiers the caller currently declares, not only the ones achieved since the last round. Carrying previously declared identifiers forward is what makes `withdrawnMilestones` meaningful: a caller that supplies only the round's new identifiers still gets correct `progress` and `no_progress` outcomes, because the baseline is cumulative, but every earlier identifier is then reported as withdrawn.

Omit the `previous` property to signal that no baseline exists. Passing the property explicitly as `undefined` is rejected with `invalid_input` rather than treated as a missing baseline, so a malformed baseline can never be silently downgraded to `unknown`.

Each observation must be a plain object with a `milestones` array. Every entry must be an original, non-empty string, and an observation cannot contain the same identifier twice. Whitespace is inspected only to reject empty or whitespace-only strings: accepted identifiers are retained exactly as supplied.

## Public API

The package root exports `judgeProgress` and `ProgressError`, plus these TypeScript types:

- `ProgressOutcome` — `progress`, `no_progress`, or `unknown`;
- `ProgressUnknownReason` — currently `missing_baseline`;
- `ProgressErrorCode` — `invalid_input` or `duplicate_milestone`;
- `ProgressObservation` — one ordered observation;
- `ProgressJudgeInput` — the current observation and optional cumulative baseline;
- `ProgressVerdict` — the progress, no-progress, or unknown result.

`judgeProgress(input: unknown): ProgressVerdict` treats its input as untrusted. It throws `ProgressError` with code `invalid_input` for malformed shapes and with code `duplicate_milestone` for a duplicate within one observation. It never coerces, trims into validity, or drops an entry.

## What counts as progress

With a valid baseline, progress means exactly this:

- at least one identifier appears in `current` that is not in `previous`;
- `newMilestones` contains those identifiers in their order in `current`;
- `recordedMilestones` contains the old cumulative identifiers in `previous` order, followed by the new identifiers in `current` order.

The judge also computes `withdrawnMilestones` as identifiers in `previous` that are absent from `current`. When non-empty, that property is included in the result, but withdrawal never changes the outcome. A round can therefore report both progress and withdrawal.

Without a `previous` property, the outcome is `unknown` with reason `missing_baseline`. The result still returns a defensive copy of the current milestones as `recordedMilestones`, allowing the caller to establish the first cumulative baseline.

## What does not count automatically

The primitive never treats any of these as progress by themselves:

- reordering the same identifiers;
- re-declaring identifiers already in the cumulative baseline;
- withdrawing an identifier;
- declaring the same identifier again after withdrawing it;
- rewriting an identifier is not normalized: a different string is a different opaque identifier and may count as new; callers are responsible for keeping identifiers stable.

The primitive does not infer milestones from text, work-item status, tool output, timestamps, attempts, or model activity. A caller must explicitly supply the observations.

## Relationship to Agent State

Progress is **independent** of `@j1nn0/agent-state` and has no Agent State dependency or Agent State types. Agent State records a caller-declared current position; Progress compares caller-declared milestone sets across a boundary. Keeping the boundary explicit prevents Progress from inventing a milestone extraction policy or treating an Agent State status as evidence of movement.

An adapter or application may choose milestone identifiers based on an Agent State snapshot, but that extraction is caller-owned. This package accepts plain generic observations and can be used with any source of explicit identifiers.

## Relationship to Retry Guard and Evidence

Progress does not count attempts, classify failures, or decide whether to retry. A Retry Guard can own repeated-failure and retry policy; this package only judges cumulative declared-set growth.

Progress does not verify that a completion claim is true. Evidence can own the question of whether a claim is supported; a newly declared milestone is progress according to this contract even when another component must still verify what it means.

## Deterministic and privacy properties

The judge is pure and deterministic:

- equal inputs produce deep-equal, JSON-round-trip-safe outputs;
- caller order is preserved and no sorting or normalization occurs;
- returned arrays are defensive copies and never alias input arrays;
- there are no timestamps, generated identifiers, global state, persistence, or hidden history;
- there is no filesystem or other I/O, network access, telemetry, or console output;
- milestone identifiers are opaque, never interpreted, and never logged.

The primitive returns only plain objects and arrays of strings. It has no runtime dependencies.

## Limitations

Version 0.1 deliberately judges only declared-set growth. It cannot tell you whether a milestone was worth reaching, whether the caller's observation is honest, or whether a completion claim is supported. A caller that declares meaningless new identifiers will register `progress`.

The package does not observe lifecycle events, retain a history beyond the cumulative data the caller feeds back, persist observations, calculate completion percentages or confidence, or provide a retry policy, a CLI, a Pi adapter, or an MCP integration.

The cumulative baseline only grows. Withdrawing an identifier reports it in `withdrawnMilestones` but does not remove it from `recordedMilestones`, which is what stops a withdrawn identifier from being re-earned later. Each call compares the two observations directly, so the cost grows with the size of the baseline: a single round is roughly 0.5 ms at 100 recorded identifiers and roughly 280 ms at 5000 on the machine used to measure it. That is immaterial for an agent session, but a long-lived process that accumulates identifiers indefinitely should start a new baseline rather than let one grow without bound.
