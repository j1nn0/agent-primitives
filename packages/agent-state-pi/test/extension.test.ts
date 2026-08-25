import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { COMMAND_NAME } from '../src/command.js';
import { STATE_CUSTOM_TYPE } from '../src/state.js';
import { TOOL_NAMES } from '../src/tools.js';
import { FakePiHarness } from './harness.js';

function text(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (content === undefined || content.type !== 'text') {
    throw new Error('expected a text tool result');
  }
  return content.text;
}

function lastAppended(harness: FakePiHarness): {
  readonly customType: string;
  readonly data: unknown;
} {
  const entry = harness.appendedEntries.at(-1);
  if (entry === undefined) {
    throw new Error('expected an appended entry');
  }
  return entry;
}

function validPayload(): unknown {
  return {
    schemaVersion: 1,
    state: {
      schemaVersion: 1,
      objective: 'Resume this work.',
      workItems: [
        { id: 'first', content: 'First item.', status: 'open' },
        { id: 'second', content: 'Second item.', status: 'done' },
      ],
      decisions: [{ id: 'choice', content: 'Keep the safe path.' }],
    },
  };
}

describe('Agent State Pi commands', () => {
  it('shows an empty status and bare-command usage', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('status');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );

    await harness.command('');
    expect(harness.notifications.at(-1)?.message).toMatch(
      /^Usage: \/agent-state /,
    );
    expect(harness.notifications.at(-1)?.type).toBe('warning');
  });

  it('records an objective, work items, statuses, and decisions in insertion order', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('objective Ship the release.');
    await harness.command('add first Prepare the release.');
    await harness.command('add second Run the checks.');
    await harness.command('set first in_progress');
    await harness.command('decide tests Keep the focused tests.');
    await harness.command('status');

    const message = harness.notifications.at(-1)?.message ?? '';
    expect(message).toContain('objective: Ship the release.');
    expect(message).toContain('2 work items (1 open, 1 in_progress, 0 blocked, 0 done)');
    expect(message).toContain('1 decision');
    expect(message.indexOf('- first [in_progress]: Prepare the release.')).toBeLessThan(
      message.indexOf('- second [open]: Run the checks.'),
    );
    expect(message).toContain('- tests: Keep the focused tests.');
    expect(harness.appendedEntries).toHaveLength(5);
  });

  it('reports duplicate ids and unknown ids without mutating or appending', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('add task Original.');
    await harness.command('add task Replacement.');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: duplicate work item id "task".',
    );
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('set missing done');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: unknown work item id "missing".',
    );
    expect(harness.appendedEntries).toHaveLength(1);
  });

  it('rejects invalid statuses, removes items, and preserves the remaining state', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('add task Original.');
    await harness.command('set task paused');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: invalid status "paused"; expected open, in_progress, blocked, done.',
    );
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('remove task');
    await harness.command('remove task');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: unknown work item id "task".',
    );
    expect(harness.appendedEntries).toHaveLength(2);

    await harness.command('status');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );
  });

  it('requires explicit confirmation before clearing and clears with --yes', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('objective Keep this objective.');
    await harness.command('add task Do the work.');
    await harness.command('decide choice Keep the safe choice.');
    const appendCount = harness.appendedEntries.length;

    await harness.command('clear');
    expect(harness.notifications.at(-1)?.message).toContain(
      'clear would remove the objective, 1 work item and 1 decision',
    );
    expect(harness.appendedEntries).toHaveLength(appendCount);

    await harness.command('status');
    expect(harness.notifications.at(-1)?.message).toContain('1 work item');

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(appendCount + 1);
    await harness.command('status');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );
  });
});

describe('Agent State Pi tools', () => {
  it('registers exactly the four explicit tools', () => {
    const harness = new FakePiHarness();

    expect([...harness.tools.keys()]).toEqual(TOOL_NAMES);
    expect(harness.tools.size).toBe(4);
    expect([...harness.handlers.keys()]).toEqual(['session_start']);
  });

  it('adds, updates, reads, and records decisions through tools', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    expect(
      text(
        await harness.executeTool('agent_state_add_work_item', {
          id: 'task',
          content: 'Run the checks.',
          status: 'open',
        }),
      ),
    ).toContain('added work item "task"');
    expect(
      text(
        await harness.executeTool('agent_state_set_work_item_status', {
          id: 'task',
          status: 'blocked',
        }),
      ),
    ).toContain('now blocked');
    expect(
      text(
        await harness.executeTool('agent_state_add_decision', {
          id: 'choice',
          content: 'Keep the safe path.',
        }),
      ),
    ).toContain('added decision "choice"');

    const state = text(await harness.executeTool('agent_state_get'));
    expect(state).toContain('1 work item (0 open, 0 in_progress, 1 blocked, 0 done)');
    expect(state).toContain('- task [blocked]: Run the checks.');
    expect(state).toContain('- choice: Keep the safe path.');
    expect(harness.appendedEntries).toHaveLength(3);
  });

  it('returns safe messages for invalid tool input and does not infer state', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    const invalidAdd = await harness.executeTool(
      'agent_state_add_work_item',
      { id: '', content: '' },
    );
    expect(text(invalidAdd)).toBe('Agent State: invalid agent state input.');
    expect(harness.appendedEntries).toHaveLength(0);

    const unknownSet = await harness.executeTool(
      'agent_state_set_work_item_status',
      { id: 'missing', status: 'done' },
    );
    expect(text(unknownSet)).toBe(
      'Agent State: unknown work item id "missing".',
    );
    expect(harness.appendedEntries).toHaveLength(0);

    const descriptions = [...harness.tools.values()].map(
      (tool) => tool.description,
    );
    expect(descriptions.every((description) => description.includes('caller'))).toBe(
      true,
    );
    expect(descriptions.every((description) => !description.includes('automatically'))).toBe(
      true,
    );
  });
});

describe('Agent State Pi persistence', () => {
  it('appends only after an explicit mutation and restores on resume', async () => {
    const first = new FakePiHarness();
    await first.start('startup');
    await first.command('objective Resume this work.');
    await first.command('add task Continue the task.');

    expect(first.appendedEntries).toHaveLength(2);
    const latest = lastAppended(first);
    expect(latest.customType).toBe(STATE_CUSTOM_TYPE);
    expect(latest.data).toEqual({
      schemaVersion: 1,
      state: {
        schemaVersion: 1,
        objective: 'Resume this work.',
        workItems: [
          { id: 'task', content: 'Continue the task.', status: 'open' },
        ],
        decisions: [],
      },
    });

    const resumed = new FakePiHarness(first.getBranch());
    await resumed.start('resume');
    expect(resumed.appendedEntries).toHaveLength(0);
    const state = text(await resumed.executeTool('agent_state_get'));
    expect(state).toContain('objective: Resume this work.');
    expect(state).toContain('- task [open]: Continue the task.');
  });

  it('starts a fresh session empty and loading alone does not append', async () => {
    const resumed = new FakePiHarness([
      { type: 'custom', customType: STATE_CUSTOM_TYPE, data: validPayload() },
    ]);
    await resumed.start('resume');
    expect(resumed.appendedEntries).toHaveLength(0);
    expect(text(await resumed.executeTool('agent_state_get'))).toContain(
      '2 work items',
    );

    const fresh = new FakePiHarness();
    await fresh.start('startup');
    expect(text(await fresh.executeTool('agent_state_get'))).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );
    expect(fresh.appendedEntries).toHaveLength(0);
  });

  it('warns and starts empty for malformed or unsupported persisted data', async () => {
    const malformed = new FakePiHarness([
      { type: 'custom', customType: STATE_CUSTOM_TYPE, data: { schemaVersion: 1 } },
    ]);
    await malformed.start('resume');
    expect(malformed.notifications.at(-1)).toEqual({
      message: 'Agent State: persisted state was invalid; starting with empty state.',
      type: 'warning',
    });
    expect(text(await malformed.executeTool('agent_state_get'))).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );
    expect(malformed.appendedEntries).toHaveLength(0);

    const unsupported = new FakePiHarness([
      {
        type: 'custom',
        customType: STATE_CUSTOM_TYPE,
        data: { schemaVersion: 2, state: validPayload() },
      },
    ]);
    await unsupported.start('resume');
    expect(unsupported.notifications.at(-1)?.type).toBe('warning');
    expect(text(await unsupported.executeTool('agent_state_get'))).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );
  });

  it('uses the newest matching entry and does not fall back after corruption', async () => {
    const harness = new FakePiHarness([
      { type: 'custom', customType: STATE_CUSTOM_TYPE, data: validPayload() },
      {
        type: 'custom',
        customType: STATE_CUSTOM_TYPE,
        data: { schemaVersion: 1, state: { schemaVersion: 1 } },
      },
    ]);
    await harness.start('resume');

    expect(harness.notifications.at(-1)?.type).toBe('warning');
    expect(text(await harness.executeTool('agent_state_get'))).toBe(
      'Agent State: no objective, 0 work items, 0 decisions.',
    );
  });
});

describe('Agent State Pi safety and coexistence', () => {
  it('does not expose mutable persisted snapshots back into live state', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add task Original content.');

    const payload = lastAppended(harness).data as {
      state: { workItems: Array<{ content: string }> };
    };
    payload.state.workItems[0]!.content = 'Changed outside the adapter.';

    expect(text(await harness.executeTool('agent_state_get'))).toContain(
      '- task [open]: Original content.',
    );
  });

  it('uses names distinct from Context Guard', () => {
    expect(COMMAND_NAME).toBe('agent-state');
    expect(COMMAND_NAME).not.toBe('context-guard');
    expect(STATE_CUSTOM_TYPE).toBe('agent-state-state');
    expect(STATE_CUSTOM_TYPE).not.toBe('agent-context-guard-state');
    expect(TOOL_NAMES.every((name) => !name.startsWith('context_guard'))).toBe(
      true,
    );
  });
});
