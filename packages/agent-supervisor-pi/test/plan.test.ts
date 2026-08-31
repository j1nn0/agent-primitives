import { describe, expect, it } from 'vitest';
import {
  SupervisorFeatureRegistry,
  resolveSupervisorPlan,
  validateSupervisorFeatureDescriptor,
} from '../src/index.js';
import type { SupervisorFeatureRegistration, SupervisorPlan } from '../src/index.js';

function feature(
  id: string,
  overrides: Record<string, unknown> = {},
): SupervisorFeatureRegistration {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: [],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
      ...overrides,
    }),
  };
}

function resolve(
  features: readonly SupervisorFeatureRegistration[],
  config: unknown = { schemaVersion: 1, mode: 'autonomous', features: {} },
  kernelCapabilities: readonly string[] = [],
): SupervisorPlan {
  return resolveSupervisorPlan({ features, config, kernelCapabilities });
}

function modes(plan: SupervisorPlan): Record<string, string> {
  return Object.fromEntries(plan.features.map((entry) => [entry.id, entry.effectiveMode]));
}

describe('supervisor plan resolution', () => {
  it('applies autonomous, observe, and off global ceilings', () => {
    const features = [feature('feature-a')];
    expect(modes(resolve(features))).toEqual({ 'feature-a': 'autonomous' });
    expect(
      modes(resolve(features, { schemaVersion: 1, mode: 'observe', features: {} })),
    ).toEqual({ 'feature-a': 'observe' });
    expect(modes(resolve(features, { schemaVersion: 1, mode: 'off', features: {} }))).toEqual({
      'feature-a': 'off',
    });
  });

  it('satisfies a dependency from a kernel capability', () => {
    const plan = resolve(
      [feature('feature-a', { requires: ['provider-x:ready'] })],
      undefined,
      ['provider-x:ready'],
    );
    expect(plan.features[0]?.effectiveMode).toBe('autonomous');
  });

  it('satisfies a dependency from another feature provider', () => {
    const plan = resolve([
      feature('feature-a', { provides: ['feature:ready'] }),
      feature('feature-b', { requires: ['feature:ready'] }),
    ]);
    expect(modes(plan)).toEqual({ 'feature-a': 'autonomous', 'feature-b': 'autonomous' });
  });

  it('marks a missing capability unavailable', () => {
    const plan = resolve([feature('feature-a', { requires: ['missing:capability'] })]);
    expect(plan.features[0]).toMatchObject({
      effectiveMode: 'unavailable',
      reason: 'dependency-unsatisfied',
    });
  });

  it('resolves an A-to-B-to-C chain for every registration permutation', () => {
    const definitions = [
      feature('feature-a', { requires: ['provider-b:ready'], provides: ['provider-a:ready'] }),
      feature('feature-b', { requires: ['provider-c:ready'], provides: ['provider-b:ready'] }),
      feature('feature-c', { provides: ['provider-c:ready'] }),
    ];
    const expected = { 'feature-a': 'autonomous', 'feature-b': 'autonomous', 'feature-c': 'autonomous' };
    const permutations = [
      definitions,
      [definitions[2]!, definitions[0]!, definitions[1]!],
      [definitions[1]!, definitions[2]!, definitions[0]!],
      [definitions[0]!, definitions[1]!, definitions[2]!],
    ];
    for (const permutation of permutations) {
      expect(modes(resolve(permutation))).toEqual(expected);
    }
  });

  it('fails safe for an unrooted two-feature dependency cycle', () => {
    const plan = resolve([
      feature('feature-a', { requires: ['provider-b:ready'], provides: ['provider-a:ready'] }),
      feature('feature-b', { requires: ['provider-a:ready'], provides: ['provider-b:ready'] }),
    ]);
    expect(plan.features).toEqual([
      expect.objectContaining({ id: 'feature-a', effectiveMode: 'unavailable', reason: 'dependency-unsatisfied' }),
      expect.objectContaining({ id: 'feature-b', effectiveMode: 'unavailable', reason: 'dependency-unsatisfied' }),
    ]);
  });

  it('marks both enabled sides of a conflict unavailable', () => {
    const plan = resolve([
      feature('feature-a', { conflictsWith: ['feature-b'] }),
      feature('feature-b'),
    ]);
    expect(plan.features).toEqual([
      expect.objectContaining({ id: 'feature-a', effectiveMode: 'unavailable', reason: 'conflict' }),
      expect.objectContaining({ id: 'feature-b', effectiveMode: 'unavailable', reason: 'conflict' }),
    ]);
  });

  it('lets the other side resolve when one conflict side is off', () => {
    const plan = resolve([
      feature('feature-a', { conflictsWith: ['feature-b'] }),
      feature('feature-b'),
    ], {
      schemaVersion: 1,
      mode: 'autonomous',
      features: { 'feature-b': { mode: 'off' } },
    });
    expect(plan.features).toEqual([
      expect.objectContaining({ id: 'feature-a', effectiveMode: 'autonomous' }),
      expect.objectContaining({ id: 'feature-b', effectiveMode: 'off' }),
    ]);
  });

  it('returns deeply equal plans for registration permutations', () => {
    const definitions = [
      feature('feature-a', { provides: ['provider-a:ready'] }),
      feature('feature-b', { requires: ['provider-a:ready'] }),
      feature('feature-c', { conflictsWith: ['feature-d'] }),
      feature('feature-d'),
    ];
    const config = {
      schemaVersion: 1,
      mode: 'autonomous',
      features: { 'feature-d': { mode: 'off' }, 'feature-b': { mode: 'observe' } },
    };
    const plans = [
      resolve(definitions, config),
      resolve([definitions[3]!, definitions[1]!, definitions[0]!, definitions[2]!], config),
      resolve([definitions[2]!, definitions[0]!, definitions[3]!, definitions[1]!], config),
    ];
    expect(plans[1]).toEqual(plans[0]);
    expect(plans[2]).toEqual(plans[0]);
  });

  it('keeps registry ordering separate from plan ordering', () => {
    const registry = new SupervisorFeatureRegistry();
    registry.register(feature('feature-c'));
    registry.register(feature('feature-a'));
    registry.register(feature('feature-b'));
    expect(resolve(registry.list()).features.map((entry) => entry.id)).toEqual([
      'feature-a',
      'feature-b',
      'feature-c',
    ]);
  });
});
