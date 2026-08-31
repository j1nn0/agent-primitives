import { SupervisorContractError } from '../errors.js';
import type {
  SupervisorBenchmarkExpectedPair,
  SupervisorBenchmarkRun,
  SupervisorBenchmarkDatasetV1,
} from './types.js';

export interface SupervisorBenchmarkPairIndexEntry {
  readonly expectedPair: SupervisorBenchmarkExpectedPair;
  readonly baselineRun: SupervisorBenchmarkRun;
  readonly supervisorRun: SupervisorBenchmarkRun;
  readonly complete: boolean;
}

export interface SupervisorBenchmarkPairIndex {
  readonly pairs: readonly SupervisorBenchmarkPairIndexEntry[];
  readonly totalPlannedPairs: number;
  readonly completePairs: number;
  readonly infrastructureErrorPairs: number;
}

interface IndexedRuns {
  baselineRun?: SupervisorBenchmarkRun;
  supervisorRun?: SupervisorBenchmarkRun;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function invalidPairIndex(): never {
  throw new SupervisorContractError('invalid_benchmark_dataset', 'Invalid supervisor benchmark dataset.');
}

export function indexSupervisorBenchmarkPairs(
  dataset: SupervisorBenchmarkDatasetV1,
): SupervisorBenchmarkPairIndex {
  const expectedPairIds = new Set<string>();
  for (const expectedPair of dataset.plan.expectedPairs) {
    if (expectedPairIds.has(expectedPair.pairId)) {
      return invalidPairIndex();
    }
    expectedPairIds.add(expectedPair.pairId);
  }

  const runsByPair = new Map<string, IndexedRuns>();
  const runIds = new Set<string>();
  for (const run of dataset.runs) {
    if (!expectedPairIds.has(run.pairId) || runIds.has(run.runId)) {
      return invalidPairIndex();
    }
    runIds.add(run.runId);

    let indexedRuns = runsByPair.get(run.pairId);
    if (indexedRuns === undefined) {
      indexedRuns = {};
      runsByPair.set(run.pairId, indexedRuns);
    }
    if (run.variant === 'baseline') {
      if (indexedRuns.baselineRun !== undefined) {
        return invalidPairIndex();
      }
      indexedRuns.baselineRun = run;
    } else if (run.variant === 'supervisor') {
      if (indexedRuns.supervisorRun !== undefined) {
        return invalidPairIndex();
      }
      indexedRuns.supervisorRun = run;
    } else {
      return invalidPairIndex();
    }
  }

  // The plan is authoritative: expected pairs are never inferred from dataset.runs.
  const pairs = [...dataset.plan.expectedPairs]
    .sort((left, right) => compareStrings(left.pairId, right.pairId))
    .map((expectedPair): SupervisorBenchmarkPairIndexEntry => {
      const indexedRuns = runsByPair.get(expectedPair.pairId);
      const baselineRun = indexedRuns?.baselineRun;
      const supervisorRun = indexedRuns?.supervisorRun;
      if (baselineRun === undefined || supervisorRun === undefined) {
        return invalidPairIndex();
      }

      return {
        expectedPair,
        baselineRun,
        supervisorRun,
        complete: baselineRun.status === 'completed' && supervisorRun.status === 'completed',
      };
    });

  let completePairs = 0;
  let infrastructureErrorPairs = 0;
  for (const pair of pairs) {
    if (pair.complete) {
      completePairs += 1;
    }
    if (
      pair.baselineRun.status === 'infrastructure-error' ||
      pair.supervisorRun.status === 'infrastructure-error'
    ) {
      infrastructureErrorPairs += 1;
    }
  }

  return {
    pairs,
    totalPlannedPairs: pairs.length,
    completePairs,
    infrastructureErrorPairs,
  };
}
