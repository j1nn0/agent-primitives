import { ProgressError } from './errors.js';
import {
  hasOwn,
  isPlainObject,
  validateObservation,
} from './validation.js';
import type { ProgressVerdict } from './types.js';

function invalidInput(): never {
  throw new ProgressError('invalid_input', 'Invalid progress input.');
}

export function judgeProgress(input: unknown): ProgressVerdict {
  try {
    if (!isPlainObject(input)) {
      return invalidInput();
    }

    if (!hasOwn(input, 'current')) {
      return invalidInput();
    }

    const current = validateObservation(input.current);
    const currentMilestones = [...current.milestones];

    if (!hasOwn(input, 'previous')) {
      return {
        outcome: 'unknown',
        reason: 'missing_baseline',
        recordedMilestones: [...currentMilestones],
      };
    }

    const previous = validateObservation(input.previous);
    const previousMilestones = [...previous.milestones];
    const newMilestones = currentMilestones.filter(
      (milestone) => !previousMilestones.includes(milestone),
    );
    const withdrawnMilestones = previousMilestones.filter(
      (milestone) => !currentMilestones.includes(milestone),
    );
    const recordedMilestones = [...previousMilestones];

    for (const milestone of currentMilestones) {
      if (!recordedMilestones.includes(milestone)) {
        recordedMilestones.push(milestone);
      }
    }

    if (newMilestones.length > 0) {
      if (withdrawnMilestones.length > 0) {
        return {
          outcome: 'progress',
          newMilestones,
          withdrawnMilestones,
          recordedMilestones,
        };
      }
      return {
        outcome: 'progress',
        newMilestones,
        recordedMilestones,
      };
    }

    if (withdrawnMilestones.length > 0) {
      return {
        outcome: 'no_progress',
        newMilestones: [],
        withdrawnMilestones,
        recordedMilestones,
      };
    }
    return {
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestones,
    };
  } catch (error) {
    if (error instanceof ProgressError) {
      throw error;
    }
    return invalidInput();
  }
}
