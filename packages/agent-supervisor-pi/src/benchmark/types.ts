export type SupervisorBenchmarkVariant = 'baseline' | 'supervisor';

export interface SupervisorBenchmarkExpectedPair {
  readonly pairId: string;
  readonly scenarioClass: string;
  readonly scenarioId: string;
  readonly caseId: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly executionProfile: string;
  readonly repetition: number;
}

export interface SupervisorBenchmarkPlanV1 {
  readonly schemaVersion: 1;
  readonly benchmarkId: string;
  readonly sourceSha: string;
  readonly policyId: string;
  readonly expectedPairs: readonly SupervisorBenchmarkExpectedPair[];
}

export interface SupervisorBenchmarkRunMetrics {
  readonly meaningfulAgentRuns: number;
  readonly repeatedFailedInvocations: number;
  readonly unsupportedCompletionClaims: number;
  readonly userInterventions: number;
  readonly supervisorInterventions: number;
  readonly falseInterventions: number;
  readonly automaticFollowUps: number;
  readonly auxiliaryModelCalls: number;
  readonly supervisorFatalFailures: number;
  readonly rawToolOutputPersisted: number;
  readonly automaticContinuationLimitViolations: number;
  readonly totalTokens?: number;
  readonly wallClockMs?: number;
}

export interface SupervisorBenchmarkOracle {
  readonly kind: 'deterministic';
  readonly taskSuccess: boolean;
}

export interface SupervisorBenchmarkCompletedRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pairId: string;
  readonly variant: SupervisorBenchmarkVariant;
  readonly status: 'completed';
  readonly oracle: SupervisorBenchmarkOracle;
  readonly metrics: SupervisorBenchmarkRunMetrics;
}

export interface SupervisorBenchmarkInfrastructureErrorRun {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pairId: string;
  readonly variant: SupervisorBenchmarkVariant;
  readonly status: 'infrastructure-error';
  readonly errorKind: 'provider' | 'harness' | 'oracle' | 'timeout' | 'unknown';
}

export type SupervisorBenchmarkRun =
  | SupervisorBenchmarkCompletedRun
  | SupervisorBenchmarkInfrastructureErrorRun;

export interface SupervisorBenchmarkDatasetV1 {
  readonly schemaVersion: 1;
  readonly plan: SupervisorBenchmarkPlanV1;
  readonly planFingerprint: string;
  readonly runs: readonly SupervisorBenchmarkRun[];
}
