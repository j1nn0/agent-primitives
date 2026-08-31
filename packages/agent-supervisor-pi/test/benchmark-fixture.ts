import {
  SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1,
  computeSupervisorBenchmarkPlanFingerprint,
  validateSupervisorBenchmarkDataset,
} from '../src/index.js';
import type {
  SupervisorBenchmarkCompletedRun,
  SupervisorBenchmarkDatasetV1,
  SupervisorBenchmarkPlanV1,
  SupervisorBenchmarkRun,
} from '../src/index.js';
import {
  completedRun,
  expectedPair,
  metrics,
  validDataset,
} from './benchmark-helper.js';

export interface SyntheticBenchmarkFixtureOptions {
  readonly repetitions?: number;
  readonly scenarioClasses?: readonly string[];
  readonly modelFamilies?: readonly string[];
  readonly repetitionsFor?: (scenarioClass: string, modelFamily: string) => number;
  readonly wins?: number;
  readonly regressions?: number;
  readonly baselineRepeatedFailedInvocations?: number;
  readonly supervisorRepeatedFailedInvocations?: number;
  readonly baselineUnsupportedCompletionClaims?: number;
  readonly supervisorUnsupportedCompletionClaims?: number;
  readonly baselineUserInterventions?: number;
  readonly supervisorUserInterventions?: number;
  readonly supervisorInterventionsPerRun?: number;
  readonly falseInterventionRunCount?: number;
  readonly baselineTotalTokens?: number;
  readonly supervisorTotalTokens?: number;
  readonly baselineWallClockMs?: number;
  readonly supervisorWallClockMs?: number;
  readonly supervisorAutomaticFollowUps?: number;
  readonly supervisorAuxiliaryModelCalls?: number;
  readonly supervisorFatalFailures?: number;
  readonly rawToolOutputPersisted?: number;
  readonly automaticContinuationLimitViolations?: number;
  readonly policyId?: string;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function repetitionsFor(
  options: SyntheticBenchmarkFixtureOptions,
  scenarioClass: string,
  modelFamily: string,
): number {
  const repetitions = options.repetitionsFor?.(scenarioClass, modelFamily) ?? options.repetitions ?? 3;
  assertNonNegativeSafeInteger(repetitions, 'Repetitions');
  return repetitions;
}

function pairOutcome(
  scenarioClass: string,
  nonHealthyOrdinal: number,
  wins: number,
  regressions: number,
  healthySuccessSilenceClass: string,
): { readonly baselineSuccess: boolean; readonly supervisorSuccess: boolean } {
  if (scenarioClass === healthySuccessSilenceClass) {
    return { baselineSuccess: true, supervisorSuccess: true };
  }
  if (nonHealthyOrdinal < wins) {
    return { baselineSuccess: false, supervisorSuccess: true };
  }
  if (nonHealthyOrdinal < wins + regressions) {
    return { baselineSuccess: true, supervisorSuccess: false };
  }
  return { baselineSuccess: true, supervisorSuccess: true };
}

export function createSyntheticSupervisorBenchmarkDataset(
  options: SyntheticBenchmarkFixtureOptions = {},
): SupervisorBenchmarkDatasetV1 {
  const scenarioClasses = options.scenarioClasses ?? SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses;
  const modelFamilies = options.modelFamilies ?? ['family-a', 'family-b'];
  const wins = options.wins ?? 10;
  const regressions = options.regressions ?? 0;
  assertNonNegativeSafeInteger(wins, 'Wins');
  assertNonNegativeSafeInteger(regressions, 'Regressions');

  const baselineRepeatedFailedInvocations = options.baselineRepeatedFailedInvocations ?? 6;
  const supervisorRepeatedFailedInvocations = options.supervisorRepeatedFailedInvocations ?? 0;
  const baselineUnsupportedCompletionClaims = options.baselineUnsupportedCompletionClaims ?? 4;
  const supervisorUnsupportedCompletionClaims = options.supervisorUnsupportedCompletionClaims ?? 0;
  const baselineUserInterventions = options.baselineUserInterventions ?? 3;
  const supervisorUserInterventions = options.supervisorUserInterventions ?? 0;
  const supervisorInterventionsPerRun = options.supervisorInterventionsPerRun ?? 1;
  const falseInterventionRunCount = options.falseInterventionRunCount ?? 0;
  const baselineTotalTokens = options.baselineTotalTokens ?? 100;
  const supervisorTotalTokens = options.supervisorTotalTokens ?? 105;
  const baselineWallClockMs = options.baselineWallClockMs ?? 1_000;
  const supervisorWallClockMs = options.supervisorWallClockMs ?? 1_050;
  const supervisorAutomaticFollowUps = options.supervisorAutomaticFollowUps ?? 0;
  const supervisorAuxiliaryModelCalls = options.supervisorAuxiliaryModelCalls ?? 0;
  const supervisorFatalFailures = options.supervisorFatalFailures ?? 0;
  const rawToolOutputPersisted = options.rawToolOutputPersisted ?? 0;
  const automaticContinuationLimitViolations = options.automaticContinuationLimitViolations ?? 0;
  const expectedPairs: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  let pairOrdinal = 0;
  let nonHealthyOrdinal = 0;
  let supervisorInterventionRunOrdinal = 0;

  for (const scenarioClass of scenarioClasses) {
    for (const modelFamily of modelFamilies) {
      const repetitions = repetitionsFor(options, scenarioClass, modelFamily);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const pairId = `${scenarioClass}-${modelFamily}-${repetition}`;
        const pair = expectedPair(pairId, {
          scenarioClass,
          scenarioId: `${scenarioClass}-scenario`,
          caseId: `${scenarioClass}-case-${modelFamily}-${repetition}`,
          modelFamily,
          modelId: modelFamily === 'family-a' ? 'openai-codex/gpt-5.6-luna' : 'anthropic/claude-opus-5',
          executionProfile: 'default',
          repetition,
        });
        expectedPairs.push(pair);

        const outcome = pairOutcome(
          scenarioClass,
          nonHealthyOrdinal,
          wins,
          regressions,
          SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.healthySuccessSilenceClass,
        );
        if (scenarioClass !== SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.healthySuccessSilenceClass) {
          nonHealthyOrdinal += 1;
        }

        const supervisorInterventions =
          scenarioClass === SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.healthySuccessSilenceClass
            ? 0
            : supervisorInterventionsPerRun;
        if (supervisorInterventions > 0) {
          supervisorInterventionRunOrdinal += 1;
        }
        const falseInterventions =
          supervisorInterventionRunOrdinal > 0 &&
          supervisorInterventionRunOrdinal <= falseInterventionRunCount
            ? 1
            : 0;

        runs.push(
          completedRun('baseline', pairId, `${pairId}-baseline`, {
            oracle: { kind: 'deterministic', taskSuccess: outcome.baselineSuccess },
            metrics: metrics({
              repeatedFailedInvocations: baselineRepeatedFailedInvocations,
              unsupportedCompletionClaims: baselineUnsupportedCompletionClaims,
              userInterventions: baselineUserInterventions,
              totalTokens: baselineTotalTokens,
              wallClockMs: baselineWallClockMs,
            }),
          }),
          completedRun('supervisor', pairId, `${pairId}-supervisor`, {
            oracle: { kind: 'deterministic', taskSuccess: outcome.supervisorSuccess },
            metrics: metrics({
              repeatedFailedInvocations: supervisorRepeatedFailedInvocations,
              unsupportedCompletionClaims: supervisorUnsupportedCompletionClaims,
              userInterventions: supervisorUserInterventions,
              supervisorInterventions,
              falseInterventions,
              automaticFollowUps: supervisorAutomaticFollowUps,
              auxiliaryModelCalls: supervisorAuxiliaryModelCalls,
              supervisorFatalFailures,
              rawToolOutputPersisted,
              automaticContinuationLimitViolations,
              totalTokens: supervisorTotalTokens,
              wallClockMs: supervisorWallClockMs,
            }),
          }),
        );
        pairOrdinal += 1;
      }
    }
  }

  // Referencing the ordinal keeps the pair construction visibly one-to-one with the plan.
  if (pairOrdinal !== expectedPairs.length) {
    throw new RangeError('Synthetic fixture pair construction is inconsistent.');
  }
  const planValue = {
    schemaVersion: 1,
    benchmarkId: 'supervisor-release-benchmark',
    sourceSha: 'b'.repeat(40),
    policyId: options.policyId ?? SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.policyId,
    expectedPairs,
  };
  return validateSupervisorBenchmarkDataset(validDataset(planValue, runs));
}

export const createPassingSupervisorBenchmarkDataset = createSyntheticSupervisorBenchmarkDataset;

export function replaceSupervisorBenchmarkRun(
  dataset: SupervisorBenchmarkDatasetV1,
  replacement: SupervisorBenchmarkRun,
): SupervisorBenchmarkDatasetV1 {
  let replaced = false;
  const runs = dataset.runs.map((run) => {
    if (run.runId !== replacement.runId) {
      return run;
    }
    replaced = true;
    return replacement;
  });
  if (!replaced) {
    throw new RangeError('Synthetic fixture run was not found.');
  }
  return { ...dataset, runs };
}

export function replaceSupervisorBenchmarkPlan(
  dataset: SupervisorBenchmarkDatasetV1,
  plan: SupervisorBenchmarkPlanV1,
): SupervisorBenchmarkDatasetV1 {
  return {
    ...dataset,
    plan,
    planFingerprint: computeSupervisorBenchmarkPlanFingerprint(plan),
  };
}

export function completedRunWithoutMeasurement(
  run: SupervisorBenchmarkCompletedRun,
  measurement: 'totalTokens' | 'wallClockMs',
): SupervisorBenchmarkCompletedRun {
  const updatedMetrics = { ...run.metrics };
  delete updatedMetrics[measurement];
  return { ...run, metrics: updatedMetrics };
}
