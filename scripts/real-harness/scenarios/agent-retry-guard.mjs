/* global setImmediate */
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { SessionManager } from '@earendil-works/pi-coding-agent';
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

function createRetryProbeTool(invocations, name, mode) {
  return {
    name,
    label: 'Retry Auto Record Probe',
    description: 'Deterministic real-harness retry auto-record probe tool.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      invocations.push(name);
      if (mode.fail) {
        throw new Error('intentional retry auto-record probe failure');
      }
      return { content: [{ type: 'text', text: 'retry-probe-ok' }] };
    },
  };
}

async function runRetryCommand(harness, command) {
  await harness.session.prompt(`/agent-retry ${command}`);
  await new Promise((resolveTick) => setImmediate(resolveTick));
  harness.assertNoPendingFauxResponses();
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

async function runFileBackedAutoRecord({ isolation, registerCleanup, check }) {
  const invocations = [];
  const mode = { fail: true };
  const sessionA = await createIsolatedSession({
    isolation,
    storage: 'file',
    additionalExtensionPaths: [AGENT_RETRY_GUARD_EXTENSION_PATH],
    expectedExtensionPath: AGENT_RETRY_GUARD_EXTENSION_PATH,
    customTools: [createRetryProbeTool(invocations, 'retry_file_probe', mode)],
  });
  let sessionADisposed = false;
  const disposeSessionA = () => {
    if (!sessionADisposed) {
      sessionA.session.dispose();
      sessionADisposed = true;
    }
  };
  registerCleanup(disposeSessionA);

  check(sessionA.assertSessionStorage(), 'R4 Session A is file-backed');
  await runRetryCommand(sessionA, 'auto-record on');
  const enabledMarker = stateEntriesFor(
    sessionA.sessionManager,
    'agent-retry-auto-record',
  ).at(-1)?.data;
  check(
    enabledMarker?.schemaVersion === 1 && enabledMarker.enabled === true,
    'R4 Session A persisted the enabled auto-record marker',
  );

  await runScriptedTurn(
    sessionA,
    'Run the failing file-backed retry probe.',
    [
      fauxAssistantMessage(fauxToolCall('retry_file_probe', {})),
      fauxAssistantMessage(fauxText('The file-backed probe failed.')),
    ],
  );
  sessionA.assertNoPendingFauxResponses();
  const sessionFile = sessionA.sessionFile;
  const sessionAEnvelope = latestStateEnvelope(sessionA.sessionManager);
  const sessionAToolResult = latestToolResult(sessionA.session, 'retry_file_probe');
  check(
    invocations.length === 1 && sessionAToolResult?.isError === true,
    'R4 Session A executed the failing custom tool exactly once',
  );
  check(
    sessionAEnvelope?.schemaVersion === 1 &&
      sessionAEnvelope.attempts?.length === 1 &&
      sessionAEnvelope.attempts[0]?.outcome === 'failure' &&
      sessionAEnvelope.attempts[0]?.strategyId === undefined,
    'R4 Session A persisted one automatic failure attempt',
  );
  check(typeof sessionFile === 'string', 'R4 Session A exposed its session file');
  if (typeof sessionFile !== 'string') {
    return false;
  }

  disposeSessionA();
  const resumeManager = SessionManager.open(sessionFile);
  const sessionB = await createIsolatedSession({
    isolation,
    storage: 'file',
    sessionManager: resumeManager,
    additionalExtensionPaths: [AGENT_RETRY_GUARD_EXTENSION_PATH],
    expectedExtensionPath: AGENT_RETRY_GUARD_EXTENSION_PATH,
    customTools: [createRetryProbeTool(invocations, 'retry_file_probe', mode)],
  });
  registerCleanup(() => sessionB.session.dispose());
  check(sessionB.assertSessionStorage(), 'R4 Session B is file-backed');
  check(
    sessionB.sessionFile === sessionFile,
    'R4 Session B reopened Session A file',
  );
  const sessionBEnvelopeBefore = latestStateEnvelope(sessionB.sessionManager);
  const resumedMarker = stateEntriesFor(
    sessionB.sessionManager,
    'agent-retry-auto-record',
  ).at(-1)?.data;
  check(
    sessionBEnvelopeBefore?.attempts?.length === 1 &&
      sessionBEnvelopeBefore.attempts[0]?.outcome === 'failure' &&
      resumedMarker?.schemaVersion === 1 &&
      resumedMarker.enabled === true,
    'R4 Session B restored attempts and the enabled auto-record flag',
  );

  await runScriptedTurn(
    sessionB,
    'Run the resumed failing retry probe.',
    [
      fauxAssistantMessage(fauxToolCall('retry_file_probe', {})),
      fauxAssistantMessage(fauxText('The resumed probe failed.')),
    ],
  );
  const sessionBEnvelopeAfter = latestStateEnvelope(sessionB.sessionManager);
  check(
    invocations.length === 2,
    'R4 Session B executed one more failing custom tool',
  );
  check(
    sessionBEnvelopeAfter?.attempts?.length === 2 &&
      sessionBEnvelopeAfter.attempts[1]?.outcome === 'failure' &&
      sessionBEnvelopeAfter.attempts[1]?.strategyId === undefined,
    'R4 Session B appended one more automatic failure attempt',
  );
  sessionB.assertNoPendingFauxResponses();
  sessionB.assertFauxNetworkIdentity();
  return true;
}

export const name = 'agent-retry-guard-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  const memoryInvocations = [];
  const memoryMode = { fail: true };

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [AGENT_RETRY_GUARD_EXTENSION_PATH],
      expectedExtensionPath: AGENT_RETRY_GUARD_EXTENSION_PATH,
      customTools: [
        createRetryProbeTool(memoryInvocations, 'retry_auto_probe', memoryMode),
      ],
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

    await runRetryCommand(harness, 'auto-record on');
    const stateEntriesBeforeAutoFailure = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const autoFailureEvents = await runScriptedTurn(
      harness,
      'Run the failing automatic-recording probe.',
      [
        fauxAssistantMessage(fauxToolCall('retry_auto_probe', {})),
        fauxAssistantMessage(fauxText('The automatic-recording probe failed.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const autoFailureResult = latestToolResult(harness.session, 'retry_auto_probe');
    const autoFailureEnvelope = latestStateEnvelope(harness.sessionManager);
    const stateEntriesAfterAutoFailure = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    check(
      memoryInvocations.length === 1 &&
        autoFailureEvents.some(
          (event) =>
            event.type === 'tool_execution_start' &&
            event.toolName === 'retry_auto_probe',
        ),
      'R1 executed the failing custom tool exactly once',
    );
    check(
      autoFailureResult?.isError === true,
      'R1 surfaced the failed custom-tool result',
    );
    check(
      stateEntriesAfterAutoFailure.length === stateEntriesBeforeAutoFailure.length + 1 &&
        autoFailureEnvelope?.schemaVersion === 1 &&
        autoFailureEnvelope.attempts?.length === 1 &&
        autoFailureEnvelope.attempts[0]?.outcome === 'failure' &&
        autoFailureEnvelope.attempts[0]?.strategyId === undefined,
      'R1 persisted exactly one automatic failure attempt',
    );

    await runScriptedTurn(
      harness,
      'Judge the automatic failure attempt.',
      [
        fauxAssistantMessage(fauxToolCall('agent_retry_judge', {})),
        fauxAssistantMessage(fauxText('The automatic failure judgment is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const autoJudge = parseRetryVerdict(
      latestToolResult(harness.session, 'agent_retry_judge'),
    );
    check(
      autoJudge?.attempts === 1 &&
        autoJudge.consecutiveFailures === 1 &&
        autoJudge.retryAllowed === true,
      'R1 judge reflected the automatic failure attempt',
    );

    memoryMode.fail = false;
    const beforeSuccessEnvelope = latestStateEnvelope(harness.sessionManager);
    const stateEntriesBeforeSuccess = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const successEvents = await runScriptedTurn(
      harness,
      'Run the successful automatic-recording probe.',
      [
        fauxAssistantMessage(fauxToolCall('retry_auto_probe', {})),
        fauxAssistantMessage(fauxText('The automatic-recording probe succeeded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const successResult = latestToolResult(harness.session, 'retry_auto_probe');
    const afterSuccessEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      memoryInvocations.length === 2 &&
        successEvents.some(
          (event) =>
            event.type === 'tool_execution_start' &&
            event.toolName === 'retry_auto_probe',
        ) &&
        successResult?.isError === false,
      'R3 executed the successful custom tool exactly once',
    );
    check(
      stateEntriesFor(harness.sessionManager, STATE_CUSTOM_TYPE).length ===
        stateEntriesBeforeSuccess.length &&
        JSON.stringify(afterSuccessEnvelope) === JSON.stringify(beforeSuccessEnvelope),
      'R3 left retry attempts unchanged after success',
    );

    await runRetryCommand(harness, 'auto-record off');
    const beforeDisabledFailureEnvelope = latestStateEnvelope(harness.sessionManager);
    const stateEntriesBeforeDisabledFailure = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    memoryMode.fail = true;
    const disabledFailureEvents = await runScriptedTurn(
      harness,
      'Run a failed probe with automatic recording disabled.',
      [
        fauxAssistantMessage(fauxToolCall('retry_auto_probe', {})),
        fauxAssistantMessage(fauxText('The disabled automatic-recording probe failed.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const disabledFailureResult = latestToolResult(
      harness.session,
      'retry_auto_probe',
    );
    const afterDisabledFailureEnvelope = latestStateEnvelope(
      harness.sessionManager,
    );
    check(
      memoryInvocations.length === 3 &&
        disabledFailureEvents.some(
          (event) =>
            event.type === 'tool_execution_start' &&
            event.toolName === 'retry_auto_probe',
        ) &&
        disabledFailureResult?.isError === true,
      'T5 executed a failing custom tool with automatic recording disabled',
    );
    check(
      stateEntriesFor(harness.sessionManager, STATE_CUSTOM_TYPE).length ===
        stateEntriesBeforeDisabledFailure.length &&
        JSON.stringify(afterDisabledFailureEnvelope) ===
          JSON.stringify(beforeDisabledFailureEnvelope),
      'T5 left retry attempts unchanged while automatic recording was off',
    );

    await runRetryCommand(harness, 'auto-record on');
    const beforeMissingEnvelope = latestStateEnvelope(harness.sessionManager);
    const stateEntriesBeforeMissing = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const missingToolEvents = await runScriptedTurn(
      harness,
      'Call a tool that is not registered.',
      [
        fauxAssistantMessage(fauxToolCall('agent_nonexistent_tool', {})),
        fauxAssistantMessage(fauxText('The missing-tool probe is complete.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const missingToolResult = latestToolResult(
      harness.session,
      'agent_nonexistent_tool',
    );
    const afterMissingEnvelope = latestStateEnvelope(harness.sessionManager);
    check(
      missingToolResult?.isError === true &&
        missingToolEvents.some(
          (event) =>
            event.type === 'tool_execution_end' &&
            event.toolName === 'agent_nonexistent_tool' &&
            event.isError === true,
        ),
      'R2 surfaced the immediate error for the non-registered tool',
    );
    check(
      memoryInvocations.length === 3 &&
        stateEntriesFor(harness.sessionManager, STATE_CUSTOM_TYPE).length ===
          stateEntriesBeforeMissing.length &&
        JSON.stringify(afterMissingEnvelope) === JSON.stringify(beforeMissingEnvelope),
      'R2 did not record the non-executed missing tool',
    );

    const fileIsolation = makeIsolation();
    registerCleanup(fileIsolation.cleanup);
    await runFileBackedAutoRecord({
      isolation: fileIsolation,
      registerCleanup,
      check,
    });

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
