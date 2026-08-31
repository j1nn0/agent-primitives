import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  indexSupervisorBenchmarkPairs,
  validateSupervisorBenchmarkDataset,
} from '../src/index.js';
import {
  completedRun,
  infrastructureErrorRun,
  plan,
  validDataset,
} from './benchmark-helper.js';

function expectInvalidDataset(value: unknown): void {
  expect(() => validateSupervisorBenchmarkDataset(value)).toThrow(SupervisorContractError);
}

describe('supervisor benchmark pair indexing', () => {
  it('indexes one baseline and one supervisor run as a complete pair', () => {
    const dataset = validateSupervisorBenchmarkDataset(validDataset());
    const indexed = indexSupervisorBenchmarkPairs(dataset);

    expect(indexed.pairs).toHaveLength(1);
    expect(indexed.pairs[0]).toMatchObject({
      expectedPair: dataset.plan.expectedPairs[0],
      baselineRun: dataset.runs[0],
      supervisorRun: dataset.runs[1],
      complete: true,
    });
    expect(indexed.totalPlannedPairs).toBe(1);
    expect(indexed.completePairs).toBe(1);
    expect(indexed.infrastructureErrorPairs).toBe(0);
  });

  it('rejects a planned pair with no baseline run', () => {
    expectInvalidDataset(validDataset(plan(), [completedRun('supervisor')]));
  });

  it('rejects a planned pair with no supervisor run', () => {
    expectInvalidDataset(validDataset(plan(), [completedRun('baseline')]));
  });

  it('rejects duplicate baseline runs', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline', 'pair-a', 'baseline-run'),
        completedRun('baseline', 'pair-a', 'baseline-run-2'),
        completedRun('supervisor'),
      ]),
    );
  });

  it('rejects duplicate supervisor runs', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline'),
        completedRun('supervisor', 'pair-a', 'supervisor-run'),
        completedRun('supervisor', 'pair-a', 'supervisor-run-2'),
      ]),
    );
  });

  it('rejects a run with an unknown pair ID', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline'),
        completedRun('supervisor', 'pair-z', 'supervisor-run'),
      ]),
    );
  });

  it('rejects an extra unplanned run', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline'),
        completedRun('supervisor'),
        completedRun('baseline', 'pair-z', 'extra-run'),
      ]),
    );
  });

  it('rejects duplicate run IDs', () => {
    expectInvalidDataset(
      validDataset(plan(), [
        completedRun('baseline', 'pair-a', 'same-run'),
        completedRun('supervisor', 'pair-a', 'same-run'),
      ]),
    );
  });

  it('counts an infrastructure-error pair and marks it incomplete', () => {
    const dataset = validateSupervisorBenchmarkDataset(
      validDataset(plan(), [infrastructureErrorRun('baseline'), completedRun('supervisor')]),
    );
    const indexed = indexSupervisorBenchmarkPairs(dataset);

    expect(indexed.pairs[0]?.complete).toBe(false);
    expect(indexed.totalPlannedPairs).toBe(1);
    expect(indexed.completePairs).toBe(0);
    expect(indexed.infrastructureErrorPairs).toBe(1);
  });
});
