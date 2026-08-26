# @j1nn0/agent-retry-guard

## What

`@j1nn0/agent-retry-guard` judges a caller-declared retry episode. It counts trailing failure and no-progress streaks, detects repetition of the latest identified strategy, and applies explicit attempt limits. It is an ESM-only package with zero runtime dependencies.

The package evaluates declarations supplied by its caller. It does not run a strategy, observe an agent, verify an outcome, or retain history between calls. It is a **retry judgment**, not a retry executor, progress tracker, evidence verifier, or agent framework.

## Why

Retries can spend effort without changing the strategy or the result. A caller can provide the outcomes from one episode and receive a small, deterministic verdict showing whether the latest unsuccessful work repeats one identified strategy and whether an explicit policy still permits another attempt.

The caller owns episode boundaries. Passing a fresh `attempts` array starts a fresh episode; the guard never combines it with an earlier call or with lifetime totals.

## Installation

Install this package from the registry or from a local checkout. For a local checkout, build it, then install the built package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-retry-guard build
pnpm add file:/path/to/agent-primitives/packages/agent-retry-guard
```

For a registry installation, add the package with your package manager:

- pnpm: `pnpm add @j1nn0/agent-retry-guard`
- npm: `npm install @j1nn0/agent-retry-guard`
- Yarn: `yarn add @j1nn0/agent-retry-guard`

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Give the judge the attempts observed in the current episode and an optional policy:

```ts
import { judgeRetry } from '@j1nn0/agent-retry-guard';
import type { RetryAttempt } from '@j1nn0/agent-retry-guard';

const attempts: readonly RetryAttempt[] = [
  { outcome: 'failure', strategyId: 'search-v1' },
  { outcome: 'no_progress', strategyId: 'search-v1' },
];

const verdict = judgeRetry({
  attempts,
  policy: { maxAttempts: 5, maxStrategyAttempts: 3 },
});

// {
//   attempts: 2,
//   consecutiveFailures: 0,
//   consecutiveNoProgress: 1,
//   repeatedStrategy: { strategyId: 'search-v1', attempts: 2 },
//   retryAllowed: true
// }
```

## Retry model

A `RetryAttempt` is a caller-declared outcome and, optionally, an identified strategy:

```ts
interface RetryAttempt {
  readonly outcome: 'success' | 'failure' | 'no_progress' | 'unknown';
  readonly strategyId?: string;
}
```

The `attempts` array is the **current retry episode only**. Episode boundaries and resets belong to the caller. `policy.maxAttempts` is measured against this array, never against attempts from previous calls or a lifetime total.

The verdict reports:

- `attempts` — the number of attempts in this episode;
- `consecutiveFailures` — the largest trailing `k` for which the last `k` outcomes are all `failure`;
- `consecutiveNoProgress` — the corresponding trailing count for `no_progress`.

These are independent axes. A failure does not increment the no-progress counter, and a no-progress outcome does not increment the failure counter. `unknown` terminates both streaks and is never counted as either outcome.

## Public API

The package root exports the runtime values `judgeRetry` and `RetryError`, plus these TypeScript types:

- `RetryAttemptOutcome` — the closed `success`, `failure`, `no_progress`, or `unknown` vocabulary;
- `RetryAttempt` — one declared attempt;
- `RetryPolicy` — optional `maxAttempts` and `maxStrategyAttempts` limits;
- `RetryJudgeInput` — the current episode and optional policy;
- `RepeatedStrategyRun` — the latest repeated strategy and its run length;
- `RetryVerdict` — the deterministic judgment;
- `RetryErrorCode` — currently only `invalid_input`.

`judgeRetry(input: unknown): RetryVerdict` treats its input as untrusted. It throws `RetryError` with `code === 'invalid_input'` for malformed input. The error's `name` is `RetryError`.

Inputs must be plain objects. `attempts` is required and must be an array. Each attempt must have an own `outcome` property with exactly one of the four literals. An own `strategyId` must be a non-empty, non-whitespace-only string; accepted strings are preserved verbatim rather than trimmed. An own `policy` must be a plain object, and each present limit must be a finite integer greater than or equal to one. Explicit `undefined` values on these optional properties are rejected rather than treated as absent. Unexpected extra keys are accepted and ignored, matching the validation precedent used by `@j1nn0/agent-progress`.

## What counts as a repeated retry

`repeatedStrategy` is present exactly when the last attempt has a `strategyId` and its outcome is `failure` or `no_progress`.

Its `attempts` value is the maximal trailing run in which every attempt:

- has a `strategyId` exactly equal to the last attempt's identifier, using case-sensitive string equality; and
- has outcome `failure` or `no_progress`.

Failure and no-progress outcomes count together for this run. For example, `failure` → `no_progress` → `failure` under strategy `search-v1` is a run of three. Any success, unknown outcome, different identifier, or absent identifier terminates the scan. An absent `strategyId` means that identity is unknown: id-less attempts never join a run, and two id-less failures are never treated as repetitions of one another.

Duplicate strategy identifiers anywhere in the history are valid and expected. Repetition detection is the purpose of the field; this differs deliberately from milestone-set primitives that reject duplicate identifiers.

When the rule does not apply, `repeatedStrategy` is omitted. It is never `null` or an own property whose value is `undefined`.

## Policy semantics

An absent or empty policy imposes no limits. The `retryAllowed` decision is derived in this order:

1. An empty episode (`attempts === 0`) returns `true`: the first attempt is always permitted because nothing has been observed.
2. If the last outcome is `success`, it returns `false`: the episode ended successfully. This is not a budget-exhaustion signal.
3. Otherwise it returns `false` if either applicable limit is reached:
   - `maxAttempts` is present and `attempts >= maxAttempts`; or
   - `maxStrategyAttempts` is present, `repeatedStrategy` is present, and `repeatedStrategy.attempts >= maxStrategyAttempts`.
4. If neither limit blocks, it returns `true`.

The comparisons are inclusive. A `maxAttempts` value of `3` blocks when the episode contains exactly three attempts (and also after that). A `maxStrategyAttempts` value of `3` blocks exactly when the repeated run reaches three; a run of two remains allowed. A `maxStrategyAttempts` value of `1` blocks immediately after one unsuccessful identified attempt. The strategy limit does not apply when `repeatedStrategy` is absent, including for id-less attempts.

A success always wins before budget checks, but it still makes `retryAllowed` false because there is no unsuccessful result left to retry. An empty history returns `true` even when a policy contains limits.

## Relationship to Progress

Retry Guard is independent of `@j1nn0/agent-progress` and has no Progress dependency or Progress types. Progress judges cumulative milestone-set growth; Retry Guard judges the outcome history that a caller supplies.

A caller may map a Progress verdict to this package's generic outcome vocabulary. A suggested mapping is:

- `progress` → `success`;
- `no_progress` → `no_progress`;
- `unknown` → `unknown`.

That mapping is the caller's decision. Retry Guard does not import Progress, infer a mapping, or decide what a progress verdict means for a particular task.

## Relationship to Evidence

Retry Guard is independent of any evidence verifier. Declared results are trusted as claims for the purpose of this judgment and are never verified. A declared `success` therefore ends the episode according to this contract even if another component would later determine that the underlying claim was unsupported.

## What Retry Guard does not know

The primitive does not know:

- why an attempt failed or made no progress;
- what a strategy identifier means or whether two strategies are semantically equivalent;
- whether a caller's outcome or strategy declaration is true;
- whether the task is impossible, unsafe, or complete;
- whether another attempt would be useful beyond the explicit policy and trailing declarations.

It does not infer causes, normalize strategy identifiers, execute retries, choose a strategy, or mutate caller state.

## Determinism and privacy

The judge is a pure function:

- equal inputs produce deep-equal and JSON-round-trip-safe verdicts;
- output objects are newly constructed and do not alias input objects;
- no timestamps, random identifiers, global state, persistence, or hidden history are used;
- there is no filesystem or other I/O, network access, telemetry, or console output in the core package;
- inputs and outputs are plain serializable, JSON-safe data;
- declarations are inspected only for the fields in the contract and are never logged.

## Limitations

Version 0.1 uses a closed outcome vocabulary and a single-episode scope by design. The caller must choose episode boundaries and provide the complete history for the episode. The history grows with episode length, and each call scans its tail for the two streaks and the latest strategy run. Long-lived callers should start a new episode when appropriate rather than retain an unbounded history.

The primitive cannot infer causes, semantic strategy equivalence, truth, task impossibility, or the value of a retry. It also does not provide a retry executor, persistence layer, CLI, Pi adapter, MCP integration, or provider integration.
