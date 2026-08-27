import type { BudgetErrorCode } from './types.js';

export class BudgetError extends Error {
  readonly code: BudgetErrorCode;

  constructor(code: BudgetErrorCode, message: string) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}
