import { describe, expect, it } from 'vitest';
import { FakePiHarness } from './harness.js';
import { STATE_CUSTOM_TYPE } from '../src/state.js';
import type { PersistedStateV5 } from '../src/types.js';
import {
  collectDiscoveryAnchors,
  findSupersessionCandidates,
  type CandidateItem,
} from '../src/discovery-candidates.js';
import {
  CANDIDATE_BENCHMARK_CORPUS,
  type CandidateCaseCategory,
} from '../benchmark/candidate-corpus.js';
import {
  CANDIDATE_ANCHOR_CATEGORIES,
  evaluateCandidateBenchmark,
  evaluateCandidateCategory,
} from '../benchmark/candidate-evaluate.js';

const ALL_CATEGORIES = CANDIDATE_ANCHOR_CATEGORIES;

describe('discovery candidate anchors', () => {
  it('extracts accepted paths and rejects fragments without a qualifying extension', () => {
    expect(
      collectDiscoveryAnchors(
        'Use /srv/aurora/archive, packages/context-guard-pi/src/state.ts, and/or 24/7.',
        ['path'],
      ),
    ).toEqual([
      { category: 'path', value: '/srv/aurora/archive' },
      { category: 'path', value: 'packages/context-guard-pi/src/state.ts' },
    ]);
  });

  it('extracts opaque ids but not generic uppercase or digit tokens', () => {
    expect(
      collectDiscoveryAnchors(
        'QSHARD-7731-ZETA!, CACHE-42-OMEGA., INFO, DEBUG, JST, UTC, TLS, HTTP, and 2025-01-02.',
        ['opaque-id'],
      ),
    ).toEqual([
      { category: 'opaque-id', value: 'CACHE-42-OMEGA' },
      { category: 'opaque-id', value: 'QSHARD-7731-ZETA' },
    ]);
  });

  it('extracts versioned subjects, folds only their case, and rejects generic subjects', () => {
    expect(
      collectDiscoveryAnchors(
        'Ledger version 2.3.0.; ledger v2.4.0; Node 24.1.0.; version 9.9.9; status 1.2.3; 42.',
        ['versioned-subject'],
      ),
    ).toEqual([
      { category: 'versioned-subject', value: 'ledger' },
      { category: 'versioned-subject', value: 'node' },
    ]);
  });

  it('strips punctuation and backticks and de-duplicates repeated anchors', () => {
    expect(
      collectDiscoveryAnchors(
        'The path is `/var/lib/novacache/index.db`! It is also /var/lib/novacache/index.db. The marker is `MIGRATE-2048-BETA`.',
        ['path', 'opaque-id'],
      ),
    ).toEqual([
      { category: 'path', value: '/var/lib/novacache/index.db' },
      { category: 'opaque-id', value: 'MIGRATE-2048-BETA' },
    ]);
  });

  it('finds anchors between Japanese characters without whitespace', () => {
    expect(
      collectDiscoveryAnchors(
        '監視対象は/srv/aurora/archiveです。識別子QSHARD-7731-ZETAも確認します。Ledger version 2.3.0は安定版です。',
        ALL_CATEGORIES,
      ),
    ).toEqual([
      { category: 'path', value: '/srv/aurora/archive' },
      { category: 'opaque-id', value: 'QSHARD-7731-ZETA' },
      { category: 'versioned-subject', value: 'ledger' },
    ]);
  });
});

describe('discovery candidate grouping', () => {
  it('groups two items and keeps a three-item group as one candidate', () => {
    const items: readonly CandidateItem[] = [
      { id: 'three-c', content: 'The file is /srv/aurora/archive.' },
      { id: 'three-a', content: 'The file moved to /srv/aurora/archive.' },
      { id: 'three-b', content: 'The file remains at /srv/aurora/archive.' },
    ];
    expect(findSupersessionCandidates(items, ['path'])).toEqual([
      {
        itemIds: ['three-a', 'three-b', 'three-c'],
        anchors: [{ category: 'path', value: '/srv/aurora/archive' }],
      },
    ]);
  });

  it('merges a pair sharing a path and an opaque id', () => {
    expect(
      findSupersessionCandidates(
        [
          { id: 'pair-b', content: 'CACHE-42-OMEGA uses /var/lib/novacache/index.db.' },
          { id: 'pair-a', content: 'CACHE-42-OMEGA reads /var/lib/novacache/index.db.' },
        ],
        ALL_CATEGORIES,
      ),
    ).toEqual([
      {
        itemIds: ['pair-a', 'pair-b'],
        anchors: [
          { category: 'path', value: '/var/lib/novacache/index.db' },
          { category: 'opaque-id', value: 'CACHE-42-OMEGA' },
        ],
      },
    ]);
  });

  it('does not compare an item with itself or emit unrelated, singleton, or empty groups', () => {
    expect(
      findSupersessionCandidates(
        [
          { id: 'same', content: 'The marker is QSHARD-7731-ZETA.' },
          { id: 'same', content: 'The marker is QSHARD-7731-ZETA.' },
          { id: 'other', content: 'The marker is CACHE-42-OMEGA.' },
        ],
        ['opaque-id'],
      ),
    ).toEqual([]);
    expect(
      findSupersessionCandidates(
        [{ id: 'single', content: 'The marker is QSHARD-7731-ZETA.' }],
        ['opaque-id'],
      ),
    ).toEqual([]);
    expect(findSupersessionCandidates([], ALL_CATEGORIES)).toEqual([]);
  });

  it('is deterministic for repeated evaluation and shuffled input', () => {
    const items: readonly CandidateItem[] = [
      { id: 'z', content: 'CACHE-42-OMEGA uses /var/lib/novacache/index.db.' },
      { id: 'x', content: 'CACHE-42-OMEGA reads /var/lib/novacache/index.db.' },
      { id: 'y', content: 'CACHE-42-OMEGA checks /var/lib/novacache/index.db.' },
    ];
    const first = findSupersessionCandidates(items, ALL_CATEGORIES);
    expect(findSupersessionCandidates(items, ALL_CATEGORIES)).toEqual(first);
    expect(
      findSupersessionCandidates([...items].reverse(), [...ALL_CATEGORIES].reverse()),
    ).toEqual(first);
  });
});

describe('candidate benchmark corpus and evaluator', () => {
  it('has the required size, languages, categories, and valid expected ids', () => {
    expect(CANDIDATE_BENCHMARK_CORPUS.length).toBeGreaterThanOrEqual(36);
    expect(new Set(CANDIDATE_BENCHMARK_CORPUS.map(({ id }) => id)).size).toBe(
      CANDIDATE_BENCHMARK_CORPUS.length,
    );
    expect(
      CANDIDATE_BENCHMARK_CORPUS.filter(({ language }) => language === 'ja'),
    ).toHaveLength(20);

    const requiredCategories: readonly CandidateCaseCategory[] = [
      'true-path',
      'true-opaque-id',
      'true-versioned-subject',
      'true-three-way',
      'true-multi-anchor',
      'negative-basename',
      'negative-shared-version',
      'negative-bare-number',
      'negative-log-token',
      'negative-generic-word',
      'negative-route-fragment',
      'negative-similar-prose',
      'ordinary-unrelated',
      'ordinary-single',
      'ordinary-empty',
    ];
    const presentCategories = new Set(
      CANDIDATE_BENCHMARK_CORPUS.map(({ category }) => category),
    );
    for (const category of requiredCategories) {
      expect(presentCategories.has(category)).toBe(true);
    }

    for (const testCase of CANDIDATE_BENCHMARK_CORPUS) {
      const itemIds = new Set(testCase.items.map(({ id }) => id));
      for (const expectedGroup of testCase.expectedGroups) {
        for (const id of expectedGroup) {
          expect(itemIds.has(id)).toBe(true);
        }
      }
    }
  });

  it('reports the combined measurement and exposes each single-category measurement', () => {
    const combined = evaluateCandidateBenchmark();
    expect(combined.categories).toEqual(ALL_CATEGORIES);
    expect(combined.falsePositives).toBe(0);
    expect(combined.highRiskFalsePositives).toBe(0);
    expect(combined.diagnostics).toEqual([]);
    for (const category of ALL_CATEGORIES) {
      expect(evaluateCandidateCategory(category)).toEqual({
        ...evaluateCandidateBenchmark([category]),
      });
      expect(combined.categoryBreakdown[category]).toEqual(
        evaluateCandidateCategory(category).categoryBreakdown[category],
      );
    }
  });
});

describe('discovery candidates command', () => {
  const CACHE_A = 'The artifact cache is stored at /var/lib/novacache/index.db.';
  const CACHE_B = 'The artifact cache moved to /var/lib/novacache/index.db.';
  const CACHE_C = 'Backups read /var/lib/novacache/index.db every night.';
  const SHARD_A = 'Queue shard QSHARD-7731-ZETA is assigned to staging.';
  const SHARD_B = 'Only QSHARD-7731-ZETA is accepted by the staging gateway.';
  const UNRELATED = 'The dispatcher parks a lease after four retries.';

  function discoveryResponse(contents: readonly string[]): unknown {
    return {
      stopReason: 'stop',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            schemaVersion: 1,
            discoveries: contents.map((content) => ({
              kind: 'fact',
              content,
              evidence: [{ id: 'e1', quote: 'evidence line' }],
            })),
          }),
        },
      ],
    };
  }

  /**
   * Captures facts through the real discovery path, so discovery membership and
   * lifecycle status are what the extension itself produced rather than
   * hand-written state.
   */
  async function harnessWithFacts(
    ...contents: readonly string[]
  ): Promise<FakePiHarness> {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('discovery automatic');
    harness.setCompletionResponse(discoveryResponse(contents));
    await harness.startTurn();
    await harness.toolResult('call-1', 'read', [
      { type: 'text', text: 'evidence line' },
    ]);
    await harness.endTurn();
    return harness;
  }

  type CandidateMessage = Parameters<FakePiHarness['setBranch']>[0][number];

  function persistedItem(
    id: string,
    content: string,
    kind: 'fact' | 'constraint' = 'fact',
  ): PersistedStateV5['items'][number] {
    return { id, kind, content, critical: true };
  }

  function candidateStateEntry(data: PersistedStateV5): CandidateMessage {
    return {
      id: 'candidate-state',
      type: 'custom',
      customType: STATE_CUSTOM_TYPE,
      data,
    } as unknown as CandidateMessage;
  }

  async function harnessWithState(
    items: readonly PersistedStateV5['items'][number][],
    discoveryItemIds: readonly string[],
    autoItemIds: readonly string[] = [],
  ): Promise<FakePiHarness> {
    const state: PersistedStateV5 = {
      schemaVersion: 5,
      recovery: 'critical',
      extraction: 'off',
      discovery: 'automatic',
      items: [...items],
      autoItemIds: [...autoItemIds],
      discoveryItemIds: [...discoveryItemIds],
      discoveryProvenance: Object.fromEntries(
        discoveryItemIds.map((id) => [id, []]),
      ),
      discoveryLifecycle: Object.fromEntries(
        discoveryItemIds.map((id) => [
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
      candidateStateEntry(state),
    ] as unknown as readonly CandidateMessage[]);
    await harness.start();
    return harness;
  }

  function lastMessage(harness: FakePiHarness): string {
    return harness.notifyMessages().at(-1) ?? '';
  }

  /** Ids of the listed items whose row contains the given text. */
  async function listedIds(
    harness: FakePiHarness,
    matching: string,
  ): Promise<readonly string[]> {
    await harness.command('list');
    return lastMessage(harness)
      .split('\n')
      .filter((row) => row.includes(matching))
      .map((row) => row.split(' ')[0] ?? '')
      .filter((id) => id.length > 0);
  }

  it('reports two discoveries sharing an anchor as one group', async () => {
    const harness = await harnessWithFacts(CACHE_A, CACHE_B);

    await harness.command('discovery candidates');
    const message = lastMessage(harness);
    expect(message).toContain('1 discovery supersession candidate group.');
    expect(message).toContain('Shared anchors: path /var/lib/novacache/index.db');
    expect(message).toContain(CACHE_A);
    expect(message).toContain(CACHE_B);
    expect(message).toContain('Nothing was changed.');
  });

  it('reports three discoveries sharing one anchor as a single group', async () => {
    const harness = await harnessWithFacts(CACHE_A, CACHE_B, CACHE_C);

    await harness.command('discovery candidates');
    const message = lastMessage(harness);
    expect(message).toContain('1 discovery supersession candidate group.');
    expect(
      message.split('\n').filter((line) => line.startsWith('Shared anchors:')),
    ).toHaveLength(1);
    for (const content of [CACHE_A, CACHE_B, CACHE_C]) {
      expect(message).toContain(content);
    }
  });

  it('reports no candidates when nothing shares an anchor', async () => {
    const harness = await harnessWithFacts(CACHE_A, UNRELATED);

    await harness.command('discovery candidates');
    expect(lastMessage(harness)).toBe(
      'Context Guard: no discovery supersession candidates.',
    );
  });

  it('excludes a retired discovery', async () => {
    const harness = await harnessWithFacts(SHARD_A, SHARD_B);
    const [first] = await listedIds(harness, 'QSHARD-7731-ZETA');

    await harness.command(`discovery retire ${first ?? ''}`);
    await harness.command('discovery candidates');

    expect(lastMessage(harness)).toBe(
      'Context Guard: no discovery supersession candidates.',
    );
  });

  it('excludes a superseded discovery', async () => {
    const harness = await harnessWithFacts(SHARD_A, SHARD_B, UNRELATED);
    const [first] = await listedIds(harness, 'QSHARD-7731-ZETA');
    const [unrelated] = await listedIds(harness, 'dispatcher');

    await harness.command(
      `discovery supersede ${first ?? ''} ${unrelated ?? ''}`,
    );
    await harness.command('discovery candidates');

    expect(lastMessage(harness)).toBe(
      'Context Guard: no discovery supersession candidates.',
    );
  });

  it('excludes a manual item sharing an anchor with a discovery', async () => {
    const harness = await harnessWithFacts(CACHE_A);
    await harness.command(`add manual-cache fact ${CACHE_B}`);

    await harness.command('discovery candidates');
    expect(lastMessage(harness)).toBe(
      'Context Guard: no discovery supersession candidates.',
    );
  });

  it('excludes a removed discovery', async () => {
    const harness = await harnessWithFacts(CACHE_A, CACHE_B);
    const [first] = await listedIds(harness, 'novacache');

    await harness.command(`remove ${first ?? ''}`);
    await harness.command('discovery candidates');

    expect(lastMessage(harness)).toBe(
      'Context Guard: no discovery supersession candidates.',
    );
  });

  it('changes nothing when it runs', async () => {
    const harness = await harnessWithFacts(CACHE_A, CACHE_B);
    await harness.command('list');
    const listBefore = lastMessage(harness);
    await harness.command('status');
    const statusBefore = lastMessage(harness);
    const entriesBefore = harness.appendedEntries.length;

    await harness.command('discovery candidates');

    expect(harness.appendedEntries).toHaveLength(entriesBefore);
    await harness.command('list');
    expect(lastMessage(harness)).toBe(listBefore);
    await harness.command('status');
    expect(lastMessage(harness)).toBe(statusBefore);
  });

  it('rejects extra arguments without changing anything', async () => {
    const harness = await harnessWithFacts(CACHE_A, CACHE_B);
    const entriesBefore = harness.appendedEntries.length;

    await harness.command('discovery candidates extra');

    expect(lastMessage(harness)).toBe(
      'Usage: /context-guard discovery candidates',
    );
    expect(harness.appendedEntries).toHaveLength(entriesBefore);
  });

  it('keeps supersede working after the subcommand was added', async () => {
    const harness = await harnessWithFacts(SHARD_A, SHARD_B);
    const [first, second] = await listedIds(harness, 'QSHARD-7731-ZETA');

    await harness.command(
      `discovery supersede ${first ?? ''} ${second ?? ''}`,
    );

    expect(lastMessage(harness)).toBe(
      `Context Guard: discovery '${first ?? ''}' superseded by '${second ?? ''}'.`,
    );
  });

  it('lists both anchors once for a pair sharing two anchors', async () => {
    const first =
      'Cache marker CACHE-42-OMEGA is stored at /var/lib/novacache/index.db.';
    const second =
      'Cache marker CACHE-42-OMEGA was moved to /var/lib/novacache/index.db.';
    const harness = await harnessWithFacts(first, second);

    await harness.command('discovery candidates');
    const message = lastMessage(harness);

    expect(
      message.split('\n').filter((line) => line.startsWith('Shared anchors:')),
    ).toEqual([
      'Shared anchors: path /var/lib/novacache/index.db, opaque-id CACHE-42-OMEGA',
    ]);
  });

  it('excludes an extracted automatic item sharing an anchor', async () => {
    const harness = await harnessWithState(
      [
        persistedItem('discovery-one', SHARD_A),
        persistedItem('auto-one', SHARD_B, 'constraint'),
      ],
      ['discovery-one'],
      ['auto-one'],
    );

    await harness.command('discovery candidates');

    expect(lastMessage(harness)).toBe(
      'Context Guard: no discovery supersession candidates.',
    );
  });

  it('bounds output to ten groups and reports the total', async () => {
    const items: PersistedStateV5['items'][number][] = [];
    const discoveryItemIds: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const serial = String(index + 1).padStart(2, '0');
      const anchor = `SHARD-${1000 + index}-NODE`;
      const firstId = `candidate-${serial}-a`;
      const secondId = `candidate-${serial}-b`;
      items.push(
        persistedItem(firstId, `Shard ${anchor} is assigned.`),
        persistedItem(secondId, `Shard ${anchor} is accepted.`),
      );
      discoveryItemIds.push(firstId, secondId);
    }
    const harness = await harnessWithState(items, discoveryItemIds);

    await harness.command('discovery candidates');
    const message = lastMessage(harness);

    expect(message).toContain(
      'Context Guard: 11 discovery supersession candidate groups.',
    );
    expect(message).toContain('Showing 10 of 11 candidate groups.');
    expect(
      message.split('\n').filter((line) => line.startsWith('Shared anchors:')),
    ).toHaveLength(10);
    expect(message).not.toContain('SHARD-1010-NODE');
  });
});
