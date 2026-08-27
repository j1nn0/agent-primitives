import { BudgetError } from './errors.js';
import { validateBudgetInput } from './validation.js';
import type { BudgetOutcome, BudgetVerdict } from './types.js';

function invalidInput(): never {
  throw new BudgetError('invalid_input', 'Invalid budget input.');
}

export function judgeBudget(input: unknown): BudgetVerdict {
  try {
    const { consumed, limit } = validateBudgetInput(input);
    const outcome: BudgetOutcome = consumed >= limit ? 'exhausted' : 'within_budget';
    const remaining = limit - consumed;
    return { outcome, remaining };
  } catch (error) {
    if (error instanceof BudgetError) {
      throw error;
    }
    return invalidInput();
  }
}
