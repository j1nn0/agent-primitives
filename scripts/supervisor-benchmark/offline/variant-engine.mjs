/* global console */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepStrictEqual } from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createCheck,
  createCleanupRegistry,
  makeIsolation,
} from '../../supervisor-harness/runner.mjs';
import {
  canonicalDigest,
} from '../metrics.mjs';
import { runBenchmarkVariant } from '../run-variant.mjs';
import { computeSupervisorBenchmarkPlanFingerprint } from '../../../packages/agent-supervisor-pi/dist/benchmark/plan.js';
import { validateSupervisorBenchmarkDataset } from '../../../packages/agent-supervisor-pi/dist/benchmark/validate.js';

const TOOL_NAME = 'supervisor_benchmark_fixture_probe';
const FIXTURE_PATH = 'fixture.txt';
const OUTCOME_PATH = 'outcome.txt';
const SETUP_PATH = 'setup.txt';
const SETUP_CONTENT = 'throwaway-setup';
const FIXTURE_CONTENT = 'throwaway-fixture-bytes\n';
const OUTCOME_CONTENT = 'throwaway-task-complete';
const SENTINEL = 'throwaway-offline-sentinel';
const AUXILIARY_SYSTEM_PROMPT_PREFIX = 'You are a bounded claim/evidence extractor.';
const AUXILIARY_RESPONSE = JSON.stringify({
  schemaVersion: 1,
  claims: [
    {
      kind: 'completion',
      quote: 'Task complete.',
      evidence: [],
    },
  ],
});

function contentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function latestUserText(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return contentText(messages[index].content);
    }
  }
  return '';
}

function isAuxiliaryContext(context) {
  return (
    typeof context?.systemPrompt === 'string' &&
    context.systemPrompt.startsWith(AUXILIARY_SYSTEM_PROMPT_PREFIX) &&
    Array.isArray(context.messages) &&
    context.messages.length === 1
  );
}

function captureModelContext(capture, context) {
  capture.promptDigests.push(canonicalDigest(latestUserText(context)));
  const toolNames = Array.isArray(context?.tools)
    ? context.tools.map((tool) => tool?.name ?? null)
    : [];
  capture.toolAllowlistDigests.push(canonicalDigest(toolNames));
}

function scriptedResponses(agentResponses, capture) {
  const remaining = [...agentResponses];
  const responseFactory = (context) => {
    if (isAuxiliaryContext(context)) {
      return fauxAssistantMessage(fauxText(AUXILIARY_RESPONSE));
    }
    captureModelContext(capture, context);
    const response = remaining.shift();
    if (response === undefined) {
      throw new Error('offline faux script ran out of agent responses');
    }
    return response;
  };
  return Array.from({ length: 32 }, () => responseFactory);
}

function createCase(observations, oracleViews) {
  return {
    scenarioClass: 'offline-variant-engine',
    scenarioId: 'throwaway',
    caseId: 'example',
    sentinels: [SENTINEL],
    fixture: { [FIXTURE_PATH]: FIXTURE_CONTENT },
    tools: ['read', 'write', TOOL_NAME],
    limits: {
      maxRuns: 4,
      maxToolCalls: 16,
      safetyTimeoutMs: 5000,
    },
    storage: 'memory',
    createCustomTools(bench) {
      const observation = {
        fixtureDigest: undefined,
        outcomeDigest: undefined,
        verificationPassed: undefined,
      };
      observations.push(observation);
      return [
        {
          name: TOOL_NAME,
          label: 'Offline fixture probe',
          description: 'Reads the isolated fixture and records a deterministic verification.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
            additionalProperties: false,
          },
          execute: async (_toolCallId, input, signal) => {
            await Promise.resolve();
            if (signal?.aborted) {
              throw new Error('offline fixture probe aborted');
            }
            const fixture = readFileSync(join(bench.workspaceDir, input.path), 'utf8');
            observation.fixtureDigest = canonicalDigest(fixture);
            const passed = input.path === FIXTURE_PATH && fixture === FIXTURE_CONTENT;
            if (!passed) {
              bench.recordVerification({ name: 'fixture-check', passed: false });
              observation.verificationPassed = false;
              return {
                content: [{ type: 'text', text: 'fixture verification failed' }],
              };
            }
            writeFileSync(join(bench.workspaceDir, OUTCOME_PATH), OUTCOME_CONTENT);
            bench.recordVerification({ name: 'fixture-check', passed: true });
            observation.verificationPassed = true;
            observation.outcomeDigest = canonicalDigest(
              readFileSync(join(bench.workspaceDir, OUTCOME_PATH), 'utf8'),
            );
            return {
              content: [{ type: 'text', text: 'fixture verification passed' }],
            };
          },
        },
      ];
    },
    phases: [{ kind: 'prompt', text: 'Inspect the throwaway fixture and complete the task.' }],
    evaluate({ workspaceDir, trace }) {
      oracleViews.push(trace);
      try {
        return (
          readFileSync(join(workspaceDir, OUTCOME_PATH), 'utf8') === OUTCOME_CONTENT
        );
      } catch {
        return false;
      }
    },
    requiredVerificationSatisfied(prefix) {
      return prefix.verifications.some(
        (verification) =>
          verification.name === 'fixture-check' && verification.passed === true,
      );
    },
    classifyIntervention() {
      return 'justified';
    },
  };
}

function zeroMetrics() {
  return {
    meaningfulAgentRuns: 1,
    repeatedFailedInvocations: 0,
    unsupportedCompletionClaims: 0,
    userInterventions: 0,
    supervisorInterventions: 0,
    falseInterventions: 0,
    automaticFollowUps: 0,
    auxiliaryModelCalls: 0,
    supervisorFatalFailures: 0,
    rawToolOutputPersisted: 0,
    automaticContinuationLimitViolations: 0,
  };
}

function validationPlan(pairId) {
  return {
    schemaVersion: 1,
    benchmarkId: 'offline-variant-engine',
    sourceSha: '0'.repeat(40),
    policyId: 'offline-variant-engine-policy',
    expectedPairs: [
      {
        pairId,
        scenarioClass: 'offline-variant-engine',
        scenarioId: 'throwaway',
        caseId: 'example',
        modelFamily: 'offline',
        modelId: 'faux-1',
        executionProfile: 'offline',
        repetition: 1,
      },
    ],
  };
}

function validateRunRecord(check, run, label) {
  const plan = validationPlan(run.pairId);
  const counterpartVariant = run.variant === 'baseline' ? 'supervisor' : 'baseline';
  const counterpart =
    run.status === 'infrastructure-error'
      ? {
          schemaVersion: 1,
          runId: `${run.runId}-counterpart`,
          pairId: run.pairId,
          variant: counterpartVariant,
          status: 'infrastructure-error',
          errorKind: 'unknown',
        }
      : {
          schemaVersion: 1,
          runId: `${run.runId}-counterpart`,
          pairId: run.pairId,
          variant: counterpartVariant,
          status: 'completed',
          oracle: { kind: 'deterministic', taskSuccess: false },
          metrics: zeroMetrics(),
        };
  try {
    validateSupervisorBenchmarkDataset({
      schemaVersion: 1,
      plan,
      planFingerprint: computeSupervisorBenchmarkPlanFingerprint(plan),
      runs: [run, counterpart],
    });
    check(true, `${label}: run record passes the built S0-B validator`);
  } catch {
    check(false, `${label}: run record passes the built S0-B validator`);
  }
}

function checkEqual(check, left, right, label) {
  try {
    deepStrictEqual(left, right);
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

function assertVariantBlindOracleView(view) {
  const expectedTopLevelKeys = ['compaction', 'oracle', 'runs', 'toolEvents', 'verifications'];
  const expectedRunKeys = ['index', 'rootIndex'];
  const expectedToolEventKeys = [
    'inputDigest',
    'isError',
    'mutation',
    'order',
    'resultDigest',
    'runIndex',
    'toolCallId',
    'toolName',
  ];
  if (
    view === null ||
    typeof view !== 'object' ||
    Array.isArray(view) ||
    Object.hasOwn(view, 'supervisor') ||
    !Array.isArray(view.runs) ||
    !Array.isArray(view.toolEvents) ||
    !Array.isArray(view.verifications)
  ) {
    throw new Error('Oracle view contains a variant-specific field.');
  }
  deepStrictEqual(Object.keys(view).sort(), expectedTopLevelKeys);
  for (const run of view.runs) {
    if (
      run === null ||
      typeof run !== 'object' ||
      Array.isArray(run) ||
      Object.hasOwn(run, 'cause') ||
      Object.hasOwn(run, 'finalAssistantText')
    ) {
      throw new Error('Oracle run contains a forbidden field.');
    }
    deepStrictEqual(Object.keys(run).sort(), expectedRunKeys);
  }
  for (const event of view.toolEvents) {
    if (
      event === null ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      Object.hasOwn(event, 'blockedBySupervisor')
    ) {
      throw new Error('Oracle tool event contains a forbidden field.');
    }
    deepStrictEqual(Object.keys(event).sort(), expectedToolEventKeys);
  }
}

async function createOfflineModelRuntime(cleanup) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(isolation.agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(isolation.agentDir, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider();
  modelRuntime.registerNativeProvider(faux.provider);
  cleanup.registerCleanup(() => {
    modelRuntime.unregisterProvider('faux');
  });
  return { modelRuntime, faux, model: faux.getModel() };
}

async function runVariantCase({
  scenarioCase,
  variant,
  model,
  modelRuntime,
  faux,
  capture,
  responses,
  runId,
  pairId,
  waitForFollowUpRuns,
}) {
  faux.setResponses(scriptedResponses(responses, capture));
  return runBenchmarkVariant({
    scenarioCase,
    variant,
    model,
    thinkingLevel: 'off',
    modelRuntime,
    pairId,
    runId,
    waitForFollowUpRuns,
  });
}

export const name = 'variant-engine';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { modelRuntime, faux, model } = await createOfflineModelRuntime(cleanup);
  const observations = [];
  const oracleViews = [];
  const scenarioCase = createCase(observations, oracleViews);
  const parityResponses = [
    fauxAssistantMessage(
      fauxToolCall('read', { path: FIXTURE_PATH }, { id: 'parity-read' }),
    ),
    fauxAssistantMessage(
      fauxToolCall(TOOL_NAME, { path: FIXTURE_PATH }, { id: 'parity-probe' }),
    ),
    fauxAssistantMessage(fauxText('No completion claim.')),
  ];

  try {
    const baselineCapture = { promptDigests: [], toolAllowlistDigests: [] };
    const baseline = await runVariantCase({
      scenarioCase,
      variant: 'baseline',
      model,
      modelRuntime,
      faux,
      capture: baselineCapture,
      responses: parityResponses,
      runId: 'offline-variant-baseline',
      pairId: 'offline-variant-parity',
    });
    const supervisorCapture = { promptDigests: [], toolAllowlistDigests: [] };
    const supervisor = await runVariantCase({
      scenarioCase,
      variant: 'supervisor',
      model,
      modelRuntime,
      faux,
      capture: supervisorCapture,
      responses: parityResponses,
      runId: 'offline-variant-supervisor',
      pairId: 'offline-variant-parity',
    });

    const baselineOracleView = oracleViews[0];
    const supervisorOracleView = oracleViews[1];
    let baselineOracleViewAccepted = false;
    try {
      assertVariantBlindOracleView(baselineOracleView);
      baselineOracleViewAccepted = true;
    } catch {
      // The check below records the failed assertion without exposing trace data.
    }
    check(
      baselineOracleViewAccepted,
      'the object passed to baseline evaluate has only variant-blind trace fields',
    );
    let supervisorOracleViewAccepted = false;
    try {
      assertVariantBlindOracleView(supervisorOracleView);
      supervisorOracleViewAccepted = true;
    } catch {
      // The check below records the failed assertion without exposing trace data.
    }
    check(
      supervisorOracleViewAccepted,
      'the object passed to Supervisor evaluate has only variant-blind trace fields',
    );

    // The throwaway case uses identical scripted model/tool behavior in adjacent runs.
    // Its sanitized views omit timing, token totals, run causes, final text, and all
    // Supervisor projection data, so deep equality proves no variant-only value is visible.
    checkDeepEqual(
      check,
      baselineOracleView,
      supervisorOracleView,
      'baseline and Supervisor oracle views are deeply equal',
    );

    // Negative control: reintroduce the projection on a throwaway copy. The assertion
    // must reject it, while the original frozen view must still pass afterward.
    let negativeControlRejected = false;
    try {
      assertVariantBlindOracleView({
        ...baselineOracleView,
        supervisor: { interventions: [{ kind: 'synthetic' }] },
      });
    } catch {
      negativeControlRejected = true;
    }
    check(
      negativeControlRejected,
      'negative control: reintroduced Supervisor projection fails assertion (a)',
    );

    let restoredOracleViewAccepted = false;
    try {
      assertVariantBlindOracleView(baselineOracleView);
      restoredOracleViewAccepted = true;
    } catch {
      // The check below records whether the original sanitized view was restored.
    }
    check(
      restoredOracleViewAccepted,
      'restored sanitized oracle view passes assertion (a)',
    );

    check(
      baseline.status === 'completed' && supervisor.status === 'completed',
      'variant parity produced two completed run records',
    );
    checkEqual(
      check,
      baselineCapture.promptDigests,
      supervisorCapture.promptDigests,
      'baseline and Supervisor sent identical prompt text to agent model calls',
    );
    checkEqual(
      check,
      baselineCapture.toolAllowlistDigests,
      supervisorCapture.toolAllowlistDigests,
      'baseline and Supervisor exposed an identical tool allowlist',
    );
    checkEqual(
      check,
      observations[0]?.fixtureDigest,
      observations[1]?.fixtureDigest,
      'baseline and Supervisor materialized identical fixture bytes',
    );
    checkEqual(
      check,
      observations[0]?.outcomeDigest,
      observations[1]?.outcomeDigest,
      'baseline and Supervisor produced the same workspace-visible outcome',
    );
    check(
      baseline.oracle?.taskSuccess === true && supervisor.oracle?.taskSuccess === true,
      'the deterministic workspace oracle agreed across variants',
    );
    if (baseline.status === 'completed') {
      for (const key of [
        'supervisorInterventions',
        'falseInterventions',
        'automaticFollowUps',
        'auxiliaryModelCalls',
        'supervisorFatalFailures',
        'rawToolOutputPersisted',
        'automaticContinuationLimitViolations',
      ]) {
        check(baseline.metrics[key] === 0, `baseline ${key} is zero`);
      }
    }
    validateRunRecord(check, baseline, 'parity baseline');
    validateRunRecord(check, supervisor, 'parity supervisor');

    const followUpResponses = [
      fauxAssistantMessage(
        fauxToolCall('write', { path: SETUP_PATH, content: SETUP_CONTENT }, { id: 'follow-up-write' }),
      ),
      fauxAssistantMessage(fauxText('Task complete.')),
      fauxAssistantMessage(
        fauxToolCall(TOOL_NAME, { path: FIXTURE_PATH }, { id: 'follow-up-probe' }),
      ),
      fauxAssistantMessage(fauxText('Verification finished.')),
    ];
    const fullCapture = { promptDigests: [], toolAllowlistDigests: [] };
    const full = await runVariantCase({
      scenarioCase,
      variant: 'supervisor',
      model,
      modelRuntime,
      faux,
      capture: fullCapture,
      responses: followUpResponses,
      runId: 'offline-variant-follow-up',
      pairId: 'offline-variant-follow-up',
      waitForFollowUpRuns: true,
    });
    check(
      full.status === 'completed' && full.metrics?.meaningfulAgentRuns === 2,
      'full settlement observed the Supervisor follow-up as a second meaningful agent run',
    );
    check(
      full.metrics?.automaticFollowUps === 1 &&
        full.oracle?.taskSuccess === true,
      'full settlement retained the follow-up and deterministic success',
    );
    validateRunRecord(check, full, 'full-settlement Supervisor');

    const naiveCapture = { promptDigests: [], toolAllowlistDigests: [] };
    const naive = await runVariantCase({
      scenarioCase,
      variant: 'supervisor',
      model,
      modelRuntime,
      faux,
      capture: naiveCapture,
      responses: followUpResponses,
      runId: 'offline-variant-naive-follow-up',
      pairId: 'offline-variant-naive',
      waitForFollowUpRuns: false,
    });
    check(
      naive.status === 'completed' && naive.metrics?.meaningfulAgentRuns === 1,
      'naive settlement missed the not-yet-started follow-up and observed one run',
    );
    console.log(
      `  TRACE variant-engine settlement: naive meaningfulAgentRuns=${naive.metrics?.meaningfulAgentRuns ?? 'infrastructure-error'}, full meaningfulAgentRuns=${full.metrics?.meaningfulAgentRuns ?? 'infrastructure-error'}`,
    );
    validateRunRecord(check, naive, 'naive-settlement Supervisor');

    const providerCapture = { promptDigests: [], toolAllowlistDigests: [] };
    const providerCallsBefore = faux.state.callCount;
    const providerFailure = await runVariantCase({
      scenarioCase,
      variant: 'baseline',
      model,
      modelRuntime,
      faux,
      capture: providerCapture,
      responses: [
        fauxAssistantMessage(fauxText('provider failure'), {
          stopReason: 'error',
          errorMessage: 'offline provider failure',
        }),
      ],
      runId: 'offline-variant-provider-failure',
      pairId: 'offline-variant-provider',
    });
    check(
      providerFailure.status === 'infrastructure-error' &&
        providerFailure.errorKind === 'provider',
      'provider failure produced exactly one provider infrastructure-error record',
    );
    check(
      faux.state.callCount === providerCallsBefore + 1,
      'provider failure was not retried and no replacement call was made',
    );
    validateRunRecord(check, providerFailure, 'provider-failure baseline');

    const limitCase = {
      ...scenarioCase,
      limits: {
        ...scenarioCase.limits,
        maxToolCalls: 0,
      },
    };
    const limitCapture = { promptDigests: [], toolAllowlistDigests: [] };
    const limited = await runVariantCase({
      scenarioCase: limitCase,
      variant: 'baseline',
      model,
      modelRuntime,
      faux,
      capture: limitCapture,
      responses: [
        fauxAssistantMessage(
          fauxToolCall(TOOL_NAME, { path: FIXTURE_PATH }, { id: 'limit-probe' }),
        ),
        fauxAssistantMessage(fauxText('No completion claim.')),
      ],
      runId: 'offline-variant-tool-limit',
      pairId: 'offline-variant-limit',
    });
    check(
      limited.status === 'completed' && limited.oracle?.taskSuccess === false,
      'maxToolCalls produced a completed unsuccessful run rather than infrastructure error',
    );
    validateRunRecord(check, limited, 'behavioral-limit baseline');

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: 'variant execution, settlement, failure classification, and limits verified',
        }
      : { status: 'fail', reason: 'variant execution assertions failed' };
  } finally {
    await cleanup.cleanupAll();
  }
}
