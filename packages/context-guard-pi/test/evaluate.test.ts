import { describe, expect, it } from 'vitest';
import type {
  BenchmarkCase,
  BenchmarkItem,
} from '../benchmark/corpus.js';
import {
  evaluateBenchmark,
  matchItemsBySpan,
  spanRelation,
  type ParsedExtractionOutput,
  type RateSummary,
  type TextSpan,
} from '../benchmark/evaluate.js';

function definition(
  id: string,
  expectedAdds: readonly BenchmarkItem[],
  expectedRetirements: readonly string[] = [],
): BenchmarkCase {
  const message = expectedAdds.length === 0
    ? `Synthetic message for ${id}.`
    : `Synthetic message for ${id}: ${expectedAdds
        .map((item) => item.content)
        .join(' and ')}.`;
  return {
    id,
    category: 'positive',
    message,
    existingAutomaticItems: [],
    expectedAdds,
    expectedRetirements,
    expectNoAdds: expectedAdds.length === 0,
  };
}

function customDefinition(
  id: string,
  message: string,
  expectedAdds: readonly BenchmarkItem[],
  options: {
    readonly category?: BenchmarkCase['category'];
    readonly expectedRetirements?: readonly string[];
    readonly expectNoAdds?: boolean;
  } = {},
): BenchmarkCase {
  return {
    id,
    category: options.category ?? 'positive',
    message,
    existingAutomaticItems: [],
    expectedAdds,
    expectedRetirements: options.expectedRetirements ?? [],
    expectNoAdds: options.expectNoAdds ?? expectedAdds.length === 0,
  };
}

function output(
  caseId: string,
  add: readonly BenchmarkItem[],
  outcome: ParsedExtractionOutput['outcome'] = 'success',
  removeAutoItemIds: readonly string[] = [],
): ParsedExtractionOutput {
  return {
    caseId,
    outcome,
    add,
    removeAutoItemIds,
  };
}

function rate(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function span(start: number, end: number): TextSpan {
  return { start, end };
}

const expectedItem: BenchmarkItem = {
  content: 'Keep this synthetic item.',
  kind: 'constraint',
  critical: true,
};

describe('benchmark evaluator', () => {
  it('scores a perfect run with strict and detection metrics', () => {
    const testCase = definition('perfect-case', [expectedItem]);
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [expectedItem])],
    );

    expect(result.strictItem).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: rate(1, 1),
      recall: rate(1, 1),
      f1: rate(2, 2),
    });
    expect(result.detection).toEqual(result.strictItem);
    expect(result.kindAccuracy).toEqual({
      correct: 1,
      total: 1,
      accuracy: rate(1, 1),
    });
    expect(result.critical).toEqual({
      truePositives: 1,
      falseCritical: 0,
      missedCritical: 0,
      correct: 1,
      total: 1,
      precision: rate(1, 1),
      recall: rate(1, 1),
      accuracy: rate(1, 1),
    });
    expect(result.criticalAccuracy).toEqual({
      correct: 1,
      total: 1,
      accuracy: rate(1, 1),
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

    expect(result.strictItem.precision).toEqual(rate(0, 1));
    expect(result.strictItem.recall).toEqual(rate(0, 0));
    expect(result.strictItem.f1).toEqual(rate(0, 1));
    expect(result.detection).toEqual(result.strictItem);
    expect(result.falsePositives).toEqual([{ caseId: testCase.id, item: extra }]);
    expect(result.falseNegatives).toEqual([]);
  });

  it('reports a known false negative with its case id', () => {
    const testCase = definition('false-negative-case', [expectedItem]);
    const result = evaluateBenchmark([testCase], [output(testCase.id, [])]);

    expect(result.strictItem.precision).toEqual(rate(0, 0));
    expect(result.strictItem.recall).toEqual(rate(0, 1));
    expect(result.strictItem.f1).toEqual(rate(0, 1));
    expect(result.detection).toEqual(result.strictItem);
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

    expect(result.strictItem.precision).toEqual(rate(0, 1));
    expect(result.strictItem.recall).toEqual(rate(0, 1));
    expect(result.detection).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: rate(1, 1),
      recall: rate(1, 1),
      f1: rate(2, 2),
    });
    expect(result.kindAccuracy).toEqual({
      correct: 0,
      total: 1,
      accuracy: rate(0, 1),
    });
    expect(result.kindConfusionMatrix).toEqual({
      constraint: { goal: 1 },
    });
    expect(result.criticalAccuracy).toEqual({
      correct: 1,
      total: 1,
      accuracy: rate(1, 1),
    });
  });

  it('keeps critical out of strict matching and scores it among matches', () => {
    const testCase = definition('wrong-critical-case', [expectedItem]);
    const wrongCritical: BenchmarkItem = {
      ...expectedItem,
      critical: false,
    };
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [wrongCritical])],
    );

    expect(result.strictItem).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: rate(1, 1),
      recall: rate(1, 1),
      f1: rate(2, 2),
    });
    expect(result.critical).toEqual({
      truePositives: 0,
      falseCritical: 0,
      missedCritical: 1,
      correct: 0,
      total: 1,
      precision: rate(0, 0),
      recall: rate(0, 1),
      accuracy: rate(0, 1),
    });
  });

  it('excludes provider failures from every quality denominator', () => {
    const testCase = definition('provider-case', [expectedItem]);
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [], 'provider')],
    );

    expect(result.providerFailures).toEqual([testCase.id]);
    expect(result.qualityCaseCount).toBe(0);
    expect(result.strictItem.falseNegatives).toBe(0);
    expect(result.detection).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: rate(0, 0),
      recall: rate(0, 0),
      f1: rate(0, 0),
    });
    expect(result.kindAccuracy).toEqual({
      correct: 0,
      total: 0,
      accuracy: rate(0, 0),
    });
  });

  it('classifies every span relation with half-open offsets', () => {
    expect(spanRelation(span(1, 4), span(1, 4))).toBe('exact');
    expect(spanRelation(span(2, 4), span(1, 5))).toBe('actual-super-span');
    expect(spanRelation(span(1, 5), span(2, 4))).toBe('actual-sub-span');
    expect(spanRelation(span(1, 4), span(3, 6))).toBe('partial-overlap');
    expect(spanRelation(span(1, 2), span(2, 3))).toBe('disjoint');
  });

  it('matches several items one to one and leaves extras unmatched', () => {
    const expected: BenchmarkItem[] = [
      { content: 'alpha', kind: 'goal', critical: true },
      { content: 'gamma', kind: 'constraint', critical: false },
    ];
    const actual: BenchmarkItem[] = [
      { content: 'alpha beta', kind: 'goal', critical: true },
      { content: 'gamma', kind: 'constraint', critical: false },
      { content: 'beta', kind: 'goal', critical: false },
    ];
    const matching = matchItemsBySpan('alpha beta gamma', expected, actual);

    expect(matching.matches.map(({ expectedIndex, actualIndex }) => [
      expectedIndex,
      actualIndex,
    ])).toEqual([[1, 1], [0, 0]]);
    expect(matching.unmatchedExpected).toEqual([]);
    expect(matching.unmatchedActual.map(({ index }) => index)).toEqual([2]);

    const testCase = customDefinition(
      'one-to-one-case',
      'alpha beta gamma',
      expected,
    );
    const result = evaluateBenchmark([testCase], [output(testCase.id, actual)]);
    expect(result.detection).toEqual({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 0,
      precision: rate(2, 3),
      recall: rate(2, 2),
      f1: rate(4, 5),
    });
  });

  it('uses total index tie-breaking and is reproducible', () => {
    const expected: BenchmarkItem[] = [
      { content: 'abcd', kind: 'goal', critical: false },
      { content: 'cdef', kind: 'constraint', critical: false },
    ];
    const actual: BenchmarkItem[] = [
      { content: 'abcdef', kind: 'decision', critical: false },
    ];
    const first = matchItemsBySpan('abcdef', expected, actual);
    const second = matchItemsBySpan('abcdef', expected, actual);

    expect(first).toEqual(second);
    expect(first.matches.map(({ expectedIndex, actualIndex }) => [
      expectedIndex,
      actualIndex,
    ])).toEqual([[0, 0]]);
    expect(first.unmatchedExpected.map(({ index }) => index)).toEqual([1]);
  });

  it('separates a detected super-span from a strict miss', () => {
    const testCase = customDefinition(
      'super-span-case',
      'Keep this synthetic item.',
      [{
        content: 'Keep this',
        kind: 'constraint',
        critical: true,
      }],
    );
    const actual: BenchmarkItem = {
      content: testCase.message,
      kind: 'constraint',
      critical: true,
    };
    const result = evaluateBenchmark([testCase], [output(testCase.id, [actual])]);

    expect(result.strictItem).toEqual({
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
      precision: rate(0, 1),
      recall: rate(0, 1),
      f1: rate(0, 2),
    });
    expect(result.detection).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: rate(1, 1),
      recall: rate(1, 1),
      f1: rate(2, 2),
    });
    expect(result.spanRates['actual-super-span']).toEqual(rate(1, 1));
    expect(result.kindAccuracy).toEqual({
      correct: 1,
      total: 1,
      accuracy: rate(1, 1),
    });
  });

  it('builds a kind confusion matrix from matched pairs only', () => {
    const expected: BenchmarkItem[] = [
      { content: 'goal text', kind: 'goal', critical: false },
      { content: 'constraint text', kind: 'constraint', critical: false },
    ];
    const actual: BenchmarkItem[] = [
      { content: 'goal text', kind: 'constraint', critical: false },
      { content: 'constraint text', kind: 'constraint', critical: false },
    ];
    const testCase = customDefinition(
      'kind-matrix-case',
      'goal text and constraint text',
      expected,
    );
    const result = evaluateBenchmark([testCase], [output(testCase.id, actual)]);

    expect(result.kindAccuracy).toEqual({
      correct: 1,
      total: 2,
      accuracy: rate(1, 2),
    });
    expect(result.kindConfusionMatrix).toEqual({
      goal: { constraint: 1 },
      constraint: { constraint: 1 },
    });
  });

  it('reports false-critical and missed-critical counts among matches', () => {
    const expected: BenchmarkItem[] = [
      { content: 'critical item', kind: 'constraint', critical: true },
      { content: 'optional item', kind: 'constraint', critical: false },
    ];
    const actual: BenchmarkItem[] = [
      { content: 'critical item', kind: 'constraint', critical: false },
      { content: 'optional item', kind: 'constraint', critical: true },
    ];
    const testCase = customDefinition(
      'critical-matrix-case',
      'critical item and optional item',
      expected,
    );
    const result = evaluateBenchmark([testCase], [output(testCase.id, actual)]);

    expect(result.critical).toEqual({
      truePositives: 0,
      falseCritical: 1,
      missedCritical: 1,
      correct: 0,
      total: 2,
      precision: rate(0, 1),
      recall: rate(0, 1),
      accuracy: rate(0, 2),
    });
  });

  it('reports negative rejection accuracy over no-add cases', () => {
    const rejected = definition('negative-rejected', []);
    const notRejected = customDefinition(
      'negative-not-rejected',
      'This message contains a durable-looking add.',
      [],
      { expectNoAdds: true },
    );
    const extra: BenchmarkItem = {
      content: 'durable-looking add',
      kind: 'goal',
      critical: false,
    };
    const result = evaluateBenchmark(
      [rejected, notRejected],
      [output(rejected.id, []), output(notRejected.id, [extra])],
    );

    expect(result.negativeRejection).toEqual({
      correct: 1,
      total: 2,
      accuracy: rate(1, 2),
    });
  });

  it('reports supersession retirement and replacement detection', () => {
    const detected = customDefinition(
      'supersession-detected',
      'Replace the old plan with the new plan.',
      [{ content: 'new plan', kind: 'decision', critical: true }],
      {
        category: 'supersession',
        expectedRetirements: ['auto:old-plan'],
      },
    );
    const missed = customDefinition(
      'supersession-missed',
      'Replace the old plan with the revised plan.',
      [{ content: 'revised plan', kind: 'decision', critical: true }],
      {
        category: 'supersession',
        expectedRetirements: ['auto:old-plan-2'],
      },
    );
    const result = evaluateBenchmark(
      [detected, missed],
      [
        output(detected.id, [{
          content: 'new plan',
          kind: 'decision',
          critical: true,
        }], 'success', ['auto:old-plan']),
        output(missed.id, []),
      ],
    );

    expect(result.retirements).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 1,
      precision: rate(1, 1),
      recall: rate(1, 2),
      f1: rate(2, 3),
    });
    expect(result.supersession.replacementDetection).toEqual({
      correct: 1,
      total: 2,
      accuracy: rate(1, 2),
    });
  });

  it('treats content absent from the message as unmatched', () => {
    const missing: BenchmarkItem = {
      content: 'not in this message',
      kind: 'goal',
      critical: false,
    };
    const testCase = customDefinition(
      'missing-content-case',
      'The message has no matching span.',
      [missing],
    );
    const result = evaluateBenchmark(
      [testCase],
      [output(testCase.id, [missing])],
    );

    expect(result.strictItem).toEqual({
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
      precision: rate(0, 1),
      recall: rate(0, 1),
      f1: rate(0, 2),
    });
    expect(result.detection).toEqual({
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
      precision: rate(0, 1),
      recall: rate(0, 1),
      f1: rate(0, 2),
    });
  });
});
