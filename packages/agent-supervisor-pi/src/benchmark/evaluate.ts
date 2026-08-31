import { SupervisorContractError } from '../errors.js';
import { assertJsonValue, type JsonValue } from '../json.js';
import {
  aggregateSupervisorBenchmarkDataset,
  type SupervisorBenchmarkAggregate,
  type SupervisorBenchmarkScenarioAggregate,
} from './aggregate.js';
import {
  computeReductionRatio,
  rationalMeetsThreshold,
  reductionMeetsThreshold,
  rationalToNumber,
  type SupervisorBenchmarkExactPairedSignTest,
  type SupervisorBenchmarkRational,
} from './statistics.js';
import {
  SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1,
  type SupervisorBenchmarkRatioThreshold,
  type SupervisorReleaseBenchmarkPolicyV1,
} from './policy.js';
import { validateSupervisorBenchmarkDataset } from './validate.js';
import type { SupervisorBenchmarkDatasetV1, SupervisorBenchmarkRun } from './types.js';

export type SupervisorBenchmarkGateStatus = 'pass' | 'fail' | 'insufficient-data';
export type SupervisorBenchmarkVerdict = 'pass' | 'fail' | 'insufficient-data';

export interface SupervisorBenchmarkGateResult {
  readonly id: string;
  readonly status: SupervisorBenchmarkGateStatus;
  readonly observed: JsonValue;
  readonly required: JsonValue;
}

export interface SupervisorBenchmarkScenarioCoverageReport {
  readonly scenarioClass: string;
  readonly completePairs: number;
  readonly modelFamilyCounts: Readonly<Record<string, number>>;
  readonly regressions: number;
  readonly falseInterventions: number;
  readonly supervisorInterventions: number;
}

export interface SupervisorBenchmarkCoverageReport {
  readonly totalPlannedPairs: number;
  readonly completePairs: number;
  readonly infrastructureErrorPairs: number;
  readonly infrastructureErrorRuns: number;
  readonly modelFamilies: readonly string[];
  readonly scenarioClasses: readonly SupervisorBenchmarkScenarioCoverageReport[];
}

export interface SupervisorBenchmarkSignTestReport {
  readonly status: 'computed' | 'no-discordance';
  readonly discordantPairs: number;
  readonly pValue: number | null;
  readonly significant: boolean | null;
}

export interface SupervisorBenchmarkOutcomesReport {
  readonly wins: number;
  readonly regressions: number;
  readonly ties: number;
  readonly baselineSuccesses: number;
  readonly supervisorSuccesses: number;
  readonly baselineSuccessRate: number;
  readonly supervisorSuccessRate: number;
  readonly successDeltaPercentagePoints: number;
  readonly pairedSignTest: SupervisorBenchmarkSignTestReport;
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
}

export interface SupervisorBenchmarkOverheadReport {
  readonly tokenOverheadSamples: readonly number[];
  readonly wallClockOverheadSamples: readonly number[];
  readonly tokenOverheadMedian: number | null;
  readonly wallClockOverheadMedian: number | null;
  readonly missingTokenSamples: number;
  readonly missingWallClockSamples: number;
}

export interface SupervisorBenchmarkReportV1 {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly planFingerprint: string;
  readonly verdict: SupervisorBenchmarkVerdict;
  readonly coverage: SupervisorBenchmarkCoverageReport;
  readonly outcomes: SupervisorBenchmarkOutcomesReport;
  readonly overhead: SupervisorBenchmarkOverheadReport;
  readonly gates: readonly SupervisorBenchmarkGateResult[];
}

function ratioJson(threshold: SupervisorBenchmarkRatioThreshold): JsonValue {
  return { numerator: threshold.numerator, denominator: threshold.denominator };
}

function reductionJson(
  baselineTotal: number,
  supervisorTotal: number,
): JsonValue {
  const reduction = computeReductionRatio(baselineTotal, supervisorTotal);
  return reduction.status === 'available' ? reduction.ratio : null;
}

function exactPercentagePointsMeetThreshold(
  completePairs: number,
  baselineSuccesses: number,
  supervisorSuccesses: number,
  minimumPercentagePoints: number,
): boolean {
  if (completePairs <= 0) {
    return false;
  }
  return (
    100n * BigInt(supervisorSuccesses - baselineSuccesses) >=
    BigInt(minimumPercentagePoints) * BigInt(completePairs)
  );
}

function exactRateIsStrictlyBelowThreshold(
  count: number,
  denominator: number,
  threshold: SupervisorBenchmarkRatioThreshold,
): boolean {
  if (denominator === 0) {
    return count === 0;
  }
  return (
    BigInt(count) * BigInt(threshold.denominator) <
    BigInt(threshold.numerator) * BigInt(denominator)
  );
}

function signTestReport(
  signTest: SupervisorBenchmarkExactPairedSignTest,
): SupervisorBenchmarkSignTestReport {
  if (signTest.status === 'no-discordance') {
    return {
      status: signTest.status,
      discordantPairs: 0,
      pValue: null,
      significant: null,
    };
  }
  return {
    status: signTest.status,
    discordantPairs: signTest.discordantPairs,
    pValue: signTest.pValue,
    significant: signTest.significant,
  };
}

function signTestJson(signTest: SupervisorBenchmarkExactPairedSignTest): JsonValue {
  const report = signTestReport(signTest);
  return {
    status: report.status,
    discordantPairs: report.discordantPairs,
    pValue: report.pValue,
    significant: report.significant,
  };
}

function scenarioCoverage(
  scenario: SupervisorBenchmarkScenarioAggregate | undefined,
  scenarioClass: string,
  policy: SupervisorReleaseBenchmarkPolicyV1,
): JsonValue {
  const modelFamilyCounts = scenario === undefined ? {} : { ...scenario.modelFamilyCounts };
  const qualifyingModelFamilies = Object.entries(modelFamilyCounts)
    .filter(([, count]) => count >= policy.coverage.minimumPairsPerRequiredClassFamily)
    .map(([modelFamily]) => modelFamily);
  return {
    scenarioClass,
    present: scenario !== undefined,
    completePairs: scenario?.completePairs ?? 0,
    modelFamilyCounts,
    qualifyingModelFamilies,
    qualifyingFamilyCount: qualifyingModelFamilies.length,
  };
}

function coverageGate(
  aggregate: SupervisorBenchmarkAggregate,
  policy: SupervisorReleaseBenchmarkPolicyV1,
): SupervisorBenchmarkGateResult {
  const requiredClasses = policy.requiredScenarioClasses.map((scenarioClass) => {
    const scenario = aggregate.scenarioClasses.find(
      (candidate) => candidate.scenarioClass === scenarioClass,
    );
    return scenarioCoverage(scenario, scenarioClass, policy);
  });
  /*
   * Requiring two qualifying families in every class produces the documented
   * 10 classes × 2 families × 3 pairs = 60 minimum. Extra families contribute
   * evidence when they qualify; a family with only one or two pairs does not
   * break an otherwise qualifying class.
   */
  const classCoverage = policy.requiredScenarioClasses.every((scenarioClass) => {
    const scenario = aggregate.scenarioClasses.find(
      (candidate) => candidate.scenarioClass === scenarioClass,
    );
    if (scenario === undefined) {
      return false;
    }
    const qualifyingFamilies = Object.values(scenario.modelFamilyCounts).filter(
      (count) => count >= policy.coverage.minimumPairsPerRequiredClassFamily,
    ).length;
    return qualifyingFamilies >= policy.coverage.minimumFamiliesPerRequiredClass;
  });
  const status =
    aggregate.completePairs >= policy.coverage.minimumCompletePairs &&
    aggregate.modelFamilies.length >= policy.coverage.minimumModelFamilies &&
    classCoverage
      ? 'pass'
      : 'insufficient-data';
  return {
    id: 'benchmark:coverage',
    status,
    observed: {
      completePairs: aggregate.completePairs,
      modelFamilies: [...aggregate.modelFamilies],
      modelFamilyCount: aggregate.modelFamilies.length,
      requiredScenarioClasses: requiredClasses,
    },
    required: {
      minimumCompletePairs: policy.coverage.minimumCompletePairs,
      minimumModelFamilies: policy.coverage.minimumModelFamilies,
      minimumFamiliesPerRequiredClass: policy.coverage.minimumFamiliesPerRequiredClass,
      minimumPairsPerRequiredClassFamily: policy.coverage.minimumPairsPerRequiredClassFamily,
      requiredScenarioClasses: [...policy.requiredScenarioClasses],
    },
  };
}

function dataCompletenessGate(
  aggregate: SupervisorBenchmarkAggregate,
): SupervisorBenchmarkGateResult {
  const complete =
    aggregate.infrastructureErrorRuns === 0 &&
    aggregate.infrastructureErrorPairs === 0 &&
    aggregate.completePairs === aggregate.totalPlannedPairs;
  return {
    id: 'benchmark:data-completeness',
    status: complete ? 'pass' : 'insufficient-data',
    observed: {
      totalPlannedPairs: aggregate.totalPlannedPairs,
      completePairs: aggregate.completePairs,
      infrastructureErrorPairs: aggregate.infrastructureErrorPairs,
      infrastructureErrorRuns: aggregate.infrastructureErrorRuns,
    },
    required: {
      completePairs: aggregate.totalPlannedPairs,
      infrastructureErrorPairs: 0,
      infrastructureErrorRuns: 0,
    },
  };
}

function taskSuccessGate(
  aggregate: SupervisorBenchmarkAggregate,
  policy: SupervisorReleaseBenchmarkPolicyV1,
): SupervisorBenchmarkGateResult {
  const signTest = aggregate.pairedSignTest;
  const hasSufficientPairs = aggregate.completePairs > 0;
  const hasEffect = exactPercentagePointsMeetThreshold(
    aggregate.completePairs,
    aggregate.baselineSuccesses,
    aggregate.supervisorSuccesses,
    policy.minimumSuccessDeltaPercentagePoints,
  );
  const hasDirectionalWins = aggregate.wins > aggregate.regressions;
  const hasSignificance = signTest.status === 'computed' && signTest.significant;
  const passes = hasSufficientPairs && hasEffect && hasDirectionalWins && hasSignificance;
  return {
    id: 'benchmark:task-success',
    status: hasSufficientPairs ? (passes ? 'pass' : 'fail') : 'insufficient-data',
    observed: {
      completePairs: aggregate.completePairs,
      baselineSuccesses: aggregate.baselineSuccesses,
      supervisorSuccesses: aggregate.supervisorSuccesses,
      successDeltaPercentagePoints: aggregate.successDeltaPercentagePoints,
      wins: aggregate.wins,
      regressions: aggregate.regressions,
      pairedSignTest: signTestJson(signTest),
    },
    required: {
      minimumSuccessDeltaPercentagePoints: policy.minimumSuccessDeltaPercentagePoints,
      requireMoreWinsThanRegressions: true,
      significanceThreshold: ratioJson(policy.significanceThreshold),
    },
  };
}

function reductionGate(
  id: string,
  baselineTotal: number,
  supervisorTotal: number,
  threshold: SupervisorBenchmarkRatioThreshold,
  minimumProblemExposure: number,
): SupervisorBenchmarkGateResult {
  const sufficientExposure = baselineTotal >= minimumProblemExposure;
  const passes =
    sufficientExposure &&
    reductionMeetsThreshold(baselineTotal, supervisorTotal, threshold.numerator, threshold.denominator);
  return {
    id,
    status: sufficientExposure ? (passes ? 'pass' : 'fail') : 'insufficient-data',
    observed: {
      baselineTotal,
      supervisorTotal,
      reduction: reductionJson(baselineTotal, supervisorTotal),
    },
    required: {
      minimumProblemExposure,
      minimumReduction: ratioJson(threshold),
    },
  };
}

function falseInterventionGate(
  aggregate: SupervisorBenchmarkAggregate,
  policy: SupervisorReleaseBenchmarkPolicyV1,
): SupervisorBenchmarkGateResult {
  const passes = exactRateIsStrictlyBelowThreshold(
    aggregate.falseInterventions,
    aggregate.supervisorInterventions,
    policy.maximumFalseInterventionRate,
  );
  const observedRate =
    aggregate.supervisorInterventions === 0
      ? 0
      : aggregate.falseInterventions / aggregate.supervisorInterventions;
  return {
    id: 'benchmark:false-intervention-rate',
    status: passes ? 'pass' : 'fail',
    observed: {
      falseInterventions: aggregate.falseInterventions,
      supervisorInterventions: aggregate.supervisorInterventions,
      falseInterventionRate: observedRate,
    },
    required: {
      maximumFalseInterventionRate: ratioJson(policy.maximumFalseInterventionRate),
      comparison: 'strictly-below',
    },
  };
}

function healthySuccessSilenceGate(
  aggregate: SupervisorBenchmarkAggregate,
  policy: SupervisorReleaseBenchmarkPolicyV1,
): SupervisorBenchmarkGateResult {
  const scenario = aggregate.scenarioClasses.find(
    (candidate) => candidate.scenarioClass === policy.healthySuccessSilenceClass,
  );
  const hasData = scenario !== undefined && scenario.completePairs > 0;
  const passes =
    hasData &&
    scenario.regressions === 0 &&
    scenario.falseInterventions === 0 &&
    scenario.supervisorInterventions === 0;
  return {
    id: 'benchmark:healthy-success-silence',
    status: hasData ? (passes ? 'pass' : 'fail') : 'insufficient-data',
    observed: {
      scenarioClass: policy.healthySuccessSilenceClass,
      completePairs: scenario?.completePairs ?? 0,
      regressions: scenario?.regressions ?? 0,
      falseInterventions: scenario?.falseInterventions ?? 0,
      supervisorInterventions: scenario?.supervisorInterventions ?? 0,
    },
    required: {
      regressions: 0,
      falseInterventions: 0,
      supervisorInterventions: 0,
    },
  };
}

function zeroCountGate(
  id: string,
  observedCount: number,
  observedName: string,
  requiredName: string,
): SupervisorBenchmarkGateResult {
  return {
    id,
    status: observedCount === 0 ? 'pass' : 'fail',
    observed: { [observedName]: observedCount },
    required: { [requiredName]: 0 },
  };
}

function countAutomaticFollowUpBoundViolations(
  dataset: SupervisorBenchmarkDatasetV1,
  maximumAutomaticFollowUpsPerRun: number,
): number {
  return dataset.runs.filter(
    (run: SupervisorBenchmarkRun) =>
      run.status === 'completed' &&
      run.variant === 'supervisor' &&
      run.metrics.automaticFollowUps > maximumAutomaticFollowUpsPerRun,
  ).length;
}
function continuationBoundsGate(
  aggregate: SupervisorBenchmarkAggregate,
  automaticFollowUpBoundViolations: number,
  policy: SupervisorReleaseBenchmarkPolicyV1,
): SupervisorBenchmarkGateResult {
  const violations =
    aggregate.automaticContinuationLimitViolations + automaticFollowUpBoundViolations;
  return {
    id: 'benchmark:continuation-bounds',
    status: violations === 0 ? 'pass' : 'fail',
    observed: {
      automaticContinuationLimitViolations: aggregate.automaticContinuationLimitViolations,
      automaticFollowUpBoundViolations,
    },
    required: {
      automaticContinuationLimitViolations: 0,
      automaticFollowUpBoundViolations: 0,
      maximumAutomaticFollowUpsPerRun: policy.maximumAutomaticFollowUpsPerRun,
    },
  };
}

function overheadGate(
  id: string,
  samples: readonly SupervisorBenchmarkRational[],
  median: SupervisorBenchmarkRational | undefined,
  missingSamples: number,
  threshold: SupervisorBenchmarkRatioThreshold,
  sampleName: string,
  medianName: string,
): SupervisorBenchmarkGateResult {
  const hasUsableData = missingSamples === 0 && samples.length > 0 && median !== undefined;
  const passes = hasUsableData && rationalMeetsThreshold(
    median,
    threshold.numerator,
    threshold.denominator,
  );
  return {
    id,
    status: hasUsableData ? (passes ? 'pass' : 'fail') : 'insufficient-data',
    observed: {
      [sampleName]: samples.map(rationalToNumber),
      sampleCount: samples.length,
      missingSamples,
      [medianName]: median === undefined ? null : rationalToNumber(median),
    },
    required: {
      maximumOverhead: ratioJson(threshold),
      missingSamples: 0,
    },
  };
}

function gateForId(
  id: string,
  aggregate: SupervisorBenchmarkAggregate,
  policy: SupervisorReleaseBenchmarkPolicyV1,
  automaticFollowUpBoundViolations: number,
): SupervisorBenchmarkGateResult {
  switch (id) {
    case 'benchmark:data-completeness':
      return dataCompletenessGate(aggregate);
    case 'benchmark:coverage':
      return coverageGate(aggregate, policy);
    case 'benchmark:task-success':
      return taskSuccessGate(aggregate, policy);
    case 'benchmark:repeated-failure-reduction':
      return reductionGate(
        id,
        aggregate.baselineRepeatedFailedInvocations,
        aggregate.supervisorRepeatedFailedInvocations,
        policy.reductions.repeatedFailedInvocations,
        policy.minimumProblemExposure,
      );
    case 'benchmark:unsupported-completion-reduction':
      return reductionGate(
        id,
        aggregate.baselineUnsupportedCompletionClaims,
        aggregate.supervisorUnsupportedCompletionClaims,
        policy.reductions.unsupportedCompletionClaims,
        policy.minimumProblemExposure,
      );
    case 'benchmark:user-intervention-reduction':
      return reductionGate(
        id,
        aggregate.baselineUserInterventions,
        aggregate.supervisorUserInterventions,
        policy.reductions.userInterventions,
        policy.minimumProblemExposure,
      );
    case 'benchmark:false-intervention-rate':
      return falseInterventionGate(aggregate, policy);
    case 'benchmark:healthy-success-silence':
      return healthySuccessSilenceGate(aggregate, policy);
    case 'benchmark:supervisor-fatal-failures':
      return zeroCountGate(
        id,
        aggregate.supervisorFatalFailures,
        'supervisorFatalFailures',
        'supervisorFatalFailures',
      );
    case 'benchmark:persistence-privacy':
      return zeroCountGate(id, aggregate.rawToolOutputPersisted, 'rawToolOutputPersisted', 'rawToolOutputPersisted');
    case 'benchmark:continuation-bounds':
      return continuationBoundsGate(aggregate, automaticFollowUpBoundViolations, policy);
    case 'benchmark:auxiliary-call-bound':
      return zeroCountGate(
        id,
        aggregate.auxiliaryModelCallBoundViolations,
        'auxiliaryModelCallBoundViolations',
        'auxiliaryModelCallBoundViolations',
      );
    case 'benchmark:token-overhead':
      return overheadGate(
        id,
        aggregate.tokenOverheadSamples,
        aggregate.tokenOverheadMedian,
        aggregate.missingTokenSamples,
        policy.overhead.maximumTokenOverhead,
        'tokenOverheadSamples',
        'tokenOverheadMedian',
      );
    case 'benchmark:wall-clock-overhead':
      return overheadGate(
        id,
        aggregate.wallClockOverheadSamples,
        aggregate.wallClockOverheadMedian,
        aggregate.missingWallClockSamples,
        policy.overhead.maximumWallClockOverhead,
        'wallClockOverheadSamples',
        'wallClockOverheadMedian',
      );
    default:
      throw new SupervisorContractError('invalid_benchmark_dataset', 'Unknown benchmark gate.');
  }
}

function coverageReport(
  aggregate: SupervisorBenchmarkAggregate,
): SupervisorBenchmarkCoverageReport {
  return {
    totalPlannedPairs: aggregate.totalPlannedPairs,
    completePairs: aggregate.completePairs,
    infrastructureErrorPairs: aggregate.infrastructureErrorPairs,
    infrastructureErrorRuns: aggregate.infrastructureErrorRuns,
    modelFamilies: [...aggregate.modelFamilies],
    scenarioClasses: aggregate.scenarioClasses.map((scenario) => ({
      scenarioClass: scenario.scenarioClass,
      completePairs: scenario.completePairs,
      modelFamilyCounts: { ...scenario.modelFamilyCounts },
      regressions: scenario.regressions,
      falseInterventions: scenario.falseInterventions,
      supervisorInterventions: scenario.supervisorInterventions,
    })),
  };
}

function outcomesReport(
  aggregate: SupervisorBenchmarkAggregate,
): SupervisorBenchmarkOutcomesReport {
  return {
    wins: aggregate.wins,
    regressions: aggregate.regressions,
    ties: aggregate.ties,
    baselineSuccesses: aggregate.baselineSuccesses,
    supervisorSuccesses: aggregate.supervisorSuccesses,
    baselineSuccessRate: aggregate.baselineSuccessRate,
    supervisorSuccessRate: aggregate.supervisorSuccessRate,
    successDeltaPercentagePoints: aggregate.successDeltaPercentagePoints,
    pairedSignTest: signTestReport(aggregate.pairedSignTest),
    baselineRepeatedFailedInvocations: aggregate.baselineRepeatedFailedInvocations,
    supervisorRepeatedFailedInvocations: aggregate.supervisorRepeatedFailedInvocations,
    baselineUnsupportedCompletionClaims: aggregate.baselineUnsupportedCompletionClaims,
    supervisorUnsupportedCompletionClaims: aggregate.supervisorUnsupportedCompletionClaims,
    baselineUserInterventions: aggregate.baselineUserInterventions,
    supervisorUserInterventions: aggregate.supervisorUserInterventions,
    supervisorInterventions: aggregate.supervisorInterventions,
    falseInterventions: aggregate.falseInterventions,
    supervisorFatalFailures: aggregate.supervisorFatalFailures,
    rawToolOutputPersisted: aggregate.rawToolOutputPersisted,
    automaticContinuationLimitViolations: aggregate.automaticContinuationLimitViolations,
    automaticFollowUpBoundViolations: aggregate.automaticFollowUpBoundViolations,
    auxiliaryModelCallBoundViolations: aggregate.auxiliaryModelCallBoundViolations,
  };
}

function overheadReport(
  aggregate: SupervisorBenchmarkAggregate,
): SupervisorBenchmarkOverheadReport {
  return {
    tokenOverheadSamples: aggregate.tokenOverheadSamples.map(rationalToNumber),
    wallClockOverheadSamples: aggregate.wallClockOverheadSamples.map(rationalToNumber),
    tokenOverheadMedian:
      aggregate.tokenOverheadMedian === undefined
        ? null
        : rationalToNumber(aggregate.tokenOverheadMedian),
    wallClockOverheadMedian:
      aggregate.wallClockOverheadMedian === undefined
        ? null
        : rationalToNumber(aggregate.wallClockOverheadMedian),
    missingTokenSamples: aggregate.missingTokenSamples,
    missingWallClockSamples: aggregate.missingWallClockSamples,
  };
}

function verdictForGates(gates: readonly SupervisorBenchmarkGateResult[]): SupervisorBenchmarkVerdict {
  if (gates.some((gate) => gate.status === 'fail')) {
    return 'fail';
  }
  if (gates.some((gate) => gate.status === 'insufficient-data')) {
    return 'insufficient-data';
  }
  return 'pass';
}

export function evaluateSupervisorBenchmarkDataset(
  dataset: unknown,
  policy: SupervisorReleaseBenchmarkPolicyV1 = SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1,
): SupervisorBenchmarkReportV1 {
  // Validate before reading any dataset field so malformed input cannot be upgraded by evaluation.
  const validatedDataset = validateSupervisorBenchmarkDataset(dataset);
  if (validatedDataset.plan.policyId !== policy.policyId) {
    throw new SupervisorContractError(
      'invalid_benchmark_dataset',
      'Benchmark plan policy does not match the evaluation policy.',
    );
  }

  const aggregate = aggregateSupervisorBenchmarkDataset(validatedDataset);
  const automaticFollowUpBoundViolations = countAutomaticFollowUpBoundViolations(
    validatedDataset,
    policy.maximumAutomaticFollowUpsPerRun,
  );
  const gates = policy.gateOrder.map((id) =>
    gateForId(id, aggregate, policy, automaticFollowUpBoundViolations),
  );
  const report: SupervisorBenchmarkReportV1 = {
    schemaVersion: 1,
    policyId: policy.policyId,
    planFingerprint: validatedDataset.planFingerprint,
    verdict: verdictForGates(gates),
    coverage: coverageReport(aggregate),
    outcomes: outcomesReport(aggregate),
    overhead: overheadReport(aggregate),
    gates,
  };
  assertJsonValue(report);
  return report;
}

export const evaluateSupervisorBenchmark = evaluateSupervisorBenchmarkDataset;

