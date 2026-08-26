import { RetryError } from './errors.js';
import { hasOwn, isPlainObject, validateRetryInput } from './validation.js';
import type { RetryVerdict } from './types.js';

function invalidInput(): never {
  throw new RetryError('invalid_input', 'Invalid retry input.');
}

export function judgeRetry(input: unknown): RetryVerdict {
  try {
    if (!isPlainObject(input) || !hasOwn(input, 'attempts')) {
      return invalidInput();
    }

    const validated = validateRetryInput(input);
    const attempts = [...validated.attempts];
    const attemptCount = attempts.length;
    const lastAttempt = attempts[attemptCount - 1];

    let consecutiveFailures = 0;
    while (consecutiveFailures < attemptCount) {
      const attempt = attempts[attemptCount - consecutiveFailures - 1];
      if (attempt === undefined || attempt.outcome !== 'failure') {
        break;
      }
      consecutiveFailures += 1;
    }

    let consecutiveNoProgress = 0;
    while (consecutiveNoProgress < attemptCount) {
      const attempt = attempts[attemptCount - consecutiveNoProgress - 1];
      if (attempt === undefined || attempt.outcome !== 'no_progress') {
        break;
      }
      consecutiveNoProgress += 1;
    }

    let repeatedStrategy: RetryVerdict['repeatedStrategy'];
    if (
      lastAttempt !== undefined &&
      lastAttempt.strategyId !== undefined &&
      (lastAttempt.outcome === 'failure' ||
        lastAttempt.outcome === 'no_progress')
    ) {
      const strategyId = lastAttempt.strategyId;
      let repeatedAttempts = 0;

      for (let index = attemptCount - 1; index >= 0; index -= 1) {
        const attempt = attempts[index];
        if (
          attempt === undefined ||
          attempt.strategyId === undefined ||
          attempt.strategyId !== strategyId ||
          (attempt.outcome !== 'failure' && attempt.outcome !== 'no_progress')
        ) {
          break;
        }
        repeatedAttempts += 1;
      }

      repeatedStrategy = { strategyId, attempts: repeatedAttempts };
    }

    const maxAttempts = validated.policy?.maxAttempts;
    const maxStrategyAttempts = validated.policy?.maxStrategyAttempts;
    const retryAllowed =
      attemptCount === 0
        ? true
        : lastAttempt?.outcome === 'success'
          ? false
          : maxAttempts !== undefined && attemptCount >= maxAttempts
            ? false
            : maxStrategyAttempts !== undefined &&
                repeatedStrategy !== undefined &&
                repeatedStrategy.attempts >= maxStrategyAttempts
              ? false
              : true;

    return {
      attempts: attemptCount,
      consecutiveFailures,
      consecutiveNoProgress,
      ...(repeatedStrategy === undefined ? {} : { repeatedStrategy }),
      retryAllowed,
    };
  } catch (error) {
    if (error instanceof RetryError) {
      throw error;
    }
    return invalidInput();
  }
}
