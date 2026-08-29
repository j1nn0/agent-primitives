/* global console, process */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const releasePath = join(repositoryRoot, '.github', 'workflows', 'release.yml');
const temporaryRoots = [];

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requirePublishStep(document, name) {
  const steps = document?.jobs?.publish?.steps;
  expect(Array.isArray(steps), 'publish job steps are not an array');
  const matches = steps.filter((step) => step?.name === name);
  expect(matches.length === 1, `expected exactly one publish step named ${name}`);
  expect(typeof matches[0].run === 'string', `${name} does not have a run script`);
  return matches[0];
}

function assertVisibilityStep(step, label, visibleVariable) {
  const run = step.run;
  const maxAttemptsMatches = [...run.matchAll(/^\s*max_attempts=(\d+)\s*$/gm)];
  expect(maxAttemptsMatches.length === 1, `${label} must define one max_attempts assignment`);
  expect(Number(maxAttemptsMatches[0][1]) === 116, `${label} must use max_attempts=116`);

  const schedule = run.match(
    /if \(\( attempt == 1 \)\); then\s+retry_delay=(\d+)\s+else\s+retry_delay=(\d+)\s+fi/,
  );
  expect(schedule !== null, `${label} must define first and subsequent retry delays`);
  expect(Number(schedule[1]) === 15, `${label} first retry delay must be 15 seconds`);
  expect(Number(schedule[2]) === 5, `${label} subsequent retry delay must be 5 seconds`);
  expect(run.includes('sleep "$retry_delay"'), `${label} must sleep using the selected retry delay`);
  expect(run.includes('retrying in ${retry_delay}s.'), `${label} must report the selected retry delay`);

  const exhaustionStart = `if [[ "$${visibleVariable}" != true ]]; then`;
  const exhaustionPosition = run.indexOf(exhaustionStart);
  expect(exhaustionPosition >= 0, `${label} exhaustion branch is missing`);
  const exhaustionEnd = run.indexOf('\npython3 ', exhaustionPosition);
  const exhaustion = run.slice(exhaustionPosition, exhaustionEnd >= 0 ? exhaustionEnd : undefined);
  expect(exhaustion.includes('>&2'), `${label} exhaustion branch must report to stderr`);
  expect(exhaustion.includes('exit 1'), `${label} exhaustion branch must exit 1`);
}

function assertFixedPollingCadence(step, label) {
  expect(step.run.includes('max_attempts=40'), `${label} must retain max_attempts=40`);
  expect(step.run.includes('retry_delay=15'), `${label} must retain retry_delay=15`);
}

function assertStateBIntegrity(run) {
  const markers = [
    'npm view "$CORE_PKG_NAME@$CORE_VERSION" dist.integrity --json --prefer-online',
    'python3 - "$CORE_TARBALL"',
    'validated_core_integrity',
    'hashlib.sha512()',
    'base64.b64encode',
    'registry_core_integrity',
    'if [[ "$registry_core_integrity" != "$validated_core_integrity" ]]; then',
    'refusing to publish the adapter',
  ];
  for (const marker of markers) {
    expect(run.includes(marker), `State B integrity marker is missing: ${marker}`);
  }
}

function runBash(scriptPath, environment) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', [scriptPath], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function readLog(path) {
  try {
    const content = await readFile(path, 'utf8');
    const trimmed = content.trim();
    return trimmed === '' ? [] : trimmed.split(/\r?\n/);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

const fakeNpm = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
attempts="$(wc -l < "$FAKE_NPM_LOG")"
if (( attempts <= FAKE_NPM_FAILS )); then
  echo "fake registry miss" >&2
  exit 1
fi
if [[ "$*" == *" dependencies "* ]]; then
  printf '{"name":"%s","version":"%s","dependencies":{"%s":"^%s"}}\n' "$ADAPTER_PKG_NAME" "$PI_VERSION" "$CORE_PKG_NAME" "$CORE_VERSION"
else
  printf '{"name":"%s","version":"%s","repository":"https://github.com/j1nn0/agent-primitives"}\n' "$CORE_PKG_NAME" "$CORE_VERSION"
fi
`;

const fakeSleep = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$FAKE_SLEEP_LOG"
`;

async function runScenario(step, label, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'agent-primitives-registry-poll-'));
  temporaryRoots.push(root);
  const shimDirectory = join(root, 'bin');
  await mkdir(shimDirectory);
  const scriptPath = join(root, 'step.sh');
  const npmPath = join(shimDirectory, 'npm');
  const sleepPath = join(shimDirectory, 'sleep');
  const npmLog = join(root, 'npm.log');
  const sleepLog = join(root, 'sleep.log');
  await writeFile(scriptPath, `${step.run}\n`);
  await writeFile(npmPath, fakeNpm);
  await writeFile(sleepPath, fakeSleep);
  await chmod(npmPath, 0o755);
  await chmod(sleepPath, 0o755);

  const result = await runBash(scriptPath, {
    RUNNER_TEMP: root,
    CORE_PKG_NAME: '@j1nn0/agent-primitives',
    CORE_VERSION: '9.9.9',
    ADAPTER_PKG_NAME: '@j1nn0/agent-primitives-pi',
    PI_VERSION: '9.9.9',
    FAKE_NPM_FAILS: String(scenario.failures),
    FAKE_NPM_LOG: npmLog,
    FAKE_SLEEP_LOG: sleepLog,
    PATH: `${shimDirectory}:${process.env.PATH ?? ''}`,
  });
  const npmInvocations = await readLog(npmLog);
  const sleeps = (await readLog(sleepLog)).map(Number);

  if (scenario.success) {
    expect(result.code === 0, `${label} ${scenario.name} exited ${result.code}: ${result.stderr}`);
  } else {
    expect(result.code !== 0, `${label} ${scenario.name} unexpectedly succeeded`);
    expect(result.stderr.includes(scenario.exhaustionMessage), `${label} ${scenario.name} lacked its exhaustion message`);
  }
  expect(
    npmInvocations.length === scenario.attempts,
    `${label} ${scenario.name} made ${npmInvocations.length} attempts, expected ${scenario.attempts}`,
  );
  if (scenario.expectedSleeps !== undefined) {
    expect(
      JSON.stringify(sleeps) === JSON.stringify(scenario.expectedSleeps),
      `${label} ${scenario.name} recorded sleeps ${JSON.stringify(sleeps)}, expected ${JSON.stringify(scenario.expectedSleeps)}`,
    );
  } else {
    expect(sleeps.length === 115, `${label} exhaustion recorded ${sleeps.length} sleeps, expected 115`);
    expect(sleeps[0] === 15, `${label} exhaustion first retry delay was ${sleeps[0]}, expected 15`);
    expect(sleeps.slice(1).every((delay) => delay === 5), `${label} exhaustion had a non-5 subsequent delay`);
    expect(sleeps.reduce((total, delay) => total + delay, 0) === 585, `${label} exhaustion sleep total was not 585`);
  }
  console.log(`${label} ${scenario.name}: PASS`);
}

async function main() {
  const raw = await readFile(releasePath, 'utf8');
  const document = YAML.parse(raw);
  const coreVisibility = requirePublishStep(document, 'Verify core on the registry before the adapter');
  const adapterVisibility = requirePublishStep(document, 'Verify Pi adapter on the registry');
  assertVisibilityStep(coreVisibility, 'core registry visibility', 'core_visible');
  assertVisibilityStep(adapterVisibility, 'adapter registry visibility', 'adapter_visible');

  assertFixedPollingCadence(
    requirePublishStep(document, 'Verify core provenance attestation before the adapter'),
    'core provenance verification',
  );
  assertFixedPollingCadence(
    requirePublishStep(document, 'Verify Pi adapter provenance attestation'),
    'adapter provenance verification',
  );

  const registryPreflight = requirePublishStep(document, 'Registry preflight');
  const stateBStart = registryPreflight.run.indexOf('B)');
  const stateBEnd = registryPreflight.run.indexOf('C)', stateBStart + 2);
  expect(stateBStart >= 0 && stateBEnd > stateBStart, 'State B registry preflight branch is missing');
  const stateBRun = registryPreflight.run.slice(stateBStart, stateBEnd);
  assertFixedPollingCadence({ run: stateBRun }, 'State B existing-core identity verification');
  assertStateBIntegrity(registryPreflight.run);

  const scenarios = [
    { name: 'immediate success', failures: 0, attempts: 1, expectedSleeps: [], success: true },
    { name: 'second-attempt success', failures: 1, attempts: 2, expectedSleeps: [15], success: true },
    { name: 'third-attempt success', failures: 2, attempts: 3, expectedSleeps: [15, 5], success: true },
    {
      name: 'exhaustion',
      failures: 1000,
      attempts: 116,
      success: false,
      exhaustionMessage: 'registry verification failed',
    },
  ];

  for (const [label, step] of [
    ['core registry visibility', coreVisibility],
    ['adapter registry visibility', adapterVisibility],
  ]) {
    for (const scenario of scenarios) {
      const scenarioWithMessage = {
        ...scenario,
        exhaustionMessage:
          label === 'core registry visibility'
            ? 'Core registry verification failed; the adapter will not be published.'
            : 'Pi adapter registry verification failed.',
      };
      await runScenario(step, label, scenarioWithMessage);
    }
  }
  console.log('Registry poll fixture passed: static checks and 8 deterministic runtime scenarios.');
}

try {
  await main();
} catch (error) {
  console.error(`Registry poll fixture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
}
