import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_STRATEGIES,
  allPairs,
  evaluateSemanticCandidateBenchmark,
  recentWindow,
  sameTool,
  summarizeDuplicateDistances,
} from '../benchmark/semantic-candidate-evaluate.js';
import { SEMANTIC_CANDIDATE_CORPUS } from '../benchmark/semantic-candidate-corpus.js';
import {
  RECORDED_SEMANTIC_CANDIDATE_FACTS,
  RECORDED_SEMANTIC_CANDIDATE_SCENARIO,
  RECORDED_SEMANTIC_CANDIDATE_VERDICTS,
} from '../benchmark/semantic-candidate-recorded.js';

function pairIsPresent(
  pairs: readonly (readonly [number, number])[],
  leftIndex: number,
  rightIndex: number,
): boolean {
  return pairs.some(
    ([left, right]) => left === leftIndex && right === rightIndex,
  );
}

describe('semantic candidate benchmark', () => {
  it('keeps the ordered corpus structurally complete', () => {
    expect(SEMANTIC_CANDIDATE_CORPUS).toHaveLength(16);
    expect(
      new Set(SEMANTIC_CANDIDATE_CORPUS.map((scenario) => scenario.id)).size,
    ).toBe(16);
    expect(
      SEMANTIC_CANDIDATE_CORPUS.filter((scenario) => scenario.language !== 'en')
        .length,
    ).toBeGreaterThanOrEqual(6);

    const requiredCategories = [
      'distance-1',
      'distance-2',
      'distance-5',
      'distance-10',
      'distance-15',
      'distance-25-plus',
      'two-duplicate-groups',
      'group-of-three',
      'hard-negatives-only',
      'nearby-same-subject-different',
      'inactive-duplicates',
    ] as const;
    const categories = new Set(
      SEMANTIC_CANDIDATE_CORPUS.map((scenario) => scenario.category),
    );
    for (const category of requiredCategories) {
      expect(categories.has(category)).toBe(true);
    }

    for (const scenario of SEMANTIC_CANDIDATE_CORPUS) {
      for (const [leftIndex, rightIndex] of scenario.duplicatePairs) {
        expect(leftIndex).toBeGreaterThanOrEqual(0);
        expect(leftIndex).toBeLessThan(scenario.discoveries.length);
        expect(rightIndex).toBeGreaterThanOrEqual(0);
        expect(rightIndex).toBeLessThan(scenario.discoveries.length);
      }
      for (const group of scenario.duplicateGroups) {
        for (const index of group) {
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(scenario.discoveries.length);
        }
      }
    }

    const farScenario = SEMANTIC_CANDIDATE_CORPUS.find(
      (scenario) => scenario.category === 'distance-25-plus',
    );
    if (farScenario === undefined) {
      throw new Error('missing far-distance scenario');
    }
    expect(farScenario.discoveries.length).toBeGreaterThanOrEqual(26);
    for (const [leftIndex, rightIndex] of farScenario.duplicatePairs) {
      expect(Math.abs(rightIndex - leftIndex)).toBeGreaterThanOrEqual(25);
    }
  });

  it('excludes retired and superseded discoveries without shifting active order', () => {
    const scenario = SEMANTIC_CANDIDATE_CORPUS.find(
      (candidate) => candidate.category === 'inactive-duplicates',
    );
    if (scenario === undefined) {
      throw new Error('missing inactive scenario');
    }

    const inactiveIndexes = new Set(
      scenario.discoveries.flatMap((discovery, index) =>
        discovery.status === 'active' ? [] : [index],
      ),
    );
    for (const strategy of CANDIDATE_STRATEGIES) {
      for (const [leftIndex, rightIndex] of strategy.generate(scenario)) {
        expect(inactiveIndexes.has(leftIndex)).toBe(false);
        expect(inactiveIndexes.has(rightIndex)).toBe(false);
      }
    }

    expect(recentWindow(1)(scenario)).toContainEqual([0, 2]);
    expect(recentWindow(1)(scenario)).not.toContainEqual([0, 1]);
  });

  it('keeps close duplicates and drops distant duplicates at a five-item window', () => {
    for (const scenario of SEMANTIC_CANDIDATE_CORPUS) {
      const activeIndexes = new Set(
        scenario.discoveries.flatMap((discovery, index) =>
          discovery.status === 'active' ? [index] : [],
        ),
      );
      const pairs = recentWindow(5)(scenario);
      for (const [leftIndex, rightIndex] of scenario.duplicatePairs) {
        if (!activeIndexes.has(leftIndex) || !activeIndexes.has(rightIndex)) {
          continue;
        }
        const distance = Math.abs(rightIndex - leftIndex);
        if (distance <= 5) {
          expect(pairIsPresent(pairs, leftIndex, rightIndex)).toBe(true);
        } else {
          expect(pairIsPresent(pairs, leftIndex, rightIndex)).toBe(false);
        }
      }
    }
  });

  it('gets sparser as registries grow while allPairs remains quadratic', () => {
    const small = SEMANTIC_CANDIDATE_CORPUS.find(
      (scenario) => scenario.id === 'distance-5-third-tool',
    );
    const medium = SEMANTIC_CANDIDATE_CORPUS.find(
      (scenario) => scenario.id === 'distance-15-mixed',
    );
    const largest = SEMANTIC_CANDIDATE_CORPUS.find(
      (scenario) => scenario.category === 'distance-25-plus',
    );
    if (small === undefined || medium === undefined || largest === undefined) {
      throw new Error('missing registry-size scenarios');
    }

    const smallFull = allPairs(small).length;
    const mediumFull = allPairs(medium).length;
    const largestFull = allPairs(largest).length;
    const smallReduction =
      1 - recentWindow(5)(small).length / smallFull;
    const mediumReduction =
      1 - recentWindow(5)(medium).length / mediumFull;
    const largestReduction =
      1 - recentWindow(5)(largest).length / largestFull;

    expect(mediumReduction).toBeGreaterThan(smallReduction);
    expect(largestReduction).toBeGreaterThan(mediumReduction);
    expect(largestFull).toBe(
      (largest.discoveries.length * (largest.discoveries.length - 1)) / 2,
    );
    expect(largestFull).toBeGreaterThan(mediumFull * 2);
  });

  it('measures sameTool on the recorded 34-fact fixture', () => {
    expect(RECORDED_SEMANTIC_CANDIDATE_FACTS).toHaveLength(34);
    const toolNames = new Set(
      RECORDED_SEMANTIC_CANDIDATE_FACTS.flatMap((fact) => fact.toolNames),
    );
    expect([...toolNames]).toEqual(['bash', 'read']);

    const candidatePairCount = sameTool(
      RECORDED_SEMANTIC_CANDIDATE_SCENARIO,
    ).length;
    const fullPairCount = allPairs(RECORDED_SEMANTIC_CANDIDATE_SCENARIO).length;
    expect(candidatePairCount).toBe(276);
    expect(fullPairCount).toBe(561);
    expect(1 - candidatePairCount / fullPairCount).toBeCloseTo(285 / 561);
  });

  it('summarises the declared duplicate distances without percentiles', () => {
    const summary = summarizeDuplicateDistances();
    expect(summary.distances).toEqual([
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      2,
      3,
      4,
      4,
      5,
      5,
      5,
      8,
      9,
      10,
      10,
      15,
      25,
    ]);
    expect(summary.minimum).toBe(1);
    expect(summary.median).toBe(4);
    expect(summary.maximum).toBe(25);
  });

  it('records nine live verdicts and none is duplicate', () => {
    expect(RECORDED_SEMANTIC_CANDIDATE_VERDICTS).toHaveLength(9);
    expect(
      RECORDED_SEMANTIC_CANDIDATE_VERDICTS.every(
        (verdict) => verdict.classification !== 'duplicate',
      ),
    ).toBe(true);
  });

  it('is deterministic across repeated evaluation and scenario order', () => {
    const first = evaluateSemanticCandidateBenchmark();
    const second = evaluateSemanticCandidateBenchmark();
    const shuffled = evaluateSemanticCandidateBenchmark([
      ...SEMANTIC_CANDIDATE_CORPUS,
    ].reverse());

    expect(second).toEqual(first);
    expect(shuffled).toEqual(first);
  });
});
