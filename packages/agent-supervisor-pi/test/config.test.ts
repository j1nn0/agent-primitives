import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  SupervisorFeatureRegistry,
  parseSupervisorConfig,
  resolveSupervisorPlan,
  validateSupervisorFeatureDescriptor,
} from '../src/index.js';
import type { SupervisorFeatureRegistration } from '../src/index.js';

function feature(
  id: string,
  defaultMode: 'autonomous' | 'observe' | 'off' = 'autonomous',
): SupervisorFeatureRegistration {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id,
      schemaVersion: 1,
      maturity: defaultMode === 'autonomous' ? 'validated' : 'experimental',
      defaultMode,
      observes: ['tool-result'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
    }),
  };
}

describe('supervisor configuration and resolution', () => {
  it('provides the deeply frozen install-and-forget default', () => {
    expect(DEFAULT_SUPERVISOR_CONFIG).toEqual({
      schemaVersion: 1,
      mode: 'autonomous',
      features: {},
    });
    expect(Object.isFrozen(DEFAULT_SUPERVISOR_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SUPERVISOR_CONFIG.features)).toBe(true);
  });

  it('parses valid per-feature settings and preserves unknown future entries', () => {
    const parsed = parseSupervisorConfig({
      schemaVersion: 1,
      mode: 'autonomous',
      features: {
        'feature-a': { mode: 'observe' },
        'future-feature': { settings: { enabled: true } },
      },
    });
    expect(parsed.status).toBe('valid');
    if (parsed.status === 'valid') {
      expect(parsed.config.features['future-feature']).toEqual({ settings: { enabled: true } });
      expect(parsed.featureDiagnostics).toEqual([]);
    }
  });

  it('isolates a reserved kernel config entry from a valid sibling', () => {
    const config = {
      schemaVersion: 1,
      mode: 'autonomous',
      features: {
        kernel: { mode: 'autonomous' },
        'feature-a': {},
      },
    };
    const parsed = parseSupervisorConfig(config);

    expect(parsed.status).toBe('valid');
    if (parsed.status === 'valid') {
      expect(parsed.config.features).toEqual({ 'feature-a': {} });
      expect(parsed.featureDiagnostics).toEqual([
        { code: 'reserved-feature-id', featureId: 'kernel' },
      ]);
    }

    const plan = resolveSupervisorPlan({
      features: [feature('feature-a')],
      config,
      kernelCapabilities: [],
    });
    expect(plan.configStatus).toBe('valid');
    expect(plan.configDiagnostics).toEqual([
      { code: 'reserved-feature-id', featureId: 'kernel' },
    ]);
    expect(plan.features).toEqual([
      expect.objectContaining({ id: 'feature-a', effectiveMode: 'autonomous' }),
    ]);
  });

  it('applies overrides in both directions and honors explicit off', () => {
    const registry = new SupervisorFeatureRegistry();
    registry.register(feature('feature-a', 'autonomous'));
    registry.register(feature('feature-b', 'observe'));
    registry.register(feature('feature-c', 'autonomous'));

    const plan = resolveSupervisorPlan({
      features: registry.list(),
      config: {
        schemaVersion: 1,
        mode: 'autonomous',
        features: {
          'feature-a': { mode: 'observe' },
          'feature-b': { mode: 'autonomous' },
          'feature-c': { mode: 'off' },
        },
      },
      kernelCapabilities: [],
    });

    expect(plan.features.map((entry) => [entry.id, entry.effectiveMode])).toEqual([
      ['feature-a', 'observe'],
      ['feature-b', 'autonomous'],
      ['feature-c', 'off'],
    ]);
  });

  it('preserves an unknown future entry while resolving other features', () => {
    const registered = feature('feature-a');
    const plan = resolveSupervisorPlan({
      features: [registered],
      config: {
        schemaVersion: 1,
        mode: 'autonomous',
        features: {
          'future-feature': { mode: 'observe' },
        },
      },
      kernelCapabilities: [],
    });

    expect(plan.features).toEqual([
      expect.objectContaining({ id: 'feature-a', effectiveMode: 'autonomous' }),
      expect.objectContaining({
        id: 'future-feature',
        requestedMode: 'observe',
        effectiveMode: 'unavailable',
        reason: 'not-registered',
      }),
    ]);
  });

  it('isolates an invalid feature entry from a valid sibling', () => {
    const plan = resolveSupervisorPlan({
      features: [feature('feature-a'), feature('feature-b')],
      config: {
        schemaVersion: 1,
        mode: 'autonomous',
        features: {
          'feature-a': { settings: new Date() },
          'feature-b': {},
        },
      },
      kernelCapabilities: [],
    });

    expect(plan.configStatus).toBe('valid');
    expect(plan.configDiagnostics).toEqual([
      { code: 'invalid-feature-entry', featureId: 'feature-a' },
    ]);
    expect(plan.features).toEqual([
      expect.objectContaining({
        id: 'feature-a',
        effectiveMode: 'unavailable',
        reason: 'invalid-config',
      }),
      expect.objectContaining({ id: 'feature-b', effectiveMode: 'autonomous' }),
    ]);
  });

  it.each([
    { schemaVersion: 2, mode: 'autonomous', features: {} },
    { schemaVersion: 1, mode: 'invalid', features: {} },
    { schemaVersion: 1, mode: 'autonomous', features: {}, extra: true },
    { schemaVersion: 1, mode: 'autonomous', features: [] },
    'not-an-object',
  ])('degrades safely for corrupt top-level configuration %#', (config) => {
    const plan = resolveSupervisorPlan({
      features: [feature('feature-a')],
      config,
      kernelCapabilities: [],
    });
    expect(plan.configStatus).toBe('degraded');
    expect(plan.requestedGlobalMode).toBeNull();
    expect(plan.effectiveGlobalMode).toBe('observe');
    expect(plan.features[0]?.effectiveMode).toBe('observe');
    expect(plan.features[0]?.reason).toBe('global-observe');
  });

  it('rejects a symbol-keyed feature map as a top-level failure', () => {
    const features: Record<string | symbol, unknown> = {};
    features[Symbol('feature')] = {};

    expect(
      parseSupervisorConfig({ schemaVersion: 1, mode: 'autonomous', features }),
    ).toEqual({
      status: 'invalid',
      diagnostics: [{ code: 'invalid-features' }],
    });
  });
});
