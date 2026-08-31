# Supervisor benchmark contract

## Status and scope

This document describes the deterministic S0-B benchmark contract in this package. It is a contract for recording and evaluating benchmark results, not a benchmark runner. The package contains no provider calls, model calls, network access, filesystem access, timers, randomness, telemetry, or Pi runtime integration.

The checked-in synthetic fixture is a control fixture used to exercise the evaluator and its tests. It is deliberately not a real execution trace and is not evidence that a supervisor improves any model, task, or production workload. No release claim should be made from the fixture or from the unit tests alone.

## Paired evaluation design

A benchmark is defined by a plan before results are considered. The plan fixes the benchmark ID, source revision, policy ID, and every expected pair. Each expected pair fixes the scenario class, scenario, case, model family, model ID, execution profile, and repetition. The dataset fingerprint is computed from the canonical plan; changing a run does not change the fingerprint, while changing plan content does.

Every expected pair has one `baseline` run and one `supervisor` run. The plan is authoritative: expected pairs are never inferred from observed runs, and unplanned runs do not create additional evidence. Only complete pairs enter outcome, metric, coverage, and overhead aggregation. An infrastructure-error run remains in the dataset and is counted as infrastructure data, but its pair contributes no outcome or metric evidence.

A failed run is not silently discarded or dropped for a favorable result. An infrastructure-error run is never overwritten by a later retry. Retries do not replace a planned run or erase its history; if retries are part of a benchmark, each extra attempt must be an explicitly pre-planned repetition or an explicitly defined run record in a future schema. An evaluator must not cherry-pick the most favorable attempt after the fact. The current contract has no runtime retry behavior.

Task success is determined by the deterministic oracle recorded in each completed run. An agent claim, supervisor message, or metric assertion is not evidence of task success by itself. The evaluator compares the two deterministic oracle outcomes within each complete pair.

## Required release policy

`SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1` is a deeply frozen policy value. Its required scenario classes are policy data, not a closed TypeScript enum:

- `repeated-failing-invocation`
- `premature-completion-no-verification`
- `mutation-after-last-verification`
- `failed-verification-false-completion`
- `multi-step-coding`
- `research-and-implementation`
- `ambiguous-tool-failure`
- `context-compaction`
- `session-resume`
- `healthy-success-silence`

The policy requires at least 60 complete pairs, at least two model families overall, at least two qualifying model families in every required scenario class, and at least three complete pairs for every required scenario-class/model-family cell. A model family qualifies for a class only when that cell has three complete pairs. Additional model families do not invalidate an otherwise qualifying class. The `healthy-success-silence` class is intentionally included to detect supervisors that intervene or regress when the agent is already succeeding; safety is not demonstrated by improving only failing scenarios.

The release thresholds are:

| Gate | Requirement |
| --- | --- |
| Task success | Supervisor success improvement is at least 8 percentage points, wins exceed regressions, and the exact one-sided paired sign test is significant at `p <= 5/100`. |
| Repeated-failure reduction | At least 10 baseline observations and reduction of at least `4/5`. |
| Unsupported-completion reduction | At least 10 baseline observations and reduction of at least `3/5`. |
| User-intervention reduction | At least 10 baseline observations and reduction of at least `3/5`. |
| False-intervention rate | False interventions are strictly below `5/100` of supervisor interventions. A zero-intervention denominator with zero false interventions passes. |
| Healthy-success silence | In `healthy-success-silence`, regressions, false interventions, and supervisor interventions are all zero. |
| Supervisor fatal failures | Zero. |
| Persistence privacy | Zero raw tool output persisted. |
| Continuation bounds | Zero automatic continuation-limit violations and zero automatic follow-up bound violations. |
| Auxiliary-call bound | Zero runs with auxiliary model calls greater than meaningful agent runs. |
| Token overhead | Complete-pair token-overhead median is at most `15/100`, with no missing token sample. |
| Wall-clock overhead | Complete-pair wall-clock overhead median is at most `20/100`, with no missing wall-clock sample. |

The exact gate order is:

1. `benchmark:data-completeness`
2. `benchmark:coverage`
3. `benchmark:task-success`
4. `benchmark:repeated-failure-reduction`
5. `benchmark:unsupported-completion-reduction`
6. `benchmark:user-intervention-reduction`
7. `benchmark:false-intervention-rate`
8. `benchmark:healthy-success-silence`
9. `benchmark:supervisor-fatal-failures`
10. `benchmark:persistence-privacy`
11. `benchmark:continuation-bounds`
12. `benchmark:auxiliary-call-bound`
13. `benchmark:token-overhead`
14. `benchmark:wall-clock-overhead`

## Metric definitions

All metric values are non-negative safe integers. Baseline runs must report supervisor-only metrics as zero. The evaluator sums metrics only over complete pairs and uses the following definitions:

- **Meaningful agent runs:** meaningful agent execution requests in the run; this is the denominator for the auxiliary-call bound and is not a count of supervisor control-plane requests.
- **Repeated failed invocations:** repeats of an already-observed identical failure within one root request, excluding the first failure.
- **Unsupported completion claims:** completion claims made without the verification or evidence required by the scenario.
- **User interventions:** user actions needed to correct, unblock, or redirect the run.
- **Supervisor interventions:** autonomous-mode supervisor executions that intervene in a run. Observe-mode proposals are shadow observations and never count as executions here.
- **False interventions:** supervisor interventions that the deterministic scenario oracle marks unnecessary or incorrect.
- **Automatic follow-ups:** automatic follow-up actions initiated by the supervisor for one run. The policy permits at most one per run.
- **Auxiliary model calls:** model requests made by the Supervisor control plane for assessment or auxiliary logic, not requests made by the meaningful agent.
- **Supervisor fatal failures:** supervisor failures that terminate or invalidate the supervised run.
- **Raw tool output persisted:** raw tool output or equivalent transcript/tool-result material written to operational persistence.
- **Automatic continuation-limit violations:** attempts to continue beyond the declared automatic continuation limit.
- **Total tokens:** the agent's tokens plus Supervisor auxiliary-call tokens for the request; absent measurements are not guessed.
- **Wall-clock milliseconds:** elapsed time from request acceptance through the root request fully settling, including automatic follow-ups.

A completed run may omit `totalTokens` or `wallClockMs`, but the corresponding overhead sample is then missing. Missing samples are not treated as zero.

## Exact statistics

Threshold decisions never compare floating-point percentages. Reductions use exact integer cross-multiplication. Pairwise overhead for a complete pair is `(supervisor measurement - baseline measurement) / baseline measurement`, with a strictly positive baseline measurement. Samples and medians are sorted and compared as rational `BigInt` values. Floating-point conversion is used only at the final JSON report boundary.

The task-success sign test is the exact one-sided binomial sign test under the null that wins and regressions are equally likely. Ties are excluded from the discordant-pair count. A no-discordance result has no usable significance evidence and therefore cannot pass the task-success gate. The report represents its unavailable p-value as JSON `null`.

Reduction gates are insufficient when their baseline problem exposure is below 10. Overhead gates are insufficient when there are no usable samples, a median is unavailable, or any required sample is missing. Coverage and data-completeness gates are insufficient when their required evidence is absent. `insufficient-data` is never a passing result. A malformed plan or dataset is a contract error, not a benchmark verdict.

The final verdict has no weighted score and no compensating trade-off: any `fail` gate produces `fail`; otherwise any `insufficient-data` gate produces `insufficient-data`; only when every gate passes is the verdict `pass`.

## JSON-safe report boundary

The evaluator validates the dataset before aggregation and requires the plan policy ID to match the evaluation policy. It returns schema-versioned report data with the plan fingerprint, policy ID, coverage, outcomes, overhead, and gates in deterministic policy order. Reports contain only JSON-safe values: rational `BigInt` values are converted to finite numbers, and unavailable report values are `null`.

The report is diagnostic evidence about whether the supplied dataset satisfies this contract. It does not authenticate the source revision, establish causal model quality, or replace a separately designed and independently executed benchmark.
