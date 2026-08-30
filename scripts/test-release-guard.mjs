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

function replaceUnique(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`${label}: expected source text exactly once`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
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

const corePublishLine = '          npm publish "${{ steps.validated_tarballs.outputs.core_tarball }}" --access public --provenance';
const adapterPublishBlock = [
  '      - name: Publish Pi adapter',
  "        if: ${{ success() && steps.registry_preflight.outputs.publish_adapter == 'true' }}",
  '        shell: bash',
  '        run: |',
  '          set -euo pipefail',
  '          npm publish "${{ steps.validated_tarballs.outputs.pi_tarball }}" --access public --provenance',
  '',
  '',
].join('\n');

const toolPolicyPackedSmokeStart = '      - name: Smoke-test Tool Policy packed artifacts in a fresh consumer';
const toolPolicyPackedSmokeEnd = '\n\n      - name: Upload validated release tarballs';
const toolPolicyPackedSmokeIf = "        if: ${{ steps.validate_reuse.outputs.reuse != 'true' && inputs.family == 'agent-tool-policy' }}\n";
const uploadStepStart = '      - name: Upload validated release tarballs';
const uploadStepEnd = '\n  publish:';
const validatedTarballsStepStart = '      - name: Resolve, download, and audit validated release artifacts';
const validatedTarballsStepEnd = '\n\n      - name: Registry preflight';
const registryPreflightStepStart = '      - name: Registry preflight';
const registryPreflightStepEnd = '\n\n      - name: Record Node and npm versions for trusted publishing';
const coreRegistryVisibilityStepStart = '      - name: Verify core on the registry before the adapter';
const coreRegistryVisibilityStepEnd = '\n\n      - name: Verify core provenance attestation before the adapter';
const adapterRegistryVisibilityStepStart = '      - name: Verify Pi adapter on the registry';
const adapterRegistryVisibilityStepEnd = '\n\n      - name: Verify Pi adapter provenance attestation';
const registryVisibilityLoop = '          for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do\n';
const coreVisibilityExhaustionBlock = [
  '          if [[ "$core_visible" != true ]]; then',
  '            echo "Core registry verification failed; the adapter will not be published. The version did not become visible on the public registry within the wait window." >&2',
  '            cat "$verification_error_file" >&2',
  '            exit 1',
  '          fi',
].join('\n') + '\n';
const adapterVisibilityExhaustionBlock = [
  '          if [[ "$adapter_visible" != true ]]; then',
  '            echo "Pi adapter registry verification failed. The version did not become visible on the public registry within the wait window." >&2',
  '            cat "$verification_error_file" >&2',
  '            exit 1',
  '          fi',
].join('\n') + '\n';

function moveStepAfter(source, stepStart, stepEnd, afterMarker, label) {
  const start = source.indexOf(stepStart);
  const end = source.indexOf(stepEnd, start + stepStart.length);
  if (start < 0 || end < 0) {
    throw new Error(`${label}: expected workflow step was not found`);
  }
  const step = source.slice(start, end);
  const withoutStep = source.slice(0, start) + source.slice(end);
  const insertion = withoutStep.indexOf(afterMarker);
  if (insertion < 0) {
    throw new Error(`${label}: expected insertion marker was not found`);
  }
  const insertionEnd = insertion + afterMarker.length;
  return `${withoutStep.slice(0, insertionEnd)}\n\n${step}${withoutStep.slice(insertionEnd)}`;
}
const validatedRunRequiredBlock = [
  '            if [[ -z "$VALIDATED_RUN_ID" ]]; then',
  '              echo "validated_run_id is required in publish mode." >&2',
  '              exit 1',
  '            fi',
].join('\n') + '\n';
const validateJobOutputBlock = '    outputs:\n      validated_run_attempt: ${{ steps.validate_reuse.outputs.run_attempt }}\n';
const packageSetAssertLine = '          pnpm list -r --filter "$ADAPTER_PKG_NAME..." --depth -1 --json | node -e \'const fs=require("node:fs");const actual=JSON.parse(fs.readFileSync(0,"utf8")).map((entry)=>entry.name).sort();const expected=[process.env.CORE_PKG_NAME,process.env.ADAPTER_PKG_NAME].sort();if(actual.length!==expected.length||actual.some((name,index)=>name!==expected[index])){console.error("Family package set mismatch: "+JSON.stringify(actual)+" instead of "+JSON.stringify(expected));process.exit(1);}\'\n';
const runExampleStep = [
  '      - name: Run example',
  "        if: ${{ steps.validate_reuse.outputs.reuse != 'true' }}",
  '        env:',
  '          FAMILY: ${{ inputs.family }}',
  '        shell: bash',
  '        run: |',
  '          set -euo pipefail',
  "          node -e 'const scripts=JSON.parse(require(\"node:fs\").readFileSync(\"package.json\",\"utf8\")).scripts||{};const name=\"example:\"+process.env.FAMILY;if(typeof scripts[name]!==\"string\"||scripts[name].length===0){console.error(\"No root example script for family \"+process.env.FAMILY);process.exit(1);}'",
  '          pnpm run "example:${FAMILY}"',
].join('\n') + '\n';
const validatedRunInputBlock = [
  '      validated_run_id:',
  "        description: 'Required in publish mode: run ID of a successful validate-mode run for the same family, versions, and commit'",
  '        required: false',
  "        default: ''",
  '        type: string',
].join('\n') + '\n';
const validatedRunModeOnly = [
  '            if [[ "$MODE" != "publish" ]]; then',
  '              echo "validated_run_id is only allowed in publish mode." >&2',
  '              exit 1',
  '            fi',
].join('\n') + '\n';
const validatedRunNumericCheck = [
  '            if [[ ! "$VALIDATED_RUN_ID" =~ ^[0-9]{1,19}$ ]]; then',
  '              echo "Invalid validated_run_id: must be a numeric Actions run ID with at most 19 digits." >&2',
  '              exit 1',
  '            fi',
].join('\n') + '\n';
const validationReuseStepStart = '      - name: Verify the referenced validated run';
const validationReuseStepEnd = '\n\n      - name: Set up pnpm';
const verifyHeadShaCheck = [
  '          if not (r.head_sha == dispatch_sha):',
  '              fail("r.head_sha == dispatch_sha")',
].join('\n') + '\n';
const verifyHeadBranchCheck = [
  '          if not (r.head_branch == "main"):',
  '              fail(\'r.head_branch == "main"\')',
].join('\n') + '\n';
const verifyPathCheck = [
  '          if not (r.path == ".github/workflows/release.yml"):',
  '              fail(\'r.path == ".github/workflows/release.yml"\')',
].join('\n') + '\n';
const verifyEventCheck = [
  '          if not (r.event == "workflow_dispatch"):',
  '              fail(\'r.event == "workflow_dispatch"\')',
].join('\n') + '\n';
const verifyStatusConclusionChecks = [
  '          if not (r.status == "completed"):',
  '              fail(\'r.status == "completed"\')',
  '          if not (r.conclusion == "success"):',
  '              fail(\'r.conclusion == "success"\')',
].join('\n') + '\n';
const verifyRunNumberCheck = [
  '          if not (r.run_number < current_run_number):',
  '              fail("r.run_number < current_run_number")',
].join('\n') + '\n';
const verifyRunAttemptCheck = [
  '              if not (run_attempt == job_attempt):',
  '                  fail("run_attempt == job[\'run_attempt\']")',
].join('\n') + '\n';
const verifyTotalCountCheck = [
  '          if not (total_count == len(jobs)):',
  '              fail("total_count == len(jobs)")',
].join('\n') + '\n';
const verifyValidateModeProof = [
  '          if not (jobs_by_name["validate"]["conclusion"] == "success"):',
  '              fail(\'validate job conclusion == "success"\')',
  '          if not (jobs_by_name["publish"]["conclusion"] == "skipped"):',
  '              fail(\'publish job conclusion == "skipped"\')',
  '          if not (jobs_by_name["registry-smoke"]["conclusion"] == "skipped"):',
  '              fail(\'registry-smoke job conclusion == "skipped"\')',
].join('\n') + '\n';
const verifyRequiredStepSuccessChecks = [
  '              if not (required_matches[0].get("conclusion") == "success"):',
  '                  fail(f"required validate step {required_name!r} conclusion == \\"success\\"")',
].join('\n') + '\n';
const verifySmokeMap = [
  '          smoke_steps = {',
  '              "context-guard": "Smoke-test Context Guard packed artifacts in a fresh consumer",',
  '              "agent-state": "Smoke-test Agent State packed artifacts in a fresh consumer",',
  '              "agent-progress": "Smoke-test Progress packed artifacts in a fresh consumer",',
  '              "agent-retry-guard": "Smoke-test Retry Guard packed artifacts in a fresh consumer",',
  '              "agent-evidence": "Smoke-test Evidence packed artifacts in a fresh consumer",',
  '              "agent-handoff": "Smoke-test Handoff packed artifacts in a fresh consumer",',
  '              "agent-budget": "Smoke-test Budget packed artifacts in a fresh consumer",',
  '              "agent-tool-policy": "Smoke-test Tool Policy packed artifacts in a fresh consumer",',
  '          }',
].join('\n') + '\n';
const verifySelectedSmokeChecks = [
  '          selected_smoke = smoke_steps[family]',
  '          selected_matches = [step for step in validate_steps if step.get("name") == selected_smoke]',
  '          if len(selected_matches) != 1:',
  '              fail("selected family smoke step appears exactly once")',
  '          if not (selected_matches[0].get("conclusion") == "success"):',
  '              fail(\'selected family smoke step conclusion == "success"\')',
].join('\n') + '\n';
const ciTerminalBranch = [
  '              terminal_conclusions = {"failure", "cancelled", "timed_out", "startup_failure"}',
  '              r = latest',
  '              if r.get("status") == "completed":',
  '                  if r.get("conclusion") == "success":',
  '                      print(f"Found successful CI run for {sha}.")',
  '                      raise SystemExit(0)',
  '                  if r.get("conclusion") in terminal_conclusions or r.get("conclusion") != "success":',
  '                      print(',
  '                          f"Latest matching CI run is terminal CI: {r.get(\'conclusion\')}.",',
  '                          file=sys.stderr,',
  '                      )',
  '                      raise SystemExit(2)',
].join('\n') + '\n';
const ciExhaustion = '            echo "CI preflight exhausted ${max_attempts} attempts; failing closed." >&2\n            exit 1\n          fi';
const unrelatedFamilyGatedStep = [
  '      - name: Audit family docs',
  "        if: ${{ inputs.family == 'agent-budget' }}",
  '        shell: bash',
  '        run: echo "checking docs for $FAMILY"',
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
        '          npm publish "${{ steps.validated_tarballs.outputs.pi_tarball }}" --access public --provenance',
        '          npm publish "${{ steps.validated_tarballs.outputs.pi_tarball }}" --access public',
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
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/context-guard' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
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
          "      ADAPTER_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy-pi' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget-pi' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff-pi' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence-pi' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard-pi' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress-pi' || inputs.family == 'agent-state' && 'j1nn0-agent-state-pi' || 'j1nn0-agent-context-guard-pi' }}\n",
          "      ADAPTER_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy-pi' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget-pi' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff-pi' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence-pi' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard-pi' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress-pi' || inputs.family == 'agent-state' && 'j1nn0-agent-state-pi' || 'j1nn0-agent-context-guard-pi' }}\n      NPM_TOKEN: forbidden\n",
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
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-state' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case L',
      ),
  },
  {
    name: 'M Progress adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case M',
      ),
  },
  {
    name: 'N Progress tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-state' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
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
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-state' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case P',
      ),
  },
  {
    name: 'Q Retry Guard adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case Q',
      ),
  },
  {
    name: 'R Retry Guard tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-state' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
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
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-state' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case T',
      ),
  },
  {
    name: 'U Evidence adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case U',
      ),
  },
  {
    name: 'V Evidence tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-state' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
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
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-handoff' && 'packages/agent-state' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case X',
      ),
  },
  {
    name: 'Y Handoff adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case Y',
      ),
  },
  {
    name: 'Z Handoff tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-handoff' && 'j1nn0-agent-state' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case Z',
      ),
  },
  {
    name: 'AA family input removes the Budget option',
    mutate: (source) =>
      replaceRequired(source, '          - agent-budget\n', '', 'case AA'),
  },
  {
    name: 'AB Budget core maps to the wrong package directory',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-budget' && 'packages/agent-state' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case AB',
      ),
  },
  {
    name: 'AC Budget adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-budget' && '@j1nn0/agent-state-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case AC',
      ),
  },
  {
    name: 'AD Budget tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-budget' && 'j1nn0-agent-state' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case AD',
      ),
  },
  {
    name: 'AE family input removes the Tool Policy option',
    mutate: (source) =>
      replaceRequired(source, '          - agent-tool-policy\n', '', 'case AE'),
  },
  {
    name: 'AF Tool Policy core maps to the wrong package directory',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-tool-policy' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        "      CORE_PKG_DIR: ${{ inputs.family == 'agent-tool-policy' && 'packages/agent-budget' || inputs.family == 'agent-budget' && 'packages/agent-budget' || inputs.family == 'agent-handoff' && 'packages/agent-handoff' || inputs.family == 'agent-evidence' && 'packages/agent-evidence' || inputs.family == 'agent-retry-guard' && 'packages/agent-retry-guard' || inputs.family == 'agent-progress' && 'packages/agent-progress' || inputs.family == 'agent-state' && 'packages/agent-state' || 'packages/context-guard' }}\n",
        'case AF',
      ),
  },
  {
    name: 'AG Tool Policy adapter is paired with another core',
    mutate: (source) =>
      replaceRequired(
        source,
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-tool-policy-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        "      ADAPTER_PKG_NAME: ${{ inputs.family == 'agent-tool-policy' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-budget' && '@j1nn0/agent-budget-pi' || inputs.family == 'agent-handoff' && '@j1nn0/agent-handoff-pi' || inputs.family == 'agent-evidence' && '@j1nn0/agent-evidence-pi' || inputs.family == 'agent-retry-guard' && '@j1nn0/agent-retry-guard-pi' || inputs.family == 'agent-progress' && '@j1nn0/agent-progress-pi' || inputs.family == 'agent-state' && '@j1nn0/agent-state-pi' || '@j1nn0/agent-context-guard-pi' }}\n",
        'case AG',
      ),
  },
  {
    name: 'AH Tool Policy tarball base arm changes',
    mutate: (source) =>
      replaceRequired(
        source,
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-tool-policy' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        "      CORE_TARBALL_BASE: ${{ inputs.family == 'agent-tool-policy' && 'j1nn0-agent-budget' || inputs.family == 'agent-budget' && 'j1nn0-agent-budget' || inputs.family == 'agent-handoff' && 'j1nn0-agent-handoff' || inputs.family == 'agent-evidence' && 'j1nn0-agent-evidence' || inputs.family == 'agent-retry-guard' && 'j1nn0-agent-retry-guard' || inputs.family == 'agent-progress' && 'j1nn0-agent-progress' || inputs.family == 'agent-state' && 'j1nn0-agent-state' || 'j1nn0-agent-context-guard' }}\n",
        'case AH',
      ),
  },

  {
    name: 'AI Tool Policy smoke step loses its if (unwired smoke)',
    mutate: (source) =>
      replaceStep(
        source,
        toolPolicyPackedSmokeStart,
        toolPolicyPackedSmokeEnd,
        (step) => replaceUnique(step, toolPolicyPackedSmokeIf, '', 'case AI'),
        'case AI step',
      ),
  },
  {
    name: 'AJ Tool Policy packed smoke is gated on the wrong family',
    mutate: (source) =>
      replaceStep(
        source,
        toolPolicyPackedSmokeStart,
        toolPolicyPackedSmokeEnd,
        (step) =>
          replaceUnique(
            step,
            "inputs.family == 'agent-tool-policy'",
            "inputs.family == 'context-guard'",
            'case AJ',
          ),
        'case AJ step',
      ),
  },
  {
    name: 'AK duplicate Tool Policy packed smoke step for the same family',
    mutate: (source) =>
      replaceStep(
        source,
        toolPolicyPackedSmokeStart,
        toolPolicyPackedSmokeEnd,
        (step) => `${step}${step}`,
        'case AK step',
      ),
  },
  {
    name: 'AL Tool Policy packed smoke references an unknown family',
    mutate: (source) =>
      replaceStep(
        source,
        toolPolicyPackedSmokeStart,
        toolPolicyPackedSmokeEnd,
        (step) =>
          replaceUnique(
            step,
            "inputs.family == 'agent-tool-policy'",
            "inputs.family == 'agent-statte'",
            'case AL',
          ),
        'case AL step',
      ),
  },
  {
    name: 'AM validate build reverts to repo-wide build',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Build from a clean dist',
        '\n\n      - name: Typecheck',
        (step) =>
          replaceRequired(
            step,
            `${packageSetAssertLine}          pnpm -r --filter "$ADAPTER_PKG_NAME..." run build`,
            '          pnpm build',
            'case AM',
          ),
        'case AM step',
      ),
  },
  {
    name: 'AN validate build loses the package-set assertion',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Build from a clean dist',
        '\n\n      - name: Typecheck',
        (step) => replaceRequired(step, packageSetAssertLine, '', 'case AN'),
        'case AN step',
      ),
  },
  {
    name: 'AO validate typecheck loses the family filter',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Typecheck',
        '\n\n      - name: Test',
        (step) =>
          replaceRequired(
            step,
            '          pnpm -r --filter "$ADAPTER_PKG_NAME..." run typecheck',
            '          pnpm typecheck',
            'case AO',
          ),
        'case AO step',
      ),
  },
  {
    name: 'AQ validate test loses the family filter',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Test',
        '\n\n      - name: Check package quality',
        (step) =>
          replaceRequired(
            step,
            '          pnpm -r --filter "$ADAPTER_PKG_NAME..." run test',
            '          pnpm test',
            'case AQ',
          ),
        'case AQ step',
      ),
  },
  {
    name: 'AR validate package check loses the family filter',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Check package quality',
        '\n\n      - name: Run example',
        (step) =>
          replaceRequired(
            step,
            '          pnpm -r --filter "$ADAPTER_PKG_NAME..." run check:package',
            '          pnpm check:package',
            'case AR',
          ),
        'case AR step',
      ),
  },
  {
    name: 'AS validate example reverts to the repo-wide example',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Run example',
        '\n\n      - name: Dry-run pnpm package publication',
        () => '      - name: Run example\n        run: pnpm example',
        'case AS step',
      ),
  },
  {
    name: 'AT publish job reintroduces a build step',
    mutate: (source) =>
      replaceRequired(
        source,
        '      - name: Resolve, download, and audit validated release artifacts\n',
        '      - name: Build from a clean dist\n        run: pnpm build\n\n      - name: Resolve, download, and audit validated release artifacts\n',
        'case AT',
      ),
  },
  {
    name: 'AU publish job reintroduces dependency installation',
    mutate: (source) =>
      replaceRequired(
        source,
        '      - name: Resolve, download, and audit validated release artifacts\n',
        '      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n\n      - name: Resolve, download, and audit validated release artifacts\n',
        'case AU',
      ),
  },
  {
    name: 'AV CI preflight step is removed',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Require successful CI on the dispatched commit',
        '\n\n      - name: Set up pnpm',
        () => '',
        'case AV step',
      ),
  },
  {
    name: 'AW validate permissions lose actions read',
    mutate: (source) =>
      replaceRequired(
        source,
        '    permissions:\n      actions: read\n      contents: read\n',
        '    permissions:\n      contents: read\n',
        'case AW',
      ),
  },
  {
    name: 'AX CI preflight loses the exact SHA constraint',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Require successful CI on the dispatched commit',
        '\n\n      - name: Set up pnpm',
        (step) => replaceUnique(step, 'head_sha=${DISPATCH_SHA}', 'head_sha=', 'case AX'),
        'case AX step',
      ),
  },
  {
    name: 'AY CI preflight loses its fail-closed exit',
    mutate: (source) =>
      replaceStep(
        source,
        '      - name: Require successful CI on the dispatched commit',
        '\n\n      - name: Set up pnpm',
        (step) => replaceRequired(step, ciExhaustion, ciExhaustion.replace('exit 1', 'exit 0'), 'case AY'),
        'case AY step',
      ),
  },
  {
    name: 'BO validated_run_id input is removed',
    mutate: (source) => replaceRequired(source, validatedRunInputBlock, '', 'case BO'),
  },
  {
    name: 'BP validate-mode validated_run_id rejection is removed',
    mutate: (source) => replaceRequired(source, validatedRunModeOnly, '', 'case BP'),
  },
  {
    name: 'BQ validated_run_id numeric sanitizer is removed from input validation',
    mutate: (source) => replaceRequired(source, validatedRunNumericCheck, '', 'case BQ'),
  },
  {
    name: 'BR referenced validated run verification step is removed',
    mutate: (source) => replaceStep(source, validationReuseStepStart, validationReuseStepEnd, () => '', 'case BR'),
  },
  {
    name: 'BS referenced validated run exact-SHA check is removed',
    mutate: (source) => replaceRequired(source, verifyHeadShaCheck, '', 'case BS'),
  },
  {
    name: 'BT referenced validated run head-branch check is removed',
    mutate: (source) => replaceRequired(source, verifyHeadBranchCheck, '', 'case BT'),
  },
  {
    name: 'BU referenced validated run workflow-path check is removed',
    mutate: (source) => replaceRequired(source, verifyPathCheck, '', 'case BU'),
  },
  {
    name: 'BV referenced validated run event check is removed',
    mutate: (source) => replaceRequired(source, verifyEventCheck, '', 'case BV'),
  },
  {
    name: 'BW referenced validated run status and conclusion checks are removed',
    mutate: (source) => replaceRequired(source, verifyStatusConclusionChecks, '', 'case BW'),
  },
  {
    name: 'BX referenced validated run ordering check is removed',
    mutate: (source) => replaceRequired(source, verifyRunNumberCheck, '', 'case BX'),
  },
  {
    name: 'BY referenced jobs lose run_attempt binding',
    mutate: (source) => replaceRequired(source, verifyRunAttemptCheck, '', 'case BY'),
  },
  {
    name: 'BZ referenced jobs use the implicit latest endpoint',
    mutate: (source) => replaceUnique(source, 'attempts/${RUN_ATTEMPT}/jobs?per_page=100', 'jobs?per_page=100', 'case BZ'),
  },
  {
    name: 'CA referenced jobs lose total_count truncation check',
    mutate: (source) => replaceRequired(source, verifyTotalCountCheck, '', 'case CA'),
  },
  {
    name: 'CB referenced run validate-mode proof is removed',
    mutate: (source) => replaceRequired(source, verifyValidateModeProof, '', 'case CB'),
  },
  {
    name: 'CC referenced run required validate-step success checks are removed',
    mutate: (source) => replaceRequired(source, verifyRequiredStepSuccessChecks, '', 'case CC'),
  },
  {
    name: 'CD referenced run family smoke binding is removed',
    mutate: (source) => replaceRequired(source, verifySmokeMap, '', 'case CD'),
  },
  {
    name: 'CE referenced run selected smoke exactly-one success check is removed',
    mutate: (source) => replaceRequired(source, verifySelectedSmokeChecks, '', 'case CE'),
  },
  {
    name: 'CF Lint loses validated-run reuse skip wiring',
    mutate: (source) => replaceRequired(source, "        if: ${{ steps.validate_reuse.outputs.reuse != 'true' }}\n        run: pnpm lint\n", '        run: pnpm lint\n', 'case CF'),
  },
  {
    name: 'CG packed smoke loses its family predicate',
    mutate: (source) => replaceUnique(source, "        if: ${{ steps.validate_reuse.outputs.reuse != 'true' && inputs.family == 'context-guard' }}", "        if: ${{ steps.validate_reuse.outputs.reuse != 'true' }}", 'case CG'),
  },
  {
    name: 'CH CI preflight terminal fast-exit branch is removed',
    mutate: (source) => replaceRequired(source, ciTerminalBranch, '', 'case CH'),
  },
  {
    name: 'CI CI preflight loses startup_failure handling',
    mutate: (source) => replaceUnique(source, 'startup_failure', '', 'case CI'),
  },
  {
    name: 'CJ CI preflight loses latest-run selection',
    mutate: (source) => replaceRequired(source, '              latest = max(candidates, key=lambda r: r.get("run_number", -1))\n', '', 'case CJ'),
  },
  {
    name: 'CK validated artifact upload step is removed',
    mutate: (source) => replaceStep(source, uploadStepStart, uploadStepEnd, () => '', 'case CK'),
  },
  {
    name: 'CL validated artifact upload runs outside validate mode',
    mutate: (source) =>
      replaceStep(
        source,
        uploadStepStart,
        uploadStepEnd,
        (step) => replaceUnique(step, "        if: ${{ inputs.mode == 'validate' }}", '        if: ${{ always() }}', 'case CL'),
        'case CL step',
      ),
  },
  {
    name: 'CM validated artifact name loses the run-attempt suffix',
    mutate: (source) =>
      replaceStep(
        source,
        uploadStepStart,
        uploadStepEnd,
        (step) => replaceUnique(step, '-attempt-${{ github.run_attempt }}', '', 'case CM'),
        'case CM step',
      ),
  },
  {
    name: 'CN validated artifact upload enables overwrite',
    mutate: (source) =>
      replaceStep(
        source,
        uploadStepStart,
        uploadStepEnd,
        (step) => replaceUnique(step, '          overwrite: false\n', '          overwrite: true\n', 'case CN'),
        'case CN step',
      ),
  },
  {
    name: 'CO referenced-run required upload check is removed',
    mutate: (source) => replaceRequired(source, '              "Upload validated release tarballs",\n', '', 'case CO'),
  },
  {
    name: 'CP publish validated-artifact resolve step is removed',
    mutate: (source) => replaceStep(source, validatedTarballsStepStart, validatedTarballsStepEnd, () => '', 'case CP'),
  },
  {
    name: 'CQ publish artifact workflow-run ID binding is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '          if workflow_run["id"] != int(sys.argv[3]):\n', '', 'case CQ'),
        'case CQ step',
      ),
  },
  {
    name: 'CR publish artifact head-SHA binding is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '          if workflow_run["head_sha"] != sys.argv[4]:\n', '', 'case CR'),
        'case CR step',
      ),
  },
  {
    name: 'CS publish artifact list truncation check is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '          if not (total_count == len(artifacts)):\n', '', 'case CS'),
        'case CS step',
      ),
  },
  {
    name: 'CT publish artifact expiration check is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '          if artifact["expired"] is not False:\n', '', 'case CT'),
        'case CT step',
      ),
  },
  {
    name: 'CU publish artifact ZIP digest verification is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '          if [[ "$zip_digest" != "$ARTIFACT_DIGEST" ]]; then\n', '', 'case CU'),
        'case CU step',
      ),
  },
  {
    name: 'CV publish strict ZIP validation is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceUnique(step, '              with zipfile.ZipFile(zip_path) as zf:\n', '              with tarfile.ZipFile(zip_path) as zf:\n', 'case CV'),
        'case CV step',
      ),
  },
  {
    name: 'CW publish ZIP allows an extra member',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '                  if len(infos) != 2:\n', '', 'case CW'),
        'case CW step',
      ),
  },
  {
    name: 'CX publish ZIP allows path traversal',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '                      if ".." in name.split("/"):\n', '', 'case CX'),
        'case CX step',
      ),
  },
  {
    name: 'CY publish ZIP allows symlinks',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '                      if mode == 0o120000:\n', '', 'case CY'),
        'case CY step',
      ),
  },
  {
    name: 'CZ publish downloaded-tarball audit is removed',
    mutate: (source) =>
      replaceStep(
        source,
        validatedTarballsStepStart,
        validatedTarballsStepEnd,
        (step) => replaceRequired(step, '              with tarfile.open(archive, "r:gz") as tar:\n', '', 'case CZ'),
        'case CZ step',
      ),
  },
  {
    name: 'DA publish job reintroduces a build step',
    mutate: (source) =>
      replaceRequired(
        source,
        `${validatedTarballsStepStart}\n`,
        `      - name: Build from a clean dist\n        run: pnpm build\n\n${validatedTarballsStepStart}\n`,
        'case DA',
      ),
  },
  {
    name: 'DB publish job reintroduces dependency installation',
    mutate: (source) =>
      replaceRequired(
        source,
        `${validatedTarballsStepStart}\n`,
        `      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n\n${validatedTarballsStepStart}\n`,
        'case DB',
      ),
  },
  {
    name: 'DC publish job reintroduces pnpm repacking',
    mutate: (source) =>
      replaceRequired(
        source,
        `${validatedTarballsStepStart}\n`,
        `      - name: Repack validated artifacts\n        run: pnpm --filter "$CORE_PKG_NAME" pack\n\n${validatedTarballsStepStart}\n`,
        'case DC',
      ),
  },
  {
    name: 'DD publish regresses to directory publication',
    mutate: (source) =>
      replaceRequired(
        source,
        corePublishLine,
        '          npm publish "$CORE_PKG_DIR" --access public --provenance\n',
        'case DD',
      ),
  },
  {
    name: 'DE publish core operand is not linked to the resolve step',
    mutate: (source) =>
      replaceRequired(
        source,
        corePublishLine,
        '          npm publish "${{ steps.other.outputs.core_tarball }}" --access public --provenance\n',
        'case DE',
      ),
  },
  {
    name: 'DF State B core integrity comparison is removed',
    mutate: (source) =>
      replaceStep(
        source,
        registryPreflightStepStart,
        registryPreflightStepEnd,
        (step) => replaceRequired(step, '              if [[ "$registry_core_integrity" != "$validated_core_integrity" ]]; then\n', '', 'case DF'),
        'case DF step',
      ),
  },
  {
    name: 'DG Registry State C and D definitions are swapped',
    mutate: (source) =>
      replaceUnique(
        source,
        "          elif [[ \"$core_exists\" == false && \"$adapter_exists\" == true ]]; then\n            state='C'\n",
        "          elif [[ \"$core_exists\" == false && \"$adapter_exists\" == true ]]; then\n            state='D'\n",
        'case DG',
      ),
  },
  {
    name: 'DH publish permissions are over-broadened',
    mutate: (source) =>
      replaceRequired(
        source,
        '  publish:\n    permissions:\n      actions: read\n      contents: read\n      id-token: write\n',
        '  publish:\n    permissions:\n      actions: write\n      contents: read\n      id-token: write\n',
        'case DH',
      ),
  },
  {
    name: 'DI core provenance verification moves after adapter publication',
    mutate: (source) => {
      const withoutAdapter = replaceRequired(source, adapterPublishBlock, '', 'case DI removal');
      return replaceRequired(
        withoutAdapter,
        '      - name: Verify core provenance attestation before the adapter',
        `${adapterPublishBlock}      - name: Verify core provenance attestation before the adapter`,
        'case DI insertion',
      );
    },
  },
  {
    name: 'DJ publish mode no longer requires a validated run ID',
    mutate: (source) => replaceRequired(source, validatedRunRequiredBlock, '', 'case DJ'),
  },
  {
    name: 'DK validated artifact retention is removed',
    mutate: (source) =>
      replaceStep(
        source,
        uploadStepStart,
        uploadStepEnd,
        (step) => replaceRequired(step, '          retention-days: 90\n', '', 'case DK'),
        'case DK step',
      ),
  },
  {
    name: 'DL validate run attempt output is removed',
    mutate: (source) => replaceRequired(source, validateJobOutputBlock, '', 'case DL'),
  },
  {
    name: 'DM core registry visibility loop loses its max-attempt bound',
    mutate: (source) =>
      replaceStep(
        source,
        coreRegistryVisibilityStepStart,
        coreRegistryVisibilityStepEnd,
        (step) =>
          replaceRequired(
            step,
            registryVisibilityLoop,
            '          for ((attempt = 1; ; attempt += 1)); do\n',
            'case DM',
          ),
        'case DM step',
      ),
  },
  {
    name: 'DN adapter registry visibility loop loses its max-attempt bound',
    mutate: (source) =>
      replaceStep(
        source,
        adapterRegistryVisibilityStepStart,
        adapterRegistryVisibilityStepEnd,
        (step) =>
          replaceRequired(
            step,
            registryVisibilityLoop,
            '          for ((attempt = 1; ; attempt += 1)); do\n',
            'case DN',
          ),
        'case DN step',
      ),
  },
  {
    name: 'DO core registry visibility exhaustion failure is removed',
    mutate: (source) =>
      replaceStep(
        source,
        coreRegistryVisibilityStepStart,
        coreRegistryVisibilityStepEnd,
        (step) => replaceRequired(step, coreVisibilityExhaustionBlock, '', 'case DO'),
        'case DO step',
      ),
  },
  {
    name: 'DP adapter registry visibility exhaustion failure is removed',
    mutate: (source) =>
      replaceStep(
        source,
        adapterRegistryVisibilityStepStart,
        adapterRegistryVisibilityStepEnd,
        (step) => replaceRequired(step, adapterVisibilityExhaustionBlock, '', 'case DP'),
        'case DP step',
      ),
  },
  {
    name: 'DQ core registry visibility wait budget exceeds the ceiling',
    mutate: (source) =>
      replaceStep(
        source,
        coreRegistryVisibilityStepStart,
        coreRegistryVisibilityStepEnd,
        (step) => {
          const first = replaceRequired(step, 'retry_delay=15', 'retry_delay=150', 'case DQ first');
          return replaceRequired(first, 'retry_delay=5', 'retry_delay=50', 'case DQ subsequent');
        },
        'case DQ step',
      ),
  },
  {
    name: 'DR adapter registry visibility wait budget exceeds the ceiling',
    mutate: (source) =>
      replaceStep(
        source,
        adapterRegistryVisibilityStepStart,
        adapterRegistryVisibilityStepEnd,
        (step) => {
          const first = replaceRequired(step, 'retry_delay=15', 'retry_delay=150', 'case DR first');
          return replaceRequired(first, 'retry_delay=5', 'retry_delay=50', 'case DR subsequent');
        },
        'case DR step',
      ),
  },
  {
    name: 'DS core registry visibility moves after core provenance verification',
    mutate: (source) =>
      moveStepAfter(
        source,
        coreRegistryVisibilityStepStart,
        coreRegistryVisibilityStepEnd,
        '          echo "Core provenance attestation verified for $CORE_PKG_NAME@$CORE_VERSION."',
        'case DS',
      ),
  },
  {
    name: 'DT ci.yml loses the release-guard regression suite',
    file: 'ci.yml',
    mutate: (source) =>
      replaceRequired(
        source,
        "      - if: matrix.node == '24.x'\n        run: pnpm test:release-guard\n",
        '',
        'case DT',
      ),
  },
  {
    name: 'DU ci.yml loses the registry-poll regression suite',
    file: 'ci.yml',
    mutate: (source) =>
      replaceRequired(
        source,
        "      - if: matrix.node == '24.x'\n        run: pnpm test:registry-poll\n",
        '',
        'case DU',
      ),
  },
  {
    name: 'DV ci.yml release-guard regression suite loses its Node 24 gate',
    file: 'ci.yml',
    mutate: (source) =>
      replaceRequired(
        source,
        "      - if: matrix.node == '24.x'\n        run: pnpm test:release-guard\n",
        '      - run: pnpm test:release-guard\n',
        'case DV',
      ),
  },
  {
    name: 'DW Verify the referenced validated run loses GH_TOKEN',
    mutate: (source) =>
      replaceStep(
        source,
        validationReuseStepStart,
        validationReuseStepEnd,
        (step) =>
          replaceRequired(
            step,
            '          GH_TOKEN: ${{ github.token }}\n',
            '          GH_TOK3N: ${{ github.token }}\n',
            'case DW',
          ),
        'case DW step',
      ),
  },
];

const positiveMutations = [
  {
    name: 'AP unrelated family-gated step is tolerated',
    mutate: (source) =>
      replaceUnique(
        source,
        runExampleStep,
        `${runExampleStep}${unrelatedFamilyGatedStep}\n`,
        'case AP',
      ),
  },
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

  for (const testCase of positiveMutations) {
    const root = await createWorkflowCopy();
    const targetPath = join(root, '.github', 'workflows', testCase.file ?? 'release.yml');
    try {
      const source = await readFile(targetPath, 'utf8');
      await writeFile(targetPath, testCase.mutate(source));
      const result = await runGuard(root);
      if (result.code === 0) {
        console.log(`${testCase.name}: PASS (guard accepted mutation)`);
      } else {
        failures += 1;
        console.error(`${testCase.name}: FAIL (expected exit 0, got ${result.code})`);
        process.stderr.write(result.stderr);
      }
    } catch (error) {
      failures += 1;
      console.error(`${testCase.name}: FAIL (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  for (const testCase of mutations) {
    const root = await createWorkflowCopy();
    const targetPath = join(root, '.github', 'workflows', testCase.file ?? 'release.yml');
    try {
      const source = await readFile(targetPath, 'utf8');
      await writeFile(targetPath, testCase.mutate(source));
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
  console.error(`release guard suite failed: ${failures} case(s)`);
  process.exitCode = 1;
} else {
  console.log(`release guard suite passed: ${mutations.length} negative controls and ${positiveMutations.length + 1} positive controls (${mutations.length + positiveMutations.length + 1} cases)`);
}
