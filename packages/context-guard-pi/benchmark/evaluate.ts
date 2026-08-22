import type {
  BenchmarkCase,
  BenchmarkItem,
} from './corpus.js';

export type BenchmarkOutcome =
  | 'success'
  | 'timeout'
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output'
  | 'stale';

export interface ParsedExtractionOutput {
  readonly caseId: string;
  readonly outcome: BenchmarkOutcome;
  readonly add: readonly BenchmarkItem[];
  readonly removeAutoItemIds: readonly string[];
}

export interface MetricSummary {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface AccuracySummary {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: number;
}

export interface CaseItem {
  readonly caseId: string;
  readonly item: BenchmarkItem;
}

interface ScoredCase {
  readonly definition: BenchmarkCase;
  readonly output: ParsedExtractionOutput;
}

export interface BenchmarkEvaluation {
  readonly totalCases: number;
  readonly qualityCaseCount: number;
  readonly providerFailures: readonly string[];
  readonly item: MetricSummary;
  readonly retirements: MetricSummary;
  readonly kindAccuracy: AccuracySummary;
  readonly criticalAccuracy: AccuracySummary;
  readonly falsePositives: readonly CaseItem[];
  readonly falseNegatives: readonly CaseItem[];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function metricSummary(
  truePositives: number,
  falsePositives: number,
  falseNegatives: number,
): MetricSummary {
  const precision = rate(truePositives, truePositives + falsePositives);
  const recall = rate(truePositives, truePositives + falseNegatives);
  const f1 = precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
  };
}

function itemKey(item: Pick<BenchmarkItem, 'kind' | 'content'>): string {
  return JSON.stringify([item.kind, item.content]);
}

function matchItems(
  caseId: string,
  expected: readonly BenchmarkItem[],
  actual: readonly BenchmarkItem[],
): {
  readonly metric: MetricSummary;
  readonly falsePositives: readonly CaseItem[];
  readonly falseNegatives: readonly CaseItem[];
} {
  const remainingExpected = new Map<string, number>();
  for (const item of expected) {
    const key = itemKey(item);
    remainingExpected.set(key, (remainingExpected.get(key) ?? 0) + 1);
  }

  let truePositives = 0;
  const falsePositives: CaseItem[] = [];
  for (const item of actual) {
    const key = itemKey(item);
    const remaining = remainingExpected.get(key) ?? 0;
    if (remaining === 0) {
      falsePositives.push({ caseId, item });
    } else {
      truePositives += 1;
      remainingExpected.set(key, remaining - 1);
    }
  }

  const falseNegatives: CaseItem[] = [];
  for (const item of expected) {
    const key = itemKey(item);
    const matched = remainingExpected.get(key) ?? 0;
    if (matched === 0) {
      continue;
    }
    falseNegatives.push({ caseId, item });
    remainingExpected.set(key, matched - 1);
  }

  return {
    metric: metricSummary(
      truePositives,
      falsePositives.length,
      falseNegatives.length,
    ),
    falsePositives,
    falseNegatives,
  };
}

function matchStrings(
  expected: readonly string[],
  actual: readonly string[],
): MetricSummary {
  const remainingExpected = new Map<string, number>();
  for (const value of expected) {
    remainingExpected.set(value, (remainingExpected.get(value) ?? 0) + 1);
  }

  let truePositives = 0;
  let falsePositives = 0;
  for (const value of actual) {
    const remaining = remainingExpected.get(value) ?? 0;
    if (remaining === 0) {
      falsePositives += 1;
    } else {
      truePositives += 1;
      remainingExpected.set(value, remaining - 1);
    }
  }

  let falseNegatives = 0;
  for (const value of expected) {
    const remaining = remainingExpected.get(value) ?? 0;
    if (remaining > 0) {
      falseNegatives += 1;
      remainingExpected.set(value, remaining - 1);
    }
  }

  return metricSummary(truePositives, falsePositives, falseNegatives);
}

function accuracyByField(
  scoredCases: readonly ScoredCase[],
  field: 'kind' | 'critical',
): AccuracySummary {
  let correct = 0;
  let total = 0;

  for (const { definition, output } of scoredCases) {
    const predictionsByContent = new Map<string, BenchmarkItem[]>();
    for (const item of output.add) {
      const predictions = predictionsByContent.get(item.content) ?? [];
      predictions.push(item);
      predictionsByContent.set(item.content, predictions);
    }

    for (const expected of definition.expectedAdds) {
      total += 1;
      const predictions = predictionsByContent.get(expected.content);
      const prediction = predictions?.shift();
      if (prediction !== undefined && prediction[field] === expected[field]) {
        correct += 1;
      }
    }
  }

  return {
    correct,
    total,
    accuracy: rate(correct, total),
  };
}

function emptyOutput(caseId: string): ParsedExtractionOutput {
  return {
    caseId,
    outcome: 'invalid-output',
    add: [],
    removeAutoItemIds: [],
  };
}

export function evaluateBenchmark(
  cases: readonly BenchmarkCase[],
  outputs: readonly ParsedExtractionOutput[],
): BenchmarkEvaluation {
  const outputByCaseId = new Map(
    outputs.map((output) => [output.caseId, output]),
  );
  const scoredCases = cases.map((definition) => ({
    definition,
    output: outputByCaseId.get(definition.id) ?? emptyOutput(definition.id),
  }));
  const qualityCases = scoredCases.filter(
    ({ output }) => output.outcome !== 'provider',
  );
  const providerFailures = scoredCases.flatMap(({ definition, output }) =>
    output.outcome === 'provider' ? [definition.id] : [],
  );

  let itemTruePositives = 0;
  let itemFalsePositives = 0;
  let itemFalseNegatives = 0;
  const falsePositives: CaseItem[] = [];
  const falseNegatives: CaseItem[] = [];
  let retirement = metricSummary(0, 0, 0);

  for (const { definition, output } of qualityCases) {
    const itemMatch = matchItems(
      definition.id,
      definition.expectedAdds,
      output.add,
    );
    itemTruePositives += itemMatch.metric.truePositives;
    itemFalsePositives += itemMatch.metric.falsePositives;
    itemFalseNegatives += itemMatch.metric.falseNegatives;
    falsePositives.push(...itemMatch.falsePositives);
    falseNegatives.push(...itemMatch.falseNegatives);

    const retirementMatch = matchStrings(
      definition.expectedRetirements,
      output.removeAutoItemIds,
    );
    retirement = metricSummary(
      retirement.truePositives + retirementMatch.truePositives,
      retirement.falsePositives + retirementMatch.falsePositives,
      retirement.falseNegatives + retirementMatch.falseNegatives,
    );
  }

  return {
    totalCases: cases.length,
    qualityCaseCount: qualityCases.length,
    providerFailures,
    item: metricSummary(
      itemTruePositives,
      itemFalsePositives,
      itemFalseNegatives,
    ),
    retirements: retirement,
    kindAccuracy: accuracyByField(qualityCases, 'kind'),
    criticalAccuracy: accuracyByField(qualityCases, 'critical'),
    falsePositives,
    falseNegatives,
  };
}
