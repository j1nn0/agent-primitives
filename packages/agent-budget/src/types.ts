export type BudgetOutcome = 'within_budget' | 'exhausted';
export type BudgetErrorCode = 'invalid_input';

export interface BudgetJudgeInput {
  readonly consumed: number;
  readonly limit: number;
}

export interface BudgetVerdict {
  readonly outcome: BudgetOutcome;
  readonly remaining: number;
}
