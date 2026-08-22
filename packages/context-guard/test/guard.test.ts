import { describe, expect, it } from 'vitest';
import {
  ContextGuardError,
  createContextGuard,
} from '../src/index.js';
import type { ContextItem, ContextItemInput } from '../src/index.js';

function item(id: string, critical?: boolean): ContextItemInput {
  const value: ContextItemInput = {
    id,
    kind: 'fact',
    content: `content-${id}`,
  };
  if (critical !== undefined) {
    value.critical = critical;
  }
  return value;
}

function expectGuardError(
  action: () => unknown,
  code: 'duplicate_item_id' | 'invalid_input',
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ContextGuardError);
  expect((thrown as ContextGuardError).code).toBe(code);
}

describe('context guard registry', () => {
  it('adds items and supports lookup, ordering, membership, removal, clearing, and size', () => {
    const guard = createContextGuard();

    expect(guard.size()).toBe(0);
    expect(guard.add(item('first'))).toEqual({
      id: 'first',
      kind: 'fact',
      content: 'content-first',
      critical: false,
    });
    expect(guard.addAll([item('second'), item('third', true)])).toEqual([
      {
        id: 'second',
        kind: 'fact',
        content: 'content-second',
        critical: false,
      },
      {
        id: 'third',
        kind: 'fact',
        content: 'content-third',
        critical: true,
      },
    ]);

    expect(guard.get('first')).toEqual({
      id: 'first',
      kind: 'fact',
      content: 'content-first',
      critical: false,
    });
    expect(guard.get('missing')).toBeUndefined();
    expect(guard.list().map((entry) => entry.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(guard.has('second')).toBe(true);
    expect(guard.has('missing')).toBe(false);
    expect(guard.size()).toBe(3);

    expect(guard.remove('second')).toBe(true);
    expect(guard.remove('second')).toBe(false);
    expect(guard.list().map((entry) => entry.id)).toEqual(['first', 'third']);

    guard.clear();
    expect(guard.size()).toBe(0);
    expect(guard.list()).toEqual([]);
  });

  it('rejects duplicate ids and keeps addAll atomic', () => {
    const guard = createContextGuard([item('existing')]);

    expectGuardError(() => guard.add(item('existing')), 'duplicate_item_id');
    expectGuardError(
      () => guard.addAll([item('new'), item('new')]),
      'duplicate_item_id',
    );
    expectGuardError(
      () => guard.addAll([item('existing'), item('another')]),
      'duplicate_item_id',
    );
    expectGuardError(
      () => guard.addAll([item('valid'), null as unknown as ContextItemInput]),
      'invalid_input',
    );

    expect(guard.list().map((entry) => entry.id)).toEqual(['existing']);
  });

  it('does not expose mutable internal items or arrays', () => {
    const guard = createContextGuard([item('stable')]);
    const added = guard.add(item('added'));
    Object.assign(added, { id: 'changed', content: 'changed' });

    const listed = guard.list();
    const listedItem = listed[0];
    if (listedItem !== undefined) {
      Object.assign(listedItem, { content: 'changed' });
    }
    (listed as unknown as ContextItem[]).push(item('outside') as ContextItem);

    const snapshot = guard.snapshot();
    const snapshotItem = snapshot.items[0];
    if (snapshotItem !== undefined) {
      Object.assign(snapshotItem, { content: 'changed' });
    }
    (snapshot.items as unknown as ContextItem[]).push(
      item('outside-snapshot') as ContextItem,
    );

    expect(guard.get('added')?.content).toBe('content-added');
    expect(guard.get('stable')?.content).toBe('content-stable');
    expect(guard.has('outside')).toBe(false);
    expect(guard.has('outside-snapshot')).toBe(false);
    expect(snapshot.items[0]).not.toBe(guard.list()[0]);
  });

  it('produces deterministic, JSON-compatible snapshots with stable critical fields', () => {
    const guard = createContextGuard([item('ordinary'), item('critical', true)]);
    const first = guard.snapshot();
    const second = guard.snapshot();

    expect(first.schemaVersion).toBe(1);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.items.map((entry) => entry.critical)).toEqual([false, true]);
    expect(Object.keys(first.items[0] ?? {})).toEqual([
      'id',
      'kind',
      'content',
      'critical',
    ]);
  });

  it('rejects every invalid item shape with an invalid_input ContextGuardError', () => {
    const invalidItems: readonly unknown[] = [
      null,
      [],
      new Date(),
      () => undefined,
      { id: 42, kind: 'fact', content: 'content' },
      { id: '   ', kind: 'fact', content: 'content' },
      { id: 'id', kind: 'unsupported', content: 'content' },
      { id: 'id', kind: 'fact', content: 42 },
      { id: 'id', kind: 'fact', content: '   ' },
      { id: 'id', kind: 'fact', content: 'content', critical: 'yes' },
      { id: 'id', kind: 'fact', content: 'content', critical: undefined },
    ];

    for (const invalidItem of invalidItems) {
      expectGuardError(
        () => createContextGuard().add(invalidItem as ContextItemInput),
        'invalid_input',
      );
    }

    expectGuardError(
      () =>
        createContextGuard().addAll(
          null as unknown as readonly ContextItemInput[],
        ),
      'invalid_input',
    );
  });
});
