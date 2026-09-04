const COMPLETION_CLAIM = 'Task complete.';

function hasRepeatedExecutedFailure(prefix) {
  const failures = new Map();
  const toolEvents = Array.isArray(prefix?.toolEvents) ? prefix.toolEvents : [];

  for (const event of toolEvents) {
    if (
      event?.blockedBySupervisor !== false ||
      event?.isError !== true ||
      typeof event.toolName !== 'string' ||
      typeof event.inputDigest !== 'string' ||
      typeof event.resultDigest !== 'string'
    ) {
      continue;
    }

    const identity = JSON.stringify([
      event.toolName,
      event.inputDigest,
      event.resultDigest,
    ]);
    const count = (failures.get(identity) ?? 0) + 1;
    failures.set(identity, count);
    if (count >= 2) {
      return true;
    }
  }

  return false;
}

function hasUnverifiedCompletionClaim(prefix, requiredVerificationSatisfied) {
  const runs = Array.isArray(prefix?.runs) ? prefix.runs : [];
  const precedingRun = runs.at(-1);
  if (
    typeof precedingRun?.finalAssistantText !== 'string' ||
    !precedingRun.finalAssistantText.includes(COMPLETION_CLAIM) ||
    typeof requiredVerificationSatisfied !== 'function'
  ) {
    return false;
  }

  try {
    return !requiredVerificationSatisfied(prefix);
  } catch {
    return false;
  }
}

export function classifyScenarioIntervention(
  intervention,
  prefix,
  requiredVerificationSatisfied,
) {
  if (intervention?.kind === 'steer' || intervention?.kind === 'block') {
    return hasRepeatedExecutedFailure(prefix) ? 'justified' : 'false';
  }
  if (intervention?.kind === 'follow-up') {
    return hasUnverifiedCompletionClaim(prefix, requiredVerificationSatisfied)
      ? 'justified'
      : 'false';
  }
  return 'false';
}
