# @j1nn0/agent-budget

## What it is

`@j1nn0/agent-budget` is a CONTROL-type core primitive for judging caller-declared numeric consumption against a caller-declared limit. It returns a deterministic `within_budget` or `exhausted` outcome with the remaining quantity. It is an ESM-only package with zero runtime dependencies.

The package evaluates declarations supplied by its caller. It does not observe an agent, count events, infer units, retain history, or decide what should count toward `consumed`.

## Why it exists

A caller may need a small, explicit ceiling check before continuing work. This primitive keeps that check separate from event collection and policy: the caller supplies the current quantity and the hard limit, and the core applies only the inclusive comparison.

The result exposes overage instead of hiding it. A negative `remaining` value is useful caller-owned data, not an implicit repair or clamp.

## Installation

Install the published package from the npm registry with your package manager:

- pnpm: `pnpm add @j1nn0/agent-budget`
- npm: `npm install @j1nn0/agent-budget`
- Yarn: `yarn add @j1nn0/agent-budget`

### From a local checkout (development)

For development or local use, build the package, then install the built package by local path:

```sh
REPO_DIR=/abs/path/to/agent-primitives
PACKAGE_DIR="$REPO_DIR/packages/agent-budget"
cd "$REPO_DIR"
pnpm install
pnpm --filter @j1nn0/agent-budget build
pnpm add "file:$PACKAGE_DIR"
```

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Pass the current caller-declared consumption and hard limit to the judge:

```ts
import { judgeBudget } from '@j1nn0/agent-budget';

console.log(judgeBudget({ consumed: 2, limit: 5 }));
// { outcome: 'within_budget', remaining: 3 }

console.log(judgeBudget({ consumed: 5, limit: 5 }));
// { outcome: 'exhausted', remaining: 0 }
```

## The model

`BudgetJudgeInput` has two required numeric quantities:

```ts
interface BudgetJudgeInput {
  readonly consumed: number;
  readonly limit: number;
}
```

`consumed` is the quantity the caller declares as used. `limit` is the caller-declared hard ceiling. Units are opaque to the core: the caller decides whether a quantity represents tokens, bytes, tool-call cost, or another numeric measure, and decides what contributes to it.

The verdict contains only the outcome and the unmodified arithmetic remainder:

```ts
interface BudgetVerdict {
  readonly outcome: 'within_budget' | 'exhausted';
  readonly remaining: number;
}
```

This model has no warning threshold, soft limit, reset, window, or automatic counting behavior.

## Public API reference

The package root exports the runtime values `judgeBudget` and `BudgetError`, plus these TypeScript types:

- `BudgetOutcome` — the closed `within_budget` or `exhausted` vocabulary;
- `BudgetErrorCode` — currently only `invalid_input`;
- `BudgetJudgeInput` — the two caller-declared numeric quantities;
- `BudgetVerdict` — the deterministic outcome and remaining quantity.

`judgeBudget(input: unknown): BudgetVerdict` treats its input as untrusted. It returns a fresh plain object or throws `BudgetError` with `code === 'invalid_input'` and message `Invalid budget input.`. The error's `name` is `BudgetError`; callers normally match on the thrown error rather than construct one.

## Validation rules

- The input must be a plain object whose prototype is `Object.prototype` or `null`. Arrays, primitives, class instances, and objects with another prototype are invalid.
- The accepted top-level keys are exactly `consumed` and `limit`. Unknown keys are invalid.
- `consumed` and `limit` are required own properties. Each must be a finite JavaScript number greater than or equal to zero. Fractional values are valid.
- Explicit `undefined`, `NaN`, positive or negative infinity, negative numbers, and non-numbers are invalid rather than being given defaults.
- A `limit` of `0` is valid. Because valid `consumed` values are non-negative, every valid observation with `limit === 0` is exhausted, including `consumed === 0` at the inclusive boundary.
- Invalid input throws `BudgetError('invalid_input', 'Invalid budget input.')`. There is no implicit default, repair, or clamping behavior. Positive-integer attempt-count policies belong to other primitives, not this quantity check.

## Comparison semantics

The boundary is inclusive: `consumed >= limit` returns `outcome: 'exhausted'`. Otherwise the outcome is `within_budget`.

`remaining` is always `limit - consumed`. It is reported unclamped, so an exhausted verdict may carry a negative remaining value.

## Numbers and precision

Fractional values are allowed and follow ordinary JavaScript number floating-point semantics. The core does not guarantee currency-grade precision or decimal rounding. Callers who need exact accounting should pass integers in their smallest natural unit.

## Relationship to Agent State

Agent State records caller-declared work items, statuses, and decisions. Budget does not read or update that state, and it does not infer consumption from work-item status.

## Relationship to Agent Progress

Agent Progress judges movement in caller-declared milestone sets. A caller may explicitly use a Progress result when deciding what quantity to declare, but Budget performs no automatic mapping.

## Relationship to Agent Retry Guard

Retry Guard owns attempt-outcome continuation policy. Budget owns only quantitative ceilings and never counts attempts itself. A caller may consult both judgments explicitly when deciding whether to continue.

## Relationship to Agent Evidence

Evidence judges whether caller-declared claims have linked supporting records. Budget does not verify that consumption was observed or that a limit is justified, and it does not map evidence verdicts automatically.

## Relationship to Context Guard

Context Guard protects and verifies durable context across its own boundaries. Budget neither captures nor persists context and does not change context policy.

## Relationship to Handoff

Handoff carries caller-declared packets across agents or sessions. A caller may include a Budget verdict as explicit data when appropriate, but Budget does not create packets, select successors, or decide whether a handoff is safe.

## Determinism and privacy

The judge is a pure function:

- equal inputs produce deep-equal and JSON-round-trip-safe verdicts;
- each call returns a fresh plain result object;
- no I/O, telemetry, network access, global state, persistence, or hidden history is used;
- the core never logs inputs or stores declarations.

## Limitations

Version 0.1 judges one `consumed` and `limit` pair only. It does not provide multi-resource maps, soft or warning thresholds, units, automatic resets, windows, forecasting, provider pricing, or automatic accounting. Phase 1 ships no Pi adapter; future adapters would integrate explicitly at their own lifecycle boundaries.
