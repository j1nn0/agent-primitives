import { describe, expect, it } from 'vitest';
import { COMMAND_NAME } from '../src/command.js';
import { STATE_CUSTOM_TYPE, ADAPTER_SCHEMA_VERSION } from '../src/state.js';
import {
  APPROVAL_DENIED_REASON,
  NO_UI_APPROVAL_REASON,
} from '../src/messages.js';
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

function approvalHarness(toolName: string): FakePiHarness {
  return new FakePiHarness([
    customEntry(
      envelope({
        default: 'deny',
        allow: [],
        deny: [],
        requiresApproval: [toolName],
      }),
    ),
  ]);
}

function nameOnlyApprovalMessage(toolName: string): string {
  return `Allow tool call "${toolName}"? This tool requires approval under the active policy.`;
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

    const result = await harness.executeToolCall('dangerous');
    expect(result).toBeUndefined();
    expect(harness.confirmationCalls).toHaveLength(1);
    expect(harness.confirmationCalls[0]?.message).toBe(nameOnlyApprovalMessage('dangerous'));
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

  it('renders allowlisted operand previews and keeps the decision fail-safe', async () => {
    const cases: readonly {
      toolName: string;
      input: Record<string, unknown>;
      lines: readonly string[];
    }[] = [
      { toolName: 'bash', input: { command: 'rm -rf x' }, lines: ['command: rm -rf x'] },
      { toolName: 'powershell', input: { command: 'Get-Item x' }, lines: ['command: Get-Item x'] },
      { toolName: 'read', input: { path: '/a/b.ts' }, lines: ['path: /a/b.ts'] },
      { toolName: 'edit', input: { path: '/a.ts', edits: [{ oldText: 'SECRET_OLD', newText: 'SECRET_NEW' }] }, lines: ['path: /a.ts'] },
      { toolName: 'write', input: { path: '/a.ts', content: 'WHOLE_FILE_SECRET' }, lines: ['path: /a.ts'] },
      { toolName: 'grep', input: { pattern: 'foo', path: 'src', glob: '*.ts' }, lines: ['pattern: foo', 'path: src', 'glob: *.ts'] },
      { toolName: 'find', input: { pattern: '*.ts', path: 'src' }, lines: ['pattern: *.ts', 'path: src'] },
      { toolName: 'ls', input: { path: '/tmp' }, lines: ['path: /tmp'] },
    ];

    for (const testCase of cases) {
      const harness = approvalHarness(testCase.toolName);
      await harness.start();
      const result = await harness.executeToolCall(testCase.toolName, testCase.input);
      expect(blockReason(result)).toBe(APPROVAL_DENIED_REASON);
      const message = harness.confirmationCalls[0]?.message ?? '';
      expect(message.split('\n').slice(-testCase.lines.length)).toEqual(testCase.lines);
      expect(harness.confirmationCalls).toHaveLength(1);
      if (testCase.toolName === 'edit') {
        expect(message).not.toContain('SECRET_OLD');
        expect(message).not.toContain('SECRET_NEW');
      }
      if (testCase.toolName === 'write') {
        expect(message).not.toContain('WHOLE_FILE_SECRET');
      }
    }
  });

  it('falls back to the exact name-only approval message for unknown and invalid operands', async () => {
    const unknown = approvalHarness('mcp__srv__thing');
    await unknown.start();
    await unknown.executeToolCall('mcp__srv__thing', { command: 'SECRET' });
    expect(unknown.confirmationCalls[0]?.message).toBe(nameOnlyApprovalMessage('mcp__srv__thing'));
    expect(unknown.confirmationCalls[0]?.message).not.toContain('SECRET');

    const invalid = approvalHarness('ls');
    await invalid.start();
    await invalid.executeToolCall('ls', { path: 42 });
    expect(invalid.confirmationCalls[0]?.message).toBe(nameOnlyApprovalMessage('ls'));

    const empty = approvalHarness('ls');
    await empty.start();
    await empty.executeToolCall('ls', {});
    expect(empty.confirmationCalls[0]?.message).toBe(nameOnlyApprovalMessage('ls'));
  });

  it('skips accessor operands without invoking getters', async () => {
    let invoked = false;
    const input = {};
    Object.defineProperty(input, 'path', {
      enumerable: true,
      get: () => {
        invoked = true;
        throw new Error('getter invoked');
      },
    });

    const harness = approvalHarness('read');
    await harness.start();
    await harness.executeToolCall('read', input);
    expect(invoked).toBe(false);
    expect(harness.confirmationCalls[0]?.message).toBe(nameOnlyApprovalMessage('read'));
  });

  it('normalizes multiline controls and truncates long operands', async () => {
    const multiline = approvalHarness('bash');
    await multiline.start();
    await multiline.executeToolCall('bash', { command: 'cd a\nrm -rf b\tsomething\x01' });
    const multilineMessage = multiline.confirmationCalls[0]?.message ?? '';
    expect(multilineMessage).toContain('command: cd a ⏎ rm -rf b something');
    expect(multilineMessage).not.toContain('\x01');
    expect(multilineMessage.split('\n')).toHaveLength(2);

    const truncation = approvalHarness('bash');
    await truncation.start();
    await truncation.executeToolCall('bash', { command: 'x'.repeat(200) });
    const truncationMessage = truncation.confirmationCalls[0]?.message ?? '';
    expect(truncationMessage).toContain(`command: ${'x'.repeat(120)}... [truncated]`);
    expect(truncationMessage).not.toContain('x'.repeat(121));
  });

  it('uses confirmation only for the decision and keeps headless calls before preview work', async () => {
    const approved = approvalHarness('bash');
    approved.setConfirm(async () => true);
    await approved.start();
    expect(await approved.executeToolCall('bash', { command: 'echo approved' })).toBeUndefined();
    expect(approved.confirmationCalls[0]?.message).toContain('command: echo approved');

    const denied = approvalHarness('bash');
    denied.setConfirm(async () => false);
    await denied.start();
    expect(blockReason(await denied.executeToolCall('bash', { command: 'echo denied' }))).toBe(
      APPROVAL_DENIED_REASON,
    );

    let headlessGetterInvoked = false;
    const toxicInput = {};
    Object.defineProperty(toxicInput, 'command', {
      enumerable: true,
      get: () => {
        headlessGetterInvoked = true;
        throw new Error('headless preview invoked');
      },
    });
    const headless = approvalHarness('bash');
    await headless.start();
    expect(
      blockReason(await headless.executeToolCall('bash', toxicInput, { hasUI: false })),
    ).toBe(NO_UI_APPROVAL_REASON);
    expect(headlessGetterInvoked).toBe(false);
    expect(headless.confirmationCalls).toHaveLength(0);
  });

  it('uses only the tool name for core policy matching', async () => {
    const harness = new FakePiHarness([
      customEntry(
        envelope({
          default: 'deny',
          allow: ['bash'],
          deny: [],
          requiresApproval: [],
        }),
      ),
    ]);
    await harness.start();

    expect(await harness.executeToolCall('bash', { command: 'SAFE' })).toBeUndefined();
    expect(await harness.executeToolCall('bash', { command: 'DIFFERENT' })).toBeUndefined();
    expect(harness.confirmationCalls).toHaveLength(0);
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
