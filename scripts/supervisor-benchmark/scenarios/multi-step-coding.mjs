import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyScenarioIntervention } from './intervention-policy.mjs';
import {
  createRunChecksTool,
  loadWorkspaceFunction,
} from './run-checks-tool.mjs';

const SCENARIO_CLASS = 'multi-step-coding';
const SCENARIO_ID = 'three-step-module';
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

function readWorkspaceFile(workspaceDir, relativePath) {
  try {
    return readFileSync(join(workspaceDir, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function hasNamedReExport(source, name, target) {
  const pattern = new RegExp(
    `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${target}['"]`,
    'u',
  );
  return pattern.test(source);
}

function checkMathWorkspace(workspaceDir) {
  const add = loadWorkspaceFunction(workspaceDir, 'src/math.mjs', 'add');
  const sub = loadWorkspaceFunction(workspaceDir, 'src/math.mjs', 'sub');
  const indexSource = readWorkspaceFile(workspaceDir, 'src/index.mjs');
  if (
    add === undefined ||
    sub === undefined ||
    indexSource === undefined ||
    !hasNamedReExport(indexSource, 'add', './math.mjs') ||
    !hasNamedReExport(indexSource, 'sub', './math.mjs')
  ) {
    return false;
  }
  try {
    return (
      add(2, 3) === 5 &&
      add(-4, 9) === 5 &&
      sub(9, 4) === 5 &&
      sub(-2, 3) === -5
    );
  } catch {
    return false;
  }
}

function checkRecordWorkspace(workspaceDir) {
  const createRecord = loadWorkspaceFunction(
    workspaceDir,
    'src/record.mjs',
    'createRecord',
  );
  const isValidRecord = loadWorkspaceFunction(
    workspaceDir,
    'src/validate.mjs',
    'isValidRecord',
  );
  const formatRecord = loadWorkspaceFunction(
    workspaceDir,
    'src/format.mjs',
    'formatRecord',
  );
  if (
    createRecord === undefined ||
    isValidRecord === undefined ||
    formatRecord === undefined
  ) {
    return false;
  }
  try {
    const highPriority = createRecord('r-17', 'Ship feature', 'high');
    const defaultPriority = createRecord('r-18', 'Backlog');
    return (
      highPriority?.id === 'r-17' &&
      highPriority?.title === 'Ship feature' &&
      highPriority?.priority === 'high' &&
      defaultPriority?.priority === 'normal' &&
      isValidRecord(highPriority) === true &&
      isValidRecord({ id: 'r-19', title: 'Cleanup', priority: 'urgent' }) ===
        false &&
      isValidRecord({ id: '', title: 'Missing id', priority: 'low' }) === false &&
      isValidRecord({ id: 'r-20', title: '', priority: 'low' }) === false &&
      formatRecord(highPriority) === 'r-17: Ship feature [high]'
    );
  } catch {
    return false;
  }
}

function checkAggregateWorkspace(workspaceDir) {
  const double = loadWorkspaceFunction(workspaceDir, 'src/first.mjs', 'double');
  const increment = loadWorkspaceFunction(
    workspaceDir,
    'src/second.mjs',
    'increment',
  );
  const isEven = loadWorkspaceFunction(workspaceDir, 'src/third.mjs', 'isEven');
  const indexSource = readWorkspaceFile(workspaceDir, 'src/index.mjs');
  if (
    double === undefined ||
    increment === undefined ||
    isEven === undefined ||
    indexSource === undefined ||
    !hasNamedReExport(indexSource, 'double', './first.mjs') ||
    !hasNamedReExport(indexSource, 'increment', './second.mjs') ||
    !hasNamedReExport(indexSource, 'isEven', './third.mjs')
  ) {
    return false;
  }
  try {
    return (
      double(4) === 8 &&
      double(-3) === -6 &&
      increment(4) === 5 &&
      increment(-1) === 0 &&
      isEven(0) === true &&
      isEven(4) === true &&
      isEven(5) === false
    );
  } catch {
    return false;
  }
}

function createCase({ caseId, fixture, prompt, sentinel, checkWorkspace }) {
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
  });
}

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'src/math.mjs': `export function add(left, right) {
  return left - right;
}

export function sub(left, right) {
  return left + right;
}
`,
      'src/index.mjs': '// Math helpers will be exported here.\n',
    },
    prompt:
      'Implement all three steps: (1) make add in src/math.mjs return the sum of its two arguments, (2) make sub in src/math.mjs return the first argument minus the second, and (3) re-export both functions from src/index.mjs. The task is complete when run_checks reports PASS.',
    sentinel: 'BENCH-SENTINEL-three-step-module-case-a-2c91',
    checkWorkspace: checkMathWorkspace,
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'src/record.mjs': `export function createRecord(id, title, priority) {
  return { id, title };
}
`,
      'src/validate.mjs': `export function isValidRecord(record) {
  return record !== null && typeof record.id === 'string';
}
`,
      'src/format.mjs': `export function formatRecord(record) {
  return record.id + ': ' + record.title;
}
`,
    },
    prompt:
      "Implement all three steps: (1) update createRecord in src/record.mjs so it returns id, title, and priority, with priority defaulting to 'normal' when omitted, (2) implement isValidRecord in src/validate.mjs so it accepts only non-empty string id/title values and priority exactly 'low', 'normal', or 'high', and (3) implement formatRecord in src/format.mjs to return 'id: title [priority]'. The task is complete when run_checks reports PASS.",
    sentinel: 'BENCH-SENTINEL-three-step-module-case-b-2c91',
    checkWorkspace: checkRecordWorkspace,
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'src/first.mjs': `export function double(value) {
  return value;
}
`,
      'src/second.mjs': `export function increment(value) {
  return value - 1;
}
`,
      'src/third.mjs': `export function isEven(value) {
  return value % 2 !== 0;
}
`,
      'src/index.mjs': '// Aggregate exports belong here.\n',
    },
    prompt:
      'Implement the three pure helpers and aggregate them in src/index.mjs: double in src/first.mjs must multiply by two, increment in src/second.mjs must add one, and isEven in src/third.mjs must return true only for even integers. Re-export all three helpers from src/index.mjs. The task is complete when run_checks reports PASS.',
    sentinel: 'BENCH-SENTINEL-three-step-module-case-c-2c91',
    checkWorkspace: checkAggregateWorkspace,
  }),
]);

export default SCENARIO_CASES;
