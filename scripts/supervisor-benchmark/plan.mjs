import { computeSupervisorBenchmarkPlanFingerprint } from '../../packages/agent-supervisor-pi/dist/benchmark/plan.js';

const DEFAULT_BENCHMARK_ID = 'supervisor-post-s4-v1';
const DEFAULT_POLICY_ID = 'supervisor-release-v1';
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertSourceSha(sourceSha) {
  if (typeof sourceSha !== 'string' || !SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new TypeError('sourceSha must be a 40-character lowercase hexadecimal string.');
  }
}

export function buildSupervisorBenchmarkPlan({
  sourceSha,
  scenarioCases,
  modelFamilies,
  benchmarkId = DEFAULT_BENCHMARK_ID,
  policyId = DEFAULT_POLICY_ID,
}) {
  assertSourceSha(sourceSha);

  const orderedScenarioCases = [...scenarioCases].sort((left, right) => {
    const classOrder = compareStrings(left.scenarioClass, right.scenarioClass);
    return classOrder === 0 ? compareStrings(left.caseId, right.caseId) : classOrder;
  });

  const expectedPairs = [];
  for (let caseOrdinal = 0; caseOrdinal < orderedScenarioCases.length; caseOrdinal += 1) {
    const scenarioCase = orderedScenarioCases[caseOrdinal];
    for (let familyIndex = 0; familyIndex < modelFamilies.length; familyIndex += 1) {
      const modelFamily = modelFamilies[familyIndex];
      const baselineFirst = (caseOrdinal + familyIndex) % 2 === 0;
      // Opposite order for the two families of each case yields 30/30 overall and 15/15 per family.
      expectedPairs.push({
        pairId: `pair-${scenarioCase.scenarioId}-${scenarioCase.caseId}-${modelFamily.modelFamily}`,
        scenarioClass: scenarioCase.scenarioClass,
        scenarioId: scenarioCase.scenarioId,
        caseId: scenarioCase.caseId,
        modelFamily: modelFamily.modelFamily,
        modelId: modelFamily.modelId,
        executionProfile: baselineFirst
          ? 'pi0844-max-baseline-first'
          : 'pi0844-max-supervisor-first',
        repetition: 1,
      });
    }
  }

  return {
    schemaVersion: 1,
    benchmarkId,
    sourceSha,
    policyId,
    expectedPairs,
  };
}

export function buildSupervisorBenchmarkPlanWithFingerprint(options) {
  const plan = buildSupervisorBenchmarkPlan(options);
  return {
    plan,
    planFingerprint: computeSupervisorBenchmarkPlanFingerprint(plan),
  };
}
