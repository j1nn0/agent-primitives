import type {
  BenchmarkCase,
  BenchmarkItem,
  BenchmarkKind,
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

export type SpanRelation =
  | 'exact'
  | 'actual-super-span'
  | 'actual-sub-span'
  | 'partial-overlap'
  | 'disjoint';

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface MetricSummary {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: RateSummary;
  readonly recall: RateSummary;
  readonly f1: RateSummary;
}

export interface AccuracySummary {
  readonly correct: number;
  readonly total: number;
  readonly accuracy: RateSummary;
}

export interface CriticalSummary {
  readonly truePositives: number;
  readonly falseCritical: number;
  readonly missedCritical: number;
  readonly correct: number;
  readonly total: number;
  readonly precision: RateSummary;
  readonly recall: RateSummary;
  readonly accuracy: RateSummary;
}

export type KindConfusionMatrix = Partial<
  Record<BenchmarkKind, Partial<Record<BenchmarkKind, number>>>
>;

export interface SpanRates {
  readonly exact: RateSummary;
  readonly 'actual-super-span': RateSummary;
  readonly 'actual-sub-span': RateSummary;
  readonly 'partial-overlap': RateSummary;
}

export interface CaseItem {
  readonly caseId: string;
  readonly item: BenchmarkItem;
}

export interface IndexedItem {
  readonly index: number;
  readonly item: BenchmarkItem;
}

interface ItemMatch {
  readonly expectedIndex: number;
  readonly actualIndex: number;
  readonly expected: BenchmarkItem;
  readonly actual: BenchmarkItem;
  readonly expectedSpan: TextSpan;
  readonly actualSpan: TextSpan;
  readonly relation: Exclude<SpanRelation, 'disjoint'>;
}

export interface ItemMatching {
  readonly matches: readonly ItemMatch[];
  readonly unmatchedExpected: readonly IndexedItem[];
  readonly unmatchedActual: readonly IndexedItem[];
}

interface StrictMatch {
  readonly metric: MetricSummary;
  readonly falsePositives: readonly CaseItem[];
  readonly falseNegatives: readonly CaseItem[];
}

interface SupersessionSummary {
  readonly replacementDetection: AccuracySummary;
}

export interface BenchmarkEvaluation {
  readonly totalCases: number;
  readonly qualityCaseCount: number;
  readonly providerFailures: readonly string[];
  readonly strictItem: MetricSummary;
  readonly detection: MetricSummary;
  readonly spanRates: SpanRates;
  readonly kindAccuracy: AccuracySummary;
  readonly kindConfusionMatrix: KindConfusionMatrix;
  readonly critical: CriticalSummary;
  /** Compatibility view of the accuracy portion of critical. */
  readonly criticalAccuracy: AccuracySummary;
  readonly negativeRejection: AccuracySummary;
  readonly retirements: MetricSummary;
  readonly supersession: SupersessionSummary;
  readonly falsePositives: readonly CaseItem[];
  readonly falseNegatives: readonly CaseItem[];
}

const RELATION_RANK: Record<SpanRelation, number> = {
  exact: 0,
  'actual-super-span': 1,
  'actual-sub-span': 1,
  'partial-overlap': 2,
  disjoint: 3,
};

function rateSummary(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function metricSummary(
  truePositives: number,
  falsePositives: number,
  falseNegatives: number,
): MetricSummary {
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: rateSummary(truePositives, truePositives + falsePositives),
    recall: rateSummary(truePositives, truePositives + falseNegatives),
    f1: rateSummary(
      2 * truePositives,
      2 * truePositives + falsePositives + falseNegatives,
    ),
  };
}

function accuracySummary(correct: number, total: number): AccuracySummary {
  return {
    correct,
    total,
    accuracy: rateSummary(correct, total),
  };
}

function itemKey(item: Pick<BenchmarkItem, 'kind' | 'content'>): string {
  return JSON.stringify([item.kind, item.content]);
}

function locateContent(
  message: string,
  content: string,
): TextSpan | undefined {
  const start = message.indexOf(content);
  return start < 0
    ? undefined
    : { start, end: start + content.length };
}

export function spanRelation(
  expected: TextSpan,
  actual: TextSpan,
): SpanRelation {
  if (expected.start === actual.start && expected.end === actual.end) {
    return 'exact';
  }

  const overlaps = expected.start < actual.end && actual.start < expected.end;
  if (!overlaps) {
    return 'disjoint';
  }

  if (actual.start <= expected.start && actual.end >= expected.end) {
    return 'actual-super-span';
  }
  if (expected.start <= actual.start && expected.end >= actual.end) {
    return 'actual-sub-span';
  }
  return 'partial-overlap';
}


function overlapLength(expected: TextSpan, actual: TextSpan): number {
  return Math.max(
    0,
    Math.min(expected.end, actual.end) - Math.max(expected.start, actual.start),
  );
}

interface LocatedItem extends IndexedItem {
  readonly span: TextSpan;
}

function locateItems(
  message: string,
  items: readonly BenchmarkItem[],
): LocatedItem[] {
  const located: LocatedItem[] = [];
  items.forEach((item, index) => {
    const span = locateContent(message, item.content);
    if (span !== undefined) {
      located.push({ index, item, span });
    }
  });
  return located;
}

interface SpanCandidate {
  readonly expected: LocatedItem;
  readonly actual: LocatedItem;
  readonly relation: Exclude<SpanRelation, 'disjoint'>;
  readonly overlap: number;
}

export function matchItemsBySpan(
  message: string,
  expected: readonly BenchmarkItem[],
  actual: readonly BenchmarkItem[],
): ItemMatching {
  const locatedExpected = locateItems(message, expected);
  const locatedActual = locateItems(message, actual);
  const candidates: SpanCandidate[] = [];

  for (const expectedItem of locatedExpected) {
    for (const actualItem of locatedActual) {
      const relation = spanRelation(expectedItem.span, actualItem.span);
      if (relation === 'disjoint') {
        continue;
      }
      candidates.push({
        expected: expectedItem,
        actual: actualItem,
        relation,
        overlap: overlapLength(expectedItem.span, actualItem.span),
      });
    }
  }

  candidates.sort((left, right) => {
    const relationDifference =
      RELATION_RANK[left.relation] - RELATION_RANK[right.relation];
    if (relationDifference !== 0) {
      return relationDifference;
    }

    const overlapDifference = right.overlap - left.overlap;
    if (overlapDifference !== 0) {
      return overlapDifference;
    }

    const expectedDifference =
      left.expected.index - right.expected.index;
    if (expectedDifference !== 0) {
      return expectedDifference;
    }
    return left.actual.index - right.actual.index;
  });

  const matchedExpected = new Set<number>();
  const matchedActual = new Set<number>();
  const matches: ItemMatch[] = [];
  for (const candidate of candidates) {
    if (
      matchedExpected.has(candidate.expected.index) ||
      matchedActual.has(candidate.actual.index)
    ) {
      continue;
    }

    matchedExpected.add(candidate.expected.index);
    matchedActual.add(candidate.actual.index);
    matches.push({
      expectedIndex: candidate.expected.index,
      actualIndex: candidate.actual.index,
      expected: candidate.expected.item,
      actual: candidate.actual.item,
      expectedSpan: candidate.expected.span,
      actualSpan: candidate.actual.span,
      relation: candidate.relation,
    });
  }

  return {
    matches,
    unmatchedExpected: expected.map((item, index) => ({
      index,
      item,
    })).filter(({ index }) => !matchedExpected.has(index)),
    unmatchedActual: actual.map((item, index) => ({
      index,
      item,
    })).filter(({ index }) => !matchedActual.has(index)),
  };
}

function matchStrictItems(
  caseId: string,
  message: string,
  expected: readonly BenchmarkItem[],
  actual: readonly BenchmarkItem[],
): StrictMatch {
  const expectedSpans = expected.map((item) =>
    locateContent(message, item.content),
  );
  const actualSpans = actual.map((item) => locateContent(message, item.content));
  const remainingExpected = new Map<string, number>();

  expected.forEach((item, index) => {
    if (expectedSpans[index] !== undefined) {
      const key = itemKey(item);
      remainingExpected.set(key, (remainingExpected.get(key) ?? 0) + 1);
    }
  });

  let truePositives = 0;
  const falsePositives: CaseItem[] = [];
  actual.forEach((item, index) => {
    if (actualSpans[index] === undefined) {
      falsePositives.push({ caseId, item });
      return;
    }

    const key = itemKey(item);
    const remaining = remainingExpected.get(key) ?? 0;
    if (remaining === 0) {
      falsePositives.push({ caseId, item });
    } else {
      truePositives += 1;
      remainingExpected.set(key, remaining - 1);
    }
  });

  const falseNegatives: CaseItem[] = [];
  expected.forEach((item, index) => {
    if (expectedSpans[index] === undefined) {
      falseNegatives.push({ caseId, item });
      return;
    }

    const key = itemKey(item);
    const remaining = remainingExpected.get(key) ?? 0;
    if (remaining === 0) {
      return;
    }
    falseNegatives.push({ caseId, item });
    remainingExpected.set(key, remaining - 1);
  });

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

interface QualityCaseScore {
  readonly matching: ItemMatching;
  readonly strict: StrictMatch;
  readonly retirements: MetricSummary;
}

interface EvaluationAccumulator {
  strictTruePositives: number;
  strictFalsePositives: number;
  strictFalseNegatives: number;
  detectionTruePositives: number;
  detectionFalsePositives: number;
  detectionFalseNegatives: number;
  retirementTruePositives: number;
  retirementFalsePositives: number;
  retirementFalseNegatives: number;
  matchedTotal: number;
  kindCorrect: number;
  criticalTruePositives: number;
  falseCritical: number;
  missedCritical: number;
  criticalCorrect: number;
  negativeCorrect: number;
  negativeTotal: number;
  replacementDetected: number;
  replacementTotal: number;
  falsePositives: CaseItem[];
  falseNegatives: CaseItem[];
  spanCounts: Record<Exclude<SpanRelation, 'disjoint'>, number>;
  kindConfusionMatrix: KindConfusionMatrix;
}

function emptyAccumulator(): EvaluationAccumulator {
  return {
    strictTruePositives: 0,
    strictFalsePositives: 0,
    strictFalseNegatives: 0,
    detectionTruePositives: 0,
    detectionFalsePositives: 0,
    detectionFalseNegatives: 0,
    retirementTruePositives: 0,
    retirementFalsePositives: 0,
    retirementFalseNegatives: 0,
    matchedTotal: 0,
    kindCorrect: 0,
    criticalTruePositives: 0,
    falseCritical: 0,
    missedCritical: 0,
    criticalCorrect: 0,
    negativeCorrect: 0,
    negativeTotal: 0,
    replacementDetected: 0,
    replacementTotal: 0,
    falsePositives: [],
    falseNegatives: [],
    spanCounts: {
      exact: 0,
      'actual-super-span': 0,
      'actual-sub-span': 0,
      'partial-overlap': 0,
    },
    kindConfusionMatrix: {},
  };
}

function scoreQualityCase(
  definition: BenchmarkCase,
  output: ParsedExtractionOutput,
): QualityCaseScore {
  const matching = matchItemsBySpan(
    definition.message,
    definition.expectedAdds,
    output.add,
  );
  return {
    matching,
    strict: matchStrictItems(
      definition.id,
      definition.message,
      definition.expectedAdds,
      output.add,
    ),
    retirements: matchStrings(
      definition.expectedRetirements,
      output.removeAutoItemIds,
    ),
  };
}

function accumulateMatches(
  matches: readonly ItemMatch[],
  accumulator: EvaluationAccumulator,
): void {
  for (const match of matches) {
    accumulator.matchedTotal += 1;
    accumulator.spanCounts[match.relation] += 1;

    if (match.expected.kind === match.actual.kind) {
      accumulator.kindCorrect += 1;
    }
    const expectedRow = accumulator.kindConfusionMatrix[match.expected.kind] ?? {};
    expectedRow[match.actual.kind] =
      (expectedRow[match.actual.kind] ?? 0) + 1;
    accumulator.kindConfusionMatrix[match.expected.kind] = expectedRow;

    if (match.expected.critical === match.actual.critical) {
      accumulator.criticalCorrect += 1;
    }
    if (match.expected.critical && match.actual.critical) {
      accumulator.criticalTruePositives += 1;
    } else if (!match.expected.critical && match.actual.critical) {
      accumulator.falseCritical += 1;
    } else if (match.expected.critical && !match.actual.critical) {
      accumulator.missedCritical += 1;
    }
  }
}

function emptyOutput(caseId: string): ParsedExtractionOutput {
  return {
    caseId,
    outcome: 'invalid-output',
    add: [],
    removeAutoItemIds: [],
  };
}

function spanRates(
  counts: Readonly<Record<Exclude<SpanRelation, 'disjoint'>, number>>,
  total: number,
): SpanRates {
  return {
    exact: rateSummary(counts.exact, total),
    'actual-super-span': rateSummary(counts['actual-super-span'], total),
    'actual-sub-span': rateSummary(counts['actual-sub-span'], total),
    'partial-overlap': rateSummary(counts['partial-overlap'], total),
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
  const accumulator = emptyAccumulator();

  for (const { definition, output } of qualityCases) {
    const score = scoreQualityCase(definition, output);
    accumulator.strictTruePositives += score.strict.metric.truePositives;
    accumulator.strictFalsePositives += score.strict.metric.falsePositives;
    accumulator.strictFalseNegatives += score.strict.metric.falseNegatives;
    accumulator.falsePositives.push(...score.strict.falsePositives);
    accumulator.falseNegatives.push(...score.strict.falseNegatives);
    accumulator.detectionTruePositives += score.matching.matches.length;
    accumulator.detectionFalsePositives += score.matching.unmatchedActual.length;
    accumulator.detectionFalseNegatives += score.matching.unmatchedExpected.length;
    accumulator.retirementTruePositives += score.retirements.truePositives;
    accumulator.retirementFalsePositives += score.retirements.falsePositives;
    accumulator.retirementFalseNegatives += score.retirements.falseNegatives;
    accumulateMatches(score.matching.matches, accumulator);

    if (definition.expectNoAdds) {
      accumulator.negativeTotal += 1;
      if (output.add.length === 0) {
        accumulator.negativeCorrect += 1;
      }
    }
    if (definition.category === 'supersession') {
      accumulator.replacementTotal += 1;
      if (score.matching.matches.length > 0) {
        accumulator.replacementDetected += 1;
      }
    }
  }

  const critical: CriticalSummary = {
    truePositives: accumulator.criticalTruePositives,
    falseCritical: accumulator.falseCritical,
    missedCritical: accumulator.missedCritical,
    correct: accumulator.criticalCorrect,
    total: accumulator.matchedTotal,
    precision: rateSummary(
      accumulator.criticalTruePositives,
      accumulator.criticalTruePositives + accumulator.falseCritical,
    ),
    recall: rateSummary(
      accumulator.criticalTruePositives,
      accumulator.criticalTruePositives + accumulator.missedCritical,
    ),
    accuracy: rateSummary(
      accumulator.criticalCorrect,
      accumulator.matchedTotal,
    ),
  };
  const retirements = metricSummary(
    accumulator.retirementTruePositives,
    accumulator.retirementFalsePositives,
    accumulator.retirementFalseNegatives,
  );

  return {
    totalCases: cases.length,
    qualityCaseCount: qualityCases.length,
    providerFailures,
    strictItem: metricSummary(
      accumulator.strictTruePositives,
      accumulator.strictFalsePositives,
      accumulator.strictFalseNegatives,
    ),
    detection: metricSummary(
      accumulator.detectionTruePositives,
      accumulator.detectionFalsePositives,
      accumulator.detectionFalseNegatives,
    ),
    spanRates: spanRates(accumulator.spanCounts, accumulator.matchedTotal),
    kindAccuracy: accuracySummary(
      accumulator.kindCorrect,
      accumulator.matchedTotal,
    ),
    kindConfusionMatrix: accumulator.kindConfusionMatrix,
    critical,
    criticalAccuracy: {
      correct: critical.correct,
      total: critical.total,
      accuracy: critical.accuracy,
    },
    negativeRejection: accuracySummary(
      accumulator.negativeCorrect,
      accumulator.negativeTotal,
    ),
    retirements,
    supersession: {
      replacementDetection: accuracySummary(
        accumulator.replacementDetected,
        accumulator.replacementTotal,
      ),
    },
    falsePositives: accumulator.falsePositives,
    falseNegatives: accumulator.falseNegatives,
  };
}
