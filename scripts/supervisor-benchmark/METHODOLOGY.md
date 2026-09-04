# Supervisor benchmark methodology

## Variants and agent runs

The benchmark compares two variants: **baseline** (no Supervisor) and **supervisor** (the real production extension loaded through a transparent telemetry wrapper). Everything else is identical between the variants.

A meaningful agent run is exactly one `agent_start`/`agent_end` pair caused by a planned benchmark phase or by an accepted Supervisor automatic follow-up. Tool-loop model turns are not separate runs.

> **Unsupported-completion rule:** A completion claim emitted when the scenario-required verification was not satisfied at the moment of the claim counts. This is monotonic: it is never decremented if a later Supervisor follow-up repairs the problem. It must not be reinterpreted as “only terminal unresolved completion claims.” The current Completion Gate acts after the initial claim, so the gate may legitimately fail; that result is valid product evidence.

## Measurements and outcomes

- `totalTokens = Pi session token total + Supervisor auxiliary-call token total`. The baseline auxiliary total is 0. Measurements are never estimated or guessed.
- Wall-clock time is monotonic and starts when the scenario request is accepted. It ends only when the scenario fully settles, including Supervisor follow-up runs and planned compaction/resume phases. Supervisor assessment latency is not excluded. Variants never run concurrently.
- Behavioral limits (maximum runs and maximum tool calls) produce a completed run with `taskSuccess: false`; they are not infrastructure errors. Infrastructure errors are only real provider, harness, or oracle failures and the overall safety timeout. Such a run remains in the dataset and is never retried or replaced.
- Task success is always the deterministic scenario oracle. Agent claims, Supervisor claims, and LLM judging are never used.

## Pairing and isolation

Both variants of each pair run adjacent, with the order frozen per pair in `executionProfile`: 30 pairs are baseline-first and 30 pairs are supervisor-first. There is no execution-time randomness. Each variant receives fresh isolation; no workspace or Supervisor state is reused.

## B1 execution rule

**B1 must execute using the runner and scenarios exactly as of `plan.sourceSha`**, for example through a temporary git worktree checked out at that SHA, with the frozen `plan.json` supplied read-only. It must not use a later `main`.

No Supervisor context-continuity improvement is claimed, because S5 is not implemented.
