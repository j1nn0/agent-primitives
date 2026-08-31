import { describe, expect, it } from 'vitest';
import {
  compareRationals,
  computeExactPairedSignTest,
  computePairwiseOverhead,
  computeReductionRatio,
  medianRational,
  rationalMeetsThreshold,
  rationalToNumber,
  reductionMeetsThreshold,
} from '../src/index.js';
import type { SupervisorBenchmarkRational } from '../src/index.js';

describe('supervisor benchmark statistics', () => {
  it('computes an ordinary reduction ratio and reports a zero baseline as unavailable', () => {
    expect(computeReductionRatio(10, 2)).toEqual({ status: 'available', ratio: 0.8 });
    expect(computeReductionRatio(0, 0)).toEqual({ status: 'unavailable' });
  });

  it('makes reduction threshold decisions with exact integer arithmetic', () => {
    expect(reductionMeetsThreshold(10, 2, 4, 5)).toBe(true);
    expect(reductionMeetsThreshold(100, 21, 4, 5)).toBe(false);
    expect(reductionMeetsThreshold(10, 4, 3, 5)).toBe(true);
    expect(reductionMeetsThreshold(100, 41, 3, 5)).toBe(false);
    expect(reductionMeetsThreshold(3, 1, 2, 3)).toBe(true);
    expect(reductionMeetsThreshold(0, 0, 4, 5)).toBe(false);
  });

  it('keeps a negative reduction negative and fails a positive threshold', () => {
    expect(computeReductionRatio(10, 12)).toEqual({ status: 'available', ratio: -0.19999999999999996 });
    expect(reductionMeetsThreshold(10, 12, 4, 5)).toBe(false);
  });

  it('computes positive, zero, and negative pairwise overhead exactly', () => {
    expect(computePairwiseOverhead(100, 125)).toEqual({ numerator: 25n, denominator: 100n });
    expect(computePairwiseOverhead(100, 100)).toEqual({ numerator: 0n, denominator: 100n });
    expect(computePairwiseOverhead(100, 75)).toEqual({ numerator: -25n, denominator: 100n });
    expect(rationalToNumber(computePairwiseOverhead(100, 125))).toBe(0.25);
    expect(() => computePairwiseOverhead(0, 1)).toThrow();
  });

  it('takes exact rational medians independent of insertion order', () => {
    const odd = [
      { numerator: 3n, denominator: 1n },
      { numerator: 1n, denominator: 1n },
      { numerator: 2n, denominator: 1n },
    ] satisfies readonly SupervisorBenchmarkRational[];
    expect(medianRational(odd)).toEqual({ numerator: 2n, denominator: 1n });

    const even = [
      { numerator: 3n, denominator: 4n },
      { numerator: 1n, denominator: 2n },
    ] satisfies readonly SupervisorBenchmarkRational[];
    expect(medianRational(even)).toEqual({ numerator: 10n, denominator: 16n });
    expect(medianRational([...even].reverse())).toEqual(medianRational(even));
    expect(compareRationals({ numerator: -1n, denominator: 2n }, { numerator: 0n, denominator: 1n })).toBe(-1);
  });

  it('makes exact rational overhead threshold decisions at and above boundaries', () => {
    expect(rationalMeetsThreshold({ numerator: 15n, denominator: 100n }, 15, 100)).toBe(true);
    expect(rationalMeetsThreshold({ numerator: 16n, denominator: 100n }, 15, 100)).toBe(false);
    expect(rationalMeetsThreshold({ numerator: 20n, denominator: 100n }, 20, 100)).toBe(true);
    expect(rationalMeetsThreshold({ numerator: -20n, denominator: 100n }, 15, 100)).toBe(true);
  });

  it('returns no-discordance without treating it as evidence', () => {
    expect(computeExactPairedSignTest(0, 0)).toEqual({ status: 'no-discordance' });
  });

  it('computes exact small paired sign-test values', () => {
    expect(computeExactPairedSignTest(8, 0)).toEqual({
      status: 'computed',
      discordantPairs: 8,
      pValue: 1 / 256,
      significant: true,
    });
    expect(computeExactPairedSignTest(4, 3)).toEqual({
      status: 'computed',
      discordantPairs: 7,
      pValue: 0.5,
      significant: false,
    });
  });

  it.each([
    [0, 1],
    [3, 3],
    [4, 5],
  ] as const)('never marks wins <= regressions significant (%s, %s)', (wins, regressions) => {
    const result = computeExactPairedSignTest(wins, regressions);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.significant).toBe(false);
    }
  });

  it('uses BigInt binomial arithmetic for a realistic large discordant sample', () => {
    const result = computeExactPairedSignTest(30, 30);
    expect(result.status).toBe('computed');
    if (result.status === 'computed') {
      expect(result.discordantPairs).toBe(60);
      expect(result.pValue).toBeCloseTo(0.5512890865042848, 15);
      expect(result.significant).toBe(false);
    }
  });
});
