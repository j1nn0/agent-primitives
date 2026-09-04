import { Buffer } from 'node:buffer';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { computeSupervisorBenchmarkPlanFingerprint } from '../../../packages/agent-supervisor-pi/dist/benchmark/plan.js';
import { SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1 } from '../../../packages/agent-supervisor-pi/dist/benchmark/policy.js';
import { validateSupervisorBenchmarkPlan } from '../../../packages/agent-supervisor-pi/dist/benchmark/validate.js';
import { createCheck, createCleanupRegistry } from '../../supervisor-harness/runner.mjs';
import { BENCHMARK_MODEL_FAMILIES } from '../models.mjs';
import {
  buildSupervisorBenchmarkPlan,
  buildSupervisorBenchmarkPlanWithFingerprint,
} from '../plan.mjs';
import { SCENARIO_CASES } from '../scenarios/index.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const EXPECTED_MODEL_FAMILIES = ['deepseek', 'openai'];
const EXPECTED_CASE_IDS = ['case-a', 'case-b', 'case-c'];
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const IDENTIFIER_FIELDS = [
  'pairId',
  'scenarioClass',
  'scenarioId',
  'caseId',
  'modelFamily',
  'executionProfile',
];
const FINGERPRINT_FIELDS = [
  'pairId',
  'scenarioClass',
  'scenarioId',
  'caseId',
  'modelFamily',
  'modelId',
  'executionProfile',
  'repetition',
];

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function checkEqual(check, left, right, label) {
  try {
    strictEqual(left, right);
    check(true, label);
  } catch {
    check(false, label);
  }
}

function checkDeepEqual(check, left, right, label) {
  try {
    deepStrictEqual(left, right);
    check(true, label);
  } catch {
    check(false, label);
  }
}

function acceptsPlan(plan) {
  try {
    validateSupervisorBenchmarkPlan(plan);
    return true;
  } catch {
    return false;
  }
}

function buildPlan() {
  return buildSupervisorBenchmarkPlan({
    sourceSha: SOURCE_SHA,
    scenarioCases: SCENARIO_CASES,
    modelFamilies: BENCHMARK_MODEL_FAMILIES,
  });
}

function changePairField(plan, field) {
  const firstPair = plan.expectedPairs[0];
  const changedValue = field === 'repetition' ? firstPair[field] + 1 : `${firstPair[field]}-changed`;
  return {
    ...plan,
    expectedPairs: plan.expectedPairs.map((pair, index) =>
      index === 0 ? { ...pair, [field]: changedValue } : pair,
    ),
  };
}

export const name = 'plan';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  try {
    const plan = buildPlan();
    const secondPlan = buildPlan();
    const fingerprint = computeSupervisorBenchmarkPlanFingerprint(plan);
    const secondFingerprint = computeSupervisorBenchmarkPlanFingerprint(secondPlan);
    const withFingerprint = buildSupervisorBenchmarkPlanWithFingerprint({
      sourceSha: SOURCE_SHA,
      scenarioCases: SCENARIO_CASES,
      modelFamilies: BENCHMARK_MODEL_FAMILIES,
    });

    checkEqual(check, plan.expectedPairs.length, 60, 'plan contains exactly 60 expected pairs');
    checkDeepEqual(
      check,
      sortedUnique(plan.expectedPairs.map((pair) => pair.modelFamily)),
      EXPECTED_MODEL_FAMILIES,
      'plan contains exactly deepseek and openai model families',
    );
    checkDeepEqual(
      check,
      sortedUnique(plan.expectedPairs.map((pair) => pair.scenarioClass)),
      [...SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses].sort(),
      'plan classes exactly match the real release policy classes',
    );

    for (const scenarioClass of SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses) {
      const classPairs = plan.expectedPairs.filter((pair) => pair.scenarioClass === scenarioClass);
      checkEqual(check, classPairs.length, 6, `${scenarioClass} has exactly 6 pairs`);
      for (const modelFamily of EXPECTED_MODEL_FAMILIES) {
        const cellPairs = classPairs.filter((pair) => pair.modelFamily === modelFamily);
        checkEqual(check, cellPairs.length, 3, `${scenarioClass}/${modelFamily} has exactly 3 pairs`);
        checkDeepEqual(
          check,
          sortedUnique(cellPairs.map((pair) => pair.caseId)),
          EXPECTED_CASE_IDS,
          `${scenarioClass}/${modelFamily} contains case-a, case-b, and case-c`,
        );
      }
    }

    checkEqual(
      check,
      plan.expectedPairs.filter((pair) => pair.executionProfile === 'pi0844-max-baseline-first').length,
      30,
      'plan contains exactly 30 baseline-first pairs',
    );
    checkEqual(
      check,
      plan.expectedPairs.filter((pair) => pair.executionProfile === 'pi0844-max-supervisor-first').length,
      30,
      'plan contains exactly 30 supervisor-first pairs',
    );
    for (const modelFamily of EXPECTED_MODEL_FAMILIES) {
      const familyPairs = plan.expectedPairs.filter((pair) => pair.modelFamily === modelFamily);
      checkEqual(
        check,
        familyPairs.filter((pair) => pair.executionProfile === 'pi0844-max-baseline-first').length,
        15,
        `${modelFamily} has exactly 15 baseline-first pairs`,
      );
      checkEqual(
        check,
        familyPairs.filter((pair) => pair.executionProfile === 'pi0844-max-supervisor-first').length,
        15,
        `${modelFamily} has exactly 15 supervisor-first pairs`,
      );
    }

    checkEqual(
      check,
      new Set(plan.expectedPairs.map((pair) => pair.pairId)).size,
      plan.expectedPairs.length,
      'all pairIds are unique',
    );
    check(
      plan.expectedPairs.every(
        (pair) =>
          IDENTIFIER_FIELDS.every(
            (field) => typeof pair[field] === 'string' && IDENTIFIER_PATTERN.test(pair[field]),
          ) && pair.repetition === 1,
      ),
      'all identifiers use the required grammar and every repetition is 1',
    );
    check(acceptsPlan(plan), 'the built S0-B validator accepts the plan');

    checkDeepEqual(check, plan, secondPlan, 'building the plan twice yields deeply equal objects');
    const serializedPlan = JSON.stringify(plan);
    const serializedSecondPlan = JSON.stringify(secondPlan);
    checkDeepEqual(
      check,
      Buffer.from(serializedPlan),
      Buffer.from(serializedSecondPlan),
      'building the plan twice yields identical serialized JSON bytes',
    );
    checkEqual(check, fingerprint, secondFingerprint, 'building the plan twice yields the same fingerprint');
    checkDeepEqual(check, withFingerprint.plan, plan, 'the fingerprint helper returns the built plan');
    checkEqual(
      check,
      withFingerprint.planFingerprint,
      fingerprint,
      'the fingerprint helper uses the built S0-B fingerprint function',
    );

    for (const field of FINGERPRINT_FIELDS) {
      check(
        computeSupervisorBenchmarkPlanFingerprint(changePairField(plan, field)) !== fingerprint,
        `fingerprint changes when expected pair ${field} changes`,
      );
    }
    check(
      computeSupervisorBenchmarkPlanFingerprint({ ...plan, sourceSha: 'b'.repeat(40) }) !== fingerprint,
      'fingerprint changes when sourceSha changes',
    );

    const reorderedPlan = { ...plan, expectedPairs: [...plan.expectedPairs].reverse() };
    checkEqual(
      check,
      computeSupervisorBenchmarkPlanFingerprint(reorderedPlan),
      fingerprint,
      'reordering expectedPairs does not change the canonical fingerprint',
    );
    check(acceptsPlan(reorderedPlan), 'reordering expectedPairs still passes validation');

    return result.status === 'pass'
      ? { status: 'pass', reason: 'deterministic benchmark plan generation and fingerprint binding verified' }
      : { status: 'fail', reason: 'plan assertions failed' };
  } finally {
    await cleanup.cleanupAll();
  }
}
