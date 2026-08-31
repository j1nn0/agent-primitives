import { SupervisorContractError } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function visitJsonValue(value: unknown, path: Set<object>): value is JsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }

  if (path.has(value)) {
    return false;
  }

  path.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return false;
      }

      const array = value as readonly unknown[];
      for (let index = 0; index < array.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          return false;
        }
        if (!visitJsonValue(descriptor.value, path)) {
          return false;
        }
      }

      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          return false;
        }
        if (key === 'length') {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !('value' in descriptor)) {
            return false;
          }
          continue;
        }

        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= array.length || String(index) !== key) {
          return false;
        }
      }

      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        return false;
      }
      if (!visitJsonValue(descriptor.value, path)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  } finally {
    path.delete(value);
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  return visitJsonValue(value, new Set<object>());
}

export function assertJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new SupervisorContractError('invalid_json_value', 'Invalid JSON value.');
  }
  return value;
}
