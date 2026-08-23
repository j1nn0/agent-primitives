import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  SEMANTIC_DUPLICATE_CORPUS,
  type SemanticLabel,
  type SemanticPair,
} from '../benchmark/semantic-duplicate-corpus.js';
import {
  evaluateRecordedSemanticDuplicates,
  evaluateSemanticDuplicateBenchmark,
  isNormalizedStringDuplicate,
  isTokenOverlapDuplicate,
  TOKEN_OVERLAP_THRESHOLDS,
} from '../benchmark/semantic-duplicate-evaluate.js';
import {
  RECORDED_DEEPSEEK_SUBSAMPLE,
  RECORDED_LUNA_SESSION,
  RECORDED_LUNA_SUBSAMPLE,
  RECORDED_LUNA_VARIANCE,
} from '../benchmark/semantic-duplicate-recorded.js';

import {
  SEMANTIC_DUPLICATE_SESSION,
  SEMANTIC_DUPLICATE_SUBSAMPLE,
  SEMANTIC_DUPLICATE_VARIANCE,
  selectSemanticDuplicateSubset,
} from '../benchmark/semantic-duplicate-run.js';

const EXPECTED_COUNTS: Readonly<Record<SemanticLabel, number>> = {
  duplicate: 20,
  'same-subject-different': 14,
  'compatible-distinct': 12,
  contradictory: 10,
  unrelated: 12,
  ambiguous: 2,
};

function structuralAnchors(text: string): ReadonlySet<string> {
  const anchors = [
    ...(text.match(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/gu) ?? []),
    ...(text.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/gu) ?? []),
    ...(text.match(/\b\d+\.\d+(?:\.\d+)*\b/gu) ?? []),
  ];
  return new Set(anchors);
}

function findPair(id: string): SemanticPair {
  const pair = SEMANTIC_DUPLICATE_CORPUS.find((candidate) => candidate.id === id);
  assert.ok(pair, `missing corpus pair: ${id}`);
  return pair;
}

test('semantic duplicate corpus has the required integrity', () => {
  assert.equal(SEMANTIC_DUPLICATE_CORPUS.length, 70);
  assert.equal(
    new Set(SEMANTIC_DUPLICATE_CORPUS.map((pair) => pair.id)).size,
    70,
  );

  const counts = Object.fromEntries(
    Object.keys(EXPECTED_COUNTS).map((label) => [
      label,
      SEMANTIC_DUPLICATE_CORPUS.filter((pair) => pair.label === label).length,
    ]),
  ) as Record<SemanticLabel, number>;
  assert.deepEqual(counts, EXPECTED_COUNTS);

  assert.ok(
    SEMANTIC_DUPLICATE_CORPUS.filter((pair) => pair.language !== 'en').length >=
      28,
  );
  const hardNegativeLabels = new Set<SemanticLabel>([
    'same-subject-different',
    'compatible-distinct',
    'contradictory',
  ]);
  for (const pair of SEMANTIC_DUPLICATE_CORPUS) {
    assert.equal(pair.hardNegative, hardNegativeLabels.has(pair.label));
    if (pair.label === 'duplicate') {
      assert.notEqual(pair.left, pair.right);
    }
  }
});

test('duplicate paraphrases are independent of structural anchors', () => {
  const independentDuplicates = SEMANTIC_DUPLICATE_CORPUS.filter((pair) => {
    if (pair.label !== 'duplicate') {
      return false;
    }
    const leftAnchors = structuralAnchors(pair.left);
    const rightAnchors = structuralAnchors(pair.right);
    return [...leftAnchors].every((anchor) => !rightAnchors.has(anchor));
  });

  assert.ok(independentDuplicates.length >= 14);
});

test('normalized equality is a blind baseline with a punctuation case', () => {
  const paraphrase = findPair('duplicate-compiler-target');
  assert.equal(
    isNormalizedStringDuplicate(paraphrase.left, paraphrase.right),
    false,
  );

  const punctuationCase = findPair('duplicate-punctuation-case');
  assert.equal(
    isNormalizedStringDuplicate(punctuationCase.left, punctuationCase.right),
    true,
  );
});

test('token overlap does not collapse the required version and Japanese negation pairs', () => {
  const nodeVersion = findPair('same-node-version');
  const japaneseNegation = findPair('contradictory-japanese-recovery');
  for (const threshold of TOKEN_OVERLAP_THRESHOLDS) {
    assert.equal(
      isTokenOverlapDuplicate(nodeVersion.left, nodeVersion.right, threshold),
      false,
      `Node version pair at ${threshold}`,
    );
    assert.equal(
      isTokenOverlapDuplicate(
        japaneseNegation.left,
        japaneseNegation.right,
        threshold,
      ),
      false,
      `Japanese negation pair at ${threshold}`,
    );
  }
});

test('metrics exclude ambiguous pairs and count hard-negative false duplicates', () => {
  const tinyCorpus: readonly SemanticPair[] = [
    {
      id: 'tiny-duplicate',
      language: 'en',
      left: 'Recovery is enabled.',
      right: 'recovery is enabled!',
      label: 'duplicate',
      hardNegative: false,
    },
    {
      id: 'tiny-hard-negative',
      language: 'en',
      left: 'Recovery is enabled.',
      right: 'Recovery is not enabled.',
      label: 'contradictory',
      hardNegative: true,
    },
    {
      id: 'tiny-ambiguous',
      language: 'en',
      left: 'The cache is available.',
      right: 'The cache can be reached.',
      label: 'ambiguous',
      hardNegative: false,
    },
  ];
  const report = evaluateSemanticDuplicateBenchmark(tinyCorpus);
  assert.equal(report.ambiguousCount, 1);

  const exact = report.evaluations[0];
  assert.ok(exact);
  assert.equal(exact.approach, 'normalized-string');
  assert.deepEqual(exact.duplicatePrecision, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(exact.duplicateRecall, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(exact.duplicateF1, {
    numerator: 2,
    denominator: 2,
    rate: 1,
  });
  assert.equal(exact.falseDuplicateCount, 0);
  assert.equal(exact.hardNegativeFalseDuplicateCount, 0);

  const overlapAtHalf = report.evaluations.find(
    (evaluation) =>
      evaluation.approach === 'token-overlap' && evaluation.threshold === 0.5,
  );
  assert.ok(overlapAtHalf);
  assert.deepEqual(overlapAtHalf.duplicatePrecision, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.deepEqual(overlapAtHalf.duplicateRecall, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.deepEqual(overlapAtHalf.duplicateF1, {
    numerator: 2,
    denominator: 3,
    rate: 2 / 3,
  });
  assert.equal(overlapAtHalf.falseDuplicateCount, 1);
  assert.equal(overlapAtHalf.hardNegativeFalseDuplicateCount, 1);
  assert.deepEqual(overlapAtHalf.falseDuplicatesByLabel, {
    'same-subject-different': 0,
    'compatible-distinct': 0,
    contradictory: 1,
    unrelated: 0,
  });

  const overlapAtSevenTenths = report.evaluations.find(
    (evaluation) =>
      evaluation.approach === 'token-overlap' && evaluation.threshold === 0.7,
  );
  assert.ok(overlapAtSevenTenths);
  assert.equal(overlapAtSevenTenths.falseDuplicateCount, 0);
  assert.equal(overlapAtSevenTenths.hardNegativeFalseDuplicateCount, 0);
});

test('semantic duplicate evaluation is deterministic', () => {
  assert.deepEqual(
    evaluateSemanticDuplicateBenchmark(SEMANTIC_DUPLICATE_CORPUS),
    evaluateSemanticDuplicateBenchmark(SEMANTIC_DUPLICATE_CORPUS),
  );
});

test('replay evaluation computes the same headline metric shape', () => {
  const evaluation = evaluateRecordedSemanticDuplicates([
    {
      pairId: 'duplicate-compiler-target',
      classification: 'duplicate',
    },
    {
      pairId: 'duplicate-eslint-ignores',
      classification: 'unrelated',
    },
    {
      pairId: 'same-package-parser',
      classification: 'duplicate',
    },
    {
      pairId: 'contradictory-recovery',
      classification: 'duplicate',
    },
    {
      pairId: 'compatible-redis-properties',
      classification: 'compatible-distinct',
    },
    {
      pairId: 'ambiguous-cache-reachability',
      classification: 'duplicate',
    },
  ]);

  assert.deepEqual(evaluation.duplicatePrecision, {
    numerator: 1,
    denominator: 3,
    rate: 1 / 3,
  });
  assert.deepEqual(evaluation.duplicateRecall, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.deepEqual(evaluation.duplicateF1, {
    numerator: 2,
    denominator: 5,
    rate: 0.4,
  });
  assert.equal(evaluation.falseDuplicateCount, 2);
  assert.equal(evaluation.hardNegativeFalseDuplicateCount, 2);
  assert.equal(evaluation.ambiguousCount, 2);
  assert.deepEqual(evaluation.falseDuplicatesByLabel, {
    'same-subject-different': 1,
    'compatible-distinct': 0,
    contradictory: 1,
    unrelated: 0,
  });
});

test('replay confusion cells expose the two high-risk duplicate mistakes', () => {
  const evaluation = evaluateRecordedSemanticDuplicates([
    {
      pairId: 'same-package-parser',
      classification: 'duplicate',
    },
    {
      pairId: 'contradictory-recovery',
      classification: 'duplicate',
    },
  ]);

  assert.equal(
    evaluation.confusionMatrix['same-subject-different'].duplicate,
    1,
  );
  assert.equal(evaluation.confusionMatrix.contradictory.duplicate, 1);
  assert.deepEqual(evaluation.importantConfusions, {
    sameSubjectDifferentAsDuplicate: 1,
    contradictoryAsDuplicate: 1,
  });
  assert.equal(evaluation.falseDuplicateCount, 2);
  assert.equal(evaluation.hardNegativeFalseDuplicateCount, 2);
  assert.deepEqual(
    evaluation.diagnostics.map((diagnostic) => diagnostic.id),
    ['contradictory-recovery', 'same-package-parser'],
  );
});

test('replay excludes and reports missing or unrecognised classifications', () => {
  const evaluation = evaluateRecordedSemanticDuplicates(
    [
      {
        pairId: 'duplicate-compiler-target',
        classification: 'duplicate',
      },
      {
        pairId: 'same-package-parser',
        classification: 'not-a-classification',
      },
    ],
    [
      findPair('duplicate-compiler-target'),
      findPair('same-package-parser'),
      findPair('unrelated-node-report'),
    ],
  );

  assert.equal(evaluation.classifiedPairCount, 1);
  assert.equal(evaluation.unclassifiedPairCount, 2);
  assert.equal(evaluation.unclassifiedCount, 2);
  assert.equal(evaluation.falseDuplicateCount, 0);
  assert.deepEqual(
    evaluation.unclassified.map(({ pairId, reason }) => ({ pairId, reason })),
    [
      {
        pairId: 'same-package-parser',
        reason: 'unrecognized-classification',
      },
      {
        pairId: 'unrelated-node-report',
        reason: 'missing-classification',
      },
    ],
  );
  assert.deepEqual(evaluation.duplicateRecall, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
});

test('semantic benchmark subsets are deterministic and stratified', () => {
  const countLabels = (pairs: readonly SemanticPair[]) => {
    const counts = {} as Partial<Record<SemanticLabel, number>>;
    for (const pair of pairs) {
      counts[pair.label] = (counts[pair.label] ?? 0) + 1;
    }
    return counts;
  };

  assert.deepEqual(
    SEMANTIC_DUPLICATE_SUBSAMPLE,
    selectSemanticDuplicateSubset('subsample'),
  );
  assert.equal(SEMANTIC_DUPLICATE_SUBSAMPLE.length, 30);
  assert.deepEqual(countLabels(SEMANTIC_DUPLICATE_SUBSAMPLE), {
    duplicate: 10,
    'same-subject-different': 7,
    'compatible-distinct': 5,
    contradictory: 5,
    unrelated: 3,
  });

  assert.deepEqual(
    SEMANTIC_DUPLICATE_VARIANCE,
    selectSemanticDuplicateSubset('variance'),
  );
  assert.equal(SEMANTIC_DUPLICATE_VARIANCE.length, 10);
  assert.equal(
    SEMANTIC_DUPLICATE_VARIANCE.filter((pair) => pair.label === 'duplicate')
      .length,
    5,
  );
  assert.equal(
    SEMANTIC_DUPLICATE_VARIANCE.filter((pair) => pair.hardNegative).length,
    5,
  );
  assert.ok(
    SEMANTIC_DUPLICATE_VARIANCE.every(
      (pair) => pair.label === 'duplicate' || pair.hardNegative,
    ),
  );
});

test('the session subset holds the real pairs and an empty replay is safe', () => {
  // Ten pairs lifted from a real Pi session. None is a true duplicate, which is
  // the point: the subset measures restraint on operational content.
  assert.equal(SEMANTIC_DUPLICATE_SESSION.length, 10);
  assert.deepEqual(
    selectSemanticDuplicateSubset('session'),
    SEMANTIC_DUPLICATE_SESSION,
  );
  assert.deepEqual(
    SEMANTIC_DUPLICATE_SESSION.filter((pair) => pair.label === 'duplicate'),
    [],
  );

  const evaluation = evaluateRecordedSemanticDuplicates([], []);
  assert.equal(evaluation.totalPairs, 0);
  assert.equal(evaluation.classifiedPairCount, 0);
  assert.equal(evaluation.unclassifiedPairCount, 0);
  assert.deepEqual(evaluation.duplicatePrecision, {
    numerator: 0,
    denominator: 0,
    rate: 1,
  });
  assert.deepEqual(evaluation.duplicateRecall, {
    numerator: 0,
    denominator: 0,
    rate: 1,
  });
  assert.deepEqual(evaluation.duplicateF1, {
    numerator: 0,
    denominator: 0,
    rate: 1,
  });
});

test('recorded model runs reproduce the measured results without a provider', () => {
  const luna = evaluateRecordedSemanticDuplicates(RECORDED_LUNA_SUBSAMPLE);
  const deepseek = evaluateRecordedSemanticDuplicates(RECORDED_DEEPSEEK_SUBSAMPLE);

  assert.equal(luna.duplicatePrecision.rate, 1);
  assert.equal(luna.duplicateRecall.rate, 1);
  assert.equal(deepseek.duplicatePrecision.rate, 1);
  assert.equal(deepseek.duplicateRecall.rate, 0.9);
});

test('recorded model runs contain no false duplicate on either model', () => {
  // The safety metric the adoption decision turned on. A change that makes any
  // of these non-zero has moved the thing that actually mattered.
  for (const recorded of [RECORDED_LUNA_SUBSAMPLE, RECORDED_DEEPSEEK_SUBSAMPLE]) {
    const result = evaluateRecordedSemanticDuplicates(recorded);
    assert.equal(result.falseDuplicateCount, 0);
    assert.equal(result.hardNegativeFalseDuplicateCount, 0);
    assert.equal(result.importantConfusions.sameSubjectDifferentAsDuplicate, 0);
    assert.equal(result.importantConfusions.contradictoryAsDuplicate, 0);
  }
});

test('no real session pair was ever called a duplicate', () => {
  // Ten pairs hand-picked from a real Pi session, none of them true duplicates.
  // Restraint here, not recall, is the operational result.
  assert.equal(RECORDED_LUNA_SESSION.length, 10);
  assert.deepEqual(
    RECORDED_LUNA_SESSION.filter(
      (record) => record.classification === 'duplicate',
    ),
    [],
  );
});

test('the hardest pairs were classified identically on both runs', () => {
  const entries = Object.entries(RECORDED_LUNA_VARIANCE);
  assert.equal(entries.length, 10);
  for (const [pairId, classifications] of entries) {
    assert.equal(classifications.length, 2);
    assert.equal(
      new Set(classifications).size,
      1,
      `${pairId} was classified inconsistently`,
    );
  }
});
