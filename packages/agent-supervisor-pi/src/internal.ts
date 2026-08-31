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

export function hasOnlyAllowedKeys(value: object, allowedKeys: ReadonlySet<string>): boolean {
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowedKeys.has(key)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }

  try {
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
  } catch {
    return false;
  }
}
