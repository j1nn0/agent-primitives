import { ToolPolicyError } from './errors.js';
import { validateToolPolicyInput } from './validation.js';
import type { ToolPolicyOutcome, ToolPolicyVerdict } from './types.js';

function invalidInput(): never {
  throw new ToolPolicyError('invalid_input', 'Invalid tool policy input.');
}

export function judgeToolPolicy(input: unknown): ToolPolicyVerdict {
  try {
    const { tool, policy } = validateToolPolicyInput(input);

    if (policy.deny.includes(tool)) {
      return { outcome: 'denied', source: 'rule' };
    }
    if (policy.requiresApproval?.includes(tool)) {
      return { outcome: 'requires_approval', source: 'rule' };
    }
    if (policy.allow.includes(tool)) {
      return { outcome: 'allowed', source: 'rule' };
    }

    let outcome: ToolPolicyOutcome;
    switch (policy.default) {
      case 'allow':
        outcome = 'allowed';
        break;
      case 'deny':
        outcome = 'denied';
        break;
      case 'requires_approval':
        outcome = 'requires_approval';
        break;
      default:
        return invalidInput();
    }
    return { outcome, source: 'default' };
  } catch (error) {
    if (error instanceof ToolPolicyError) {
      throw error;
    }
    return invalidInput();
  }
}
