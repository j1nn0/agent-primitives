import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_KERNEL_CAPABILITIES_V1,
  SUPERVISOR_KERNEL_CAPABILITY_NAMESPACE,
  SUPERVISOR_KERNEL_SOURCE_ID,
  SupervisorContractError,
  isSupervisorKernelCapabilityId,
  validateSupervisorFeatureDescriptor,
} from '../src/index.js';

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

  it('accepts an assessment consumer that uses the auxiliary model', () => {
    const validated = validateSupervisorFeatureDescriptor(
      descriptor({ requires: ['kernel:assessment'], usesAuxiliaryModel: true }),
    );

    expect(validated.requires).toEqual(['kernel:assessment']);
    expect(validated.usesAuxiliaryModel).toBe(true);
  });

  it('rejects an assessment consumer that disables auxiliary model use', () => {
    expectInvalid(
      descriptor({ requires: ['kernel:assessment'], usesAuxiliaryModel: false }),
    );
  });

  it('accepts auxiliary model use without an assessment requirement', () => {
    expect(
      validateSupervisorFeatureDescriptor(descriptor({ usesAuxiliaryModel: true })).usesAuxiliaryModel,
    ).toBe(true);
  });

  it('keeps non-assessment features valid without auxiliary model use', () => {
    expect(
      validateSupervisorFeatureDescriptor(
        descriptor({ requires: ['provider-x:base'], usesAuxiliaryModel: false }),
      ),
    ).toMatchObject({ requires: ['provider-x:base'], usesAuxiliaryModel: false });
  });

  it('defines the reserved kernel capabilities without reserving other namespaces', () => {
    expect(SUPERVISOR_KERNEL_CAPABILITY_NAMESPACE).toBe(SUPERVISOR_KERNEL_SOURCE_ID);
    expect(SUPERVISOR_KERNEL_CAPABILITIES_V1).toEqual([
      'kernel:observation',
      'kernel:persistence',
      'kernel:intervention',
      'kernel:assessment',
    ]);
    expect(Object.isFrozen(SUPERVISOR_KERNEL_CAPABILITIES_V1)).toBe(true);
    expect(isSupervisorKernelCapabilityId('kernel:observation')).toBe(true);
    expect(isSupervisorKernelCapabilityId('provider-x:ready')).toBe(false);
    expect(isSupervisorKernelCapabilityId('kernel')).toBe(false);
  });

  it('allows kernel requirements and open non-kernel capability namespaces', () => {
    expect(
      validateSupervisorFeatureDescriptor(
        descriptor({
          provides: ['evidence:source', 'progress:milestone', 'provider-x:ready'],
          requires: ['kernel:observation'],
        }),
      ),
    ).toMatchObject({
      provides: ['evidence:source', 'progress:milestone', 'provider-x:ready'],
      requires: ['kernel:observation'],
    });
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
    { provides: ['kernel:observation'] },
    { provides: ['kernel:assessment'] },
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
