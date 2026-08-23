import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakePiHarness } from './harness.js';
import { STATE_CUSTOM_TYPE } from '../src/state.js';
import { createDiscoveryLifecycle } from '../src/discovery-lifecycle.js';
import type {
  DiscoveryProvenance,
  DiscoveryLifecycle,
  PersistedState,
  PersistedStateV1,
  PersistedStateV2,
  PersistedStateV3,
  PersistedStateV4,
  PersistedStateV5,
} from '../src/types.js';

type CandidateMessage = Parameters<FakePiHarness['setBranch']>[0][number];

function quoteHash(quote: string): string {
  return createHash('sha256').update(quote).digest('hex').slice(0, 12);
}

function item(
  id: string,
  content: string,
  critical = true,
): { id: string; kind: 'fact'; content: string; critical: boolean } {
  return { id, kind: 'fact', content, critical };
}

function provenanceFor(quote: string): DiscoveryProvenance {
  return {
    toolCallId: 'call-1',
    toolName: 'read',
    quoteHash: quoteHash(quote),
    span: { startOffset: 0, endOffset: quote.length },
  };
}

function stateEntry(data: unknown): unknown {
  return {
    id: 'entry-state',
    type: 'custom',
    customType: STATE_CUSTOM_TYPE,
    data,
  };
}

function latestState(harness: FakePiHarness): PersistedState {
  const entry = harness.appendedEntries.at(-1);
  expect(entry?.customType).toBe(STATE_CUSTOM_TYPE);
  return entry?.data as PersistedState;
}

function textMessage(text: string): unknown {
  return { role: 'user', content: text, timestamp: 1 };
}

function compactEvent(id: string): unknown {
  return {
    type: 'session_compact',
    compactionEntry: { id, summary: '', firstKeptEntryId: 'entry-1' },
  };
}

/**
 * Drives one compaction cycle whose post-compaction context contains none of
 * the protected content, so every critical item is a critical failure and the
 * only thing deciding recovery is the lifecycle policy.
 */
async function compactWithNothingPreserved(
  harness: FakePiHarness,
  id: string,
): Promise<unknown> {
  await harness.invoke('session_before_compact');
  await harness.invoke('session_compact', compactEvent(id));
  return await harness.invoke(
    'context',
    { type: 'context', messages: [textMessage('unrelated summary text')] },
  );
}

function recoveryContent(result: unknown): string | undefined {
  const messages = (result as { messages?: readonly unknown[] } | undefined)
    ?.messages;
  const recovery = messages?.find(
    (message) =>
      (message as { customType?: string }).customType ===
      'agent-context-guard-recovery',
  ) as { content?: string } | undefined;
  return recovery?.content;
}

/** A v5 session holding one discovery and one manual item. */
function v5State(
  discoveryStatusValue: 'active' | 'superseded' | 'retired' = 'active',
  supersededBy?: string,
): PersistedStateV5 {
  const quote = 'Cache driver is redis.';
  return {
    schemaVersion: 5,
    recovery: 'critical',
    extraction: 'off',
    discovery: 'automatic',
    items: [
      item('discovery-old', quote),
      item('manual-one', 'Keep the public API stable.'),
    ] as PersistedStateV5['items'],
    autoItemIds: [],
    discoveryItemIds: ['discovery-old'],
    discoveryProvenance: { 'discovery-old': [provenanceFor(quote)] },
    discoveryLifecycle: {
      'discovery-old':
        supersededBy === undefined
          ? {
              status: discoveryStatusValue,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
            }
          : {
              status: discoveryStatusValue,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
              supersededBy,
            },
    },
  };
}

/**
 * Rewrites the lifecycle timestamps of the single discovery in a v5 fixture.
 * The contract is a non-empty string, so an empty one has to be rejected as a
 * malformed record rather than treated as an unknown time.
 */
function withLifecycleTimestamps(
  data: PersistedStateV5,
  createdAt: string,
  updatedAt: string,
): PersistedStateV5 {
  const record = data.discoveryLifecycle['discovery-old'];
  if (record === undefined) {
    throw new Error('The fixture must hold a discovery-old lifecycle record.');
  }
  return {
    ...data,
    discoveryLifecycle: {
      'discovery-old': { ...record, createdAt, updatedAt },
    },
  };
}

async function harnessWithDiscoveries(
  ...ids: readonly string[]
): Promise<FakePiHarness> {
  const state: PersistedStateV5 = {
    schemaVersion: 5,
    recovery: 'critical',
    extraction: 'off',
    discovery: 'automatic',
    items: [
      ...ids.map((id) => item(id, `Fact for ${id}.`)),
      item('manual-one', 'Keep the public API stable.'),
    ] as PersistedStateV5['items'],
    autoItemIds: [],
    discoveryItemIds: ids,
    discoveryProvenance: Object.fromEntries(
      ids.map((id) => [id, [provenanceFor(`Fact for ${id}.`)]]),
    ),
    discoveryLifecycle: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          status: 'active' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    ),
  };
  const harness = new FakePiHarness([
    stateEntry(state),
  ] as unknown as readonly CandidateMessage[]);
  await harness.start();
  return harness;
}

describe('discovery lifecycle migration', () => {
  it('loads a v5 discovery with its persisted status', async () => {
    const harness = new FakePiHarness([
      stateEntry(v5State('retired')),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('[discovery retired]');
  });

  it('loads a v4 discovery as active and keeps its provenance', async () => {
    const quote = 'Cache driver is redis.';
    const v4: PersistedStateV4 = {
      schemaVersion: 4,
      recovery: 'critical',
      extraction: 'off',
      discovery: 'automatic',
      items: [item('discovery-old', quote)] as PersistedStateV4['items'],
      autoItemIds: [],
      discoveryItemIds: ['discovery-old'],
      discoveryProvenance: { 'discovery-old': [provenanceFor(quote)] },
    };
    const harness = new FakePiHarness([
      stateEntry(v4),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('[discovery active]');

    // Any persisting mutation rewrites the entry at the current schema.
    await harness.command('recovery off');
    const saved = latestState(harness);
    expect(saved.schemaVersion).toBe(5);
    expect(saved.discoveryProvenance['discovery-old']).toEqual([
      provenanceFor(quote),
    ]);
    expect(saved.discoveryLifecycle['discovery-old']?.status).toBe('active');
  });

  it.each([
    [
      'v1',
      {
        schemaVersion: 1,
        recovery: 'critical',
        items: [item('manual-one', 'Keep the public API stable.')],
      } as unknown as PersistedStateV1,
    ],
    [
      'v2',
      {
        schemaVersion: 2,
        recovery: 'critical',
        extraction: 'automatic',
        items: [item('manual-one', 'Keep the public API stable.')],
        autoItemIds: [],
      } as unknown as PersistedStateV2,
    ],
    [
      'v3',
      {
        schemaVersion: 3,
        recovery: 'critical',
        extraction: 'off',
        discovery: 'automatic',
        items: [item('discovery-old', 'Cache driver is redis.')],
        autoItemIds: [],
        discoveryItemIds: ['discovery-old'],
        discoveryProvenance: {
          'discovery-old': [
            {
              toolCallId: 'call-1',
              toolName: 'read',
              quoteHash: quoteHash('Cache driver is redis.'),
            },
          ],
        },
      } as unknown as PersistedStateV3,
    ],
  ])('migrates %s without discarding state', async (_name, data) => {
    const harness = new FakePiHarness([
      stateEntry(data),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    expect(harness.notifyMessages().join('\n')).not.toContain('degraded');
    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain('degraded no');
  });
});

describe('discovery lifecycle recovery', () => {
  it('recovers an active discovery', async () => {
    const harness = new FakePiHarness([
      stateEntry(v5State('active')),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    const content = recoveryContent(
      await compactWithNothingPreserved(harness, 'cycle-active'),
    );
    expect(content).toContain('Cache driver is redis.');
    expect(content).toContain('Keep the public API stable.');
  });

  it.each(['superseded', 'retired'] as const)(
    'does not recover a %s discovery but still recovers the manual item',
    async (status) => {
      const harness = new FakePiHarness([
        stateEntry(
          status === 'superseded'
            ? v5State('superseded', 'discovery-new')
            : v5State('retired'),
        ),
      ] as unknown as readonly CandidateMessage[]);
      await harness.start();

      const content = recoveryContent(
        await compactWithNothingPreserved(harness, `cycle-${status}`),
      );
      expect(content).not.toContain('Cache driver is redis.');
      expect(content).toContain('Keep the public API stable.');
    },
  );

  it('still reports an inactive discovery as a verification failure', async () => {
    const harness = new FakePiHarness([
      stateEntry(v5State('retired')),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    await compactWithNothingPreserved(harness, 'cycle-report');
    const verification = harness
      .notifyMessages()
      .filter((message) => /\d+ preserved, \d+ lost,/.test(message));
    expect(verification.at(-1)).toContain('2 lost');
  });
});

describe('discovery lifecycle commands', () => {
  it('retires a discovery and persists the change', async () => {
    const harness = await harnessWithDiscoveries('discovery-a');

    await harness.command('discovery retire discovery-a');
    expect(harness.notifyMessages().at(-1)).toBe(
      "Context Guard: retired discovery 'discovery-a'.",
    );

    const saved = latestState(harness);
    expect(saved.discoveryLifecycle['discovery-a']?.status).toBe('retired');
    expect(saved.discoveryLifecycle['discovery-a']?.createdAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('supersedes one discovery with another', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');

    await harness.command('discovery supersede discovery-a discovery-b');
    expect(harness.notifyMessages().at(-1)).toBe(
      "Context Guard: discovery 'discovery-a' superseded by 'discovery-b'.",
    );

    const saved = latestState(harness);
    expect(saved.discoveryLifecycle['discovery-a']).toMatchObject({
      status: 'superseded',
      supersededBy: 'discovery-b',
    });
    expect(saved.discoveryLifecycle['discovery-b']?.status).toBe('active');
  });

  it('keeps the mode subcommand working alongside the lifecycle operations', async () => {
    const harness = await harnessWithDiscoveries('discovery-a');

    await harness.command('discovery off');
    expect(harness.notifyMessages().at(-1)).toBe(
      "Context Guard: discovery set to 'off'.",
    );
  });

  it('reports lifecycle counts in status', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await harness.command('discovery retire discovery-a');

    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain(
      '1 active, 0 superseded, 1 retired',
    );
  });

  it('survives a session resume', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await harness.command('discovery supersede discovery-a discovery-b');

    const resumed = new FakePiHarness(harness.getBranch());
    await resumed.start();
    await resumed.command('list');
    const list = resumed.notifyMessages().at(-1) ?? '';
    expect(list).toContain('[discovery superseded]');
    expect(list).toContain('[discovery active]');

    const content = recoveryContent(
      await compactWithNothingPreserved(resumed, 'cycle-resumed'),
    );
    expect(content).not.toContain('Fact for discovery-a.');
    expect(content).toContain('Fact for discovery-b.');
  });
});

describe('discovery lifecycle safety', () => {
  async function expectRejected(
    command: string,
    message: string,
  ): Promise<void> {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    const beforeLifecycle = lifecycleRecords(harness);
    const before = harness.appendedEntries.length;

    await harness.command(command);

    expect(harness.notifyMessages().at(-1)).toBe(message);
    expect(harness.appendedEntries).toHaveLength(before);
    expect(lifecycleRecords(harness)).toEqual(beforeLifecycle);
  }

  it('rejects an unknown id without mutating state', async () => {
    await expectRejected(
      'discovery retire nope',
      "Context Guard: item 'nope' was not found.",
    );
  });

  it('refuses to retire a manual item', async () => {
    await expectRejected(
      'discovery retire manual-one',
      "Context Guard: item 'manual-one' is not a discovery; only discoveries have a lifecycle.",
    );
  });

  it('refuses to supersede a manual item', async () => {
    await expectRejected(
      'discovery supersede manual-one discovery-b',
      "Context Guard: item 'manual-one' is not a discovery; only discoveries have a lifecycle.",
    );
  });

  it('refuses an unknown supersede target', async () => {
    await expectRejected(
      'discovery supersede discovery-a nope',
      "Context Guard: item 'nope' was not found.",
    );
  });

  it('refuses to supersede a discovery with itself', async () => {
    await expectRejected(
      'discovery supersede discovery-a discovery-a',
      'Context Guard: a discovery cannot supersede itself.',
    );
  });

  it('refuses to retire the same discovery twice', async () => {
    const harness = await harnessWithDiscoveries('discovery-a');
    await harness.command('discovery retire discovery-a');
    const beforeLifecycle = lifecycleRecords(harness);
    const before = harness.appendedEntries.length;

    await harness.command('discovery retire discovery-a');

    expect(harness.notifyMessages().at(-1)).toBe(
      "Context Guard: discovery 'discovery-a' is already retired.",
    );
    expect(harness.appendedEntries).toHaveLength(before);
    expect(lifecycleRecords(harness)).toEqual(beforeLifecycle);
  });

  it('refuses to supersede with an inactive discovery', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await harness.command('discovery retire discovery-b');
    const beforeLifecycle = lifecycleRecords(harness);
    const before = harness.appendedEntries.length;

    await harness.command('discovery supersede discovery-a discovery-b');

    expect(harness.notifyMessages().at(-1)).toBe(
      "Context Guard: discovery 'discovery-b' is not active and cannot supersede another.",
    );
    expect(harness.appendedEntries).toHaveLength(before);
    expect(lifecycleRecords(harness)).toEqual(beforeLifecycle);
  });

  it('shows usage when an id is missing', async () => {
    const harness = await harnessWithDiscoveries('discovery-a');
    const before = harness.appendedEntries.length;

    await harness.command('discovery retire');

    expect(harness.notifyMessages().at(-1)).toBe(
      'Usage: /context-guard discovery retire <id>',
    );
    expect(harness.appendedEntries).toHaveLength(before);
  });
});

function lifecycleRecord(
  harness: FakePiHarness,
  id: string,
): DiscoveryLifecycle {
  const record = latestState(harness).discoveryLifecycle[id];
  if (record === undefined) {
    throw new Error(`Missing lifecycle record for '${id}'.`);
  }
  return record;
}

function lifecycleRecords(
  harness: FakePiHarness,
): Readonly<Record<string, DiscoveryLifecycle>> {
  return latestState(harness).discoveryLifecycle;
}

async function persistForInspection(harness: FakePiHarness): Promise<void> {
  await harness.command('recovery off');
}

async function expectLifecycleRejection(
  harness: FakePiHarness,
  command: string,
  message: string,
): Promise<void> {
  const before = lifecycleRecords(harness);
  const appendedEntries = harness.appendedEntries.length;

  await harness.command(command);

  expect(harness.notifyMessages().at(-1)).toBe(message);
  expect(harness.appendedEntries).toHaveLength(appendedEntries);
  expect(lifecycleRecords(harness)).toEqual(before);
}

describe('discovery lifecycle transition matrix', () => {
  it('allows active to retire', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    const before = lifecycleRecord(harness, 'discovery-a');
    const appendedEntries = harness.appendedEntries.length;

    await harness.command('discovery retire discovery-a');

    const after = lifecycleRecord(harness, 'discovery-a');
    expect(harness.notifyMessages().at(-1)).toBe(
      'Context Guard: retired discovery \'discovery-a\'.',
    );
    expect(after.status).toBe('retired');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.updatedAt >= after.createdAt).toBe(true);
    expect(harness.appendedEntries).toHaveLength(appendedEntries + 1);
  });

  it('allows active to supersede an active target', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    const before = lifecycleRecord(harness, 'discovery-a');
    const appendedEntries = harness.appendedEntries.length;

    await harness.command('discovery supersede discovery-a discovery-b');

    const after = lifecycleRecord(harness, 'discovery-a');
    expect(harness.notifyMessages().at(-1)).toBe(
      'Context Guard: discovery \'discovery-a\' superseded by \'discovery-b\'.',
    );
    expect(after.status).toBe('superseded');
    expect(after.supersededBy).toBe('discovery-b');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.updatedAt >= after.createdAt).toBe(true);
    expect(lifecycleRecord(harness, 'discovery-b').status).toBe('active');
    expect(harness.appendedEntries).toHaveLength(appendedEntries + 1);
  });

  it('rejects retiring a retired discovery', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery retire discovery-a');

    await expectLifecycleRejection(
      harness,
      'discovery retire discovery-a',
      'Context Guard: discovery \'discovery-a\' is already retired.',
    );
  });

  it('rejects superseding a retired discovery', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery retire discovery-a');

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a discovery-b',
      'Context Guard: discovery \'discovery-a\' is already retired.',
    );
  });

  it('rejects retiring a superseded discovery', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery supersede discovery-a discovery-b');

    await expectLifecycleRejection(
      harness,
      'discovery retire discovery-a',
      'Context Guard: discovery \'discovery-a\' is already superseded.',
    );
  });

  it('rejects superseding a superseded discovery', async () => {
    const harness = await harnessWithDiscoveries(
      'discovery-a',
      'discovery-b',
      'discovery-c',
    );
    await persistForInspection(harness);
    await harness.command('discovery supersede discovery-a discovery-b');

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a discovery-c',
      'Context Guard: discovery \'discovery-a\' is already superseded.',
    );
  });

  it('rejects retiring a superseded discovery without losing its replacement link', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery supersede discovery-a discovery-b');
    const before = lifecycleRecord(harness, 'discovery-a');
    const appendedEntries = harness.appendedEntries.length;

    await harness.command('discovery retire discovery-a');

    const after = lifecycleRecord(harness, 'discovery-a');
    expect(harness.notifyMessages().at(-1)).toBe(
      'Context Guard: discovery \'discovery-a\' is already superseded.',
    );
    expect(after.status).toBe(before.status);
    expect(after.supersededBy).toBe('discovery-b');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(harness.appendedEntries).toHaveLength(appendedEntries);
  });
});

describe('discovery lifecycle target validation', () => {
  it('rejects a retired target without changing the active subject', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery retire discovery-b');

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a discovery-b',
      'Context Guard: discovery \'discovery-b\' is not active and cannot supersede another.',
    );
  });

  it('rejects a superseded target without changing the active subject', async () => {
    const harness = await harnessWithDiscoveries(
      'discovery-a',
      'discovery-b',
      'discovery-c',
    );
    await persistForInspection(harness);
    await harness.command('discovery supersede discovery-b discovery-c');

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a discovery-b',
      'Context Guard: discovery \'discovery-b\' is not active and cannot supersede another.',
    );
  });

  it('rejects an unknown target without changing the active subject', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a nope',
      'Context Guard: item \'nope\' was not found.',
    );
  });

  it('rejects a discovery superseding itself without changing state', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a discovery-a',
      'Context Guard: a discovery cannot supersede itself.',
    );
  });

  it('validates an inactive subject before validating its replacement', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery retire discovery-a');

    await expectLifecycleRejection(
      harness,
      'discovery supersede discovery-a nope',
      'Context Guard: discovery \'discovery-a\' is already retired.',
    );
  });
});

describe('discovery lifecycle persisted invariants', () => {
  it.each([
    ['active', v5State('active')],
    ['retired', v5State('retired')],
    ['superseded', v5State('superseded', 'discovery-new')],
  ] as const)('loads a valid %s lifecycle record', async (_name, data) => {
    const harness = new FakePiHarness([
      stateEntry(data),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    expect(harness.notifyMessages().join('\n')).not.toContain('discarded');
    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain('2 items');
    expect(harness.notifyMessages().at(-1)).toContain('degraded no');
  });

  it.each([
    ['active with supersededBy', v5State('active', 'discovery-new')],
    ['retired with supersededBy', v5State('retired', 'discovery-new')],
    ['superseded without supersededBy', v5State('superseded')],
    ['superseded with an empty supersededBy', v5State('superseded', '')],
    [
      'superseded with its own key',
      v5State('superseded', 'discovery-old'),
    ],
    [
      'an empty createdAt',
      withLifecycleTimestamps(v5State('active'), '', '2026-01-02T00:00:00.000Z'),
    ],
    [
      'an empty updatedAt',
      withLifecycleTimestamps(v5State('active'), '2026-01-01T00:00:00.000Z', ''),
    ],
  ] as const)('discards %s and does not fall back', async (_name, data) => {
    const harness = new FakePiHarness([
      stateEntry(v5State('active')),
      stateEntry(data),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.type).toBe('warning');
    expect(harness.notifyMessages()[0]).toContain('discarded');
    expect(harness.appendedEntries).toHaveLength(0);

    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toBe(
      'Context Guard: no protected items.',
    );
    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain('0 items');
    expect(harness.notifyMessages().at(-1)).toContain('degraded yes');
  });
});

describe('discovery lifecycle migration and timestamps', () => {
  it('migrates a v3 discovery as active with provenance and saves schema 5', async () => {
    const quote = 'Cache driver is redis.';
    const v3: PersistedStateV3 = {
      schemaVersion: 3,
      recovery: 'critical',
      extraction: 'off',
      discovery: 'automatic',
      items: [item('discovery-old', quote)] as PersistedStateV3['items'],
      autoItemIds: [],
      discoveryItemIds: ['discovery-old'],
      discoveryProvenance: {
        'discovery-old': [
          {
            toolCallId: 'call-1',
            toolName: 'read',
            quoteHash: quoteHash(quote),
          },
        ],
      },
    };
    const harness = new FakePiHarness([
      stateEntry(v3),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();

    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('[discovery active]');
    await harness.command('recovery off');
    const saved = latestState(harness);
    expect(saved.schemaVersion).toBe(5);
    expect(saved.discoveryProvenance['discovery-old']).toEqual([
      v3.discoveryProvenance['discovery-old']?.[0],
    ]);
    expect(saved.discoveryLifecycle['discovery-old']).toMatchObject({
      status: 'active',
    });
    expect(saved.discoveryLifecycle['discovery-old']?.createdAt).toBe(
      saved.discoveryLifecycle['discovery-old']?.updatedAt,
    );
  });

  it('creates a new lifecycle record with matching timestamps', () => {
    const lifecycle = createDiscoveryLifecycle();

    expect(lifecycle.createdAt).toBe(lifecycle.updatedAt);
  });

  it('preserves lifecycle records, links, and timestamps on resume', async () => {
    const harness = await harnessWithDiscoveries('discovery-a', 'discovery-b');
    await persistForInspection(harness);
    await harness.command('discovery supersede discovery-a discovery-b');
    const before = lifecycleRecords(harness);

    const resumed = new FakePiHarness(harness.getBranch());
    await resumed.start();
    await resumed.command('discovery off');

    expect(lifecycleRecords(resumed)).toEqual(before);
  });
});

describe('discovery lifecycle recovery policy', () => {
  it('recovers active items in a mixed lifecycle without recovering inactive discoveries', async () => {
    const harness = await harnessWithDiscoveries(
      'discovery-retired',
      'discovery-superseded',
      'discovery-active',
    );
    await harness.command('discovery retire discovery-retired');
    await harness.command(
      'discovery supersede discovery-superseded discovery-active',
    );

    const content = recoveryContent(
      await compactWithNothingPreserved(harness, 'cycle-mixed'),
    );
    expect(content).not.toContain('Fact for discovery-retired.');
    expect(content).not.toContain('Fact for discovery-superseded.');
    expect(content).toContain('Fact for discovery-active.');
    expect(content).toContain('Keep the public API stable.');
    expect(harness.notifyMessages().at(-1)).toContain('4 lost');
  });
});
