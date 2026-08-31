import { SupervisorContractError } from '../errors.js';
import { isSupervisorIdSegment } from '../ids.js';
import { isJsonValue } from '../json.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from '../internal.js';
import { computeSupervisorBenchmarkPlanFingerprint } from './plan.js';
import type {
  SupervisorBenchmarkCompletedRun,
  SupervisorBenchmarkDatasetV1,
  SupervisorBenchmarkExpectedPair,
  SupervisorBenchmarkInfrastructureErrorRun,
  SupervisorBenchmarkOracle,
  SupervisorBenchmarkPlanV1,
  SupervisorBenchmarkRun,
  SupervisorBenchmarkRunMetrics,
  SupervisorBenchmarkVariant,
} from './types.js';

type ValidationContext = 'plan' | 'dataset';

const ALLOWED_PLAN_KEYS = new Set([
  'schemaVersion',
  'benchmarkId',
  'sourceSha',
  'policyId',
  'expectedPairs',
]);
const REQUIRED_PLAN_KEYS = ['schemaVersion', 'benchmarkId', 'sourceSha', 'policyId', 'expectedPairs'];

const ALLOWED_EXPECTED_PAIR_KEYS = new Set([
  'pairId',
  'scenarioClass',
  'scenarioId',
  'caseId',
  'modelFamily',
  'modelId',
  'executionProfile',
  'repetition',
]);
const REQUIRED_EXPECTED_PAIR_KEYS = [
  'pairId',
  'scenarioClass',
  'scenarioId',
  'caseId',
  'modelFamily',
  'modelId',
  'executionProfile',
  'repetition',
];

const ALLOWED_METRICS_KEYS = new Set([
  'meaningfulAgentRuns',
  'repeatedFailedInvocations',
  'unsupportedCompletionClaims',
  'userInterventions',
  'supervisorInterventions',
  'falseInterventions',
  'automaticFollowUps',
  'auxiliaryModelCalls',
  'supervisorFatalFailures',
  'rawToolOutputPersisted',
  'automaticContinuationLimitViolations',
  'totalTokens',
  'wallClockMs',
]);
const REQUIRED_METRICS_KEYS = [
  'meaningfulAgentRuns',
  'repeatedFailedInvocations',
  'unsupportedCompletionClaims',
  'userInterventions',
  'supervisorInterventions',
  'falseInterventions',
  'automaticFollowUps',
  'auxiliaryModelCalls',
  'supervisorFatalFailures',
  'rawToolOutputPersisted',
  'automaticContinuationLimitViolations',
];

const SUPERVISOR_ONLY_METRIC_KEYS = [
  'supervisorInterventions',
  'falseInterventions',
  'automaticFollowUps',
  'auxiliaryModelCalls',
  'supervisorFatalFailures',
  'rawToolOutputPersisted',
  'automaticContinuationLimitViolations',
] as const;

const ALLOWED_ORACLE_KEYS = new Set(['kind', 'taskSuccess']);
const REQUIRED_ORACLE_KEYS = ['kind', 'taskSuccess'];

const ALLOWED_COMPLETED_RUN_KEYS = new Set([
  'schemaVersion',
  'runId',
  'pairId',
  'variant',
  'status',
  'oracle',
  'metrics',
]);
const REQUIRED_COMPLETED_RUN_KEYS = [
  'schemaVersion',
  'runId',
  'pairId',
  'variant',
  'status',
  'oracle',
  'metrics',
];

const ALLOWED_INFRASTRUCTURE_ERROR_RUN_KEYS = new Set([
  'schemaVersion',
  'runId',
  'pairId',
  'variant',
  'status',
  'errorKind',
]);
const REQUIRED_INFRASTRUCTURE_ERROR_RUN_KEYS = [
  'schemaVersion',
  'runId',
  'pairId',
  'variant',
  'status',
  'errorKind',
];

const ALLOWED_DATASET_KEYS = new Set(['schemaVersion', 'plan', 'planFingerprint', 'runs']);
const REQUIRED_DATASET_KEYS = ['schemaVersion', 'plan', 'planFingerprint', 'runs'];

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

function invalidBenchmark(context: ValidationContext): never {
  if (context === 'plan') {
    throw new SupervisorContractError('invalid_benchmark_plan', 'Invalid supervisor benchmark plan.');
  }
  throw new SupervisorContractError('invalid_benchmark_dataset', 'Invalid supervisor benchmark dataset.');
}

function isStrictJsonObject(value: unknown): value is Record<string, unknown> {
  try {
    return isPlainObject(value) && isJsonValue(value);
  } catch {
    return false;
  }
}

function hasRequiredKeys(value: object, requiredKeys: readonly string[]): boolean {
  try {
    return requiredKeys.every((key) => hasOwn(value, key));
  } catch {
    return false;
  }
}

function isNonEmptyOpaqueString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readMetric(value: unknown, context: ValidationContext): number {
  if (!isNonNegativeSafeInteger(value)) {
    return invalidBenchmark(context);
  }
  return value;
}

function isBenchmarkVariant(value: unknown): value is SupervisorBenchmarkVariant {
  return value === 'baseline' || value === 'supervisor';
}

function isInfrastructureErrorKind(
  value: unknown,
): value is SupervisorBenchmarkInfrastructureErrorRun['errorKind'] {
  return (
    value === 'provider' ||
    value === 'harness' ||
    value === 'oracle' ||
    value === 'timeout' ||
    value === 'unknown'
  );
}

function validateExpectedPair(
  value: unknown,
  context: ValidationContext,
): SupervisorBenchmarkExpectedPair {
  if (!isStrictJsonObject(value)) {
    return invalidBenchmark(context);
  }

  try {
    if (
      !hasOnlyAllowedKeys(value, ALLOWED_EXPECTED_PAIR_KEYS) ||
      !hasRequiredKeys(value, REQUIRED_EXPECTED_PAIR_KEYS)
    ) {
      return invalidBenchmark(context);
    }

    const pairId = value.pairId;
    const scenarioClass = value.scenarioClass;
    const scenarioId = value.scenarioId;
    const caseId = value.caseId;
    const modelFamily = value.modelFamily;
    const modelId = value.modelId;
    const executionProfile = value.executionProfile;
    const repetition = value.repetition;

    if (
      !isSupervisorIdSegment(pairId) ||
      !isSupervisorIdSegment(scenarioClass) ||
      !isSupervisorIdSegment(scenarioId) ||
      !isSupervisorIdSegment(caseId) ||
      !isSupervisorIdSegment(modelFamily) ||
      !isSupervisorIdSegment(executionProfile) ||
      !isNonEmptyOpaqueString(modelId) ||
      typeof repetition !== 'number' ||
      !Number.isSafeInteger(repetition) ||
      repetition < 1
    ) {
      return invalidBenchmark(context);
    }

    return {
      pairId,
      scenarioClass,
      scenarioId,
      caseId,
      modelFamily,
      modelId,
      executionProfile,
      repetition,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidBenchmark(context);
  }
}

function validatePlan(value: unknown, context: ValidationContext): SupervisorBenchmarkPlanV1 {
  if (!isStrictJsonObject(value)) {
    return invalidBenchmark(context);
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_PLAN_KEYS) || !hasRequiredKeys(value, REQUIRED_PLAN_KEYS)) {
      return invalidBenchmark(context);
    }

    const schemaVersion = value.schemaVersion;
    const benchmarkId = value.benchmarkId;
    const sourceSha = value.sourceSha;
    const policyId = value.policyId;
    const expectedPairsValue = value.expectedPairs;
    if (
      schemaVersion !== 1 ||
      !isSupervisorIdSegment(benchmarkId) ||
      !isSupervisorIdSegment(policyId) ||
      typeof sourceSha !== 'string' ||
      !SOURCE_SHA_PATTERN.test(sourceSha) ||
      !isDenseArray(expectedPairsValue) ||
      expectedPairsValue.length === 0
    ) {
      return invalidBenchmark(context);
    }

    const expectedPairs: SupervisorBenchmarkExpectedPair[] = [];
    const pairIds = new Set<string>();
    for (let index = 0; index < expectedPairsValue.length; index += 1) {
      const expectedPair = validateExpectedPair(expectedPairsValue[index], context);
      if (pairIds.has(expectedPair.pairId)) {
        return invalidBenchmark(context);
      }
      pairIds.add(expectedPair.pairId);
      expectedPairs.push(expectedPair);
    }

    return {
      schemaVersion: 1,
      benchmarkId,
      sourceSha,
      policyId,
      expectedPairs,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidBenchmark(context);
  }
}

function validateMetrics(value: unknown, context: ValidationContext): SupervisorBenchmarkRunMetrics {
  if (!isStrictJsonObject(value)) {
    return invalidBenchmark(context);
  }

  try {
    if (
      !hasOnlyAllowedKeys(value, ALLOWED_METRICS_KEYS) ||
      !hasRequiredKeys(value, REQUIRED_METRICS_KEYS)
    ) {
      return invalidBenchmark(context);
    }

    const meaningfulAgentRuns = readMetric(value.meaningfulAgentRuns, context);
    const repeatedFailedInvocations = readMetric(value.repeatedFailedInvocations, context);
    const unsupportedCompletionClaims = readMetric(value.unsupportedCompletionClaims, context);
    const userInterventions = readMetric(value.userInterventions, context);
    const supervisorInterventions = readMetric(value.supervisorInterventions, context);
    const falseInterventions = readMetric(value.falseInterventions, context);
    const automaticFollowUps = readMetric(value.automaticFollowUps, context);
    const auxiliaryModelCalls = readMetric(value.auxiliaryModelCalls, context);
    const supervisorFatalFailures = readMetric(value.supervisorFatalFailures, context);
    const rawToolOutputPersisted = readMetric(value.rawToolOutputPersisted, context);
    const automaticContinuationLimitViolations = readMetric(
      value.automaticContinuationLimitViolations,
      context,
    );

    if (meaningfulAgentRuns < 1 || falseInterventions > supervisorInterventions) {
      return invalidBenchmark(context);
    }

    const totalTokens = hasOwn(value, 'totalTokens')
      ? readMetric(value.totalTokens, context)
      : undefined;
    const wallClockMs = hasOwn(value, 'wallClockMs') ? readMetric(value.wallClockMs, context) : undefined;

    const metrics = {
      meaningfulAgentRuns,
      repeatedFailedInvocations,
      unsupportedCompletionClaims,
      userInterventions,
      supervisorInterventions,
      falseInterventions,
      automaticFollowUps,
      auxiliaryModelCalls,
      supervisorFatalFailures,
      rawToolOutputPersisted,
      automaticContinuationLimitViolations,
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(wallClockMs === undefined ? {} : { wallClockMs }),
    };
    return metrics;
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidBenchmark(context);
  }
}

function validateOracle(value: unknown, context: ValidationContext): SupervisorBenchmarkOracle {
  if (!isStrictJsonObject(value)) {
    return invalidBenchmark(context);
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_ORACLE_KEYS) || !hasRequiredKeys(value, REQUIRED_ORACLE_KEYS)) {
      return invalidBenchmark(context);
    }

    const kind = value.kind;
    const taskSuccess = value.taskSuccess;
    if (kind !== 'deterministic' || typeof taskSuccess !== 'boolean') {
      return invalidBenchmark(context);
    }
    return { kind: 'deterministic', taskSuccess };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidBenchmark(context);
  }
}

function validateCompletedRun(
  value: Record<string, unknown>,
  context: ValidationContext,
): SupervisorBenchmarkCompletedRun {
  if (
    !hasOnlyAllowedKeys(value, ALLOWED_COMPLETED_RUN_KEYS) ||
    !hasRequiredKeys(value, REQUIRED_COMPLETED_RUN_KEYS)
  ) {
    return invalidBenchmark(context);
  }

  const schemaVersion = value.schemaVersion;
  const runId = value.runId;
  const pairId = value.pairId;
  const variant = value.variant;
  const status = value.status;
  if (
    schemaVersion !== 1 ||
    !isSupervisorIdSegment(runId) ||
    !isSupervisorIdSegment(pairId) ||
    !isBenchmarkVariant(variant) ||
    status !== 'completed'
  ) {
    return invalidBenchmark(context);
  }

  const oracle = validateOracle(value.oracle, context);
  const metrics = validateMetrics(value.metrics, context);
  if (variant === 'baseline') {
    for (const key of SUPERVISOR_ONLY_METRIC_KEYS) {
      if (metrics[key] !== 0) {
        return invalidBenchmark(context);
      }
    }
  }

  return {
    schemaVersion: 1,
    runId,
    pairId,
    variant,
    status: 'completed',
    oracle,
    metrics,
  };
}

function validateInfrastructureErrorRun(
  value: Record<string, unknown>,
  context: ValidationContext,
): SupervisorBenchmarkInfrastructureErrorRun {
  if (
    !hasOnlyAllowedKeys(value, ALLOWED_INFRASTRUCTURE_ERROR_RUN_KEYS) ||
    !hasRequiredKeys(value, REQUIRED_INFRASTRUCTURE_ERROR_RUN_KEYS)
  ) {
    return invalidBenchmark(context);
  }

  const schemaVersion = value.schemaVersion;
  const runId = value.runId;
  const pairId = value.pairId;
  const variant = value.variant;
  const status = value.status;
  const errorKind = value.errorKind;
  if (
    schemaVersion !== 1 ||
    !isSupervisorIdSegment(runId) ||
    !isSupervisorIdSegment(pairId) ||
    !isBenchmarkVariant(variant) ||
    status !== 'infrastructure-error' ||
    !isInfrastructureErrorKind(errorKind)
  ) {
    return invalidBenchmark(context);
  }

  // Infrastructure failures are valid run records and must stay in the dataset. A later gate
  // turns their presence into insufficient data; dropping them here would enable cherry-picking.
  return {
    schemaVersion: 1,
    runId,
    pairId,
    variant,
    status: 'infrastructure-error',
    errorKind,
  };
}

function validateRun(value: unknown, context: ValidationContext): SupervisorBenchmarkRun {
  if (!isStrictJsonObject(value)) {
    return invalidBenchmark(context);
  }

  try {
    if (!hasOwn(value, 'status')) {
      return invalidBenchmark(context);
    }
    if (value.status === 'completed') {
      return validateCompletedRun(value, context);
    }
    if (value.status === 'infrastructure-error') {
      return validateInfrastructureErrorRun(value, context);
    }
    return invalidBenchmark(context);
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidBenchmark(context);
  }
}

export function validateSupervisorBenchmarkPlan(value: unknown): SupervisorBenchmarkPlanV1 {
  return validatePlan(value, 'plan');
}

export function validateSupervisorBenchmarkDataset(value: unknown): SupervisorBenchmarkDatasetV1 {
  /*
   * Structural invalidity is a loud contract violation. In contrast, an infrastructure-error
   * run is structurally valid and is deliberately preserved; the later benchmark gate, not this
   * validator, decides that such a dataset has insufficient data.
   */
  if (!isStrictJsonObject(value)) {
    return invalidBenchmark('dataset');
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_DATASET_KEYS) || !hasRequiredKeys(value, REQUIRED_DATASET_KEYS)) {
      return invalidBenchmark('dataset');
    }

    const schemaVersion = value.schemaVersion;
    const plan = validatePlan(value.plan, 'dataset');
    const planFingerprint = value.planFingerprint;
    const runsValue = value.runs;
    if (
      schemaVersion !== 1 ||
      typeof planFingerprint !== 'string' ||
      planFingerprint !== computeSupervisorBenchmarkPlanFingerprint(plan) ||
      !isDenseArray(runsValue)
    ) {
      return invalidBenchmark('dataset');
    }

    const plannedPairIds = new Set(plan.expectedPairs.map((expectedPair) => expectedPair.pairId));
    const seenRunIds = new Set<string>();
    const variantsByPair = new Map<string, Set<SupervisorBenchmarkVariant>>();
    const runs: SupervisorBenchmarkRun[] = [];

    for (let index = 0; index < runsValue.length; index += 1) {
      const run = validateRun(runsValue[index], 'dataset');
      if (!plannedPairIds.has(run.pairId) || seenRunIds.has(run.runId)) {
        return invalidBenchmark('dataset');
      }
      seenRunIds.add(run.runId);

      let variants = variantsByPair.get(run.pairId);
      if (variants === undefined) {
        variants = new Set<SupervisorBenchmarkVariant>();
        variantsByPair.set(run.pairId, variants);
      }
      if (variants.has(run.variant)) {
        return invalidBenchmark('dataset');
      }
      variants.add(run.variant);
      runs.push(run);
    }

    for (const expectedPair of plan.expectedPairs) {
      const variants = variantsByPair.get(expectedPair.pairId);
      if (variants === undefined || !variants.has('baseline') || !variants.has('supervisor')) {
        return invalidBenchmark('dataset');
      }
    }

    return {
      schemaVersion: 1,
      plan,
      planFingerprint,
      runs,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidBenchmark('dataset');
  }
}
