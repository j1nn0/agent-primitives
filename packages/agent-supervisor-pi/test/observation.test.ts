import { describe, expect, it } from 'vitest';
import {
  SUPERVISOR_OBSERVATION_KINDS,
  SupervisorContractError,
  isSupervisorObservationKind,
  validateSupervisorObservation,
} from '../src/index.js';
import { SupervisorObservationNormalizer } from '../src/kernel/observation.js';
import type { SupervisorPiObservationEvent } from '../src/kernel/observation.js';

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

  it('recognizes assessment-ready with its bounded payload', () => {
    const payload = { assessmentId: 'assessment-1', runSequence: 1 };
    const validated = validateSupervisorObservation(
      observation({ kind: 'assessment-ready', payload }),
    );

    expect(SUPERVISOR_OBSERVATION_KINDS).toContain('assessment-ready');
    expect(isSupervisorObservationKind('assessment-ready')).toBe(true);
    expect(validated).toMatchObject({ kind: 'assessment-ready', payload });
  });

  it('shares the canonical sequence between Pi and internal observations', () => {
    const normalizer = new SupervisorObservationNormalizer();
    const observations = [
      normalizer.normalize(
        { type: 'input', source: 'interactive', text: 'task-1' } as SupervisorPiObservationEvent,
        'root-1',
      )!,
      normalizer.createInternal(
        'assessment-ready',
        { assessmentId: 'assessment-1', runSequence: 1 },
        'root-1',
      ),
      normalizer.normalize(
        { type: 'input', source: 'rpc', text: 'task-2' } as SupervisorPiObservationEvent,
        'root-2',
      )!,
      normalizer.createInternal(
        'assessment-ready',
        { assessmentId: 'assessment-2', runSequence: 2 },
        null,
      ),
    ];

    expect(observations.map((item) => item.id)).toEqual([
      'observation-0',
      'observation-1',
      'observation-2',
      'observation-3',
    ]);
    expect(observations.map((item) => item.sequence)).toEqual([0, 1, 2, 3]);
  });

  it('carries the supplied root request id for internal observations, including null', () => {
    const normalizer = new SupervisorObservationNormalizer();

    expect(
      normalizer.createInternal(
        'assessment-ready',
        { assessmentId: 'assessment-1', runSequence: 1 },
        'root-1',
      ).rootRequestId,
    ).toBe('root-1');
    expect(
      normalizer.createInternal(
        'assessment-ready',
        { assessmentId: 'assessment-2', runSequence: 2 },
        null,
      ).rootRequestId,
    ).toBeNull();
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
