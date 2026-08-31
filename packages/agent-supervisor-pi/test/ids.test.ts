import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_KERNEL_SOURCE_ID,
  assertRegistrableSupervisorFeatureId,
  assertSupervisorCapabilityId,
  assertSupervisorFeatureId,
  assertSupervisorFactKind,
  assertSupervisorNamespacedId,
  assertSupervisorReasonCode,
  isRegistrableSupervisorFeatureId,
  isSupervisorCapabilityId,
  isSupervisorFactKind,
  isSupervisorFeatureId,
  isSupervisorNamespacedId,
  isSupervisorReasonCode,
} from '../src/index.js';

describe('supervisor identifiers', () => {
  it('accepts feature IDs with strict segments', () => {
    for (const value of ['feature-a', 'feature1', 'feature-a-long']) {
      expect(isSupervisorFeatureId(value)).toBe(true);
    }
  });

  it('recognizes kernel syntactically but reserves it from registration', () => {
    expect(SUPERVISOR_KERNEL_SOURCE_ID).toBe('kernel');
    expect(isSupervisorFeatureId(SUPERVISOR_KERNEL_SOURCE_ID)).toBe(true);
    expect(isRegistrableSupervisorFeatureId(SUPERVISOR_KERNEL_SOURCE_ID)).toBe(false);
    expect(() => assertRegistrableSupervisorFeatureId(SUPERVISOR_KERNEL_SOURCE_ID)).toThrow(
      'Invalid registrable supervisor feature ID.',
    );
  });

  it('rejects malformed feature IDs', () => {
    for (const value of [
      '1feature',
      'Feature-a',
      'feature-a-',
      'feature--a',
      '',
      'feature:a',
      'feature_a',
    ]) {
      expect(isSupervisorFeatureId(value)).toBe(false);
    }
  });

  it('accepts and rejects namespaced IDs by the same segment grammar', () => {
    for (const value of ['provider-x:observation', 'provider-y:source', 'provider-z:repeated-failure']) {
      expect(isSupervisorNamespacedId(value)).toBe(true);
      expect(isSupervisorCapabilityId(value)).toBe(true);
      expect(isSupervisorFactKind(value)).toBe(true);
      expect(isSupervisorReasonCode(value)).toBe(true);
    }
    for (const value of [
      'feature-a',
      '1feature:source',
      'feature:Source',
      'feature-:source',
      'feature--a:source',
      ':source',
      'feature:',
      'feature:source:extra',
      '',
    ]) {
      expect(isSupervisorNamespacedId(value)).toBe(false);
    }
  });

  it('asserts invalid identifiers without exposing payloads', () => {
    expect(() => assertSupervisorFeatureId('Feature-a')).toThrow('Invalid supervisor feature ID.');
    expect(() => assertSupervisorNamespacedId('feature')).toThrow('Invalid supervisor namespaced ID.');
    expect(() => assertSupervisorCapabilityId('feature')).toThrow('Invalid supervisor capability ID.');
    expect(() => assertSupervisorFactKind('feature')).toThrow('Invalid supervisor fact kind.');
    expect(() => assertSupervisorReasonCode('feature')).toThrow('Invalid supervisor reason code.');
  });
});
