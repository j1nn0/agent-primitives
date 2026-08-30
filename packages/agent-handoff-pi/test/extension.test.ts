import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { COMMAND_NAME } from '../src/command.js';
import {
  ADAPTER_SCHEMA_VERSION,
  createPacket,
  isFreshState,
  removePacket,
  STATE_CUSTOM_TYPE,
  type HandoffState,
} from '../src/state.js';
import { TOOL_NAMES } from '../src/tools.js';
import { TOOL_NAMES as EVIDENCE_TOOL_NAMES } from '../../agent-evidence-pi/src/tools.js';
import { TOOL_NAMES as STATE_TOOL_NAMES } from '../../agent-state-pi/src/tools.js';
import { TOOL_NAMES as PROGRESS_TOOL_NAMES } from '../../agent-progress-pi/src/tools.js';
import { TOOL_NAMES as RETRY_TOOL_NAMES } from '../../agent-retry-guard-pi/src/tools.js';
import { STATE_CUSTOM_TYPE as EVIDENCE_STATE_CUSTOM_TYPE } from '../../agent-evidence-pi/src/state.js';
import { STATE_CUSTOM_TYPE as STATE_STATE_CUSTOM_TYPE } from '../../agent-state-pi/src/state.js';
import { STATE_CUSTOM_TYPE as PROGRESS_STATE_CUSTOM_TYPE } from '../../agent-progress-pi/src/state.js';
import { STATE_CUSTOM_TYPE as RETRY_STATE_CUSTOM_TYPE } from '../../agent-retry-guard-pi/src/state.js';
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

function payload(packets: readonly unknown[] = []): unknown {
  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    packets,
  };
}

function validPacket(id = 'handoff-1', source = 'engineer', overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    id,
    source,
    goal: 'Review PR 42',
    ...overrides,
  };
}

describe('Agent Handoff Pi registration and namespaces', () => {
  it('registers exactly one command, three tools, and one lifecycle handler', () => {
    const harness = new FakePiHarness();

    expect([...harness.commands.keys()]).toEqual([COMMAND_NAME]);
    expect([...harness.tools.keys()]).toEqual([...TOOL_NAMES]);
    expect(harness.tools.size).toBe(3);
    expect([...harness.handlers.keys()]).toEqual(['session_start']);
    expect([...harness.tools.values()].map((tool) => tool.label)).toEqual([
      'Agent Handoff: get',
      'Agent Handoff: create',
      'Agent Handoff: remove',
    ]);

    expect(harness.tools.get('agent_handoff_get')?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });

    const descriptions = [...harness.tools.values()].map((tool) => tool.description);
    expect(descriptions.every((d) => d.includes('does not generate packets automatically'))).toBe(true);
    expect(descriptions.every((d) => d.includes('summarize context'))).toBe(true);
    expect(descriptions.every((d) => d.includes('select successors'))).toBe(true);
    expect(descriptions.every((d) => d.includes('judge completion'))).toBe(true);
    expect(
      descriptions.every((d) => d.includes('Evidence/State/Progress/Retry/Context Guard')),
    ).toBe(true);
  });

  it('uses namespaces distinct from the other adapters\' namespaces', () => {
    const existingCommands = new Set(['agent-evidence', 'agent-state', 'agent-progress', 'agent-retry']);
    expect(existingCommands.has(COMMAND_NAME)).toBe(false);

    const existingTools = new Set<string>([
      ...EVIDENCE_TOOL_NAMES,
      ...STATE_TOOL_NAMES,
      ...PROGRESS_TOOL_NAMES,
      ...RETRY_TOOL_NAMES,
    ]);
    expect(TOOL_NAMES.every((name) => !existingTools.has(name))).toBe(true);
    expect(TOOL_NAMES.every((name) => name.startsWith('agent_handoff_'))).toBe(true);

    const existingCustomTypes = new Set([
      EVIDENCE_STATE_CUSTOM_TYPE,
      STATE_STATE_CUSTOM_TYPE,
      PROGRESS_STATE_CUSTOM_TYPE,
      RETRY_STATE_CUSTOM_TYPE,
    ]);
    expect(existingCustomTypes.has(STATE_CUSTOM_TYPE)).toBe(false);
    expect(STATE_CUSTOM_TYPE).toBe('agent-handoff-state');
  });

  it('does not register a clear tool', () => {
    const harness = new FakePiHarness();
    expect(harness.tools.has('agent_handoff_clear')).toBe(false);
  });
});

describe('Agent Handoff Pi packet lifecycle', () => {
  it('creates packets via core validation and persists only on change', async () => {
    const harness = new FakePiHarness();

    const created = await harness.executeTool('agent_handoff_create', validPacket('h1', 'engineer'));
    expect(text(created)).toContain('created packet "h1"');
    expect(harness.appendedEntries).toHaveLength(1);
    expect(lastAppended(harness).data).toEqual(payload([validPacket('h1', 'engineer')]));

    const duplicate = await harness.executeTool('agent_handoff_create', validPacket('h1', 'engineer'));
    expect(text(duplicate)).toContain('duplicate packet id "h1"');
    expect(harness.appendedEntries).toHaveLength(1);

    const invalid = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'bad',
      source: 'engineer',
      goal: '',
    });
    expect(text(invalid)).toContain('change rejected as invalid');
    expect(harness.appendedEntries).toHaveLength(1);

    const unknownKey = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'h2',
      source: 'engineer',
      goal: 'g',
      extra: 'nope',
    } as unknown as Record<string, unknown>);
    expect(text(unknownKey)).toContain('change rejected as invalid');
    expect(harness.appendedEntries).toHaveLength(1);

    const evidenceDup = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'h2',
      source: 'engineer',
      goal: 'g',
      evidenceReferences: ['e1', 'e1'],
    });
    expect(text(evidenceDup)).toContain('change rejected as invalid');
    expect(harness.appendedEntries).toHaveLength(1);

    // constraints duplicates allowed (core prose)
    const withDupConstraints = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'h2',
      source: 'engineer',
      goal: 'g',
      constraints: ['same', 'same'],
    });
    expect(text(withDupConstraints)).toContain('created packet "h2"');
    expect(harness.appendedEntries).toHaveLength(2);
  });

  it('removes packets via tool and command with append-on-change', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_handoff_create', validPacket('p1', 'a'));
    await harness.executeTool('agent_handoff_create', validPacket('p2', 'a'));
    expect(harness.appendedEntries).toHaveLength(2);

    const removed = await harness.executeTool('agent_handoff_remove', { id: 'p1' });
    expect(text(removed)).toContain('removed packet "p1"');
    expect(harness.appendedEntries).toHaveLength(3);
    expect((lastAppended(harness).data as { packets: unknown[] }).packets).toHaveLength(1);

    const unknown = await harness.executeTool('agent_handoff_remove', { id: 'missing' });
    expect(text(unknown)).toContain('unknown packet "missing"');
    expect(harness.appendedEntries).toHaveLength(3);

    await harness.command('remove p2');
    expect(harness.appendedEntries).toHaveLength(4);
    expect((lastAppended(harness).data as { packets: unknown[] }).packets).toHaveLength(0);

    await harness.command('remove p2');
    expect(harness.notifications.at(-1)?.message).toContain('unknown packet "p2"');
    expect(harness.appendedEntries).toHaveLength(4);
  });

  it('handles human clear with confirmation and append-on-change', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_handoff_create', validPacket('c1', 's'));
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('clear');
    expect(harness.notifications.at(-1)?.message).toContain('clear would remove 1 packet');
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(2);
    expect((lastAppended(harness).data as { packets: unknown[] }).packets).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain('cleared.');

    await harness.command('clear --yes');
    expect(harness.notifications.at(-1)?.message).toContain('already clear');
    expect(harness.appendedEntries).toHaveLength(2);

    await harness.command('clear');
    expect(harness.notifications.at(-1)?.message).toContain('already clear');
  });

  it('shows status and single packet', async () => {
    const harness = new FakePiHarness();
    await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'show-1',
      source: 'src',
      destination: 'dst',
      goal: 'Goal text',
      constraints: ['c1'],
      openItems: ['o1'],
      evidenceReferences: ['e1'],
    });

    const get = await harness.executeTool('agent_handoff_get', {});
    const getOutput = text(get);
    expect(getOutput).toContain('1 packet');
    expect(getOutput).toContain('show-1');
    expect(getOutput).toContain('  Constraints:\n- c1');
    expect(getOutput).toContain('  Open items:\n- o1');
    expect(getOutput).toContain('  Evidence references:\n- e1');
    expect(getOutput).toContain('Policy: explicit caller-declared');
    expect(getOutput).toContain('Privacy: all packet fields');

    const expectedSummary = [
      'Agent Handoff: 1 packet in the current session.',
      'Packets:',
      '- show-1: src -> dst | goal: Goal text',
      'Policy: explicit caller-declared packets only; no automatic generation, no successor selection, no completion judgment.',
      'Privacy: all packet fields are caller-controlled and may carry sensitive content; scrub before transmission. No automatic redaction.',
    ].join('\n');
    await harness.command('');
    const bareStatus = harness.notifications.at(-1)?.message;
    await harness.command('status');
    const namedStatus = harness.notifications.at(-1)?.message;
    expect(bareStatus).toBe(expectedSummary);
    expect(namedStatus).toBe(expectedSummary);
    await harness.command('show show-1');
    expect(harness.notifications.at(-1)?.message).toContain('Packet: show-1');
    expect(harness.notifications.at(-1)?.message).toContain('Source: src');
    expect(harness.notifications.at(-1)?.message).toContain('Destination: dst');

    await harness.command('show missing');
    expect(harness.notifications.at(-1)?.message).toContain('unknown packet "missing"');

    await harness.command('');
    expect(harness.notifications.at(-1)?.message).toContain('1 packet');
  });

  it('restores from latest valid entry and handles malformed newest entry', async () => {
    const valid = validPacket('restore-1', 'a');
    const malformedBranch = [
      customEntry(payload([valid])),
      customEntry({ schemaVersion: 1, packets: [{ schemaVersion: 1, id: 'bad', source: '', goal: '' }] }),
    ];

    const harness = new FakePiHarness(malformedBranch);
    await harness.start();
    expect(harness.notifications.some((n) => n.message.includes('persisted state was invalid'))).toBe(true);
    expect(text(await harness.executeTool('agent_handoff_get', {}))).toContain('0 packet');

    // older valid not used as fallback — fresh state
    const fresh = new FakePiHarness(malformedBranch);
    // append a new valid after malformed warning should succeed
    await fresh.start();
    const after = await fresh.executeTool('agent_handoff_create', validPacket('new-1', 'a'));
    expect(text(after)).toContain('created packet "new-1"');
    expect(fresh.appendedEntries).toHaveLength(1);

    // valid restore
    const validBranch = [customEntry(payload([validPacket('v1', 's'), validPacket('v2', 's')]))];
    const harness2 = new FakePiHarness(validBranch);
    await harness2.start();
    expect(text(await harness2.executeTool('agent_handoff_get', {}))).toContain('2 packets');
  });

  it('rejects duplicate packet ids on restore as invalid', async () => {
    const dupBranch = [
      customEntry(payload([validPacket('dup', 'a'), validPacket('dup', 'b')])),
    ];
    const harness = new FakePiHarness(dupBranch);
    await harness.start();
    expect(harness.notifications.some((n) => n.message.includes('persisted state was invalid'))).toBe(true);
    expect(text(await harness.executeTool('agent_handoff_get', {}))).toContain('0 packet');
  });

  it('isolates sessions and does not use unrelated custom entries', async () => {
    const harness = new FakePiHarness([customEntry(payload([validPacket('isolated', 'a')]), 'other-type')]);
    await harness.start();
    expect(text(await harness.executeTool('agent_handoff_get', {}))).toContain('0 packet');

    const harness2 = new FakePiHarness([]);
    await harness2.start();
    expect(text(await harness2.executeTool('agent_handoff_get', {}))).toBe(
      [
        'Agent Handoff: 0 packets in the current session.',
        'Packets: none.',
        'Policy: explicit caller-declared packets only; no automatic generation, no successor selection, no completion judgment.',
        'Privacy: all packet fields are caller-controlled and may carry sensitive content; scrub before transmission. No automatic redaction.',
      ].join('\n'),
    );

    // create then simulate resume
    await harness2.executeTool('agent_handoff_create', validPacket('resume-1', 's'));
    const branch = [...harness2.getBranch()];
    const resumed = new FakePiHarness(branch);
    await resumed.start();
    expect(text(await resumed.executeTool('agent_handoff_get', {}))).toContain('1 packet');
    expect(text(await resumed.executeTool('agent_handoff_get', {}))).toContain('resume-1');
  });

  it('validates outer envelope strictly', async () => {
    const wrongVersion = [customEntry({ schemaVersion: 2, packets: [] })];
    const h1 = new FakePiHarness(wrongVersion);
    await h1.start();
    expect(h1.notifications.some((n) => n.message.includes('persisted state was invalid'))).toBe(true);

    const extraKey = [customEntry({ schemaVersion: 1, packets: [], extra: 1 })];
    const h2 = new FakePiHarness(extraKey);
    await h2.start();
    expect(h2.notifications.some((n) => n.message.includes('persisted state was invalid'))).toBe(true);

    const notArray = [customEntry({ schemaVersion: 1, packets: 'nope' })];
    const h3 = new FakePiHarness(notArray);
    await h3.start();
    expect(h3.notifications.some((n) => n.message.includes('persisted state was invalid'))).toBe(true);
  });

  it('delegates packet validation to core createHandoff semantics', async () => {
    const harness = new FakePiHarness();

    // empty goal should be rejected by core (trim check)
    const emptyGoal = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'x',
      source: 's',
      goal: '   ',
    });
    expect(text(emptyGoal)).toContain('change rejected as invalid');

    // spaces preserved but valid
    const spaced = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: ' spaced ',
      source: ' s ',
      goal: ' g ',
    });
    // core preserves original spelling, so id with spaces is valid per isIdentifier (trim length >0)
    expect(text(spaced)).toContain('created packet');

    // unknown top-level key via core
    const withUnknown = await harness.executeTool('agent_handoff_create', {
      schemaVersion: 1,
      id: 'u1',
      source: 's',
      goal: 'g',
      createdAt: 'now',
    } as unknown as Record<string, unknown>);
    expect(text(withUnknown)).toContain('change rejected as invalid');
  });
});

describe('State helpers', () => {
  it('createPacket and removePacket are pure and do not alias', () => {
    const empty: HandoffState = { packets: [] };
    const result = createPacket(empty, validPacket('a', 's'));
    expect(result.changed).toBe(true);
    if (!result.changed) throw new Error('expected changed');
    expect(empty.packets).toHaveLength(0);
    expect(result.state.packets).toHaveLength(1);

    const dup = createPacket(result.state, validPacket('a', 's'));
    expect(dup.changed).toBe(false);
    if (!dup.changed) expect(dup.reason).toBe('duplicate');

    const removed = removePacket(result.state, 'a');
    expect(removed.changed).toBe(true);
    if (!removed.changed) throw new Error('');
    expect(removed.state.packets).toHaveLength(0);
    expect(result.state.packets).toHaveLength(1);

    expect(isFreshState({ packets: [] })).toBe(true);
    expect(isFreshState(result.state)).toBe(false);
  });
});
