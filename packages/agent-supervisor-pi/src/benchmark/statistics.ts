/*
 * Release thresholds are exact boundaries. Every threshold decision in this module uses integer
 * or BigInt arithmetic; floating-point values are produced only for machine-readable reports.
 */

export interface SupervisorBenchmarkRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export type SupervisorBenchmarkReductionRatio =
  | { readonly status: 'unavailable' }
  | { readonly status: 'available'; readonly ratio: number };

export type SupervisorBenchmarkExactPairedSignTest =
  | { readonly status: 'no-discordance' }
  | {
      readonly status: 'computed';
      readonly discordantPairs: number;
      readonly pValue: number;
      readonly significant: boolean;
    };

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer.`);
  }
}

function toBigIntInteger(value: number, name: string): bigint {
  assertSafeInteger(value, name);
  return BigInt(value);
}

function assertPositiveDenominator(value: SupervisorBenchmarkRational): void {
  if (typeof value.numerator !== 'bigint' || typeof value.denominator !== 'bigint') {
    throw new RangeError('Rational numerator and denominator must be BigInt values.');
  }
  if (value.denominator <= 0n) {
    throw new RangeError('Rational denominator must be strictly positive.');
  }
}

function assertPositiveThresholdDenominator(value: number): bigint {
  const denominator = toBigIntInteger(value, 'Threshold denominator');
  if (denominator <= 0n) {
    throw new RangeError('Threshold denominator must be strictly positive.');
  }
  return denominator;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  assertSafeInteger(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative.`);
  }
}

export function computeReductionRatio(
  baselineTotal: number,
  supervisorTotal: number,
): SupervisorBenchmarkReductionRatio {
  // A zero baseline means the problem was never observed, not that it was reduced by 100%.
  if (baselineTotal === 0) {
    return { status: 'unavailable' };
  }

  assertSafeInteger(baselineTotal, 'Baseline total');
  assertSafeInteger(supervisorTotal, 'Supervisor total');
  if (baselineTotal < 0) {
    throw new RangeError('Baseline total must be positive.');
  }

  return {
    status: 'available',
    ratio: 1 - supervisorTotal / baselineTotal,
  };
}

export function reductionMeetsThreshold(
  baselineTotal: number,
  supervisorTotal: number,
  thresholdNumerator: number,
  thresholdDenominator: number,
): boolean {
  // A missing denominator is missing evidence and cannot meet a reduction threshold.
  if (baselineTotal === 0) {
    return false;
  }

  const baseline = toBigIntInteger(baselineTotal, 'Baseline total');
  const supervisor = toBigIntInteger(supervisorTotal, 'Supervisor total');
  if (baseline <= 0n) {
    throw new RangeError('Baseline total must be positive.');
  }
  const numerator = toBigIntInteger(thresholdNumerator, 'Threshold numerator');
  const denominator = assertPositiveThresholdDenominator(thresholdDenominator);

  // 1 - supervisor / baseline >= numerator / denominator
  // is equivalent to denominator * baseline - denominator * supervisor >= numerator * baseline.
  return denominator * baseline - denominator * supervisor >= numerator * baseline;
}

export function computePairwiseOverhead(
  baselineValue: number,
  supervisorValue: number,
): SupervisorBenchmarkRational {
  assertSafeInteger(baselineValue, 'Baseline measurement');
  assertSafeInteger(supervisorValue, 'Supervisor measurement');
  if (baselineValue <= 0) {
    throw new RangeError('Baseline measurement must be positive.');
  }

  return {
    numerator: BigInt(supervisorValue) - BigInt(baselineValue),
    denominator: BigInt(baselineValue),
  };
}

export function compareRationals(
  left: SupervisorBenchmarkRational,
  right: SupervisorBenchmarkRational,
): number {
  assertPositiveDenominator(left);
  assertPositiveDenominator(right);

  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  if (difference < 0n) {
    return -1;
  }
  if (difference > 0n) {
    return 1;
  }
  return 0;
}

export function medianRational(
  samples: readonly SupervisorBenchmarkRational[],
): SupervisorBenchmarkRational | undefined {
  if (samples.length === 0) {
    return undefined;
  }

  for (const sample of samples) {
    assertPositiveDenominator(sample);
  }
  const sorted = [...samples].sort(compareRationals);
  const middleIndex = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const middle = sorted[middleIndex];
    if (middle === undefined) {
      throw new RangeError('Median sample index is out of range.');
    }
    return middle;
  }

  const left = sorted[middleIndex - 1];
  const right = sorted[middleIndex];
  if (left === undefined || right === undefined) {
    throw new RangeError('Median sample index is out of range.');
  }
  return {
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: 2n * left.denominator * right.denominator,
  };
}

export function rationalToNumber(rational: SupervisorBenchmarkRational): number {
  assertPositiveDenominator(rational);
  return Number(rational.numerator) / Number(rational.denominator);
}

export function rationalMeetsThreshold(
  rational: SupervisorBenchmarkRational,
  thresholdNumerator: number,
  thresholdDenominator: number,
): boolean {
  assertPositiveDenominator(rational);
  const numerator = toBigIntInteger(thresholdNumerator, 'Threshold numerator');
  const denominator = assertPositiveThresholdDenominator(thresholdDenominator);

  // Both denominators are asserted positive, so cross-multiplication preserves the comparison.
  return rational.numerator * denominator <= numerator * rational.denominator;
}

export function computeExactPairedSignTest(
  wins: number,
  regressions: number,
): SupervisorBenchmarkExactPairedSignTest {
  assertNonNegativeSafeInteger(wins, 'Wins');
  assertNonNegativeSafeInteger(regressions, 'Regressions');

  const winsBigInt = BigInt(wins);
  const regressionsBigInt = BigInt(regressions);
  const discordantPairsBigInt = winsBigInt + regressionsBigInt;
  // No discordant pairs are insufficient evidence; unit 3 must map this to insufficient-data, not pass/fail.
  if (discordantPairsBigInt === 0n) {
    return { status: 'no-discordance' };
  }
  if (discordantPairsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Discordant pair count must fit in a safe integer.');
  }

  const discordantPairs = Number(discordantPairsBigInt);
  let coefficient = 1n;
  let numerator = 0n;
  for (let successes = 0; successes <= discordantPairs; successes += 1) {
    if (successes >= wins) {
      numerator += coefficient;
    }
    if (successes < discordantPairs) {
      coefficient =
        (coefficient * BigInt(discordantPairs - successes)) / BigInt(successes + 1);
    }
  }

  const denominator = 2n ** discordantPairsBigInt;
  // pValue is report data only. The significance decision below never reads this float.
  const pValue = Number(numerator) / Number(denominator);
  const significant = numerator * 100n <= 5n * denominator;
  return {
    status: 'computed',
    discordantPairs,
    pValue,
    significant,
  };
}
