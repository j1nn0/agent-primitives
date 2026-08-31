import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  validateSupervisorBenchmarkDataset,
  validateSupervisorBenchmarkPlan,
} from '../src/index.js';
import {
  completedRun,
  expectedPair,
  infrastructureErrorRun,
  metrics,
  plan,
  validDataset,
} from './benchmark-helper.js';

function expectInvalid(value: unknown): void {
  expect(() => validateSupervisorBenchmarkPlan(value)).toThrow(SupervisorContractError);
}

function expectInvalidDataset(value: unknown): void {
  expect(() => validateSupervisorBenchmarkDataset(value)).toThrow(SupervisorContractError);
}

function runsOf(dataset: Record<string, unknown>): readonly Record<string, unknown>[] {
  return dataset.runs as readonly Record<string, unknown>[];
}

describe('supervisor benchmark validation', () => {
  it('accepts a valid plan and dataset', () => {
    const validPlan = validateSupervisorBenchmarkPlan(plan());
    expect(validPlan.expectedPairs).toHaveLength(1);

    const valid = validDataset();
    const validated = validateSupervisorBenchmarkDataset(valid);
    expect(validated.plan).toEqual(validPlan);
    expect(validated.runs).toHaveLength(2);
  });

  it.each(['a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(39)}g`])(
    'rejects an invalid source SHA: %s',
    (sourceSha) => {
      expectInvalid(plan({ sourceSha }));
    },
  );

  it('rejects duplicate expected pair IDs', () => {
    expectInvalid(
      plan({
        expectedPairs: [expectedPair('pair-a'), expectedPair('pair-a')],
      }),
    );
  });

  it.each([0, -1, 1.5])('rejects repetition %s', (repetition) => {
    expectInvalid(plan({ expectedPairs: [expectedPair('pair-a', { repetition })] }));
  });

  it('rejects invalid segment-grammar identifiers without reserving kernel', () => {
    for (const field of [
      'benchmarkId',
      'policyId',
    ]) {
      expectInvalid(plan({ [field]: 'Feature-a' }));
    }
    for (const field of [
      'pairId',
      'scenarioClass',
      'scenarioId',
      'caseId',
      'modelFamily',
      'executionProfile',
    ]) {
      expectInvalid(
        plan({
          expectedPairs: [expectedPair('pair-a', { [field]: 'bad_id' })],
        }),
      );
    }
    expectInvalid(plan({ expectedPairs: [expectedPair('pair:a')] }));
    expect(validateSupervisorBenchmarkPlan(plan({ benchmarkId: 'kernel', policyId: 'kernel' }))).toEqual(
      expect.objectContaining({ benchmarkId: 'kernel', policyId: 'kernel' }),
    );
  });

  it('accepts a realistic opaque model ID', () => {
    const validated = validateSupervisorBenchmarkPlan(
      plan({
        expectedPairs: [expectedPair('pair-a', { modelId: 'openai-codex/gpt-5.6-luna' })],
      }),
    );
    expect(validated.expectedPairs[0]?.modelId).toBe('openai-codex/gpt-5.6-luna');
  });

  it('rejects a plan fingerprint mismatch', () => {
    expectInvalidDataset(
      validDataset(plan(), [completedRun('baseline'), completedRun('supervisor')], {
        planFingerprint: 'f'.repeat(64),
      }),
    );
  });

  it('rejects unknown keys at the plan, pair, run, and metrics levels', () => {
    expectInvalid(plan({ extra: true }));
    expectInvalid(plan({ expectedPairs: [expectedPair('pair-a', { extra: true })] }));

    const base = validDataset();
    const baseRuns = runsOf(base);
    expectInvalidDataset({
      ...base,
      runs: [{ ...baseRuns[0], extra: true }, baseRuns[1]],
    });
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline', 'pair-a', 'baseline-run', { metrics: metrics({ extra: true }) }),
        completedRun('supervisor'),
      ]),
    );
  });

  it.each([
    ['meaningfulAgentRuns', -1],
    ['repeatedFailedInvocations', 1.5],
    ['unsupportedCompletionClaims', Number.MAX_SAFE_INTEGER + 1],
    ['totalTokens', -1],
    ['wallClockMs', 1.5],
  ] as const)('rejects an invalid metric value for %s', (key, value) => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline'),
        completedRun('supervisor', 'pair-a', 'supervisor-run', {
          metrics: metrics({ [key]: value }),
        }),
      ]),
    );
  });

  it('rejects meaningfulAgentRuns equal to zero', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline'),
        completedRun('supervisor', 'pair-a', 'supervisor-run', {
          metrics: metrics({ meaningfulAgentRuns: 0 }),
        }),
      ]),
    );
  });

  it.each([
    'supervisorInterventions',
    'falseInterventions',
    'automaticFollowUps',
    'auxiliaryModelCalls',
    'supervisorFatalFailures',
    'rawToolOutputPersisted',
    'automaticContinuationLimitViolations',
  ] as const)('rejects non-zero %s on a baseline run', (key) => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline', 'pair-a', 'baseline-run', {
          metrics: metrics({ [key]: 1 }),
        }),
        completedRun('supervisor'),
      ]),
    );
  });

  it('rejects false interventions above supervisor interventions', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline'),
        completedRun('supervisor', 'pair-a', 'supervisor-run', {
          metrics: metrics({ supervisorInterventions: 1, falseInterventions: 2 }),
        }),
      ]),
    );
  });

  it('accepts an infrastructure-error run as a structural record without metrics', () => {
    const infrastructureRun = infrastructureErrorRun('baseline');
    const validated = validateSupervisorBenchmarkDataset(
      validDataset(plan(), [infrastructureRun, completedRun('supervisor')]),
    );
    expect(validated.runs[0]).toEqual(infrastructureRun);
    expect(validated.runs[0]?.status).toBe('infrastructure-error');
    if (validated.runs[0]?.status === 'infrastructure-error') {
      expect('metrics' in validated.runs[0]).toBe(false);
    }
  });

  it('rejects non-JSON-safe dataset values', () => {
    const base = validDataset();
    const baseRuns = runsOf(base);
    expectInvalidDataset({
      ...base,
      runs: [{ ...baseRuns[0], oracle: new Date() }, baseRuns[1]],
    });
  });
});
