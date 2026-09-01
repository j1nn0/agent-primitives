import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPERVISOR_RUNTIME_STATE,
  SUPERVISOR_STATE_CUSTOM_TYPE,
  SupervisorContractError,
  parseSupervisorStateRecord,
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

  it('provides a frozen initial runtime state', () => {
    expect(DEFAULT_SUPERVISOR_RUNTIME_STATE).toEqual({
      schemaVersion: 1,
      nextRootRequestSequence: 1,
    });
    expect(Object.isFrozen(DEFAULT_SUPERVISOR_RUNTIME_STATE)).toBe(true);
  });

  it('parses an explicitly discriminated runtime state record', () => {
    expect(
      parseSupervisorStateRecord({
        schemaVersion: 1,
        kind: 'runtime',
        state: { schemaVersion: 1, nextRootRequestSequence: 2 },
      }),
    ).toEqual({
      status: 'valid',
      record: {
        schemaVersion: 1,
        kind: 'runtime',
        state: { schemaVersion: 1, nextRootRequestSequence: 2 },
      },
    });
  });

  it('preserves JSON-safe future runtime fields without changing the schema version', () => {
    const parsed = parseSupervisorStateRecord({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 2, futureField: true },
    });
    expect(parsed).toEqual({
      status: 'valid',
      record: {
        schemaVersion: 1,
        kind: 'runtime',
        state: { schemaVersion: 1, nextRootRequestSequence: 2, futureField: true },
      },
    });
  });

  it('parses a feature record without consulting feature registration', () => {
    expect(
      parseSupervisorStateRecord({
        schemaVersion: 1,
        kind: 'feature',
        state: {
          schemaVersion: 1,
          featureId: 'future-feature',
          featureSchemaVersion: 1,
          data: { enabled: true },
        },
      }),
    ).toEqual({
      status: 'valid',
      record: {
        schemaVersion: 1,
        kind: 'feature',
        state: {
          schemaVersion: 1,
          featureId: 'future-feature',
          featureSchemaVersion: 1,
          data: { enabled: true },
        },
      },
    });
  });

  it.each([
    null,
    new Date(),
    { schemaVersion: 2, kind: 'runtime', state: { schemaVersion: 1, nextRootRequestSequence: 1 } },
    { schemaVersion: 1, kind: 'unknown', state: { schemaVersion: 1, nextRootRequestSequence: 1 } },
    { schemaVersion: 1, state: { schemaVersion: 1, nextRootRequestSequence: 1 } },
    { schemaVersion: 1, kind: 'runtime', state: { schemaVersion: 1, nextRootRequestSequence: 0 } },
    { schemaVersion: 1, kind: 'runtime', state: { schemaVersion: 1, nextRootRequestSequence: 1.5 } },
    { schemaVersion: 1, kind: 'runtime', state: { schemaVersion: 1, nextRootRequestSequence: Number.NaN } },
    { schemaVersion: 1, kind: 'feature', state: { schemaVersion: 1, featureId: 'kernel', featureSchemaVersion: 1, data: null } },
  ])('returns an invalid result for malformed persisted record %#', (value) => {
    expect(() => parseSupervisorStateRecord(value)).not.toThrow();
    expect(parseSupervisorStateRecord(value).status).toBe('invalid');
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
