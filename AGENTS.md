# Repository guidance

This repository is a pnpm workspace of small, composable primitives for making AI agents more reliable.

## Architecture

- Keep core primitives harness-agnostic. They should accept explicit inputs and return plain, serializable data.
- Put runtime lifecycle behavior, session integration, persistence, recovery, and harness-specific APIs in adapters.
- Keep provider- and harness-specific behavior out of core packages unless the abstraction is independently justified by multiple real consumers.
- Prefer adapter-local solutions over premature shared abstractions.
- Keep internal helpers internal. Do not expand a package's public API without a concrete consumer or requirement.

## Reliability and safety

- Preserve fail-safe behavior. Missing, malformed, contradictory, or unverifiable data must never be silently upgraded to a successful or preserved state.
- Keep uncertainty visible rather than guessing or repairing state implicitly.
- Do not weaken existing validation, authority, lifecycle, recovery, or privacy boundaries to make a feature easier to implement.
- Prefer explicit user decisions over inferred destructive actions.
- Do not automatically delete, merge, supersede, retire, or otherwise mutate durable state unless that behavior is an explicit part of the task and its safety contract.
- Preserve historical and provenance information unless a deliberate retention policy says otherwise.

## Privacy and side effects

- No implicit network calls, telemetry, analytics, global state, or external persistence.
- Never include protected content, credentials, raw provider errors, or unrelated session data in logs, notifications, fixtures, or error messages.
- Do not modify user-level agent, provider, authentication, or model settings during tests or smoke runs.
- Isolate live runtime tests from the user's normal sessions and configuration.
- Do not add live provider/model calls to CI.

## Persistence and compatibility

- Treat persisted state as an external compatibility boundary.
- When changing persisted structures, preserve supported older schemas through explicit migration or compatibility handling.
- Validate the latest persisted state fail-safely; do not silently fall back to older state when doing so would hide corruption.
- Do not introduce a new schema version unless the persisted representation actually needs to change.
- Do not infer semantic freshness or authority from timestamps, insertion order, provenance order, or other metadata unless their contract explicitly guarantees it.

## Changes

- Read the nearest package README, existing implementation, and relevant tests before changing behavior.
- Keep diffs focused on the requested problem.
- Prefer the smallest change that preserves existing contracts.
- Reuse existing modules and utilities before creating new abstractions.
- Avoid new runtime dependencies unless they provide clear value that cannot reasonably be achieved with the existing stack.
- Update tests for every behavior change.
- Update documentation when public behavior, commands, persistence semantics, or package APIs change.
- Do not change unrelated code while implementing a task.

## Research and benchmarks

- Measure before changing behavior when the task concerns model quality, heuristics, extraction, verification, deduplication, or runtime policy.
- Separate research/evaluation code from production code.
- Prefer deterministic evaluators and explicit fixture ground truth over LLM-as-judge.
- Do not tune heuristics solely to the corpus used to design them; use independent or operational data when available.
- Treat precision, recall, safety failures, latency, provider calls, and privacy exposure as separate dimensions.
- A benchmark improvement alone is not sufficient justification for a production change.
- If evidence does not justify a production change, leaving production code unchanged is a valid result.
- Keep benchmark corpora, recorded research results, tests, and temporary artifacts out of published package tarballs.

## Live model evaluation

- Reuse recorded results instead of repeating equivalent provider calls.
- Set and respect an explicit call budget before starting a live evaluation.
- Count failed, malformed, timed-out, and aborted dispatched requests against that budget.
- Do not retry provider failures unless the experiment explicitly requires retry behavior.
- Keep live evaluation bounded and isolated.
- Never change the user's default provider or model settings to run an experiment.

## Testing

Run commands from the repository root.

Build before commands that consume workspace build output:

    pnpm build
    pnpm lint
    pnpm typecheck
    pnpm test
    pnpm check:package
    pnpm example

During development, focused tests are fine, but run the complete validation sequence before considering a change finished.

For a clean-state validation, remove generated package build output first, then rerun the full sequence.

Also verify packaging when package contents change:

- `publint`
- `attw` through `pnpm check:package`
- `npm pack --dry-run` or the existing equivalent
- no accidental inclusion of tests, benchmarks, live results, or temporary files

## Git and repository hygiene

- Preserve unrelated user changes.
- Inspect `git status` and the actual diff before committing.
- Do not rewrite pushed history.
- Never use `git push --force` or `git push --force-with-lease`.
- Do not create tags, releases, or publish packages unless explicitly requested.
- Do not commit temporary probes, generated live outputs, credentials, or experiment scratch files.
- After interrupted or timed-out commands, check both tracked and untracked files before continuing.

## Agent orchestration

- Treat delegated-agent reports as claims to verify, not as proof of completion.
- Review the actual diff, tests, and repository state after delegated work.
- Keep mutating agents serialized when they share a working tree.
- If an agent is interrupted or stopped, verify its lifecycle state is actually idle or terminated before assuming it cannot resume.
- A clean Git working tree does not prove that a delegated agent has stopped.
- If the same delegated work makes no progress twice, stop repeating the same instruction and change the approach.

## Completion

Before reporting a task complete:

- Review the final diff against the requested scope.
- Confirm relevant regressions are covered.
- Run the full validation sequence.
- Confirm the working tree contains no unintended files or changes.
- If the task requires a push, confirm local HEAD matches the remote branch and required CI jobs are green.
- Report remaining risks and unverified assumptions explicitly.

When in doubt, prefer:

- explicit over inferred
- fail-safe over convenient repair
- evidence over assumption
- focused changes over broad refactors
- adapter-local behavior over premature core abstraction
- preserving durable information over silently discarding it
