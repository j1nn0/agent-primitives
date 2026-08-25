import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as progressApi from '../src/index.js';
import { ProgressError, judgeProgress } from '../src/index.js';
import type {
  ProgressErrorCode,
  ProgressObservation,
} from '../src/index.js';

function expectProgressError(
  action: () => unknown,
  code: ProgressErrorCode,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ProgressError);
  expect((thrown as ProgressError).name).toBe('ProgressError');
  expect((thrown as ProgressError).code).toBe(code);
}

describe('agent progress public boundary', () => {
  it('exports only the public runtime values and has no Agent State dependency', () => {
    expect(Object.keys(progressApi).sort()).toEqual([
      'ProgressError',
      'judgeProgress',
    ]);

    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();

    expect(
      judgeProgress({
        previous: { milestones: [] },
        current: { milestones: ['plain-observation'] },
      }),
    ).toEqual({
      outcome: 'progress',
      newMilestones: ['plain-observation'],
      recordedMilestones: ['plain-observation'],
    });
  });

  it('judges set growth while preserving insertion order and exact strings', () => {
    expect(
      judgeProgress({
        previous: { milestones: ['zeta', 'alpha', 'withdrawn'] },
        current: { milestones: ['alpha', '  new  ', 'zeta'] },
      }),
    ).toEqual({
      outcome: 'progress',
      newMilestones: ['  new  '],
      withdrawnMilestones: ['withdrawn'],
      recordedMilestones: ['zeta', 'alpha', 'withdrawn', '  new  '],
    });
  });

  it('reports no progress for reordering and re-declaring the same set', () => {
    const verdict = judgeProgress({
      previous: { milestones: ['zeta', 'alpha'] },
      current: { milestones: ['alpha', 'zeta'] },
    });

    expect(verdict).toEqual({
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestones: ['zeta', 'alpha'],
    });
    expect(Object.hasOwn(verdict, 'withdrawnMilestones')).toBe(false);
  });

  it('returns unknown only when the baseline is missing', () => {
    const currentMilestones = ['first', 'second'];
    const current = { milestones: currentMilestones };
    const verdict = judgeProgress({ current });

    expect(verdict).toEqual({
      outcome: 'unknown',
      reason: 'missing_baseline',
      recordedMilestones: ['first', 'second'],
    });
    expect(verdict.recordedMilestones).not.toBe(currentMilestones);
    expect(current).toEqual({ milestones: ['first', 'second'] });

    expect(
      judgeProgress({
        previous: { milestones: [] },
        current: { milestones: [] },
      }),
    ).toEqual({
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestones: [],
    });
  });

  it('returns the cumulative set in order across a multi-round loop', () => {
    let recorded: ProgressObservation = { milestones: [] };

    const first = judgeProgress({
      previous: recorded,
      current: { milestones: ['third', 'first'] },
    });
    expect(first).toEqual({
      outcome: 'progress',
      newMilestones: ['third', 'first'],
      recordedMilestones: ['third', 'first'],
    });
    recorded = { milestones: first.recordedMilestones };

    const second = judgeProgress({
      previous: recorded,
      current: { milestones: ['first', 'second'] },
    });
    expect(second).toEqual({
      outcome: 'progress',
      newMilestones: ['second'],
      withdrawnMilestones: ['third'],
      recordedMilestones: ['third', 'first', 'second'],
    });
    recorded = { milestones: second.recordedMilestones };

    const third = judgeProgress({
      previous: recorded,
      current: { milestones: ['second'] },
    });
    expect(third).toEqual({
      outcome: 'no_progress',
      newMilestones: [],
      withdrawnMilestones: ['third', 'first'],
      recordedMilestones: ['third', 'first', 'second'],
    });
  });

  it('does not treat withdrawal followed by re-declaration as progress', () => {
    let recorded: ProgressObservation = { milestones: [] };

    const declared = judgeProgress({
      previous: recorded,
      current: { milestones: ['a'] },
    });
    expect(declared.outcome).toBe('progress');
    recorded = { milestones: declared.recordedMilestones };

    const withdrawn = judgeProgress({
      previous: recorded,
      current: { milestones: [] },
    });
    expect(withdrawn).toEqual({
      outcome: 'no_progress',
      newMilestones: [],
      withdrawnMilestones: ['a'],
      recordedMilestones: ['a'],
    });
    recorded = { milestones: withdrawn.recordedMilestones };

    const reDeclared = judgeProgress({
      previous: recorded,
      current: { milestones: ['a'] },
    });
    expect(reDeclared).toEqual({
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestones: ['a'],
    });
    expect(Object.hasOwn(reDeclared, 'withdrawnMilestones')).toBe(false);
  });

  it('rejects malformed inputs with invalid_input', () => {
    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      42,
      'input',
      [],
      new Date(),
      Object.create({}),
      {},
      { current: undefined },
      { current: null },
      { current: {} },
      { current: { milestones: undefined } },
      { current: { milestones: 'not-an-array' } },
      { current: { milestones: [42] } },
      { current: { milestones: [''] } },
      { current: { milestones: [' \t\n'] } },
      {
        current: { milestones: ['current'] },
        previous: null,
      },
      {
        current: { milestones: ['current'] },
        previous: undefined,
      },
      {
        current: { milestones: ['current'] },
        previous: {},
      },
      {
        current: { milestones: ['current'] },
        previous: { milestones: 'not-an-array' },
      },
      {
        current: { milestones: ['current'] },
        previous: { milestones: [false] },
      },
      {
        current: { milestones: ['current'] },
        previous: { milestones: ['\n'] },
      },
    ];

    for (const input of invalidInputs) {
      expectProgressError(() => judgeProgress(input), 'invalid_input');
    }
  });

  it('rejects duplicate identifiers within either observation', () => {
    expectProgressError(
      () =>
        judgeProgress({
          current: { milestones: ['a', 'a'] },
        }),
      'duplicate_milestone',
    );
    expectProgressError(
      () =>
        judgeProgress({
          previous: { milestones: ['a', 'b', 'a'] },
          current: { milestones: ['b'] },
        }),
      'duplicate_milestone',
    );
  });

  it('is deterministic and JSON round-trip safe', () => {
    const input = {
      previous: { milestones: ['zeta', 'alpha'] },
      current: { milestones: ['alpha', 'new'] },
    };
    const first = judgeProgress(input);
    const second = judgeProgress(input);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('does not mutate inputs or allow returned arrays to alias them', () => {
    const previousMilestones = ['old'];
    const currentMilestones = ['new'];
    const input = {
      previous: { milestones: previousMilestones },
      current: { milestones: currentMilestones },
    };
    const before = {
      previous: { milestones: ['old'] },
      current: { milestones: ['new'] },
    };

    const first = judgeProgress(input);

    expect(input).toEqual(before);
    const mutableFirst = first as unknown as {
      newMilestones: string[];
      withdrawnMilestones: string[];
      recordedMilestones: string[];
    };
    expect(mutableFirst.newMilestones).not.toBe(currentMilestones);
    expect(mutableFirst.withdrawnMilestones).not.toBe(previousMilestones);
    expect(mutableFirst.recordedMilestones).not.toBe(previousMilestones);
    expect(mutableFirst.recordedMilestones).not.toBe(currentMilestones);
    mutableFirst.newMilestones?.push('returned-only');
    mutableFirst.withdrawnMilestones?.push('returned-only');
    mutableFirst.recordedMilestones.push('returned-only');

    expect(judgeProgress(input)).toEqual({
      outcome: 'progress',
      newMilestones: ['new'],
      withdrawnMilestones: ['old'],
      recordedMilestones: ['old', 'new'],
    });
    expect(input).toEqual(before);
  });
});
