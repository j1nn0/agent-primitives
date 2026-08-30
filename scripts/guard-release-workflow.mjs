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
function checkGhApiAuthentication(document) {
  const expectedToken = '${{ github.token }}';
  for (const { jobName, index, step } of stepRecords(document)) {
    if (!isRecord(step) || typeof step.run !== 'string' || !step.run.includes('gh api')) {
      continue;
    }

    if (!isRecord(step.env) || step.env.GH_TOKEN !== expectedToken) {
      const stepLabel = typeof step.name === 'string' ? step.name : `${jobName} step ${index + 1}`;
      addViolation(
        `release.yml ${stepLabel} invokes gh api and must define GH_TOKEN as ${describe(expectedToken)}.`,
      );
    }
  }
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

  if (packageLabel === 'core') {
    const hasStateWiring =
      (env?.REGISTRY_STATE === '${{ steps.registry_preflight.outputs.state }}' ||
        run.includes('steps.registry_preflight.outputs.state')) &&
      run.includes('REGISTRY_STATE');
    if (!hasStateWiring) {
      addViolation(
        'release.yml core provenance verification step must wire REGISTRY_STATE from steps.registry_preflight.outputs.state and use it.'
      );
    }
    if (!run.includes('hashlib.sha512') || !run.includes('hexdigest')) {
      addViolation(
        'release.yml core provenance verification step must compute a tarball SHA-512 hexdigest for State B subject binding.'
      );
    }
  }
}

function checkRegistryVisibilityStep({ step }, packageLabel, visibleVariable) {
  const label = `release.yml ${packageLabel} registry visibility verification`;
  if (!isRecord(step) || typeof step.run !== 'string') {
    addViolation(`${label} step must have a string run script.`);
    return;
  }

  const run = step.run;
  const maxAttemptsMatches = [...run.matchAll(/^\s*max_attempts=(\d+)\s*$/gm)];
  let maxAttempts;
  if (maxAttemptsMatches.length !== 1) {
    addViolation(`${label} step must define exactly one max_attempts integer.`);
  } else {
    maxAttempts = Number(maxAttemptsMatches[0][1]);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 2) {
      addViolation(`${label} step max_attempts must be an integer of at least 2.`);
    }
  }

  const loopMatch = run.match(
    /for \(\(attempt = 1; attempt <= max_attempts; attempt \+= 1\)\); do\n([\s\S]*?)\n\s*done/,
  );
  if (!loopMatch) {
    addViolation(`${label} step must use a bounded max_attempts loop.`);
  } else {
    const loopBody = loopMatch[1];
    const scheduleMatch = loopBody.match(
      /if \(\( attempt == 1 \)\); then\s+([A-Za-z_][A-Za-z0-9_]*)=(\d+)\s+else\s+\1=(\d+)\s+fi/,
    );
    if (!scheduleMatch) {
      addViolation(`${label} step must define first and subsequent retry delays in its loop.`);
    } else {
      const delayVariable = scheduleMatch[1];
      const firstDelay = Number(scheduleMatch[2]);
      const subsequentDelay = Number(scheduleMatch[3]);
      const sleepMatches = [...loopBody.matchAll(/^\s*sleep\s+"\$([A-Za-z_][A-Za-z0-9_]*)"\s*$/gm)];
      if (sleepMatches.length !== 1 || sleepMatches[0][1] !== delayVariable) {
        addViolation(`${label} step must sleep exactly once using its selected retry delay.`);
      } else if (scheduleMatch.index > sleepMatches[0].index) {
        addViolation(`${label} step must select its retry delay before sleeping.`);
      }
      const retryMessageMarker = `retrying in \${${delayVariable}}s.`;
      if (!run.includes(retryMessageMarker)) {
        addViolation(`${label} step must report the delay used by its retry sleep.`);
      }
      if (
        !Number.isSafeInteger(firstDelay) ||
        firstDelay < 0 ||
        !Number.isSafeInteger(subsequentDelay) ||
        subsequentDelay < 0
      ) {
        addViolation(`${label} step retry delays must be non-negative integers.`);
      } else if (Number.isSafeInteger(maxAttempts) && maxAttempts >= 2) {
        const totalSleep = firstDelay + (maxAttempts - 2) * subsequentDelay;
        if (totalSleep > 600) {
          addViolation(`${label} step derived sleep budget must not exceed 600 seconds; found ${totalSleep}.`);
        }
      }
    }
  }

  const exhaustionMatch = run.match(
    new RegExp(String.raw`if \[\[ "\$${visibleVariable}" != true \]\]; then[\s\S]*?\n\s*fi`),
  );
  if (!exhaustionMatch || !/\bexit 1\b/.test(exhaustionMatch[0]) || !/>&2/.test(exhaustionMatch[0])) {
    addViolation(`${label} step must keep its stderr exhaustion failure with exit 1.`);
  }
}

function checkRegistryVisibilityLoops(publishRecords) {
  const coreVisibilityName = 'Verify core on the registry before the adapter';
  const adapterVisibilityName = 'Verify Pi adapter on the registry';
  const coreProvenanceName = 'Verify core provenance attestation before the adapter';
  const coreVisibilityMatches = publishRecords.filter(
    ({ step }) => isRecord(step) && step.name === coreVisibilityName,
  );
  const adapterVisibilityMatches = publishRecords.filter(
    ({ step }) => isRecord(step) && step.name === adapterVisibilityName,
  );
  if (coreVisibilityMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one ${coreVisibilityName} step; found ${coreVisibilityMatches.length}.`);
  } else {
    checkRegistryVisibilityStep(coreVisibilityMatches[0], 'core', 'core_visible');
  }
  if (adapterVisibilityMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one ${adapterVisibilityName} step; found ${adapterVisibilityMatches.length}.`);
  } else {
    checkRegistryVisibilityStep(adapterVisibilityMatches[0], 'adapter', 'adapter_visible');
  }

  const coreProvenanceMatches = publishRecords.filter(
    ({ step }) => isRecord(step) && step.name === coreProvenanceName,
  );
  if (coreProvenanceMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one ${coreProvenanceName} step; found ${coreProvenanceMatches.length}.`);
  } else if (coreVisibilityMatches.length === 1 && coreVisibilityMatches[0].index >= coreProvenanceMatches[0].index) {
    addViolation(`release.yml ${coreVisibilityName} step must appear before ${coreProvenanceName}.`);
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
    'latest = max(candidates',
    'terminal_conclusions',
    'failure',
    'cancelled',
    'timed_out',
    'startup_failure',
    'in terminal_conclusions',
    'raise SystemExit(2)',
    'parser_status == 2',
    'max_attempts=30',
    'failing closed',
  ]) {
    if (!run.includes(marker)) {
      addViolation(`release.yml ${preflightName} step is missing the required marker ${marker}.`);
    }
  }
  const exhaustion = 'echo "CI preflight exhausted ${max_attempts} attempts; failing closed." >&2\n  exit 1\nfi';
  if (!run.includes(exhaustion)) {
    addViolation(`release.yml ${preflightName} step must keep its bounded exhaustion exit 1.`);
  }
  if (run.includes('checks') || run.includes('/check-runs')) {
    addViolation(`release.yml ${preflightName} step must not use the Checks API.`);
  }
  if (!/failing closed[\s\S]*\bexit 1\b/.test(run)) {
    addViolation(`release.yml ${preflightName} step must fail closed with exit 1.`);
  }
}
function checkValidationReuse(document) {
  const triggers = triggerMapping(document);
  const workflowDispatch = isRecord(triggers) ? triggers.workflow_dispatch : undefined;
  const inputs = isRecord(workflowDispatch) ? workflowDispatch.inputs : undefined;
  const validatedRunInput = isRecord(inputs) ? inputs.validated_run_id : undefined;
  if (!isRecord(validatedRunInput)) {
    addViolation('release.yml workflow_dispatch must define a validated_run_id input.');
  } else {
    if (validatedRunInput.required !== false) {
      addViolation('release.yml validated_run_id input must not be required.');
    }
    if (validatedRunInput.default !== '') {
      addViolation('release.yml validated_run_id input must default to an empty string.');
    }
    if (validatedRunInput.type !== 'string') {
      addViolation('release.yml validated_run_id input must have type string.');
    }
  }

  const validateRecords = stepRecords(document, 'validate');
  exactMapping(
    document?.jobs?.validate?.outputs,
    { validated_run_attempt: '${{ steps.validate_reuse.outputs.run_attempt }}' },
    'release.yml validate outputs',
  );
  const inputValidationName = 'Validate release inputs and manifests';
  const inputValidationMatches = validateRecords.filter(
    ({ step }) => isRecord(step) && step.name === inputValidationName,
  );
  if (inputValidationMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one ${inputValidationName} step; found ${inputValidationMatches.length}.`);
  } else {
    const inputValidationRun = inputValidationMatches[0].step.run;
    if (typeof inputValidationRun !== 'string') {
      addViolation(`release.yml ${inputValidationName} step must have a string run script.`);
    } else {
      const modeGate = 'if [[ "$MODE" != "publish" ]]; then';
      const publishModeGate = 'if [[ "$MODE" == "publish" ]]; then';
      const requiredRunIdGate = 'if [[ -z "$VALIDATED_RUN_ID" ]]; then';
      if (!inputValidationRun.includes(publishModeGate) || !inputValidationRun.includes(requiredRunIdGate)) {
        addViolation(`release.yml ${inputValidationName} step must require a non-empty validated_run_id in publish mode.`);
      }
      if (!inputValidationRun.includes('if [[ -n "$VALIDATED_RUN_ID" ]]; then') || !inputValidationRun.includes(modeGate)) {
        addViolation(`release.yml ${inputValidationName} step must reject validated_run_id outside publish mode.`);
      }
      if (!inputValidationRun.includes('^[0-9]{1,19}$')) {
        addViolation(`release.yml ${inputValidationName} step must sanitize validated_run_id as a numeric run ID.`);
      }
      const confirmationPosition = inputValidationRun.indexOf('expected_confirmation');
      const modeGatePosition = inputValidationRun.indexOf(modeGate);
      const publishModeGatePosition = inputValidationRun.indexOf(publishModeGate);
      const requiredRunIdPosition = inputValidationRun.indexOf(requiredRunIdGate);
      if (confirmationPosition >= 0 && modeGatePosition <= confirmationPosition) {
        addViolation(`release.yml ${inputValidationName} validated_run_id checks must follow confirmation validation.`);
      }
      if (confirmationPosition >= 0 && requiredRunIdPosition <= confirmationPosition) {
        addViolation(`release.yml ${inputValidationName} required validated_run_id check must follow confirmation validation.`);
      }
      if (requiredRunIdPosition >= 0 && publishModeGatePosition >= 0 && requiredRunIdPosition <= publishModeGatePosition) {
        addViolation(`release.yml ${inputValidationName} required validated_run_id check must remain inside publish mode validation.`);
      }
    }
  }

  const verifyName = 'Verify the referenced validated run';
  const verifyMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === verifyName);
  if (verifyMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one ${verifyName} step; found ${verifyMatches.length}.`);
  } else {
    const verifyRecord = verifyMatches[0];
    const verifyStep = verifyRecord.step;
    if (verifyStep.id !== 'validate_reuse') {
      addViolation(`release.yml ${verifyName} step must have id validate_reuse.`);
    }
    if (hasOwn(verifyStep, 'uses')) {
      addViolation(`release.yml ${verifyName} step must be a run step, not a uses step.`);
    }
    exactMapping(
      verifyStep.env,
      {
        GH_TOKEN: '${{ github.token }}',
        VALIDATED_RUN_ID: '${{ inputs.validated_run_id }}',
        MODE: '${{ inputs.mode }}',
        DISPATCH_SHA: '${{ github.sha }}',
        REPOSITORY: '${{ github.repository }}',
        CURRENT_RUN_NUMBER: '${{ github.run_number }}',
        FAMILY: '${{ inputs.family }}',
      },
      `release.yml ${verifyName} environment`,
    );

    const preflightMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === 'Require successful CI on the dispatched commit');
    const lintMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === 'Lint');
    if (inputValidationMatches.length === 1 && preflightMatches.length === 1 && lintMatches.length === 1) {
      if (verifyRecord.index <= inputValidationMatches[0].index || verifyRecord.index <= preflightMatches[0].index || verifyRecord.index >= lintMatches[0].index) {
        addViolation(`release.yml ${verifyName} step must appear after input validation and CI preflight, before Lint.`);
      }
    }

    if (typeof verifyStep.run !== 'string') {
      addViolation(`release.yml ${verifyName} step must have a string run script.`);
    } else {
      const run = verifyStep.run;
      for (const marker of [
        'if not isinstance(data, dict):',
        'required_fields = {',
        'if any(field not in data for field in required_fields):',
        'isinstance(data[field], int)',
        'isinstance(data[field], str)',
        'if not (r.id == int(sys.argv[4])):',
        'if not (r.path == ".github/workflows/release.yml"):',
        'if not (r.event == "workflow_dispatch"):',
        'if not (r.status == "completed"):',
        'if not (r.conclusion == "success"):',
        'if not (r.head_sha == dispatch_sha):',
        'if not (r.head_branch == "main"):',
        'if not (r.run_number < current_run_number):',
        '/attempts/',
        'attempts/${RUN_ATTEMPT}/jobs',
        'if not (total_count == len(jobs)):',
        'expected_job_names = {"validate", "publish", "registry-smoke"}',
        'if len(matches) != 1:',
        'unexpected extra job names',
        'if not (run_attempt == job_attempt):',
        'if not (jobs_by_name["validate"]["conclusion"] == "success"):',
        'if not (jobs_by_name["publish"]["conclusion"] == "skipped"):',
        'if not (jobs_by_name["registry-smoke"]["conclusion"] == "skipped"):',
        'if len(required_matches) != 1:',
        'if not (required_matches[0].get("conclusion") == "success"):',
        'smoke_steps = {',
        'if family not in smoke_steps:',
        'if len(smoke_matches) != 1:',
        'selected_smoke = smoke_steps[family]',
        'if len(selected_matches) != 1:',
        'if not (selected_matches[0].get("conclusion") == "success"):',
        'if not (smoke_matches_by_name[smoke_name].get("conclusion") == "skipped"):',
        'echo "reuse=false" >> "$GITHUB_OUTPUT"',
        'echo "reuse=true" >> "$GITHUB_OUTPUT"',
        'failing closed',
      ]) {
        if (!run.includes(marker)) {
          addViolation(`release.yml ${verifyName} step is missing the required marker ${marker}.`);
        }
      }

      for (const marker of [
        'if [[ "$MODE" == "publish" ]]; then',
        'run a new validate dispatch',
        "printf 'run_attempt=%s\\n' \"$RUN_ATTEMPT\" >> \"$GITHUB_OUTPUT\"",
        '"Upload validated release tarballs"',
      ]) {
        if (!run.includes(marker)) {
          addViolation(`release.yml ${verifyName} step is missing the required reuse-contract marker ${marker}.`);
        }
      }

      for (const stepName of [
        'Validate release inputs and manifests',
        'Require successful CI on the dispatched commit',
        'Lint',
        'Build from a clean dist',
        'Typecheck',
        'Test',
        'Check package quality',
        'Run example',
        'Dry-run pnpm package publication',
        'Pack release artifacts',
        'Extract and audit release artifacts',
      ]) {
        if (!run.includes(stepName)) {
          addViolation(`release.yml ${verifyName} step must check validate step ${stepName}.`);
        }
      }

      for (const smokeName of [
        'Smoke-test Context Guard packed artifacts in a fresh consumer',
        'Smoke-test Agent State packed artifacts in a fresh consumer',
        'Smoke-test Progress packed artifacts in a fresh consumer',
        'Smoke-test Retry Guard packed artifacts in a fresh consumer',
        'Smoke-test Evidence packed artifacts in a fresh consumer',
        'Smoke-test Handoff packed artifacts in a fresh consumer',
        'Smoke-test Budget packed artifacts in a fresh consumer',
        'Smoke-test Tool Policy packed artifacts in a fresh consumer',
      ]) {
        if (!run.includes(smokeName)) {
          addViolation(`release.yml ${verifyName} step must check family smoke step ${smokeName}.`);
        }
      }

      if (!/failing closed[\s\S]*(?:\bexit [12]\b|SystemExit\([12]\))/.test(run)) {
        addViolation(`release.yml ${verifyName} step must fail closed on every verification anomaly.`);
      }
    }
  }

  const reuseMarker = "steps.validate_reuse.outputs.reuse != 'true'";
  const nonSmokeCandidates = [
    'Lint',
    'Build from a clean dist',
    'Typecheck',
    'Test',
    'Check package quality',
    'Run example',
    'Dry-run pnpm package publication',
    'Pack release artifacts',
    'Extract and audit release artifacts',
  ];
  for (const stepName of nonSmokeCandidates) {
    const matches = validateRecords.filter(({ step }) => isRecord(step) && step.name === stepName);
    if (matches.length !== 1) {
      addViolation(`release.yml validate job must contain exactly one ${stepName} reuse candidate; found ${matches.length}.`);
    } else if (typeof matches[0].step.if !== 'string' || !matches[0].step.if.includes(reuseMarker)) {
      addViolation(`release.yml validate ${stepName} step must skip when validated-run reuse is verified.`);
    }
  }

  const smokeCandidates = [
    ['context-guard', 'Smoke-test Context Guard packed artifacts in a fresh consumer'],
    ['agent-state', 'Smoke-test Agent State packed artifacts in a fresh consumer'],
    ['agent-progress', 'Smoke-test Progress packed artifacts in a fresh consumer'],
    ['agent-retry-guard', 'Smoke-test Retry Guard packed artifacts in a fresh consumer'],
    ['agent-evidence', 'Smoke-test Evidence packed artifacts in a fresh consumer'],
    ['agent-handoff', 'Smoke-test Handoff packed artifacts in a fresh consumer'],
    ['agent-budget', 'Smoke-test Budget packed artifacts in a fresh consumer'],
    ['agent-tool-policy', 'Smoke-test Tool Policy packed artifacts in a fresh consumer'],
  ];
  for (const [family, stepName] of smokeCandidates) {
    const matches = validateRecords.filter(({ step }) => isRecord(step) && step.name === stepName);
    if (matches.length !== 1) {
      addViolation(`release.yml validate job must contain exactly one ${stepName} reuse candidate; found ${matches.length}.`);
      continue;
    }
    const ifText = matches[0].step.if;
    if (typeof ifText !== 'string' || !ifText.includes(reuseMarker) || !ifText.includes(`inputs.family == '${family}'`)) {
      addViolation(`release.yml validate ${stepName} step must retain both reuse and ${family} predicates.`);
    }
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
  checkValidationReuse(document);

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
      { actions: 'read', contents: 'read', 'id-token': 'write' },
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
  if (/\boverwrite:\s*true\b/.test(raw)) {
    addViolation('release.yml must not enable artifact overwrite.');
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

  const publishRecords = stepRecords(document, 'publish');
  checkRegistryVisibilityLoops(publishRecords);
  const hasPnpmPackCommand = (run) =>
    commandSegments(run).some((command) => {
      if (!/^pnpm(?:\s|$)/.test(command)) {
        return false;
      }
      return command.split(/\s+/).includes('pack');
    });
  const publishPackRecords = publishRecords.filter(
    ({ step }) => isRecord(step) && typeof step.run === 'string' && hasPnpmPackCommand(step.run),
  );
  if (publishPackRecords.length > 0) {
    addViolation('release.yml publish job must not contain any pnpm pack invocation.');
  }
  for (const { step } of publishRecords) {
    if (!isRecord(step)) {
      continue;
    }
    if (step.name === 'Set up pnpm' || (typeof step.uses === 'string' && /^pnpm\/action-setup@/.test(step.uses))) {
      addViolation('release.yml publish job must not set up pnpm.');
    }
    if (step.name === 'Build from a clean dist') {
      addViolation('release.yml publish job must not contain Build from a clean dist.');
    }
    if (step.name === 'Set up Node.js' && isRecord(step.with) && hasOwn(step.with, 'cache')) {
      addViolation('release.yml publish Set up Node.js step must not configure a package-manager cache.');
    }
    if (typeof step.run !== 'string') {
      continue;
    }
    if (commandSegments(step.run).some((command) => /^pnpm(?:\s|$).*\binstall(?:\s|$)/.test(command))) {
      addViolation('release.yml publish job must not run pnpm install.');
    }
    if (commandSegments(step.run).some((command) => /^pnpm(?:\s|$).*(?:\brun\s+build(?:\s|$)|\bbuild(?:\s|$))/.test(command))) {
      addViolation('release.yml publish job must not run a pnpm build.');
    }
  }

  const coreTarballOutputMarker = "printf 'core_tarball=%s\\n' \"$core_tarball\" >> \"$GITHUB_OUTPUT\"";
  const piTarballOutputMarker = "printf 'pi_tarball=%s\\n' \"$pi_tarball\" >> \"$GITHUB_OUTPUT\"";
  const publishOutputRecords = publishRecords.filter(
    ({ step }) =>
      isRecord(step) &&
      typeof step.run === 'string' &&
      step.run.includes(coreTarballOutputMarker) &&
      step.run.includes(piTarballOutputMarker) &&
      !hasPnpmPackCommand(step.run),
  );
  if (publishOutputRecords.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one non-repacking tarball-output step; found ${publishOutputRecords.length}.`);
  } else {
    const outputStep = publishOutputRecords[0].step;
    if (typeof outputStep.id !== 'string' || outputStep.id.length === 0) {
      addViolation('release.yml publish tarball-output step must have an id.');
    }
    if (outputStep.id !== 'validated_tarballs') {
      addViolation('release.yml publish tarball-output step must be validated_tarballs.');
    }
  }

  const validateRecords = stepRecords(document, 'validate');
  const auditName = 'Extract and audit release artifacts';
  const auditMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === auditName);
  let auditStepId;
  if (auditMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one ${auditName} step; found ${auditMatches.length}.`);
  } else {
    const auditStep = auditMatches[0].step;
    if (auditStep.id !== 'validate_artifacts') {
      addViolation(`release.yml ${auditName} step must have id validate_artifacts.`);
    }
    if (typeof auditStep.id === 'string') {
      auditStepId = auditStep.id;
    }
    if (typeof auditStep.run !== 'string') {
      addViolation(`release.yml ${auditName} step must have a string run script.`);
    } else {
      for (const marker of [
        "printf 'core_tarball=%s\\n' \"$core_tarball\" >> \"$GITHUB_OUTPUT\"",
        "printf 'pi_tarball=%s\\n' \"$pi_tarball\" >> \"$GITHUB_OUTPUT\"",
      ]) {
        if (!auditStep.run.includes(marker)) {
          addViolation(`release.yml ${auditName} step must write ${marker} to GITHUB_OUTPUT.`);
        }
      }
    }
  }

  const uploadName = 'Upload validated release tarballs';
  const uploadMatches = validateRecords.filter(({ step }) => isRecord(step) && step.name === uploadName);
  if (uploadMatches.length !== 1) {
    addViolation(`release.yml validate job must contain exactly one ${uploadName} step; found ${uploadMatches.length}.`);
  } else {
    const uploadRecord = uploadMatches[0];
    const uploadStep = uploadRecord.step;
    if (uploadStep.if !== '${{ inputs.mode == \'validate\' }}') {
      addViolation(`release.yml ${uploadName} step must run only in validate mode.`);
    }
    if (uploadStep.uses !== 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a') {
      addViolation(`release.yml ${uploadName} step must use the pinned upload-artifact action.`);
    }
    const uploadWith = uploadStep.with;
    if (!isRecord(uploadWith)) {
      addViolation(`release.yml ${uploadName} step must define its action inputs.`);
    } else {
      const expectedName = 'release-tarballs-${{ inputs.family }}-${{ inputs.core_version }}-${{ inputs.pi_version }}-${{ github.sha }}-attempt-${{ github.run_attempt }}';
      if (uploadWith.name !== expectedName) {
        addViolation(`release.yml ${uploadName} artifact name must include the workflow run attempt.`);
      }
      const expectedPath = auditStepId
        ? [
            `\${{ steps.${auditStepId}.outputs.core_tarball }}`,
            `\${{ steps.${auditStepId}.outputs.pi_tarball }}`,
          ]
        : [];
      const actualPath = typeof uploadWith.path === 'string'
        ? uploadWith.path.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        : [];
      if (JSON.stringify(actualPath) !== JSON.stringify(expectedPath)) {
        addViolation(`release.yml ${uploadName} path must contain exactly the audit step tarball outputs.`);
      }
      if (uploadWith['retention-days'] !== 90 || typeof uploadWith['retention-days'] !== 'number') {
        addViolation(`release.yml ${uploadName} retention-days must be 90.`);
      }
      if (uploadWith['if-no-files-found'] !== 'error') {
        addViolation(`release.yml ${uploadName} must fail when a tarball is missing.`);
      }
      if (uploadWith.overwrite !== false) {
        addViolation(`release.yml ${uploadName} overwrite must be false.`);
      }
      if (uploadWith['include-hidden-files'] !== false) {
        addViolation(`release.yml ${uploadName} include-hidden-files must be false.`);
      }
      for (const forbiddenInput of ['compression-level', 'archive']) {
        if (hasOwn(uploadWith, forbiddenInput)) {
          addViolation(`release.yml ${uploadName} must not override ${forbiddenInput}.`);
        }
      }
    }
    if (auditMatches.length === 1 && uploadRecord.index <= auditMatches[0].index) {
      addViolation(`release.yml ${uploadName} must appear after ${auditName}.`);
    }
    for (const { index, step } of validateRecords) {
      if (isRecord(step) && typeof step.name === 'string' && /^Smoke-test .* packed artifacts in a fresh consumer$/.test(step.name)) {
        if (uploadRecord.index <= index) {
          addViolation(`release.yml ${uploadName} must appear after every packed-artifact smoke step.`);
        }
      }
    }
  }

  const resolveMatches = publishRecords.filter(({ step }) => isRecord(step) && step.id === 'validated_tarballs');
  let resolvedStepId;
  if (resolveMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one validated_tarballs step; found ${resolveMatches.length}.`);
  } else {
    const resolveStep = resolveMatches[0].step;
    resolvedStepId = resolveStep.id;
    if (typeof resolveStep.run !== 'string') {
      addViolation('release.yml validated_tarballs step must have a string run script.');
    } else {
      const resolveRun = resolveStep.run;
      const expectedResolveEnvironment = {
        GH_TOKEN: '${{ github.token }}',
        REPOSITORY: '${{ github.repository }}',
        VALIDATED_RUN_ID: '${{ inputs.validated_run_id }}',
        VALIDATED_RUN_ATTEMPT: '${{ needs.validate.outputs.validated_run_attempt }}',
        DISPATCH_SHA: '${{ github.sha }}',
        CORE_VERSION: '${{ inputs.core_version }}',
        PI_VERSION: '${{ inputs.pi_version }}',
        FAMILY: '${{ inputs.family }}',
      };
      if (!isRecord(resolveStep.env)) {
        addViolation('release.yml validated_tarballs step must define its artifact-resolution environment.');
      } else {
        for (const [key, expectedValue] of Object.entries(expectedResolveEnvironment)) {
          if (resolveStep.env[key] !== expectedValue) {
            addViolation(`release.yml validated_tarballs environment ${key} must be ${describe(expectedValue)}.`);
          }
        }
      }
      const requiredResolveMarkers = [
        'set -euo pipefail',
        '^[0-9]{1,19}$',
        '^[0-9]{1,9}$',
        '^[0-9a-f]{40}$',
        'release-tarballs-${FAMILY}-${CORE_VERSION}-${PI_VERSION}-${DISPATCH_SHA}-attempt-${VALIDATED_RUN_ATTEMPT}',
        'repos/${REPOSITORY}/actions/runs/${VALIDATED_RUN_ID}/artifacts?per_page=100',
        'total_count == len(artifacts)',
        'if not (total_count == len(artifacts)):',
        'required_fields = {"id", "name", "expired", "digest", "size_in_bytes", "workflow_run"}',
        'len(matches) != 1',
        'artifact["expired"] is not False',
        'sha256:[0-9a-f]{64}',
        'workflow_run id == int(VALIDATED_RUN_ID)',
        'workflow_run head_sha == DISPATCH_SHA',
        'if workflow_run["id"] != int(sys.argv[3]):',
        'if workflow_run["head_sha"] != sys.argv[4]:',
        'ARTIFACT_ID=',
        'ARTIFACT_DIGEST=',
        'ARTIFACT_SIZE=',
        '^ARTIFACT_ID=[0-9]+$',
        '^ARTIFACT_DIGEST=[0-9a-f]{64}$',
        '^ARTIFACT_SIZE=[1-9][0-9]*$',
        'repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip',
        '! -s "$zip_file"',
        'ARTIFACT_SIZE',
        'sha256sum "$zip_file"',
        'zip_digest',
        'if [[ "$zip_digest" != "$ARTIFACT_DIGEST" ]]; then',
        'zipfile.ZipFile',
        'zipfile.BadZipFile',
        'len(infos) != 2',
        'len(set(names)) != len(names)',
        'info.is_dir()',
        'os.path.isabs(name)',
        're.match(r"^[A-Za-z]:", name)',
        '".." in name.split("/")',
        'os.path.basename(name)',
        'name.endswith(".tgz")',
        'info.external_attr >> 16',
        '0o120000',
        'if mode == 0o120000:',
        'mode not in (0, 0o100000)',
        'names.count(core_name) != 1',
        'names.count(adapter_name) != 1',
        'mktemp -d',
        'zf.open(info)',
        'tarfile.open',
        'package/LICENSE',
        'package/README.md',
        'package/dist',
        'package/src',
        'forbidden_parts',
        'name.endswith(".tgz")',
        '"/home/"',
        'workspace:',
        'file:',
        'link:',
        'expected_dependency',
        'pi_manifest',
        'extensions',
        'target_path',
        "printf 'core_tarball=%s\\n' \"$core_tarball\" >> \"$GITHUB_OUTPUT\"",
        "printf 'pi_tarball=%s\\n' \"$pi_tarball\" >> \"$GITHUB_OUTPUT\"",
        'run a new validate dispatch',
        'if not isinstance(artifact["expired"], bool):',
        'or not name:',
        'if "/" in name or',
        'if [[ "$downloaded_size" != "$ARTIFACT_SIZE" ]]; then',
        'destination.iterdir()',
      ];
      for (const marker of requiredResolveMarkers) {
        if (!resolveRun.includes(marker)) {
          addViolation(`release.yml validated_tarballs step is missing required artifact safety marker ${marker}.`);
        }
      }
      if (/\bzf\.extract(?:all)?\s*\(/.test(resolveRun)) {
        addViolation('release.yml validated_tarballs step must not use ZIP extract helpers.');
      }
    }
  }

  const reassertMatches = publishRecords.filter(({ step }) => isRecord(step) && step.name === 'Re-assert manifest versions');
  if (reassertMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one Re-assert manifest versions step; found ${reassertMatches.length}.`);
  } else if (resolveMatches.length === 1 && resolveMatches[0].index !== reassertMatches[0].index + 1) {
    addViolation('release.yml validated_tarballs step must immediately follow Re-assert manifest versions.');
  }

  const publishInvocations = npmPublishInvocations(releaseSteps);
  const publishJobInvocations = npmPublishInvocations(publishRecords);
  if (publishInvocations.length !== 2) {
    addViolation(`release.yml must contain exactly two npm publish invocations; found ${publishInvocations.length}.`);
  }
  const expectedOperands = resolvedStepId
    ? [
        new Set([`\${{ steps.${resolvedStepId}.outputs.core_tarball }}`]),
        new Set([`\${{ steps.${resolvedStepId}.outputs.pi_tarball }}`]),
      ]
    : [new Set(), new Set()];
  publishInvocations.slice(0, 2).forEach((invocation, index) => {
    const packageLabel = index === 0 ? 'core' : 'adapter';
    if (!expectedOperands[index].has(invocation.operand)) {
      addViolation(
        `release.yml ${packageLabel} npm publish must use the validated tarball output, not a directory; found ${describe(invocation.operand)}.`,
      );
    }
    if (!/--access\s+public(?:\s|$)/.test(invocation.argumentsText)) {
      addViolation(`release.yml ${packageLabel} npm publish must pass --access public.`);
    }
    if (!/--provenance(?:\s|$)/.test(invocation.argumentsText)) {
      addViolation(`release.yml ${packageLabel} npm publish must pass --provenance.`);
    }
  });

  const registryPreflightMatches = publishRecords.filter(({ step }) => isRecord(step) && step.name === 'Registry preflight');
  if (registryPreflightMatches.length !== 1) {
    addViolation(`release.yml publish job must contain exactly one Registry preflight step; found ${registryPreflightMatches.length}.`);
  } else {
    const registryStep = registryPreflightMatches[0].step;
    if (!isRecord(registryStep.env) || registryStep.env.CORE_TARBALL !== '${{ steps.validated_tarballs.outputs.core_tarball }}') {
      addViolation('release.yml Registry preflight must receive the validated core tarball path.');
    }
    if (typeof registryStep.run !== 'string') {
      addViolation('release.yml Registry preflight step must have a string run script.');
    } else {
      const registryRun = registryStep.run;
      const statePatterns = [
        /if \[\[ "\$core_exists" == false && "\$adapter_exists" == false \]\]; then\s+state='A'/,
        /elif \[\[ "\$core_exists" == true && "\$adapter_exists" == false \]\]; then\s+state='B'/,
        /elif \[\[ "\$core_exists" == false && "\$adapter_exists" == true \]\]; then\s+state='C'/,
        /else\s+state='D'/,
      ];
      for (const pattern of statePatterns) {
        if (!pattern.test(registryRun)) {
          addViolation('release.yml Registry preflight must retain the Registry State A/B/C/D definitions.');
        }
      }
      const stateBStart = registryRun.indexOf('B)');
      const stateBEnd = stateBStart >= 0 ? registryRun.indexOf('C)', stateBStart + 2) : -1;
      const stateBRun = stateBStart >= 0 && stateBEnd >= 0 ? registryRun.slice(stateBStart, stateBEnd) : '';
      const stateBMarkers = [
        'npm view "$CORE_PKG_NAME@$CORE_VERSION" dist.integrity --json --prefer-online',
        'python3 - "$CORE_TARBALL"',
        'validated_core_integrity',
        'hashlib.sha512()',
        'base64.b64encode',
        'registry_core_integrity',
        'if [[ "$registry_core_integrity" != "$validated_core_integrity" ]]; then',
        'refusing to publish the adapter',
      ];
      for (const marker of stateBMarkers) {
        if (!stateBRun.includes(marker)) {
          addViolation(`release.yml Registry preflight State B is missing the core integrity marker ${marker}.`);
        }
      }
      const comparisonPosition = stateBRun.indexOf('if [[ "$registry_core_integrity" != "$validated_core_integrity" ]]; then');
      const publishAdapterPosition = stateBRun.indexOf("printf 'publish_adapter=true\\n'");
      if (comparisonPosition < 0 || publishAdapterPosition < 0 || comparisonPosition >= publishAdapterPosition) {
        addViolation('release.yml Registry preflight State B must compare core integrity before enabling adapter publication.');
      }
    }
  }

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

function checkCiReleaseRegressionSuites(ciDocument) {
  const steps =
    isRecord(ciDocument) && isRecord(ciDocument.jobs) && isRecord(ciDocument.jobs.ci)
      ? ciDocument.jobs.ci.steps
      : undefined;
  if (!Array.isArray(steps)) {
    addViolation('ci.yml must define a ci job with a steps array.');
    return;
  }
  const node24Condition = "matrix.node == '24.x'";
  for (const suite of ['pnpm test:release-guard', 'pnpm test:registry-poll']) {
    const matches = steps.filter((step) => isRecord(step) && step.run === suite);
    if (matches.length !== 1) {
      addViolation(`ci.yml must run ${suite} exactly once on the Node 24 job; found ${matches.length}.`);
      continue;
    }
    if (matches[0].if !== node24Condition) {
      addViolation(`ci.yml ${suite} must be gated to ${node24Condition} so the Node 22 job does not duplicate it.`);
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
  checkGhApiAuthentication(release.document);
  checkActionPins('release.yml', release.raw, release.document);
  checkSetupNodeRegistryUrl('release.yml', release.document);
}
if (ci) {
  checkActionPins('ci.yml', ci.raw, ci.document);
  checkSetupNodeRegistryUrl('ci.yml', ci.document);
  checkCiReleaseRegressionSuites(ci.document);
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`RELEASE_GUARD_VIOLATION: ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Release workflow guard passed.');
}
