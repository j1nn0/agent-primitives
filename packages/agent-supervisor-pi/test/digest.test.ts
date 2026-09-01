import { describe, expect, it } from 'vitest';
import { computeSupervisorJsonDigest } from '../src/index.js';

describe('supervisor JSON digests', () => {
  it('is deterministic for the same input', () => {
    const value = { status: 'ready', count: 2 };
    expect(computeSupervisorJsonDigest(value)).toBe(computeSupervisorJsonDigest(value));
  });

  it('sorts object keys recursively while preserving array order', () => {
    const first = { z: { b: 2, a: 1 }, a: [{ d: 4, c: 3 }] };
    const reordered = { a: [{ c: 3, d: 4 }], z: { a: 1, b: 2 } };
    expect(computeSupervisorJsonDigest(first)).toBe(computeSupervisorJsonDigest(reordered));
    expect(computeSupervisorJsonDigest([1, 2])).not.toBe(computeSupervisorJsonDigest([2, 1]));
  });

  it('changes when the JSON value changes', () => {
    expect(computeSupervisorJsonDigest({ value: 1 })).not.toBe(
      computeSupervisorJsonDigest({ value: 2 }),
    );
  });

  it.each([
    undefined,
    { callback: () => 'not JSON' },
    { symbol: Symbol('not JSON') },
    { number: Number.NaN },
    { number: Number.POSITIVE_INFINITY },
    { missing: undefined },
    new Date(),
    new (class OddShape {
      readonly value = 1;
    })(),
  ])('returns the unavailable sentinel for non-JSON-safe input %#', (value) => {
    expect(computeSupervisorJsonDigest(value)).toBeNull();
  });

  it('returns the unavailable sentinel for cyclic input without throwing', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => computeSupervisorJsonDigest(cycle)).not.toThrow();
    expect(computeSupervisorJsonDigest(cycle)).toBeNull();
  });

  it('returns only a hexadecimal digest and never the raw input', () => {
    const digest = computeSupervisorJsonDigest({ secret: 'not-in-the-digest' });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('not-in-the-digest');
  });
});
