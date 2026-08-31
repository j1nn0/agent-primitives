import { describe, expect, it } from 'vitest';
import { SupervisorContractError, validateSupervisorFeatureDescriptor } from '../src/index.js';

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'feature-a',
    schemaVersion: 1,
    maturity: 'validated',
    defaultMode: 'observe',
    observes: ['tool-result'],
    provides: ['capability:feature-a'],
    requires: ['provider-x:base'],
    conflictsWith: [],
    usesAuxiliaryModel: false,
    interventionIntents: ['verify'],
    ...overrides,
  };
}

function expectInvalid(value: unknown): void {
  expect(() => validateSupervisorFeatureDescriptor(value)).toThrow(SupervisorContractError);
}

describe('supervisor feature descriptors', () => {
  it('accepts a valid descriptor', () => {
    expect(validateSupervisorFeatureDescriptor(descriptor())).toEqual(descriptor());
  });

  it.each([
    { id: 'Feature-a' },
    { id: 'kernel' },
    { schemaVersion: 2 },
    { provides: ['bad-capability'] },
    { provides: ['capability:one', 'capability:one'] },
    { requires: ['capability:one', 'capability:one'] },
    { conflictsWith: ['feature-b', 'feature-b'] },
    { observes: ['tool-result', 'tool-result'] },
    { interventionIntents: ['verify', 'verify'] },
    { conflictsWith: ['feature-a'] },
    { conflictsWith: ['kernel'] },
    { maturity: 'experimental', defaultMode: 'autonomous' },
  ])('rejects one invalid descriptor rule %#', (override) => {
    expectInvalid(descriptor(override));
  });

  it('accepts a future capability that is not currently provided', () => {
    expect(
      validateSupervisorFeatureDescriptor(
        descriptor({ requires: ['future:capability'] }),
      ).requires,
    ).toEqual(['future:capability']);
  });
});
