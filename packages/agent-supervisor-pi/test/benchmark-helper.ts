import {
  computeSupervisorBenchmarkPlanFingerprint,
  validateSupervisorBenchmarkPlan,
} from '../src/index.js';
import type { SupervisorBenchmarkVariant } from '../src/index.js';

export const SOURCE_SHA = 'a'.repeat(40);

export function expectedPair(
  pairId = 'pair-a',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pairId,
    scenarioClass: 'tool-use',
    scenarioId: 'scenario-a',
    caseId: 'case-a',
    modelFamily: 'model-family-a',
    modelId: 'openai-codex/gpt-5.6-luna',
    executionProfile: 'default',
    repetition: 1,
    ...overrides,
  };
}

export function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    benchmarkId: 'benchmark-a',
    sourceSha: SOURCE_SHA,
    policyId: 'policy-a',
    expectedPairs: [expectedPair()],
    ...overrides,
  };
}

export function metrics(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meaningfulAgentRuns: 1,
    repeatedFailedInvocations: 0,
    unsupportedCompletionClaims: 0,
    userInterventions: 0,
    supervisorInterventions: 0,
    falseInterventions: 0,
    automaticFollowUps: 0,
    auxiliaryModelCalls: 0,
    supervisorFatalFailures: 0,
    rawToolOutputPersisted: 0,
    automaticContinuationLimitViolations: 0,
    ...overrides,
  };
}

export function completedRun(
  variant: SupervisorBenchmarkVariant = 'baseline',
  pairId = 'pair-a',
  runId = `${variant}-run`,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    pairId,
    variant,
    status: 'completed',
    oracle: { kind: 'deterministic', taskSuccess: true },
    metrics: metrics(),
    ...overrides,
  };
}

export function infrastructureErrorRun(
  variant: SupervisorBenchmarkVariant,
  pairId = 'pair-a',
  runId = `${variant}-run`,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    pairId,
    variant,
    status: 'infrastructure-error',
    errorKind: 'provider',
    ...overrides,
  };
}

export function validDataset(
  planValue: Record<string, unknown> = plan(),
  runsValue: readonly Record<string, unknown>[] = [completedRun('baseline'), completedRun('supervisor')],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const validatedPlan = validateSupervisorBenchmarkPlan(planValue);
  return {
    schemaVersion: 1,
    plan: validatedPlan,
    planFingerprint: computeSupervisorBenchmarkPlanFingerprint(validatedPlan),
    runs: [...runsValue],
    ...overrides,
  };
}
