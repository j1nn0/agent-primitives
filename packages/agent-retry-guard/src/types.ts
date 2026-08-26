export type RetryAttemptOutcome =
  | 'success'
  | 'failure'
  | 'no_progress'
  | 'unknown';

export type RetryErrorCode = 'invalid_input';

export interface RetryAttempt {
  readonly outcome: RetryAttemptOutcome;
  readonly strategyId?: string;
}

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly maxStrategyAttempts?: number;
}

export interface RetryJudgeInput {
  readonly attempts: readonly RetryAttempt[];
  readonly policy?: RetryPolicy;
}

export interface StrategyRun {
  readonly strategyId: string;
  readonly attempts: number;
}

export interface RetryVerdict {
  readonly attempts: number;
  readonly consecutiveFailures: number;
  readonly consecutiveNoProgress: number;
  readonly strategyRun?: StrategyRun;
  readonly retryAllowed: boolean;
}
