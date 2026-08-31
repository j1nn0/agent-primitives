export interface SupervisorBenchmarkRatioThreshold {
  readonly numerator: number;
  readonly denominator: number;
}

export interface SupervisorReleaseBenchmarkCoveragePolicy {
  readonly minimumCompletePairs: number;
  readonly minimumModelFamilies: number;
  readonly minimumFamiliesPerRequiredClass: number;
  readonly minimumPairsPerRequiredClassFamily: number;
}

export interface SupervisorReleaseBenchmarkReductionPolicy {
  readonly repeatedFailedInvocations: SupervisorBenchmarkRatioThreshold;
  readonly unsupportedCompletionClaims: SupervisorBenchmarkRatioThreshold;
  readonly userInterventions: SupervisorBenchmarkRatioThreshold;
}

export interface SupervisorReleaseBenchmarkOverheadPolicy {
  readonly maximumTokenOverhead: SupervisorBenchmarkRatioThreshold;
  readonly maximumWallClockOverhead: SupervisorBenchmarkRatioThreshold;
}

export interface SupervisorReleaseBenchmarkPolicyV1 {
  readonly policyId: string;
  readonly coverage: SupervisorReleaseBenchmarkCoveragePolicy;
  /** Required scenario classes are policy data, not a closed TypeScript enum. */
  readonly requiredScenarioClasses: readonly string[];
  readonly minimumSuccessDeltaPercentagePoints: number;
  readonly significanceThreshold: SupervisorBenchmarkRatioThreshold;
  readonly minimumProblemExposure: number;
  readonly reductions: SupervisorReleaseBenchmarkReductionPolicy;
  readonly maximumFalseInterventionRate: SupervisorBenchmarkRatioThreshold;
  readonly healthySuccessSilenceClass: string;
  readonly maximumAutomaticFollowUpsPerRun: number;
  readonly overhead: SupervisorReleaseBenchmarkOverheadPolicy;
  readonly gateOrder: readonly string[];
}

const REQUIRED_SCENARIO_CLASSES = Object.freeze([
  'repeated-failing-invocation',
  'premature-completion-no-verification',
  'mutation-after-last-verification',
  'failed-verification-false-completion',
  'multi-step-coding',
  'research-and-implementation',
  'ambiguous-tool-failure',
  'context-compaction',
  'session-resume',
  'healthy-success-silence',
]);

const GATE_ORDER = Object.freeze([
  'benchmark:data-completeness',
  'benchmark:coverage',
  'benchmark:task-success',
  'benchmark:repeated-failure-reduction',
  'benchmark:unsupported-completion-reduction',
  'benchmark:user-intervention-reduction',
  'benchmark:false-intervention-rate',
  'benchmark:healthy-success-silence',
  'benchmark:supervisor-fatal-failures',
  'benchmark:persistence-privacy',
  'benchmark:continuation-bounds',
  'benchmark:auxiliary-call-bound',
  'benchmark:token-overhead',
  'benchmark:wall-clock-overhead',
]);

const COVERAGE_POLICY = Object.freeze({
  minimumCompletePairs: 60,
  minimumModelFamilies: 2,
  minimumFamiliesPerRequiredClass: 2,
  minimumPairsPerRequiredClassFamily: 3,
});

const SIGNIFICANCE_THRESHOLD = Object.freeze({ numerator: 5, denominator: 100 });
const MAXIMUM_FALSE_INTERVENTION_RATE = Object.freeze({ numerator: 5, denominator: 100 });

const REDUCTION_POLICY = Object.freeze({
  repeatedFailedInvocations: Object.freeze({ numerator: 4, denominator: 5 }),
  unsupportedCompletionClaims: Object.freeze({ numerator: 3, denominator: 5 }),
  userInterventions: Object.freeze({ numerator: 3, denominator: 5 }),
});

const OVERHEAD_POLICY = Object.freeze({
  maximumTokenOverhead: Object.freeze({ numerator: 15, denominator: 100 }),
  maximumWallClockOverhead: Object.freeze({ numerator: 20, denominator: 100 }),
});

export const SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1: SupervisorReleaseBenchmarkPolicyV1 = Object.freeze({
  policyId: 'supervisor-release-v1',
  coverage: COVERAGE_POLICY,
  requiredScenarioClasses: REQUIRED_SCENARIO_CLASSES,
  minimumSuccessDeltaPercentagePoints: 8,
  significanceThreshold: SIGNIFICANCE_THRESHOLD,
  minimumProblemExposure: 10,
  reductions: REDUCTION_POLICY,
  maximumFalseInterventionRate: MAXIMUM_FALSE_INTERVENTION_RATE,
  healthySuccessSilenceClass: 'healthy-success-silence',
  maximumAutomaticFollowUpsPerRun: 1,
  overhead: OVERHEAD_POLICY,
  gateOrder: GATE_ORDER,
});

