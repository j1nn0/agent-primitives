import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as retryApi from '../src/index.js';
import { RetryError, judgeRetry } from '../src/index.js';
import type {
  RetryAttempt,
  RetryAttemptOutcome,
  RetryErrorCode,
} from '../src/index.js';

function expectRetryError(
  action: () => unknown,
  code: RetryErrorCode,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(RetryError);
  expect((thrown as RetryError).name).toBe('RetryError');
  expect((thrown as RetryError).code).toBe(code);
}

function attempt(
  outcome: RetryAttemptOutcome,
  strategyId?: string,
): RetryAttempt {
  return strategyId === undefined ? { outcome } : { outcome, strategyId };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const object = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    deepFreeze(object[key]);
  }
  Object.freeze(value);
  return value;
}

describe('agent retry guard public boundary', () => {
  it('exports only the public runtime values and has no dependencies', () => {
    expect(Object.keys(retryApi).sort()).toEqual(['RetryError', 'judgeRetry']);

    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
  });

  it('allows the initial observation in an empty episode', () => {
    expect(
      judgeRetry({
        attempts: [],
        policy: { maxAttempts: 1, maxStrategyAttempts: 1 },
      }),
    ).toEqual({
      attempts: 0,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
      retryAllowed: true,
    });
  });

  it('judges each member of the closed outcome vocabulary', () => {
    const outcomes: readonly RetryAttemptOutcome[] = [
      'success',
      'failure',
      'no_progress',
      'unknown',
    ];

    for (const outcome of outcomes) {
      const verdict = judgeRetry({ attempts: [{ outcome }] });
      expect(verdict).toEqual({
        attempts: 1,
        consecutiveFailures: outcome === 'failure' ? 1 : 0,
        consecutiveNoProgress: outcome === 'no_progress' ? 1 : 0,
        retryAllowed: outcome !== 'success',
      });
      expect(Object.hasOwn(verdict, 'repeatedStrategy')).toBe(false);
    }
  });

  it('keeps episode history scoped to the array supplied by the caller', () => {
    const priorEpisode = judgeRetry({
      attempts: [attempt('failure', 'alpha'), attempt('failure', 'alpha')],
      policy: { maxAttempts: 3 },
    });
    expect(priorEpisode).toEqual({
      attempts: 2,
      consecutiveFailures: 2,
      consecutiveNoProgress: 0,
      repeatedStrategy: { strategyId: 'alpha', attempts: 2 },
      retryAllowed: true,
    });

    const freshEpisode = judgeRetry({
      attempts: [attempt('failure', 'alpha')],
      policy: { maxAttempts: 3 },
    });
    expect(freshEpisode).toEqual({
      attempts: 1,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      repeatedStrategy: { strategyId: 'alpha', attempts: 1 },
      retryAllowed: true,
    });
  });

  it('builds a mixed failure and no-progress strategy run', () => {
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('no_progress', 'alpha'),
          attempt('failure', 'alpha'),
        ],
      }),
    ).toEqual({
      attempts: 3,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      repeatedStrategy: { strategyId: 'alpha', attempts: 3 },
      retryAllowed: true,
    });
  });

  it('counts a three-times no-progress run under one strategy', () => {
    expect(
      judgeRetry({
        attempts: [
          attempt('no_progress', 'alpha'),
          attempt('no_progress', 'alpha'),
          attempt('no_progress', 'alpha'),
        ],
      }),
    ).toEqual({
      attempts: 3,
      consecutiveFailures: 0,
      consecutiveNoProgress: 3,
      repeatedStrategy: { strategyId: 'alpha', attempts: 3 },
      retryAllowed: true,
    });
  });

  it('breaks a repeated run on a different, case-sensitive strategy id', () => {
    const verdict = judgeRetry({
      attempts: [
        attempt('failure', 'alpha'),
        attempt('failure', 'alpha'),
        attempt('no_progress', 'Alpha'),
      ],
    });

    expect(verdict).toEqual({
      attempts: 3,
      consecutiveFailures: 0,
      consecutiveNoProgress: 1,
      repeatedStrategy: { strategyId: 'Alpha', attempts: 1 },
      retryAllowed: true,
    });
  });

  it('breaks runs for absent strategy ids and never merges id-less attempts', () => {
    const verdict = judgeRetry({
      attempts: [attempt('failure'), attempt('failure')],
      policy: { maxStrategyAttempts: 1 },
    });

    expect(verdict).toEqual({
      attempts: 2,
      consecutiveFailures: 2,
      consecutiveNoProgress: 0,
      retryAllowed: true,
    });
    expect(Object.hasOwn(verdict, 'repeatedStrategy')).toBe(false);
  });

  it('clears trailing state after success and does not permit a retry', () => {
    const verdict = judgeRetry({
      attempts: [
        attempt('failure', 'alpha'),
        attempt('no_progress', 'alpha'),
        attempt('success', 'alpha'),
      ],
      policy: { maxAttempts: 1, maxStrategyAttempts: 1 },
    });

    expect(verdict).toEqual({
      attempts: 3,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
      retryAllowed: false,
    });
    expect(Object.hasOwn(verdict, 'repeatedStrategy')).toBe(false);
  });

  it('keeps failure and no-progress counters on separate axes', () => {
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('no_progress', 'alpha'),
          attempt('no_progress', 'alpha'),
        ],
      }),
    ).toEqual({
      attempts: 3,
      consecutiveFailures: 0,
      consecutiveNoProgress: 2,
      repeatedStrategy: { strategyId: 'alpha', attempts: 3 },
      retryAllowed: true,
    });
  });

  it('lets unknown terminate every streak without downgrading it', () => {
    const endingUnknown = judgeRetry({
      attempts: [
        attempt('failure', 'alpha'),
        attempt('no_progress', 'alpha'),
        attempt('unknown', 'alpha'),
      ],
    });
    expect(endingUnknown).toEqual({
      attempts: 3,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
      retryAllowed: true,
    });
    expect(Object.hasOwn(endingUnknown, 'repeatedStrategy')).toBe(false);

    const failureAfterUnknown = judgeRetry({
      attempts: [
        attempt('failure', 'alpha'),
        attempt('unknown', 'alpha'),
        attempt('failure', 'alpha'),
      ],
    });
    expect(failureAfterUnknown).toEqual({
      attempts: 3,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      repeatedStrategy: { strategyId: 'alpha', attempts: 1 },
      retryAllowed: true,
    });
  });

  it('applies the full retry policy matrix with inclusive boundaries', () => {
    expect(judgeRetry({ attempts: [attempt('failure')] }).retryAllowed).toBe(
      true,
    );
    expect(judgeRetry({ attempts: [attempt('success')] }).retryAllowed).toBe(
      false,
    );
    expect(
      judgeRetry({ attempts: [attempt('failure')], policy: {} }).retryAllowed,
    ).toBe(true);

    expect(
      judgeRetry({
        attempts: [attempt('failure'), attempt('failure')],
        policy: { maxAttempts: 3 },
      }).retryAllowed,
    ).toBe(true);
    expect(
      judgeRetry({
        attempts: [
          attempt('failure'),
          attempt('failure'),
          attempt('failure'),
        ],
        policy: { maxAttempts: 3 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [
          attempt('failure'),
          attempt('failure'),
          attempt('failure'),
          attempt('failure'),
        ],
        policy: { maxAttempts: 3 },
      }).retryAllowed,
    ).toBe(false);

    expect(
      judgeRetry({
        attempts: [attempt('failure', 'alpha'), attempt('failure', 'alpha')],
        policy: { maxStrategyAttempts: 3 },
      }).retryAllowed,
    ).toBe(true);
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('failure', 'alpha'),
          attempt('no_progress', 'alpha'),
        ],
        policy: { maxStrategyAttempts: 3 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('failure', 'alpha'),
          attempt('no_progress', 'alpha'),
          attempt('failure', 'alpha'),
        ],
        policy: { maxStrategyAttempts: 3 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [attempt('failure', 'alpha')],
        policy: { maxStrategyAttempts: 1 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [attempt('failure')],
        policy: { maxStrategyAttempts: 1 },
      }).retryAllowed,
    ).toBe(true);

    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('no_progress', 'alpha'),
          attempt('failure', 'alpha'),
        ],
        policy: { maxAttempts: 3, maxStrategyAttempts: 3 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('no_progress', 'alpha'),
          attempt('failure', 'alpha'),
        ],
        policy: { maxAttempts: 5, maxStrategyAttempts: 3 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [attempt('success', 'alpha')],
        policy: { maxAttempts: 1, maxStrategyAttempts: 1 },
      }).retryAllowed,
    ).toBe(false);
    expect(
      judgeRetry({
        attempts: [],
        policy: { maxAttempts: 1, maxStrategyAttempts: 1 },
      }).retryAllowed,
    ).toBe(true);
  });

  it('rejects malformed input with invalid_input', () => {
    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      42,
      'input',
      [],
      new Date(),
      Object.create({}),
      {},
      { attempts: undefined },
      { attempts: null },
      { attempts: {} },
      { attempts: 'not-an-array' },
      { attempts: [undefined] },
      { attempts: [null] },
      { attempts: [42] },
      { attempts: [new Date()] },
      { attempts: [{}] },
      { attempts: [Object.create({ outcome: 'failure' })] },
      { attempts: [{ outcome: undefined }] },
      { attempts: [{ outcome: 'SUCCESS' }] },
      { attempts: [{ outcome: 'done' }] },
      { attempts: [{ outcome: 1 }] },
      { attempts: [{ outcome: null }] },
      { attempts: [{ outcome: 'failure', strategyId: undefined }] },
      { attempts: [{ outcome: 'failure', strategyId: null }] },
      { attempts: [{ outcome: 'failure', strategyId: 1 }] },
      { attempts: [{ outcome: 'failure', strategyId: '' }] },
      { attempts: [{ outcome: 'failure', strategyId: ' \t\n' }] },
      { attempts: [{ outcome: 'failure' }], policy: undefined },
      { attempts: [{ outcome: 'failure' }], policy: null },
      { attempts: [{ outcome: 'failure' }], policy: [] },
      { attempts: [{ outcome: 'failure' }], policy: 'policy' },
      { attempts: [{ outcome: 'failure' }], policy: Object.create({}) },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxAttempts: undefined },
      },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: 0 } },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: -1 } },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: 1.5 } },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: NaN } },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: Infinity } },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: '3' } },
      { attempts: [{ outcome: 'failure' }], policy: { maxAttempts: null } },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: undefined },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: 0 },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: -1 },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: 1.5 },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: NaN },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: Infinity },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: '3' },
      },
      {
        attempts: [{ outcome: 'failure' }],
        policy: { maxStrategyAttempts: null },
      },
    ];

    for (const input of invalidInputs) {
      expectRetryError(() => judgeRetry(input), 'invalid_input');
    }
  });

  it('accepts extra keys, following agent-progress validation precedent', () => {
    expect(
      judgeRetry({
        extra: 'ignored',
        attempts: [{ outcome: 'failure', extra: true }],
        policy: { extra: true },
      }),
    ).toEqual({
      attempts: 1,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      retryAllowed: true,
    });
  });

  it('accepts duplicate strategy ids because repetition is the purpose', () => {
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', 'alpha'),
          attempt('success', 'beta'),
          attempt('failure', 'alpha'),
        ],
      }),
    ).toEqual({
      attempts: 3,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      repeatedStrategy: { strategyId: 'alpha', attempts: 1 },
      retryAllowed: true,
    });
  });

  it('preserves accepted strategy strings exactly', () => {
    expect(
      judgeRetry({
        attempts: [
          attempt('failure', '  alpha  '),
          attempt('no_progress', '  alpha  '),
        ],
      }),
    ).toEqual({
      attempts: 2,
      consecutiveFailures: 0,
      consecutiveNoProgress: 1,
      repeatedStrategy: { strategyId: '  alpha  ', attempts: 2 },
      retryAllowed: true,
    });
  });

  it('is deterministic and JSON round-trip safe', () => {
    const input = {
      attempts: [
        attempt('failure', 'alpha'),
        attempt('no_progress', 'alpha'),
        attempt('failure', 'alpha'),
      ],
      policy: { maxAttempts: 5, maxStrategyAttempts: 4 },
    };
    const first = judgeRetry(input);
    const second = judgeRetry(input);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });

  it('does not mutate deep-frozen input or alias returned strategy data', () => {
    const input = deepFreeze({
      attempts: [
        { outcome: 'failure' as const, strategyId: 'alpha' },
        { outcome: 'no_progress' as const, strategyId: 'alpha' },
      ],
      policy: { maxStrategyAttempts: 3 },
    });
    const before = JSON.stringify(input);
    const first = judgeRetry(input);
    const second = judgeRetry(input);

    expect(first.repeatedStrategy).not.toBe(second.repeatedStrategy);
    expect(first.repeatedStrategy).not.toBe(input.attempts[1]);
    expect(JSON.stringify(input)).toBe(before);

    const mutableFirst = first as unknown as {
      repeatedStrategy: { strategyId: string; attempts: number };
    };
    mutableFirst.repeatedStrategy.strategyId = 'mutated';
    mutableFirst.repeatedStrategy.attempts = 99;

    expect(judgeRetry(input)).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('supports a caller-owned Progress boundary without importing Progress', () => {
    type ProgressVerdict = {
      readonly outcome: 'progress' | 'no_progress' | 'unknown';
    };

    const toRetryOutcome = (
      verdict: ProgressVerdict,
    ): RetryAttemptOutcome => {
      switch (verdict.outcome) {
        case 'progress':
          return 'success';
        case 'no_progress':
          return 'no_progress';
        case 'unknown':
          return 'unknown';
      }
    };

    expect(toRetryOutcome({ outcome: 'progress' })).toBe('success');
    expect(toRetryOutcome({ outcome: 'no_progress' })).toBe('no_progress');
    expect(toRetryOutcome({ outcome: 'unknown' })).toBe('unknown');

    const verdict = judgeRetry({
      attempts: [
        {
          outcome: toRetryOutcome({ outcome: 'progress' }),
          strategyId: 'progress-loop',
        },
        {
          outcome: toRetryOutcome({ outcome: 'no_progress' }),
          strategyId: 'progress-loop',
        },
        {
          outcome: toRetryOutcome({ outcome: 'unknown' }),
          strategyId: 'progress-loop',
        },
        {
          outcome: toRetryOutcome({ outcome: 'no_progress' }),
          strategyId: 'progress-loop',
        },
      ],
    });

    expect(verdict).toEqual({
      attempts: 4,
      consecutiveFailures: 0,
      consecutiveNoProgress: 1,
      repeatedStrategy: { strategyId: 'progress-loop', attempts: 1 },
      retryAllowed: true,
    });
  });

  it('takes a declared success at face value at the Evidence boundary', () => {
    expect(
      judgeRetry({
        attempts: [{ outcome: 'success' }],
        policy: { maxAttempts: 1 },
      }),
    ).toEqual({
      attempts: 1,
      consecutiveFailures: 0,
      consecutiveNoProgress: 0,
      retryAllowed: false,
    });
  });
});
