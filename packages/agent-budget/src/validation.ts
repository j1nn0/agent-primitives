import { BudgetError } from './errors.js';
import type { BudgetJudgeInput } from './types.js';

const ALLOWED_TOP_LEVEL_KEYS = new Set(['consumed', 'limit']);

function invalidInput(): never {
  throw new BudgetError('invalid_input', 'Invalid budget input.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateBudgetInput(value: unknown): BudgetJudgeInput {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    for (const key of Object.keys(value)) {
      if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
        return invalidInput();
      }
    }

    if (!hasOwn(value, 'consumed')) {
      return invalidInput();
    }
    const consumed = value.consumed;
    if (!isValidQuantity(consumed)) {
      return invalidInput();
    }

    if (!hasOwn(value, 'limit')) {
      return invalidInput();
    }
    const limit = value.limit;
    if (!isValidQuantity(limit)) {
      return invalidInput();
    }

    return { consumed, limit };
  } catch (error) {
    if (error instanceof BudgetError) {
      throw error;
    }
    return invalidInput();
  }
}
