import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_OBSERVATION_KINDS,
  SupervisorContractError,
  isSupervisorObservationKind,
  validateSupervisorObservation,
} from '../src/index.js';

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'observation-1',
    sequence: 0,
    rootRequestId: null,
    kind: 'tool-result',
    payload: { ok: true },
    ...overrides,
  };
}

describe('supervisor observations', () => {
  it('accepts every builtin kind', () => {
    for (const kind of SUPERVISOR_OBSERVATION_KINDS) {
      expect(isSupervisorObservationKind(kind)).toBe(true);
      expect(validateSupervisorObservation(observation({ kind })).kind).toBe(kind);
    }
  });

  it('accepts future unprefixed kebab kinds', () => {
    expect(isSupervisorObservationKind('future-observation-kind')).toBe(true);
    expect(validateSupervisorObservation(observation({ kind: 'future-observation-kind' })).kind).toBe(
      'future-observation-kind',
    );
  });

  it.each([
    { schemaVersion: 2 },
    { sequence: -1 },
    { sequence: 1.5 },
    { payload: undefined },
    { payload: new Date() },
    { extra: true },
  ])('rejects malformed envelopes %#', (override) => {
    expect(() => validateSupervisorObservation(observation(override))).toThrow(SupervisorContractError);
  });
});
