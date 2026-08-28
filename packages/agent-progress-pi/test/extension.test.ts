import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { COMMAND_NAME } from '../src/command.js';
import {
  ADAPTER_SCHEMA_VERSION,
  STATE_CUSTOM_TYPE,
} from '../src/state.js';
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
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    hasBaseline: true,
    currentMilestones: ['current'],
    recordedMilestones: ['recorded'],
  };
}

function customEntry(data: unknown): unknown {
  return { type: 'custom', customType: STATE_CUSTOM_TYPE, data };
}

describe('Agent Progress Pi commands', () => {
  it('registers the namespace, shows status, and rejects extra arguments', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    expect([...harness.commands.keys()]).toEqual([COMMAND_NAME]);
    await harness.command('status');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent Progress: 0 declared milestones; baseline not established (0 recorded milestones).\nDeclared milestones: none.',
    );

    await harness.command('status extra');
    expect(harness.notifications.at(-1)).toEqual({
      message:
        'Agent Progress: Usage: /agent-progress status | add <milestone> | withdraw <milestone> | judge | clear --yes',
      type: 'warning',
    });

    await harness.command('add first second');
    expect(harness.notifications.at(-1)?.type).toBe('warning');
    await harness.command('withdraw first second');
    expect(harness.notifications.at(-1)?.type).toBe('warning');
    await harness.command('judge extra');
    expect(harness.notifications.at(-1)?.type).toBe('warning');
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it('adds and withdraws single-token milestones without judgment', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('add first');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent Progress: added milestone "first".',
    );
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: false,
      currentMilestones: ['first'],
      recordedMilestones: [],
    });

    await harness.command('add first');
    expect(harness.notifications.at(-1)).toEqual({
      message: 'Agent Progress: milestone "first" is already declared.',
      type: 'warning',
    });
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('withdraw unknown');
    expect(harness.notifications.at(-1)).toEqual({
      message: 'Agent Progress: unknown declared milestone "unknown".',
      type: 'warning',
    });
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('withdraw first');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent Progress: withdrew milestone "first".',
    );
    expect(harness.appendedEntries).toHaveLength(2);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: false,
      currentMilestones: [],
      recordedMilestones: [],
    });

    expect(
      harness.notifications.some(({ message }) =>
        /unknown \(|no_progress\.|progress\./.test(message),
      ),
    ).toBe(false);
  });

  it('requires explicit confirmation before clearing', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add first');
    const appendCount = harness.appendedEntries.length;

    await harness.command('clear');
    expect(harness.notifications.at(-1)?.message).toContain(
      'clear would remove 1 declared milestone and 0 recorded milestones',
    );
    expect(harness.notifications.at(-1)?.type).toBe('warning');
    expect(harness.appendedEntries).toHaveLength(appendCount);

    await harness.command('clear --yes');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent Progress: cleared.',
    );
    expect(harness.appendedEntries).toHaveLength(appendCount + 1);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: false,
      currentMilestones: [],
      recordedMilestones: [],
    });

    await harness.command('clear --yes');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent Progress: state is already empty.',
    );
    expect(harness.appendedEntries).toHaveLength(appendCount + 1);
  });
});

describe('Agent Progress Pi tools', () => {
  it('registers exactly the four tools with strict schemas and labels', () => {
    const harness = new FakePiHarness();

    expect([...harness.tools.keys()]).toEqual(TOOL_NAMES);
    expect(harness.tools.size).toBe(4);
    expect([...harness.handlers.keys()]).toEqual(['session_start']);
    expect([...harness.tools.values()].map((tool) => tool.label)).toEqual([
      'Agent Progress: get',
      'Agent Progress: add milestone',
      'Agent Progress: withdraw milestone',
      'Agent Progress: judge',
    ]);

    const getTool = harness.tools.get('agent_progress_get');
    const addTool = harness.tools.get('agent_progress_add_milestone');
    const withdrawTool = harness.tools.get('agent_progress_withdraw_milestone');
    const judgeTool = harness.tools.get('agent_progress_judge');
    expect(getTool?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(judgeTool?.parameters).toEqual(getTool?.parameters);
    expect(addTool?.parameters).toEqual({
      type: 'object',
      properties: {
        milestone: {
          type: 'string',
          description: 'Caller-supplied opaque milestone identifier.',
        },
      },
      required: ['milestone'],
      additionalProperties: false,
    });
    expect(withdrawTool?.parameters).toEqual(addTool?.parameters);

    const descriptions = [...harness.tools.values()].map(
      (tool) => tool.description,
    );
    expect(descriptions.every((description) => description.includes('caller'))).toBe(
      true,
    );
    expect(
      descriptions.every((description) =>
        /infer, verify, or assert/.test(description),
      ),
    ).toBe(true);
    expect(judgeTool?.description).toContain(
      'complete currently declared milestone set',
    );
    expect(judgeTool?.description).toContain('cumulative baseline');
    expect(judgeTool?.description).toContain('strictly grew');
    expect(judgeTool?.description).toContain(
      'does not inspect milestone meaning',
    );
    expect(judgeTool?.description).toContain(
      'verify that a milestone was worth reaching',
    );
  });

  it('keeps tool mutations separate from judgment and returns core verdicts', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    expect(text(await harness.executeTool('agent_progress_get'))).toContain(
      'baseline not established',
    );
    expect(
      text(
        await harness.executeTool('agent_progress_add_milestone', {
          milestone: 'first',
        }),
      ),
    ).toBe('Agent Progress: added milestone "first".');
    expect(harness.appendedEntries).toHaveLength(1);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: false,
      currentMilestones: ['first'],
      recordedMilestones: [],
    });

    expect(
      text(
        await harness.executeTool('agent_progress_add_milestone', {
          milestone: 'first',
        }),
      ),
    ).toBe('Agent Progress: milestone "first" is already declared.');
    expect(harness.appendedEntries).toHaveLength(1);

    expect(
      text(
        await harness.executeTool('agent_progress_withdraw_milestone', {
          milestone: 'missing',
        }),
      ),
    ).toBe('Agent Progress: unknown declared milestone "missing".');
    expect(harness.appendedEntries).toHaveLength(1);

    const firstJudge = text(
      await harness.executeTool('agent_progress_judge'),
    );
    expect(firstJudge).toContain('Agent Progress: unknown (missing_baseline).');
    expect(firstJudge).toContain(
      'Call agent_progress_judge again after the milestone set changes: this first judgment established the baseline.',
    );
    expect(harness.appendedEntries).toHaveLength(2);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: true,
      currentMilestones: ['first'],
      recordedMilestones: ['first'],
    });

    const repeatedJudge = text(
      await harness.executeTool('agent_progress_judge'),
    );
    expect(repeatedJudge).toContain('Agent Progress: no_progress.');
    expect(repeatedJudge).not.toContain('Call agent_progress_judge again after the milestone set changes');
    expect(harness.appendedEntries).toHaveLength(2);
  });
});

describe('Agent Progress Pi judging', () => {
  it('establishes a missing baseline, then reports progress and no progress', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add planned');

    await harness.command('judge');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Agent Progress: unknown (missing_baseline).',
    );
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: true,
      currentMilestones: ['planned'],
      recordedMilestones: ['planned'],
    });

    await harness.command('add implemented');
    await harness.command('judge');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Agent Progress: progress.',
    );
    expect(harness.notifications.at(-1)?.message).toContain('- implemented');
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: true,
      currentMilestones: ['planned', 'implemented'],
      recordedMilestones: ['planned', 'implemented'],
    });

    const appendCount = harness.appendedEntries.length;
    await harness.command('judge');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Agent Progress: no_progress.',
    );
    expect(harness.appendedEntries).toHaveLength(appendCount);
  });

  it('reports progress with a withdrawal when one new milestone replaces another', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add old');
    await harness.command('judge');
    await harness.command('withdraw old');
    await harness.command('add new');

    await harness.command('judge');
    const message = harness.notifications.at(-1)?.message ?? '';
    expect(message).toContain('Agent Progress: progress.');
    expect(message).toContain('New milestones:');
    expect(message).toContain('- new');
    expect(message).toContain('Withdrawn milestones:');
    expect(message).toContain('- old');
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: true,
      currentMilestones: ['new'],
      recordedMilestones: ['old', 'new'],
    });
  });

  it('does not count withdrawal followed by re-declaration as progress', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add milestone');
    await harness.command('judge');
    await harness.command('withdraw milestone');

    const beforeWithdrawJudge = harness.appendedEntries.length;
    await harness.command('judge');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Agent Progress: no_progress.',
    );
    expect(harness.appendedEntries).toHaveLength(beforeWithdrawJudge);

    await harness.command('add milestone');
    const beforeRedeclareJudge = harness.appendedEntries.length;
    await harness.command('judge');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Agent Progress: no_progress.',
    );
    expect(harness.appendedEntries).toHaveLength(beforeRedeclareJudge);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: 1,
      hasBaseline: true,
      currentMilestones: ['milestone'],
      recordedMilestones: ['milestone'],
    });
  });

  it('treats an established empty baseline as a real no-progress verdict', async () => {
    const harness = new FakePiHarness([
      customEntry({
        schemaVersion: 1,
        hasBaseline: true,
        currentMilestones: [],
        recordedMilestones: [],
      }),
    ]);
    await harness.start('resume');

    await harness.command('judge');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Agent Progress: no_progress.',
    );
    expect(harness.notifications.at(-1)?.message).not.toContain('unknown');
    expect(harness.appendedEntries).toHaveLength(0);
  });
});

describe('Agent Progress Pi persistence and resume', () => {
  it('restores the newest valid state without appending while loading', async () => {
    const first = new FakePiHarness();
    await first.start('startup');
    await first.command('add first');
    await first.command('judge');
    await first.command('add second');

    const resumed = new FakePiHarness(first.getBranch());
    await resumed.start('resume');
    expect(resumed.appendedEntries).toHaveLength(0);

    await resumed.command('status');
    const status = resumed.notifications.at(-1)?.message ?? '';
    expect(status).toContain('2 declared milestones');
    expect(status).toContain('baseline established (1 recorded milestone)');
    expect(status).toContain('- first');
    expect(status).toContain('- second');

    const fresh = new FakePiHarness();
    await fresh.start('startup');
    await fresh.command('status');
    expect(fresh.notifications.at(-1)?.message).toContain(
      'baseline not established',
    );
    expect(fresh.notifications.at(-1)?.message).toContain(
      'Declared milestones: none.',
    );
    expect(fresh.appendedEntries).toHaveLength(0);
  });

  it('warns and starts fresh for every malformed newest matching entry', async () => {
    const malformedPayloads: readonly unknown[] = [
      null,
      {},
      { schemaVersion: 2, hasBaseline: false, currentMilestones: [], recordedMilestones: [] },
      { schemaVersion: 1, currentMilestones: [], recordedMilestones: [] },
      { schemaVersion: 1, hasBaseline: 'false', currentMilestones: [], recordedMilestones: [] },
      { schemaVersion: 1, hasBaseline: false, currentMilestones: 'not-array', recordedMilestones: [] },
      { schemaVersion: 1, hasBaseline: false, currentMilestones: [], recordedMilestones: ['recorded'] },
      { schemaVersion: 1, hasBaseline: false, currentMilestones: ['duplicate', 'duplicate'], recordedMilestones: [] },
      { schemaVersion: 1, hasBaseline: true, currentMilestones: [''], recordedMilestones: [] },
      { schemaVersion: 1, hasBaseline: true, currentMilestones: [], recordedMilestones: ['duplicate', 'duplicate'] },
    ];

    for (const payload of malformedPayloads) {
      const harness = new FakePiHarness([customEntry(payload)]);
      await harness.start('resume');
      expect(harness.notifications.at(-1)).toEqual({
        message:
          'Agent Progress: persisted state was invalid; starting with fresh state.',
        type: 'warning',
      });
      expect(harness.appendedEntries).toHaveLength(0);
      await harness.command('status');
      expect(harness.notifications.at(-1)?.message).toContain(
        'baseline not established',
      );
    }

    const newestInvalid = new FakePiHarness([
      customEntry(validPayload()),
      customEntry({ schemaVersion: 1 }),
    ]);
    await newestInvalid.start('resume');
    expect(newestInvalid.notifications.at(-1)?.type).toBe('warning');
    await newestInvalid.command('status');
    expect(newestInvalid.notifications.at(-1)?.message).toContain(
      'Declared milestones: none.',
    );
    expect(newestInvalid.appendedEntries).toHaveLength(0);
  });
});

describe('Agent Progress Pi coexistence and boundaries', () => {
  it('uses names distinct from the other adapters and exposes no replacement', () => {
    expect(COMMAND_NAME).toBe('agent-progress');
    expect(COMMAND_NAME).not.toBe('agent-state');
    expect(STATE_CUSTOM_TYPE).toBe('agent-progress-state');
    expect(STATE_CUSTOM_TYPE).not.toBe('agent-state-state');
    expect(TOOL_NAMES.every((name) => !name.startsWith('agent_state'))).toBe(
      true,
    );
  });
});
