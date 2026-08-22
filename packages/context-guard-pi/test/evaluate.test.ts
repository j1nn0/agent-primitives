import { describe, expect, it } from 'vitest';
import type {
  BenchmarkCase,
  BenchmarkItem,
} from '../benchmark/corpus.js';
import {
  evaluateBenchmark,
  type ParsedExtractionOutput,
} from '../benchmark/evaluate.js';

function definition(
  id: string,
  expectedAdds: readonly BenchmarkItem[],
  expectedRetirements: readonly string[] = [],
): BenchmarkCase {
  return {
    id,
    category: 'positive',
    message: `Synthetic message for ${id}.`,
    existingAutomaticItems: [],
    expectedAdds,
    expectedRetirements,
    expectNoAdds: expectedAdds.length === 0,
  };
}

function output(
  caseId: string,
  add: readonly BenchmarkItem[],
  outcome: ParsedExtractionOutput['outcome'] = 'success',
): ParsedExtractionOutput {
  return {
    caseId,
    outcome,
    add,
    removeAutoItemIds: [],
  };
}

const expectedItem: BenchmarkItem = {
  content: 'Keep this synthetic item.',
  kind: 'constraint',
  critical: true,
};

describe('benchmark evaluator', () => {
  it('scores a perfect run', () => {
    const testCase = definition('perfect-case', [expectedItem]);
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [expectedItem])],
    );

    expect(result.item).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(result.kindAccuracy).toEqual({ correct: 1, total: 1, accuracy: 1 });
    expect(result.criticalAccuracy).toEqual({
      correct: 1,
      total: 1,
      accuracy: 1,
    });
    expect(result.falsePositives).toEqual([]);
    expect(result.falseNegatives).toEqual([]);
  });

  it('reports a known false positive with its case id', () => {
    const testCase = definition('false-positive-case', []);
    const extra: BenchmarkItem = {
      content: 'Unexpected synthetic item.',
      kind: 'goal',
      critical: false,
    };
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [extra])],
    );

    expect(result.item.precision).toBe(0);
    expect(result.item.recall).toBe(1);
    expect(result.item.f1).toBe(0);
    expect(result.falsePositives).toEqual([{ caseId: testCase.id, item: extra }]);
    expect(result.falseNegatives).toEqual([]);
  });

  it('reports a known false negative with its case id', () => {
    const testCase = definition('false-negative-case', [expectedItem]);
    const result = evaluateBenchmark([testCase], [output(testCase.id, [])]);

    expect(result.item.precision).toBe(1);
    expect(result.item.recall).toBe(0);
    expect(result.item.f1).toBe(0);
    expect(result.falsePositives).toEqual([]);
    expect(result.falseNegatives).toEqual([
      { caseId: testCase.id, item: expectedItem },
    ]);
  });

  it('matches primary items by kind and exact content, and scores kind separately', () => {
    const testCase = definition('wrong-kind-case', [expectedItem]);
    const wrongKind: BenchmarkItem = {
      ...expectedItem,
      kind: 'goal',
    };
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [wrongKind])],
    );

    expect(result.item.precision).toBe(0);
    expect(result.item.recall).toBe(0);
    expect(result.kindAccuracy).toEqual({ correct: 0, total: 1, accuracy: 0 });
    expect(result.criticalAccuracy).toEqual({
      correct: 1,
      total: 1,
      accuracy: 1,
    });
  });

  it('keeps critical out of primary matching and scores it separately', () => {
    const testCase = definition('wrong-critical-case', [expectedItem]);
    const wrongCritical: BenchmarkItem = {
      ...expectedItem,
      critical: false,
    };
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [wrongCritical])],
    );

    expect(result.item).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });
    expect(result.criticalAccuracy).toEqual({
      correct: 0,
      total: 1,
      accuracy: 0,
    });
  });

  it('excludes provider failures from the quality denominator', () => {
    const testCase = definition('provider-case', [expectedItem]);
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [], 'provider')],
    );

    expect(result.providerFailures).toEqual([testCase.id]);
    expect(result.qualityCaseCount).toBe(0);
    expect(result.falseNegatives).toEqual([]);
  });
});
