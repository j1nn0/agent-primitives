import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { computeSupervisorBenchmarkPlanFingerprint } from '../../../packages/agent-supervisor-pi/dist/benchmark/plan.js';
import { validateSupervisorBenchmarkDataset } from '../../../packages/agent-supervisor-pi/dist/benchmark/validate.js';
import { createCleanupRegistry, createCheck } from '../../supervisor-harness/runner.mjs';
import {
  canonicalDigest,
  computeSupervisorBenchmarkRunMetrics,
} from '../metrics.mjs';

const SENTINEL = 'offline-tool-output-sentinel';

function makeRun(index, rootIndex = index, finalAssistantText = 'No completion claim.') {
  return {
    index,
    rootIndex,
    cause: index === 0 ? 'planned-phase' : 'supervisor-follow-up',
    finalAssistantText,
  };
}

function makeTrace(overrides = {}) {
  return {
    runs: overrides.runs ?? [makeRun(0, 0)],
    toolEvents: overrides.toolEvents ?? [],
    verifications: overrides.verifications ?? [],
    supervisor: {
      interventions: [],
      auxiliaryModelCalls: 0,
      auxiliaryTokens: { input: 0, output: 0, total: 0 },
      persistedPayloads: [],
      handlerThrows: 0,
      extensionLoadErrors: 0,
      ...overrides.supervisor,
    },
    sessionTokenTotal: overrides.sessionTokenTotal,
    wallClockMs: overrides.wallClockMs,
    oracle: { taskSuccess: false, ...overrides.oracle },
  };
}

function failedToolEvent(order, runIndex, blockedBySupervisor = false) {
  return {
    order,
    runIndex,
    toolCallId: `call-${order}`,
    toolName: 'offline-failing-tool',
    inputDigest: 'same-input',
    resultDigest: 'same-result',
    isError: true,
    blockedBySupervisor,
    mutation: 'none',
  };
}

function standardRules(overrides = {}) {
  return {
    sentinels: [SENTINEL],
    requiredVerificationSatisfied: (prefix) =>
      prefix.verifications.some((verification) => verification.passed),
    classifyIntervention: () => 'justified',
    ...overrides,
  };
}

function expectedMetrics(overrides = {}) {
  return {
    meaningfulAgentRuns: 1,
    repeatedFailedInvocations: 0,
    unsupportedCompletionClaims: 0,
    userInterventions: 1,
    supervisorInterventions: 0,
    falseInterventions: 0,
    automaticFollowUps: 0,
    auxiliaryModelCalls: 0,
    supervisorFatalFailures: 0,
    rawToolOutputPersisted: 0,
    automaticContinuationLimitViolations: 0,
    ...overrides,
  };
}

function recordMetrics(produced, trace, rules, expected, label, variant = 'supervisor') {
  const metrics = computeSupervisorBenchmarkRunMetrics(trace, rules);
  deepStrictEqual(metrics, expected);
  produced.push({ label, metrics, variant });
  return metrics;
}

function benchmarkPlan() {
  return {
    schemaVersion: 1,
    benchmarkId: 'offline-metrics',
    sourceSha: '0'.repeat(40),
    policyId: 'offline-metrics-policy',
    expectedPairs: [
      {
        pairId: 'offline-metrics-pair',
        scenarioClass: 'offline-metrics',
        scenarioId: 'metrics',
        caseId: 'synthetic',
        modelFamily: 'offline',
        modelId: 'synthetic-model',
        executionProfile: 'offline',
        repetition: 1,
      },
    ],
  };
}

function validateEveryMetric(produced, baselineMetrics) {
  const plan = benchmarkPlan();
  const planFingerprint = computeSupervisorBenchmarkPlanFingerprint(plan);
  for (let index = 0; index < produced.length; index += 1) {
    const dataset = {
      schemaVersion: 1,
      plan,
      planFingerprint,
      runs: [
        {
          schemaVersion: 1,
          runId: `baseline-${index}`,
          pairId: 'offline-metrics-pair',
          variant: 'baseline',
          status: 'completed',
          oracle: { kind: 'deterministic', taskSuccess: true },
          metrics: baselineMetrics,
        },
        {
          schemaVersion: 1,
          runId: `supervisor-${index}`,
          pairId: 'offline-metrics-pair',
          variant: 'supervisor',
          status: 'completed',
          oracle: { kind: 'deterministic', taskSuccess: false },
          metrics: produced[index].metrics,
        },
      ],
    };
    validateSupervisorBenchmarkDataset(dataset);
  }
}

export const name = 'metrics';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { cleanupAll } = cleanup;
  const produced = [];

  try {
    const fullTrace = makeTrace({
      runs: [
        makeRun(0, 0, 'Task complete.'),
        makeRun(1, 0),
        makeRun(2, 1, 'Task complete.'),
      ],
      toolEvents: [
        failedToolEvent(1, 0),
        failedToolEvent(2, 0),
        failedToolEvent(3, 0, true),
        failedToolEvent(4, 2),
      ],
      verifications: [
        { order: 5, runIndex: 0, name: 'required-check', passed: false },
        { order: 6, runIndex: 1, name: 'required-check', passed: false },
        { order: 7, runIndex: 2, name: 'required-check', passed: true },
      ],
      supervisor: {
        interventions: [
          { runIndex: 0, kind: 'steer', phase: 'planning' },
          { runIndex: 1, kind: 'follow-up', phase: 'retry' },
          { runIndex: 1, kind: 'follow-up', phase: 'false-phase' },
          { runIndex: 2, kind: 'block', phase: 'tool_call' },
        ],
        auxiliaryModelCalls: 3,
        auxiliaryTokens: { input: 10, output: 20, total: 30 },
        persistedPayloads: [
          { customType: 'record-one', record: { items: [{ text: SENTINEL }] } },
          { customType: 'record-two', record: { text: 'ordinary content' } },
          {
            customType: 'record-three',
            record: [SENTINEL, { nested: { text: `two-${SENTINEL}` } }],
          },
        ],
        handlerThrows: 1,
        extensionLoadErrors: 2,
      },
      sessionTokenTotal: 100,
      wallClockMs: 12.6,
      oracle: { taskSuccess: true },
    });
    const fullMetrics = recordMetrics(
      produced,
      fullTrace,
      standardRules({
        classifyIntervention: (intervention) =>
          intervention.phase === 'false-phase' ? 'false' : 'justified',
      }),
      {
        meaningfulAgentRuns: 3,
        repeatedFailedInvocations: 1,
        unsupportedCompletionClaims: 1,
        userInterventions: 0,
        supervisorInterventions: 4,
        falseInterventions: 1,
        automaticFollowUps: 2,
        auxiliaryModelCalls: 3,
        supervisorFatalFailures: 3,
        rawToolOutputPersisted: 2,
        automaticContinuationLimitViolations: 1,
        totalTokens: 130,
        wallClockMs: 13,
      },
      'full trace',
    );
    check(fullMetrics.falseInterventions === 1, 'full trace exact metrics');

    const blockedMetrics = recordMetrics(
      produced,
      makeTrace({
        toolEvents: [
          failedToolEvent(1, 0),
          failedToolEvent(2, 0),
          failedToolEvent(3, 0, true),
        ],
      }),
      standardRules(),
      expectedMetrics({ repeatedFailedInvocations: 1 }),
      'blocked call exclusion',
    );
    check(
      blockedMetrics.repeatedFailedInvocations === 1,
      'blocked calls are excluded from repeated failures',
    );

    const perRootMetrics = recordMetrics(
      produced,
      makeTrace({
        runs: [makeRun(0, 0), makeRun(1, 1)],
        toolEvents: [failedToolEvent(1, 0), failedToolEvent(2, 1)],
      }),
      standardRules(),
      expectedMetrics({ meaningfulAgentRuns: 2 }),
      'per-root reset',
    );
    check(perRootMetrics.repeatedFailedInvocations === 0, 'failure identity resets per root');

    const repairedMetrics = recordMetrics(
      produced,
      makeTrace({
        runs: [makeRun(0, 0, 'Task complete.'), makeRun(1, 0, 'Task complete.')],
        verifications: [
          { order: 1, runIndex: 0, name: 'required-check', passed: false },
          { order: 2, runIndex: 1, name: 'required-check', passed: true },
        ],
        oracle: { taskSuccess: true },
      }),
      standardRules(),
      expectedMetrics({
        meaningfulAgentRuns: 2,
        unsupportedCompletionClaims: 1,
        userInterventions: 0,
      }),
      'unsupported completion monotonicity',
    );
    check(
      repairedMetrics.unsupportedCompletionClaims === 1,
      'a repaired unsupported completion claim remains counted',
    );

    const repeatedUnsupportedMetrics = recordMetrics(
      produced,
      makeTrace({
        runs: [makeRun(0, 0, 'Task complete.'), makeRun(1, 0, 'Task complete.')],
        verifications: [
          { order: 1, runIndex: 0, name: 'required-check', passed: false },
          { order: 2, runIndex: 1, name: 'required-check', passed: false },
        ],
      }),
      standardRules(),
      expectedMetrics({ meaningfulAgentRuns: 2, unsupportedCompletionClaims: 2 }),
      'second unsupported completion claim',
    );
    check(
      repeatedUnsupportedMetrics.unsupportedCompletionClaims === 2,
      'later unsupported completion claims are counted again',
    );

    const oneFollowUpMetrics = recordMetrics(
      produced,
      makeTrace({
        runs: [makeRun(0, 0), makeRun(1, 0)],
        supervisor: {
          interventions: [{ runIndex: 1, kind: 'follow-up', phase: 'retry' }],
        },
      }),
      standardRules(),
      expectedMetrics({
        meaningfulAgentRuns: 2,
        supervisorInterventions: 1,
        automaticFollowUps: 1,
      }),
      'one follow-up continuation bound',
    );
    strictEqual(oneFollowUpMetrics.automaticContinuationLimitViolations, 0);

    const twoFollowUpsMetrics = recordMetrics(
      produced,
      makeTrace({
        runs: [makeRun(0, 0), makeRun(1, 0), makeRun(2, 0)],
        supervisor: {
          interventions: [
            { runIndex: 1, kind: 'follow-up', phase: 'retry' },
            { runIndex: 2, kind: 'follow-up', phase: 'retry' },
          ],
        },
      }),
      standardRules(),
      expectedMetrics({
        meaningfulAgentRuns: 3,
        supervisorInterventions: 2,
        automaticFollowUps: 2,
        automaticContinuationLimitViolations: 1,
      }),
      'two follow-up continuation bound',
    );
    strictEqual(twoFollowUpsMetrics.automaticContinuationLimitViolations, 1);

    const nestedPayloadMetrics = recordMetrics(
      produced,
      makeTrace({
        supervisor: {
          persistedPayloads: [
            { customType: 'nested', record: [{ object: { value: SENTINEL } }] },
            { customType: 'duplicate-sentinel', record: { a: SENTINEL, b: `x-${SENTINEL}` } },
          ],
        },
      }),
      standardRules(),
      expectedMetrics({ rawToolOutputPersisted: 2 }),
      'nested persisted sentinel',
    );
    strictEqual(nestedPayloadMetrics.rawToolOutputPersisted, 2);

    const absentPayloadMetrics = recordMetrics(
      produced,
      makeTrace({
        supervisor: {
          persistedPayloads: [{ customType: 'clean', record: { values: ['ordinary'] } }],
        },
      }),
      standardRules(),
      expectedMetrics(),
      'absent persisted sentinel',
    );
    strictEqual(absentPayloadMetrics.rawToolOutputPersisted, 0);

    const absentTimingMetrics = recordMetrics(
      produced,
      makeTrace(),
      standardRules(),
      expectedMetrics(),
      'unavailable timing and tokens',
    );
    strictEqual(Object.hasOwn(absentTimingMetrics, 'totalTokens'), false);
    strictEqual(Object.hasOwn(absentTimingMetrics, 'wallClockMs'), false);

    const presentTimingMetrics = recordMetrics(
      produced,
      makeTrace({
        supervisor: { auxiliaryTokens: { input: 1, output: 2, total: 4 } },
        sessionTokenTotal: 10,
        wallClockMs: 10.4,
      }),
      standardRules(),
      expectedMetrics({ totalTokens: 14, wallClockMs: 10 }),
      'available timing and tokens',
    );
    strictEqual(presentTimingMetrics.totalTokens, 14);
    strictEqual(presentTimingMetrics.wallClockMs, 10);

    const baselineMetrics = recordMetrics(
      produced,
      makeTrace({
        runs: [makeRun(0, 0, 'Task complete.')],
        verifications: [{ order: 1, runIndex: 0, name: 'required-check', passed: true }],
        oracle: { taskSuccess: true },
      }),
      standardRules(),
      expectedMetrics({ userInterventions: 0 }),
      'baseline-shaped trace',
      'baseline',
    );
    for (const key of [
      'supervisorInterventions',
      'falseInterventions',
      'automaticFollowUps',
      'auxiliaryModelCalls',
      'supervisorFatalFailures',
      'rawToolOutputPersisted',
      'automaticContinuationLimitViolations',
    ]) {
      strictEqual(baselineMetrics[key], 0);
    }
    check(true, 'baseline supervisor-only metrics are zero');

    const customUserInterventionMetrics = recordMetrics(
      produced,
      makeTrace({ oracle: { taskSuccess: true } }),
      standardRules({ userInterventions: () => 1 }),
      expectedMetrics({ userInterventions: 1 }),
      'custom user intervention policy',
    );
    strictEqual(customUserInterventionMetrics.userInterventions, 1);

    strictEqual(
      canonicalDigest({ b: 2, a: { d: 4, c: 3 } }),
      canonicalDigest({ a: { c: 3, d: 4 }, b: 2 }),
    );
    check(true, 'canonical digest is independent of object key insertion order');

    validateEveryMetric(produced, baselineMetrics);
    const plan = benchmarkPlan();
    const fullDataset = {
      schemaVersion: 1,
      plan,
      planFingerprint: computeSupervisorBenchmarkPlanFingerprint(plan),
      runs: [
        {
          schemaVersion: 1,
          runId: 'baseline-run',
          pairId: 'offline-metrics-pair',
          variant: 'baseline',
          status: 'completed',
          oracle: { kind: 'deterministic', taskSuccess: true },
          metrics: baselineMetrics,
        },
        {
          schemaVersion: 1,
          runId: 'supervisor-run',
          pairId: 'offline-metrics-pair',
          variant: 'supervisor',
          status: 'completed',
          oracle: { kind: 'deterministic', taskSuccess: true },
          metrics: fullMetrics,
        },
      ],
    };
    validateSupervisorBenchmarkDataset(fullDataset);
    check(true, 'every produced metrics object passes the built S0-B validator');

    return result.status === 'pass'
      ? { status: 'pass', reason: 'pure benchmark metrics and schema conformance verified' }
      : { status: 'fail', reason: 'metrics assertions failed' };
  } finally {
    await cleanupAll();
  }
}
