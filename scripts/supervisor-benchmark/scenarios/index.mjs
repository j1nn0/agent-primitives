import { SCENARIO_CASES as repeatedFailingInvocationCases } from './repeated-failing-invocation.mjs';
import { SCENARIO_CASES as ambiguousToolFailureCases } from './ambiguous-tool-failure.mjs';
import { SCENARIO_CASES as prematureCompletionNoVerificationCases } from './premature-completion-no-verification.mjs';
import { SCENARIO_CASES as mutationAfterLastVerificationCases } from './mutation-after-last-verification.mjs';
import { SCENARIO_CASES as failedVerificationFalseCompletionCases } from './failed-verification-false-completion.mjs';
import { SCENARIO_CASES as multiStepCodingCases } from './multi-step-coding.mjs';
import { SCENARIO_CASES as researchAndImplementationCases } from './research-and-implementation.mjs';
import { SCENARIO_CASES as healthySuccessSilenceCases } from './healthy-success-silence.mjs';
import { SCENARIO_CASES as contextCompactionCases } from './context-compaction.mjs';
import { SCENARIO_CASES as sessionResumeCases } from './session-resume.mjs';
const SCENARIO_IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CASE_IDS = new Set(['case-a', 'case-b', 'case-c']);

export const SCENARIO_CASES = Object.freeze([
  ...repeatedFailingInvocationCases,
  ...ambiguousToolFailureCases,
  ...prematureCompletionNoVerificationCases,
  ...mutationAfterLastVerificationCases,
  ...failedVerificationFalseCompletionCases,
  ...multiStepCodingCases,
  ...researchAndImplementationCases,
  ...healthySuccessSilenceCases,
  ...contextCompactionCases,
  ...sessionResumeCases,
]);

export function getScenarioCases() {
  return SCENARIO_CASES;
}

export function validateScenarioRegistry() {
  if (!Array.isArray(SCENARIO_CASES) || !Object.isFrozen(SCENARIO_CASES)) {
    throw new Error('Scenario registry must be a frozen array.');
  }

  const seenCaseKeys = new Set();
  const casesByClass = new Map();
  for (const scenarioCase of SCENARIO_CASES) {
    if (scenarioCase === null || typeof scenarioCase !== 'object') {
      throw new Error('Scenario registry contains a non-object case.');
    }

    for (const name of ['scenarioClass', 'scenarioId', 'caseId']) {
      if (
        typeof scenarioCase[name] !== 'string' ||
        !SCENARIO_IDENTIFIER.test(scenarioCase[name])
      ) {
        throw new Error(`Scenario registry contains an invalid ${name}.`);
      }
    }
    if (!CASE_IDS.has(scenarioCase.caseId)) {
      throw new Error(`Scenario registry contains an invalid caseId: ${scenarioCase.caseId}.`);
    }

    const caseKey = JSON.stringify([
      scenarioCase.scenarioClass,
      scenarioCase.caseId,
    ]);
    if (seenCaseKeys.has(caseKey)) {
      throw new Error(`Scenario registry contains a duplicate case: ${caseKey}.`);
    }
    seenCaseKeys.add(caseKey);
    casesByClass.set(
      scenarioCase.scenarioClass,
      (casesByClass.get(scenarioCase.scenarioClass) ?? 0) + 1,
    );
  }

  for (const [scenarioClass, count] of casesByClass) {
    if (count !== 3) {
      throw new Error(
        `Scenario class ${scenarioClass} must contain exactly three cases.`,
      );
    }
  }

  return true;
}
