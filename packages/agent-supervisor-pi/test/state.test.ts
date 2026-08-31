import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_STATE_CUSTOM_TYPE,
  SupervisorContractError,
  validateSupervisorFeatureStateEnvelope,
} from '../src/index.js';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    featureId: 'feature-a',
    featureSchemaVersion: 1,
    data: { count: 1 },
    ...overrides,
  };
}

describe('supervisor feature state', () => {
  it('uses the reserved kernel state custom type name', () => {
    expect(SUPERVISOR_STATE_CUSTOM_TYPE).toBe('agent-supervisor-state');
  });

  it('accepts a valid state envelope', () => {
    expect(validateSupervisorFeatureStateEnvelope(envelope())).toEqual(envelope());
  });

  it.each([
    { schemaVersion: 2 },
    { featureId: 'Feature-a' },
    { featureId: 'kernel' },
    { featureSchemaVersion: 0 },
    { featureSchemaVersion: -1 },
    { featureSchemaVersion: 1.5 },
    { featureSchemaVersion: Number.NaN },
    { data: new Date() },
    { extra: true },
  ])('rejects malformed state envelopes %#', (override) => {
    expect(() => validateSupervisorFeatureStateEnvelope(envelope(override))).toThrow(
      SupervisorContractError,
    );
  });
});
