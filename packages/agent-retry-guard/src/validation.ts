import { RetryError } from './errors.js';
import type {
  RetryAttempt,
  RetryAttemptOutcome,
  RetryJudgeInput,
  RetryPolicy,
} from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidInput(): never {
  throw new RetryError('invalid_input', 'Invalid retry input.');
}

function isRetryAttemptOutcome(value: unknown): value is RetryAttemptOutcome {
  return (
    value === 'success' ||
    value === 'failure' ||
    value === 'no_progress' ||
    value === 'unknown'
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1
  );
}

function validateAttempt(value: unknown): RetryAttempt {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'outcome')) {
      return invalidInput();
    }

    const outcome = value.outcome;
    if (!isRetryAttemptOutcome(outcome)) {
      return invalidInput();
    }

    if (!hasOwn(value, 'strategyId')) {
      return { outcome };
    }

    const strategyId = value.strategyId;
    if (typeof strategyId !== 'string' || strategyId.trim().length === 0) {
      return invalidInput();
    }

    return { outcome, strategyId };
  } catch (error) {
    if (error instanceof RetryError) {
      throw error;
    }
    return invalidInput();
  }
}

function validatePolicy(value: unknown): RetryPolicy {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    let maxAttempts: number | undefined;
    if (hasOwn(value, 'maxAttempts')) {
      const rawMaxAttempts = value.maxAttempts;
      if (!isPositiveInteger(rawMaxAttempts)) {
        return invalidInput();
      }
      maxAttempts = rawMaxAttempts;
    }

    let maxStrategyAttempts: number | undefined;
    if (hasOwn(value, 'maxStrategyAttempts')) {
      const rawMaxStrategyAttempts = value.maxStrategyAttempts;
      if (!isPositiveInteger(rawMaxStrategyAttempts)) {
        return invalidInput();
      }
      maxStrategyAttempts = rawMaxStrategyAttempts;
    }

    return {
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(maxStrategyAttempts === undefined ? {} : { maxStrategyAttempts }),
    };
  } catch (error) {
    if (error instanceof RetryError) {
      throw error;
    }
    return invalidInput();
  }
}

export function validateRetryInput(value: unknown): RetryJudgeInput {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'attempts')) {
      return invalidInput();
    }

    const rawAttempts = value.attempts;
    if (!Array.isArray(rawAttempts)) {
      return invalidInput();
    }

    const length = rawAttempts.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      return invalidInput();
    }

    const attempts: RetryAttempt[] = [];
    for (let index = 0; index < length; index += 1) {
      attempts.push(validateAttempt(rawAttempts[index]));
    }

    if (!hasOwn(value, 'policy')) {
      return { attempts };
    }

    const policy = validatePolicy(value.policy);
    return { attempts, policy };
  } catch (error) {
    if (error instanceof RetryError) {
      throw error;
    }
    return invalidInput();
  }
}
