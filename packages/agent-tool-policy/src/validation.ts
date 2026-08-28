import { ToolPolicyError } from './errors.js';
import type {
  ToolPolicy,
  ToolPolicyDefaultAction,
  ToolPolicyJudgeInput,
} from './types.js';

const ALLOWED_TOP_LEVEL_KEYS = new Set(['tool', 'policy']);
const ALLOWED_POLICY_KEYS = new Set([
  'default',
  'allow',
  'deny',
  'requiresApproval',
]);
const TOOL_NAME_PATTERN = /^\S+$/;

function invalidInput(): never {
  throw new ToolPolicyError('invalid_input', 'Invalid tool policy input.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    if (Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyAllowedKeys(
  value: object,
  allowedKeys: ReadonlySet<string>,
): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      return false;
    }
  }
  return true;
}

function isValidToolName(value: unknown): value is string {
  return typeof value === 'string' && TOOL_NAME_PATTERN.test(value);
}

function isValidDefaultAction(
  value: unknown,
): value is ToolPolicyDefaultAction {
  return (
    value === 'allow' ||
    value === 'deny' ||
    value === 'requires_approval'
  );
}

function isValidStringList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) {
    return false;
  }

  try {
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (!isValidToolName(item) || seen.has(item)) {
        return false;
      }
      seen.add(item);
    }
    return true;
  } catch {
    return false;
  }
}

function hasOverlap(
  first: readonly string[],
  second: readonly string[],
): boolean {
  const secondSet = new Set(second);
  return first.some((item) => secondSet.has(item));
}

export function validateToolPolicyInput(
  value: unknown,
): ToolPolicyJudgeInput {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_TOP_LEVEL_KEYS)) {
      return invalidInput();
    }

    if (!hasOwn(value, 'tool')) {
      return invalidInput();
    }
    const tool = value.tool;
    if (!isValidToolName(tool)) {
      return invalidInput();
    }

    if (!hasOwn(value, 'policy')) {
      return invalidInput();
    }
    const policyValue = value.policy;
    if (!isPlainObject(policyValue)) {
      return invalidInput();
    }

    if (!hasOnlyAllowedKeys(policyValue, ALLOWED_POLICY_KEYS)) {
      return invalidInput();
    }

    if (!hasOwn(policyValue, 'default')) {
      return invalidInput();
    }
    const defaultAction = policyValue.default;
    if (!isValidDefaultAction(defaultAction)) {
      return invalidInput();
    }

    if (!hasOwn(policyValue, 'allow')) {
      return invalidInput();
    }
    const allow = policyValue.allow;
    if (!isValidStringList(allow)) {
      return invalidInput();
    }

    if (!hasOwn(policyValue, 'deny')) {
      return invalidInput();
    }
    const deny = policyValue.deny;
    if (!isValidStringList(deny)) {
      return invalidInput();
    }

    const hasRequiresApproval = hasOwn(policyValue, 'requiresApproval');
    const requiresApproval = hasRequiresApproval
      ? policyValue.requiresApproval
      : [];
    if (!isValidStringList(requiresApproval)) {
      return invalidInput();
    }

    if (
      hasOverlap(allow, deny) ||
      hasOverlap(allow, requiresApproval) ||
      hasOverlap(deny, requiresApproval)
    ) {
      return invalidInput();
    }

    const policy: ToolPolicy = {
      default: defaultAction,
      allow,
      deny,
      ...(hasRequiresApproval ? { requiresApproval } : {}),
    };
    return { tool, policy };
  } catch (error) {
    if (error instanceof ToolPolicyError) {
      throw error;
    }
    return invalidInput();
  }
}
