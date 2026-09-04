/* global setTimeout, clearTimeout */

import { canonicalDigest } from './metrics.mjs';

function assertSentinels(sentinels) {
  if (
    !Array.isArray(sentinels) ||
    !sentinels.every((sentinel) => typeof sentinel === 'string')
  ) {
    throw new TypeError('Benchmark sentinels must be an array of strings.');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object';
}

function hasOwn(value, key) {
  return isRecord(value) && Object.hasOwn(value, key);
}

function textFromContent(content) {
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

function assistantText(message) {
  return isRecord(message) ? textFromContent(message.content) : '';
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      return assistantText(messages[index]);
    }
  }
  return undefined;
}

function resultContent(result) {
  if (isRecord(result) && hasOwn(result, 'content')) {
    return result.content;
  }
  return result;
}

function eventInput(event) {
  if (hasOwn(event, 'input')) {
    return event.input;
  }
  if (hasOwn(event, 'args')) {
    return event.args;
  }
  if (isRecord(event.toolCall) && hasOwn(event.toolCall, 'arguments')) {
    return event.toolCall.arguments;
  }
  return undefined;
}

function eventResult(event) {
  if (hasOwn(event, 'result')) {
    return event.result;
  }
  if (hasOwn(event, 'message')) {
    return event.message;
  }
  if (hasOwn(event, 'content')) {
    return { content: event.content };
  }
  return undefined;
}

function eventIsError(event, result) {
  if (typeof event?.isError === 'boolean') {
    return event.isError;
  }
  if (typeof result?.isError === 'boolean') {
    return result.isError;
  }
  return false;
}

function isAssistantError(message) {
  return message?.role === 'assistant' && message.stopReason === 'error';
}

function zeroSupervisorProjection(extensionLoadErrors = 0) {
  return {
    interventions: [],
    auxiliaryModelCalls: 0,
    auxiliaryTokens: { input: 0, output: 0, total: 0 },
    persistedPayloads: [],
    handlerThrows: 0,
    extensionLoadErrors,
  };
}

/**
 * Observe one or more AgentSession instances and reduce their events to the
 * privacy-bounded S0-B trace consumed by metrics.mjs.
 *
 * `declarePlannedPhase()` must be called immediately before every planned
 * prompt phase. Agent starts without a pending declaration are therefore
 * attributable only when the Supervisor has accepted a follow-up. This keeps
 * root attribution explicit instead of guessing from event timing.
 */
export function createTraceRecorder({
  session,
  telemetry,
  sentinels,
  extensionLoadErrors = 0,
}) {
  if (session === undefined || session === null || typeof session.subscribe !== 'function') {
    throw new TypeError('Benchmark trace recording requires a subscribable session.');
  }
  assertSentinels(sentinels);
  if (
    !Number.isSafeInteger(extensionLoadErrors) ||
    extensionLoadErrors < 0
  ) {
    throw new TypeError('Benchmark extensionLoadErrors must be a non-negative safe integer.');
  }
  if (telemetry !== undefined && telemetry?.sink === undefined) {
    throw new TypeError('Benchmark telemetry must contain a sink.');
  }

  const configuredSentinels = [...sentinels];
  const runs = [];
  const toolEvents = [];
  const verifications = [];
  const compactionEvents = [];
  const compactionEntries = [];
  const pendingTools = new Map();
  const activityListeners = new Set();
  const waiters = new Set();
  const plannedPhaseIndexes = [];
  const projectedInterventions = [];

  let order = 0;
  let plannedPhaseCount = 0;
  let nextRunIndex = 0;
  let currentRun;
  let lastRun;
  let observedAgentEndCount = 0;
  let observedAgentStartCount = 0;
  let followUpRunsAssigned = 0;
  let providerFailure = false;
  let recorderError;
  let unsubscribeSession = () => {};
  let observedSession = session;
  let configuredExtensionLoadErrors = extensionLoadErrors;
  let seenInterventions = 0;

  function notifyActivity() {
    for (const listener of activityListeners) {
      listener();
    }
    for (const resolveWaiter of waiters) {
      resolveWaiter();
    }
    waiters.clear();
  }

  function runIndexForTelemetry() {
    return currentRun?.index ?? lastRun?.index ?? 0;
  }

  function refreshTelemetryProjection() {
    if (telemetry === undefined) {
      return;
    }
    const rawInterventions = telemetry.sink.interventions;
    if (!Array.isArray(rawInterventions)) {
      recorderError ??= new Error('Benchmark telemetry interventions are malformed.');
      return;
    }
    while (seenInterventions < rawInterventions.length) {
      const intervention = rawInterventions[seenInterventions];
      seenInterventions += 1;
      if (!isRecord(intervention)) {
        recorderError ??= new Error('Benchmark telemetry intervention is malformed.');
        continue;
      }
      projectedInterventions.push({
        runIndex:
          Number.isSafeInteger(intervention.runIndex) && intervention.runIndex >= 0
            ? intervention.runIndex
            : runIndexForTelemetry(),
        kind: intervention.kind,
        phase: intervention.phase,
      });
    }
  }

  function beginRun() {
    refreshTelemetryProjection();
    const plannedRootIndex = plannedPhaseIndexes.shift();
    let rootIndex;
    let cause;
    if (plannedRootIndex !== undefined) {
      rootIndex = plannedRootIndex;
      cause = 'planned-phase';
    } else {
      const acceptedFollowUps = telemetry?.sink?.followUpAccepted ?? 0;
      if (
        lastRun === undefined ||
        !Number.isSafeInteger(acceptedFollowUps) ||
        acceptedFollowUps <= followUpRunsAssigned
      ) {
        throw new Error('Benchmark observed an unplanned agent run without a Supervisor follow-up.');
      }
      followUpRunsAssigned += 1;
      rootIndex = lastRun.rootIndex;
      cause = 'supervisor-follow-up';
    }

    const run = {
      index: nextRunIndex,
      rootIndex,
      cause,
      finalAssistantText: '',
    };
    nextRunIndex += 1;
    observedAgentStartCount += 1;
    runs.push(run);
    currentRun = run;
    lastRun = run;
  }

  function finishRun(event) {
    if (currentRun === undefined) {
      throw new Error('Benchmark observed agent_end without agent_start.');
    }
    const finalText = lastAssistantText(event.messages);
    currentRun.finalAssistantText =
      finalText === undefined ? currentRun.lastAssistantText ?? '' : finalText;
    if (Array.isArray(event.messages) && event.messages.some(isAssistantError)) {
      providerFailure = true;
    }
    delete currentRun.lastAssistantText;
    observedAgentEndCount += 1;
    currentRun = undefined;
    refreshTelemetryProjection();
  }

  function startTool(event) {
    const toolCallId = event?.toolCallId;
    const toolName = event?.toolName;
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string') {
      throw new Error('Benchmark observed a malformed tool call event.');
    }
    if (currentRun === undefined) {
      throw new Error('Benchmark observed a tool call outside an agent run.');
    }

    const toolEvent = {
      order: order + 1,
      runIndex: currentRun.index,
      toolCallId,
      toolName,
      inputDigest: canonicalDigest(eventInput(event)),
      resultDigest: canonicalDigest(undefined),
      isError: false,
      mutation: toolName === 'write' || toolName === 'edit',
      blockedBySupervisor: false,
    };
    order += 1;
    toolEvents.push(toolEvent);
    const pending = pendingTools.get(toolCallId) ?? [];
    pending.push(toolEvent);
    pendingTools.set(toolCallId, pending);
  }

  function finishTool(event) {
    const toolCallId = event?.toolCallId;
    if (typeof toolCallId !== 'string') {
      throw new Error('Benchmark observed a malformed tool result event.');
    }
    const pending = pendingTools.get(toolCallId);
    const result = eventResult(event);
    let toolEvent = pending?.shift();
    if (pending !== undefined && pending.length === 0) {
      pendingTools.delete(toolCallId);
    }
    if (toolEvent === undefined) {
      if (currentRun === undefined) {
        throw new Error('Benchmark observed a tool result without an agent run.');
      }
      toolEvent = {
        order: order + 1,
        runIndex: currentRun.index,
        toolCallId,
        toolName: event?.toolName,
        inputDigest: canonicalDigest(undefined),
        resultDigest: canonicalDigest(resultContent(result)),
        isError: eventIsError(event, result),
        mutation: event?.toolName === 'write' || event?.toolName === 'edit',
        blockedBySupervisor: false,
      };
      order += 1;
      toolEvents.push(toolEvent);
    } else {
      toolEvent.resultDigest = canonicalDigest(resultContent(result));
      toolEvent.isError = eventIsError(event, result);
    }

    const blockedToolCallIds = telemetry?.sink?.blockedToolCallIds;
    toolEvent.blockedBySupervisor =
      Array.isArray(blockedToolCallIds) && blockedToolCallIds.includes(toolCallId);
    refreshTelemetryProjection();
  }

  function handleEvent(event) {
    try {
      switch (event?.type) {
        case 'agent_start':
          beginRun();
          break;
        case 'agent_end':
          finishRun(event);
          break;
        case 'message_start':
        case 'message_update':
        case 'message_end':
          if (event.message?.role === 'assistant') {
            if (currentRun !== undefined) {
              currentRun.lastAssistantText = assistantText(event.message);
            }
            if (isAssistantError(event.message)) {
              providerFailure = true;
            }
          }
          break;
        case 'tool_call':
        case 'tool_execution_start':
          startTool(event);
          break;
        case 'tool_result':
        case 'tool_execution_end':
          finishTool(event);
          break;
        case 'compaction_start':
        case 'compaction_end':
          compactionEvents.push({
            type: event.type,
            reason: event.reason,
            ...(event.type === 'compaction_end'
              ? { aborted: event.aborted === true }
              : {}),
          });
          break;
        case 'entry_appended':
          if (event.entry?.type === 'compaction') {
            compactionEntries.push({ type: 'compaction' });
          }
          break;
        default:
          break;
      }
      refreshTelemetryProjection();
    } catch (error) {
      recorderError ??= error instanceof Error ? error : new Error('Benchmark trace recorder failed.');
    }
    notifyActivity();
  }

  function subscribeToSession(nextSession) {
    if (
      nextSession === undefined ||
      nextSession === null ||
      typeof nextSession.subscribe !== 'function'
    ) {
      throw new TypeError('Benchmark trace recording requires a subscribable session.');
    }
    unsubscribeSession();
    unsubscribeSession = nextSession.subscribe(handleEvent);
    observedSession = nextSession;
  }

  subscribeToSession(session);

  function declarePlannedPhase() {
    const rootIndex = plannedPhaseCount;
    plannedPhaseCount += 1;
    plannedPhaseIndexes.push(rootIndex);
    notifyActivity();
    return rootIndex;
  }

  function recordVerification({ name, passed }) {
    if (currentRun === undefined) {
      throw new Error('Benchmark verification was recorded outside an agent run.');
    }
    if (typeof name !== 'string' || typeof passed !== 'boolean') {
      throw new TypeError('Benchmark verification requires a string name and boolean passed value.');
    }
    const verification = {
      order: order + 1,
      runIndex: currentRun.index,
      name,
      passed,
    };
    order += 1;
    verifications.push(verification);
    notifyActivity();
    return verification;
  }

  function waitForActivity(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('Benchmark trace activity timeout must be non-negative.');
    }
    return new Promise((resolvePromise) => {
      let finished = false;
      let timer;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        waiters.delete(finish);
        resolvePromise();
      };
      waiters.add(finish);
      timer = setTimeout(finish, timeoutMs);
    });
  }

  function addActivityListener(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Benchmark trace activity listener must be a function.');
    }
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  }

  function setExtensionLoadErrors(count) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Benchmark extensionLoadErrors must be a non-negative safe integer.');
    }
    configuredExtensionLoadErrors = count;
    notifyActivity();
  }

  function observePersistedCompactionEntries() {
    const manager = observedSession?.sessionManager;
    if (typeof manager?.getBranch !== 'function') {
      return;
    }
    let entries;
    try {
      entries = manager.getBranch();
    } catch {
      recorderError ??= new Error('Benchmark could not inspect session compaction entries.');
      return;
    }
    if (!Array.isArray(entries)) {
      recorderError ??= new Error('Benchmark session compaction entries are malformed.');
      return;
    }
    const compactionCount = entries.filter((entry) => entry?.type === 'compaction').length;
    while (compactionEntries.length < compactionCount) {
      compactionEntries.push({ type: 'compaction' });
    }
  }

  function hasRealCompaction() {
    observePersistedCompactionEntries();
    return (
      compactionEntries.length > 0 &&
      compactionEvents.some(
        (event) => event.type === 'compaction_end' && event.aborted !== true,
      )
    );
  }

  function compactionProof() {
    observePersistedCompactionEntries();
    return {
      sentinels: [...configuredSentinels],
      entries: compactionEntries.slice(),
      events: compactionEvents.slice(),
    };
  }

  function supervisorProjection() {
    if (telemetry === undefined) {
      return zeroSupervisorProjection();
    }
    refreshTelemetryProjection();
    const sink = telemetry.sink;
    return {
      interventions: projectedInterventions.slice(),
      auxiliaryModelCalls: sink.auxiliaryModelCalls,
      auxiliaryTokens: { ...sink.auxiliaryTokens },
      persistedPayloads: sink.persistedPayloads.slice(),
      handlerThrows: sink.handlerThrows,
      extensionLoadErrors: configuredExtensionLoadErrors,
    };
  }

  function getTrace({ sessionTokenTotal, wallClockMs, oracle } = {}) {
    observePersistedCompactionEntries();
    refreshTelemetryProjection();
    return {
      runs: runs.slice().map((run) => ({
        index: run.index,
        rootIndex: run.rootIndex,
        cause: run.cause,
        finalAssistantText: run.finalAssistantText,
      })),
      toolEvents: toolEvents.slice().map((event) => ({ ...event })),
      verifications: verifications.slice().map((verification) => ({ ...verification })),
      // Real Pi compaction evidence, so a scenario oracle can require an actual
      // compaction rather than trusting a synthetic flag. `real` is true only when a
      // persisted compaction entry and a non-aborted compaction_end event both exist.
      compaction: {
        real: hasRealCompaction(),
        entryCount: compactionEntries.length,
        endEvents: compactionEvents.filter(
          (event) => event.type === 'compaction_end' && event.aborted !== true,
        ).length,
      },
      supervisor: supervisorProjection(),
      sessionTokenTotal,
      wallClockMs,
      oracle: oracle ?? { taskSuccess: false },
    };
  }

  return {
    declarePlannedPhase,
    recordVerification,
    attachSession: subscribeToSession,
    addActivityListener,
    waitForActivity,
    setExtensionLoadErrors,
    hasRealCompaction,
    getCompactionProof: compactionProof,
    getTrace,
    getProviderFailure: () => providerFailure,
    hasProviderFailure: () => providerFailure,
    getRecorderError: () => recorderError,
    assertHealthy() {
      if (recorderError !== undefined) {
        throw recorderError;
      }
    },
    getRunCount: () => runs.length,
    getStartedRunCount: () => observedAgentStartCount,
    getObservedAgentEndCount: () => observedAgentEndCount,
    getToolEventCount: () => toolEvents.length,
    getVerificationCount: () => verifications.length,
    get trace() {
      return getTrace();
    },
    dispose() {
      unsubscribeSession();
      activityListeners.clear();
      for (const resolveWaiter of waiters) {
        resolveWaiter();
      }
      waiters.clear();
    },
  };
}
