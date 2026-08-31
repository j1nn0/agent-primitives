import { describe, expect, it } from 'vitest';
import { evaluateSupervisorBenchmark } from '../src/index.js';
import type { SupervisorBenchmarkDatasetV1, SupervisorBenchmarkExpectedPair, SupervisorBenchmarkRun } from '../src/index.js';
import { createSyntheticSupervisorBenchmarkDataset, replaceSupervisorBenchmarkPlan } from './benchmark-fixture.js';

function rotate<T>(values: readonly T[], amount: number): T[] {
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function shuffledDataset(
  dataset: SupervisorBenchmarkDatasetV1,
  pairs: readonly SupervisorBenchmarkExpectedPair[],
  runs: readonly SupervisorBenchmarkRun[],
): SupervisorBenchmarkDatasetV1 {
  return replaceSupervisorBenchmarkPlan(
    { ...dataset, runs: [...runs] },
    { ...dataset.plan, expectedPairs: [...pairs] },
  );
}

describe('supervisor benchmark deterministic ordering', () => {
  it('emits the same report for independent plan/run permutations', () => {
    const dataset = createSyntheticSupervisorBenchmarkDataset({ repetitions: 5, wins: 8 });
    const reference = evaluateSupervisorBenchmark(dataset);
    const permutations = [
      {
        pairs: [...dataset.plan.expectedPairs],
        runs: [...dataset.runs].reverse(),
      },
      {
        pairs: rotate(dataset.plan.expectedPairs, 17),
        runs: [...dataset.runs],
      },
      {
        pairs: [...dataset.plan.expectedPairs].reverse(),
        runs: rotate(dataset.runs, 29),
      },
    ];

    for (const permutation of permutations) {
      const shuffled = shuffledDataset(dataset, permutation.pairs, permutation.runs);
      const report = evaluateSupervisorBenchmark(shuffled);
      expect(shuffled.planFingerprint).toBe(dataset.planFingerprint);
      expect(report.planFingerprint).toBe(reference.planFingerprint);
      expect(report).toEqual(reference);
    }
  });
});
