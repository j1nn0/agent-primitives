import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { COMMAND_NAME } from '../src/command.js';
import {
  ADAPTER_SCHEMA_VERSION,
  STATE_CUSTOM_TYPE,
} from '../src/state.js';
import { TOOL_NAMES } from '../src/tools.js';
import { FakePiHarness, type AppendedEntry } from './harness.js';

function text(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (content === undefined || content.type !== 'text') {
    throw new Error('expected a text tool result');
  }
  return content.text;
}

function lastAppended(harness: FakePiHarness): AppendedEntry {
  const entry = harness.appendedEntries.at(-1);
  if (entry === undefined) {
    throw new Error('expected an appended entry');
  }
  return entry;
}

function customEntry(data: unknown, customType: string = STATE_CUSTOM_TYPE): unknown {
  return { type: 'custom', customType, data };
}

function payload(budgets: readonly unknown[] = []): unknown {
  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    budgets,
  };
}

function record(
  id: string,
  consumed = 1,
  limit = 5,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id,
    consumed,
    limit,
    ...overrides,
  };
}

function summaryLines(summary: string): string[] {
  return summary.split('\n').slice(1);
}

describe('Agent Budget Pi registration', () => {
  it('registers one command, four tools, and one lifecycle handler', () => {
    const harness = new FakePiHarness();

    expect([...harness.commands.keys()]).toEqual([COMMAND_NAME]);
    expect([...harness.tools.keys()]).toEqual([...TOOL_NAMES]);
    expect(harness.tools.size).toBe(4);
    expect([...harness.handlers.keys()]).toEqual(['session_start']);
    expect(harness.tools.get('agent_budget_get')?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(harness.tools.get('agent_budget_set')?.parameters).toEqual({
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Opaque caller-supplied id preserved exactly.',
        },
        consumed: {
          type: 'number',
          description:
            'Caller-declared finite non-negative number; fractional values are allowed; unit-free.',
        },
        limit: {
          type: 'number',
          description:
            'Caller-declared finite non-negative number; fractional values are allowed; unit-free.',
        },
      },
      required: ['id', 'consumed', 'limit'],
      additionalProperties: false,
    });

    const descriptions = [...harness.tools.values()].map((tool) => tool.description);
    expect(descriptions.every((description) => description.includes('does not count tool calls'))).toBe(
      true,
    );
    expect(descriptions.every((description) => description.includes('consumption is caller-declared'))).toBe(
      true,
    );
  });
});

describe('Agent Budget Pi lifecycle', () => {
  it('starts with an empty state and reports a zero-budget summary', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    expect(text(await harness.executeTool('agent_budget_get', {}))).toBe(
      'Agent Budget: 0 budgets in the current session.',
    );
    await harness.command('');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Agent Budget: 0 budgets in the current session.',
    );
  });

  it('starts fresh and warns once when the newest persisted entry is malformed', async () => {
    const harness = new FakePiHarness([customEntry({ schemaVersion: 2, budgets: [] })]);
    await harness.start();

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]).toEqual({
      message: 'Agent Budget: persisted state was invalid; starting with fresh state.',
      type: 'warning',
    });
    expect(text(await harness.executeTool('agent_budget_get', {}))).toContain('0 budgets');
  });

  it('rejects duplicate ids in a persisted snapshot as one invalid state', async () => {
    const harness = new FakePiHarness([
      customEntry(payload([record('duplicate'), record('duplicate', 2)])),
    ]);
    await harness.start();

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.message).toContain('persisted state was invalid');
    expect(text(await harness.executeTool('agent_budget_get', {}))).toContain('0 budgets');
  });

  it('does not fall back to an older valid entry when the newest entry is invalid', async () => {
    const branch = [
      customEntry(payload([record('older-valid')])),
      customEntry({ schemaVersion: 2, budgets: [] }),
    ];
    const harness = new FakePiHarness(branch);
    await harness.start();

    expect(harness.notifications).toHaveLength(1);
    expect(text(await harness.executeTool('agent_budget_get', {}))).not.toContain('older-valid');
    expect(text(await harness.executeTool('agent_budget_get', {}))).toContain('0 budgets');
  });

  it('round-trips mutations through the current branch in insertion order', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.executeTool('agent_budget_set', { id: 'first', consumed: 1, limit: 5 });
    await harness.executeTool('agent_budget_set', { id: 'second', consumed: 2, limit: 6 });
    await harness.command('set third --consumed=3 --limit=7');

    const resumed = new FakePiHarness(harness.getBranch());
    await resumed.start();
    const summary = text(await resumed.executeTool('agent_budget_get', {}));
    expect(summaryLines(summary)).toEqual([
      '- first: consumed=1 limit=5',
      '- second: consumed=2 limit=6',
      '- third: consumed=3 limit=7',
    ]);
  });

  it('creates a new budget at the end of the registry', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', { id: 'a', consumed: 1, limit: 5 });
    await harness.executeTool('agent_budget_set', { id: 'b', consumed: 2, limit: 5 });
    const result = await harness.executeTool('agent_budget_set', {
      id: 'c',
      consumed: 3,
      limit: 5,
    });

    expect(text(result)).toContain('created budget "c"');
    expect(summaryLines(text(await harness.executeTool('agent_budget_get', {})))).toEqual([
      '- a: consumed=1 limit=5',
      '- b: consumed=2 limit=5',
      '- c: consumed=3 limit=5',
    ]);
    expect(harness.appendedEntries).toHaveLength(3);
  });

  it('replaces an existing budget in place', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', { id: 'a', consumed: 1, limit: 5 });
    await harness.executeTool('agent_budget_set', { id: 'b', consumed: 2, limit: 5 });
    await harness.executeTool('agent_budget_set', { id: 'c', consumed: 3, limit: 5 });
    const result = await harness.executeTool('agent_budget_set', {
      id: 'b',
      consumed: 4,
      limit: 8,
    });

    expect(text(result)).toContain('replaced budget "b"');
    expect(text(result)).toContain('in place');
    expect(summaryLines(text(await harness.executeTool('agent_budget_get', {})))).toEqual([
      '- a: consumed=1 limit=5',
      '- b: consumed=4 limit=8',
      '- c: consumed=3 limit=5',
    ]);
    expect((lastAppended(harness).data as { budgets: unknown[] }).budgets).toEqual([
      record('a'),
      record('b', 4, 8),
      record('c', 3),
    ]);
  });

  it('does not append when a set repeats identical values', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', { id: 'same', consumed: 3, limit: 5 });
    const before = harness.appendedEntries.length;

    const result = await harness.executeTool('agent_budget_set', {
      id: 'same',
      consumed: 3,
      limit: 5,
    });

    expect(text(result)).toContain('unchanged');
    expect(text(result)).toContain('nothing was written');
    expect(harness.appendedEntries).toHaveLength(before);
  });

  it('accepts fractional consumption and a zero limit through the core judge', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', {
      id: 'fractional',
      consumed: 2.5,
      limit: 3.75,
    });
    await harness.executeTool('agent_budget_set', {
      id: 'zero-limit',
      consumed: 0.5,
      limit: 0,
    });
    const before = harness.getBranch().length;

    const result = text(await harness.executeTool('agent_budget_judge', {}));

    expect(result).toContain('Agent Budget judged 2 budget(s):');
    expect(result).toContain('- fractional: within_budget (remaining 1.25)');
    expect(result).toContain('- zero-limit: exhausted (remaining -0.5)');
    expect(harness.getBranch()).toHaveLength(before);
    expect(harness.appendedEntries).toHaveLength(2);
  });

  it('rejects invalid set inputs without appending entries', async () => {
    const harness = new FakePiHarness();
    const invalidInputs: unknown[] = [
      { id: 'negative-consumed', consumed: -1, limit: 5 },
      { id: 'negative-limit', consumed: 1, limit: -1 },
      { id: 'nan', consumed: Number.NaN, limit: 5 },
      { id: 'infinity', consumed: Number.POSITIVE_INFINITY, limit: 5 },
      { id: 'string-consumed', consumed: '1', limit: 5 },
      { id: 'string-limit', consumed: 1, limit: '5' },
      { id: 'has whitespace', consumed: 1, limit: 5 },
      { id: 'extra', consumed: 1, limit: 5, extra: true },
    ];

    for (const input of invalidInputs) {
      expect(text(await harness.executeTool('agent_budget_set', input))).toContain(
        'invalid budget input.',
      );
    }
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it('removes known budgets and reports unknown ids without appending', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', { id: 'known', consumed: 1, limit: 5 });

    const removed = await harness.executeTool('agent_budget_remove', { id: 'known' });
    expect(text(removed)).toContain('removed budget "known"');
    expect(harness.appendedEntries).toHaveLength(2);

    const unknown = await harness.executeTool('agent_budget_remove', { id: 'missing' });
    expect(text(unknown)).toContain('unknown budget "missing"');
    expect(harness.appendedEntries).toHaveLength(2);
  });

  it('judges transiently and preserves a negative remaining value for overage', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', { id: 'over', consumed: 7, limit: 5 });
    const before = harness.getBranch().length;

    const result = text(await harness.executeTool('agent_budget_judge', {}));

    expect(result).toContain('Agent Budget judged 1 budget(s):');
    expect(result).toContain('- over: exhausted (remaining -2)');
    expect(harness.getBranch()).toHaveLength(before);
    expect(harness.appendedEntries).toHaveLength(1);
  });

  it('gates clear, then clears once, and makes repeated clear a no-op', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', { id: 'one', consumed: 1, limit: 5 });
    await harness.executeTool('agent_budget_set', { id: 'two', consumed: 2, limit: 5 });
    const beforeGate = harness.appendedEntries.length;

    await harness.command('clear');
    expect(harness.notifications.at(-1)?.message).toContain('clear would remove 2 budgets');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Run /agent-budget clear --yes to confirm.',
    );
    expect(harness.appendedEntries).toHaveLength(beforeGate);
    expect(text(await harness.executeTool('agent_budget_get', {}))).toContain('2 budgets');

    await harness.command('clear --yes');
    expect(harness.notifications.at(-1)?.message).toContain('cleared 2 budgets');
    expect(harness.appendedEntries).toHaveLength(beforeGate + 1);
    expect((lastAppended(harness).data as { budgets: unknown[] }).budgets).toEqual([]);

    await harness.command('clear --yes');
    expect(harness.notifications.at(-1)?.message).toContain('nothing to clear');
    expect(harness.appendedEntries).toHaveLength(beforeGate + 1);
  });

  it('parses space-separated and equals-form numeric command flags', async () => {
    const harness = new FakePiHarness();

    await harness.command('set space --consumed 2.5 --limit 3.5');
    await harness.command('set equals --consumed=5 --limit=5');
    expect(harness.notifications.at(-2)?.message).toContain('created budget "space"');
    expect(harness.notifications.at(-1)?.message).toContain('created budget "equals"');
    expect(summaryLines(text(await harness.executeTool('agent_budget_get', {})))).toEqual([
      '- space: consumed=2.5 limit=3.5',
      '- equals: consumed=5 limit=5',
    ]);

    await harness.command('set bad --consumed NaN --limit 5');
    expect(harness.notifications.at(-1)?.message).toContain('invalid budget input.');
    expect(harness.appendedEntries).toHaveLength(2);
  });

  it('persists only the exact state envelope and record keys', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_budget_set', {
      id: 'exact',
      consumed: 1.5,
      limit: 2.5,
    });

    expect(lastAppended(harness).data).toEqual({
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      budgets: [{ id: 'exact', consumed: 1.5, limit: 2.5 }],
    });
  });
});

