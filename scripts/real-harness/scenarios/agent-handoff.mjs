import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  HANDOFF_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const PACKET_ID = 'b1-packet-1';
const PACKET_GOAL =
  'Prove real-harness handoff execution and state persistence.';

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

async function runFileBackedResume({ isolation, registerCleanup, check }) {
  const sessionA = await createIsolatedSession({
    isolation,
    storage: 'file',
    additionalExtensionPaths: [HANDOFF_EXTENSION_PATH],
    expectedExtensionPath: HANDOFF_EXTENSION_PATH,
  });
  let sessionADisposed = false;
  const disposeSessionA = () => {
    if (!sessionADisposed) {
      sessionA.session.dispose();
      sessionADisposed = true;
    }
  };
  registerCleanup(disposeSessionA);

  check(sessionA.assertSessionStorage(), 'resume Session A is file-backed');
  const h1Events = await runScriptedTurn(
    sessionA,
    'Create the requested handoff packet for the resume round-trip.',
    [
      fauxAssistantMessage([
        fauxText('Creating the requested handoff packet.'),
        fauxToolCall('agent_handoff_create', {
          schemaVersion: 1,
          id: PACKET_ID,
          source: 'real-harness-b1-resume',
          goal: PACKET_GOAL,
        }),
      ]),
      fauxAssistantMessage(fauxText('Handoff packet created.')),
    ],
  );
  const sessionFile = sessionA.sessionFile;
  const stateEntry = stateEntriesFor(
    sessionA.sessionManager,
    'agent-handoff-state',
  ).at(-1);
  const envelope = stateEntry?.data;
  const packet = envelope?.packets?.find((candidate) => candidate?.id === PACKET_ID);
  check(
    typeof sessionFile === 'string',
    'resume Session A exposed its file path',
  );
  check(
    envelope?.schemaVersion === 1 && packet?.id === PACKET_ID,
    'resume Session A H1 persisted a structured handoff envelope',
  );
  check(
    h1Events.some(
      (event) =>
        event.type === 'tool_execution_start' &&
        event.toolName === 'agent_handoff_create',
    ),
    'resume Session A captured the real agent_handoff_create tool call',
  );
  sessionA.assertNoPendingFauxResponses();
  sessionA.assertFauxNetworkIdentity();

  if (typeof sessionFile !== 'string' || envelope === undefined) {
    return false;
  }
  disposeSessionA();

  const resumeManager = SessionManager.open(sessionFile);
  const sessionB = await createIsolatedSession({
    isolation,
    storage: 'file',
    sessionManager: resumeManager,
    additionalExtensionPaths: [HANDOFF_EXTENSION_PATH],
    expectedExtensionPath: HANDOFF_EXTENSION_PATH,
  });
  registerCleanup(() => sessionB.session.dispose());
  check(sessionB.assertSessionStorage(), 'resume Session B is file-backed');
  check(
    sessionB.sessionFile === sessionFile,
    'resume Session B reopened Session A file',
  );

  await runScriptedTurn(
    sessionB,
    'Read the reconstructed handoff packets.',
    [
      fauxAssistantMessage(fauxToolCall('agent_handoff_get', {})),
      fauxAssistantMessage(fauxText('Resume round-trip complete.')),
    ],
  );
  const probeResult = latestToolResult(sessionB.session, 'agent_handoff_get');
  const probeOutput =
    probeResult === undefined ? '' : messageText(probeResult);
  check(
    probeResult !== undefined &&
      probeOutput.includes(PACKET_ID) &&
      probeOutput.includes(PACKET_GOAL),
    'resume Session B returned the reconstructed packet id and content',
  );
  const resumedStateEntry = stateEntriesFor(
    sessionB.sessionManager,
    'agent-handoff-state',
  ).at(-1);
  check(
    resumedStateEntry?.data !== undefined &&
      JSON.stringify(resumedStateEntry.data) === JSON.stringify(envelope),
    'resume Session B newest handoff envelope matches Session A',
  );
  sessionB.assertNoPendingFauxResponses();
  sessionB.assertFauxNetworkIdentity();
  return true;
}

export const name = 'agent-handoff-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const primary = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [HANDOFF_EXTENSION_PATH],
      expectedExtensionPath: HANDOFF_EXTENSION_PATH,
    });
    registerCleanup(() => primary.session.dispose());

    check(
      primary.extensionsResult.extensions.length === 1 &&
        primary.extensionsResult.extensions[0]?.resolvedPath ===
          HANDOFF_EXTENSION_PATH,
      'loader contract passed for the handoff adapter',
    );
    check(
      primary.session.sessionFile === undefined,
      'session is in-memory (no session file)',
    );

    const h1Events = await runScriptedTurn(
      primary,
      'Create the requested handoff packet.',
      [
        fauxAssistantMessage([
          fauxText('Creating the requested handoff packet.'),
          fauxToolCall('agent_handoff_create', {
            schemaVersion: 1,
            id: PACKET_ID,
            source: 'real-harness-b1',
            goal: 'Prove real-harness handoff execution and state persistence.',
          }),
        ]),
        fauxAssistantMessage(fauxText('Handoff packet created.')),
      ],
    );
    const h1StateEntry = stateEntriesFor(
      primary.sessionManager,
      'agent-handoff-state',
    ).at(-1);
    const h1Envelope = h1StateEntry?.data;
    const h1Packet = h1Envelope?.packets?.find(
      (packet) => packet?.id === PACKET_ID,
    );
    check(
      h1Envelope?.schemaVersion === 1 && h1Packet?.id === PACKET_ID,
      'H1 create persisted the packet through the real runtime',
    );
    check(
      h1Events.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_handoff_create',
      ),
      'H1 captured the real agent_handoff_create tool call event',
    );
    primary.assertNoPendingFauxResponses();
    primary.assertFauxNetworkIdentity();

    const capturedStateEntry = stateEntriesFor(
      primary.sessionManager,
      'agent-handoff-state',
    ).at(-1);
    if (capturedStateEntry === undefined || capturedStateEntry.data === undefined) {
      check(false, 'H1 produced a state envelope for the resume probe');
      return { status: 'fail', reason: 'H1 did not produce a persisted state envelope' };
    }
    check(true, 'H1 produced a structured state envelope');

    await runScriptedTurn(
      primary,
      'Read the current handoff packets.',
      [
        fauxAssistantMessage(fauxToolCall('agent_handoff_get', {})),
        fauxAssistantMessage(fauxText('The current handoff packet was read.')),
      ],
    );
    const h2GetResult = latestToolResult(primary.session, 'agent_handoff_get');
    check(
      h2GetResult !== undefined && messageText(h2GetResult).includes(PACKET_ID),
      'H2 get returned the created packet content',
    );
    primary.assertNoPendingFauxResponses();
    primary.assertFauxNetworkIdentity();

    const h2RemoveEvents = await runScriptedTurn(
      primary,
      'Remove the created handoff packet.',
      [
        fauxAssistantMessage(
          fauxToolCall('agent_handoff_remove', { id: PACKET_ID }),
        ),
        fauxAssistantMessage(fauxText('The handoff packet was removed.')),
      ],
    );
    const newestStateEntry = stateEntriesFor(
      primary.sessionManager,
      'agent-handoff-state',
    ).at(-1);
    check(
      h2RemoveEvents.some(
        (event) =>
          event.type === 'tool_execution_start' &&
          event.toolName === 'agent_handoff_remove',
      ),
      'H2 remove executed the real agent_handoff_remove tool call',
    );
    check(
      newestStateEntry?.data?.schemaVersion === 1 &&
        Array.isArray(newestStateEntry.data.packets) &&
        !newestStateEntry.data.packets.some(
          (packet) => packet?.id === PACKET_ID,
        ),
      'H2 newest handoff state no longer contains the packet',
    );
    primary.assertNoPendingFauxResponses();
    primary.assertFauxNetworkIdentity();

    if (result.status === 'fail') {
      return { status: 'fail', reason: 'handoff assertions failed' };
    }

    const resumeVerified = await runFileBackedResume({
      isolation,
      registerCleanup,
      check,
    });
    if (result.status === 'fail' || !resumeVerified) {
      return { status: 'fail', reason: 'handoff assertions failed' };
    }
    return {
      status: 'pass',
      reason: 'file-backed resume round-trip verified',
    };
  } finally {
    await cleanupAll();
  }
}
