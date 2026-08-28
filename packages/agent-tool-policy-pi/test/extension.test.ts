import { describe, expect, it } from 'vitest';
import { COMMAND_NAME } from '../src/command.js';
import { STATE_CUSTOM_TYPE, ADAPTER_SCHEMA_VERSION } from '../src/state.js';
import { FakePiHarness, type AppendedEntry } from './harness.js';

const VALID_POLICY = {
  default: 'deny',
  allow: ['read'],
  deny: ['write'],
  requiresApproval: ['dangerous'],
} as const;

function customEntry(data: unknown, customType: string = STATE_CUSTOM_TYPE): unknown {
  return { type: 'custom', customType, data };
}

function envelope(policy: unknown): unknown {
  return { schemaVersion: ADAPTER_SCHEMA_VERSION, policy };
}

function lastAppended(harness: FakePiHarness): AppendedEntry {
  const entry = harness.appendedEntries.at(-1);
  if (entry === undefined) {
    throw new Error('expected an appended entry');
  }
  return entry;
}

function blockReason(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('reason' in result) ||
    typeof result.reason !== 'string'
  ) {
    throw new Error('expected a blocked tool call result');
  }
  return result.reason;
}

describe('Agent Tool Policy Pi registration', () => {
  it('registers one command, two lifecycle handlers, and no model tools', () => {
    const harness = new FakePiHarness();

    expect([...harness.commands.keys()]).toEqual([COMMAND_NAME]);
    expect([...harness.handlers.keys()]).toEqual(['session_start', 'tool_call']);
    expect(harness.tools.size).toBe(0);
  });
});

describe('Agent Tool Policy Pi enforcement', () => {
  it('blocks every tool with recovery hints when no policy is configured', async () => {
    const harness = new FakePiHarness();

    for (const toolName of ['read', 'write', 'mcp__server__search']) {
      const reason = blockReason(await harness.executeToolCall(toolName));
      expect(reason).toContain('no policy configured');
      expect(reason).toContain('/agent-tool-policy set <policy-json>');
      expect(reason).toContain('/agent-tool-policy clear --yes');
    }
  });

  it('warns exactly once at session_start for an unconfigured session', async () => {
    const harness = new FakePiHarness();

    await harness.start();
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.message).toContain('no policy configured');
    expect(harness.notifications[0]?.type).toBe('warning');

    await harness.executeToolCall('read');
    expect(harness.notifications).toHaveLength(1);
  });

  it('passes through when the newest persisted entry is the explicit null marker', async () => {
    const harness = new FakePiHarness([customEntry(envelope(null))]);

    await harness.start();
    expect(await harness.executeToolCall('read')).toBeUndefined();
    expect(await harness.executeToolCall('write')).toBeUndefined();
    expect(harness.notifications).toHaveLength(0);
  });

  it('allows a tool selected by a valid policy', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    await harness.start();

    expect(await harness.executeToolCall('read')).toBeUndefined();
  });

  it('blocks a denied tool with the denied policy reason', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    await harness.start();

    const reason = blockReason(await harness.executeToolCall('write'));
    expect(reason).toContain('denied by tool policy');
  });

  it('blocks approval-required tools when no UI is available', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    await harness.start();

    const reason = blockReason(await harness.executeToolCall('dangerous', {}, { hasUI: false }));
    expect(reason).toContain('requires approval');
    expect(reason).toContain('no UI available');
    expect(harness.confirmationCalls).toHaveLength(0);
  });

  it('passes an approval-required tool when confirmation resolves true', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    harness.setConfirm(async () => true);
    await harness.start();

    expect(await harness.executeToolCall('dangerous')).toBeUndefined();
    expect(harness.confirmationCalls).toHaveLength(1);
  });

  it('blocks an approval-required tool when confirmation resolves false', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    harness.setConfirm(async () => false);
    await harness.start();

    const reason = blockReason(await harness.executeToolCall('dangerous'));
    expect(reason).toContain('approval');
    expect(reason).toContain('denied');
  });

  it('blocks rather than allowing when confirmation throws', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    harness.setConfirm(async () => {
      throw new Error('confirmation failed');
    });
    await harness.start();

    const reason = blockReason(await harness.executeToolCall('dangerous'));
    expect(reason).toContain('approval');
    expect(reason).toContain('not granted');
  });

  it('forwards the active abort signal to the approval dialog', async () => {
    const controller = new AbortController();
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    harness.setSignal(controller.signal);
    harness.setConfirm(async () => true);
    await harness.start();

    expect(await harness.executeToolCall('dangerous')).toBeUndefined();
    expect(harness.confirmationCalls[0]?.options).toEqual({ signal: controller.signal });
  });

  it('blocks with a judgment-failed reason when the core rejects a tool probe', async () => {
    const harness = new FakePiHarness([customEntry(envelope(VALID_POLICY))]);
    await harness.start();

    const reason = blockReason(await harness.executeToolCall('tool name'));
    expect(reason).toContain('tool policy');
    expect(reason).toContain('judgment failed');
  });

  it('blocks all tools and warns when the newest policy entry is corrupt', async () => {
    const corrupt = {
      default: 'deny',
      allow: 'read',
      deny: [],
    };
    const harness = new FakePiHarness([customEntry(envelope(corrupt))]);

    await harness.start();
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.message).toContain('policy configuration');
    expect(harness.notifications[0]?.message).toContain('invalid');

    const reason = blockReason(await harness.executeToolCall('read'));
    expect(reason).toContain('policy configuration');
    expect(reason).toContain('invalid');
    expect(reason).toContain('/agent-tool-policy set <policy-json>');
  });

  it('does not fall back to an older valid entry when the newest entry is corrupt', async () => {
    const branch = [
      customEntry(envelope(VALID_POLICY)),
      customEntry({ schemaVersion: 2, policy: VALID_POLICY }),
    ];
    const harness = new FakePiHarness(branch);

    await harness.start();
    const reason = blockReason(await harness.executeToolCall('read'));
    expect(reason).toContain('policy configuration');
    expect(reason).toContain('invalid');
  });
});

describe('Agent Tool Policy Pi commands and persistence', () => {
  it('sets valid JSON, enters enforcing mode, and persists one exact envelope', async () => {
    const harness = new FakePiHarness();

    await harness.command(`set ${JSON.stringify(VALID_POLICY)}`);

    expect(harness.appendedEntries).toHaveLength(1);
    expect(lastAppended(harness).customType).toBe(STATE_CUSTOM_TYPE);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      policy: VALID_POLICY,
    });
    expect(harness.notifications.at(-1)?.message).toContain('tool policy set');
    expect(await harness.executeToolCall('read')).toBeUndefined();
    expect(blockReason(await harness.executeToolCall('write'))).toContain(
      'denied by tool policy',
    );
  });

  it('rejects invalid policy JSON without appending or changing the mode', async () => {
    const harness = new FakePiHarness();

    await harness.command('set {not valid json');

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain('invalid policy JSON');
    expect(blockReason(await harness.executeToolCall('read'))).toContain('no policy configured');
  });

  it('rejects a policy rejected by the core without appending or changing the mode', async () => {
    const harness = new FakePiHarness();
    const invalidPolicy = {
      default: 'deny',
      allow: ['same'],
      deny: ['same'],
    };

    await harness.command(`set ${JSON.stringify(invalidPolicy)}`);

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain('invalid tool policy');
    expect(blockReason(await harness.executeToolCall('read'))).toContain('no policy configured');
  });

  it('gates clear, writes one null marker, and makes repeated clear --yes a no-op', async () => {
    const harness = new FakePiHarness();
    await harness.command(`set ${JSON.stringify(VALID_POLICY)}`);
    const beforeGate = harness.appendedEntries.length;

    await harness.command('clear');
    expect(harness.notifications.at(-1)?.message).toContain('clear would disable');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Run /agent-tool-policy clear --yes to confirm.',
    );
    expect(harness.appendedEntries).toHaveLength(beforeGate);
    expect(await harness.executeToolCall('read')).toBeUndefined();

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(beforeGate + 1);
    expect(lastAppended(harness).data).toEqual({
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      policy: null,
    });
    expect(harness.notifications.at(-1)?.message).toContain('disabled');
    expect(harness.notifications.at(-1)?.message).toContain('policy: null');

    await harness.command('clear --yes');
    expect(harness.notifications.at(-1)?.message).toContain('already disabled');
    expect(harness.appendedEntries).toHaveLength(beforeGate + 1);
  });

  it('round-trips enforcing, disabled, and corrupt modes through branch resume', async () => {
    const harness = new FakePiHarness();
    await harness.command(`set ${JSON.stringify(VALID_POLICY)}`);

    const resumed = new FakePiHarness(harness.getBranch());
    await resumed.start();
    expect(await resumed.executeToolCall('read')).toBeUndefined();
    expect(blockReason(await resumed.executeToolCall('write'))).toContain('denied by tool policy');

    await harness.command('clear --yes');
    const disabled = new FakePiHarness(harness.getBranch());
    await disabled.start();
    expect(await disabled.executeToolCall('write')).toBeUndefined();

    const corrupt = new FakePiHarness([
      ...harness.getBranch(),
      customEntry(envelope({ ...VALID_POLICY, extra: true })),
    ]);
    await corrupt.start();
    expect(blockReason(await corrupt.executeToolCall('read'))).toContain('policy configuration');
  });

  it('reports status and transient judge results for each non-enforcing mode', async () => {
    const unconfigured = new FakePiHarness();
    await unconfigured.command('judge read');
    expect(unconfigured.notifications.at(-1)?.message).toContain('unconfigured');
    await unconfigured.command('status');
    expect(unconfigured.notifications.at(-1)?.message).toContain('/agent-tool-policy set <policy-json>');
    expect(unconfigured.notifications.at(-1)?.message).toContain('policy: null');

    const enforcing = new FakePiHarness();
    await enforcing.command(`set ${JSON.stringify(VALID_POLICY)}`);
    await enforcing.command('judge read');
    expect(enforcing.notifications.at(-1)?.message).toContain('outcome=allowed');
    expect(enforcing.notifications.at(-1)?.message).toContain('source=rule');
    await enforcing.command('status');
    expect(enforcing.notifications.at(-1)?.message).toContain('mode is enforcing');
    expect(enforcing.notifications.at(-1)?.message).toContain(JSON.stringify(VALID_POLICY));

    const disabled = new FakePiHarness([customEntry(envelope(null))]);
    await disabled.start();
    await disabled.command('judge read');
    expect(disabled.notifications.at(-1)?.message).toContain('disabled');

    const corrupt = new FakePiHarness([customEntry({ schemaVersion: 2, policy: VALID_POLICY })]);
    await corrupt.start();
    await corrupt.command('judge read');
    expect(corrupt.notifications.at(-1)?.message).toContain('corrupted');
  });
});
