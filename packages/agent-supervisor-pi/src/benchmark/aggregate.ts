import { indexSupervisorBenchmarkPairs } from './pairing.js';
import {
  compareRationals,
  computeExactPairedSignTest,
  computePairwiseOverhead,
  medianRational,
  type SupervisorBenchmarkExactPairedSignTest,
  type SupervisorBenchmarkRational,
} from './statistics.js';
import type { SupervisorBenchmarkDatasetV1 } from './types.js';

export interface SupervisorBenchmarkScenarioAggregate {
  readonly scenarioClass: string;
  readonly completePairs: number;
  readonly modelFamilyCounts: Readonly<Record<string, number>>;
  readonly regressions: number;
  readonly falseInterventions: number;
  readonly supervisorInterventions: number;
}

export interface SupervisorBenchmarkAggregate {
  readonly totalPlannedPairs: number;
  readonly completePairs: number;
  readonly infrastructureErrorPairs: number;
  readonly infrastructureErrorRuns: number;

  readonly wins: number;
  readonly regressions: number;
  readonly ties: number;
  readonly baselineSuccesses: number;
  readonly supervisorSuccesses: number;
  readonly baselineSuccessRate: number;
  readonly supervisorSuccessRate: number;
  readonly successDeltaPercentagePoints: number;
  readonly pairedSignTest: SupervisorBenchmarkExactPairedSignTest;

  readonly baselineRepeatedFailedInvocations: number;
  readonly supervisorRepeatedFailedInvocations: number;
  readonly baselineUnsupportedCompletionClaims: number;
  readonly supervisorUnsupportedCompletionClaims: number;
  readonly baselineUserInterventions: number;
  readonly supervisorUserInterventions: number;

  readonly supervisorInterventions: number;
  readonly falseInterventions: number;
  readonly supervisorFatalFailures: number;
  readonly rawToolOutputPersisted: number;
  readonly automaticContinuationLimitViolations: number;
  readonly automaticFollowUpBoundViolations: number;
  readonly auxiliaryModelCallBoundViolations: number;

  readonly modelFamilies: readonly string[];
  readonly scenarioClasses: readonly SupervisorBenchmarkScenarioAggregate[];

  readonly tokenOverheadSamples: readonly SupervisorBenchmarkRational[];
  readonly wallClockOverheadSamples: readonly SupervisorBenchmarkRational[];
  readonly missingTokenSamples: number;
  readonly missingWallClockSamples: number;
  readonly tokenOverheadMedian?: SupervisorBenchmarkRational;
  readonly wallClockOverheadMedian?: SupervisorBenchmarkRational;
}

interface ScenarioAccumulator {
  readonly scenarioClass: string;
  completePairs: number;
  readonly modelFamilyCounts: Map<string, number>;
  regressions: number;
  falseInterventions: number;
  supervisorInterventions: number;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createScenarioAccumulator(scenarioClass: string): ScenarioAccumulator {
  return {
    scenarioClass,
    completePairs: 0,
    modelFamilyCounts: new Map<string, number>(),
    regressions: 0,
    falseInterventions: 0,
    supervisorInterventions: 0,
  };
}

function scenarioAggregates(
  accumulators: ReadonlyMap<string, ScenarioAccumulator>,
): readonly SupervisorBenchmarkScenarioAggregate[] {
  return [...accumulators.values()]
    .sort((left, right) => compareStrings(left.scenarioClass, right.scenarioClass))
    .map((accumulator) => {
      const modelFamilyCounts = Object.fromEntries(
        [...accumulator.modelFamilyCounts.entries()].sort(([left], [right]) =>
          compareStrings(left, right),
        ),
      );
      return {
        scenarioClass: accumulator.scenarioClass,
        completePairs: accumulator.completePairs,
        modelFamilyCounts,
        regressions: accumulator.regressions,
        falseInterventions: accumulator.falseInterventions,
        supervisorInterventions: accumulator.supervisorInterventions,
      };
    });
}

export function aggregateSupervisorBenchmarkDataset(
  dataset: SupervisorBenchmarkDatasetV1,
): SupervisorBenchmarkAggregate {
  const indexed = indexSupervisorBenchmarkPairs(dataset);
  const infrastructureErrorRuns = dataset.runs.filter(
    (run) => run.status === 'infrastructure-error',
  ).length;

  let wins = 0;
  let regressions = 0;
  let ties = 0;
  let baselineSuccesses = 0;
  let supervisorSuccesses = 0;

  let baselineRepeatedFailedInvocations = 0;
  let supervisorRepeatedFailedInvocations = 0;
  let baselineUnsupportedCompletionClaims = 0;
  let supervisorUnsupportedCompletionClaims = 0;
  let baselineUserInterventions = 0;
  let supervisorUserInterventions = 0;

  let supervisorInterventions = 0;
  let falseInterventions = 0;
  let supervisorFatalFailures = 0;
  let rawToolOutputPersisted = 0;
  let automaticContinuationLimitViolations = 0;
  let automaticFollowUpBoundViolations = 0;
  let auxiliaryModelCallBoundViolations = 0;

  const modelFamilies = new Set<string>();
  const scenarioAccumulators = new Map<string, ScenarioAccumulator>();
  // Seed from the plan so a class with only infrastructure failures remains visible at zero.
  for (const expectedPair of dataset.plan.expectedPairs) {
    if (!scenarioAccumulators.has(expectedPair.scenarioClass)) {
      scenarioAccumulators.set(
        expectedPair.scenarioClass,
        createScenarioAccumulator(expectedPair.scenarioClass),
      );
    }
  }
  const tokenOverheadSamples: SupervisorBenchmarkRational[] = [];
  const wallClockOverheadSamples: SupervisorBenchmarkRational[] = [];
  let missingTokenSamples = 0;
  let missingWallClockSamples = 0;

  for (const pair of indexed.pairs) {
    if (!pair.complete) {
      continue;
    }
    if (pair.baselineRun.status !== 'completed' || pair.supervisorRun.status !== 'completed') {
      continue;
    }

    const baselineMetrics = pair.baselineRun.metrics;
    const supervisorMetrics = pair.supervisorRun.metrics;
    const baselineSuccess = pair.baselineRun.oracle.taskSuccess;
    const supervisorSuccess = pair.supervisorRun.oracle.taskSuccess;
    if (baselineSuccess) {
      baselineSuccesses += 1;
    }
    if (supervisorSuccess) {
      supervisorSuccesses += 1;
    }

    const scenarioClass = pair.expectedPair.scenarioClass;
    const modelFamily = pair.expectedPair.modelFamily;
    modelFamilies.add(modelFamily);
    let scenario = scenarioAccumulators.get(scenarioClass);
    if (scenario === undefined) {
      scenario = createScenarioAccumulator(scenarioClass);
      scenarioAccumulators.set(scenarioClass, scenario);
    }
    scenario.completePairs += 1;
    scenario.modelFamilyCounts.set(
      modelFamily,
      (scenario.modelFamilyCounts.get(modelFamily) ?? 0) + 1,
    );

    if (!baselineSuccess && supervisorSuccess) {
      wins += 1;
    } else if (baselineSuccess && !supervisorSuccess) {
      regressions += 1;
      scenario.regressions += 1;
    } else {
      ties += 1;
    }

    baselineRepeatedFailedInvocations += baselineMetrics.repeatedFailedInvocations;
    supervisorRepeatedFailedInvocations += supervisorMetrics.repeatedFailedInvocations;
    baselineUnsupportedCompletionClaims += baselineMetrics.unsupportedCompletionClaims;
    supervisorUnsupportedCompletionClaims += supervisorMetrics.unsupportedCompletionClaims;
    baselineUserInterventions += baselineMetrics.userInterventions;
    supervisorUserInterventions += supervisorMetrics.userInterventions;

    supervisorInterventions += supervisorMetrics.supervisorInterventions;
    falseInterventions += supervisorMetrics.falseInterventions;
    supervisorFatalFailures += supervisorMetrics.supervisorFatalFailures;
    rawToolOutputPersisted += supervisorMetrics.rawToolOutputPersisted;
    automaticContinuationLimitViolations += supervisorMetrics.automaticContinuationLimitViolations;
    if (supervisorMetrics.automaticFollowUps > 1) {
      automaticFollowUpBoundViolations += 1;
    }
    if (supervisorMetrics.auxiliaryModelCalls > supervisorMetrics.meaningfulAgentRuns) {
      auxiliaryModelCallBoundViolations += 1;
    }
    scenario.falseInterventions += supervisorMetrics.falseInterventions;
    scenario.supervisorInterventions += supervisorMetrics.supervisorInterventions;

    const baselineTotalTokens = baselineMetrics.totalTokens;
    const supervisorTotalTokens = supervisorMetrics.totalTokens;
    if (
      baselineTotalTokens === undefined ||
      supervisorTotalTokens === undefined ||
      baselineTotalTokens <= 0
    ) {
      missingTokenSamples += 1;
    } else {
      tokenOverheadSamples.push(
        computePairwiseOverhead(baselineTotalTokens, supervisorTotalTokens),
      );
    }

    const baselineWallClockMs = baselineMetrics.wallClockMs;
    const supervisorWallClockMs = supervisorMetrics.wallClockMs;
    if (
      baselineWallClockMs === undefined ||
      supervisorWallClockMs === undefined ||
      baselineWallClockMs <= 0
    ) {
      missingWallClockSamples += 1;
    } else {
      wallClockOverheadSamples.push(
        computePairwiseOverhead(baselineWallClockMs, supervisorWallClockMs),
      );
    }
  }

  const sortedTokenOverheadSamples = tokenOverheadSamples.sort(compareRationals);
  const sortedWallClockOverheadSamples = wallClockOverheadSamples.sort(compareRationals);
  const tokenOverheadMedian = medianRational(sortedTokenOverheadSamples);
  const wallClockOverheadMedian = medianRational(sortedWallClockOverheadSamples);
  const completePairs = indexed.completePairs;
  const baselineSuccessRate = completePairs === 0 ? 0 : baselineSuccesses / completePairs;
  const supervisorSuccessRate = completePairs === 0 ? 0 : supervisorSuccesses / completePairs;
  const successDeltaPercentagePoints =
    completePairs === 0 ? 0 : (100 * (supervisorSuccesses - baselineSuccesses)) / completePairs;

  return {
    totalPlannedPairs: indexed.totalPlannedPairs,
    completePairs,
    infrastructureErrorPairs: indexed.infrastructureErrorPairs,
    infrastructureErrorRuns,
    wins,
    regressions,
    ties,
    baselineSuccesses,
    supervisorSuccesses,
    baselineSuccessRate,
    supervisorSuccessRate,
    successDeltaPercentagePoints,
    pairedSignTest: computeExactPairedSignTest(wins, regressions),
    baselineRepeatedFailedInvocations,
    supervisorRepeatedFailedInvocations,
    baselineUnsupportedCompletionClaims,
    supervisorUnsupportedCompletionClaims,
    baselineUserInterventions,
    supervisorUserInterventions,
    supervisorInterventions,
    falseInterventions,
    supervisorFatalFailures,
    rawToolOutputPersisted,
    automaticContinuationLimitViolations,
    automaticFollowUpBoundViolations,
    auxiliaryModelCallBoundViolations,
    modelFamilies: [...modelFamilies].sort(compareStrings),
    scenarioClasses: scenarioAggregates(scenarioAccumulators),
    tokenOverheadSamples: sortedTokenOverheadSamples,
    wallClockOverheadSamples: sortedWallClockOverheadSamples,
    missingTokenSamples,
    missingWallClockSamples,
    ...(tokenOverheadMedian === undefined ? {} : { tokenOverheadMedian }),
    ...(wallClockOverheadMedian === undefined ? {} : { wallClockOverheadMedian }),
  };
}
