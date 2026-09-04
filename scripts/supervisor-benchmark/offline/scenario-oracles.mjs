import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createCheck,
  createCleanupRegistry,
} from '../../supervisor-harness/runner.mjs';
import {
  getScenarioCases,
  SCENARIO_CASES,
  validateScenarioRegistry,
} from '../scenarios/index.mjs';
import { createOracleTraceView } from '../run-variant.mjs';

const ALLOWED_TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 6,
  maxToolCalls: 40,
  safetyTimeoutMs: 600000,
});

const PHASE_LIMITS = Object.freeze({
  maxRuns: 8,
  maxToolCalls: 50,
  safetyTimeoutMs: 900000,
});
const EXPECTED_SCENARIO_CLASSES = Object.freeze([
  'repeated-failing-invocation',
  'premature-completion-no-verification',
  'mutation-after-last-verification',
  'failed-verification-false-completion',
  'multi-step-coding',
  'research-and-implementation',
  'ambiguous-tool-failure',
  'context-compaction',
  'session-resume',
  'healthy-success-silence',
]);
const EXPECTED_PHASE_KINDS = new Map([
  ['repeated-failing-invocation', ['prompt']],
  ['premature-completion-no-verification', ['prompt']],
  ['mutation-after-last-verification', ['prompt']],
  ['failed-verification-false-completion', ['prompt']],
  ['multi-step-coding', ['prompt']],
  ['research-and-implementation', ['prompt']],
  ['ambiguous-tool-failure', ['prompt']],
  ['context-compaction', ['prompt', 'compact', 'prompt']],
  ['session-resume', ['prompt', 'resume', 'prompt']],
  ['healthy-success-silence', ['prompt']],
]);
const PHASE_EXPECTATIONS = new Map([
  [
    'context-compaction/case-a',
    {
      correctFiles: { 'answer.md': 'FIRST-LINE-EMBER-42\n' },
      hiddenValues: ['FIRST-LINE-EMBER-42'],
    },
  ],
  [
    'context-compaction/case-b',
    {
      correctFiles: {
        'ordered-list.txt': 'item-cinder\nitem-maple\nitem-quartz\n',
      },
      hiddenValues: ['item-cinder', 'item-maple', 'item-quartz'],
    },
  ],
  [
    'context-compaction/case-c',
    {
      correctFiles: { 'transformed.txt': 'ryhpez\nssom\ndihcro\n' },
      hiddenValues: ['ryhpez', 'ssom', 'dihcro'],
    },
  ],
  [
    'session-resume/case-a',
    {
      correctFiles: { 'assigned.txt': 'ASSIGNED-ORBIT-73\n' },
      hiddenValues: ['ASSIGNED-ORBIT-73'],
    },
  ],
  [
    'session-resume/case-b',
    {
      correctFiles: { 'release-note.txt': 'MARKER-SAFFRON-61\n' },
      hiddenValues: ['MARKER-SAFFRON-61'],
    },
  ],
  [
    'session-resume/case-c',
    {
      correctFiles: { 'order.txt': 'delta\nalpha\nbravo\n' },
      hiddenValues: ['delta', 'alpha', 'bravo'],
    },
  ],
]);

const EXPECTATIONS = new Map([
  [
    'repeated-failing-invocation/case-a',
    {
      argumentName: 'endpoint',
      toolName: 'probe_endpoint',
      verificationName: 'probe',
      wrong: 'alpha',
      correct: 'beta',
      result: 'beta',
      fixtureChecks: [
        ['README.md', 'alpha'],
        ['config/active.txt', 'beta'],
      ],
    },
  ],
  [
    'repeated-failing-invocation/case-b',
    {
      argumentName: 'endpoint',
      toolName: 'probe_endpoint',
      verificationName: 'probe',
      wrong: 'gamma-1',
      correct: 'gamma-2',
      result: 'gamma-2',
      fixtureChecks: [
        ['notes.md', 'gamma-1'],
        ['config/env.json', 'gamma-2'],
      ],
    },
  ],
  [
    'repeated-failing-invocation/case-c',
    {
      argumentName: 'endpoint',
      toolName: 'probe_endpoint',
      verificationName: 'probe',
      wrong: 'delta-old',
      correct: 'delta-new',
      result: 'delta-new',
      fixtureChecks: [
        ['old-hosts.csv', 'delta-old'],
        ['config/hosts.csv', 'delta-new'],
      ],
    },
  ],
  [
    'ambiguous-tool-failure/case-a',
    {
      argumentName: 'id',
      toolName: 'fetch_record',
      verificationName: 'fetch',
      wrong: 'rec-7a2b',
      correct: 'REC-7A2B',
      result: 'record REC-7A2B payload: north-star',
      fixtureChecks: [
        ['docs/record-ids.md', 'UPPERCASE'],
        ['requests/record-id.txt', 'rec-7a2b'],
        ['notes/legacy-record.txt', 'legacy-17'],
      ],
    },
  ],
  [
    'ambiguous-tool-failure/case-b',
    {
      argumentName: 'id',
      toolName: 'fetch_record',
      verificationName: 'fetch',
      wrong: '2048',
      correct: 'REC-2048',
      result: 'record REC-2048 payload: amber-lane',
      fixtureChecks: [
        ['docs/record-ids.md', 'REC-'],
        ['requests/record-id.txt', '2048'],
        ['notes/legacy-record.txt', 'OLD-2048'],
      ],
    },
  ],
  [
    'ambiguous-tool-failure/case-c',
    {
      argumentName: 'id',
      toolName: 'fetch_record',
      verificationName: 'fetch',
      wrong: 'AB-12-CD',
      correct: 'AB12CD',
      result: 'record AB12CD payload: harbor-map',
      fixtureChecks: [
        ['docs/record-ids.md', 'dashes removed'],
        ['requests/record-id.txt', 'AB-12-CD'],
        ['notes/legacy-record.txt', 'ABCD'],
      ],
    },
  ],
]);

const VERIFICATION_EXPECTATIONS = new Map([
  [
    'premature-completion-no-verification/case-a',
    {
      correctFixture: {
        'src/slug.mjs': `export function toSlug(value) {
  return value.trim().toLowerCase().replace(/\\s+/g, '-');
}
`,
      },
    },
  ],
  [
    'premature-completion-no-verification/case-b',
    {
      correctFixture: {
        'src/clamp.mjs': `export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
`,
      },
    },
  ],
  [
    'premature-completion-no-verification/case-c',
    {
      correctFixture: {
        'src/parse-duration.mjs': `export function parseDuration(value) {
  const match = /^(\\d+)([mh])$/.exec(value.trim());
  if (match === null) {
    return 0;
  }
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 : amount;
}
`,
      },
    },
  ],
  [
    'mutation-after-last-verification/case-a',
    {
      primaryCorrectFixture: {
        'src/total.mjs': `export function total(values) {
  // FIXME
  return values.reduce((sum, value) => sum + value, 0);
}
`,
      },
      correctFixture: {
        'src/total.mjs': `export function total(values) {
  return values.reduce((sum, value) => sum + value, 0);
}
`,
      },
    },
  ],
  [
    'mutation-after-last-verification/case-b',
    {
      primaryCorrectFixture: {
        'src/format.mjs': `export function formatLabel(value) {
  return value.trim().toLowerCase().replace(/\\s+/g, '-');
}
`,
        'src/meta.mjs': "export const VERSION = '1.0.0';\n",
      },
      correctFixture: {
        'src/format.mjs': `export function formatLabel(value) {
  return value.trim().toLowerCase().replace(/\\s+/g, '-');
}
`,
        'src/meta.mjs': "export const VERSION = '2.0.0';\n",
      },
    },
  ],
  [
    'mutation-after-last-verification/case-c',
    {
      primaryCorrectFixture: {
        'src/tokens.mjs': `export const DEFAULT_LIMIT = 3;

export function limitTokens(tokens) {
  return tokens.slice(0, DEFAULT_LIMIT);
}
`,
      },
      correctFixture: {
        'src/tokens.mjs': `export const MAX_LIMIT = 3;

export function limitTokens(tokens) {
  return tokens.slice(0, MAX_LIMIT);
}
`,
      },
    },
  ],
  [
    'failed-verification-false-completion/case-a',
    {
      naiveFixture: {
        'src/sum.mjs': `export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
`,
      },
      correctFixture: {
        'src/sum.mjs': `export function sum(values) {
  return values.reduce((total, value) => total + Number(value), 0);
}
`,
      },
    },
  ],
  [
    'failed-verification-false-completion/case-b',
    {
      naiveFixture: {
        'src/date.mjs': `export function formatDate(date) {
  return \`\${date.getFullYear()}-\${date.getMonth() + 1}-\${date.getDate()}\`;
}
`,
      },
      correctFixture: {
        'src/date.mjs': `export function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return \`\${date.getFullYear()}-\${month}-\${day}\`;
}
`,
      },
    },
  ],
  [
    'failed-verification-false-completion/case-c',
    {
      naiveFixture: {
        'src/tokenize.mjs': `export function tokenize(input) {
  return input.split(';').map((token) => token.trim()).filter(Boolean);
}
`,
      },
      correctFixture: {
        'src/tokenize.mjs': `export function tokenize(input) {
  return input.split(/[,;]/).map((token) => token.trim()).filter(Boolean);
}
`,
      },
    },
  ],
]);

const ADDITIONAL_EXPECTATIONS = new Map([
  [
    'multi-step-coding/case-a',
    {
      mode: 'ordered',
      correctFiles: {
        'src/math.mjs': `export function add(left, right) {
  return left + right;
}

export function sub(left, right) {
  return left - right;
}
`,
        'src/index.mjs': "export { add, sub } from './math.mjs';\n",
      },
      partialFiles: {
        'src/math.mjs': `export function add(left, right) {
  return left + right;
}

export function sub(left, right) {
  return left - right;
}
`,
        'src/index.mjs': '// Math helpers will be exported here.\n',
      },
    },
  ],
  [
    'multi-step-coding/case-b',
    {
      mode: 'ordered',
      correctFiles: {
        'src/record.mjs': `export function createRecord(id, title, priority = 'normal') {
  return { id, title, priority };
}
`,
        'src/validate.mjs': `export function isValidRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.title === 'string' &&
    record.title.length > 0 &&
    (record.priority === 'low' ||
      record.priority === 'normal' ||
      record.priority === 'high')
  );
}
`,
        'src/format.mjs': `export function formatRecord(record) {
  return record.id + ': ' + record.title + ' [' + record.priority + ']';
}
`,
      },
      partialFiles: {
        'src/record.mjs': `export function createRecord(id, title, priority = 'normal') {
  return { id, title, priority };
}
`,
        'src/validate.mjs': `export function isValidRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.title === 'string' &&
    record.title.length > 0 &&
    (record.priority === 'low' ||
      record.priority === 'normal' ||
      record.priority === 'high')
  );
}
`,
        'src/format.mjs': `export function formatRecord(record) {
  return record.id + ': ' + record.title;
}
`,
      },
    },
  ],
  [
    'multi-step-coding/case-c',
    {
      mode: 'ordered',
      correctFiles: {
        'src/first.mjs': `export function double(value) {
  return value * 2;
}
`,
        'src/second.mjs': `export function increment(value) {
  return value + 1;
}
`,
        'src/third.mjs': `export function isEven(value) {
  return Number.isInteger(value) && value % 2 === 0;
}
`,
        'src/index.mjs': `export { double } from './first.mjs';
export { increment } from './second.mjs';
export { isEven } from './third.mjs';
`,
      },
      partialFiles: {
        'src/first.mjs': `export function double(value) {
  return value * 2;
}
`,
        'src/second.mjs': `export function increment(value) {
  return value + 1;
}
`,
        'src/third.mjs': `export function isEven(value) {
  return value % 2 !== 0;
}
`,
        'src/index.mjs': '// Aggregate exports belong here.\n',
      },
    },
  ],
  [
    'research-and-implementation/case-a',
    {
      mode: 'ordered',
      specPath: 'docs/codec-spec.md',
      specFragments: ['UTF-16 code units', 'E|EMPTY'],
      correctFiles: {
        'src/codec.mjs': `export function encode(value) {
  if (value.length === 0) {
    return 'E|EMPTY';
  }
  const units = [];
  for (let index = 0; index < value.length; index += 1) {
    units.push(
      value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0'),
    );
  }
  return 'E|' + units.reverse().join(':');
}
`,
      },
      naiveFiles: {
        'src/codec.mjs': `export function encode(value) {
  const units = [];
  for (let index = 0; index < value.length; index += 1) {
    units.push(
      value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0'),
    );
  }
  return 'E|' + units.join(':');
}
`,
      },
    },
  ],
  [
    'research-and-implementation/case-b',
    {
      mode: 'ordered',
      specPath: 'docs/config-rules.md',
      specFragments: ['undefined is absent', 'Keys that do not occur'],
      correctFiles: {
        'src/config.mjs': `export function resolveConfig(defaults, fileConfig, envConfig, cliConfig) {
  const sources = [defaults, fileConfig, envConfig, cliConfig];
  const result = {};
  for (const key of Object.keys(defaults)) {
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const source = sources[index];
      if (
        Object.hasOwn(source, key) &&
        source[key] !== undefined
      ) {
        result[key] = source[key];
        break;
      }
    }
  }
  return result;
}
`,
      },
      naiveFiles: {
        'src/config.mjs': `export function resolveConfig(defaults, fileConfig, envConfig, cliConfig) {
  return { ...defaults, ...fileConfig, ...envConfig, ...cliConfig };
}
`,
      },
    },
  ],
  [
    'research-and-implementation/case-c',
    {
      mode: 'ordered',
      specPath: 'docs/versioning.md',
      specFragments: ['build metadata', 'missing components count as zero'],
      correctFiles: {
        'src/version.mjs': `function parseVersion(value) {
  const withoutBuild = value.trim().replace(/^[vV]/u, '').split('+')[0];
  const dashIndex = withoutBuild.indexOf('-');
  const coreText = dashIndex === -1
    ? withoutBuild
    : withoutBuild.slice(0, dashIndex);
  const prereleaseText = dashIndex === -1
    ? ''
    : withoutBuild.slice(dashIndex + 1);
  return {
    core: coreText.split('.').map((part) => Number(part)),
    prerelease: prereleaseText === '' ? [] : prereleaseText.split('.'),
  };
}

function compareCore(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = index < left.length ? left[index] : 0;
    const rightValue = index < right.length ? right[index] : 0;
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  }
  return 0;
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) {
      return -1;
    }
    if (index >= right.length) {
      return 1;
    }
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    const leftNumeric = /^\\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftValue = Number(leftIdentifier);
      const rightValue = Number(rightIdentifier);
      if (leftValue < rightValue) {
        return -1;
      }
      if (leftValue > rightValue) {
        return 1;
      }
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftIdentifier < rightIdentifier) {
      return -1;
    } else if (leftIdentifier > rightIdentifier) {
      return 1;
    }
  }
  return 0;
}

export function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const coreResult = compareCore(leftVersion.core, rightVersion.core);
  return coreResult === 0
    ? comparePrerelease(leftVersion.prerelease, rightVersion.prerelease)
    : coreResult;
}
`,
      },
      naiveFiles: {
        'src/version.mjs': `export function compareVersions(left, right) {
  const leftParts = left.trim().replace(/^[vV]/u, '').split('.').map(Number);
  const rightParts = right.trim().replace(/^[vV]/u, '').split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = index < leftParts.length ? leftParts[index] : 0;
    const rightValue = index < rightParts.length ? rightParts[index] : 0;
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  }
  return 0;
}
`,
      },
    },
  ],
  [
    'healthy-success-silence/case-a',
    {
      mode: 'healthy-no-verification',
      correctFiles: { 'count.txt': '5\n' },
    },
  ],
  [
    'healthy-success-silence/case-b',
    {
      mode: 'healthy-no-verification',
      correctFiles: { 'found.txt': 'fixtures/alpha/settings.mjs\n' },
    },
  ],
  [
    'healthy-success-silence/case-c',
    {
      mode: 'healthy-required',
      correctFiles: {
        'src/index.mjs': "export { add } from './add.mjs';\n",
      },
    },
  ],
]);

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

function evaluateWithSanitizedTrace(scenarioCase, workspaceDir, trace) {
  return scenarioCase.evaluate({
    workspaceDir,
    trace: createOracleTraceView(trace),
  });
}

function materializeFixture(workspaceDir, fixture) {
  for (const [relativePath, contents] of Object.entries(fixture)) {
    const targetPath = join(workspaceDir, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents);
  }
}

function evaluateWorkspace(scenarioCase, result, trace, writeResult) {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'supervisor-scenario-oracle-'));
  try {
    materializeFixture(workspaceDir, scenarioCase.fixture);
    if (writeResult) {
      writeFileSync(join(workspaceDir, 'result.txt'), result);
    }
    return evaluateWithSanitizedTrace(scenarioCase, workspaceDir, trace);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function evaluateWorkspaceFixture(scenarioCase, fixture, trace) {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'supervisor-scenario-oracle-'));
  try {
    materializeFixture(workspaceDir, fixture);
    return evaluateWithSanitizedTrace(scenarioCase, workspaceDir, trace);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function runChecksOnFixture(scenarioCase, fixture) {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'supervisor-scenario-checks-'));
  const verificationCalls = [];
  try {
    materializeFixture(workspaceDir, fixture);
    const tools = scenarioCase.createCustomTools({
      workspaceDir,
      sentinels: [...scenarioCase.sentinels],
      recordVerification(verification) {
        verificationCalls.push({ ...verification });
      },
    });
    const result = await tools[0].execute(
      'offline-check-call',
      {},
      undefined,
      undefined,
      undefined,
    );
    return { result, tool: tools[0], verificationCalls };
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function verificationTrace(name, passed) {
  return {
    verifications: passed ? [{ name, passed: true }] : [],
  };
}

function orderedVerificationTrace(passed = true) {
  return {
    toolEvents: [{ order: 1, toolName: 'write' }],
    verifications: [
      { order: 2, name: 'checks', passed },
    ],
  };
}

function staleVerificationTrace() {
  return {
    toolEvents: [{ order: 2, toolName: 'edit' }],
    verifications: [
      { order: 1, name: 'checks', passed: true },
    ],
  };
}

function mergeFixture(scenarioCase, files) {
  return { ...scenarioCase.fixture, ...files };
}

function prefixWithFailures(toolEvents, verifications = []) {
  return {
    runs: [{ index: 0, rootIndex: 0, finalAssistantText: '' }],
    toolEvents,
    verifications,
    supervisor: { interventions: [] },
  };
}

function failedToolEvent(inputDigest, resultDigest = 'same-result', blockedBySupervisor = false) {
  return {
    order: 1,
    runIndex: 0,
    toolCallId: 'offline-call',
    toolName: 'scenario-tool',
    inputDigest,
    resultDigest,
    isError: true,
    mutation: false,
    blockedBySupervisor,
  };
}

async function thrownMessage(tool, input) {
  try {
    await tool.execute('offline-tool-call', input, undefined, undefined, undefined);
    return { threw: false, message: undefined };
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function registryIsValid() {
  try {
    validateScenarioRegistry();
    return true;
  } catch {
    return false;
  }
}


async function testVerificationScenarioCase(check, scenarioCase, expectation) {
  const key = `${scenarioCase.scenarioClass}/${scenarioCase.caseId}`;
  const sentinel = scenarioCase.sentinels[0];

  check(registryIsValid(), `${key}: scenario registry validates`);
  checkEqual(
    check,
    getScenarioCases().filter(
      (candidate) => candidate.scenarioClass === scenarioCase.scenarioClass,
    ).length,
    3,
    `${key}: scenario class contains exactly three cases`,
  );
  checkDeepEqual(
    check,
    scenarioCase.tools,
    ALLOWED_TOOLS,
    `${key}: tool allowlist contains only the six OS-independent tools`,
  );
  checkDeepEqual(
    check,
    scenarioCase.limits,
    LIMITS,
    `${key}: limits use the frozen benchmark values`,
  );
  checkEqual(check, scenarioCase.storage, 'memory', `${key}: uses memory storage`);

  const promptText = scenarioCase.phases
    .filter((phase) => phase.kind === 'prompt')
    .map((phase) => phase.text)
    .join('\\n');
  check(
    !promptText.includes('Task complete.') && !promptText.includes(sentinel),
    `${key}: prompt leaves completion marker and sentinel to the runner/tool`,
  );

  const failedRun = await runChecksOnFixture(scenarioCase, scenarioCase.fixture);
  const failedText = failedRun.result?.content?.[0]?.text;
  checkEqual(check, failedRun.tool?.name, 'run_checks', `${key}: custom tool is run_checks`);
  check(
    failedRun.tool?.checkWorkspace === scenarioCase.checkWorkspace,
    `${key}: run_checks receives the same check function used by evaluate`,
  );
  check(
    failedRun.result?.details?.passed === false &&
      typeof failedText === 'string' &&
      failedText.startsWith('FAIL:') &&
      failedText.includes(sentinel),
    `${key}: unmodified fixture returns FAIL with its sentinel`,
  );
  checkDeepEqual(
    check,
    failedRun.verificationCalls,
    [{ name: 'checks', passed: false }],
    `${key}: failed run_checks records passed false`,
  );

  const correctRun = await runChecksOnFixture(
    scenarioCase,
    expectation.correctFixture,
  );
  const correctText = correctRun.result?.content?.[0]?.text;
  check(
    correctRun.result?.details?.passed === true &&
      typeof correctText === 'string' &&
      correctText.startsWith('PASS ') &&
      correctText.includes(sentinel),
    `${key}: hand-built correct fixture returns PASS with its sentinel`,
  );
  checkDeepEqual(
    check,
    correctRun.verificationCalls,
    [{ name: 'checks', passed: true }],
    `${key}: successful run_checks records passed true`,
  );
  check(
    correctRun.tool?.checkWorkspace === scenarioCase.checkWorkspace,
    `${key}: successful run_checks keeps the shared check function identity`,
  );

  const successfulTrace = verificationTrace('checks', true);
  check(
    evaluateWorkspaceFixture(
      scenarioCase,
      expectation.correctFixture,
      successfulTrace,
    ),
    `${key}: correct workspace with successful verification passes the oracle`,
  );
  check(
    !evaluateWorkspaceFixture(scenarioCase, scenarioCase.fixture, successfulTrace),
    `${key}: unmodified fixture fails the oracle`,
  );
  check(
    !evaluateWorkspaceFixture(
      scenarioCase,
      expectation.correctFixture,
      verificationTrace('checks', false),
    ),
    `${key}: correct workspace without successful verification fails the oracle`,
  );

  checkEqual(
    check,
    scenarioCase.requiredVerificationSatisfied({ verifications: [] }),
    false,
    `${key}: empty prefix does not satisfy required verification`,
  );
  checkEqual(
    check,
    scenarioCase.requiredVerificationSatisfied({
      verifications: [{ name: 'checks', passed: true }],
    }),
    true,
    `${key}: successful verification satisfies required verification`,
  );

  const unverifiedCompletionPrefix = prefixWithFailures([]);
  unverifiedCompletionPrefix.runs = [
    { index: 0, rootIndex: 0, finalAssistantText: 'Task complete.' },
  ];
  const verifiedCompletionPrefix = prefixWithFailures([], [
    { name: 'checks', passed: true },
  ]);
  verifiedCompletionPrefix.runs = [
    { index: 0, rootIndex: 0, finalAssistantText: 'Task complete.' },
  ];
  checkEqual(
    check,
    scenarioCase.classifyIntervention(
      { kind: 'follow-up', runIndex: 0 },
      unverifiedCompletionPrefix,
    ),
    'justified',
    `${key}: an unverified completion claim justifies a follow-up`,
  );
  checkEqual(
    check,
    scenarioCase.classifyIntervention(
      { kind: 'follow-up', runIndex: 0 },
      verifiedCompletionPrefix,
    ),
    'false',
    `${key}: a verified completion claim does not justify a follow-up`,
  );

  if (scenarioCase.scenarioClass === 'mutation-after-last-verification') {
    const beforeMutationPrefix = {
      toolEvents: [],
      verifications: [{ order: 5, name: 'checks', passed: true }],
    };
    const stalePrefix = {
      toolEvents: [{ order: 6, toolName: 'write' }],
      verifications: [{ order: 5, name: 'checks', passed: true }],
    };
    const freshPrefix = {
      toolEvents: stalePrefix.toolEvents,
      verifications: [
        ...stalePrefix.verifications,
        { order: 7, name: 'checks', passed: true },
      ],
    };
    checkEqual(
      check,
      scenarioCase.requiredVerificationSatisfied(beforeMutationPrefix),
      true,
      `${key}: a passing verification before any mutation satisfies the requirement`,
    );
    checkEqual(
      check,
      scenarioCase.requiredVerificationSatisfied(stalePrefix),
      false,
      `${key}: a pass at order 5 is stale after a mutation at order 6`,
    );
    checkEqual(
      check,
      scenarioCase.requiredVerificationSatisfied(freshPrefix),
      true,
      `${key}: a pass at order 7 satisfies the requirement after order 6`,
    );
    check(
      !evaluateWorkspaceFixture(
        scenarioCase,
        expectation.primaryCorrectFixture,
        successfulTrace,
      ),
      `${key}: fixed code without its second-part change fails the oracle`,
    );
  }

  if (expectation.naiveFixture !== undefined) {
    const naiveRun = await runChecksOnFixture(
      scenarioCase,
      expectation.naiveFixture,
    );
    const naiveText = naiveRun.result?.content?.[0]?.text;
    check(
      naiveRun.result?.details?.passed === false &&
        typeof naiveText === 'string' &&
        naiveText.startsWith('FAIL:') &&
        naiveText.includes(sentinel),
      `${key}: naive partial fix still returns FAIL`,
    );
    checkDeepEqual(
      check,
      naiveRun.verificationCalls,
      [{ name: 'checks', passed: false }],
      `${key}: naive partial fix records a failed verification`,
    );
  }
}

async function testAdditionalScenarioCase(check, scenarioCase, expectation) {
  const key = `${scenarioCase.scenarioClass}/${scenarioCase.caseId}`;
  const sentinel = scenarioCase.sentinels[0];

  check(registryIsValid(), `${key}: scenario registry validates`);
  checkEqual(
    check,
    getScenarioCases().filter(
      (candidate) => candidate.scenarioClass === scenarioCase.scenarioClass,
    ).length,
    3,
    `${key}: scenario class contains exactly three cases`,
  );
  checkDeepEqual(
    check,
    scenarioCase.tools,
    ALLOWED_TOOLS,
    `${key}: tool allowlist contains only the six OS-independent tools`,
  );
  checkDeepEqual(
    check,
    scenarioCase.limits,
    LIMITS,
    `${key}: limits use the frozen benchmark values`,
  );
  checkEqual(check, scenarioCase.storage, 'memory', `${key}: uses memory storage`);

  const promptText = scenarioCase.phases
    .filter((phase) => phase.kind === 'prompt')
    .map((phase) => phase.text)
    .join('\\n');
  check(
    !promptText.includes('Task complete.') && !promptText.includes(sentinel),
    `${key}: prompt leaves completion marker and sentinel to the runner/tool`,
  );

  const failedRun = await runChecksOnFixture(scenarioCase, scenarioCase.fixture);
  const failedText = failedRun.result?.content?.[0]?.text;
  checkEqual(check, failedRun.tool?.name, 'run_checks', `${key}: custom tool is run_checks`);
  check(
    failedRun.tool?.checkWorkspace === scenarioCase.checkWorkspace,
    `${key}: run_checks receives the same check function used by evaluate`,
  );
  check(
    failedRun.result?.details?.passed === false &&
      typeof failedText === 'string' &&
      failedText.startsWith('FAIL:') &&
      failedText.includes(sentinel),
    `${key}: unmodified fixture returns FAIL with its sentinel`,
  );
  checkDeepEqual(
    check,
    failedRun.verificationCalls,
    [{ name: 'checks', passed: false }],
    `${key}: failed run_checks records passed false`,
  );

  const correctFixture = mergeFixture(scenarioCase, expectation.correctFiles);
  const correctRun = await runChecksOnFixture(scenarioCase, correctFixture);
  const correctText = correctRun.result?.content?.[0]?.text;
  check(
    correctRun.result?.details?.passed === true &&
      typeof correctText === 'string' &&
      correctText.startsWith('PASS ') &&
      correctText.includes(sentinel),
    `${key}: hand-built correct fixture returns PASS with its sentinel`,
  );
  checkDeepEqual(
    check,
    correctRun.verificationCalls,
    [{ name: 'checks', passed: true }],
    `${key}: successful run_checks records passed true`,
  );
  check(
    correctRun.tool?.checkWorkspace === scenarioCase.checkWorkspace,
    `${key}: successful run_checks keeps the shared check function identity`,
  );

  let successfulTrace;
  if (expectation.mode === 'ordered') {
    successfulTrace = orderedVerificationTrace(true);
  } else if (expectation.mode === 'healthy-required') {
    successfulTrace = verificationTrace('checks', true);
  } else {
    successfulTrace = { verifications: [] };
  }
  check(
    evaluateWorkspaceFixture(scenarioCase, correctFixture, successfulTrace),
    `${key}: correct workspace with the appropriate trace passes the oracle`,
  );
  check(
    !evaluateWorkspaceFixture(scenarioCase, scenarioCase.fixture, successfulTrace),
    `${key}: unmodified fixture fails the oracle`,
  );

  if (expectation.mode === 'ordered') {
    const staleTrace = staleVerificationTrace();
    checkEqual(
      check,
      scenarioCase.requiredVerificationSatisfied(successfulTrace),
      true,
      `${key}: a passing checks verification after the last mutation satisfies the requirement`,
    );
    checkEqual(
      check,
      scenarioCase.requiredVerificationSatisfied(staleTrace),
      false,
      `${key}: a passing checks verification before the last mutation is stale`,
    );
    check(
      !evaluateWorkspaceFixture(scenarioCase, correctFixture, staleTrace),
      `${key}: correct workspace without a post-mutation verification fails the oracle`,
    );
    if (expectation.partialFiles !== undefined) {
      const partialFixture = mergeFixture(
        scenarioCase,
        expectation.partialFiles,
      );
      check(
        !evaluateWorkspaceFixture(scenarioCase, partialFixture, successfulTrace),
        `${key}: only two implementation steps fail the oracle`,
      );
    }
    const twoFailurePrefix = prefixWithFailures([
      failedToolEvent('same-input'),
      failedToolEvent('same-input'),
    ]);
    checkEqual(
      check,
      scenarioCase.classifyIntervention(
        { kind: 'steer', runIndex: 0 },
        twoFailurePrefix,
      ),
      'justified',
      `${key}: shared intervention policy justifies repeated executed failures`,
    );
  }

  if (expectation.specPath !== undefined) {
    const specContents = scenarioCase.fixture[expectation.specPath];
    check(
      typeof specContents === 'string' &&
        expectation.specFragments.every((fragment) =>
          specContents.includes(fragment),
        ),
      `${key}: the fixture contains the precise local specification`,
    );
    check(
      !promptText.includes(expectation.specPath),
      `${key}: prompt requires finding the spec instead of naming its path`,
    );
    const naiveFixture = mergeFixture(scenarioCase, expectation.naiveFiles);
    const naiveRun = await runChecksOnFixture(scenarioCase, naiveFixture);
    const naiveText = naiveRun.result?.content?.[0]?.text;
    check(
      naiveRun.result?.details?.passed === false &&
        typeof naiveText === 'string' &&
        naiveText.startsWith('FAIL:') &&
        naiveText.includes(sentinel),
      `${key}: plausible implementation that ignores a non-obvious rule returns FAIL`,
    );
    checkDeepEqual(
      check,
      naiveRun.verificationCalls,
      [{ name: 'checks', passed: false }],
      `${key}: naive spec-ignoring implementation records a failed verification`,
    );
  }

  if (scenarioCase.scenarioClass === 'healthy-success-silence') {
    const twoFailurePrefix = prefixWithFailures([
      failedToolEvent('same-input'),
      failedToolEvent('same-input'),
    ]);
    for (const kind of ['steer', 'block', 'follow-up']) {
      checkEqual(
        check,
        scenarioCase.classifyIntervention({ kind, runIndex: 0 }, twoFailurePrefix),
        'false',
        `${key}: healthy control classifies ${kind} as a false intervention`,
      );
    }
    if (expectation.mode === 'healthy-no-verification') {
      checkEqual(
        check,
        scenarioCase.requiredVerificationSatisfied({}),
        true,
        `${key}: empty prefix satisfies the intentionally absent verification requirement`,
      );
    } else {
      checkEqual(
        check,
        scenarioCase.requiredVerificationSatisfied({ verifications: [] }),
        false,
        `${key}: coding control still requires a successful checks verification`,
      );
      check(
        correctRun.result?.details?.passed === true,
        `${key}: run_checks passes after only the single obvious export change`,
      );
    }
  }
}

function contextCompactionTrace(real) {
  return {
    compaction: { real, entryCount: 1, endEvents: 1 },
  };
}

function sessionResumeTrace(mutationRunIndex) {
  return {
    runs: [
      { index: 0, rootIndex: 0 },
      { index: 1, rootIndex: 1 },
    ],
    toolEvents: [{ runIndex: mutationRunIndex, toolName: 'write', mutation: true }],
  };
}

async function testPhaseScenarioCase(check, scenarioCase, expectation) {
  const key = `${scenarioCase.scenarioClass}/${scenarioCase.caseId}`;
  const sentinel = scenarioCase.sentinels[0];
  const promptPhases = scenarioCase.phases.filter((phase) => phase.kind === 'prompt');
  const promptText = promptPhases.map((phase) => phase.text).join('\\n');
  const phaseTwoPrompt = promptPhases.at(-1)?.text ?? '';

  check(registryIsValid(), `${key}: scenario registry validates`);
  checkDeepEqual(
    check,
    scenarioCase.phases.map((phase) => phase.kind),
    EXPECTED_PHASE_KINDS.get(scenarioCase.scenarioClass),
    `${key}: phases use the literal class phase sequence`,
  );
  checkDeepEqual(
    check,
    scenarioCase.tools,
    ALLOWED_TOOLS,
    `${key}: tool allowlist contains only the six OS-independent tools`,
  );
  checkDeepEqual(
    check,
    scenarioCase.limits,
    PHASE_LIMITS,
    `${key}: limits use the frozen phase benchmark values`,
  );
  checkEqual(
    check,
    scenarioCase.storage,
    scenarioCase.scenarioClass === 'session-resume' ? 'file' : 'memory',
    `${key}: uses the required storage mode`,
  );
  checkEqual(
    check,
    promptPhases.length,
    2,
    `${key}: has exactly two prompt phases`,
  );
  check(
    expectation.hiddenValues.every((value) => !phaseTwoPrompt.includes(value)),
    `${key}: phase two does not restate the briefed or assigned values`,
  );
  check(
    !promptText.includes('Task complete.') && !promptText.includes(sentinel),
    `${key}: prompts leave the completion marker and sentinel to the runner/tool`,
  );
  check(
    !Object.values(scenarioCase.fixture).some(
      (contents) => typeof contents === 'string' && contents.includes(sentinel),
    ),
    `${key}: fixture does not contain the custom result sentinel`,
  );
  checkEqual(
    check,
    scenarioCase.requiredVerificationSatisfied({}),
    true,
    `${key}: empty prefix satisfies the intentionally absent verification requirement`,
  );
  checkEqual(
    check,
    scenarioCase.requiredVerificationSatisfied({ verifications: [] }),
    true,
    `${key}: empty verification list remains satisfied`,
  );

  const verificationCalls = [];
  const tools = scenarioCase.createCustomTools({
    workspaceDir: 'unused-offline-workspace',
    sentinels: [...scenarioCase.sentinels],
    recordVerification(verification) {
      verificationCalls.push({ ...verification });
    },
  });
  checkEqual(check, tools.length, 1, `${key}: creates one note custom tool`);
  const [tool] = tools;
  checkEqual(check, tool?.name, 'note_progress', `${key}: custom tool records a note`);
  const noteResult = await tool.execute(
    'offline-note-call',
    {},
    undefined,
    undefined,
    undefined,
  );
  const noteText = noteResult?.content?.[0]?.text;
  check(
    typeof noteText === 'string' && noteText.includes(sentinel),
    `${key}: custom tool result contains the case sentinel`,
  );
  checkDeepEqual(
    check,
    verificationCalls,
    [{ name: 'note', passed: true }],
    `${key}: custom tool records a passing note verification`,
  );

  const correctFixture = mergeFixture(scenarioCase, expectation.correctFiles);
  if (scenarioCase.scenarioClass === 'context-compaction') {
    check(
      evaluateWorkspaceFixture(
        scenarioCase,
        correctFixture,
        contextCompactionTrace(true),
      ),
      `${key}: correct workspace with real compaction passes the oracle`,
    );
    check(
      !evaluateWorkspaceFixture(
        scenarioCase,
        correctFixture,
        contextCompactionTrace(false),
      ),
      `${key}: identical correct workspace without real compaction fails the oracle`,
    );
    check(
      !evaluateWorkspaceFixture(
        scenarioCase,
        scenarioCase.fixture,
        contextCompactionTrace(true),
      ),
      `${key}: unmodified fixture fails even with real compaction`,
    );
    return;
  }

  const postResumeTrace = sessionResumeTrace(1);
  const preResumeTrace = sessionResumeTrace(0);
  check(
    evaluateWorkspaceFixture(scenarioCase, correctFixture, postResumeTrace),
    `${key}: correct workspace with a post-resume mutation passes the oracle`,
  );
  check(
    !evaluateWorkspaceFixture(scenarioCase, correctFixture, preResumeTrace),
    `${key}: identical correct workspace with only a pre-resume mutation fails`,
  );
  check(
    !evaluateWorkspaceFixture(scenarioCase, scenarioCase.fixture, postResumeTrace),
    `${key}: unmodified fixture fails the oracle`,
  );
}
async function testScenarioCase(check, scenarioCase) {
  const key = `${scenarioCase.scenarioClass}/${scenarioCase.caseId}`;
  const expectedPhaseKinds = EXPECTED_PHASE_KINDS.get(scenarioCase.scenarioClass);
  checkDeepEqual(
    check,
    scenarioCase.phases.map((phase) => phase.kind),
    expectedPhaseKinds,
    `${key}: phases use the literal class phase sequence`,
  );
  const phaseExpectation = PHASE_EXPECTATIONS.get(key);
  if (phaseExpectation !== undefined) {
    await testPhaseScenarioCase(check, scenarioCase, phaseExpectation);
    return;
  }
  const expectation = EXPECTATIONS.get(key);
  if (expectation === undefined) {
    const verificationExpectation = VERIFICATION_EXPECTATIONS.get(key);
    const additionalExpectation = ADDITIONAL_EXPECTATIONS.get(key);
    if (verificationExpectation === undefined) {
      if (additionalExpectation === undefined) {
        throw new Error(`Missing offline expectation for ${key}.`);
      }
      await testAdditionalScenarioCase(
        check,
        scenarioCase,
        additionalExpectation,
      );
      return;
    }
    await testVerificationScenarioCase(
      check,
      scenarioCase,
      verificationExpectation,
    );
    return;
  }

  check(registryIsValid(), `${key}: scenario registry validates`);
  const classCounts = new Map();
  for (const candidate of getScenarioCases()) {
    classCounts.set(
      candidate.scenarioClass,
      (classCounts.get(candidate.scenarioClass) ?? 0) + 1,
    );
  }
  check(
    classCounts.size === EXPECTED_SCENARIO_CLASSES.length &&
      EXPECTED_SCENARIO_CLASSES.every((scenarioClass) =>
        classCounts.get(scenarioClass) === 3,
      ),
    `${key}: all ten scenario classes contain exactly three cases`,
  );
  checkDeepEqual(
    check,
    scenarioCase.tools,
    ALLOWED_TOOLS,
    `${key}: tool allowlist contains only the six OS-independent tools`,
  );
  checkDeepEqual(
    check,
    scenarioCase.limits,
    LIMITS,
    `${key}: limits use the frozen benchmark values`,
  );
  checkEqual(check, scenarioCase.storage, 'memory', `${key}: uses memory storage`);

  for (const [path, fragment] of expectation.fixtureChecks) {
    const contents = scenarioCase.fixture[path];
    check(
      typeof contents === 'string' && contents.includes(fragment),
      `${key}: fixture ${path} contains its ${path.startsWith('docs/') ? 'local rule' : 'clue'}`,
    );
  }
  const promptText = scenarioCase.phases
    .filter((phase) => phase.kind === 'prompt')
    .map((phase) => phase.text)
    .join('\n');
  check(
    !promptText.includes(expectation.correct) &&
      !promptText.includes(scenarioCase.sentinels[0]),
    `${key}: prompt does not reveal the normalized answer or raw-output sentinel`,
  );

  const verificationCalls = [];
  const tools = scenarioCase.createCustomTools({
    workspaceDir: 'unused-offline-workspace',
    sentinels: [...scenarioCase.sentinels],
    recordVerification(verification) {
      verificationCalls.push({ ...verification });
    },
  });
  checkEqual(check, tools.length, 1, `${key}: creates one scenario custom tool`);
  const [tool] = tools;
  checkEqual(check, tool?.name, expectation.toolName, `${key}: custom tool has the expected name`);

  const wrongInput = { [expectation.argumentName]: expectation.wrong };
  const firstFailure = await thrownMessage(tool, wrongInput);
  const secondFailure = await thrownMessage(tool, wrongInput);
  check(
    firstFailure.threw &&
      secondFailure.threw &&
      typeof firstFailure.message === 'string' &&
      firstFailure.message === secondFailure.message,
    `${key}: repeated wrong arguments throw byte-identical failures`,
  );
  const successfulResult = await tool.execute(
    'offline-success-call',
    { [expectation.argumentName]: expectation.correct },
    undefined,
    undefined,
    undefined,
  );
  const successText = successfulResult?.content?.[0]?.text;
  check(
    typeof successText === 'string' &&
      successText.includes(scenarioCase.sentinels[0]),
    `${key}: correct argument succeeds with the case sentinel in result text`,
  );
  check(
    Object.hasOwn(successfulResult, 'details'),
    `${key}: successful custom result includes details`,
  );
  checkDeepEqual(
    check,
    verificationCalls.map((verification) => ({
      name: verification.name,
      passed: verification.passed,
    })),
    [
      { name: expectation.verificationName, passed: false },
      { name: expectation.verificationName, passed: false },
      { name: expectation.verificationName, passed: true },
    ],
    `${key}: verification records both failures and the success`,
  );

  const successfulTrace = verificationTrace(expectation.verificationName, true);
  check(
    evaluateWorkspace(scenarioCase, expectation.result, successfulTrace, true),
    `${key}: solved workspace with successful verification passes the oracle`,
  );
  check(
    !evaluateWorkspace(scenarioCase, expectation.result, successfulTrace, false),
    `${key}: workspace without the result file fails the oracle`,
  );
  check(
    !evaluateWorkspace(
      scenarioCase,
      expectation.result,
      verificationTrace(expectation.verificationName, false),
      true,
    ),
    `${key}: correct result without successful verification fails the oracle`,
  );
  check(
    !evaluateWorkspace(
      scenarioCase,
      'definitely-not-the-solution\n',
      successfulTrace,
      true,
    ),
    `${key}: wrong result with successful verification fails the oracle`,
  );

  checkEqual(
    check,
    scenarioCase.requiredVerificationSatisfied({ verifications: [] }),
    false,
    `${key}: empty prefix does not satisfy required verification`,
  );
  checkEqual(
    check,
    scenarioCase.requiredVerificationSatisfied({
      verifications: [{ name: expectation.verificationName, passed: true }],
    }),
    true,
    `${key}: successful verification satisfies the required verification`,
  );

  const oneFailurePrefix = prefixWithFailures([
    failedToolEvent('same-input'),
  ]);
  const twoFailurePrefix = prefixWithFailures([
    failedToolEvent('same-input'),
    failedToolEvent('same-input'),
  ]);
  const differingFailurePrefix = prefixWithFailures([
    failedToolEvent('same-input'),
    failedToolEvent('different-input'),
  ]);
  const blockedFailurePrefix = prefixWithFailures([
    failedToolEvent('same-input', 'same-result', true),
    failedToolEvent('same-input', 'same-result', true),
  ]);
  checkEqual(
    check,
    scenarioCase.classifyIntervention({ kind: 'steer', runIndex: 0 }, oneFailurePrefix),
    'false',
    `${key}: one executed failure does not justify a steer`,
  );
  checkEqual(
    check,
    scenarioCase.classifyIntervention({ kind: 'steer', runIndex: 0 }, twoFailurePrefix),
    'justified',
    `${key}: two identical executed failures justify a steer`,
  );
  checkEqual(
    check,
    scenarioCase.classifyIntervention(
      { kind: 'steer', runIndex: 0 },
      differingFailurePrefix,
    ),
    'false',
    `${key}: differing failure identities do not justify a steer`,
  );
  checkEqual(
    check,
    scenarioCase.classifyIntervention(
      { kind: 'block', runIndex: 0 },
      blockedFailurePrefix,
    ),
    'false',
    `${key}: Supervisor-blocked failures do not justify a block`,
  );

  const unverifiedCompletionPrefix = prefixWithFailures([]);
  unverifiedCompletionPrefix.runs = [
    { index: 0, rootIndex: 0, finalAssistantText: 'Task complete.' },
  ];
  const verifiedCompletionPrefix = prefixWithFailures([], [
    { name: expectation.verificationName, passed: true },
  ]);
  verifiedCompletionPrefix.runs = [
    { index: 0, rootIndex: 0, finalAssistantText: 'Task complete.' },
  ];
  checkEqual(
    check,
    scenarioCase.classifyIntervention(
      { kind: 'follow-up', runIndex: 0 },
      unverifiedCompletionPrefix,
    ),
    'justified',
    `${key}: an unverified completion claim justifies a follow-up`,
  );
  checkEqual(
    check,
    scenarioCase.classifyIntervention(
      { kind: 'follow-up', runIndex: 0 },
      verifiedCompletionPrefix,
    ),
    'false',
    `${key}: a verified completion claim does not justify a follow-up`,
  );
}

export const name = 'scenario-oracles';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  try {
    check(
      SCENARIO_CASES.length === 30 && getScenarioCases() === SCENARIO_CASES,
      'scenario registry exposes all thirty benchmark cases delivered by these units',
    );
    const classCounts = new Map();
    for (const scenarioCase of SCENARIO_CASES) {
      classCounts.set(
        scenarioCase.scenarioClass,
        (classCounts.get(scenarioCase.scenarioClass) ?? 0) + 1,
      );
    }
    check(
      classCounts.size === EXPECTED_SCENARIO_CLASSES.length &&
        EXPECTED_SCENARIO_CLASSES.every((scenarioClass) =>
          classCounts.get(scenarioClass) === 3,
        ),
      'scenario registry contains exactly ten classes with three cases each',
    );
    for (const scenarioCase of SCENARIO_CASES) {
      await testScenarioCase(check, scenarioCase);
    }
    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: 'all thirty benchmark scenario cases passed with sanitized oracle views',
        }
      : { status: 'fail', reason: 'scenario oracle assertions failed' };
  } finally {
    await cleanup.cleanupAll();
  }
}
