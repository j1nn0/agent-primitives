import {
  SEMANTIC_DUPLICATE_CORPUS,
  type SemanticLabel,
  type SemanticPair,
} from './semantic-duplicate-corpus.js';

export type SemanticApproach =
  | 'normalized-string'
  | 'normalized-token-set'
  | 'token-overlap';
export type SemanticThreshold = 0.5 | 0.6 | 0.7 | 0.8;
export type FalseDuplicateLabel = Exclude<SemanticLabel, 'duplicate' | 'ambiguous'>;
export type SemanticLanguage = SemanticPair['language'];

export const TOKEN_OVERLAP_THRESHOLDS: readonly SemanticThreshold[] = [
  0.5,
  0.6,
  0.7,
  0.8,
];

export const SEMANTIC_APPROACHES: readonly SemanticApproach[] = [
  'normalized-string',
  'normalized-token-set',
  'token-overlap',
];

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface SemanticFalseDuplicateDiagnostic {
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly label: SemanticLabel;
}

export interface SemanticLanguageEvaluation {
  readonly pairCount: number;
  readonly evaluatedPairCount: number;
  readonly ambiguousCount: number;
  readonly trueDuplicateCount: number;
  readonly duplicatePrecision: RateSummary;
  readonly duplicateRecall: RateSummary;
  readonly duplicateF1: RateSummary;
  readonly falseDuplicateCount: number;
  readonly hardNegativeFalseDuplicateCount: number;
}

export interface SemanticEvaluation {
  readonly approach: SemanticApproach;
  readonly threshold: SemanticThreshold | null;
  readonly totalPairs: number;
  readonly ambiguousCount: number;
  readonly duplicatePrecision: RateSummary;
  readonly duplicateRecall: RateSummary;
  readonly duplicateF1: RateSummary;
  readonly falseDuplicateCount: number;
  readonly hardNegativeFalseDuplicateCount: number;
  readonly falseDuplicatesByLabel: Readonly<
    Record<FalseDuplicateLabel, number>
  >;
  readonly perLanguage: Readonly<
    Record<SemanticLanguage, SemanticLanguageEvaluation>
  >;
  readonly diagnostics: readonly SemanticFalseDuplicateDiagnostic[];
}

export interface SemanticDuplicateReport {
  readonly totalPairs: number;
  readonly ambiguousCount: number;
  readonly evaluations: readonly SemanticEvaluation[];
}

const CONTENTLESS_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'and',
  'or',
  'for',
  'with',
  'by',
  'that',
  'this',
  'it',
]);

const LANGUAGES: readonly SemanticLanguage[] = ['en', 'ja', 'mixed'];
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function rateSummary(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function metricRates(
  truePositives: number,
  falseDuplicates: number,
  falseNegatives: number,
): Pick<
  SemanticEvaluation,
  'duplicatePrecision' | 'duplicateRecall' | 'duplicateF1'
> {
  return {
    duplicatePrecision: rateSummary(
      truePositives,
      truePositives + falseDuplicates,
    ),
    duplicateRecall: rateSummary(
      truePositives,
      truePositives + falseNegatives,
    ),
    duplicateF1: rateSummary(
      2 * truePositives,
      2 * truePositives + falseDuplicates + falseNegatives,
    ),
  };
}

/** Lowercase, collapse whitespace, and remove punctuation at the edges. */
export function normalizeSemanticText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/^\p{P}+/u, '')
    .replace(/\p{P}+$/u, '')
    .trim();
}

function stripTokenPunctuation(token: string): string {
  return token
    .replace(/^\p{P}+/u, '')
    .replace(/\p{P}+$/u, '');
}

export function normalizedTokens(text: string): readonly string[] {
  return normalizeSemanticText(text)
    .split(/\s+/u)
    .map(stripTokenPunctuation)
    .filter((token) => token.length > 0);
}

export function normalizedTokenSet(text: string): ReadonlySet<string> {
  return new Set(normalizedTokens(text));
}

export function isNormalizedStringDuplicate(
  left: string,
  right: string,
): boolean {
  return normalizeSemanticText(left) === normalizeSemanticText(right);
}

export function isNormalizedTokenSetDuplicate(
  left: string,
  right: string,
): boolean {
  const leftTokens = normalizedTokenSet(left);
  const rightTokens = normalizedTokenSet(right);
  if (leftTokens.size !== rightTokens.size) {
    return false;
  }
  for (const token of leftTokens) {
    if (!rightTokens.has(token)) {
      return false;
    }
  }
  return true;
}

export function contentTokens(text: string): ReadonlySet<string> {
  const normalized = normalizeSemanticText(text);
  const tokens = new Set(
    normalizedTokens(normalized).filter(
      (token) => !CONTENTLESS_WORDS.has(token),
    ),
  );

  // Japanese text has no spaces, so character bigrams from non-ASCII runs are
  // included as tokens; otherwise Japanese pairs would be one opaque token.
  const nonAsciiRuns: string[] = [];
  let run = '';
  for (const character of normalized) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      run += character;
    } else if (run.length > 0) {
      nonAsciiRuns.push(run);
      run = '';
    }
  }
  if (run.length > 0) {
    nonAsciiRuns.push(run);
  }
  for (const nonAsciiRun of nonAsciiRuns) {
    for (let index = 0; index + 1 < nonAsciiRun.length; index += 1) {
      tokens.add(nonAsciiRun.slice(index, index + 2));
    }
  }
  return tokens;
}

export function tokenOverlapSimilarity(left: string, right: string): number {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 1 : intersection / union;
}

export function isTokenOverlapDuplicate(
  left: string,
  right: string,
  threshold: SemanticThreshold,
): boolean {
  return tokenOverlapSimilarity(left, right) > threshold;
}

interface PairCounts {
  readonly truePositives: number;
  readonly falseDuplicates: number;
  readonly falseNegatives: number;
  readonly hardNegativeFalseDuplicates: number;
  readonly falseDuplicatesByLabel: Record<FalseDuplicateLabel, number>;
  readonly diagnostics: readonly SemanticFalseDuplicateDiagnostic[];
}

function emptyFalseDuplicateBreakdown(): Record<FalseDuplicateLabel, number> {
  return {
    'same-subject-different': 0,
    'compatible-distinct': 0,
    contradictory: 0,
    unrelated: 0,
  };
}

function sortedPairs(pairs: readonly SemanticPair[]): readonly SemanticPair[] {
  return [...pairs].sort((left, right) => compareStrings(left.id, right.id));
}

function isFalseDuplicateLabel(
  label: SemanticLabel,
): label is FalseDuplicateLabel {
  return label !== 'duplicate' && label !== 'ambiguous';
}

function pairCounts(
  pairs: readonly SemanticPair[],
  predictsDuplicate: (pair: SemanticPair) => boolean,
): PairCounts {
  let truePositives = 0;
  let falseDuplicates = 0;
  let falseNegatives = 0;
  let hardNegativeFalseDuplicates = 0;
  const falseDuplicatesByLabel = emptyFalseDuplicateBreakdown();
  const diagnostics: SemanticFalseDuplicateDiagnostic[] = [];

  for (const pair of sortedPairs(pairs)) {
    const predicted = predictsDuplicate(pair);
    if (pair.label === 'ambiguous') {
      continue;
    }
    if (predicted && pair.label === 'duplicate') {
      truePositives += 1;
      continue;
    }
    if (predicted && isFalseDuplicateLabel(pair.label)) {
      falseDuplicates += 1;
      falseDuplicatesByLabel[pair.label] += 1;
      if (pair.hardNegative) {
        hardNegativeFalseDuplicates += 1;
      }
      diagnostics.push({
        id: pair.id,
        left: pair.left,
        right: pair.right,
        label: pair.label,
      });
      continue;
    }
    if (!predicted && pair.label === 'duplicate') {
      falseNegatives += 1;
    }
  }

  return {
    truePositives,
    falseDuplicates,
    falseNegatives,
    hardNegativeFalseDuplicates,
    falseDuplicatesByLabel,
    diagnostics,
  };
}

function predictWithApproach(
  pair: SemanticPair,
  approach: SemanticApproach,
  threshold: SemanticThreshold | null,
): boolean {
  switch (approach) {
    case 'normalized-string':
      return isNormalizedStringDuplicate(pair.left, pair.right);
    case 'normalized-token-set':
      return isNormalizedTokenSetDuplicate(pair.left, pair.right);
    case 'token-overlap':
      return isTokenOverlapDuplicate(pair.left, pair.right, threshold ?? 0.5);
  }
}

function languageEvaluation(
  pairs: readonly SemanticPair[],
  predictsDuplicate: (pair: SemanticPair) => boolean,
): SemanticLanguageEvaluation {
  const ambiguousCount = pairs.filter(
    (pair) => pair.label === 'ambiguous',
  ).length;
  const evaluatedPairCount = pairs.length - ambiguousCount;
  const trueDuplicateCount = pairs.filter(
    (pair) => pair.label === 'duplicate',
  ).length;
  const counts = pairCounts(pairs, predictsDuplicate);
  return {
    pairCount: pairs.length,
    evaluatedPairCount,
    ambiguousCount,
    trueDuplicateCount,
    ...metricRates(
      counts.truePositives,
      counts.falseDuplicates,
      counts.falseNegatives,
    ),
    falseDuplicateCount: counts.falseDuplicates,
    hardNegativeFalseDuplicateCount: counts.hardNegativeFalseDuplicates,
  };
}

export function evaluateSemanticApproach(
  pairs: readonly SemanticPair[],
  approach: SemanticApproach,
  threshold: SemanticThreshold | null = null,
): SemanticEvaluation {
  const effectiveThreshold = approach === 'token-overlap' ? threshold ?? 0.5 : null;
  const predictsDuplicate = (pair: SemanticPair): boolean =>
    predictWithApproach(pair, approach, effectiveThreshold);
  const counts = pairCounts(pairs, predictsDuplicate);
  const ambiguousCount = pairs.filter(
    (pair) => pair.label === 'ambiguous',
  ).length;
  const perLanguage = {} as Record<
    SemanticLanguage,
    SemanticLanguageEvaluation
  >;
  for (const language of LANGUAGES) {
    perLanguage[language] = languageEvaluation(
      pairs.filter((pair) => pair.language === language),
      predictsDuplicate,
    );
  }
  return {
    approach,
    threshold: effectiveThreshold,
    totalPairs: pairs.length,
    ambiguousCount,
    ...metricRates(
      counts.truePositives,
      counts.falseDuplicates,
      counts.falseNegatives,
    ),
    falseDuplicateCount: counts.falseDuplicates,
    hardNegativeFalseDuplicateCount: counts.hardNegativeFalseDuplicates,
    falseDuplicatesByLabel: counts.falseDuplicatesByLabel,
    perLanguage,
    diagnostics: counts.diagnostics,
  };
}

export function evaluateSemanticDuplicateBenchmark(
  pairs: readonly SemanticPair[] = SEMANTIC_DUPLICATE_CORPUS,
): SemanticDuplicateReport {
  const evaluations: SemanticEvaluation[] = [
    evaluateSemanticApproach(pairs, 'normalized-string'),
    evaluateSemanticApproach(pairs, 'normalized-token-set'),
    ...TOKEN_OVERLAP_THRESHOLDS.map((threshold) =>
      evaluateSemanticApproach(pairs, 'token-overlap', threshold),
    ),
  ];
  return {
    totalPairs: pairs.length,
    ambiguousCount: pairs.filter((pair) => pair.label === 'ambiguous').length,
    evaluations,
  };
}

export const evaluateSemanticDuplicates = evaluateSemanticDuplicateBenchmark;

export type SemanticClassification = Exclude<SemanticLabel, 'ambiguous'>;

export const SEMANTIC_CLASSIFICATIONS: readonly SemanticClassification[] = [
  'duplicate',
  'same-subject-different',
  'compatible-distinct',
  'contradictory',
  'unrelated',
];

const ALL_SEMANTIC_LABELS: readonly SemanticLabel[] = [
  ...SEMANTIC_CLASSIFICATIONS,
  'ambiguous',
];

export interface RecordedSemanticClassification {
  readonly pairId: string;
  readonly classification?: unknown;
}

export type SemanticUnclassifiedReason =
  | 'missing-classification'
  | 'unrecognized-classification'
  | 'unknown-pair';

export interface SemanticUnclassifiedPair {
  readonly pairId: string;
  readonly reason: SemanticUnclassifiedReason;
  readonly classification?: string;
}

export type SemanticConfusionMatrix = Readonly<
  Record<SemanticLabel, Readonly<Record<SemanticClassification, number>>>
>;

export interface SemanticReplayEvaluation
  extends Omit<SemanticEvaluation, 'approach' | 'threshold'> {
  readonly approach: 'model-replay';
  readonly threshold: null;
  readonly classifiedPairCount: number;
  readonly unclassifiedPairCount: number;
  readonly unclassifiedCount: number;
  readonly confusionMatrix: SemanticConfusionMatrix;
  readonly importantConfusions: Readonly<{
    readonly sameSubjectDifferentAsDuplicate: number;
    readonly contradictoryAsDuplicate: number;
  }>;
  readonly unclassified: readonly SemanticUnclassifiedPair[];
}

export function isSemanticClassification(
  value: unknown,
): value is SemanticClassification {
  return (
    typeof value === 'string' &&
    (SEMANTIC_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

interface ReplayPairCounts {
  readonly truePositives: number;
  readonly falseDuplicates: number;
  readonly falseNegatives: number;
  readonly hardNegativeFalseDuplicates: number;
  readonly falseDuplicatesByLabel: Record<FalseDuplicateLabel, number>;
  readonly diagnostics: readonly SemanticFalseDuplicateDiagnostic[];
}

function replayPairCounts(
  pairs: readonly SemanticPair[],
  predictions: ReadonlyMap<string, SemanticClassification>,
): ReplayPairCounts {
  let truePositives = 0;
  let falseDuplicates = 0;
  let falseNegatives = 0;
  let hardNegativeFalseDuplicates = 0;
  const falseDuplicatesByLabel = emptyFalseDuplicateBreakdown();
  const diagnostics: SemanticFalseDuplicateDiagnostic[] = [];

  for (const pair of sortedPairs(pairs)) {
    const predicted = predictions.get(pair.id);
    if (predicted === undefined || pair.label === 'ambiguous') {
      continue;
    }
    if (predicted === 'duplicate' && pair.label === 'duplicate') {
      truePositives += 1;
      continue;
    }
    if (predicted === 'duplicate' && isFalseDuplicateLabel(pair.label)) {
      falseDuplicates += 1;
      falseDuplicatesByLabel[pair.label] += 1;
      if (pair.hardNegative) {
        hardNegativeFalseDuplicates += 1;
      }
      diagnostics.push({
        id: pair.id,
        left: pair.left,
        right: pair.right,
        label: pair.label,
      });
      continue;
    }
    if (predicted !== 'duplicate' && pair.label === 'duplicate') {
      falseNegatives += 1;
    }
  }

  return {
    truePositives,
    falseDuplicates,
    falseNegatives,
    hardNegativeFalseDuplicates,
    falseDuplicatesByLabel,
    diagnostics,
  };
}

function replayLanguageEvaluation(
  pairs: readonly SemanticPair[],
  predictions: ReadonlyMap<string, SemanticClassification>,
): SemanticLanguageEvaluation {
  const ambiguousCount = pairs.filter(
    (pair) => pair.label === 'ambiguous',
  ).length;
  const counts = replayPairCounts(pairs, predictions);
  return {
    pairCount: pairs.length,
    evaluatedPairCount: pairs.filter(
      (pair) => pair.label !== 'ambiguous' && predictions.has(pair.id),
    ).length,
    ambiguousCount,
    trueDuplicateCount: pairs.filter(
      (pair) => pair.label === 'duplicate',
    ).length,
    ...metricRates(
      counts.truePositives,
      counts.falseDuplicates,
      counts.falseNegatives,
    ),
    falseDuplicateCount: counts.falseDuplicates,
    hardNegativeFalseDuplicateCount: counts.hardNegativeFalseDuplicates,
  };
}

function emptyConfusionMatrix(): Record<
  SemanticLabel,
  Record<SemanticClassification, number>
> {
  const matrix = {} as Record<
    SemanticLabel,
    Record<SemanticClassification, number>
  >;
  for (const trueLabel of ALL_SEMANTIC_LABELS) {
    matrix[trueLabel] = {
      duplicate: 0,
      'same-subject-different': 0,
      'compatible-distinct': 0,
      contradictory: 0,
      unrelated: 0,
    };
  }
  return matrix;
}

function unclassifiedClassification(
  record: RecordedSemanticClassification,
): string | undefined {
  return typeof record.classification === 'string'
    ? record.classification
    : undefined;
}

export function evaluateRecordedSemanticDuplicates(
  recorded: readonly RecordedSemanticClassification[],
  pairs: readonly SemanticPair[] = SEMANTIC_DUPLICATE_CORPUS,
): SemanticReplayEvaluation {
  const pairById = new Map(pairs.map((pair) => [pair.id, pair]));
  const recordById = new Map<string, RecordedSemanticClassification>();
  const unclassified: SemanticUnclassifiedPair[] = [];

  for (const record of recorded) {
    if (!pairById.has(record.pairId)) {
      const classification = unclassifiedClassification(record);
      unclassified.push({
        pairId: record.pairId,
        reason: 'unknown-pair',
        ...(classification === undefined ? {} : { classification }),
      });
      continue;
    }
    recordById.set(record.pairId, record);
  }

  const predictions = new Map<string, SemanticClassification>();
  let unclassifiedPairCount = 0;
  for (const pair of sortedPairs(pairs)) {
    const record = recordById.get(pair.id);
    if (record === undefined) {
      unclassifiedPairCount += 1;
      unclassified.push({
        pairId: pair.id,
        reason: 'missing-classification',
      });
      continue;
    }
    if (!isSemanticClassification(record.classification)) {
      unclassifiedPairCount += 1;
      const classification = unclassifiedClassification(record);
      unclassified.push({
        pairId: pair.id,
        reason:
          classification === undefined
            ? 'missing-classification'
            : 'unrecognized-classification',
        ...(classification === undefined ? {} : { classification }),
      });
      continue;
    }
    predictions.set(pair.id, record.classification);
  }

  const counts = replayPairCounts(pairs, predictions);
  const matrix = emptyConfusionMatrix();
  for (const pair of sortedPairs(pairs)) {
    const predicted = predictions.get(pair.id);
    if (predicted !== undefined) {
      matrix[pair.label][predicted] += 1;
    }
  }

  const perLanguage = {} as Record<
    SemanticLanguage,
    SemanticLanguageEvaluation
  >;
  for (const language of LANGUAGES) {
    perLanguage[language] = replayLanguageEvaluation(
      pairs.filter((pair) => pair.language === language),
      predictions,
    );
  }

  unclassified.sort(
    (left, right) =>
      compareStrings(left.pairId, right.pairId) ||
      compareStrings(left.reason, right.reason),
  );
  const ambiguousCount = pairs.filter(
    (pair) => pair.label === 'ambiguous',
  ).length;
  return {
    approach: 'model-replay',
    threshold: null,
    totalPairs: pairs.length,
    ambiguousCount,
    ...metricRates(
      counts.truePositives,
      counts.falseDuplicates,
      counts.falseNegatives,
    ),
    falseDuplicateCount: counts.falseDuplicates,
    hardNegativeFalseDuplicateCount: counts.hardNegativeFalseDuplicates,
    falseDuplicatesByLabel: counts.falseDuplicatesByLabel,
    perLanguage,
    diagnostics: counts.diagnostics,
    classifiedPairCount: predictions.size,
    unclassifiedPairCount,
    unclassifiedCount: unclassified.length,
    confusionMatrix: matrix,
    importantConfusions: {
      sameSubjectDifferentAsDuplicate:
        matrix['same-subject-different'].duplicate,
      contradictoryAsDuplicate: matrix.contradictory.duplicate,
    },
    unclassified,
  };
}

export const evaluateSemanticDuplicateReplay =
  evaluateRecordedSemanticDuplicates;
