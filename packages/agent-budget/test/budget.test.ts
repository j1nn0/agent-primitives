import { describe, expect, it } from 'vitest';
import * as budgetApi from '../src/index.js';
import { BudgetError, judgeBudget } from '../src/index.js';
import type { BudgetErrorCode } from '../src/index.js';

function expectBudgetError(action: () => unknown, code: BudgetErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BudgetError);
  expect((thrown as BudgetError).name).toBe('BudgetError');
  expect((thrown as BudgetError).code).toBe(code);
  expect((thrown as BudgetError).message).toBe('Invalid budget input.');
}

describe('agent budget public boundary', () => {
  it('exports only the public runtime values and has no dependencies', () => {
    expect(Object.keys(budgetApi).sort()).toEqual(['BudgetError', 'judgeBudget']);
  });

  it('reports consumption below the limit as within_budget', () => {
    expect(judgeBudget({ consumed: 2, limit: 5 })).toEqual({
      outcome: 'within_budget',
      remaining: 3,
    });
  });

  it('uses an inclusive boundary at the limit', () => {
    expect(judgeBudget({ consumed: 5, limit: 5 })).toEqual({
      outcome: 'exhausted',
      remaining: 0,
    });
  });

  it('reports overage with an unclamped negative remaining quantity', () => {
    expect(judgeBudget({ consumed: 7, limit: 5 })).toEqual({
      outcome: 'exhausted',
      remaining: -2,
    });
  });

  it('treats a zero budget as exhausted at zero consumption', () => {
    expect(judgeBudget({ consumed: 0, limit: 0 })).toEqual({
      outcome: 'exhausted',
      remaining: 0,
    });
  });

  it('accepts fractional values below and above the limit', () => {
    expect(judgeBudget({ consumed: 2.5, limit: 3.75 })).toEqual({
      outcome: 'within_budget',
      remaining: 1.25,
    });
    expect(judgeBudget({ consumed: 4.5, limit: 3.75 })).toEqual({
      outcome: 'exhausted',
      remaining: -0.75,
    });
  });

  it('accepts a zero limit with positive consumption and reports overage', () => {
    expect(judgeBudget({ consumed: 0.5, limit: 0 })).toEqual({
      outcome: 'exhausted',
      remaining: -0.5,
    });
  });

  it('rejects unknown top-level keys', () => {
    expectBudgetError(
      () => judgeBudget({ consumed: 0, limit: 1, extra: true }),
      'invalid_input',
    );
  });

  it('rejects missing consumed or limit fields', () => {
    expectBudgetError(() => judgeBudget({ limit: 1 }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: 0 }), 'invalid_input');
  });

  it('rejects NaN and positive or negative infinity', () => {
    expectBudgetError(() => judgeBudget({ consumed: Number.NaN, limit: 1 }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: 1, limit: Number.NaN }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: Number.POSITIVE_INFINITY, limit: 1 }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: Number.NEGATIVE_INFINITY, limit: 1 }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: 1, limit: Number.POSITIVE_INFINITY }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: 1, limit: Number.NEGATIVE_INFINITY }), 'invalid_input');
  });

  it('rejects negative consumed and limit values', () => {
    expectBudgetError(() => judgeBudget({ consumed: -1, limit: 1 }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: 1, limit: -1 }), 'invalid_input');
  });

  it('rejects non-object inputs', () => {
    for (const input of [null, [], 'budget', 1, undefined]) {
      expectBudgetError(() => judgeBudget(input), 'invalid_input');
    }
  });

  it('rejects own fields whose values are undefined', () => {
    expectBudgetError(() => judgeBudget({ consumed: undefined, limit: 1 }), 'invalid_input');
    expectBudgetError(() => judgeBudget({ consumed: 1, limit: undefined }), 'invalid_input');
  });

  it('throws the documented BudgetError shape for malformed input', () => {
    expectBudgetError(() => judgeBudget({ consumed: '1', limit: 2 }), 'invalid_input');
  });

  it('is deterministic and returns exactly the same two keys for both outcomes', () => {
    const withinInput = { consumed: 1, limit: 3 };
    const exhaustedInput = { consumed: 4, limit: 3 };
    const withinFirst = judgeBudget(withinInput);
    const withinSecond = judgeBudget(withinInput);
    const exhaustedFirst = judgeBudget(exhaustedInput);
    const exhaustedSecond = judgeBudget(exhaustedInput);

    expect(withinFirst).toEqual(withinSecond);
    expect(exhaustedFirst).toEqual(exhaustedSecond);
    expect(Object.keys(withinFirst)).toEqual(['outcome', 'remaining']);
    expect(Object.keys(exhaustedFirst)).toEqual(['outcome', 'remaining']);
  });

  it('does not mutate the caller input', () => {
    const input = { consumed: 2, limit: 5 };
    const before = { ...input };

    judgeBudget(input);

    expect(input).toEqual(before);
  });
});
