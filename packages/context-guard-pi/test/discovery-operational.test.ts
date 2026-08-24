import { describe, expect, it } from 'vitest';

import {
  OPERATIONAL_SESSION_RECORDS,
  type OperationalSessionRecord,
} from '../benchmark/discovery-operational-recorded.js';
import {
  aggregateOperationalSessions,
  summarizeOperationalSession,
  validateOperationalSessionRecord,
} from '../benchmark/discovery-operational-evaluate.js';

function recordFor(sessionId: string): OperationalSessionRecord {
  const record = OPERATIONAL_SESSION_RECORDS.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (record === undefined) {
    throw new Error(`Missing operational record: ${sessionId}`);
  }
  return record;
}

describe('discovery operational recording', () => {
  it('rejects records with neither or both capture representations', () => {
    const rich = recordFor('granularity-live-01');
    const { capturedTurns, ...withoutTurns } = rich;
    void capturedTurns;
    expect(() =>
      validateOperationalSessionRecord(
        withoutTurns as OperationalSessionRecord,
      ),
    ).toThrow();
    expect(() =>
      validateOperationalSessionRecord({
        ...rich,
        factContents: ['unexpected second representation'],
      }),
    ).toThrow();
    expect(() =>
      validateOperationalSessionRecord({
        ...rich,
        statusUnknownCount: -1,
      }),
    ).toThrow();
  });

  it('replays the new rich session pins from the validated extract', () => {
    const summary = summarizeOperationalSession(
      recordFor('operational-live-02'),
    );

    expect(summary.assistantTurns).toBe(35);
    expect(summary.discoveries).toBe(52);
    expect(summary.eligibleEvidenceTurns).toBe(23);
    expect(summary.discoveryProducingTurns).toBe(19);
    expect(summary.eligibleEvidenceUnits).toBe(23);
    expect(summary.discoveriesPerTurnHistogram).toEqual({
      0: 16,
      1: 6,
      2: 2,
      3: 2,
      4: 9,
    });
    expect(summary.histogramNotApplicable).toBe(false);
    expect(summary.captureYield).toMatchObject({
      numerator: 52,
      denominator: 23,
      rate: 52 / 23,
      applicable: true,
    });
    expect(summary.producingRate).toMatchObject({
      numerator: 19,
      denominator: 23,
      rate: 19 / 23,
      applicable: true,
    });
    expect(summary.lifecycle.finalLifecycleCounts).toEqual({
      active: 50,
      superseded: 1,
      retired: 1,
    });
    expect(summary.lifecycle.statusUnknownCount).toBe(0);
    expect(summary.lifecycle.unobserved).toBe(false);
    expect(summary.lifecycle.transitions?.natural).toEqual({
      retire: 0,
      supersede: 0,
    });
    expect(summary.lifecycle.transitions?.experimental).toEqual({
      retire: 1,
      supersede: 1,
    });
  });

  it('keeps the earlier rich session values unchanged', () => {
    const summary = summarizeOperationalSession(
      recordFor('granularity-live-01'),
    );

    expect(summary.assistantTurns).toBe(18);
    expect(summary.discoveries).toBe(8);
    expect(summary.eligibleEvidenceTurns).toBe(9);
    expect(summary.discoveryProducingTurns).toBe(6);
    expect(summary.eligibleEvidenceUnits).toBe(15);
    expect(summary.discoveriesPerTurnHistogram).toEqual({
      0: 12,
      1: 4,
      2: 2,
      3: 0,
      4: 0,
    });
    expect(summary.captureYield).toMatchObject({
      numerator: 8,
      denominator: 15,
      rate: 8 / 15,
      applicable: true,
    });
    expect(summary.lifecycle.finalLifecycleCounts).toEqual({
      active: 6,
      superseded: 1,
      retired: 1,
    });
    expect(summary.lifecycle.transitions?.unknown).toEqual({
      retire: 1,
      supersede: 1,
    });
  });

  it('keeps fact-level sessions out of turn metrics and marks lifecycle metadata unknown', () => {
    const candidate = summarizeOperationalSession(
      recordFor('operational-candidate-01'),
    );
    const semantic = summarizeOperationalSession(
      recordFor('semantic-candidate-01'),
    );

    expect(candidate.discoveries).toBe(17);
    expect(candidate.assistantTurns).toBeNull();
    expect(candidate.eligibleEvidenceUnits).toBeNull();
    expect(candidate.discoveriesPerTurnHistogram).toBeNull();
    expect(candidate.histogramNotApplicable).toBe(true);
    expect(candidate.mean).toBeNull();
    expect(candidate.lifecycle.statusUnknownCount).toBe(17);
    expect(candidate.lifecycle.finalLifecycleCounts).toBeUndefined();
    expect(candidate.lifecycle.transitions).toBeUndefined();
    expect(candidate.lifecycle.unobserved).toBe(true);

    expect(semantic.discoveries).toBe(34);
    expect(semantic.lifecycle.statusUnknownCount).toBe(34);
    expect(semantic.lifecycle.finalLifecycleCounts).toBeUndefined();
    expect(semantic.lifecycle.unobserved).toBe(true);
    expect(semantic.lifecycle.statusUnknownCount).not.toBe(0);
  });

  it('aggregates order-independently without diluting rich-session means', () => {
    const records = OPERATIONAL_SESSION_RECORDS;
    const aggregate = aggregateOperationalSessions(records);
    const reversed = aggregateOperationalSessions([...records].reverse());

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(aggregate));
    expect(aggregate).toMatchObject({
      sessions: 4,
      richSessions: 2,
      factOnlySessions: 2,
      assistantTurns: 53,
      eligibleEvidenceTurns: 32,
      discoveryProducingTurns: 25,
      eligibleEvidenceUnits: 38,
      discoveries: 111,
      richDiscoveries: 60,
      discoveriesPerTurnHistogram: {
        0: 28,
        1: 10,
        2: 4,
        3: 2,
        4: 9,
      },
      histogramNotApplicable: false,
      mean: 60 / 53,
      median: 0,
    });
    expect(aggregate.captureYield).toMatchObject({
      numerator: 60,
      denominator: 38,
      rate: 60 / 38,
      applicable: true,
    });
    expect(aggregate.producingRate).toMatchObject({
      numerator: 25,
      denominator: 38,
      rate: 25 / 38,
      applicable: true,
    });
    expect(aggregate.lifecycle).toEqual({
      naturalRetire: 0,
      naturalSupersede: 0,
      experimentalRetire: 1,
      experimentalSupersede: 1,
      unknownRetire: 1,
      unknownSupersede: 1,
      sessionsWithUnobservedLifecycle: 2,
      statusUnknownCount: 51,
    });
  });

  it('distinguishes an observed natural zero from unobserved lifecycle data', () => {
    const operational = summarizeOperationalSession(
      recordFor('operational-live-02'),
    );
    const semantic = summarizeOperationalSession(
      recordFor('semantic-candidate-01'),
    );
    const aggregate = aggregateOperationalSessions(OPERATIONAL_SESSION_RECORDS);

    expect(operational.lifecycle.transitions?.natural.retire).toBe(0);
    expect(operational.lifecycle.transitions?.natural.supersede).toBe(0);
    expect(semantic.lifecycle.transitions).toBeUndefined();
    expect(semantic.lifecycle.unobserved).toBe(true);
    expect(aggregate.lifecycle.naturalRetire).toBe(0);
    expect(aggregate.lifecycle.naturalSupersede).toBe(0);
    expect(aggregate.lifecycle.sessionsWithUnobservedLifecycle).toBe(2);
  });

  it('reports not-applicable aggregate rates when there are no rich sessions', () => {
    const aggregate = aggregateOperationalSessions([
      recordFor('operational-candidate-01'),
      recordFor('semantic-candidate-01'),
    ]);

    expect(aggregate.discoveries).toBe(51);
    expect(aggregate.factOnlySessions).toBe(2);
    expect(aggregate.assistantTurns).toBe(0);
    expect(aggregate.mean).toBeNull();
    expect(aggregate.discoveriesPerTurnHistogram).toBeNull();
    expect(aggregate.histogramNotApplicable).toBe(true);
    expect(aggregate.captureYield).toEqual({
      numerator: null,
      denominator: null,
      rate: null,
      applicable: false,
    });
    expect(aggregate.producingRate).toEqual({
      numerator: null,
      denominator: null,
      rate: null,
      applicable: false,
    });
  });

  it('is deterministic across repeated aggregation', () => {
    const first = aggregateOperationalSessions(OPERATIONAL_SESSION_RECORDS);
    const second = aggregateOperationalSessions(OPERATIONAL_SESSION_RECORDS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('keeps the embedded records free of absolute home paths', () => {
    for (const record of OPERATIONAL_SESSION_RECORDS) {
      const contents =
        record.capturedTurns?.flatMap((turn) =>
          turn.facts.map(({ content }) => content),
        ) ?? record.factContents ?? [];
      expect(contents.every((content) => !content.includes('/home/j1nn0/'))).toBe(
        true,
      );
    }
  });
});
