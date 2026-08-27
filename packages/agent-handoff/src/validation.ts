import { HandoffError } from './errors.js';
import type { HandoffInput } from './types.js';

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'id',
  'source',
  'destination',
  'goal',
  'constraints',
  'openItems',
  'evidenceReferences',
]);

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
  throw new HandoffError('invalid_input', 'Invalid handoff input.');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateOptionalIdentifier(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const candidate = value[key];
  if (!isIdentifier(candidate)) {
    return invalidInput();
  }
  return candidate;
}

function validateOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  rejectDuplicates: boolean,
): string[] | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const raw = value[key];
  if (!Array.isArray(raw)) {
    return invalidInput();
  }

  const length = raw.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    return invalidInput();
  }

  const result: string[] = [];
  const seen = rejectDuplicates ? new Set<string>() : undefined;
  for (let index = 0; index < length; index += 1) {
    const candidate = raw[index];
    if (!isIdentifier(candidate)) {
      return invalidInput();
    }
    if (seen !== undefined) {
      if (seen.has(candidate)) {
        return invalidInput();
      }
      seen.add(candidate);
    }
    result.push(candidate);
  }

  return result;
}

export function validateHandoffInput(value: unknown): HandoffInput {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    for (const key of Object.keys(value)) {
      if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
        return invalidInput();
      }
    }

    if (!hasOwn(value, 'schemaVersion') || value.schemaVersion !== 1) {
      return invalidInput();
    }

    if (!hasOwn(value, 'id')) {
      return invalidInput();
    }
    const id = value.id;
    if (!isIdentifier(id)) {
      return invalidInput();
    }

    if (!hasOwn(value, 'source')) {
      return invalidInput();
    }
    const source = value.source;
    if (!isIdentifier(source)) {
      return invalidInput();
    }

    if (!hasOwn(value, 'goal')) {
      return invalidInput();
    }
    const goal = value.goal;
    if (!isIdentifier(goal)) {
      return invalidInput();
    }

    const destination = validateOptionalIdentifier(value, 'destination');
    const constraints = validateOptionalStringArray(value, 'constraints', false);
    const openItems = validateOptionalStringArray(value, 'openItems', false);
    const evidenceReferences = validateOptionalStringArray(
      value,
      'evidenceReferences',
      true,
    );

    return {
      schemaVersion: 1,
      id,
      source,
      ...(destination === undefined ? {} : { destination }),
      goal,
      ...(constraints === undefined ? {} : { constraints }),
      ...(openItems === undefined ? {} : { openItems }),
      ...(evidenceReferences === undefined ? {} : { evidenceReferences }),
    };
  } catch (error) {
    if (error instanceof HandoffError) {
      throw error;
    }
    return invalidInput();
  }
}
