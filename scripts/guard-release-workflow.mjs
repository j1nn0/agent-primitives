import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/* global console, process */

const defaultRootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDirectory = resolve(process.argv[2] ?? process.env.RELEASE_GUARD_ROOT ?? defaultRootDirectory);
const workflowSources = [
  {
    name: 'release.yml',
    path: resolve(rootDirectory, '.github', 'workflows', 'release.yml'),
  },
  {
    name: 'ci.yml',
    path: resolve(rootDirectory, '.github', 'workflows', 'ci.yml'),
  },
];

const violations = [];
const workflows = new Map();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isRecord(value) && Object.hasOwn(value, key);
}

function describe(value) {
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value);
}

function addViolation(message) {
  violations.push(String(message).replace(/\s+/g, ' ').trim());
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    addViolation(`${label} must be a mapping.`);
    return false;
  }

  const expectedKeys = [...expected].sort();
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    addViolation(
      `${label} must contain exactly ${expectedKeys.join(', ')}; found ${actualKeys.join(', ') || 'none'}.`,
    );
    return false;
  }
  return true;
}

function exactMapping(value, expected, label) {
  if (!exactKeys(value, Object.keys(expected), label)) {
    if (!isRecord(value)) {
      return;
    }
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!isRecord(value) || value[key] !== expectedValue) {
      addViolation(`${label}.${key} must be ${describe(expectedValue)}; found ${describe(value?.[key])}.`);
    }
  }
}

function triggerMapping(document) {
  if (!isRecord(document)) {
    return undefined;
  }
  if (hasOwn(document, 'on')) {
    return document.on;
  }
  if (hasOwn(document, true)) {
    return document[true];
  }
  return undefined;
}

function stepRecords(document, jobName) {
  if (!isRecord(document?.jobs)) {
    return [];
  }

  const records = [];
  const jobEntries = jobName === undefined ? Object.entries(document.jobs) : [[jobName, document.jobs[jobName]]];
  for (const [currentJobName, job] of jobEntries) {
    if (!isRecord(job) || !Array.isArray(job.steps)) {
      continue;
    }
    job.steps.forEach((step, index) => {
      records.push({
        jobName: currentJobName,
        index,
        step,
      });
    });
  }
  return records;
}

function collectUses(value, path = [], references = []) {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => collectUses(nested, [...path, String(index)], references));
    return references;
  }
  if (!isRecord(value)) {
    return references;
  }

  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (key === 'uses') {
      references.push({ path: nestedPath.join('.'), value: nested });
    }
    collectUses(nested, nestedPath, references);
  }
  return references;
}

const useLinePattern = /^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(.*?))?\s*$/;
const pinnedActionPattern = /^[^@\s]+@[0-9a-fA-F]{40}$/;
const versionCommentPattern = /\bv\d+(?:\.\d+)*\b/i;

function checkActionPins(workflowName, raw, document) {
  const parsedReferences = document === null ? [] : collectUses(document);
  const rawReferences = [];

  raw.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(useLinePattern);
    if (match) {
      rawReferences.push({
        line: index + 1,
        value: match[1],
        comment: match[2] ?? '',
      });
    }
  });

  if (document !== null && parsedReferences.length !== rawReferences.length) {
    addViolation(
      `${workflowName} uses references could not be correlated between the parsed workflow and its source lines.`,
    );
  }

  for (const reference of parsedReferences) {
    if (typeof reference.value !== 'string' || !pinnedActionPattern.test(reference.value)) {
      addViolation(
        `${workflowName} ${reference.path} must use a full 40-character hexadecimal commit SHA; found ${describe(reference.value)}.`,
      );
    }
  }

  for (const reference of rawReferences) {
    if (document === null && !pinnedActionPattern.test(reference.value)) {
      addViolation(
        `${workflowName}:${reference.line} uses reference must use a full 40-character hexadecimal commit SHA; found ${reference.value}.`,
      );
    }
    if (!versionCommentPattern.test(reference.comment)) {
      addViolation(`${workflowName}:${reference.line} uses reference must have a same-line version comment.`);
    }
  }
}

function commandSegments(run) {
  return run
    .split(/\r?\n/)
    .flatMap((line) => line.split(/&&|\|\||[;|]/))
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

function hasPnpmPackInvocation(run, packageName) {
  return commandSegments(run).some((command) => {
    if (!/^pnpm(?:\s|$)/.test(command)) {
      return false;
    }
    const tokens = command.split(/\s+/);
    const filterIndex = tokens.indexOf('--filter');
    return filterIndex >= 0 && tokens[filterIndex + 1] === packageName && tokens.includes('pack');
  });
}

function firstShellArgument(argumentsText) {
  const match = argumentsText.match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

function npmPublishInvocations(records) {
  const invocations = [];
  for (const record of records) {
    if (!isRecord(record.step) || typeof record.step.run !== 'string') {
      continue;
    }
    for (const command of commandSegments(record.step.run)) {
      const match = command.match(/^(?:if\s+)?(?:!\s+)?npm\s+publish(?:\s+(.*))?$/);
      if (!match) {
        continue;
      }
      const argumentsText = match[1] ?? '';
      invocations.push({
        argumentsText,
        command,
        index: record.index,
        operand: firstShellArgument(argumentsText),
      });
    }
  }
  return invocations;
}

const expectedReleaseCommitEnv = 'RELEASE_COMMIT';
const expectedReleaseCommit = '${{ github.sha }}';
const expectedSlsaPredicate = 'https://slsa.dev/provenance/v1';
const expectedDsseEnvelope = 'dsseEnvelope';
const expectedBase64Decode = 'b64decode';
const expectedRepository = 'https://github.com/j1nn0/agent-primitives';
const expectedWorkflow = '.github/workflows/release.yml';
const expectedRef = 'refs/heads/main';
const expectedCommitField = 'gitCommit';

// Confirms the identity assertions remain in each provenance step; it is structural
// only and cannot prove the shell and Python semantics are correct.
function checkProvenanceIdentityStep({ step }, packageLabel) {
  const hasStepMapping = isRecord(step);
  const env = hasStepMapping ? step.env : undefined;
  if (!hasStepMapping || !isRecord(env)) {
    addViolation(
      `release.yml ${packageLabel} provenance verification step has no step-level environment for ${expectedReleaseCommitEnv}=${expectedReleaseCommit}.`
    );
  } else if (env[expectedReleaseCommitEnv] !== expectedReleaseCommit) {
    addViolation(
      `release.yml ${packageLabel} provenance verification step must set ${expectedReleaseCommitEnv} to ${expectedReleaseCommit}.`
    );
  }

  if (!hasStepMapping || typeof step.run !== 'string') {
    addViolation(`release.yml ${packageLabel} provenance verification step must have a string run script.`);
    return;
  }

  const run = step.run;
  if (!run.includes(expectedSlsaPredicate)) {
    addViolation(`release.yml ${packageLabel} provenance verification step must check the SLSA predicate type ${expectedSlsaPredicate}.`);
  }
  if (!run.includes(expectedDsseEnvelope) || !run.includes(expectedBase64Decode)) {
    addViolation(
      `release.yml ${packageLabel} provenance verification step must decode the DSSE payload using ${expectedDsseEnvelope} and ${expectedBase64Decode}.`
    );
  }
  if (!run.includes(expectedRepository)) {
    addViolation(`release.yml ${packageLabel} provenance verification step must verify repository ${expectedRepository}.`);
  }
  if (!run.includes(expectedWorkflow)) {
    addViolation(`release.yml ${packageLabel} provenance verification step must verify workflow ${expectedWorkflow}.`);
  }
  if (!run.includes(expectedRef)) {
    addViolation(`release.yml ${packageLabel} provenance verification step must verify ref ${expectedRef}.`);
  }
  if (!run.includes(expectedCommitField)) {
    addViolation(`release.yml ${packageLabel} provenance verification step must read the ${expectedCommitField} field.`);
  }
  if (!run.includes(expectedReleaseCommitEnv)) {
    addViolation(`release.yml ${packageLabel} provenance verification step must reference ${expectedReleaseCommitEnv} in its run script.`);
  }
}

const SMOKE_CANDIDATE_PATTERNS = [
  {
    job: 'validate',
    pattern: /^Smoke-test .+ packed artifacts in a fresh consumer$/,
    label: 'packed artifact smoke',
  },
  {
    job: 'registry-smoke',
    pattern: /^Smoke-test .+ on the public registry anonymously$/,
    label: 'registry smoke',
  },
];

function familyFromIf(step) {
  if (!isRecord(step) || typeof step.if !== 'string') {
    return null;
  }
  return step.if.match(/inputs\.family == '([^']*)'/)?.[1] ?? null;
}

function checkFamilySmokeWiring(document, expectedFamilyOptions) {
  for (const { job, pattern, label } of SMOKE_CANDIDATE_PATTERNS) {
    const familyCounts = new Map(expectedFamilyOptions.map((family) => [family, 0]));
    for (const { step } of stepRecords(document, job)) {
      if (!isRecord(step) || typeof step.name !== 'string' || !pattern.test(step.name)) {
        continue;
      }

      const family = familyFromIf(step);
      if (family === null || !expectedFamilyOptions.includes(family)) {
        addViolation(
          `release.yml job ${job} smoke step ${describe(step.name)} must be gated on exactly one expected family via its if condition; found ${describe(step.if)}.`,
        );
        continue;
      }
      familyCounts.set(family, familyCounts.get(family) + 1);
    }

    for (const family of expectedFamilyOptions) {
      const count = familyCounts.get(family) ?? 0;
      if (count !== 1) {
        addViolation(
          `release.yml job ${job} must contain exactly one ${label} step gated on inputs.family == '${family}'; found ${count}.`,
        );
      }
    }
  }
}

const FAMILY_SCOPED_VALIDATION_STEPS = [
  ['Build from a clean dist', 'build'],
  ['Typecheck', 'typecheck'],
  ['Test', 'test'],
  ['Check package quality', 'check:package'],
];
const packageSetAssertPrefix = 'pnpm list -r --filter "$ADAPTER_PKG_NAME..." --depth -1 --json';
const packageSetMarkers = ['actual.length!==expected.length', 'name!==expected[index]'];

function checkFamilyScopedStep(record, jobName, stepName, script) {
  const step = record?.step;
  if (!isRecord(step) || typeof step.run !== 'string') {
    addViolation(`release.yml job ${jobName} step ${stepName} must have a string run script.`);
    return;
  }

  const expectedInvocation = `pnpm -r --filter "$ADAPTER_PKG_NAME..." run ${script}`;
  if (!step.run.includes(expectedInvocation)) {
    addViolation(`release.yml job ${jobName} step ${stepName} must invoke ${expectedInvocation}.`);
  }
  if (!step.run.includes(packageSetAssertPrefix)) {
    addViolation(`release.yml job ${jobName} step ${stepName} must assert its exact family package set.`);
  }
  for (const marker of packageSetMarkers) {
    if (!step.run.includes(marker)) {
      addViolation(`release.yml job ${jobName} step ${stepName} must contain the exact package-set marker ${marker}.`);
    }
  }
}

function checkFamilyScopedValidation(document) {
  const validateRecords = stepRecords(document, 'validate');
  for (const [stepName, script] of FAMILY_SCOPED_VALIDATION_STEPS) {
    const matches = validateRecords.filter(({ step }) => isRecord(step) && step.name === stepName);
    if (matches.length !== 1) {
      addViolation(`release.yml validate job must contain exactly one ${stepName} step; found ${matches.length}.`);
    } else {
      checkFamilyScopedStep(matches[0], 'validate', stepName, script);
    }
  }

  const exampleMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === 'Run example');
  if (exampleMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one Run example step; found ${exampleMatches.length}.`);
  } else {
    const step = exampleMatches[0].step;
    exactMapping(step.env, { FAMILY: '${{ inputs.family }}' }, 'release.yml validate Run example environment');
    if (typeof step.run !== 'string') {
      addViolation('release.yml validate Run example step must have a string run script.');
    } else {
      if (!step.run.includes('pnpm run "example:${FAMILY}"')) {
        addViolation('release.yml validate Run example step must invoke the family-specific root example script.');
      }
      if (!step.run.includes('No root example script for family')) {
        addViolation('release.yml validate Run example step must check that the family-specific root example script exists.');
      }
    }
  }

  if (!validateRecords.some(({ step }) => isRecord(step) && step.name === 'Lint' && step.run === 'pnpm lint')) {
    addViolation('release.yml validate job must retain a repo-wide Lint step running pnpm lint.');
  }

  const forbiddenValidateCommands = new Set(['pnpm build', 'pnpm typecheck', 'pnpm test', 'pnpm check:package', 'pnpm example']);
  for (const { step } of validateRecords) {
    if (!isRecord(step) || typeof step.run !== 'string') {
      continue;
    }
    for (const command of commandSegments(step.run)) {
      if (forbiddenValidateCommands.has(command)) {
        addViolation(`release.yml validate job must not contain the repo-wide command ${command}.`);
      }
    }
  }

  const publishRecords = stepRecords(document, 'publish');
  const publishBuildMatches = publishRecords.filter(({ step }) => isRecord(step) && step.name === 'Build from a clean dist');
  if (publishBuildMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one Build from a clean dist step; found ${publishBuildMatches.length}.`);
  } else {
    checkFamilyScopedStep(publishBuildMatches[0], 'publish', 'Build from a clean dist', 'build');
  }
  for (const { step } of publishRecords) {
    if (!isRecord(step) || typeof step.run !== 'string') {
      continue;
    }
    for (const command of commandSegments(step.run)) {
      if (command === 'pnpm build') {
        addViolation('release.yml publish job must not contain the repo-wide command pnpm build.');
      }
    }
  }
}

function checkCiPreflight(document) {
  const validateRecords = stepRecords(document, 'validate');
  const preflightName = 'Require successful CI on the dispatched commit';
  const preflightMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === preflightName);
  if (preflightMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one ${preflightName} step; found ${preflightMatches.length}.`);
    return;
  }

  const setupMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === 'Set up pnpm');
  if (setupMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one Set up pnpm step; found ${setupMatches.length}.`);
  } else if (preflightMatches[0].index >= setupMatches[0].index) {
    addViolation(`release.yml ${preflightName} step must appear before Set up pnpm.`);
  }

  const step = preflightMatches[0].step;
  if (hasOwn(step, 'uses')) {
    addViolation(`release.yml ${preflightName} step must be a run step, not a uses step.`);
  }
  exactMapping(
    step.env,
    {
      DISPATCH_SHA: '${{ github.sha }}',
      REPOSITORY: '${{ github.repository }}',
      GH_TOKEN: '${{ github.token }}',
    },
    `release.yml ${preflightName} environment`,
  );
  if (typeof step.run !== 'string') {
    addViolation(`release.yml ${preflightName} step must have a string run script.`);
    return;
  }

  const run = step.run;
  for (const marker of [
    'head_sha=${DISPATCH_SHA}',
    'workflow=.github/workflows/ci.yml',
    'head_branch=main',
    'event=push',
    'r.get("status") == "completed"',
    'r.get("conclusion") == "success"',
    'r.get("head_sha") == sha',
    'r.get("event") == "push"',
    'r.get("head_branch") == "main"',
    'r.get("path") == ".github/workflows/ci.yml"',
    'max_attempts=30',
    'failing closed',
  ]) {
    if (!run.includes(marker)) {
      addViolation(`release.yml ${preflightName} step is missing the required marker ${marker}.`);
    }
  }
  if (run.includes('checks') || run.includes('/check-runs')) {
    addViolation(`release.yml ${preflightName} step must not use the Checks API.`);
  }
  if (!/failing closed[\s\S]*\bexit 1\b/.test(run)) {
    addViolation(`release.yml ${preflightName} step must fail closed with exit 1.`);
  }
}

function checkReleaseStructure(release) {
  const { raw, document } = release;
  if (!isRecord(document)) {
    addViolation('release.yml must contain a YAML mapping at its root.');
    return;
  }

  const triggers = triggerMapping(document);
  exactKeys(triggers, ['workflow_dispatch'], 'release.yml triggers');

  const workflowDispatch = isRecord(triggers) ? triggers.workflow_dispatch : undefined;
  const inputs = isRecord(workflowDispatch) ? workflowDispatch.inputs : undefined;
  const familyInput = isRecord(inputs) ? inputs.family : undefined;
  const expectedFamilyOptions = ['context-guard', 'agent-state', 'agent-progress', 'agent-retry-guard', 'agent-evidence', 'agent-handoff', 'agent-budget', 'agent-tool-policy'];
  if (!isRecord(familyInput)) {
    addViolation('release.yml workflow_dispatch must define a family input.');
  } else {
    if (familyInput.required !== true) {
      addViolation('release.yml family input must be required.');
    }
    if (familyInput.type !== 'choice') {
      addViolation('release.yml family input must have type choice.');
    }
    if (JSON.stringify(familyInput.options) !== JSON.stringify(expectedFamilyOptions)) {
      addViolation(
        `release.yml family input options must be exactly ${JSON.stringify(expectedFamilyOptions)}; found ${describe(familyInput.options)}.`,
      );
    }
    if (familyInput.default !== 'context-guard') {
      addViolation('release.yml family input must default to context-guard.');
    }
  }
  checkFamilySmokeWiring(document, expectedFamilyOptions);
  checkFamilyScopedValidation(document);
  checkCiPreflight(document);

  const jobs = document.jobs;
  const expectedJobs = ['validate', 'publish', 'registry-smoke'];
  exactKeys(jobs, expectedJobs, 'release.yml jobs');
  if (isRecord(jobs)) {
    for (const [jobName, job] of Object.entries(jobs)) {
      if (isRecord(job) && hasOwn(job, 'environment')) {
        addViolation(`release.yml job ${jobName} must not declare an environment.`);
      }
    }

    for (const [jobName, requiredNeed] of Object.entries({ publish: 'validate', 'registry-smoke': 'publish' })) {
      const job = jobs[jobName];
      if (!isRecord(job)) {
        addViolation(`release.yml job ${jobName} must be a mapping.`);
        continue;
      }
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      if (needs.length !== 1 || needs[0] !== requiredNeed) {
        addViolation(
          `release.yml job ${jobName} must need exactly ${requiredNeed}; found ${describe(job.needs)}.`,
        );
      }
    }
  }

  exactMapping(document.permissions, { contents: 'read' }, 'release.yml workflow permissions');
  if (isRecord(jobs)) {
    exactMapping(jobs.validate?.permissions, { actions: 'read', contents: 'read' }, 'release.yml validate permissions');
    exactMapping(
      jobs.publish?.permissions,
      { contents: 'read', 'id-token': 'write' },
      'release.yml publish permissions',
    );
    exactMapping(
      jobs['registry-smoke']?.permissions,
      { contents: 'read' },
      'release.yml registry-smoke permissions',
    );
  }

  const expectedFamilyEnvironment = {
    CORE_PKG_NAME: "${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress' || inputs.family == 'agent-state' && '@j1nn0/agent-state' || '@j1nn0/agent-context-guard' }}",
    ADAPTER_PKG_NAME: "${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}",
    CORE_PKG_DIR: "${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}",
    ADAPTER_PKG_DIR: "${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy-pi' || inputs.family == 'agent-budget' && 'packages/agent-budget-pi' || inputs.family == 'agent-handoff' && 'packages/agent-handoff-pi' || inputs.family == 'agent-evidence' && 'packages/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard-pi' || inputs.family == 'agent-progress' && 'packages/agent-progress-pi' || inputs.family == 'agent-state' && 'packages/agent-state-pi' || 'packages/context-guard-pi' }}",
    CORE_TARBALL_BASE: "${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}",
    ADAPTER_TARBALL_BASE: "${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy-pi' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget-pi' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff-pi' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence-pi' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard-pi' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress-pi' || inputs.family == 'agent-state' && 'j1nn0-agent-state-pi' || 'j1nn0-agent-context-guard-pi' }}",
  };
  if (isRecord(jobs)) {
    exactMapping(jobs.validate?.env, expectedFamilyEnvironment, 'release.yml validate family environment');
    exactMapping(jobs.publish?.env, expectedFamilyEnvironment, 'release.yml publish family environment');
    exactMapping(
      jobs['registry-smoke']?.env,
      {
        CORE_PKG_NAME: expectedFamilyEnvironment.CORE_PKG_NAME,
        ADAPTER_PKG_NAME: expectedFamilyEnvironment.ADAPTER_PKG_NAME,
      },
      'release.yml registry-smoke family environment',
    );
  }

  for (const token of ['NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    if (raw.includes(token)) {
      addViolation(`release.yml must not contain ${token}.`);
    }
  }
  if (/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/s.test(raw)) {
    addViolation('release.yml must not contain a secrets context reference.');
  }

  const releaseSteps = stepRecords(document);
  const corePackage = '"$CORE_PKG_NAME"';
  const adapterPackage = '"$ADAPTER_PKG_NAME"';
  const hasCorePack = releaseSteps.some(
    ({ step }) => isRecord(step) && typeof step.run === 'string' && hasPnpmPackInvocation(step.run, corePackage),
  );
  const hasAdapterPack = releaseSteps.some(
    ({ step }) => isRecord(step) && typeof step.run === 'string' && hasPnpmPackInvocation(step.run, adapterPackage),
  );
  if (!hasCorePack) {
    addViolation(`release.yml must contain a pnpm pack invocation filtered to ${corePackage}.`);
  }
  if (!hasAdapterPack) {
    addViolation(`release.yml must contain a pnpm pack invocation filtered to ${adapterPackage}.`);
  }

  const packOutputStepIds = releaseSteps
    .filter(({ step }) => {
      if (!isRecord(step) || typeof step.id !== 'string' || typeof step.run !== 'string') {
        return false;
      }
      return (
        hasPnpmPackInvocation(step.run, corePackage) &&
        hasPnpmPackInvocation(step.run, adapterPackage) &&
        /\bcore_tarball=/.test(step.run) &&
        /\bpi_tarball=/.test(step.run)
      );
    })
    .map(({ step }) => step.id);

  const publishRecords = stepRecords(document, 'publish');
  const publishInvocations = npmPublishInvocations(releaseSteps);
  const publishJobInvocations = npmPublishInvocations(publishRecords);
  if (publishInvocations.length !== 2) {
    addViolation(`release.yml must contain exactly two npm publish invocations; found ${publishInvocations.length}.`);
  }

  const expectedOperands = [
    new Set(packOutputStepIds.map((id) => `\${{ steps.${id}.outputs.core_tarball }}`)),
    new Set(packOutputStepIds.map((id) => `\${{ steps.${id}.outputs.pi_tarball }}`)),
  ];
  publishInvocations.slice(0, 2).forEach((invocation, index) => {
    const packageLabel = index === 0 ? 'core' : 'adapter';
    if (!expectedOperands[index].has(invocation.operand)) {
      addViolation(
        `release.yml ${packageLabel} npm publish must use the tarball output from its pnpm pack step, not a directory; found ${describe(invocation.operand)}.`,
      );
    }
    if (!/--access\s+public(?:\s|$)/.test(invocation.argumentsText)) {
      addViolation(`release.yml ${packageLabel} npm publish must pass --access public.`);
    }
    if (!/--provenance(?:\s|$)/.test(invocation.argumentsText)) {
      addViolation(`release.yml ${packageLabel} npm publish must pass --provenance.`);
    }
  });

  const provenanceMarker = 'https://registry.npmjs.org/-/npm/v1/attestations/';
  const provenanceEscape = String.fromCharCode(92);
  const coreProvenancePackageReference = '$' + '{CORE_PKG_NAME/' + provenanceEscape + '//%2F}';
  const adapterProvenancePackageReference = '$' + '{ADAPTER_PKG_NAME/' + provenanceEscape + '//%2F}';
  const coreProvenance = publishRecords.find(
    ({ step }) =>
      isRecord(step) &&
      typeof step.run === 'string' &&
      step.run.includes(provenanceMarker) &&
      step.run.includes(coreProvenancePackageReference) &&
      !step.run.includes(adapterProvenancePackageReference),
  );
  const adapterProvenance = publishRecords.find(
    ({ step }) =>
      isRecord(step) &&
      typeof step.run === 'string' &&
      step.run.includes(provenanceMarker) &&
      step.run.includes(adapterProvenancePackageReference),
  );
  if (!coreProvenance) {
    addViolation('release.yml must contain a core provenance verification step referencing the npm attestations endpoint.');
  }
  if (!adapterProvenance) {
    addViolation('release.yml must contain an adapter provenance verification step referencing the npm attestations endpoint.');
  }

  if (coreProvenance) {
    checkProvenanceIdentityStep(coreProvenance, 'core');
  }
  if (adapterProvenance) {
    checkProvenanceIdentityStep(adapterProvenance, 'adapter');
  }

  if (coreProvenance && publishJobInvocations.length >= 2) {
    const adapterPublish = publishJobInvocations[1];
    if (coreProvenance.index >= adapterPublish.index) {
      addViolation('release.yml must verify core provenance before publishing the adapter.');
    }
  }
}

function checkSetupNodeRegistryUrl(workflowName, document) {
  for (const { jobName, index, step } of stepRecords(document)) {
    if (
      !isRecord(step) ||
      typeof step.uses !== 'string' ||
      !step.uses.startsWith('actions/setup-node@')
    ) {
      continue;
    }
    if (isRecord(step.with) && hasOwn(step.with, 'registry-url')) {
      addViolation(`${workflowName} job ${jobName} step ${index + 1} must not pass registry-url to setup-node.`);
    }
  }
}

async function loadWorkflows() {
  for (const source of workflowSources) {
    let raw;
    try {
      raw = await readFile(source.path, 'utf8');
    } catch (error) {
      addViolation(`${source.name} does not exist or cannot be read: ${errorMessage(error)}.`);
      continue;
    }

    try {
      const document = YAML.parse(raw);
      workflows.set(source.name, { document, raw });
    } catch (error) {
      addViolation(`${source.name} does not parse as YAML: ${errorMessage(error)}.`);
      workflows.set(source.name, { document: null, raw });
    }
  }
}

await loadWorkflows();

const release = workflows.get('release.yml');
const ci = workflows.get('ci.yml');

if (release) {
  checkReleaseStructure(release);
  checkActionPins('release.yml', release.raw, release.document);
  checkSetupNodeRegistryUrl('release.yml', release.document);
}
if (ci) {
  checkActionPins('ci.yml', ci.raw, ci.document);
  checkSetupNodeRegistryUrl('ci.yml', ci.document);
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`RELEASE_GUARD_VIOLATION: ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Release workflow guard passed.');
}
