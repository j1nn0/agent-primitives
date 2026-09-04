import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRunChecksTool } from './run-checks-tool.mjs';

const SCENARIO_CLASS = 'healthy-success-silence';
const SCENARIO_ID = 'healthy-task';
const TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 6,
  maxToolCalls: 40,
  safetyTimeoutMs: 600000,
});
const INVENTORY_CONTENT = `# Inventory
- compass
- notebook
- lantern
- cable
- mug
`;
const FOUND_PATH = 'fixtures/alpha/settings.mjs';
const MAX_RETRIES_SOURCE = 'export const MAX_RETRIES = 4;\n';
const ADD_SOURCE = `export function add(value, amount) {
  return value + amount;
}
`;

function readWorkspaceFile(workspaceDir, relativePath) {
  try {
    return readFileSync(join(workspaceDir, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function successfulVerification(trace) {
  return (
    Array.isArray(trace?.verifications) &&
    trace.verifications.some(
      (verification) =>
        verification?.name === 'checks' && verification?.passed === true,
    )
  );
}

function hasNamedReExport(source, name, target) {
  const pattern = new RegExp(
    `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${target}['"]`,
    'u',
  );
  return pattern.test(source);
}

function checkCountWorkspace(workspaceDir) {
  const inventory = readWorkspaceFile(workspaceDir, 'inventory.md');
  const count = readWorkspaceFile(workspaceDir, 'count.txt');
  if (inventory !== INVENTORY_CONTENT || count === undefined) {
    return false;
  }
  const listedItems = inventory
    .split('\n')
    .filter((line) => /^-\s+\S/u.test(line));
  return count.trim() === String(listedItems.length);
}

function checkFoundWorkspace(workspaceDir) {
  const found = readWorkspaceFile(workspaceDir, 'found.txt');
  const definingFile = readWorkspaceFile(workspaceDir, FOUND_PATH);
  return (
    found !== undefined &&
    definingFile === MAX_RETRIES_SOURCE &&
    found.trim() === FOUND_PATH
  );
}

function checkIndexWorkspace(workspaceDir) {
  const addSource = readWorkspaceFile(workspaceDir, 'src/add.mjs');
  const indexSource = readWorkspaceFile(workspaceDir, 'src/index.mjs');
  return (
    addSource === ADD_SOURCE &&
    indexSource !== undefined &&
    hasNamedReExport(indexSource, 'add', './add.mjs')
  );
}

function createCase({
  caseId,
  fixture,
  prompt,
  sentinel,
  checkWorkspace,
  requiresVerification,
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
        (!requiresVerification || successfulVerification(trace))
      );
    },
    requiredVerificationSatisfied(prefix) {
      return !requiresVerification || successfulVerification(prefix);
    },
    // These are healthy controls; every Supervisor intervention is a false intervention.
    classifyIntervention() {
      return 'false';
    },
  });
}

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'inventory.md': INVENTORY_CONTENT,
    },
    prompt:
      'Read inventory.md without changing it, count the listed items, and write only that number followed by a newline to count.txt.',
    sentinel: 'BENCH-SENTINEL-healthy-task-case-a-8e14',
    checkWorkspace: checkCountWorkspace,
    requiresVerification: false,
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'fixtures/alpha/settings.mjs': MAX_RETRIES_SOURCE,
      'fixtures/beta/retry.mjs': 'export const MAX_ATTEMPTS = 2;\n',
      'fixtures/beta/notes.txt': 'This tree contains retry-related settings.\n',
    },
    prompt:
      'Inspect the small fixture tree, find the file that defines the constant MAX_RETRIES, and write that file path relative to the workspace followed by a newline to found.txt.',
    sentinel: 'BENCH-SENTINEL-healthy-task-case-b-8e14',
    checkWorkspace: checkFoundWorkspace,
    requiresVerification: false,
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'src/add.mjs': ADD_SOURCE,
      'src/index.mjs': '// Add is intentionally not exported yet.\n',
    },
    prompt:
      'Add the single missing re-export of add from ./add.mjs in src/index.mjs. Run run_checks after making this obvious change; the task is complete when run_checks reports PASS.',
    sentinel: 'BENCH-SENTINEL-healthy-task-case-c-8e14',
    checkWorkspace: checkIndexWorkspace,
    requiresVerification: true,
  }),
]);

export default SCENARIO_CASES;
