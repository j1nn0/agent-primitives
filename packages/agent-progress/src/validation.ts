import { ProgressError } from './errors.js';
import type { ProgressObservation } from './types.js';

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
  throw new ProgressError('invalid_input', 'Invalid progress input.');
}

function duplicateMilestone(): never {
  throw new ProgressError('duplicate_milestone', 'Duplicate milestone.');
}

export function validateObservation(value: unknown): ProgressObservation {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  if (!hasOwn(value, 'milestones')) {
    return invalidInput();
  }

  try {
    const rawMilestones = value.milestones;
    if (!Array.isArray(rawMilestones)) {
      return invalidInput();
    }

    const length = rawMilestones.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      return invalidInput();
    }

    const milestones: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const candidate: unknown = rawMilestones[index];
      if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        return invalidInput();
      }
      if (milestones.includes(candidate)) {
        return duplicateMilestone();
      }
      milestones.push(candidate);
    }

    return { milestones };
  } catch (error) {
    if (error instanceof ProgressError) {
      throw error;
    }
    return invalidInput();
  }
}
