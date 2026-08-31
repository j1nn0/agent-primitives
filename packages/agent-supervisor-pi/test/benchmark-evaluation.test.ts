import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1,
  SupervisorContractError,
  evaluateSupervisorBenchmark,
  isJsonValue,
} from '../src/index.js';
import type {
  SupervisorBenchmarkCompletedRun,
  SupervisorBenchmarkDatasetV1,
  SupervisorBenchmarkGateResult,
  SupervisorBenchmarkInfrastructureErrorRun,
  SupervisorBenchmarkRun,
} from '../src/index.js';
import {
  completedRunWithoutMeasurement,
  createSyntheticSupervisorBenchmarkDataset,
  replaceSupervisorBenchmarkPlan,
  replaceSupervisorBenchmarkRun,
} from './benchmark-fixture.js';

function gate(report: ReturnType<typeof evaluateSupervisorBenchmark>, id: string): SupervisorBenchmarkGateResult {
  const result = report.gates.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`Gate not found: ${id}`);
  }
  return result;
}

function supervisorRun(
  dataset: SupervisorBenchmarkDatasetV1,
  predicate: (run: SupervisorBenchmarkCompletedRun) => boolean = () => true,
): SupervisorBenchmarkCompletedRun {
  const run = dataset.runs.find(
    (candidate): candidate is SupervisorBenchmarkCompletedRun =>
      candidate.status === 'completed' && candidate.variant === 'supervisor' && predicate(candidate),
  );
  if (run === undefined) {
    throw new Error('Supervisor run not found.');
  }
  return run;
}

function updateSupervisorRun(
  dataset: SupervisorBenchmarkDatasetV1,
  update: (run: SupervisorBenchmarkCompletedRun) => SupervisorBenchmarkRun,
  predicate: (run: SupervisorBenchmarkCompletedRun) => boolean = () => true,
): SupervisorBenchmarkDatasetV1 {
  return replaceSupervisorBenchmarkRun(dataset, update(supervisorRun(dataset, predicate)));
}

function updateSupervisorMetrics(
  dataset: SupervisorBenchmarkDatasetV1,
  update: (run: SupervisorBenchmarkCompletedRun) => SupervisorBenchmarkCompletedRun,
  predicate: (run: SupervisorBenchmarkCompletedRun) => boolean = () => true,
): SupervisorBenchmarkDatasetV1 {
  return updateSupervisorRun(dataset, update, predicate);
}

const healthyPairPrefix = `${SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.healthySuccessSilenceClass}-`;

const passing100PairDataset = () =>
  createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 8 });

describe('supervisor benchmark evaluator', () => {
  it('evaluates the synthetic control, freezes the policy, and emits JSON-safe ordered gates', () => {
    const report = evaluateSupervisorBenchmark(passing100PairDataset());

    expect(report.verdict).toBe('pass');
    expect(report.gates.map((result) => result.id)).toEqual(
      [...SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.gateOrder],
    );
    expect(report.gates.every((result) => result.status === 'pass')).toBe(true);
    expect(isJsonValue(report)).toBe(true);
    expect(Object.isFrozen(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1)).toBe(true);
    expect(Object.isFrozen(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.coverage)).toBe(true);
    expect(Object.isFrozen(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.reductions)).toBe(true);
    expect(Object.isFrozen(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.overhead)).toBe(true);
    expect(Object.isFrozen(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses)).toBe(true);
    expect(Object.isFrozen(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.gateOrder)).toBe(true);
  });

  it('validates before checking policy binding and rejects a policy mismatch', () => {
    const dataset = passing100PairDataset();
    const mismatched = replaceSupervisorBenchmarkPlan(dataset, {
      ...dataset.plan,
      policyId: 'different-policy',
    });

    expect(() => evaluateSupervisorBenchmark(mismatched)).toThrow(SupervisorContractError);
    expect(() => evaluateSupervisorBenchmark({})).toThrow(SupervisorContractError);
  });

  it('gives fail precedence over insufficient-data', () => {
    const dataset = updateSupervisorMetrics(
      passing100PairDataset(),
      (run) => ({ ...run, metrics: { ...run.metrics, supervisorFatalFailures: 1 } }),
    );
    const fatalRunId = supervisorRun(dataset).runId;
    const incompleteRun = supervisorRun(dataset, (run) => run.runId !== fatalRunId);
    const incomplete = replaceSupervisorBenchmarkRun(dataset, {
      schemaVersion: 1,
      runId: incompleteRun.runId,
      pairId: incompleteRun.pairId,
      variant: 'supervisor',
      status: 'infrastructure-error',
      errorKind: 'provider',
    } satisfies SupervisorBenchmarkInfrastructureErrorRun);
    const report = evaluateSupervisorBenchmark(incomplete);

    expect(gate(report, 'benchmark:data-completeness').status).toBe('insufficient-data');
    expect(gate(report, 'benchmark:supervisor-fatal-failures').status).toBe('fail');
    expect(report.verdict).toBe('fail');
  });

  it('fails task success when one oracle property removes the exact eight-point effect', () => {
    const dataset = passing100PairDataset();
    const tiePairId = dataset.plan.expectedPairs[8]?.pairId;
    if (tiePairId === undefined) {
      throw new Error('Expected a tie pair in the synthetic fixture.');
    }
    const red = updateSupervisorRun(
      dataset,
      (run) => ({ ...run, oracle: { ...run.oracle, taskSuccess: false } }),
      (run) => run.pairId === tiePairId,
    );
    const report = evaluateSupervisorBenchmark(red);

    expect(report.outcomes.successDeltaPercentagePoints).toBe(7);
    expect(gate(report, 'benchmark:task-success').status).toBe('fail');
    expect(report.verdict).not.toBe('pass');
  });

  it('fails task success when wins barely exceed regressions but the exact sign test is not significant', () => {
    const report = evaluateSupervisorBenchmark(
      createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 4, regressions: 3 }),
    );
    const taskGate = gate(report, 'benchmark:task-success');

    expect(taskGate.status).toBe('fail');
    expect(report.outcomes.pairedSignTest.significant).toBe(false);
    expect(report.outcomes.wins).toBeGreaterThan(report.outcomes.regressions);
  });

  it.each([
    ['benchmark:repeated-failure-reduction', 'repeatedFailedInvocations'],
    ['benchmark:unsupported-completion-reduction', 'unsupportedCompletionClaims'],
    ['benchmark:user-intervention-reduction', 'userInterventions'],
  ] as const)('fails a reduction gate when one supervisor metric property crosses its threshold', (id, metric) => {
    const red = updateSupervisorMetrics(passing100PairDataset(), (run) => ({
      ...run,
      metrics: { ...run.metrics, [metric]: 200 },
    }));
    const report = evaluateSupervisorBenchmark(red);

    expect(gate(report, id).status).toBe('fail');
    expect(report.verdict).not.toBe('pass');
  });

  it('fails the false-intervention gate at a rate above five percent', () => {
    const dataset = createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 8, supervisorInterventionsPerRun: 0 });
    const red = updateSupervisorMetrics(dataset, (run) => ({
      ...run,
      metrics: { ...run.metrics, supervisorInterventions: 1, falseInterventions: 1 },
    }));
    const report = evaluateSupervisorBenchmark(red);

    expect(gate(report, 'benchmark:false-intervention-rate').status).toBe('fail');
    expect(report.verdict).not.toBe('pass');
  });

  it('fails healthy-success silence for a regression, a false intervention, or any intervention', () => {
    const regression = updateSupervisorRun(
      passing100PairDataset(),
      (run) => ({ ...run, oracle: { ...run.oracle, taskSuccess: false } }),
      (run) => run.pairId.startsWith(healthyPairPrefix),
    );
    expect(gate(evaluateSupervisorBenchmark(regression), 'benchmark:healthy-success-silence').status).toBe('fail');

    const falseIntervention = updateSupervisorMetrics(
      passing100PairDataset(),
      (run) => ({
        ...run,
        metrics: { ...run.metrics, supervisorInterventions: 1, falseInterventions: 1 },
      }),
      (run) => run.pairId.startsWith(healthyPairPrefix),
    );
    expect(
      gate(evaluateSupervisorBenchmark(falseIntervention), 'benchmark:healthy-success-silence').status,
    ).toBe('fail');

    const intervention = updateSupervisorMetrics(
      passing100PairDataset(),
      (run) => ({ ...run, metrics: { ...run.metrics, supervisorInterventions: 1 } }),
      (run) => run.pairId.startsWith(healthyPairPrefix),
    );
    expect(gate(evaluateSupervisorBenchmark(intervention), 'benchmark:healthy-success-silence').status).toBe('fail');
  });

  it.each([
    ['benchmark:supervisor-fatal-failures', 'supervisorFatalFailures'],
    ['benchmark:persistence-privacy', 'rawToolOutputPersisted'],
    ['benchmark:continuation-bounds', 'automaticContinuationLimitViolations'],
  ] as const)('fails %s for one non-zero supervisor metric', (id, metric) => {
    const red = updateSupervisorMetrics(passing100PairDataset(), (run) => ({
      ...run,
      metrics: { ...run.metrics, [metric]: 1 },
    }));
    const report = evaluateSupervisorBenchmark(red);

    expect(gate(report, id).status).toBe('fail');
    expect(report.verdict).not.toBe('pass');
  });

  it('fails continuation bounds for one run with two automatic follow-ups', () => {
    const red = updateSupervisorMetrics(passing100PairDataset(), (run) => ({
      ...run,
      metrics: { ...run.metrics, automaticFollowUps: 2 },
    }));
    const report = evaluateSupervisorBenchmark(red);

    expect(gate(report, 'benchmark:continuation-bounds').status).toBe('fail');
  });

  it('fails the auxiliary-call bound when one run exceeds meaningful agent runs', () => {
    const red = updateSupervisorMetrics(passing100PairDataset(), (run) => ({
      ...run,
      metrics: { ...run.metrics, auxiliaryModelCalls: run.metrics.meaningfulAgentRuns + 1 },
    }));
    const report = evaluateSupervisorBenchmark(red);

    expect(gate(report, 'benchmark:auxiliary-call-bound').status).toBe('fail');
  });

  it('fails token and wall-clock overhead gates above their medians', () => {
    const tokenReport = evaluateSupervisorBenchmark(
      createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 8, supervisorTotalTokens: 120 }),
    );
    const wallReport = evaluateSupervisorBenchmark(
      createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 8, supervisorWallClockMs: 1_250 }),
    );

    expect(gate(tokenReport, 'benchmark:token-overhead').status).toBe('fail');
    expect(gate(wallReport, 'benchmark:wall-clock-overhead').status).toBe('fail');
  });

  it('returns insufficient-data for missing token or wall-clock measurements', () => {
    const tokenDataset = passing100PairDataset();
    const tokenRun = supervisorRun(tokenDataset);
    const tokenMissing = replaceSupervisorBenchmarkRun(
      tokenDataset,
      completedRunWithoutMeasurement(tokenRun, 'totalTokens'),
    );
    const wallDataset = passing100PairDataset();
    const wallRun = supervisorRun(wallDataset);
    const wallMissing = replaceSupervisorBenchmarkRun(
      wallDataset,
      completedRunWithoutMeasurement(wallRun, 'wallClockMs'),
    );

    const tokenReport = evaluateSupervisorBenchmark(tokenMissing);
    const wallReport = evaluateSupervisorBenchmark(wallMissing);
    expect(gate(tokenReport, 'benchmark:token-overhead').status).toBe('insufficient-data');
    expect(gate(wallReport, 'benchmark:wall-clock-overhead').status).toBe('insufficient-data');
    expect(tokenReport.overhead.tokenOverheadMedian).not.toBeNull();
    expect(wallReport.overhead.wallClockOverheadMedian).not.toBeNull();
  });

  it('returns insufficient-data when one run is an infrastructure error', () => {
    const dataset = createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 10 });
    const tiePairId = dataset.plan.expectedPairs[20]?.pairId;
    if (tiePairId === undefined) {
      throw new Error('Expected a tie pair in the synthetic fixture.');
    }
    const run = supervisorRun(dataset, (candidate) => candidate.pairId === tiePairId);
    const replacement: SupervisorBenchmarkInfrastructureErrorRun = {
      schemaVersion: 1,
      runId: run.runId,
      pairId: run.pairId,
      variant: 'supervisor',
      status: 'infrastructure-error',
      errorKind: 'provider',
    };
    const report = evaluateSupervisorBenchmark(replaceSupervisorBenchmarkRun(dataset, replacement));

    expect(gate(report, 'benchmark:data-completeness').status).toBe('insufficient-data');
    expect(report.coverage.infrastructureErrorRuns).toBe(1);
    expect(report.verdict).toBe('insufficient-data');
  });

  describe('coverage gates', () => {
    it('passes the positive two-family, three-repetition-per-cell control', () => {
      const report = evaluateSupervisorBenchmark(createSyntheticSupervisorBenchmarkDataset());
      expect(gate(report, 'benchmark:coverage').status).toBe('pass');
    });

    it('marks 59 complete pairs insufficient', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitionsFor: (scenarioClass, modelFamily) =>
            scenarioClass === SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses[0] &&
            modelFamily === 'family-b'
              ? 2
              : 3,
        }),
      );
      expect(report.coverage.completePairs).toBe(59);
      expect(gate(report, 'benchmark:coverage').status).toBe('insufficient-data');
    });

    it('marks one model family insufficient', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({ modelFamilies: ['family-a'], repetitions: 6 }),
      );
      expect(gate(report, 'benchmark:coverage').status).toBe('insufficient-data');
    });

    it('marks an absent required class insufficient', () => {
      const absentClass = SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses[0];
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          scenarioClasses: SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses.filter(
            (scenarioClass) => scenarioClass !== absentClass,
          ),
          repetitions: 4,
        }),
      );
      expect(gate(report, 'benchmark:coverage').status).toBe('insufficient-data');
    });

    it('marks a required class present in only one family insufficient', () => {
      const targetClass = SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses[0];
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitionsFor: (scenarioClass, modelFamily) =>
            scenarioClass === targetClass && modelFamily === 'family-b' ? 0 : 3,
        }),
      );
      expect(gate(report, 'benchmark:coverage').status).toBe('insufficient-data');
    });

    it('marks a second family with only two pairs insufficient', () => {
      const targetClass = SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses[0];
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitionsFor: (scenarioClass, modelFamily) =>
            scenarioClass === targetClass && modelFamily === 'family-b' ? 2 : 3,
        }),
      );
      expect(gate(report, 'benchmark:coverage').status).toBe('insufficient-data');
    });

    it('allows an additional model family without weakening coverage', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({ modelFamilies: ['family-a', 'family-b', 'family-c'] }),
      );
      expect(gate(report, 'benchmark:coverage').status).toBe('pass');
    });
  });

  describe('exact boundary gates', () => {
    it('passes exactly 80 percent repeated-failure reduction', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitions: 5,
          wins: 8,
          baselineRepeatedFailedInvocations: 10,
          supervisorRepeatedFailedInvocations: 2,
        }),
      );
      expect(gate(report, 'benchmark:repeated-failure-reduction').status).toBe('pass');
    });

    it('passes exactly 60 percent unsupported-completion and user-intervention reduction', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitions: 5,
          wins: 8,
          baselineUnsupportedCompletionClaims: 10,
          supervisorUnsupportedCompletionClaims: 4,
          baselineUserInterventions: 10,
          supervisorUserInterventions: 4,
        }),
      );
      expect(gate(report, 'benchmark:unsupported-completion-reduction').status).toBe('pass');
      expect(gate(report, 'benchmark:user-intervention-reduction').status).toBe('pass');
    });

    it('fails exactly five percent false-intervention rate because comparison is strict', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitions: 5,
          wins: 8,
          supervisorInterventionsPerRun: 2,
          falseInterventionRunCount: 9,
        }),
      );
      expect(report.outcomes.falseInterventions).toBe(9);
      expect(report.outcomes.supervisorInterventions).toBe(180);
      expect(gate(report, 'benchmark:false-intervention-rate').status).toBe('fail');
    });

    it('passes token and wall-clock medians exactly at their maximums', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({
          repetitions: 5,
          wins: 8,
          supervisorTotalTokens: 115,
          supervisorWallClockMs: 1_200,
        }),
      );
      expect(report.overhead.tokenOverheadMedian).toBe(0.15);
      expect(report.overhead.wallClockOverheadMedian).toBe(0.2);
      expect(gate(report, 'benchmark:token-overhead').status).toBe('pass');
      expect(gate(report, 'benchmark:wall-clock-overhead').status).toBe('pass');
    });

    it('passes exactly eight percentage points with significant paired wins', () => {
      const report = evaluateSupervisorBenchmark(
        createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 8 }),
      );
      expect(report.outcomes.successDeltaPercentagePoints).toBe(8);
      expect(report.outcomes.pairedSignTest.pValue).toBe(1 / 256);
      expect(gate(report, 'benchmark:task-success').status).toBe('pass');
    });
  });
});
