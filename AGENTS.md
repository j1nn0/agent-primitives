# Repository guidance

This repository is a pnpm workspace of small, composable primitives for making AI agents more reliable.

## Source of truth

- Treat the current repository state, package manifests, tests, workflows, package documentation, and checked-in policies as authoritative.
- Values stated in task prompts such as expected HEADs, versions, test counts, file layouts, or previously observed behavior are context, not authority; verify them before relying on them.
- When prompt assumptions and the checked-out repository disagree, use the actual repository state and report the discrepancy.
- Prefer primary sources when external behavior matters. For package managers, registries, CI systems, harness APIs, and providers, verify current official documentation or the installed implementation rather than relying on memory.
- Do not copy historical implementation choices forward merely because they appeared in an earlier report; confirm they still match the current code and contract.

## Architecture

- Keep core primitives harness-agnostic. They should accept explicit inputs and return plain, serializable data.
- Put runtime lifecycle behavior, session integration, persistence, recovery, and harness-specific APIs in adapters.
- Keep provider- and harness-specific behavior out of core packages unless the abstraction is independently justified by multiple real consumers.
- Prefer adapter-local solutions over premature shared abstractions.
- Keep internal helpers internal. Do not expand a package's public API without a concrete consumer or requirement.

## Reliability and safety

- Preserve fail-safe behavior. Missing, malformed, contradictory, or unverifiable data must never be silently upgraded to a successful or preserved state.
- Keep uncertainty visible rather than guessing or repairing state implicitly.
- Do not weaken existing validation, authority, lifecycle, recovery, provenance, or privacy boundaries to make a feature easier to implement.
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
    pnpm check:release

During development, focused tests are fine, but run the complete validation sequence before considering a change finished.

For a clean-state validation, remove generated package build output first, then rerun the full sequence.

Also verify packaging when package contents change:

- Run `publint` and `attw` through the repository's `pnpm check:package` path.
- For workspace packages, validate the actual release artifact through the repository's pnpm pack path, for example `pnpm --filter <package> pack`.
- Do not use plain source-directory `npm pack` or `npm publish` as the authoritative release-artifact path when workspace protocol rewriting is part of the package contract.
- Confirm packed workspace dependencies are rewritten to the expected publishable semver ranges and that no `workspace:`, `file:`, `link:`, or local absolute paths remain.
- Confirm there is no accidental inclusion of tests, benchmarks, live results, temporary files, local configuration, or `node_modules`.

## Release work

- Read `RELEASE.md`, `.github/workflows/release.yml`, and `scripts/guard-release-workflow.mjs` before changing release behavior.
- Preserve the established tokenless Trusted Publishing and provenance path unless the task explicitly requires a researched change.
- Keep release publishing based on pnpm-packed tarballs; do not switch to source-directory npm publishing or `pnpm publish` without explicit justification and validation.
- Keep release triggers, permission boundaries, package ordering, provenance identity checks, and registry-smoke behavior fail-safe.
- Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, registry secrets, or broader `id-token: write` permissions merely to simplify publishing.
- Run `pnpm check:release` after any release-workflow, release-policy, or release-guard change.
- When the release guard changes, verify the unchanged workflow as a positive control and exercise relevant negative controls against temporary mutated copies.
- Do not publish packages, mutate dist-tags, create git tags, or create GitHub Releases unless the task explicitly requests that release action.
- When working on a first publish or registry bootstrap, verify current official npm requirements instead of assuming an already-published package's Trusted Publishing flow applies unchanged.

## Git and repository hygiene

- Preserve unrelated user changes.
- Inspect `git status` and the actual diff before committing.
- Do not rewrite pushed history.
- Never use `git push --force` or `git push --force-with-lease`.
- Do not create tags, releases, or publish packages unless explicitly requested.
- Do not commit temporary probes, generated live outputs, credentials, or experiment scratch files.
- Do not add AI attribution or session metadata to commits, including `Co-Authored-By` entries for AI tools, model names, generated-by markers, or session identifiers.
- After interrupted or timed-out commands, check both tracked and untracked files before continuing.

## Agent orchestration

- Use the installed orchestration skill when the task calls for delegated multi-agent work; keep repository guidance focused on repository invariants rather than duplicating skill-specific model or lifecycle configuration here.
- Treat delegated-agent reports as claims to verify, not as proof of completion.
- Review the actual diff, tests, and repository state after delegated work.
- Keep mutating agents serialized when they share a working tree.
- If an agent is interrupted or stopped, verify its lifecycle state is actually idle or terminated before assuming it cannot resume.
- A clean Git working tree does not prove that a delegated agent has stopped.
- If the same delegated work makes no progress twice, stop repeating the same instruction and change the approach.

## Communication

- Use Japanese only for user-facing responses.
- Use English for all other content, including internal reasoning, tool interactions, code, comments, documentation, commit messages, and agent-to-agent communication.

## Completion

Before reporting a task complete:

- Review the final diff against the requested scope.
- Confirm relevant regressions are covered.
- Run the full validation sequence.
- Confirm the working tree contains no unintended files or changes.
- If packaging changed, inspect the actual packed artifact and its manifest rather than relying only on source files.
- If release behavior changed, run `pnpm check:release` and the relevant positive/negative guard checks.
- If the task requires a push, confirm local HEAD matches the remote branch and required CI jobs are green.
- Report remaining risks and unverified assumptions explicitly.

When in doubt, prefer:

- explicit over inferred
- fail-safe over convenient repair
- evidence over assumption
- current repository state over stale prompt assumptions
- focused changes over broad refactors
- adapter-local behavior over premature core abstraction
- preserving durable information over silently discarding it
