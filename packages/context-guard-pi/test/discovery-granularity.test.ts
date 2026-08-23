import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_GRANULARITY_CATEGORIES,
  DISCOVERY_GRANULARITY_CORPUS,
} from '../benchmark/discovery-granularity-corpus.js';
import {
  claimRecall,
  corpusInvariants,
  countScenariosByCategory,
  countScenariosByClass,
  simulateCapTailDrop,
  simulateOneFactPerToolCallId,
  summarizeCapture,
  summarizeEvidenceMultiplicity,
  type CapturedTurn,
  type RecordedTurnFact,
} from '../benchmark/discovery-granularity-evaluate.js';

import {
  RECORDED_LIVE_CAPTURE_TURNS,
  RECORDED_LIVE_SESSION_METADATA,
  recordedLiveSummary,
} from '../benchmark/discovery-granularity-recorded.js';

function fact(content: string, ...evidenceRefs: string[]): RecordedTurnFact {
  return { content, evidenceRefs };
}

describe('discovery granularity corpus', () => {
  it('has the required synthetic coverage and exact-claim invariants', () => {
    expect(DISCOVERY_GRANULARITY_CORPUS.length).toBeGreaterThanOrEqual(25);
    expect(
      new Set(DISCOVERY_GRANULARITY_CORPUS.map(({ id }) => id)).size,
    ).toBe(DISCOVERY_GRANULARITY_CORPUS.length);

    const categoryCounts = countScenariosByCategory();
    for (const category of DISCOVERY_GRANULARITY_CATEGORIES) {
      expect(categoryCounts[category]).toBeGreaterThanOrEqual(3);
    }

    const invariants = corpusInvariants();
    expect(invariants).toMatchObject({
      scenarioCount: DISCOVERY_GRANULARITY_CORPUS.length,
      claimsInEvidence: true,
      idsUnique: true,
      categoryCoverage: true,
      groupingMetadataValid: true,
      missingCategories: [],
    });
    expect(invariants.invariantChecks).toEqual({
      claimsInEvidence: true,
      idsUnique: true,
      categoryCoverage: true,
      groupingMetadataValid: true,
    });
    expect(countScenariosByClass()).toEqual({
      independent: expect.any(Number),
      'related-fragmentary': expect.any(Number),
      duplicate: expect.any(Number),
      complementary: expect.any(Number),
      ambiguous: expect.any(Number),
    });
  });

  it('keeps grouping annotations internally sane and marks the hard cases', () => {
    for (const scenario of DISCOVERY_GRANULARITY_CORPUS) {
      const acceptable = scenario.acceptableGroupings ?? [];
      const unacceptable = scenario.unacceptableGroupings ?? [];
      expect(acceptable.every((count) => Number.isInteger(count) && count > 0)).toBe(
        true,
      );
      expect(unacceptable.every((count) => Number.isInteger(count) && count > 0)).toBe(
        true,
      );
      expect(acceptable.some((count) => unacceptable.includes(count))).toBe(false);
      for (const claim of scenario.expectedClaims) {
        expect(scenario.evidence.map(({ text }) => text).join('')).toContain(claim);
      }
    }

    const notes = DISCOVERY_GRANULARITY_CORPUS.flatMap(({ notes }) =>
      notes === undefined ? [] : [notes],
    ).join('\n');
    expect(notes).toContain('Node version and package-manager version');
    expect(notes).toContain('compiler target and module');
    expect(notes).toContain('must not be merged');
    expect(
      DISCOVERY_GRANULARITY_CORPUS.some(({ language }) => language === 'ja'),
    ).toBe(true);
    expect(
      DISCOVERY_GRANULARITY_CORPUS.some(({ language }) => language === 'mixed'),
    ).toBe(true);
  });
});

describe('discovery granularity evaluator', () => {
  const turns: readonly CapturedTurn[] = [
    { turnIndex: 0, evidenceCount: 1, facts: [] },
    { turnIndex: 1, evidenceCount: 1, facts: [fact('one', 'e1')] },
    {
      turnIndex: 2,
      evidenceCount: 2,
      facts: [fact('two-a', 'e1'), fact('two-b', 'e2')],
    },
    {
      turnIndex: 3,
      evidenceCount: 3,
      facts: [fact('three-a', 'e1'), fact('three-b', 'e2'), fact('three-c', 'e3')],
    },
    {
      turnIndex: 4,
      evidenceCount: 4,
      facts: [
        fact('four-a', 'e1'),
        fact('four-b', 'e2'),
        fact('four-c', 'e3'),
        fact('four-d', 'e4'),
      ],
    },
  ];

  it('summarizes distribution, mean, median, and evidence amplification', () => {
    expect(summarizeCapture(turns)).toEqual({
      turnsWithFacts: 4,
      totalFacts: 10,
      discoveriesPerTurn: { 1: 1, 2: 1, 3: 1, 4: 1 },
      mean: 2,
      median: 2,
      max: 4,
    });

    expect(summarizeEvidenceMultiplicity(turns)).toEqual({
      unitsTotal: 11,
      unitsWithGt1Fact: 0,
      maxFactsPerUnit: 1,
      amplification: { numerator: 10, denominator: 11, rate: 10 / 11 },
    });

    const sharedEvidence: readonly CapturedTurn[] = [
      {
        turnIndex: 5,
        evidenceCount: 2,
        facts: [fact('first', 'e1'), fact('second', 'e1', 'e2')],
      },
    ];
    expect(summarizeEvidenceMultiplicity(sharedEvidence)).toEqual({
      unitsTotal: 2,
      unitsWithGt1Fact: 1,
      maxFactsPerUnit: 2,
      amplification: { numerator: 2, denominator: 2, rate: 1 },
    });
  });

  it('tail-drops in capture order and keeps cap four identical in content', () => {
    const input: readonly CapturedTurn[] = [
      {
        turnIndex: 8,
        evidenceCount: 1,
        facts: [fact('a', 'e1'), fact('b', 'e1'), fact('c', 'e1'), fact('d', 'e1')],
      },
    ];
    expect(simulateCapTailDrop(input, 2).facts.map(({ content }) => content)).toEqual([
      'a',
      'b',
    ]);
    expect(simulateCapTailDrop(input, 4).facts).toEqual(input[0]?.facts);
    // This hypothesis is tail-drop only: production rejects an over-four-fact
    // response atomically, so capTailDrop must not be read as persistence logic.
  });

  it('keeps the first fact for each first provenance tool-call proxy per turn', () => {
    const input: readonly CapturedTurn[] = [
      {
        turnIndex: 9,
        evidenceCount: 3,
        facts: [
          fact('first-call-one', 'call-1', 'e1'),
          fact('second-call-one', 'call-1', 'e2'),
          fact('first-call-two', 'call-2', 'e3'),
          fact('unreferenced'),
        ],
      },
    ];
    expect(
      simulateOneFactPerToolCallId(input).facts.map(({ content }) => content),
    ).toEqual(['first-call-one', 'first-call-two', 'unreferenced']);
  });

  it('uses exact substring recall and the empty-denominator convention', () => {
    const original = [fact('Alpha is durable.', 'e1'), fact('Beta is durable.', 'e1')];
    expect(
      claimRecall(original, [fact('Alpha is durable.', 'e1')], ['Alpha', 'Beta']),
    ).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(claimRecall(original, [fact('alpha is durable.', 'e1')], ['Alpha'])).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
    });
    expect(claimRecall([], [], ['not captured'])).toEqual({
      numerator: 0,
      denominator: 0,
      rate: 1,
    });
    expect(claimRecall(original, [], [])).toEqual({
      numerator: 0,
      denominator: 0,
      rate: 1,
    });
  });
});


describe('recorded live capture replay', () => {
  it('replays deterministically', () => {
    expect(JSON.stringify(recordedLiveSummary())).toBe(
      JSON.stringify(recordedLiveSummary()),
    );
  });

  it('matches the pinned capture, multiplicity, hypothesis, and lifecycle counts', () => {
    const summary = recordedLiveSummary();

    expect(RECORDED_LIVE_CAPTURE_TURNS).toHaveLength(18);
    expect(summary.capture).toMatchObject({
      totalFacts: 8,
      turnsWithFacts: 6,
      discoveriesPerTurn: { 1: 4, 2: 2, 3: 0, 4: 0 },
      max: 2,
    });
    expect(summary.multiplicity).toMatchObject({
      unitsTotal: 15,
      amplification: { numerator: 8, denominator: 15 },
    });
    expect(summary.hypotheses.capTailDrop[4]?.survivingFactCount).toBe(8);
    expect(summary.hypotheses.capTailDrop[1]?.survivingFactCount).toBe(6);
    expect(summary.hypotheses.oneFactPerToolCallId.survivingFactCount).toBe(6);
    expect(RECORDED_LIVE_SESSION_METADATA.finalLifecycleCounts).toEqual({
      active: 6,
      superseded: 1,
      retired: 1,
    });
    expect(summary.claimRecall).toEqual({
      applicable: false,
      reason: 'Not applicable: the real-session recording has no ground-truth expected claims.',
    });
  });

  it('contains structurally valid scrubbed replay records', () => {
    for (const turn of RECORDED_LIVE_CAPTURE_TURNS) {
      expect(turn.evidenceCount).toBeGreaterThanOrEqual(0);
      expect(turn.evidenceCount).toBeLessThanOrEqual(8);
      for (const fact of turn.facts) {
        expect(fact.content.length).toBeGreaterThan(0);
        expect(fact.content.length).toBeLessThanOrEqual(500);
        for (const evidenceRef of fact.evidenceRefs) {
          expect(evidenceRef).toMatch(/^e[1-9]\d*$/);
          const evidenceIndex = Number(evidenceRef.slice(1)) - 1;
          expect(evidenceIndex).toBeGreaterThanOrEqual(0);
          expect(evidenceIndex).toBeLessThan(turn.evidenceCount);
        }
      }
    }
  });

  it('derives eligible and producing turn counts from the replay data', () => {
    expect(RECORDED_LIVE_SESSION_METADATA.eligibleTurns).toBe(
      RECORDED_LIVE_CAPTURE_TURNS.filter(
        ({ evidenceCount }) => evidenceCount > 0,
      ).length,
    );
    expect(RECORDED_LIVE_SESSION_METADATA.producingTurns).toBe(
      RECORDED_LIVE_CAPTURE_TURNS.filter(({ facts }) => facts.length > 0).length,
    );
  });
});
