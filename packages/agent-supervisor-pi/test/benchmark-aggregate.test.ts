import { describe, expect, it } from 'vitest';
import {
  aggregateSupervisorBenchmarkDataset,
  validateSupervisorBenchmarkDataset,
} from '../src/index.js';
import type { SupervisorBenchmarkDatasetV1 } from '../src/index.js';
import {
  completedRun,
  expectedPair,
  infrastructureErrorRun,
  metrics,
  plan,
  validDataset,
} from './benchmark-helper.js';

function fixture(): SupervisorBenchmarkDatasetV1 {
  const benchmarkPlan = plan({
    expectedPairs: [
      expectedPair('pair-a', { scenarioClass: 'recovery', modelFamily: 'family-a' }),
      expectedPair('pair-b', { scenarioClass: 'recovery', modelFamily: 'family-b' }),
      expectedPair('pair-c', { scenarioClass: 'tool-use', modelFamily: 'family-a' }),
      expectedPair('pair-d', { scenarioClass: 'tool-use', modelFamily: 'family-c' }),
      expectedPair('pair-e', { scenarioClass: 'tool-use', modelFamily: 'family-c' }),
    ],
  });
  const runs = [
    completedRun('baseline', 'pair-a', 'baseline-a', {
      oracle: { kind: 'deterministic', taskSuccess: false },
      metrics: metrics({
        repeatedFailedInvocations: 1,
        unsupportedCompletionClaims: 2,
        userInterventions: 3,
        totalTokens: 100,
        wallClockMs: 1_000,
      }),
    }),
    completedRun('supervisor', 'pair-a', 'supervisor-a', {
      oracle: { kind: 'deterministic', taskSuccess: true },
      metrics: metrics({
        repeatedFailedInvocations: 4,
        unsupportedCompletionClaims: 5,
        userInterventions: 6,
        supervisorInterventions: 2,
        falseInterventions: 1,
        supervisorFatalFailures: 1,
        rawToolOutputPersisted: 1,
        automaticContinuationLimitViolations: 1,
        automaticFollowUps: 2,
        auxiliaryModelCalls: 2,
        meaningfulAgentRuns: 1,
        totalTokens: 120,
        wallClockMs: 1_100,
      }),
    }),
    completedRun('baseline', 'pair-b', 'baseline-b', {
      oracle: { kind: 'deterministic', taskSuccess: true },
      metrics: metrics({ repeatedFailedInvocations: 10, unsupportedCompletionClaims: 20, userInterventions: 30 }),
    }),
    completedRun('supervisor', 'pair-b', 'supervisor-b', {
      oracle: { kind: 'deterministic', taskSuccess: false },
      metrics: metrics({
        repeatedFailedInvocations: 40,
        unsupportedCompletionClaims: 50,
        userInterventions: 60,
        supervisorInterventions: 1,
        supervisorFatalFailures: 2,
        rawToolOutputPersisted: 2,
        totalTokens: 200,
        wallClockMs: 2_000,
      }),
    }),
    completedRun('baseline', 'pair-c', 'baseline-c', {
      oracle: { kind: 'deterministic', taskSuccess: false },
      metrics: metrics({
        repeatedFailedInvocations: 100,
        unsupportedCompletionClaims: 200,
        userInterventions: 300,
        totalTokens: 200,
      }),
    }),
    completedRun('supervisor', 'pair-c', 'supervisor-c', {
      oracle: { kind: 'deterministic', taskSuccess: false },
      metrics: metrics({
        repeatedFailedInvocations: 400,
        unsupportedCompletionClaims: 500,
        userInterventions: 600,
        totalTokens: 200,
      }),
    }),
    completedRun('baseline', 'pair-d', 'baseline-d', {
      oracle: { kind: 'deterministic', taskSuccess: true },
      metrics: metrics({
        repeatedFailedInvocations: 1_000,
        unsupportedCompletionClaims: 2_000,
        userInterventions: 3_000,
        totalTokens: 50,
        wallClockMs: 100,
      }),
    }),
    completedRun('supervisor', 'pair-d', 'supervisor-d', {
      oracle: { kind: 'deterministic', taskSuccess: true },
      metrics: metrics({
        repeatedFailedInvocations: 4_000,
        unsupportedCompletionClaims: 5_000,
        userInterventions: 6_000,
        totalTokens: 75,
        wallClockMs: 90,
      }),
    }),
    infrastructureErrorRun('baseline', 'pair-e', 'baseline-e'),
    completedRun('supervisor', 'pair-e', 'supervisor-e', {
      metrics: metrics({
        repeatedFailedInvocations: 999,
        totalTokens: 999,
        wallClockMs: 999,
      }),
    }),
  ];
  return validateSupervisorBenchmarkDataset(validDataset(benchmarkPlan, runs));
}

describe('supervisor benchmark aggregation', () => {
  it('classifies paired outcomes and retains raw success counts', () => {
    const aggregate = aggregateSupervisorBenchmarkDataset(fixture());

    expect(aggregate.wins).toBe(1);
    expect(aggregate.regressions).toBe(1);
    expect(aggregate.ties).toBe(2);
    expect(aggregate.baselineSuccesses).toBe(2);
    expect(aggregate.supervisorSuccesses).toBe(2);
    expect(aggregate.baselineSuccessRate).toBe(0.5);
    expect(aggregate.supervisorSuccessRate).toBe(0.5);
    expect(aggregate.successDeltaPercentagePoints).toBe(0);
    expect(aggregate.pairedSignTest).toMatchObject({
      status: 'computed',
      discordantPairs: 2,
      significant: false,
    });
  });

  it('limits metric totals to complete pairs and counts infrastructure records separately', () => {
    const aggregate = aggregateSupervisorBenchmarkDataset(fixture());

    expect(aggregate.totalPlannedPairs).toBe(5);
    expect(aggregate.completePairs).toBe(4);
    expect(aggregate.infrastructureErrorPairs).toBe(1);
    expect(aggregate.infrastructureErrorRuns).toBe(1);
    expect(aggregate.baselineRepeatedFailedInvocations).toBe(1_111);
    expect(aggregate.supervisorRepeatedFailedInvocations).toBe(4_444);
    expect(aggregate.baselineUnsupportedCompletionClaims).toBe(2_222);
    expect(aggregate.supervisorUnsupportedCompletionClaims).toBe(5_555);
    expect(aggregate.baselineUserInterventions).toBe(3_333);
    expect(aggregate.supervisorUserInterventions).toBe(6_666);
    expect(aggregate.supervisorInterventions).toBe(3);
    expect(aggregate.falseInterventions).toBe(1);
    expect(aggregate.supervisorFatalFailures).toBe(3);
    expect(aggregate.rawToolOutputPersisted).toBe(3);
    expect(aggregate.automaticContinuationLimitViolations).toBe(1);
  });

  it('counts per-run automatic follow-up and auxiliary-model bound violations', () => {
    const aggregate = aggregateSupervisorBenchmarkDataset(fixture());

    expect(aggregate.automaticFollowUpBoundViolations).toBe(1);
    expect(aggregate.auxiliaryModelCallBoundViolations).toBe(1);
  });

  it('reports complete-pair model-family and scenario-class coverage in sorted order', () => {
    const aggregate = aggregateSupervisorBenchmarkDataset(fixture());

    expect(aggregate.modelFamilies).toEqual(['family-a', 'family-b', 'family-c']);
    expect(aggregate.scenarioClasses).toEqual([
      {
        scenarioClass: 'recovery',
        completePairs: 2,
        modelFamilyCounts: { 'family-a': 1, 'family-b': 1 },
        regressions: 1,
        falseInterventions: 1,
        supervisorInterventions: 3,
      },
      {
        scenarioClass: 'tool-use',
        completePairs: 2,
        modelFamilyCounts: { 'family-a': 1, 'family-c': 1 },
        regressions: 0,
        falseInterventions: 0,
        supervisorInterventions: 0,
      },
    ]);
  });

  it('skips unusable token and wall-clock samples and reports their missing counts', () => {
    const aggregate = aggregateSupervisorBenchmarkDataset(fixture());

    expect(aggregate.tokenOverheadSamples).toEqual([
      { numerator: 0n, denominator: 200n },
      { numerator: 20n, denominator: 100n },
      { numerator: 25n, denominator: 50n },
    ]);
    expect(aggregate.wallClockOverheadSamples).toEqual([
      { numerator: -10n, denominator: 100n },
      { numerator: 100n, denominator: 1_000n },
    ]);
    expect(aggregate.missingTokenSamples).toBe(1);
    expect(aggregate.missingWallClockSamples).toBe(2);
    expect(aggregate.tokenOverheadMedian).toEqual({ numerator: 20n, denominator: 100n });
    expect(aggregate.wallClockOverheadMedian).toEqual({ numerator: 0n, denominator: 200_000n });
  });

  it('is invariant to run and expected-pair ordering', () => {
    const dataset = fixture();
    const permutations = [
      dataset,
      {
        ...dataset,
        plan: { ...dataset.plan, expectedPairs: [...dataset.plan.expectedPairs].reverse() },
        runs: [...dataset.runs].reverse(),
      },
      {
        ...dataset,
        plan: {
          ...dataset.plan,
          expectedPairs: [
            dataset.plan.expectedPairs[2]!,
            dataset.plan.expectedPairs[4]!,
            dataset.plan.expectedPairs[0]!,
            dataset.plan.expectedPairs[3]!,
            dataset.plan.expectedPairs[1]!,
          ],
        },
        runs: [dataset.runs[4]!, dataset.runs[1]!, dataset.runs[8]!, dataset.runs[0]!, dataset.runs[9]!, dataset.runs[5]!, dataset.runs[3]!, dataset.runs[6]!, dataset.runs[2]!, dataset.runs[7]!],
      },
    ].map((permutation) =>
      aggregateSupervisorBenchmarkDataset(validateSupervisorBenchmarkDataset(permutation)),
    );

    expect(permutations[1]).toEqual(permutations[0]);
    expect(permutations[2]).toEqual(permutations[0]);
  });
});
