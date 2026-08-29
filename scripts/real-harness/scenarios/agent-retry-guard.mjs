import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  AGENT_RETRY_GUARD_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const STATE_CUSTOM_TYPE = 'agent-retry-state';
const POLICY_LIMIT = 2;

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

function latestStateEnvelope(sessionManager) {
  return stateEntriesFor(sessionManager, STATE_CUSTOM_TYPE).at(-1)?.data;
}

function parseRetryVerdict(message) {
  if (message === undefined || message.isError !== false) {
    return undefined;
  }
  const text = messageText(message);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return { ...JSON.parse(text.slice(start, end + 1)), text };
  } catch {
    return undefined;
  }
}

export const name = 'agent-retry-guard-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [AGENT_RETRY_GUARD_EXTENSION_PATH],
      expectedExtensionPath: AGENT_RETRY_GUARD_EXTENSION_PATH,
    });
    registerCleanup(() => harness.session.dispose());
    check(
      harness.extensionsResult.extensions.length === 1 &&
        harness.extensionsResult.extensions[0]?.resolvedPath ===
          AGENT_RETRY_GUARD_EXTENSION_PATH,
      'loader contract passed for the agent-retry-guard adapter',
    );
    check(
      harness.session.sessionFile === undefined,
      'agent-retry-guard session is in-memory',
    );

    const policyEvents = await runScriptedTurn(
      harness,
      'Set the retry policy for this episode.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_retry_set_policy', {
            maxAttempts: POLICY_LIMIT,
          }),
        ),
        fauxAssistantMessage(fauxText('The retry policy was set.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      policyEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_retry_set_policy',
      ),
      'S1 captured the real agent_retry_set_policy tool event',
    );
    const policyEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      policyEnvelope?.schemaVersion === 1 &&
        Array.isArray(policyEnvelope.attempts) &&
        policyEnvelope.attempts.length === 0 &&
        policyEnvelope.policy?.maxAttempts === POLICY_LIMIT,
      'S1 policy persistence did not record an automatic attempt',
    );

    await runScriptedTurn(
      harness,
      'Record the first failed retry attempt.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_retry_add_attempt', {
            outcome: 'failure',
          }),
        ),
        fauxAssistantMessage(fauxText('The first failed attempt was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const firstAttemptEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      firstAttemptEnvelope?.attempts?.length === 1 &&
        firstAttemptEnvelope.attempts[0]?.outcome === 'failure' &&
        firstAttemptEnvelope.policy?.maxAttempts === POLICY_LIMIT,
      'S1 persisted the first manual retry attempt',
    );

    await runScriptedTurn(
      harness,
      'Judge whether another retry is allowed.',
      [
        fauxAssistantMessage(fauxToolCall('agent_retry_judge', {})),
        fauxAssistantMessage(fauxText('The first retry judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const firstJudge = parseRetryVerdict(
      latestToolResult(harness.session, 'agent_retry_judge'),
    );
    check(
      firstJudge?.attempts === 1 &&
        firstJudge.consecutiveFailures === 1 &&
        firstJudge.retryAllowed === true,
      'S1 surfaced an in-policy retry verdict through the real tool result',
    );

    await runScriptedTurn(
      harness,
      'Record the second failed retry attempt.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_retry_add_attempt', {
            outcome: 'failure',
          }),
        ),
        fauxAssistantMessage(fauxText('The second failed attempt was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const secondAttemptEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      secondAttemptEnvelope?.attempts?.length === 2 &&
        secondAttemptEnvelope.attempts[1]?.outcome === 'failure',
      'S1 persisted the second manual retry attempt',
    );

    await runScriptedTurn(
      harness,
      'Judge the retry policy limit.',
      [
        fauxAssistantMessage(fauxToolCall('agent_retry_judge', {})),
        fauxAssistantMessage(fauxText('The policy-limit judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const blockedJudge = parseRetryVerdict(
      latestToolResult(harness.session, 'agent_retry_judge'),
    );
    check(
      blockedJudge?.attempts === POLICY_LIMIT &&
        blockedJudge.consecutiveFailures === POLICY_LIMIT &&
        blockedJudge.retryAllowed === false,
      'S1 surfaced the blocked retry verdict at the policy limit',
    );

    const episodeEvents = await runScriptedTurn(
      harness,
      'Start a fresh retry episode.',
      [
        fauxAssistantMessage(fauxToolCall('agent_retry_start_episode', {})),
        fauxAssistantMessage(fauxText('The new retry episode was started.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      episodeEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_retry_start_episode',
      ),
      'S1 captured the real agent_retry_start_episode tool event',
    );
    const resetEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      resetEnvelope?.schemaVersion === 1 &&
        resetEnvelope.attempts?.length === 0 &&
        resetEnvelope.policy?.maxAttempts === POLICY_LIMIT,
      'S1 persisted the reset episode while preserving policy',
    );

    await runScriptedTurn(
      harness,
      'Judge the fresh retry episode.',
      [
        fauxAssistantMessage(fauxToolCall('agent_retry_judge', {})),
        fauxAssistantMessage(fauxText('The fresh-episode judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const resetJudge = parseRetryVerdict(
      latestToolResult(harness.session, 'agent_retry_judge'),
    );
    check(
      resetJudge?.attempts === 0 && resetJudge.retryAllowed === true,
      'S1 surfaced an allowed verdict after the episode reset',
    );

    harness.assertInMemorySession();
    harness.assertNoAuthCredentials();
    harness.assertFauxNetworkIdentity();
    return result.status === 'pass'
      ? { status: 'pass', reason: 'agent-retry-guard wiring verified' }
      : { status: 'fail', reason: 'agent-retry-guard assertions failed' };
  } finally {
    await cleanupAll();
  }
}
