/* global process, setTimeout, clearTimeout */

import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createBenchmarkTelemetry } from './telemetry.mjs';
import { createTraceRecorder } from './trace.mjs';
import { computeSupervisorBenchmarkRunMetrics } from './metrics.mjs';
import { createBenchmarkSession } from './session.mjs';
import { clearActiveBenchmarkTelemetry } from './wrapper-extension.mjs';

const COMPLETION_PROTOCOL_MARKER =
  '\n\nWhen you believe the requested task is fully complete, include the exact sentence "Task complete." in your final response. Do not include it otherwise.';

const SUPERVISOR_ONLY_METRIC_KEYS = Object.freeze([
  'supervisorInterventions',
  'falseInterventions',
  'automaticFollowUps',
  'auxiliaryModelCalls',
  'supervisorFatalFailures',
  'rawToolOutputPersisted',
  'automaticContinuationLimitViolations',
]);

class BenchmarkTimeoutError extends Error {
  constructor() {
    super('Benchmark safety timeout exceeded.');
    this.name = 'BenchmarkTimeoutError';
  }
}

class BenchmarkFailure extends Error {
  constructor(kind) {
    super(`Benchmark ${kind} failure.`);
    this.name = 'BenchmarkFailure';
    this.kind = kind;
  }
}

function nowMilliseconds() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function isRecord(value) {
  return value !== null && typeof value === 'object';
}

function cloneOracleTraceValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneOracleTraceValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneOracleTraceValue(child)]),
    );
  }
  return value;
}

function deepFreezeOracleTrace(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeOracleTrace(child);
  }
  return Object.freeze(value);
}

/**
 * Expose only variant-neutral trace data to a deterministic task oracle. Policy
 * metrics intentionally continue to receive the full trace returned by getTrace().
 */
function createOracleTraceView(trace) {
  if (!isRecord(trace) || Array.isArray(trace)) {
    throw new BenchmarkFailure('oracle');
  }
  const runs = Array.isArray(trace.runs) ? trace.runs : [];
  const toolEvents = Array.isArray(trace.toolEvents) ? trace.toolEvents : [];
  const oracleView = {
    runs: runs.map((run) => ({
      index: run?.index,
      rootIndex: run?.rootIndex,
    })),
    toolEvents: toolEvents.map((event) => ({
      order: event?.order,
      runIndex: event?.runIndex,
      toolCallId: event?.toolCallId,
      toolName: event?.toolName,
      inputDigest: event?.inputDigest,
      resultDigest: event?.resultDigest,
      isError: event?.isError,
      mutation: event?.mutation,
    })),
    verifications: cloneOracleTraceValue(trace.verifications ?? []),
    compaction: cloneOracleTraceValue(trace.compaction),
    oracle: cloneOracleTraceValue(trace.oracle),
  };
  return deepFreezeOracleTrace(oracleView);
}

function assertStringArray(value, name) {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new BenchmarkFailure('harness');
  }
  if (name === 'sentinels' && value.some((item) => item.length === 0)) {
    throw new BenchmarkFailure('harness');
  }
}

function assertScenarioCase(scenarioCase) {
  if (!isRecord(scenarioCase)) {
    throw new BenchmarkFailure('harness');
  }
  for (const name of ['scenarioClass', 'scenarioId', 'caseId']) {
    if (typeof scenarioCase[name] !== 'string' || scenarioCase[name].length === 0) {
      throw new BenchmarkFailure('harness');
    }
  }
  assertStringArray(scenarioCase.sentinels, 'sentinels');
  assertStringArray(scenarioCase.tools, 'tools');
  if (!isRecord(scenarioCase.fixture)) {
    throw new BenchmarkFailure('harness');
  }
  if (
    !isRecord(scenarioCase.limits) ||
    !Number.isSafeInteger(scenarioCase.limits.maxRuns) ||
    scenarioCase.limits.maxRuns < 0 ||
    !Number.isSafeInteger(scenarioCase.limits.maxToolCalls) ||
    scenarioCase.limits.maxToolCalls < 0 ||
    !Number.isFinite(scenarioCase.limits.safetyTimeoutMs) ||
    scenarioCase.limits.safetyTimeoutMs <= 0
  ) {
    throw new BenchmarkFailure('harness');
  }
  if (scenarioCase.storage !== 'memory' && scenarioCase.storage !== 'file') {
    throw new BenchmarkFailure('harness');
  }
  if (typeof scenarioCase.createCustomTools !== 'function') {
    throw new BenchmarkFailure('harness');
  }
  if (!Array.isArray(scenarioCase.phases) || scenarioCase.phases.length === 0) {
    throw new BenchmarkFailure('harness');
  }
  for (const phase of scenarioCase.phases) {
    if (!isRecord(phase)) {
      throw new BenchmarkFailure('harness');
    }
    if (phase.kind === 'prompt') {
      if (typeof phase.text !== 'string') {
        throw new BenchmarkFailure('harness');
      }
    } else if (phase.kind !== 'compact' && phase.kind !== 'resume') {
      throw new BenchmarkFailure('harness');
    }
  }
  if (typeof scenarioCase.evaluate !== 'function') {
    throw new BenchmarkFailure('harness');
  }
  if (typeof scenarioCase.requiredVerificationSatisfied !== 'function') {
    throw new BenchmarkFailure('harness');
  }
  if (typeof scenarioCase.classifyIntervention !== 'function') {
    throw new BenchmarkFailure('harness');
  }
}

function createIsolation() {
  const base = mkdtempSync(join(tmpdir(), 'supervisor-benchmark-'));
  const agentDir = join(base, 'agent');
  const workDir = join(base, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return {
    base,
    agentDir,
    workDir,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function materializeFixture(workspaceDir, fixture) {
  for (const [relativePath, contents] of Object.entries(fixture)) {
    if (relativePath.length === 0 || isAbsolute(relativePath)) {
      throw new BenchmarkFailure('harness');
    }
    const targetPath = resolve(workspaceDir, relativePath);
    const safeRelativePath = relative(resolve(workspaceDir), targetPath);
    if (
      safeRelativePath === '' ||
      safeRelativePath === '..' ||
      safeRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(safeRelativePath)
    ) {
      throw new BenchmarkFailure('harness');
    }
    if (
      typeof contents !== 'string' &&
      !Buffer.isBuffer(contents) &&
      !(contents instanceof Uint8Array)
    ) {
      throw new BenchmarkFailure('harness');
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents);
  }
}

function readSessionTokenTotal(session) {
  try {
    const total = session.getSessionStats()?.tokens?.total;
    return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

function createDeadline(startedAt, safetyTimeoutMs) {
  return startedAt + safetyTimeoutMs;
}

async function withDeadline(operation, deadline) {
  const remaining = deadline - nowMilliseconds();
  if (remaining <= 0) {
    throw new BenchmarkTimeoutError();
  }
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BenchmarkTimeoutError()), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function followUpCount(telemetry) {
  const value = telemetry?.sink?.followUpAccepted;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isCompactionProviderFailure(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.startsWith('Summarization failed:') ||
    error.message === 'Summarization attempted to call a tool'
  );
}

function assertRecorderHealthy(recorder) {
  try {
    recorder.assertHealthy();
  } catch {
    throw new BenchmarkFailure('harness');
  }
}

function makeInfrastructureError(runId, pairId, variant, errorKind) {
  return {
    schemaVersion: 1,
    runId,
    pairId,
    variant,
    status: 'infrastructure-error',
    errorKind,
  };
}

function assertBaselineMetrics(metrics) {
  for (const key of SUPERVISOR_ONLY_METRIC_KEYS) {
    if (metrics[key] !== 0) {
      throw new BenchmarkFailure('harness');
    }
  }
}

function sessionPhaseTokenTotal(session, accumulated, measurementState) {
  const total = readSessionTokenTotal(session);
  if (total === undefined) {
    measurementState.available = false;
    return accumulated;
  }
  return accumulated + total;
}

/**
 * Scenario case contract consumed by this runner:
 *
 * {
 *   scenarioClass, scenarioId, caseId,
 *   sentinels: string[],
 *   fixture: { [relativePath: string]: string },
 *   tools: string[],
 *   limits: { maxRuns, maxToolCalls, safetyTimeoutMs },
 *   storage: 'memory' | 'file',
 *   createCustomTools(bench) -> ToolDefinition[],
 *   phases: Array<{ kind: 'prompt', text: string } | { kind: 'compact' } | { kind: 'resume' }>,
 *   evaluate({ workspaceDir, trace }) -> boolean,
 *   requiredVerificationSatisfied(prefix) -> boolean,
 *   classifyIntervention(intervention, prefix) -> 'justified' | 'false',
 *   userInterventions?(trace, derived) -> 0 | 1,
 * }
 *
 * The case is deliberately data-driven. The runner owns the workspace, Pi
 * lifecycle, settlement, limits, and metrics; the case owns only deterministic
 * task content and its oracle.
 */
export async function runBenchmarkVariant({
  scenarioCase,
  variant,
  model,
  thinkingLevel,
  modelRuntime,
  pairId,
  runId,
  waitForFollowUpRuns = true,
}) {
  let isolation;
  let telemetry;
  let recorder;
  let sessionBundle;
  let session;
  let removeActivityListener = () => {};
  let limitAbortPromise;
  let limitAbortError;
  let behavioralLimitExceeded = false;
  let timerStart;
  let timerEnd;
  let deadline;
  let sessionTokenTotal = 0;
  const tokenMeasurement = { available: true };
  const shouldWaitForFollowUps = waitForFollowUpRuns;

  try {
    if (variant !== 'baseline' && variant !== 'supervisor') {
      throw new BenchmarkFailure('harness');
    }
    if (typeof pairId !== 'string' || typeof runId !== 'string') {
      throw new BenchmarkFailure('harness');
    }
    assertScenarioCase(scenarioCase);

    isolation = createIsolation();
    materializeFixture(isolation.workDir, scenarioCase.fixture);
    telemetry = variant === 'supervisor' ? createBenchmarkTelemetry() : undefined;

    let customTools;
    let toolsRecorder;
    customTools = scenarioCase.createCustomTools({
      workspaceDir: isolation.workDir,
      sentinels: [...scenarioCase.sentinels],
      recordVerification(verification) {
        if (toolsRecorder === undefined) {
          throw new BenchmarkFailure('harness');
        }
        return toolsRecorder.recordVerification(verification);
      },
    });
    if (!Array.isArray(customTools)) {
      throw new BenchmarkFailure('harness');
    }

    sessionBundle = await createBenchmarkSession({
      isolation,
      variant,
      model,
      thinkingLevel,
      modelRuntime,
      tools: [...scenarioCase.tools],
      customTools,
      storage: scenarioCase.storage,
      telemetry,
    });
    session = sessionBundle.session;
    recorder = createTraceRecorder({
      session,
      telemetry,
      sentinels: scenarioCase.sentinels,
      extensionLoadErrors: sessionBundle.extensionLoadErrors,
    });
    toolsRecorder = recorder;

    const checkBehavioralLimits = () => {
      if (behavioralLimitExceeded || recorder === undefined) {
        return;
      }
      if (
        recorder.getStartedRunCount() <= scenarioCase.limits.maxRuns &&
        recorder.getToolEventCount() <= scenarioCase.limits.maxToolCalls
      ) {
        return;
      }
      behavioralLimitExceeded = true;
      if (limitAbortPromise === undefined) {
        limitAbortPromise = Promise.resolve()
          .then(() => session?.abort())
          .catch((error) => {
            limitAbortError = error;
          });
      }
    };
    removeActivityListener = recorder.addActivityListener(checkBehavioralLimits);

    const settlePromptPhase = async (runsCompletedBeforePhase, followUpsBeforePhase) => {
      while (true) {
        const currentFollowUps = followUpCount(telemetry);
        const acceptedThisPhase = Math.max(
          0,
          currentFollowUps - followUpsBeforePhase,
        );
        // The sink counter is cumulative across phases; subtracting its phase
        // baseline gives the stated runs-before + root + accepted-follow-ups
        // settlement rule without double-counting earlier phases.
        const expectedRuns =
          runsCompletedBeforePhase + 1 + acceptedThisPhase;
        if (behavioralLimitExceeded) {
          break;
        }
        if (recorder.getObservedAgentEndCount() < expectedRuns) {
          const remaining = deadline - nowMilliseconds();
          if (remaining <= 0) {
            throw new BenchmarkTimeoutError();
          }
          await recorder.waitForActivity(Math.min(50, remaining));
          continue;
        }

        await withDeadline(session.waitForIdle(), deadline);
        // An agent_settled handler can accept another fire-and-forget follow-up
        // after the run's agent_end event. Give that event a bounded opportunity
        // to arrive before accepting the idle state as final.
        const remaining = deadline - nowMilliseconds();
        if (remaining <= 0) {
          throw new BenchmarkTimeoutError();
        }
        await recorder.waitForActivity(Math.min(1, remaining));
        const acceptedAfterQuiet = Math.max(
          0,
          followUpCount(telemetry) - followUpsBeforePhase,
        );
        if (
          recorder.getObservedAgentEndCount() >=
          runsCompletedBeforePhase + 1 + acceptedAfterQuiet
        ) {
          break;
        }
      }
    };

    const resumeSession = async () => {
      if (scenarioCase.storage !== 'file') {
        throw new BenchmarkFailure('harness');
      }
      const previousSessionFile = session?.sessionFile;
      if (typeof previousSessionFile !== 'string') {
        throw new BenchmarkFailure('harness');
      }
      sessionTokenTotal = sessionPhaseTokenTotal(
        session,
        sessionTokenTotal,
        tokenMeasurement,
      );
      sessionBundle.cleanup();
      sessionBundle = undefined;
      session = undefined;

      const resumedSessionManager = SessionManager.open(previousSessionFile);
      if (typeof resumedSessionManager.getBranch !== 'function') {
        throw new BenchmarkFailure('harness');
      }
      const history = resumedSessionManager.getBranch();
      if (!Array.isArray(history) || history.length === 0) {
        throw new BenchmarkFailure('harness');
      }

      sessionBundle = await createBenchmarkSession({
        isolation,
        variant,
        model,
        thinkingLevel,
        modelRuntime,
        tools: [...scenarioCase.tools],
        customTools,
        storage: scenarioCase.storage,
        sessionManager: resumedSessionManager,
        sessionStartEvent: {
          type: 'session_start',
          reason: 'resume',
          previousSessionFile,
        },
        telemetry,
      });
      session = sessionBundle.session;
      recorder.attachSession(session);
      recorder.setExtensionLoadErrors(sessionBundle.extensionLoadErrors);
      assertRecorderHealthy(recorder);
    };

    const runPromptPhase = async (text) => {
      const runsCompletedBeforePhase = recorder.getObservedAgentEndCount();
      const followUpsBeforePhase = followUpCount(telemetry);
      recorder.declarePlannedPhase();
      const promptPromise = Promise.resolve(
        session.prompt(`${text}${COMPLETION_PROTOCOL_MARKER}`),
      );
      if (!shouldWaitForFollowUps) {
        // Negative control only: wait for the planned root run's end event, not
        // for the prompt promise or any accepted follow-up. The production path
        // below must await both the prompt and the event-driven follow-up rule.
        void promptPromise.catch(() => {});
        while (
          recorder.getObservedAgentEndCount() < runsCompletedBeforePhase + 1 &&
          !behavioralLimitExceeded
        ) {
          const remaining = deadline - nowMilliseconds();
          if (remaining <= 0) {
            throw new BenchmarkTimeoutError();
          }
          await recorder.waitForActivity(Math.min(50, remaining));
        }
        if (!behavioralLimitExceeded && recorder.hasProviderFailure()) {
          throw new BenchmarkFailure('provider');
        }
        return;
      }
      await withDeadline(promptPromise, deadline);
      if (!behavioralLimitExceeded && recorder.hasProviderFailure()) {
        throw new BenchmarkFailure('provider');
      }
      await settlePromptPhase(runsCompletedBeforePhase, followUpsBeforePhase);
      assertRecorderHealthy(recorder);
    };

    for (const phase of scenarioCase.phases) {
      if (timerStart === undefined) {
        timerStart = nowMilliseconds();
        deadline = createDeadline(
          timerStart,
          scenarioCase.limits.safetyTimeoutMs,
        );
      }
      if (behavioralLimitExceeded) {
        break;
      }

      if (phase.kind === 'prompt') {
        try {
          await runPromptPhase(phase.text);
        } catch (error) {
          if (error instanceof BenchmarkTimeoutError) {
            throw error;
          }
          if (behavioralLimitExceeded) {
            await withDeadline(session.waitForIdle(), deadline);
            break;
          }
          if (error instanceof BenchmarkFailure) {
            throw error;
          }
          throw new BenchmarkFailure('provider');
        }
      } else if (phase.kind === 'compact') {
        const beforeCompaction = recorder.getCompactionProof();
        try {
          await withDeadline(session.compact(), deadline);
          await withDeadline(session.waitForIdle(), deadline);
        } catch (error) {
          if (error instanceof BenchmarkTimeoutError) {
            throw error;
          }
          throw new BenchmarkFailure(
            isCompactionProviderFailure(error) ? 'provider' : 'oracle',
          );
        }
        assertRecorderHealthy(recorder);
        const afterCompaction = recorder.getCompactionProof();
        if (
          afterCompaction.entries.length <= beforeCompaction.entries.length ||
          afterCompaction.events.length <= beforeCompaction.events.length ||
          !recorder.hasRealCompaction()
        ) {
          throw new BenchmarkFailure('oracle');
        }
      } else {
        await resumeSession();
      }

      if (!behavioralLimitExceeded && recorder.hasProviderFailure()) {
        throw new BenchmarkFailure('provider');
      }
      assertRecorderHealthy(recorder);
      if (behavioralLimitExceeded && limitAbortPromise !== undefined) {
        await withDeadline(limitAbortPromise, deadline);
        if (limitAbortError !== undefined) {
          throw new BenchmarkFailure('harness');
        }
        await withDeadline(session.waitForIdle(), deadline);
        break;
      }
    }

    if (timerStart === undefined) {
      throw new BenchmarkFailure('harness');
    }
    if (behavioralLimitExceeded) {
      if (limitAbortPromise !== undefined) {
        await withDeadline(limitAbortPromise, deadline);
      }
      if (limitAbortError !== undefined) {
        throw new BenchmarkFailure('harness');
      }
      await withDeadline(session.waitForIdle(), deadline);
    } else if (shouldWaitForFollowUps) {
      await withDeadline(session.waitForIdle(), deadline);
    }
    assertRecorderHealthy(recorder);
    if (!behavioralLimitExceeded && recorder.hasProviderFailure()) {
      throw new BenchmarkFailure('provider');
    }

    timerEnd = nowMilliseconds();
    const wallClockMs = timerEnd - timerStart;
    sessionTokenTotal = sessionPhaseTokenTotal(
      session,
      sessionTokenTotal,
      tokenMeasurement,
    );
    const measuredSessionTokens = tokenMeasurement.available
      ? sessionTokenTotal
      : undefined;
    const preliminaryTrace = recorder.getTrace({
      sessionTokenTotal: measuredSessionTokens,
      wallClockMs,
      oracle: { taskSuccess: false },
    });

    let taskSuccess;
    try {
      const oracleTrace = createOracleTraceView(preliminaryTrace);
      taskSuccess = await withDeadline(
        Promise.resolve(
          scenarioCase.evaluate({
            workspaceDir: isolation.workDir,
            trace: oracleTrace,
          }),
        ),
        deadline,
      );
    } catch (error) {
      if (error instanceof BenchmarkTimeoutError) {
        throw error;
      }
      throw new BenchmarkFailure('oracle');
    }
    if (typeof taskSuccess !== 'boolean') {
      throw new BenchmarkFailure('oracle');
    }

    const trace = recorder.getTrace({
      sessionTokenTotal: measuredSessionTokens,
      wallClockMs,
      oracle: { taskSuccess },
    });
    let metrics;
    try {
      metrics = computeSupervisorBenchmarkRunMetrics(trace, {
        sentinels: scenarioCase.sentinels,
        requiredVerificationSatisfied:
          scenarioCase.requiredVerificationSatisfied,
        classifyIntervention: scenarioCase.classifyIntervention,
        ...(scenarioCase.userInterventions === undefined
          ? {}
          : { userInterventions: scenarioCase.userInterventions }),
      });
    } catch {
      throw new BenchmarkFailure('oracle');
    }
    if (variant === 'baseline') {
      assertBaselineMetrics(metrics);
    }

    return {
      schemaVersion: 1,
      runId,
      pairId,
      variant,
      status: 'completed',
      oracle: { kind: 'deterministic', taskSuccess },
      metrics,
    };
  } catch (error) {
    const errorKind =
      error instanceof BenchmarkTimeoutError
        ? 'timeout'
        : error instanceof BenchmarkFailure
          ? error.kind
          : 'harness';
    return makeInfrastructureError(runId, pairId, variant, errorKind);
  } finally {
    removeActivityListener();
    recorder?.dispose();
    sessionBundle?.cleanup();
    clearActiveBenchmarkTelemetry();
    isolation?.cleanup();
  }
}

export { COMPLETION_PROTOCOL_MARKER, createOracleTraceView };
