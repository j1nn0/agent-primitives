import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { COMMAND_NAME } from '../src/command.js';
import { formatRetryState } from '../src/display.js';
import {
  ADAPTER_SCHEMA_VERSION,
  STATE_CUSTOM_TYPE,
} from '../src/state.js';
import { TOOL_NAMES } from '../src/tools.js';
import { FakePiHarness } from './harness.js';
import { TOOL_NAMES as PROGRESS_TOOL_NAMES } from '../../agent-progress-pi/src/tools.js';
import { TOOL_NAMES as STATE_TOOL_NAMES } from '../../agent-state-pi/src/tools.js';
import { STATE_CUSTOM_TYPE as CONTEXT_STATE_CUSTOM_TYPE } from '../../context-guard-pi/src/state.js';

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

function customEntry(data: unknown): unknown {
  return { type: 'custom', customType: STATE_CUSTOM_TYPE, data };
}

function payload(
  attempts: readonly unknown[] = [],
  policy: Record<string, unknown> = {},
): unknown {
  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    attempts,
    policy,
  };
}

function verdictFrom(result: AgentToolResult<unknown>): Record<string, unknown> {
  const output = text(result);
  const jsonStart = output.indexOf('{');
  const readingStart = output.lastIndexOf('\nReading:');
  if (jsonStart < 0 || readingStart < 0) {
    throw new Error(`expected formatted verdict: ${output}`);
  }
  return JSON.parse(output.slice(jsonStart, readingStart)) as Record<string, unknown>;
}

async function add(
  harness: FakePiHarness,
  outcome: string,
  strategyId?: string,
): Promise<string> {
  return text(
    await harness.executeTool(
      'agent_retry_add_attempt',
      strategyId === undefined ? { outcome } : { outcome, strategyId },
    ),
  );
}

describe('Agent Retry Guard Pi registration and commands', () => {
  it('registers exactly one command, five tools, and one lifecycle handler', () => {
    const harness = new FakePiHarness();

    expect([...harness.commands.keys()]).toEqual([COMMAND_NAME]);
    expect([...harness.tools.keys()]).toEqual(TOOL_NAMES);
    expect(harness.tools.size).toBe(5);
    expect([...harness.handlers.keys()]).toEqual(['session_start']);
    expect([...harness.tools.values()].map((tool) => tool.label)).toEqual([
      'Agent Retry Guard: get',
      'Agent Retry Guard: add attempt',
      'Agent Retry Guard: set policy',
      'Agent Retry Guard: judge',
      'Agent Retry Guard: start episode',
    ]);

    const get = harness.tools.get('agent_retry_get');
    const addAttempt = harness.tools.get('agent_retry_add_attempt');
    const setPolicy = harness.tools.get('agent_retry_set_policy');
    const judge = harness.tools.get('agent_retry_judge');
    const startEpisode = harness.tools.get('agent_retry_start_episode');
    expect(get?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(judge?.parameters).toEqual(get?.parameters);
    expect(startEpisode?.parameters).toEqual(get?.parameters);
    expect(addAttempt?.parameters).toEqual({
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['success', 'failure', 'no_progress', 'unknown'],
          description: 'Exact caller-declared outcome for this retry attempt.',
        },
        strategyId: {
          type: 'string',
          description: 'Caller-supplied opaque strategy identifier, preserved exactly.',
        },
      },
      required: ['outcome'],
      additionalProperties: false,
    });
    expect(setPolicy?.parameters).toEqual({
      type: 'object',
      properties: {
        maxAttempts: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum attempts permitted in the current retry episode.',
        },
        maxStrategyAttempts: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum trailing attempts for one identified strategy.',
        },
      },
      additionalProperties: false,
    });

    const descriptions = [...harness.tools.values()].map((tool) => tool.description);
    expect(descriptions.every((description) => description.includes('infer outcomes'))).toBe(true);
    expect(descriptions.every((description) => description.includes('generate strategy identifiers'))).toBe(true);
    expect(descriptions.every((description) => description.includes('map Progress verdicts'))).toBe(true);
    expect(descriptions.every((description) => description.includes('execute retries'))).toBe(true);
    expect(descriptions.every((description) => description.includes('verify truth'))).toBe(true);
    expect(harness.tools.get('agent_retry_start_episode')?.description).toContain(
      'at model or caller discretion',
    );
    expect(harness.tools.get('agent_retry_start_episode')?.description).toContain(
      'never triggered automatically by success',
    );
  });

  it('shows the same non-judging raw summary for status, bare command, and get', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('');
    const bareStatus = harness.notifications.at(-1)?.message;
    await harness.command('status');
    const namedStatus = harness.notifications.at(-1)?.message;
    const toolStatus = text(await harness.executeTool('agent_retry_get'));

    expect(namedStatus).toBe(bareStatus);
    expect(toolStatus).toBe(namedStatus);
    expect(namedStatus).toContain('0 attempts recorded');
    expect(namedStatus).toContain('Attempts: none.');
    expect(namedStatus).toContain('Policy: no policy set.');
    expect(harness.appendedEntries).toHaveLength(0);

    await harness.command('status extra');
    expect(harness.notifications.at(-1)).toEqual({
      message: expect.stringContaining('Usage: /agent-retry'),
      type: 'warning',
    });
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it('records every closed outcome with and without an exact strategy id', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    const outcomes = ['success', 'failure', 'no_progress', 'unknown'];
    for (const outcome of outcomes) {
      await harness.command(`add ${outcome}`);
    }
    await harness.command('add failure "strategy with spaces"');

    expect(harness.appendedEntries).toHaveLength(5);
    expect(harness.appendedEntries.map((entry) => entry.customType)).toEqual(
      Array.from({ length: 5 }, () => STATE_CUSTOM_TYPE),
    );
    expect(lastAppended(harness).data).toEqual(
      payload([{ outcome: 'success' }, { outcome: 'failure' }, { outcome: 'no_progress' }, { outcome: 'unknown' }, { outcome: 'failure', strategyId: 'strategy with spaces' }]),
    );
    await harness.command('status');
    const status = harness.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Attempt 1: outcome=success; strategyId=no-id');
    expect(status).toContain('Attempt 5: outcome=failure; strategyId=strategy with spaces');
    expect(status).not.toContain('retryAllowed');
  });

  it('rejects malformed add arguments with usage text and no append', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    for (const args of [
      'add',
      'add SUCCESS',
      'add done',
      'add failure ""',
      'add failure "   "',
      'add failure "unterminated',
      'add failure first second',
    ]) {
      await harness.command(args);
      expect(harness.notifications.at(-1)).toEqual({
        message: expect.stringContaining('Usage: /agent-retry'),
        type: 'warning',
      });
    }
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it('sets, replaces, clears, and displays policy only when it changes', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('policy 6');
    expect(harness.appendedEntries).toHaveLength(1);
    expect(lastAppended(harness).data).toEqual(payload([], { maxAttempts: 6 }));
    await harness.command('policy 6');
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('policy 6 3');
    expect(harness.appendedEntries).toHaveLength(2);
    expect(lastAppended(harness).data).toEqual(
      payload([], { maxAttempts: 6, maxStrategyAttempts: 3 }),
    );
    await harness.command('policy');
    expect(harness.notifications.at(-1)?.message).toBe(
      'Policy: maxAttempts=6, maxStrategyAttempts=3.',
    );

    await harness.command('policy clear');
    expect(harness.appendedEntries).toHaveLength(3);
    expect(lastAppended(harness).data).toEqual(payload());
    await harness.command('policy clear');
    expect(harness.appendedEntries).toHaveLength(3);

    for (const args of ['policy 0', 'policy -1', 'policy 1.5', 'policy nope', 'policy 1 2 3']) {
      await harness.command(args);
      expect(harness.notifications.at(-1)).toEqual({
        message: expect.stringContaining('Usage: /agent-retry'),
        type: 'warning',
      });
    }
    expect(harness.appendedEntries).toHaveLength(3);
  });

  it('requires clear confirmation and confirmed clear wipes both attempts and policy', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('policy 4 2');
    await harness.command('add failure alpha');
    const before = harness.appendedEntries.length;

    await harness.command('clear');
    expect(harness.notifications.at(-1)).toEqual({
      message: expect.stringContaining('clear requires confirmation'),
      type: 'warning',
    });
    expect(harness.appendedEntries).toHaveLength(before);

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(before + 1);
    expect(lastAppended(harness).data).toEqual(payload());
    expect(text(await harness.executeTool('agent_retry_get'))).toContain(
      'Policy: no policy set.',
    );
    expect(text(await harness.executeTool('agent_retry_get'))).toContain(
      '0 attempts recorded',
    );

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(before + 2);
  });
});

describe('Agent Retry Guard Pi tools and explicit judgment', () => {
  it('records tool attempts without judging or resetting after success', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    const initial = harness.appendedEntries.length;
    expect(initial).toBe(0);

    const response = await add(harness, 'success', 'finished');
    expect(response).toContain('recorded success attempt');
    expect(response).not.toContain('retryAllowed');
    expect(response).not.toContain('consecutiveFailures');
    expect(response).not.toContain('strategyRun');
    expect(harness.appendedEntries).toHaveLength(1);

    const state = text(await harness.executeTool('agent_retry_get'));
    expect(state).toContain('1 attempt recorded');
    expect(state).toContain('outcome=success; strategyId=finished');
    expect(harness.appendedEntries).toHaveLength(1);

    for (const params of [
      {},
      { outcome: 'SUCCESS' },
      { outcome: 'failure', strategyId: '' },
      { outcome: 'failure', strategyId: ' \t' },
      { outcome: 'failure', strategyId: undefined },
      { outcome: 'failure', extra: true },
    ]) {
      const invalid = text(await harness.executeTool('agent_retry_add_attempt', params));
      expect(invalid).toContain('Usage: /agent-retry');
    }
    expect(harness.appendedEntries).toHaveLength(1);
  });

  it('replaces policy through the tool and appends only on change', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    expect(
      text(await harness.executeTool('agent_retry_set_policy', {
        maxAttempts: 6,
        maxStrategyAttempts: 3,
      })),
    ).toContain('maxAttempts=6, maxStrategyAttempts=3');
    expect(harness.appendedEntries).toHaveLength(1);

    expect(
      text(await harness.executeTool('agent_retry_set_policy', {
        maxAttempts: 6,
        maxStrategyAttempts: 3,
      })),
    ).toContain('policy unchanged');
    expect(harness.appendedEntries).toHaveLength(1);

    await add(harness, 'failure', 'alpha');
    const beforeClear = harness.appendedEntries.length;
    expect(
      text(await harness.executeTool('agent_retry_set_policy', {})),
    ).toContain('no policy set');
    expect(harness.appendedEntries).toHaveLength(beforeClear + 1);
    expect(lastAppended(harness).data).toEqual(payload([{ outcome: 'failure', strategyId: 'alpha' }]));

    for (const params of [
      { maxAttempts: 0 },
      { maxStrategyAttempts: 0 },
      { maxAttempts: 1.5 },
      { maxStrategyAttempts: '3' },
      { maxAttempts: undefined },
      { extra: 1 },
    ]) {
      expect(
        text(await harness.executeTool('agent_retry_set_policy', params)),
      ).toContain('Usage: /agent-retry');
    }
    expect(harness.appendedEntries).toHaveLength(beforeClear + 1);
  });

  it('delegates all judgment cases to the core and never appends while judging', async () => {
    const empty = new FakePiHarness();
    await empty.start();
    await empty.executeTool('agent_retry_set_policy', {
      maxAttempts: 1,
      maxStrategyAttempts: 1,
    });
    const emptyBefore = empty.appendedEntries.length;
    expect(verdictFrom(await empty.executeTool('agent_retry_judge'))).toEqual({
      attempts: 0,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
      retryAllowed: true,
    });
    expect(empty.appendedEntries).toHaveLength(emptyBefore);

    const failureStreak = new FakePiHarness();
    await failureStreak.start();
    await add(failureStreak, 'failure');
    await add(failureStreak, 'failure');
    expect(verdictFrom(await failureStreak.executeTool('agent_retry_judge'))).toEqual({
      attempts: 2,
      consecutiveFailures: 2,
      consecutiveNoProgress: 0,
      retryAllowed: true,
    });

    const strategyLimit = new FakePiHarness();
    await strategyLimit.start();
    await strategyLimit.executeTool('agent_retry_set_policy', { maxStrategyAttempts: 2 });
    await add(strategyLimit, 'failure', 'alpha');
    await add(strategyLimit, 'no_progress', 'alpha');
    expect(verdictFrom(await strategyLimit.executeTool('agent_retry_judge'))).toEqual({
      attempts: 2,
      consecutiveFailures: 0,
      consecutiveNoProgress: 1,
      strategyRun: { strategyId: 'alpha', attempts: 2 },
      retryAllowed: false,
    });

    const strategySwitch = new FakePiHarness();
    await strategySwitch.start();
    await strategySwitch.executeTool('agent_retry_set_policy', { maxStrategyAttempts: 2 });
    await add(strategySwitch, 'failure', 'alpha');
    await add(strategySwitch, 'failure', 'beta');
    expect(verdictFrom(await strategySwitch.executeTool('agent_retry_judge'))).toEqual({
      attempts: 2,
      consecutiveFailures: 2,
      consecutiveNoProgress: 0,
      strategyRun: { strategyId: 'beta', attempts: 1 },
      retryAllowed: true,
    });

    const unknown = new FakePiHarness();
    await unknown.start();
    await add(unknown, 'failure', 'alpha');
    await add(unknown, 'unknown', 'alpha');
    await add(unknown, 'failure', 'alpha');
    const unknownVerdict = verdictFrom(await unknown.executeTool('agent_retry_judge'));
    expect(unknownVerdict).toEqual({
      attempts: 3,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      strategyRun: { strategyId: 'alpha', attempts: 1 },
      retryAllowed: true,
    });

    const success = new FakePiHarness();
    await success.start();
    await add(success, 'failure');
    await add(success, 'success');
    expect(verdictFrom(await success.executeTool('agent_retry_judge'))).toEqual({
      attempts: 2,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
      retryAllowed: false,
    });

    const maxAttempts = new FakePiHarness();
    await maxAttempts.start();
    await maxAttempts.executeTool('agent_retry_set_policy', { maxAttempts: 2 });
    await add(maxAttempts, 'failure');
    await add(maxAttempts, 'failure');
    expect(verdictFrom(await maxAttempts.executeTool('agent_retry_judge'))?.retryAllowed).toBe(false);

    const idless = new FakePiHarness();
    await idless.start();
    await idless.executeTool('agent_retry_set_policy', { maxStrategyAttempts: 1 });
    await add(idless, 'failure');
    await add(idless, 'failure');
    const idlessVerdict = verdictFrom(await idless.executeTool('agent_retry_judge'));
    expect(idlessVerdict.retryAllowed).toBe(true);
    expect(Object.hasOwn(idlessVerdict, 'strategyRun')).toBe(false);
  });

  it('starts a new episode only explicitly, preserves policy, and appends only after a reset', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.executeTool('agent_retry_set_policy', { maxAttempts: 5 });
    await add(harness, 'success');
    const beforeReset = harness.appendedEntries.length;

    const reset = text(await harness.executeTool('agent_retry_start_episode'));
    expect(reset).toContain('new episode started');
    expect(reset).toContain('policy preserved');
    expect(harness.appendedEntries).toHaveLength(beforeReset + 1);
    expect(lastAppended(harness).data).toEqual(payload([], { maxAttempts: 5 }));
    expect(text(await harness.executeTool('agent_retry_get'))).toContain(
      '0 attempts recorded',
    );
    expect(text(await harness.executeTool('agent_retry_get'))).toContain(
      'Policy: maxAttempts=5.',
    );

    const beforeNoOp = harness.appendedEntries.length;
    const noOp = text(await harness.executeTool('agent_retry_start_episode'));
    expect(noOp).toContain('not started');
    expect(noOp).toContain('policy preserved');
    expect(harness.appendedEntries).toHaveLength(beforeNoOp);
  });
});

describe('Agent Retry Guard Pi persistence and boundaries', () => {
  it('round-trips raw attempts and policy, including absent strategy ids', async () => {
    const first = new FakePiHarness();
    await first.start();
    await first.executeTool('agent_retry_set_policy', {
      maxAttempts: 5,
      maxStrategyAttempts: 3,
    });
    await add(first, 'failure');
    await add(first, 'no_progress', '  exact id  ');

    const serializedBranch = JSON.parse(JSON.stringify(first.getBranch())) as unknown[];
    const resumed = new FakePiHarness(serializedBranch);
    await resumed.start('resume');
    expect(resumed.appendedEntries).toHaveLength(0);
    await resumed.command('status');
    const status = resumed.notifications.at(-1)?.message ?? '';
    expect(status).toContain('2 attempts recorded');
    expect(status).toContain('Attempt 1: outcome=failure; strategyId=no-id');
    expect(status).toContain('Attempt 2: outcome=no_progress; strategyId=  exact id  ');
    expect(status).toContain('Policy: maxAttempts=5, maxStrategyAttempts=3.');

    await resumed.executeTool('agent_retry_start_episode');
    expect(lastAppended(resumed).data).toEqual(payload([], {
      maxAttempts: 5,
      maxStrategyAttempts: 3,
    }));
    const secondResume = new FakePiHarness(
      JSON.parse(JSON.stringify(resumed.getBranch())) as unknown[],
    );
    await secondResume.start('resume');
    expect(text(await secondResume.executeTool('agent_retry_get'))).toContain(
      'Policy: maxAttempts=5, maxStrategyAttempts=3.',
    );
    expect(text(await secondResume.executeTool('agent_retry_get'))).toContain(
      '0 attempts recorded',
    );
  });

  it('warns once and starts fresh for a malformed newest entry without fallback or repair', async () => {
    const malformed = [
      payload([{ outcome: 'failure' }]),
      payload([{ outcome: 'not-an-outcome' }]),
      payload([{ outcome: 'failure', retryAllowed: true }]),
      payload([{ outcome: 'failure' }], { maxAttempts: 0 }),
      { schemaVersion: 2, attempts: [], policy: {} },
      { schemaVersion: 1, attempts: 'not-array', policy: {} },
      { schemaVersion: 1, attempts: [], policy: {}, consecutiveFailures: 0 },
    ];

    for (const bad of malformed.slice(1)) {
      const harness = new FakePiHarness([customEntry(bad)]);
      await harness.start('resume');
      expect(harness.notifications).toEqual([
        {
          message: 'Agent Retry Guard: persisted state was invalid; starting with fresh state.',
          type: 'warning',
        },
      ]);
      expect(harness.appendedEntries).toHaveLength(0);
      expect(text(await harness.executeTool('agent_retry_get'))).toContain(
        '0 attempts recorded',
      );
    }

    const newestInvalid = new FakePiHarness([
      customEntry(malformed[0]),
      customEntry({ schemaVersion: 1, attempts: [], policy: {}, retryAllowed: false }),
    ]);
    await newestInvalid.start('resume');
    expect(newestInvalid.notifications).toHaveLength(1);
    expect(newestInvalid.appendedEntries).toHaveLength(0);
    expect(text(await newestInvalid.executeTool('agent_retry_get'))).toContain(
      'Policy: no policy set.',
    );
  });

  it('isolates a new session with no matching custom state entry', async () => {
    const harness = new FakePiHarness([
      { type: 'message', message: 'unrelated' },
      { type: 'custom', customType: 'other-state', data: payload() },
    ]);
    await harness.start();
    expect(harness.notifications).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(text(await harness.executeTool('agent_retry_get'))).toBe(
      formatRetryState({ attempts: [], policy: {} }),
    );
  });
});

describe('Agent Retry Guard Pi coexistence and zero automatic behavior', () => {
  it('keeps all command, tool, and persisted namespaces distinct', () => {
    const allCommands = [COMMAND_NAME, 'agent-progress', 'agent-state', 'context-guard'];
    const allStateTypes = [
      STATE_CUSTOM_TYPE,
      'agent-progress-state',
      'agent-state-state',
      CONTEXT_STATE_CUSTOM_TYPE,
    ];
    const allTools = [
      ...TOOL_NAMES,
      ...PROGRESS_TOOL_NAMES,
      ...STATE_TOOL_NAMES,
    ];

    expect(new Set(allCommands).size).toBe(allCommands.length);
    expect(new Set(allStateTypes).size).toBe(allStateTypes.length);
    expect(new Set(allTools).size).toBe(allTools.length);
    expect(COMMAND_NAME).toBe('agent-retry');
    expect(STATE_CUSTOM_TYPE).toBe('agent-retry-state');
    expect(TOOL_NAMES.every((name) => !name.startsWith('agent_progress_'))).toBe(true);
    expect(TOOL_NAMES.every((name) => !name.startsWith('agent_state_'))).toBe(true);
  });

  it('does not append or judge merely by registering and starting', async () => {
    const harness = new FakePiHarness();
    expect(harness.appendedEntries).toHaveLength(0);
    await harness.start();
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
  });
});
