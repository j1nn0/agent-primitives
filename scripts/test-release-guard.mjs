/* global console, process */

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const guardPath = join(scriptDirectory, 'guard-release-workflow.mjs');
const releasePath = join(repositoryRoot, '.github', 'workflows', 'release.yml');
const ciPath = join(repositoryRoot, '.github', 'workflows', 'ci.yml');
const temporaryRoots = [];

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`${label}: expected source text was not found`);
  }
  return source.replace(oldText, newText);
}

function replaceStep(source, startMarker, endMarker, transform, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`${label}: expected workflow step was not found`);
  }
  const step = source.slice(start, end);
  const mutatedStep = transform(step);
  if (mutatedStep === step) {
    throw new Error(`${label}: mutation made no change`);
  }
  return source.slice(0, start) + mutatedStep + source.slice(end);
}

async function createWorkflowCopy() {
  const root = await mkdtemp(join(tmpdir(), 'agent-primitives-release-guard-'));
  const relativePath = relative(repositoryRoot, root);
  if (relativePath === '' || (!relativePath.startsWith('..') && relativePath !== '..')) {
    throw new Error(`temporary guard root is not outside the repository: ${root}`);
  }
  temporaryRoots.push(root);
  const workflowsDirectory = join(root, '.github', 'workflows');
  await mkdir(workflowsDirectory, { recursive: true });
  await Promise.all([
    copyFile(releasePath, join(workflowsDirectory, 'release.yml')),
    copyFile(ciPath, join(workflowsDirectory, 'ci.yml')),
  ]);
  return root;
}

function runGuard(root) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [guardPath, root], {
      cwd: repositoryRoot,
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

const corePublishLine = '          npm publish "${{ steps.publish_artifacts.outputs.core_tarball }}" --access public --provenance';
const adapterPublishBlock = [
  '      - name: Publish Pi adapter',
  "        if: ${{ success() && steps.registry_preflight.outputs.publish_adapter == 'true' }}",
  '        shell: bash',
  '        run: |',
  '          set -euo pipefail',
  '          npm publish "${{ steps.publish_artifacts.outputs.pi_tarball }}" --access public --provenance',
  '',
  '',
].join('\n');

const mutations = [
  {
    name: 'A core publish uses a source directory',
    mutate: (source) =>
      replaceRequired(
        source,
        corePublishLine,
        '          npm publish packages/agent-state --access public --provenance',
        'case A',
      ),
  },
  {
    name: 'B adapter publish loses --provenance',
    mutate: (source) =>
      replaceRequired(
        source,
        '          npm publish "${{ steps.publish_artifacts.outputs.pi_tarball }}" --access public --provenance',
        '          npm publish "${{ steps.publish_artifacts.outputs.pi_tarball }}" --access public',
        'case B',
      ),
  },
  {
    name: 'C adapter publish moves before core provenance verification',
    mutate: (source) => {
      const withoutAdapter = replaceRequired(source, adapterPublishBlock, '', 'case C removal');
      return replaceRequired(
        withoutAdapter,
        '      - name: Verify core provenance attestation before the adapter',
        adapterPublishBlock + '      - name: Verify core provenance attestation before the adapter',
        'case C insertion',
      );
    },
  },
  {
    name: 'D core provenance repository identity changes',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Verify core provenance attestation before the adapter',
        '      - name: Publish Pi adapter',
        (step) =>
          replaceRequired(
            step,
            'buildDefinition.externalParameters.workflow.repository": "https://github.com/j1nn0/agent-primitives"',
            'buildDefinition.externalParameters.workflow.repository": "https://github.com/example/other-repository"',
            'case D',
          ),
        'case D step',
      ),
  },
  {
    name: 'E adapter provenance workflow path changes',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Verify Pi adapter provenance attestation',
        '\n  registry-smoke:',
        (step) =>
          replaceRequired(
            step,
            'buildDefinition.externalParameters.workflow.path": ".github/workflows/release.yml"',
            'buildDefinition.externalParameters.workflow.path": ".github/workflows/other.yml"',
            'case E',
          ),
        'case E step',
      ),
  },
  {
    name: 'F provenance ref changes',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Verify Pi adapter provenance attestation',
        '\n  registry-smoke:',
        (step) => replaceRequired(step, '"refs/heads/main"', '"refs/heads/develop"', 'case F'),
        'case F step',
      ),
  },
  {
    name: 'G provenance RELEASE_COMMIT binding is removed',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Verify Pi adapter provenance attestation',
        '\n  registry-smoke:',
        (step) => replaceRequired(step, '          RELEASE_COMMIT: ${{ github.sha }}\n', '', 'case G'),
        'case G step',
      ),
  },
  {
    name: 'H family package directory mapping changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/context-guard' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case H',
      ),
  },
  {
    name: 'I publish job gains a token reference',
    mutate: (source) =>
      replaceStep(
        source,
        '  publish:',
        '    steps:',
        (step) => replaceRequired(
          step,
          "      ADAPTER_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff-pi' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence-pi' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard-pi' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress-pi' || inputs.family == 'agent-state' && 'j1nn0-agent-state-pi' || 'j1nn0-agent-context-guard-pi' }}\n",
          "      ADAPTER_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff-pi' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence-pi' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard-pi' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress-pi' || inputs.family == 'agent-state' && 'j1nn0-agent-state-pi' || 'j1nn0-agent-context-guard-pi' }}\n      NPM_TOKEN: forbidden\n",
          'case I',
        ),
        'case I job',
      ),
  },
  {
    name: 'J family input options change',
    mutate: (source) => replaceRequired(source, '          - agent-state\n', '          - other-family\n', 'case J'),
  },
  {
    name: 'K family input removes the Progress option',
    mutate: (source) =>
      replaceRequired(source, '          - agent-progress\n', '          - other-family\n', 'case K'),
  },
  {
    name: 'L Progress core maps to the wrong package directory',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-state' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case L',
      ),
  },
  {
    name: 'M Progress adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case M',
      ),
  },
  {
    name: 'N Progress tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-state' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case N',
      ),
  },
  {
    name: 'O family input removes the Retry Guard option',
    mutate: (source) =>
      replaceRequired(source, '          - agent-retry-guard\n', '          - other-family\n', 'case O'),
  },
  {
    name: 'P Retry Guard core maps to the wrong package directory',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-state' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case P',
      ),
  },
  {
    name: 'Q Retry Guard adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case Q',
      ),
  },
  {
    name: 'R Retry Guard tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-state' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case R',
      ),
  }
,
  {
    name: 'S family input removes the Evidence option',
    mutate: (source) =>
      replaceRequired(source, '          - agent-evidence\n', '', 'case S'),
  },
  {
    name: 'T Evidence core maps to the wrong package directory',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-state' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case T',
      ),
  },
  {
    name: 'U Evidence adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case U',
      ),
  },
  {
    name: 'V Evidence tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-state' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case V',
      ),
  },
  {
    name: 'W family input removes the Handoff option',
    mutate: (source) =>
      replaceRequired(source, '          - agent-handoff\n', '', 'case W'),
  },
  {
    name: 'X Handoff core maps to the wrong package directory',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-handoff' && 'packages/agent-state' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case X',
      ),
  },
  {
    name: 'Y Handoff adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-handoff' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case Y',
      ),
  },
  {
    name: 'Z Handoff tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-handoff' && 'j1nn0-agent-state' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case Z',
      ),
  }
];

let failures = 0;
try {
  const positiveRoot = await createWorkflowCopy();
  const positive = await runGuard(positiveRoot);
  if (positive.code === 0) {
    console.log('positive control: PASS (unmutated workflow accepted)');
  } else {
    failures += 1;
    console.error(`positive control: FAIL (expected exit 0, got ${positive.code})`);
    process.stderr.write(positive.stderr);
  }

  for (const testCase of mutations) {
    const root = await createWorkflowCopy();
    const copiedReleasePath = join(root, '.github', 'workflows', 'release.yml');
    try {
      const source = await readFile(copiedReleasePath, 'utf8');
      await writeFile(copiedReleasePath, testCase.mutate(source));
      const result = await runGuard(root);
      if (result.code === 1) {
        console.log(`${testCase.name}: PASS (guard rejected mutation)`);
      } else {
        failures += 1;
        console.error(`${testCase.name}: FAIL (expected exit 1, got ${result.code})`);
        process.stderr.write(result.stderr);
      }
    } catch (error) {
      failures += 1;
      console.error(`${testCase.name}: FAIL (${error instanceof Error ? error.message : String(error)})`);
    }
  }
} finally {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
}

if (failures > 0) {
  console.error(`release guard negative-control suite failed: ${failures} case(s)`);
  process.exitCode = 1;
} else {
  console.log(`release guard negative-control suite passed: ${mutations.length + 1} cases`);
}
