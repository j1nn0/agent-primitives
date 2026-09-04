/* global console, process */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { computeSupervisorBenchmarkPlanFingerprint } from '../../packages/agent-supervisor-pi/dist/benchmark/plan.js';
import { SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1 } from '../../packages/agent-supervisor-pi/dist/benchmark/policy.js';
import { validateSupervisorBenchmarkPlan } from '../../packages/agent-supervisor-pi/dist/benchmark/validate.js';
import { BENCHMARK_MODEL_FAMILIES } from './models.mjs';
import { buildSupervisorBenchmarkPlan } from './plan.mjs';
import { SCENARIO_CASES, validateScenarioRegistry } from './scenarios/index.mjs';

const DEFAULT_OUT_PATH = 'benchmarks/supervisor-release-v1/plan.json';
const EXPECTED_CASE_COUNT = 30;
const EXPECTED_PAIR_COUNT = 60;
const EXPECTED_CASE_IDS = Object.freeze(['case-a', 'case-b', 'case-c']);
const EXPECTED_MODEL_FAMILIES = Object.freeze(['deepseek', 'openai']);
const BASELINE_FIRST_PROFILE = 'pi0844-max-baseline-first';
const SUPERVISOR_FIRST_PROFILE = 'pi0844-max-supervisor-first';
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareStrings);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(`Benchmark plan structural proof failed: ${message}`);
  }
}

function parseArguments(argv) {
  let sourceSha;
  let outPath = DEFAULT_OUT_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source-sha') {
      if (sourceSha !== undefined || index + 1 >= argv.length) {
        throw new Error('Usage: node scripts/supervisor-benchmark/generate-plan.mjs --source-sha <sha> [--out <path>]');
      }
      sourceSha = argv[index + 1];
      index += 1;
    } else if (argument === '--out') {
      if (index + 1 >= argv.length) {
        throw new Error('Usage: node scripts/supervisor-benchmark/generate-plan.mjs --source-sha <sha> [--out <path>]');
      }
      outPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (sourceSha === undefined) {
    throw new Error('Missing required --source-sha <sha>.');
  }
  return { sourceSha, outPath };
}

function proveStructure(plan) {
  const policyClasses = sortedUnique(SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.requiredScenarioClasses);
  const modelFamilies = BENCHMARK_MODEL_FAMILIES.map((modelFamily) => modelFamily.modelFamily);
  const orderedScenarioCases = [...SCENARIO_CASES].sort((left, right) => {
    const classOrder = compareStrings(left.scenarioClass, right.scenarioClass);
    return classOrder === 0 ? compareStrings(left.caseId, right.caseId) : classOrder;
  });

  requireCondition(orderedScenarioCases.length === EXPECTED_CASE_COUNT, `expected ${EXPECTED_CASE_COUNT} scenario cases`);
  requireCondition(
    sameArray(modelFamilies, EXPECTED_MODEL_FAMILIES),
    `expected model families ${EXPECTED_MODEL_FAMILIES.join(', ')}`,
  );
  requireCondition(plan.schemaVersion === 1, 'schemaVersion must be 1');
  requireCondition(plan.benchmarkId === 'supervisor-post-s4-v1', 'benchmarkId must be supervisor-post-s4-v1');
  requireCondition(plan.policyId === SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1.policyId, 'policyId must match the release policy');
  requireCondition(plan.expectedPairs.length === EXPECTED_PAIR_COUNT, `expected ${EXPECTED_PAIR_COUNT} expected pairs`);
  requireCondition(
    sameArray(sortedUnique(orderedScenarioCases.map((scenarioCase) => scenarioCase.scenarioClass)), policyClasses),
    'scenario registry classes must match the release policy classes',
  );
  requireCondition(
    sameArray(sortedUnique(plan.expectedPairs.map((pair) => pair.scenarioClass)), policyClasses),
    'plan classes must match the release policy classes',
  );
  requireCondition(
    sameArray(sortedUnique(plan.expectedPairs.map((pair) => pair.modelFamily)), EXPECTED_MODEL_FAMILIES),
    'plan must contain exactly the two model families',
  );
  requireCondition(
    new Set(plan.expectedPairs.map((pair) => pair.pairId)).size === EXPECTED_PAIR_COUNT,
    'pairIds must be unique',
  );

  const modelByFamily = new Map(BENCHMARK_MODEL_FAMILIES.map((modelFamily) => [modelFamily.modelFamily, modelFamily]));
  for (const pair of plan.expectedPairs) {
    requireCondition(
      [
        pair.pairId,
        pair.scenarioClass,
        pair.scenarioId,
        pair.caseId,
        pair.modelFamily,
        pair.executionProfile,
      ].every((value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value)),
      `pair ${String(pair.pairId)} contains an invalid identifier`,
    );
    requireCondition(pair.repetition === 1, `pair ${String(pair.pairId)} must have repetition 1`);
    const modelFamily = modelByFamily.get(pair.modelFamily);
    requireCondition(modelFamily !== undefined, `pair ${String(pair.pairId)} has an unknown model family`);
    requireCondition(pair.modelId === modelFamily.modelId, `pair ${String(pair.pairId)} has the wrong modelId`);
    requireCondition(
      pair.pairId === `pair-${pair.scenarioId}-${pair.caseId}-${pair.modelFamily}`,
      `pair ${String(pair.pairId)} has the wrong pairId`,
    );
  }

  const perClassPairCounts = {};
  const perClassPerFamilyPairCounts = {};
  for (const scenarioClass of policyClasses) {
    const classPairs = plan.expectedPairs.filter((pair) => pair.scenarioClass === scenarioClass);
    requireCondition(classPairs.length === 6, `${scenarioClass} must have exactly 6 pairs`);
    perClassPairCounts[scenarioClass] = classPairs.length;

    for (const modelFamily of EXPECTED_MODEL_FAMILIES) {
      const cellPairs = classPairs.filter((pair) => pair.modelFamily === modelFamily);
      requireCondition(cellPairs.length === 3, `${scenarioClass}/${modelFamily} must have exactly 3 pairs`);
      requireCondition(
        sameArray(sortedUnique(cellPairs.map((pair) => pair.caseId)), EXPECTED_CASE_IDS),
        `${scenarioClass}/${modelFamily} must contain case-a, case-b, and case-c`,
      );
      perClassPerFamilyPairCounts[`${scenarioClass}/${modelFamily}`] = cellPairs.length;
    }
  }

  for (let caseOrdinal = 0; caseOrdinal < orderedScenarioCases.length; caseOrdinal += 1) {
    const scenarioCase = orderedScenarioCases[caseOrdinal];
    for (let familyIndex = 0; familyIndex < BENCHMARK_MODEL_FAMILIES.length; familyIndex += 1) {
      const modelFamily = BENCHMARK_MODEL_FAMILIES[familyIndex];
      const matchingPairs = plan.expectedPairs.filter(
        (pair) =>
          pair.scenarioClass === scenarioCase.scenarioClass &&
          pair.scenarioId === scenarioCase.scenarioId &&
          pair.caseId === scenarioCase.caseId &&
          pair.modelFamily === modelFamily.modelFamily,
      );
      requireCondition(
        matchingPairs.length === 1,
        `${scenarioCase.scenarioClass}/${scenarioCase.caseId}/${modelFamily.modelFamily} must have one pair`,
      );
      const [pair] = matchingPairs;
      const expectedBaselineFirst = (caseOrdinal + familyIndex) % 2 === 0;
      requireCondition(
        pair.executionProfile ===
          (expectedBaselineFirst ? BASELINE_FIRST_PROFILE : SUPERVISOR_FIRST_PROFILE),
        `${pair.pairId} has the wrong execution order`,
      );
    }
  }

  const baselineFirstCount = plan.expectedPairs.filter(
    (pair) => pair.executionProfile === BASELINE_FIRST_PROFILE,
  ).length;
  const supervisorFirstCount = plan.expectedPairs.filter(
    (pair) => pair.executionProfile === SUPERVISOR_FIRST_PROFILE,
  ).length;
  requireCondition(baselineFirstCount === 30, 'expected exactly 30 baseline-first pairs');
  requireCondition(supervisorFirstCount === 30, 'expected exactly 30 supervisor-first pairs');

  const perFamilyOrderCounts = new Map();
  for (const modelFamily of EXPECTED_MODEL_FAMILIES) {
    const familyPairs = plan.expectedPairs.filter((pair) => pair.modelFamily === modelFamily);
    const baselineFirst = familyPairs.filter((pair) => pair.executionProfile === BASELINE_FIRST_PROFILE).length;
    const supervisorFirst = familyPairs.filter((pair) => pair.executionProfile === SUPERVISOR_FIRST_PROFILE).length;
    requireCondition(baselineFirst === 15 && supervisorFirst === 15, `${modelFamily} must have 15/15 order balance`);
    perFamilyOrderCounts.set(modelFamily, { baselineFirst, supervisorFirst });
  }

  return {
    expectedPairs: plan.expectedPairs.length,
    modelFamilies,
    perClassPairCounts,
    perClassPerFamilyPairCounts,
    baselineFirstCount,
    supervisorFirstCount,
    perFamilyOrderCounts: Object.fromEntries(perFamilyOrderCounts),
  };
}

function main() {
  const { sourceSha, outPath } = parseArguments(process.argv.slice(2));
  validateScenarioRegistry();
  const plan = buildSupervisorBenchmarkPlan({
    sourceSha,
    scenarioCases: SCENARIO_CASES,
    modelFamilies: BENCHMARK_MODEL_FAMILIES,
  });
  const validatedPlan = validateSupervisorBenchmarkPlan(plan);
  const fingerprint = computeSupervisorBenchmarkPlanFingerprint(validatedPlan);
  const summary = proveStructure(validatedPlan);

  const outputPath = resolve(outPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(validatedPlan, null, 2)}\n`, 'utf8');

  console.log(
    JSON.stringify(
      {
        ...summary,
        fingerprint,
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
