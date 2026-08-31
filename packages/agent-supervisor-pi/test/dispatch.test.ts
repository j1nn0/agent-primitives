import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  dispatchObservation,
} from '../src/index.js';
import type {
  EffectiveFeatureMode,
  SupervisorDispatchFeature,
  SupervisorFeatureRuntime,
  SupervisorObservation,
} from '../src/index.js';

function observation(): SupervisorObservation {
  return {
    schemaVersion: 1,
    id: 'observation-1',
    sequence: 0,
    rootRequestId: 'root-1',
    kind: 'tool-result',
    payload: { ok: true },
  };
}

function dispatchFeature(
  featureId: string,
  runtime: SupervisorFeatureRuntime,
  effectiveMode: EffectiveFeatureMode = 'autonomous',
  observes: readonly ['tool-result'] = ['tool-result'],
): SupervisorDispatchFeature {
  return { featureId, effectiveMode, observes, runtime, state: null };
}

function dispatchInput(
  features: readonly SupervisorDispatchFeature[],
  facts: readonly import('../src/index.js').SupervisorFactRecord[] = [],
  nextFactSequence = 0,
) {
  return { observation: observation(), features, facts, nextFactSequence };
}

describe('supervisor dispatch', () => {
  it('isolates facts within one dispatch regardless of input feature order', async () => {
    const snapshots: Record<string, object> = {};
    const featureA = dispatchFeature('feature-a', {
      onObservation: () => ({
        facts: [
          {
            kind: 'feature-a:signal',
            evidenceRefs: ['trace-1'],
            data: { value: 1 },
          },
        ],
      }),
    });
    const featureB = dispatchFeature('feature-b', {
      onObservation: (_observation, context) => {
        snapshots.featureB = context.facts;
      },
    });

    const first = await dispatchObservation(dispatchInput([featureA, featureB]));
    const second = await dispatchObservation(dispatchInput([featureB, featureA]));

    expect(snapshots.featureB).toBeDefined();
    expect((snapshots.featureB as { all(): readonly unknown[] }).all()).toEqual([]);
    expect(first).toEqual(second);
    expect(first.emittedFacts).toHaveLength(1);
  });

  it('makes emitted facts visible to a later dispatch', async () => {
    const first = await dispatchObservation(
      dispatchInput([
        dispatchFeature('feature-a', {
          onObservation: () => ({
            facts: [
              {
                kind: 'feature-a:signal',
                evidenceRefs: ['trace-1'],
                data: { value: 1 },
              },
            ],
          }),
        }),
      ]),
    );

    let observedSequences: readonly number[] = [];
    const second = await dispatchObservation(
      dispatchInput(
        [
          dispatchFeature('feature-b', {
            onObservation: (_observation, context) => {
              observedSequences = context.facts.all().map((record) => record.sequence);
            },
          }),
        ],
        first.emittedFacts,
        first.nextFactSequence,
      ),
    );

    expect(observedSequences).toEqual([0]);
    expect(second.nextFactSequence).toBe(1);
  });

  it('assigns fact sequences by feature ID and candidate order', async () => {
    const result = await dispatchObservation(
      dispatchInput([
        dispatchFeature('feature-b', {
          onObservation: () => ({
            facts: [
              { kind: 'feature-b:first', evidenceRefs: ['trace-2'], data: null },
            ],
          }),
        }),
        dispatchFeature('feature-a', {
          onObservation: () => ({
            facts: [
              { kind: 'feature-a:first', evidenceRefs: ['trace-1'], data: null },
              { kind: 'feature-a:second', evidenceRefs: ['trace-1'], data: null },
            ],
          }),
        }),
      ], [], 4),
    );

    expect(result.emittedFacts.map((record) => [record.sourceFeatureId, record.sequence])).toEqual([
      ['feature-a', 4],
      ['feature-a', 5],
      ['feature-b', 6],
    ]);
    expect(result.nextFactSequence).toBe(7);
  });

  it('skips off and unavailable features without invoking them', async () => {
    const calls: string[] = [];
    const runtime = (featureId: string): SupervisorFeatureRuntime => ({
      onObservation: () => {
        calls.push(featureId);
      },
    });

    await dispatchObservation(
      dispatchInput([
        dispatchFeature('feature-a', runtime('feature-a'), 'off'),
        dispatchFeature('feature-b', runtime('feature-b'), 'unavailable'),
        dispatchFeature('feature-c', runtime('feature-c')),
      ]),
    );

    expect(calls).toEqual(['feature-c']);
  });


  it('does not invoke a feature subscribed only to another observation kind', async () => {
    const calls: string[] = [];
    const feature = {
      featureId: 'feature-a',
      effectiveMode: 'autonomous' as const,
      observes: ['turn-ended'] as const,
      runtime: { onObservation: () => { calls.push('feature-a'); } },
      state: null,
    } satisfies SupervisorDispatchFeature;

    await dispatchObservation(dispatchInput([feature]));
    expect(calls).toEqual([]);
  });

  it('rejects a proposal made on behalf of another feature', async () => {
    const promise = dispatchObservation(
      dispatchInput([
        dispatchFeature('feature-a', {
          onObservation: () => ({
            interventions: [
              {
                sourceFeatureId: 'feature-b',
                boundary: 'stream',
                intent: 'stop',
                delivery: 'block',
                priority: 1,
                reasonCode: 'reason:delegated',
              },
            ],
          }),
        }),
      ]),
    );

    await expect(promise).rejects.toBeInstanceOf(SupervisorContractError);
    await expect(promise).rejects.toMatchObject({ code: 'invalid_intervention' });
  });

  it('returns nextState as a whole-state replacement keyed by feature ID', async () => {
    const result = await dispatchObservation(
      dispatchInput([
        dispatchFeature('feature-a', {
          onObservation: () => ({ nextState: { count: 2, ready: true } }),
        }),
      ]),
    );

    expect(result.nextStates).toEqual({ 'feature-a': { count: 2, ready: true } });
  });
});
