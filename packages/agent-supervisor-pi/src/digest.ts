/// <reference types="node" />
import { createHash } from 'node:crypto';
import { isJsonValue, type JsonValue } from './json.js';

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalizeJsonValue(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(',')}]`;
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      const keys = Reflect.ownKeys(value)
        .filter((key): key is string => typeof key === 'string')
        .sort(compareStrings);
      const entries = keys.map((key) => {
        const child = value[key];
        if (child === undefined) {
          throw new Error('Invalid JSON value.');
        }
        return `${JSON.stringify(key)}:${canonicalizeJsonValue(child)}`;
      });
      return `{${entries.join(',')}}`;
    }
  }
}

/**
 * Computes a canonical SHA-256 digest for a JSON-safe value.
 *
 * Object keys are sorted recursively and array order is preserved. `null` means that the input
 * was not JSON-safe or could not be canonicalized; the input is never returned or embedded.
 */
export function computeSupervisorJsonDigest(value: unknown): string | null {
  try {
    if (!isJsonValue(value)) {
      return null;
    }

    return createHash('sha256').update(canonicalizeJsonValue(value)).digest('hex');
  } catch {
    return null;
  }
}
