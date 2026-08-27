import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as handoffApi from '../src/index.js';
import { HandoffError, createHandoff } from '../src/index.js';
import type { HandoffErrorCode, HandoffInput, HandoffPacket } from '../src/index.js';

function expectHandoffError(
  action: () => unknown,
  code: HandoffErrorCode = 'invalid_input',
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HandoffError);
  expect((thrown as HandoffError).name).toBe('HandoffError');
  expect((thrown as HandoffError).code).toBe(code);
  expect((thrown as HandoffError).message).toBe('Invalid handoff input.');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const MINIMAL: HandoffInput = {
  schemaVersion: 1,
  id: 'handoff-1',
  source: 'engineer',
  goal: 'Review the pull request.',
};

const VALID: HandoffInput = {
  ...MINIMAL,
  destination: 'reviewer',
  constraints: ['Run the tests.', 'Check the diff.'],
  openItems: ['Confirm the deployment note.'],
  evidenceReferences: ['tests-run-123', 'lint-pass-456'],
};

describe('agent handoff public boundary', () => {
  it('exports only the public runtime values and has no dependencies', () => {
    expect(Object.keys(handoffApi).sort()).toEqual(['HandoffError', 'createHandoff']);

    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
  });

  it('returns the minimal valid packet', () => {
    expect(createHandoff(MINIMAL)).toEqual(MINIMAL);
    expect(Object.keys(createHandoff(MINIMAL)).sort()).toEqual([
      'goal',
      'id',
      'schemaVersion',
      'source',
    ]);
  });

  it('accepts a null-prototype plain object', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, MINIMAL);
    expect(createHandoff(input)).toEqual(MINIMAL);
  });

  it('rejects non-plain inputs and objects with inherited fields', () => {
    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      42,
      'input',
      [],
      new Date(),
      Object.create({ ...MINIMAL }),
    ];

    for (const input of invalidInputs) {
      expectHandoffError(() => createHandoff(input));
    }
  });

  it('requires each required field to be present and a non-whitespace string', () => {
    const missingFields: readonly Record<string, unknown>[] = [
      { source: 'engineer', goal: 'goal' },
      { schemaVersion: 1, goal: 'goal' },
      { schemaVersion: 1, source: 'engineer' },
    ];
    for (const input of missingFields) {
      expectHandoffError(() => createHandoff(input));
    }

    const invalidValues: readonly Record<string, unknown>[] = [
      { schemaVersion: 1, id: 42, source: 'engineer', goal: 'goal' },
      { schemaVersion: 1, id: 'id', source: null, goal: 'goal' },
      { schemaVersion: 1, id: 'id', source: 'engineer', goal: false },
      { schemaVersion: 1, id: '', source: 'engineer', goal: 'goal' },
      { schemaVersion: 1, id: ' \t\n', source: 'engineer', goal: 'goal' },
      { schemaVersion: 1, id: 'id', source: '', goal: 'goal' },
      { schemaVersion: 1, id: 'id', source: ' \t\n', goal: 'goal' },
      { schemaVersion: 1, id: 'id', source: 'engineer', goal: '' },
      { schemaVersion: 1, id: 'id', source: 'engineer', goal: ' \t\n' },
    ];
    for (const input of invalidValues) {
      expectHandoffError(() => createHandoff(input));
    }
  });

  it('requires schemaVersion to be exactly the number 1', () => {
    const invalidVersions: readonly unknown[] = [
      undefined,
      null,
      0,
      2,
      -1,
      1.1,
      NaN,
      Infinity,
      '1',
      true,
      1n,
    ];

    for (const schemaVersion of invalidVersions) {
      expectHandoffError(() => createHandoff({ ...MINIMAL, schemaVersion }));
    }
    expect(createHandoff({ ...MINIMAL, schemaVersion: 1 })).toEqual(MINIMAL);
  });

  it('validates destination only when it is present', () => {
    expect(createHandoff(MINIMAL)).not.toHaveProperty('destination');

    const invalidDestinations: readonly unknown[] = ['', ' \t\n', undefined, null, 42];
    for (const destination of invalidDestinations) {
      expectHandoffError(() => createHandoff({ ...MINIMAL, destination }));
    }

    expect(createHandoff({ ...MINIMAL, destination: ' reviewer ' })).toEqual({
      ...MINIMAL,
      destination: ' reviewer ',
    });
  });

  it('validates constraints and openItems arrays while allowing duplicate prose', () => {
    const input: HandoffInput = {
      ...MINIMAL,
      constraints: [' first ', 'first', ' first '],
      openItems: ['open', ' open ', 'open'],
    };
    const packet = createHandoff(input);
    expect(packet.constraints).toEqual([' first ', 'first', ' first ']);
    expect(packet.openItems).toEqual(['open', ' open ', 'open']);

    const invalidArrays: readonly unknown[] = [
      undefined,
      null,
      'not-an-array',
      [null],
      [42],
      [''],
      [' \t\n'],
      ['valid', undefined],
    ];
    for (const invalid of invalidArrays) {
      expectHandoffError(() => createHandoff({ ...MINIMAL, constraints: invalid }));
      expectHandoffError(() => createHandoff({ ...MINIMAL, openItems: invalid }));
    }

    const sparse = ['present'] as string[];
    delete sparse[0];
    expectHandoffError(() => createHandoff({ ...MINIMAL, constraints: sparse }));
    expect(createHandoff({ ...MINIMAL, constraints: [] })).toEqual({
      ...MINIMAL,
      constraints: [],
    });
    expect(createHandoff({ ...MINIMAL, openItems: [] })).toEqual({
      ...MINIMAL,
      openItems: [],
    });
  });

  it('rejects duplicate evidence references but accepts distinct opaque spellings', () => {
    expectHandoffError(() =>
      createHandoff({ ...MINIMAL, evidenceReferences: ['proof', 'proof'] }),
    );
    expectHandoffError(() =>
      createHandoff({ ...MINIMAL, evidenceReferences: [' proof ', ' proof '] }),
    );

    expect(
      createHandoff({
        ...MINIMAL,
        evidenceReferences: [' proof ', 'proof'],
      }),
    ).toEqual({
      ...MINIMAL,
      evidenceReferences: [' proof ', 'proof'],
    });
    expect(createHandoff({ ...MINIMAL, evidenceReferences: [] })).toEqual({
      ...MINIMAL,
      evidenceReferences: [],
    });
    expectHandoffError(() =>
      createHandoff({ ...MINIMAL, evidenceReferences: 'not-an-array' }),
    );
  });

  it('rejects every unknown top-level key before field validation', () => {
    const unknownKeys = [
      'createdAt',
      'timestamp',
      'summary',
      'tags',
      'metadata',
      'recipient',
      'author',
      'stateReferences',
      'verdict',
      'retryAllowed',
      'progress',
    ];

    for (const key of unknownKeys) {
      expectHandoffError(() => createHandoff({ ...MINIMAL, [key]: 'unexpected' }));
    }

    const input = { ...MINIMAL } as Record<string, unknown>;
    Object.defineProperty(input, 'metadata', {
      enumerable: true,
      get() {
        throw new Error('unknown getter should not be read');
      },
    });
    expectHandoffError(() => createHandoff(input));
  });

  it('preserves identifier spelling and treats surrounding spaces as significant', () => {
    const input: HandoffInput = {
      schemaVersion: 1,
      id: ' handoff ',
      source: ' engineer ',
      destination: ' reviewer ',
      goal: ' goal ',
      constraints: [' constraint ', 'constraint'],
      openItems: [' open ', 'open'],
      evidenceReferences: [' evidence ', 'evidence'],
    };

    expect(createHandoff(input)).toEqual(input);
  });

  it('preserves the order of every array', () => {
    const input: HandoffInput = {
      ...MINIMAL,
      constraints: ['third', 'first', 'second'],
      openItems: ['later', 'now', 'soon'],
      evidenceReferences: ['evidence-c', 'evidence-a', 'evidence-b'],
    };

    expect(createHandoff(input)).toEqual(input);
  });

  it('is deterministic and safe to JSON round-trip', () => {
    const first = createHandoff(VALID);
    const second = createHandoff({
      evidenceReferences: [...VALID.evidenceReferences!],
      openItems: [...VALID.openItems!],
      constraints: [...VALID.constraints!],
      goal: VALID.goal,
      destination: VALID.destination,
      source: VALID.source,
      id: VALID.id,
      schemaVersion: VALID.schemaVersion,
    });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('accepts frozen inputs without aliasing returned arrays', () => {
    const input = deepFreeze({
      ...VALID,
      constraints: [...VALID.constraints!],
      openItems: [...VALID.openItems!],
      evidenceReferences: [...VALID.evidenceReferences!],
    });
    const expected: HandoffPacket = {
      ...VALID,
      constraints: [...VALID.constraints!],
      openItems: [...VALID.openItems!],
      evidenceReferences: [...VALID.evidenceReferences!],
    };

    const first = createHandoff(input);
    const second = createHandoff(input);
    expect(first).toEqual(expected);
    expect(first).not.toBe(second);
    expect(first.constraints).not.toBe(second.constraints);
    expect(first.openItems).not.toBe(second.openItems);
    expect(first.evidenceReferences).not.toBe(second.evidenceReferences);

    const mutableFirst = first as unknown as {
      constraints: string[];
      openItems: string[];
      evidenceReferences: string[];
    };
    mutableFirst.constraints.push('returned-only');
    mutableFirst.openItems[0] = 'changed-only';
    mutableFirst.evidenceReferences.pop();

    expect(createHandoff(input)).toEqual(expected);
  });

  it('keeps Retry Guard, verdict, and Progress outside the packet boundary', () => {
    const packet = createHandoff(VALID);
    expect(packet).not.toHaveProperty('retryAllowed');
    expect(packet).not.toHaveProperty('verdict');
    expect(packet).not.toHaveProperty('progress');
    expect(Object.keys(packet).sort()).toEqual([
      'constraints',
      'destination',
      'evidenceReferences',
      'goal',
      'id',
      'openItems',
      'schemaVersion',
      'source',
    ]);
  });

  it('accepts a typed HandoffInput with no runtime difference from unknown input', () => {
    const typedInput: HandoffInput = {
      ...VALID,
      constraints: [...VALID.constraints!],
      openItems: [...VALID.openItems!],
      evidenceReferences: [...VALID.evidenceReferences!],
    };
    const unknownInput: unknown = typedInput;

    const typedPacket = createHandoff(typedInput);
    const unknownPacket = createHandoff(unknownInput);
    expect(typedPacket).toEqual(unknownPacket);
    expect(JSON.stringify(typedPacket)).toBe(JSON.stringify(unknownPacket));
  });
});
