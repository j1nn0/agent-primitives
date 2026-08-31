import { describe, expect, it } from 'vitest';
import {
  canonicalizeSupervisorBenchmarkPlan,
  computeSupervisorBenchmarkPlanFingerprint,
  validateSupervisorBenchmarkPlan,
} from '../src/index.js';
import { expectedPair, plan, SOURCE_SHA } from './benchmark-helper.js';

describe('supervisor benchmark plan fingerprints', () => {
  it('canonicalizes expected pairs by ascending pair ID', () => {
    const validated = validateSupervisorBenchmarkPlan(
      plan({ expectedPairs: [expectedPair('pair-z'), expectedPair('pair-a')] }),
    );
    const canonical = canonicalizeSupervisorBenchmarkPlan(validated);
    expect(canonical.indexOf('"pairId":"pair-a"')).toBeLessThan(canonical.indexOf('"pairId":"pair-z"'));
  });

  it('returns a 64-character lowercase hexadecimal fingerprint', () => {
    const fingerprint = computeSupervisorBenchmarkPlanFingerprint(validateSupervisorBenchmarkPlan(plan()));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable when expected pairs are supplied in a different order', () => {
    const first = validateSupervisorBenchmarkPlan(
      plan({ expectedPairs: [expectedPair('pair-a'), expectedPair('pair-b')] }),
    );
    const second = validateSupervisorBenchmarkPlan(
      plan({ expectedPairs: [expectedPair('pair-b'), expectedPair('pair-a')] }),
    );
    expect(computeSupervisorBenchmarkPlanFingerprint(first)).toBe(
      computeSupervisorBenchmarkPlanFingerprint(second),
    );
  });

  it('is stable when object keys are supplied in a different insertion order', () => {
    const first = validateSupervisorBenchmarkPlan(plan());
    const pair = expectedPair();
    const second = validateSupervisorBenchmarkPlan({
      policyId: 'policy-a',
      expectedPairs: [
        {
          repetition: pair.repetition,
          executionProfile: pair.executionProfile,
          modelId: pair.modelId,
          modelFamily: pair.modelFamily,
          caseId: pair.caseId,
          scenarioId: pair.scenarioId,
          scenarioClass: pair.scenarioClass,
          pairId: pair.pairId,
        },
      ],
      sourceSha: SOURCE_SHA,
      benchmarkId: 'benchmark-a',
      schemaVersion: 1,
    });
    expect(computeSupervisorBenchmarkPlanFingerprint(first)).toBe(
      computeSupervisorBenchmarkPlanFingerprint(second),
    );
  });

  it.each([
    ['sourceSha', plan({ sourceSha: 'b'.repeat(40) })],
    ['benchmarkId', plan({ benchmarkId: 'benchmark-b' })],
    ['policyId', plan({ policyId: 'policy-b' })],
    [
      'expected pair field',
      plan({ expectedPairs: [expectedPair('pair-a', { scenarioId: 'scenario-b' })] }),
    ],
  ] as const)('changes when %s changes', (_field, changedPlan) => {
    const originalFingerprint = computeSupervisorBenchmarkPlanFingerprint(
      validateSupervisorBenchmarkPlan(plan()),
    );
    const changedFingerprint = computeSupervisorBenchmarkPlanFingerprint(
      validateSupervisorBenchmarkPlan(changedPlan),
    );
    expect(changedFingerprint).not.toBe(originalFingerprint);
  });
});
