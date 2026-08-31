import { describe, expect, it } from 'vitest';
import { assertJsonValue, isJsonValue, SupervisorContractError } from '../src/index.js';

class ExampleClass {
  readonly value = 1;
}

describe('JSON boundary', () => {
  it('accepts strict JSON primitives and nested values', () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(0)).toBe(true);
    expect(isJsonValue('')).toBe(true);
    expect(isJsonValue(false)).toBe(true);
    expect(isJsonValue({ nested: [null, 1, 'text', false] })).toBe(true);
  });

  it('accepts a shared acyclic object', () => {
    const shared = { value: 1 };
    expect(isJsonValue({ left: shared, right: shared })).toBe(true);
  });

  it.each([
    undefined,
    () => undefined,
    Symbol('value'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(),
    new Map(),
    new Set(),
    /pattern/,
    new ExampleClass(),
  ])('rejects non-JSON value %#', (value) => {
    expect(isJsonValue(value)).toBe(false);
  });

  it('rejects an own symbol key', () => {
    const value: Record<string | symbol, unknown> = { value: 1 };
    value[Symbol('key')] = 2;
    expect(isJsonValue(value)).toBe(false);
  });

  it('rejects undefined in arrays and object properties', () => {
    expect(isJsonValue([undefined])).toBe(false);
    expect(isJsonValue({ value: undefined })).toBe(false);
  });

  it('rejects sparse arrays', () => {
    const value: unknown[] = [];
    value.length = 1;
    expect(isJsonValue(value)).toBe(false);
  });

  it('rejects direct and indirect cycles', () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;
    expect(isJsonValue(direct)).toBe(false);

    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    first.next = second;
    second.next = first;
    expect(isJsonValue(first)).toBe(false);
  });

  it('asserts with the documented error shape', () => {
    expect(() => assertJsonValue(undefined)).toThrow(SupervisorContractError);
    try {
      assertJsonValue(undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisorContractError);
      expect((error as SupervisorContractError).code).toBe('invalid_json_value');
      expect((error as SupervisorContractError).message).toBe('Invalid JSON value.');
    }
  });
});
