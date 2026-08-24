import { describe, expect, it } from 'vitest';
import {
  AgentStateError,
  createAgentState,
  restoreAgentState,
  summarizeAgentState,
} from '../src/index.js';
import type {
  AgentStateInput,
  AgentStateSnapshot,
  DecisionInput,
  WorkItemInput,
} from '../src/index.js';

function workItem(
  id: string,
  status?: WorkItemInput['status'],
): WorkItemInput {
  const item: WorkItemInput = {
    id,
    content: `content-${id}`,
  };
  if (status !== undefined) {
    item.status = status;
  }
  return item;
}

function decision(id: string): DecisionInput {
  return { id, content: `decision-${id}` };
}

function expectStateError(
  action: () => unknown,
  code: 'invalid_input' | 'duplicate_item_id' | 'unknown_item_id',
  itemId?: string,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AgentStateError);
  expect((thrown as AgentStateError).code).toBe(code);
  expect((thrown as AgentStateError).itemId).toBe(itemId);
}

describe('agent state registry', () => {
  it('creates an empty state and a pre-populated state', () => {
    expect(createAgentState().snapshot()).toEqual({
      schemaVersion: 1,
      workItems: [],
      decisions: [],
    });

    const input: AgentStateInput = {
      objective: 'Ship the change.',
      workItems: [workItem('first'), workItem('second', 'blocked')],
      decisions: [decision('choice')],
    };
    const state = createAgentState(input);

    expect(state.snapshot()).toEqual({
      schemaVersion: 1,
      objective: 'Ship the change.',
      workItems: [
        { id: 'first', content: 'content-first', status: 'open' },
        { id: 'second', content: 'content-second', status: 'blocked' },
      ],
      decisions: [{ id: 'choice', content: 'decision-choice' }],
    });
  });

  it('adds, reads, lists, removes, and orders work items', () => {
    const state = createAgentState();

    expect(state.addWorkItem(workItem('first'))).toEqual({
      id: 'first',
      content: 'content-first',
      status: 'open',
    });
    expect(state.addWorkItem(workItem('second', 'blocked'))).toEqual({
      id: 'second',
      content: 'content-second',
      status: 'blocked',
    });
    expect(state.getWorkItem('first')).toEqual({
      id: 'first',
      content: 'content-first',
      status: 'open',
    });
    expect(state.getWorkItem('missing')).toBeUndefined();
    expect(state.listWorkItems().map((item) => item.id)).toEqual([
      'first',
      'second',
    ]);

    expect(state.removeWorkItem('first')).toBe(true);
    expect(state.removeWorkItem('first')).toBe(false);
    expect(state.listWorkItems().map((item) => item.id)).toEqual(['second']);
  });

  it('sets every supported status without imposing transitions', () => {
    const state = createAgentState({ workItems: [workItem('task')] });
    const statuses = ['open', 'in_progress', 'blocked', 'done'] as const;

    for (const status of statuses) {
      expect(state.setWorkItemStatus('task', status).status).toBe(status);
    }
    expect(state.getWorkItem('task')?.status).toBe('done');
  });

  it('records decisions and keeps their ordering separate from work items', () => {
    const state = createAgentState({ workItems: [workItem('same')] });

    expect(state.addDecision(decision('same'))).toEqual({
      id: 'same',
      content: 'decision-same',
    });
    expect(state.addDecision(decision('other'))).toEqual({
      id: 'other',
      content: 'decision-other',
    });
    expect(state.listDecisions().map((entry) => entry.id)).toEqual([
      'same',
      'other',
    ]);
    expect(state.listWorkItems().map((entry) => entry.id)).toEqual(['same']);
  });

  it('rejects duplicate IDs in both collections and preserves existing state', () => {
    const state = createAgentState({
      workItems: [workItem('work')],
      decisions: [decision('decision')],
    });

    expectStateError(
      () => state.addWorkItem(workItem('work')),
      'duplicate_item_id',
      'work',
    );
    expectStateError(
      () => state.addDecision(decision('decision')),
      'duplicate_item_id',
      'decision',
    );
    expectStateError(
      () => state.setWorkItemStatus('missing', 'done'),
      'unknown_item_id',
      'missing',
    );

    expect(state.listWorkItems().map((item) => item.id)).toEqual(['work']);
    expect(state.listDecisions().map((entry) => entry.id)).toEqual(['decision']);
  });

  it('rejects duplicate IDs in initial arrays atomically', () => {
    expectStateError(
      () =>
        createAgentState({
          workItems: [workItem('first'), workItem('first')],
        }),
      'duplicate_item_id',
      'first',
    );
    expectStateError(
      () =>
        createAgentState({
          decisions: [decision('first'), decision('first')],
        }),
      'duplicate_item_id',
      'first',
    );
  });

  it('rejects invalid values and unsupported statuses', () => {
    const invalidItems: readonly unknown[] = [
      null,
      [],
      new Date(),
      () => undefined,
      { id: 42, content: 'content' },
      { id: '   ', content: 'content' },
      { id: 'id', content: 42 },
      { id: 'id', content: '   ' },
      { id: 'id', content: 'content', status: 'paused' },
    ];

    for (const invalidItem of invalidItems) {
      expectStateError(
        () => createAgentState().addWorkItem(invalidItem as WorkItemInput),
        'invalid_input',
      );
    }

    expectStateError(
      () => createAgentState().addDecision({ id: '', content: 'content' }),
      'invalid_input',
    );
    expectStateError(
      () => createAgentState({ objective: 42 } as unknown as AgentStateInput),
      'invalid_input',
    );
    expectStateError(
      () =>
        createAgentState({
          workItems: 'not-an-array',
        } as unknown as AgentStateInput),
      'invalid_input',
    );
    expectStateError(
      () =>
        createAgentState().setWorkItemStatus(
          'missing',
          'paused' as 'open',
        ),
      'invalid_input',
    );
    expectStateError(
      () => createAgentState().setWorkItemStatus('', 'open'),
      'invalid_input',
    );
  });

  it('does not expose mutable internal state in either direction', () => {
    const inputItem = workItem('input');
    const inputDecision = decision('input-decision');
    const input: AgentStateInput = {
      objective: 'Original objective',
      workItems: [inputItem],
      decisions: [inputDecision],
    };
    const state = createAgentState(input);

    input.objective = 'Changed objective';
    inputItem.id = 'changed-id';
    inputItem.content = 'Changed content';
    inputItem.status = 'done';
    inputDecision.id = 'changed-decision';
    inputDecision.content = 'Changed decision';
    input.workItems?.push(workItem('outside'));
    input.decisions?.push(decision('outside-decision'));

    expect(state.snapshot()).toEqual({
      schemaVersion: 1,
      objective: 'Original objective',
      workItems: [{ id: 'input', content: 'content-input', status: 'open' }],
      decisions: [{ id: 'input-decision', content: 'decision-input-decision' }],
    });

    const added = state.addWorkItem(workItem('added'));
    Object.assign(added, {
      id: 'changed',
      content: 'changed',
      status: 'done',
    });

    const read = state.getWorkItem('added');
    if (read !== undefined) {
      Object.assign(read, { content: 'changed' });
    }
    const listed = state.listWorkItems();
    const listedItem = listed[0];
    if (listedItem !== undefined) {
      Object.assign(listedItem, { content: 'changed' });
    }
    (listed as WorkItemInput[]).push(workItem('outside-list'));

    const decisions = state.listDecisions();
    const listedDecision = decisions[0];
    if (listedDecision !== undefined) {
      Object.assign(listedDecision, { content: 'changed' });
    }
    (decisions as DecisionInput[]).push(decision('outside-decisions'));

    const snapshot = state.snapshot();
    Object.assign(snapshot, { objective: 'changed' });
    const snapshotWorkItem = snapshot.workItems[0];
    if (snapshotWorkItem !== undefined) {
      Object.assign(snapshotWorkItem, { content: 'changed' });
    }
    const snapshotDecision = snapshot.decisions[0];
    if (snapshotDecision !== undefined) {
      Object.assign(snapshotDecision, { content: 'changed' });
    }
    (snapshot.workItems as WorkItemInput[]).push(workItem('outside-snapshot'));
    (snapshot.decisions as DecisionInput[]).push(decision('outside-snapshot'));

    expect(state.getWorkItem('input')).toEqual({
      id: 'input',
      content: 'content-input',
      status: 'open',
    });
    expect(state.getWorkItem('added')).toEqual({
      id: 'added',
      content: 'content-added',
      status: 'open',
    });
    expect(state.listDecisions()).toEqual([
      { id: 'input-decision', content: 'decision-input-decision' },
    ]);
    expect(state.snapshot().workItems.map((item) => item.id)).toEqual([
      'input',
      'added',
    ]);
  });

  it('produces deterministic JSON-compatible snapshots', () => {
    const state = createAgentState({
      objective: 'Objective',
      workItems: [workItem('one'), workItem('two', 'done')],
      decisions: [decision('choice')],
    });
    const first = state.snapshot();
    const second = state.snapshot();

    expect(first.schemaVersion).toBe(1);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(Object.keys(first)).toEqual([
      'schemaVersion',
      'workItems',
      'decisions',
      'objective',
    ]);
  });
});

describe('agent state restore and summary', () => {
  function validSnapshot(): AgentStateSnapshot {
    return {
      schemaVersion: 1,
      objective: 'Restore this state.',
      workItems: [
        { id: 'open', content: 'Open item.', status: 'open' },
        { id: 'progress', content: 'Progress item.', status: 'in_progress' },
        { id: 'blocked', content: 'Blocked item.', status: 'blocked' },
        { id: 'done', content: 'Done item.', status: 'done' },
      ],
      decisions: [{ id: 'choice', content: 'Keep the safe path.' }],
    };
  }

  it('restores valid snapshots and preserves their insertion order', () => {
    const snapshot = validSnapshot();
    const restored = restoreAgentState(snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.listWorkItems().map((item) => item.id)).toEqual([
      'open',
      'progress',
      'blocked',
      'done',
    ]);
    expect(restored.listDecisions().map((entry) => entry.id)).toEqual(['choice']);
  });

  it('restores a JSON round-trip unchanged', () => {
    const snapshot = validSnapshot();
    const restored = restoreAgentState(
      JSON.parse(JSON.stringify(snapshot)) as unknown,
    );

    expect(restored.snapshot()).toEqual(snapshot);
  });

  it('rejects malformed snapshots and unsupported schema versions', () => {
    const invalidSnapshots: readonly unknown[] = [
      null,
      [],
      new Date(),
      {},
      { schemaVersion: 1, workItems: [], decisions: 'nope' },
      { schemaVersion: 1, workItems: 'nope', decisions: [] },
      {
        schemaVersion: 1,
        workItems: [{ id: 'item', content: 'content' }],
        decisions: [],
      },
      {
        schemaVersion: 1,
        objective: 42,
        workItems: [],
        decisions: [],
      },
      {
        schemaVersion: 1,
        workItems: [{ id: 'item', content: 'content', status: 'paused' }],
        decisions: [],
      },
    ];

    for (const snapshot of invalidSnapshots) {
      expectStateError(
        () => restoreAgentState(snapshot),
        'invalid_input',
      );
    }
    expectStateError(
      () =>
        restoreAgentState({
          ...validSnapshot(),
          schemaVersion: 2,
        }),
      'invalid_input',
    );
  });

  it('rejects duplicate IDs within either restored collection', () => {
    const snapshot = validSnapshot();
    expectStateError(
      () =>
        restoreAgentState({
          ...snapshot,
          workItems: [
            ...snapshot.workItems,
            { id: 'open', content: 'Duplicate.', status: 'open' },
          ],
        }),
      'duplicate_item_id',
      'open',
    );
    expectStateError(
      () =>
        restoreAgentState({
          ...snapshot,
          decisions: [
            ...snapshot.decisions,
            { id: 'choice', content: 'Duplicate.' },
          ],
        }),
      'duplicate_item_id',
      'choice',
    );
  });

  it('counts every status and total without deriving a ratio', () => {
    const summary = summarizeAgentState(validSnapshot());

    expect(summary).toEqual({
      open: 1,
      in_progress: 1,
      blocked: 1,
      done: 1,
      total: 4,
    });
  });
});
