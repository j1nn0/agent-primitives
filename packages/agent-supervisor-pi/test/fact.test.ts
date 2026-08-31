import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  createSupervisorFactRecord,
  createSupervisorFactSnapshot,
  validateSupervisorFactCandidate,
} from '../src/index.js';

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'feature-a:signal',
    evidenceRefs: ['trace-1'],
    data: { observed: true },
    ...overrides,
  };
}

function expectInvalid(value: unknown): void {
  expect(() => validateSupervisorFactCandidate(value)).toThrow(SupervisorContractError);
}

describe('supervisor facts', () => {
  it('accepts a valid fact candidate with exactly content fields', () => {
    expect(validateSupervisorFactCandidate(candidate())).toEqual(candidate());
  });

  it('rejects an invalid namespaced kind', () => {
    expectInvalid(candidate({ kind: 'signal' }));
    expectInvalid(candidate({ kind: 'Feature-a:signal' }));
  });

  it('rejects duplicate and empty evidence references', () => {
    expectInvalid(candidate({ evidenceRefs: ['trace-1', 'trace-1'] }));
    expectInvalid(candidate({ evidenceRefs: [''] }));
  });

  it('rejects non-JSON data', () => {
    expectInvalid(candidate({ data: new Date() }));
  });

  it('rejects kernel-owned identity fields on a candidate', () => {
    expectInvalid(candidate({ id: 'fact-1' }));
    expectInvalid(candidate({ sequence: 1 }));
    expectInvalid(candidate({ sourceFeatureId: 'feature-a' }));
    expectInvalid(candidate({ rootRequestId: 'root-1' }));
  });

  it('stamps a feature fact with a deterministic kernel-owned identity', () => {
    const record = createSupervisorFactRecord({
      candidate: validateSupervisorFactCandidate(candidate()),
      sourceFeatureId: 'feature-a',
      rootRequestId: 'root-1',
      sequence: 7,
    });
    expect(record).toEqual({
      schemaVersion: 1,
      id: 'fact-7',
      sequence: 7,
      sourceFeatureId: 'feature-a',
      rootRequestId: 'root-1',
      kind: 'feature-a:signal',
      evidenceRefs: ['trace-1'],
      data: { observed: true },
    });
  });

  it('accepts kernel-sourced facts in the kernel namespace', () => {
    const record = createSupervisorFactRecord({
      candidate: validateSupervisorFactCandidate(candidate({ kind: 'kernel:signal' })),
      sourceFeatureId: 'kernel',
      rootRequestId: null,
      sequence: 0,
    });
    expect(record.sourceFeatureId).toBe('kernel');
    expect(record.kind).toBe('kernel:signal');
  });

  it.each([
    ['kernel', 'kernel:signal', true],
    ['kernel', 'feature-a:signal', false],
    ['feature-a', 'feature-a:signal', true],
    ['feature-a', 'feature-b:signal', false],
    ['feature-a', 'kernel:signal', false],
  ] as const)('enforces fact namespace ownership for %s and %s', (sourceFeatureId, kind, valid) => {
    const createRecord = () =>
      createSupervisorFactRecord({
        candidate: validateSupervisorFactCandidate(candidate({ kind })),
        sourceFeatureId,
        rootRequestId: null,
        sequence: 0,
      });

    if (valid) {
      expect(createRecord).not.toThrow();
    } else {
      expect(createRecord).toThrow(SupervisorContractError);
    }
  });

  it('rejects a fact whose namespace does not match its source', () => {
    expect(() =>
      createSupervisorFactRecord({
        candidate: validateSupervisorFactCandidate(candidate()),
        sourceFeatureId: 'feature-b',
        rootRequestId: null,
        sequence: 1,
      }),
    ).toThrow(SupervisorContractError);
  });

  it('returns a frozen sequence-ordered snapshot independent of its source array', () => {
    const late = createSupervisorFactRecord({
      candidate: validateSupervisorFactCandidate(candidate({ kind: 'feature-a:late' })),
      sourceFeatureId: 'feature-a',
      rootRequestId: null,
      sequence: 2,
    });
    const early = createSupervisorFactRecord({
      candidate: validateSupervisorFactCandidate(candidate({ kind: 'feature-a:early' })),
      sourceFeatureId: 'feature-a',
      rootRequestId: null,
      sequence: 1,
    });
    const other = createSupervisorFactRecord({
      candidate: validateSupervisorFactCandidate(
        candidate({ kind: 'feature-b:signal', evidenceRefs: ['trace-2'] }),
      ),
      sourceFeatureId: 'feature-b',
      rootRequestId: null,
      sequence: 3,
    });
    const source = [late, early, other];
    const snapshot = createSupervisorFactSnapshot(source);
    source.reverse();
    source.push(
      createSupervisorFactRecord({
        candidate: validateSupervisorFactCandidate(candidate({ kind: 'feature-a:new' })),
        sourceFeatureId: 'feature-a',
        rootRequestId: null,
        sequence: 4,
      }),
    );

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.all())).toBe(true);
    expect(snapshot.all().map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(snapshot.byKind('feature-a:late').map((record) => record.id)).toEqual(['fact-2']);
    expect(Object.isFrozen(snapshot.byKind('feature-a:late'))).toBe(true);
  });
});
