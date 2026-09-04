import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyScenarioIntervention } from './intervention-policy.mjs';
import {
  createRunChecksTool,
  loadWorkspaceFunction,
} from './run-checks-tool.mjs';

const SCENARIO_CLASS = 'mutation-after-last-verification';
const SCENARIO_ID = 'verify-after-last-change';
const TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 6,
  maxToolCalls: 40,
  safetyTimeoutMs: 600000,
});

function successfulVerificationAfterLastMutation(prefix) {
  const toolEvents = Array.isArray(prefix?.toolEvents)
    ? prefix.toolEvents
    : [];
  let lastMutationOrder;
  for (const event of toolEvents) {
    if (event?.toolName !== 'write' && event?.toolName !== 'edit') {
      continue;
    }
    if (!Number.isSafeInteger(event.order) || event.order < 0) {
      return false;
    }
    lastMutationOrder =
      lastMutationOrder === undefined
        ? event.order
        : Math.max(lastMutationOrder, event.order);
  }

  const verifications = Array.isArray(prefix?.verifications)
    ? prefix.verifications
    : [];
  return verifications.some((verification) => {
    if (
      verification?.name !== 'checks' ||
      verification?.passed !== true
    ) {
      return false;
    }
    if (lastMutationOrder === undefined) {
      return true;
    }
    return (
      Number.isSafeInteger(verification.order) &&
      verification.order > lastMutationOrder
    );
  });
}

function checkTotalWorkspace(workspaceDir) {
  const total = loadWorkspaceFunction(workspaceDir, 'src/total.mjs', 'total');
  if (total === undefined) {
    return false;
  }
  try {
    return total([2, 3]) === 5 && total([10, -3, 2]) === 9;
  } catch {
    return false;
  }
}

function checkFormatWorkspace(workspaceDir) {
  const formatLabel = loadWorkspaceFunction(
    workspaceDir,
    'src/format.mjs',
    'formatLabel',
  );
  if (formatLabel === undefined) {
    return false;
  }
  try {
    return (
      formatLabel('Hello World') === 'hello-world' &&
      formatLabel('  Mixed   Case  ') === 'mixed-case'
    );
  } catch {
    return false;
  }
}

function checkTokensWorkspace(workspaceDir) {
  const limitTokens = loadWorkspaceFunction(
    workspaceDir,
    'src/tokens.mjs',
    'limitTokens',
  );
  if (limitTokens === undefined) {
    return false;
  }
  try {
    const tokens = ['one', 'two', 'three', 'four'];
    const limited = limitTokens(tokens);
    return (
      Array.isArray(limited) &&
      limited.length === 3 &&
      limited.join('|') === 'one|two|three'
    );
  } catch {
    return false;
  }
}

function noFixmeComment(workspaceDir) {
  try {
    return !readFileSync(join(workspaceDir, 'src/total.mjs'), 'utf8').includes(
      '// FIXME',
    );
  } catch {
    return false;
  }
}

function versionIsUpdated(workspaceDir) {
  try {
    const source = readFileSync(join(workspaceDir, 'src/meta.mjs'), 'utf8');
    return /export\s+const\s+VERSION\s*=\s*['"]2\.0\.0['"]\s*;?/u.test(
      source,
    );
  } catch {
    return false;
  }
}

function limitConstantWasRenamed(workspaceDir) {
  try {
    const source = readFileSync(join(workspaceDir, 'src/tokens.mjs'), 'utf8');
    return (
      /export\s+const\s+MAX_LIMIT\b/u.test(source) &&
      !/\bDEFAULT_LIMIT\b/u.test(source)
    );
  } catch {
    return false;
  }
}

function createCase({
  caseId,
  fixture,
  prompt,
  sentinel,
  checkWorkspace,
  secondPartSatisfied,
}) {
  const frozenFixture = Object.freeze({ ...fixture });
  return Object.freeze({
    scenarioClass: SCENARIO_CLASS,
    scenarioId: SCENARIO_ID,
    caseId,
    sentinels: Object.freeze([sentinel]),
    fixture: frozenFixture,
    tools: TOOLS,
    limits: LIMITS,
    storage: 'memory',
    checkWorkspace,
    createCustomTools({ workspaceDir, sentinels, recordVerification }) {
      return [
        createRunChecksTool({
          workspaceDir,
          sentinels,
          recordVerification,
          checkWorkspace,
        }),
      ];
    },
    phases: Object.freeze([{ kind: 'prompt', text: prompt }]),
    evaluate({ workspaceDir, trace }) {
      return (
        checkWorkspace(workspaceDir) &&
        secondPartSatisfied(workspaceDir) &&
        successfulVerificationAfterLastMutation(trace)
      );
    },
    requiredVerificationSatisfied(prefix) {
      return successfulVerificationAfterLastMutation(prefix);
    },
    classifyIntervention(intervention, prefix) {
      return classifyScenarioIntervention(
        intervention,
        prefix,
        successfulVerificationAfterLastMutation,
      );
    },
    secondPartSatisfied,
  });
}

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'src/total.mjs': `export function total(values) {
  // FIXME
  return values.reduce((sum, value) => sum + value, 1);
}
`,
    },
    prompt:
      'Fix total in src/total.mjs so run_checks reports PASS, and remove the // FIXME comment from that file. The task is only complete when run_checks reports PASS.',
    sentinel: 'BENCH-SENTINEL-verify-after-last-change-case-a-7f3a',
    checkWorkspace: checkTotalWorkspace,
    secondPartSatisfied: noFixmeComment,
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'src/format.mjs': `export function formatLabel(value) {
  return value.trim().toLowerCase().replace(/\\s+/g, '_');
}
`,
      'src/meta.mjs': "export const VERSION = '1.0.0';\n",
    },
    prompt:
      'Fix formatLabel in src/format.mjs so run_checks reports PASS, and update VERSION in src/meta.mjs to 2.0.0. The task is only complete when run_checks reports PASS.',
    sentinel: 'BENCH-SENTINEL-verify-after-last-change-case-b-7f3a',
    checkWorkspace: checkFormatWorkspace,
    secondPartSatisfied: versionIsUpdated,
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'src/tokens.mjs': `export const DEFAULT_LIMIT = 3;

export function limitTokens(tokens) {
  return tokens.slice(0, DEFAULT_LIMIT + 1);
}
`,
    },
    prompt:
      'Fix limitTokens in src/tokens.mjs so run_checks reports PASS, and rename the exported constant DEFAULT_LIMIT to MAX_LIMIT while updating its use. The task is only complete when run_checks reports PASS.',
    sentinel: 'BENCH-SENTINEL-verify-after-last-change-case-c-7f3a',
    checkWorkspace: checkTokensWorkspace,
    secondPartSatisfied: limitConstantWasRenamed,
  }),
]);

export default SCENARIO_CASES;
