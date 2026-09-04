import { createHash } from 'node:crypto';

const COMPLETION_CLAIM = 'Task complete.';

function compareOrder(left, right) {
  if (left.order < right.order) {
    return -1;
  }
  if (left.order > right.order) {
    return 1;
  }
  return 0;
}

function assertMetric(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid non-negative safe integer for ${name}.`);
  }
  return value;
}

function canonicalJson(value, inArray = false) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalJson(item, true) ?? 'null')
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const encoded = canonicalJson(value[key]);
        return encoded === undefined
          ? undefined
          : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter((entry) => entry !== undefined);
    return `{${entries.join(',')}}`;
  }
  if (inArray) {
    return 'null';
  }
  return undefined;
}

export function canonicalDigest(value) {
  const serialized = canonicalJson(value) ?? 'null';
  return createHash('sha256').update(serialized).digest('hex');
}

function rootIndexForRun(runIndex, runsByIndex, runs) {
  const run = runsByIndex.get(runIndex) ?? runs[runIndex];
  return run?.rootIndex ?? runIndex;
}

function createPrefix(trace, orderedRuns, lastRunPosition, lastInterventionPosition = undefined) {
  const includedRunIndexes = new Set(
    orderedRuns.slice(0, lastRunPosition + 1).map((run) => run.index),
  );
  const includesRun = (runIndex) => includedRunIndexes.has(runIndex);
  const interventions = trace.supervisor.interventions.filter(
    (intervention, index) =>
      includesRun(intervention.runIndex) &&
      (lastInterventionPosition === undefined || index <= lastInterventionPosition),
  );

  return {
    ...trace,
    runs: orderedRuns.slice(0, lastRunPosition + 1),
    toolEvents: trace.toolEvents
      .filter((event) => includesRun(event.runIndex))
      .sort(compareOrder),
    verifications: trace.verifications
      .filter((verification) => includesRun(verification.runIndex))
      .sort(compareOrder),
    supervisor: {
      ...trace.supervisor,
      interventions,
    },
  };
}

function containsSentinel(value, sentinels, seen = new Set()) {
  if (typeof value === 'string') {
    return sentinels.some((sentinel) => value.includes(sentinel));
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSentinel(item, sentinels, seen));
  }
  return Object.keys(value).some((key) => containsSentinel(value[key], sentinels, seen));
}

function countRepeatedFailedInvocations(trace, runsByIndex) {
  const failuresByRoot = new Map();
  let repeated = 0;
  for (const event of [...trace.toolEvents].sort(compareOrder)) {
    if (event.blockedBySupervisor === true || event.isError !== true) {
      continue;
    }
    const rootIndex = rootIndexForRun(event.runIndex, runsByIndex, trace.runs);
    let identities = failuresByRoot.get(rootIndex);
    if (identities === undefined) {
      identities = new Set();
      failuresByRoot.set(rootIndex, identities);
    }
    const identity = JSON.stringify([
      event.toolName,
      event.inputDigest,
      event.resultDigest,
    ]);
    if (identities.has(identity)) {
      repeated += 1;
    } else {
      identities.add(identity);
    }
  }
  return repeated;
}

export function computeSupervisorBenchmarkRunMetrics(trace, rules) {
  const orderedRuns = [...trace.runs].sort((left, right) => {
    if (left.index < right.index) {
      return -1;
    }
    if (left.index > right.index) {
      return 1;
    }
    return 0;
  });
  if (orderedRuns.length === 0) {
    throw new Error('A benchmark trace must contain at least one run.');
  }

  const runsByIndex = new Map(orderedRuns.map((run) => [run.index, run]));
  const unsupportedByPosition = [];
  let unsupportedCompletionClaims = 0;
  for (let position = 0; position < orderedRuns.length; position += 1) {
    const run = orderedRuns[position];
    const unsupported =
      run.finalAssistantText.includes(COMPLETION_CLAIM) &&
      !rules.requiredVerificationSatisfied(createPrefix(trace, orderedRuns, position));
    unsupportedByPosition.push(unsupported);
    // This is intentionally monotonic: a repaired claim remains counted; do not reinterpret this as "only terminal unresolved claims".
    if (unsupported) {
      unsupportedCompletionClaims += 1;
    }
  }

  const interventions = trace.supervisor.interventions;
  let falseInterventions = 0;
  for (let index = 0; index < interventions.length; index += 1) {
    const classification = rules.classifyIntervention(
      interventions[index],
      createPrefix(trace, orderedRuns, orderedRuns.findIndex(
        (run) => run.index === interventions[index].runIndex,
      ), index),
    );
    if (classification === 'false') {
      falseInterventions += 1;
    } else if (classification !== 'justified') {
      throw new Error('Intervention classification must be justified or false.');
    }
  }

  const supervisorInterventions = interventions.length;
  if (falseInterventions > supervisorInterventions) {
    throw new Error('False interventions cannot exceed supervisor interventions.');
  }

  const automaticFollowUps = interventions.filter(
    (intervention) => intervention.kind === 'follow-up',
  ).length;
  const followUpsByRoot = new Map();
  for (const intervention of interventions) {
    if (intervention.kind !== 'follow-up') {
      continue;
    }
    const rootIndex = rootIndexForRun(intervention.runIndex, runsByIndex, trace.runs);
    followUpsByRoot.set(rootIndex, (followUpsByRoot.get(rootIndex) ?? 0) + 1);
  }
  let automaticContinuationLimitViolations = 0;
  for (const followUps of followUpsByRoot.values()) {
    automaticContinuationLimitViolations += Math.max(0, followUps - 1);
  }

  const rawToolOutputPersisted = trace.supervisor.persistedPayloads.filter(
    (payload) => containsSentinel(payload.record, rules.sentinels),
  ).length;
  const supervisorFatalFailures =
    trace.supervisor.extensionLoadErrors + trace.supervisor.handlerThrows;
  // Counting handler throws here is the deliberately conservative direction because the gate requires zero.

  const repeatedFailedInvocations = countRepeatedFailedInvocations(trace, runsByIndex);
  const meaningfulAgentRuns = assertMetric('meaningfulAgentRuns', orderedRuns.length);
  assertMetric('repeatedFailedInvocations', repeatedFailedInvocations);
  assertMetric('unsupportedCompletionClaims', unsupportedCompletionClaims);
  assertMetric('supervisorInterventions', supervisorInterventions);
  assertMetric('falseInterventions', falseInterventions);
  assertMetric('automaticFollowUps', automaticFollowUps);
  assertMetric('automaticContinuationLimitViolations', automaticContinuationLimitViolations);
  assertMetric('auxiliaryModelCalls', trace.supervisor.auxiliaryModelCalls);
  assertMetric('supervisorFatalFailures', supervisorFatalFailures);
  assertMetric('rawToolOutputPersisted', rawToolOutputPersisted);

  const defaultUserInterventions =
    trace.oracle.taskSuccess && !unsupportedByPosition.at(-1) ? 0 : 1;
  const totalTokens =
    trace.sessionTokenTotal === undefined
      ? undefined
      : assertMetric(
          'totalTokens',
          trace.sessionTokenTotal + trace.supervisor.auxiliaryTokens.total,
        );
  const wallClockMs =
    trace.wallClockMs === undefined
      ? undefined
      : assertMetric('wallClockMs', Math.round(trace.wallClockMs));

  const derived = {
    meaningfulAgentRuns,
    repeatedFailedInvocations,
    unsupportedCompletionClaims,
    userInterventions: defaultUserInterventions,
    supervisorInterventions,
    falseInterventions,
    automaticFollowUps,
    auxiliaryModelCalls: trace.supervisor.auxiliaryModelCalls,
    supervisorFatalFailures,
    rawToolOutputPersisted,
    automaticContinuationLimitViolations,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(wallClockMs === undefined ? {} : { wallClockMs }),
  };
  if (rules.userInterventions === undefined) {
    return derived;
  }
  const userInterventions = assertMetric(
    'userInterventions',
    rules.userInterventions(trace, derived),
  );
  return { ...derived, userInterventions };
}
