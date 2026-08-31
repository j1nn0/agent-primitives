import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  SupervisorFeatureRegistry,
  validateSupervisorFeatureDescriptor,
} from '../src/index.js';
import type { SupervisorFeatureRegistration } from '../src/index.js';

function feature(id: string, overrides: Record<string, unknown> = {}): SupervisorFeatureRegistration {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'observe',
      observes: ['tool-result'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
      ...overrides,
    }),
  };
}

describe('supervisor feature registry', () => {
  it('registers arbitrary features and lists them by ID', () => {
    const registry = new SupervisorFeatureRegistry();
    registry.register(feature('feature-c'));
    registry.register(feature('feature-a'));
    registry.register(feature('feature-b'));

    expect(registry.has('feature-b')).toBe(true);
    expect(registry.get('feature-a')?.descriptor.id).toBe('feature-a');
    expect(registry.list().map((entry) => entry.descriptor.id)).toEqual([
      'feature-a',
      'feature-b',
      'feature-c',
    ]);
  });

  it('hard-rejects duplicate feature IDs', () => {
    const registry = new SupervisorFeatureRegistry();
    registry.register(feature('feature-a'));
    expect(() => registry.register(feature('feature-a'))).toThrow(SupervisorContractError);
    expect(registry.list()).toHaveLength(1);
  });

  it('handles a feature set whose size is not eight', () => {
    const registry = new SupervisorFeatureRegistry();
    registry.register(feature('feature-a'));
    expect(registry.list()).toHaveLength(1);
  });
});
