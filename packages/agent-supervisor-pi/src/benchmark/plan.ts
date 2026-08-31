/// <reference types="node" />
import { createHash } from 'node:crypto';
import type { SupervisorBenchmarkExpectedPair, SupervisorBenchmarkPlanV1 } from './types.js';

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalizeExpectedPair(pair: SupervisorBenchmarkExpectedPair): {
  readonly caseId: string;
  readonly executionProfile: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly pairId: string;
  readonly repetition: number;
  readonly scenarioClass: string;
  readonly scenarioId: string;
} {
  return {
    caseId: pair.caseId,
    executionProfile: pair.executionProfile,
    modelFamily: pair.modelFamily,
    modelId: pair.modelId,
    pairId: pair.pairId,
    repetition: pair.repetition,
    scenarioClass: pair.scenarioClass,
    scenarioId: pair.scenarioId,
  };
}

export function canonicalizeSupervisorBenchmarkPlan(plan: SupervisorBenchmarkPlanV1): string {
  const expectedPairs = [...plan.expectedPairs].sort((left, right) =>
    compareStrings(left.pairId, right.pairId),
  );

  return JSON.stringify({
    benchmarkId: plan.benchmarkId,
    expectedPairs: expectedPairs.map(canonicalizeExpectedPair),
    policyId: plan.policyId,
    schemaVersion: plan.schemaVersion,
    sourceSha: plan.sourceSha,
  });
}

export function computeSupervisorBenchmarkPlanFingerprint(plan: SupervisorBenchmarkPlanV1): string {
  return createHash('sha256').update(canonicalizeSupervisorBenchmarkPlan(plan)).digest('hex');
}
