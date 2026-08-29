import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  AGENT_STATE_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const STATE_CUSTOM_TYPE = 'agent-state-state';
const WORK_ITEM_ID = 'b2a-state-work-item';

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

function latestStateEnvelope(sessionManager) {
  return stateEntriesFor(sessionManager, STATE_CUSTOM_TYPE).at(-1)?.data;
}

export const name = 'agent-state-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [AGENT_STATE_EXTENSION_PATH],
      expectedExtensionPath: AGENT_STATE_EXTENSION_PATH,
    });
    registerCleanup(() => harness.session.dispose());
    check(
      harness.extensionsResult.extensions.length === 1 &&
        harness.extensionsResult.extensions[0]?.resolvedPath ===
          AGENT_STATE_EXTENSION_PATH,
      'loader contract passed for the agent-state adapter',
    );
    check(
      harness.session.sessionFile === undefined,
      'agent-state session is in-memory',
    );

    const addEvents = await runScriptedTurn(
      harness,
      'Record the requested Agent State work item.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_state_add_work_item', {
            id: WORK_ITEM_ID,
            content: 'Verify Agent State real-runtime persistence.',
            status: 'open',
          }),
        ),
        fauxAssistantMessage(fauxText('The work item was recorded.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      addEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_state_add_work_item',
      ),
      'S1 captured the real agent_state_add_work_item tool event',
    );
    const addedEnvelope = latestStateEnvelope(harness.sessionManager);
    const addedState = addedEnvelope?.state;
    const addedItem = Array.isArray(addedState?.workItems)
      ? addedState.workItems.find((item) => item?.id === WORK_ITEM_ID)
      : undefined;
    check(
      addedEnvelope?.schemaVersion === 1 &&
        addedState?.schemaVersion === 1 &&
        addedItem?.id === WORK_ITEM_ID &&
        addedItem.content === 'Verify Agent State real-runtime persistence.' &&
        addedItem.status === 'open',
      'S1 persisted the structured work item envelope',
    );

    const statusEvents = await runScriptedTurn(
      harness,
      'Mark the Agent State work item done.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_state_set_work_item_status', {
            id: WORK_ITEM_ID,
            status: 'done',
          }),
        ),
        fauxAssistantMessage(fauxText('The work item status was updated.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      statusEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_state_set_work_item_status',
      ),
      'S1 captured the real agent_state_set_work_item_status tool event',
    );
    const updatedEnvelope = latestStateEnvelope(harness.sessionManager);
    const updatedItem = Array.isArray(updatedEnvelope?.state?.workItems)
      ? updatedEnvelope.state.workItems.find((item) => item?.id === WORK_ITEM_ID)
      : undefined;
    check(
      updatedEnvelope?.state?.schemaVersion === 1 &&
        updatedItem?.id === WORK_ITEM_ID &&
        updatedItem.status === 'done',
      'S1 persisted the changed work item status',
    );

    await runScriptedTurn(
      harness,
      'Read the current Agent State.',
      [
        fauxAssistantMessage(fauxToolCall('agent_state_get', {})),
        fauxAssistantMessage(fauxText('The Agent State was read.')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    const getResult = latestToolResult(harness.session, 'agent_state_get');
    const getText = getResult === undefined ? '' : messageText(getResult);
    check(
      getResult !== undefined &&
        getResult.isError === false &&
        getText.includes(WORK_ITEM_ID) &&
        getText.includes('Verify Agent State real-runtime persistence.') &&
        getText.includes('[done]'),
      'S2 get returned the structured Agent State content',
    );

    const entriesBeforeCommand = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const beforeCommand = entriesBeforeCommand.at(-1);
    const beforeCommandItem = Array.isArray(beforeCommand?.data?.state?.workItems)
      ? beforeCommand.data.state.workItems.find((item) => item?.id === WORK_ITEM_ID)
      : undefined;
    try {
      // The current adapter exposes `status` as its read-only command; `list` is not registered.
      await harness.session.prompt('/agent-state status');
      check(true, 'S3 read-only Agent State command completed without error');
    } catch {
      check(false, 'S3 read-only Agent State command completed without error');
    }
    const entriesAfterCommand = stateEntriesFor(
      harness.sessionManager,
      STATE_CUSTOM_TYPE,
    );
    const afterCommand = entriesAfterCommand.at(-1);
    const afterCommandItem = Array.isArray(afterCommand?.data?.state?.workItems)
      ? afterCommand.data.state.workItems.find((item) => item?.id === WORK_ITEM_ID)
      : undefined;
    check(
      entriesAfterCommand.length === entriesBeforeCommand.length &&
        beforeCommand?.data?.schemaVersion === 1 &&
        afterCommand?.data?.schemaVersion === 1 &&
        beforeCommandItem?.status === 'done' &&
        afterCommandItem?.id === WORK_ITEM_ID &&
        afterCommandItem.status === 'done',
      'S3 read-only Agent State command did not append a state entry',
    );

    harness.assertInMemorySession();
    harness.assertNoAuthCredentials();
    harness.assertFauxNetworkIdentity();
    return result.status === 'pass'
      ? { status: 'pass', reason: 'agent-state wiring verified' }
      : { status: 'fail', reason: 'agent-state assertions failed' };
  } finally {
    await cleanupAll();
  }
}
