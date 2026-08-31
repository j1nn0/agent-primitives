import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  arbitrateInterventions,
  validateSupervisorInterventionProposal,
} from '../src/index.js';
import type {
  EffectiveFeatureMode,
  SupervisorArbitrationResult,
  SupervisorInterventionIntent,
  SupervisorInterventionProposal,
} from '../src/index.js';

function proposal(
  sourceFeatureId: string,
  intent: SupervisorInterventionIntent,
  priority = 1,
  overrides: Record<string, unknown> = {},
): SupervisorInterventionProposal {
  return validateSupervisorInterventionProposal({
    sourceFeatureId,
    boundary: 'stream',
    intent,
    delivery: 'steer',
    priority,
    reasonCode: `${sourceFeatureId}:reason`,
    ...overrides,
  });
}

function arbitrate(
  proposals: readonly SupervisorInterventionProposal[],
  featureModes: Readonly<Record<string, EffectiveFeatureMode>>,
): readonly SupervisorArbitrationResult[] {
  return arbitrateInterventions({ proposals, featureModes });
}

describe('supervisor intervention arbitration', () => {
  it.each([
    ['stop', 'handoff'],
    ['handoff', 'change-strategy'],
    ['change-strategy', 'verify'],
    ['verify', 'continue'],
  ] as const)('ranks %s above %s', (higher, lower) => {
    const results = arbitrate(
      [proposal('feature-a', lower), proposal('feature-b', higher)],
      { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
    );
    expect(results[0]?.winner?.intent).toBe(higher);
  });

  it('lets intent rank dominate numeric priority', () => {
    const results = arbitrate(
      [proposal('feature-a', 'continue', 100), proposal('feature-b', 'stop', 1)],
      { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
    );
    expect(results[0]?.winner?.intent).toBe('stop');
  });

  it('uses higher priority for the same intent', () => {
    const results = arbitrate(
      [proposal('feature-a', 'verify', 1), proposal('feature-b', 'verify', 9)],
      { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
    );
    expect(results[0]?.winner?.sourceFeatureId).toBe('feature-b');
  });

  it('uses source ID and then reason code for a full tie', () => {
    const results = arbitrate(
      [
        proposal('feature-b', 'verify', 5, { reasonCode: 'feature-b:a' }),
        proposal('feature-a', 'verify', 5, { reasonCode: 'feature-a:z' }),
        proposal('feature-a', 'verify', 5, { reasonCode: 'feature-a:a' }),
      ],
      { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
    );
    expect(results[0]?.winner).toMatchObject({
      sourceFeatureId: 'feature-a',
      reasonCode: 'feature-a:a',
    });
    expect(results[0]?.suppressed.map((item) => item.reasonCode)).toEqual([
      'feature-a:z',
      'feature-b:a',
    ]);
  });

  it('keeps observe-mode proposals in shadow evaluation', () => {
    const results = arbitrate(
      [proposal('feature-a', 'stop', 100), proposal('feature-b', 'continue', 1)],
      { 'feature-a': 'observe', 'feature-b': 'autonomous' },
    );
    expect(results[0]?.winner?.sourceFeatureId).toBe('feature-b');
    expect(results[0]?.observedOnly.map((item) => item.sourceFeatureId)).toEqual(['feature-a']);
    expect(results[0]?.suppressed).toEqual([]);
  });

  it('keeps off, unavailable, and unknown sources ineligible', () => {
    const results = arbitrate(
      [
        proposal('feature-a', 'stop', 3),
        proposal('feature-b', 'handoff', 2),
        proposal('feature-c', 'continue', 1),
      ],
      { 'feature-a': 'off', 'feature-b': 'unavailable' },
    );
    expect(results[0]?.winner).toBeUndefined();
    expect(results[0]?.ineligible.map((item) => item.sourceFeatureId)).toEqual([
      'feature-a',
      'feature-b',
      'feature-c',
    ]);
  });

  it('isolates boundaries into separate groups', () => {
    const results = arbitrate(
      [
        proposal('feature-a', 'stop', 10, {
          boundary: 'tool-call',
          targetToolCallId: 'call-a',
        }),
        proposal('feature-b', 'continue', 1, { boundary: 'settled' }),
      ],
      { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
    );
    expect(results.map((result) => [result.boundary, result.targetToolCallId])).toEqual([
      ['tool-call', 'call-a'],
      ['settled', null],
    ]);
    expect(results[0]?.winner?.sourceFeatureId).toBe('feature-a');
    expect(results[1]?.winner?.sourceFeatureId).toBe('feature-b');
  });

  it('isolates tool-call targets and elects one winner per target', () => {
    const results = arbitrate(
      [
        proposal('feature-b', 'stop', 1, {
          boundary: 'tool-call',
          targetToolCallId: 'call-b',
        }),
        proposal('feature-a', 'handoff', 1, {
          boundary: 'tool-call',
          targetToolCallId: 'call-a',
        }),
      ],
      { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
    );
    expect(results.map((result) => result.targetToolCallId)).toEqual(['call-a', 'call-b']);
    expect(results.map((result) => result.winner?.sourceFeatureId)).toEqual([
      'feature-a',
      'feature-b',
    ]);
  });

  it('is unchanged when the input proposal order is shuffled', () => {
    const proposals = [
      proposal('feature-a', 'verify', 4),
      proposal('feature-b', 'stop', 1),
      proposal('feature-c', 'continue', 8, {
        boundary: 'tool-call',
        targetToolCallId: 'call-b',
      }),
      proposal('feature-d', 'handoff', 2, {
        boundary: 'tool-call',
        targetToolCallId: 'call-a',
      }),
      proposal('feature-e', 'stop', 7, { boundary: 'settled' }),
    ];
    const featureModes = {
      'feature-a': 'observe',
      'feature-b': 'autonomous',
      'feature-c': 'autonomous',
      'feature-d': 'autonomous',
      'feature-e': 'unavailable',
    } satisfies Readonly<Record<string, EffectiveFeatureMode>>;
    const permutations = [
      proposals,
      [proposals[4]!, proposals[2]!, proposals[0]!, proposals[3]!, proposals[1]!],
      [proposals[1]!, proposals[3]!, proposals[4]!, proposals[0]!, proposals[2]!],
    ];
    const results = permutations.map((permutation) => arbitrate(permutation, featureModes));

    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it.each([
    [
      'tool-call proposal without target',
      {
        sourceFeatureId: 'feature-a',
        boundary: 'tool-call',
        intent: 'verify',
        delivery: 'steer',
        priority: 1,
        reasonCode: 'feature-a:reason',
      },
    ],
    [
      'tool-call proposal with an empty target',
      {
        sourceFeatureId: 'feature-a',
        boundary: 'tool-call',
        intent: 'verify',
        delivery: 'steer',
        priority: 1,
        reasonCode: 'feature-a:reason',
        targetToolCallId: '',
      },
    ],
    [
      'non-tool-call proposal with a target',
      {
        sourceFeatureId: 'feature-a',
        boundary: 'stream',
        intent: 'verify',
        delivery: 'steer',
        priority: 1,
        reasonCode: 'feature-a:reason',
        targetToolCallId: 'call-1',
      },
    ],
    [
      'proposal with an out-of-range priority',
      {
        sourceFeatureId: 'feature-a',
        boundary: 'stream',
        intent: 'verify',
        delivery: 'steer',
        priority: 101,
        reasonCode: 'feature-a:reason',
      },
    ],
    [
      'proposal with a reason namespace owned by another feature',
      {
        sourceFeatureId: 'feature-a',
        boundary: 'stream',
        intent: 'verify',
        delivery: 'steer',
        priority: 1,
        reasonCode: 'feature-b:reason',
      },
    ],
    [
      'proposal from the kernel source',
      {
        sourceFeatureId: 'kernel',
        boundary: 'stream',
        intent: 'verify',
        delivery: 'steer',
        priority: 1,
        reasonCode: 'kernel:reason',
      },
    ],
  ] as const)('hard-rejects malformed proposal %s before grouping', (_description, invalidProposal) => {
    expect(() =>
      arbitrateInterventions({
        proposals: [invalidProposal as unknown as SupervisorInterventionProposal],
        featureModes: { 'feature-a': 'autonomous', 'feature-b': 'autonomous' },
      }),
    ).toThrow(SupervisorContractError);
  });

  it('returns canonicalized proposal copies', () => {
    const inputProposal = {
      sourceFeatureId: 'feature-a',
      boundary: 'stream',
      intent: 'verify',
      delivery: 'steer',
      priority: 1,
      reasonCode: 'feature-a:reason',
    } as const;
    const [result] = arbitrateInterventions({
      proposals: [inputProposal as unknown as SupervisorInterventionProposal],
      featureModes: { 'feature-a': 'autonomous' },
    });

    expect(result?.winner).toEqual(inputProposal);
    expect(result?.winner).not.toBe(inputProposal);
  });
});
