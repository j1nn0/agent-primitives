import {
  findSupersessionCandidates,
  type DiscoveryAnchor,
  type DiscoveryAnchorCategory,
} from '../src/discovery-candidates.js';
import {
  CANDIDATE_BENCHMARK_CORPUS,
  type CandidateBenchmarkCase,
} from './candidate-corpus.js';

export const CANDIDATE_ANCHOR_CATEGORIES: readonly DiscoveryAnchorCategory[] = [
  'path',
  'opaque-id',
  'versioned-subject',
];

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface CandidateMetricSummary {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: RateSummary;
  readonly recall: RateSummary;
}

export interface CandidateFalsePositiveDiagnostic {
  readonly caseId: string;
  /** The produced group, represented by its sorted item ids. */
  readonly group: readonly string[];
  /** Anchors that caused the produced group. */
  readonly anchors: readonly DiscoveryAnchor[];
}

export interface CandidateCategoryEvaluation extends CandidateMetricSummary {
  readonly highRiskFalsePositives: number;
}

export interface CandidateEvaluation extends CandidateMetricSummary {
  readonly totalCases: number;
  readonly categories: readonly DiscoveryAnchorCategory[];
  readonly highRiskFalsePositives: number;
  readonly diagnostics: readonly CandidateFalsePositiveDiagnostic[];
  readonly categoryBreakdown: Readonly<
    Record<DiscoveryAnchorCategory, CandidateCategoryEvaluation>
  >;
}

interface EvaluationAccumulator {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  highRiskFalsePositives: number;
  diagnostics: CandidateFalsePositiveDiagnostic[];
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalCategories(
  categories: readonly DiscoveryAnchorCategory[],
): readonly DiscoveryAnchorCategory[] {
  return CANDIDATE_ANCHOR_CATEGORIES.filter((category) =>
    categories.includes(category),
  );
}

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
): CandidateMetricSummary {
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: rateSummary(truePositives, truePositives + falsePositives),
    recall: rateSummary(truePositives, truePositives + falseNegatives),
  };
}

function sortedUniqueIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort(compareStrings);
}

function groupKey(ids: readonly string[]): string {
  return JSON.stringify(sortedUniqueIds(ids));
}

function emptyAccumulator(): EvaluationAccumulator {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    highRiskFalsePositives: 0,
    diagnostics: [],
  };
}

function sortedCases(
  cases: readonly CandidateBenchmarkCase[],
): readonly CandidateBenchmarkCase[] {
  return [...cases].sort((left, right) => compareStrings(left.id, right.id));
}

function evaluateCases(
  cases: readonly CandidateBenchmarkCase[],
  categories: readonly DiscoveryAnchorCategory[],
): EvaluationAccumulator {
  const accumulator = emptyAccumulator();
  for (const testCase of sortedCases(cases)) {
    const produced = findSupersessionCandidates(testCase.items, categories);
    const expectedKeys = new Set(
      testCase.expectedGroups.map((expectedGroup) => groupKey(expectedGroup)),
    );
    const producedKeys = new Set<string>();

    for (const candidate of produced) {
      const key = groupKey(candidate.itemIds);
      producedKeys.add(key);
      if (expectedKeys.has(key)) {
        accumulator.truePositives += 1;
        continue;
      }

      accumulator.falsePositives += 1;
      if (testCase.highRisk) {
        accumulator.highRiskFalsePositives += 1;
      }
      accumulator.diagnostics.push({
        caseId: testCase.id,
        group: candidate.itemIds,
        anchors: candidate.anchors,
      });
    }

    for (const expectedGroup of testCase.expectedGroups) {
      if (!producedKeys.has(groupKey(expectedGroup))) {
        accumulator.falseNegatives += 1;
      }
    }
  }
  return accumulator;
}

function categoryEvaluation(
  cases: readonly CandidateBenchmarkCase[],
  category: DiscoveryAnchorCategory,
): CandidateCategoryEvaluation {
  const accumulator = evaluateCases(cases, [category]);
  return {
    ...metricSummary(
      accumulator.truePositives,
      accumulator.falsePositives,
      accumulator.falseNegatives,
    ),
    highRiskFalsePositives: accumulator.highRiskFalsePositives,
  };
}

export function evaluateCandidateBenchmark(
  categories?: readonly DiscoveryAnchorCategory[],
  cases?: readonly CandidateBenchmarkCase[],
): CandidateEvaluation;
export function evaluateCandidateBenchmark(
  cases: readonly CandidateBenchmarkCase[],
  categories?: readonly DiscoveryAnchorCategory[],
): CandidateEvaluation;
export function evaluateCandidateBenchmark(
  first: readonly DiscoveryAnchorCategory[] | readonly CandidateBenchmarkCase[] =
    CANDIDATE_ANCHOR_CATEGORIES,
  second?: readonly CandidateBenchmarkCase[] | readonly DiscoveryAnchorCategory[],
): CandidateEvaluation {
  const firstEntry = first[0];
  const firstIsCases =
    typeof firstEntry === 'object' && firstEntry !== null;
  const cases = firstIsCases
    ? (first as readonly CandidateBenchmarkCase[])
    : second === undefined
      ? CANDIDATE_BENCHMARK_CORPUS
      : (second as readonly CandidateBenchmarkCase[]);
  const categories = firstIsCases
    ? second === undefined
      ? CANDIDATE_ANCHOR_CATEGORIES
      : (second as readonly DiscoveryAnchorCategory[])
    : (first as readonly DiscoveryAnchorCategory[]);
  const enabledCategories = canonicalCategories(categories);
  const accumulator = evaluateCases(cases, enabledCategories);
  const categoryBreakdown = {} as Record<
    DiscoveryAnchorCategory,
    CandidateCategoryEvaluation
  >;
  for (const category of CANDIDATE_ANCHOR_CATEGORIES) {
    categoryBreakdown[category] = categoryEvaluation(cases, category);
  }

  return {
    ...metricSummary(
      accumulator.truePositives,
      accumulator.falsePositives,
      accumulator.falseNegatives,
    ),
    totalCases: cases.length,
    categories: enabledCategories,
    highRiskFalsePositives: accumulator.highRiskFalsePositives,
    diagnostics: accumulator.diagnostics,
    categoryBreakdown,
  };
}

export function evaluateCandidateCategory(
  category: DiscoveryAnchorCategory,
  cases: readonly CandidateBenchmarkCase[] = CANDIDATE_BENCHMARK_CORPUS,
): CandidateEvaluation {
  return evaluateCandidateBenchmark([category], cases);
}
