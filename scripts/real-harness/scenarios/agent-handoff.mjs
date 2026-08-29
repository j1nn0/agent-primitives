/* global console */

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

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

async function runResumeProbe({ isolation, envelope, registerCleanup, check }) {
  const resumeManager = SessionManager.inMemory(isolation.workDir);
  resumeManager.appendCustomEntry('agent-handoff-state', envelope);

  const probe = await createIsolatedSession({
    isolation,
    sessionManager: resumeManager,
    additionalExtensionPaths: [HANDOFF_EXTENSION_PATH],
    expectedExtensionPath: HANDOFF_EXTENSION_PATH,
  });
  registerCleanup(() => probe.session.dispose());

  const probeResponses = [
    fauxAssistantMessage(fauxToolCall('agent_handoff_get', {})),
    fauxAssistantMessage(fauxText('Resume probe complete.')),
  ];
  await runScriptedTurn(
    probe,
    'Read the reconstructed handoff packets.',
    probeResponses,
  );
  const probeAResult = latestToolResult(probe.session, 'agent_handoff_get');
  const probeAVisible =
    probeAResult !== undefined && messageText(probeAResult).includes(PACKET_ID);
  probe.assertNoPendingFauxResponses();
  probe.assertFauxNetworkIdentity();

  if (probeAVisible) {
    check(true, 'resume probe A reconstructed the captured handoff state');
    probe.assertNoPendingFauxResponses();
    probe.assertFauxNetworkIdentity();
    check(probe.session.sessionFile === undefined, 'resume probe stayed in-memory');
    return 'supported';
  }

  const publicMethods = Object.getOwnPropertyNames(
    Object.getPrototypeOf(resumeManager),
  ).filter((name) => name !== 'constructor' && !name.startsWith('_'));
  console.log(
    `  resume probe public SessionManager surface: ${publicMethods.join(', ')}`,
  );
  console.log(
    '  resume probe: trying public AgentSession.reload() as the only alternate path',
  );

  try {
    await probe.session.reload();
  } catch (error) {
    console.error(
      '  resume probe public reload failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return 'unsupported';
  }

  await runScriptedTurn(
    probe,
    'Read the reconstructed handoff packets after reload.',
    probeResponses,
  );
  const probeBResult = latestToolResult(probe.session, 'agent_handoff_get');
  const probeBVisible =
    probeBResult !== undefined && messageText(probeBResult).includes(PACKET_ID);
  probe.assertNoPendingFauxResponses();
  probe.assertFauxNetworkIdentity();
  check(probe.session.sessionFile === undefined, 'resume probe stayed in-memory');

  if (probeBVisible) {
    check(true, 'resume probe B reconstructed the captured handoff state');
    return 'supported';
  }
  return 'unsupported';
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
    check(true, 'H1 produced a state envelope for the resume probe');
    const capturedEnvelope = capturedStateEntry.data;

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

    const resumeStatus = await runResumeProbe({
      isolation,
      envelope: capturedEnvelope,
      registerCleanup,
      check,
    });
    if (resumeStatus === 'supported') {
      return {
        status: result.status,
        reason:
          result.status === 'pass'
            ? 'resume: SUPPORTED'
            : 'resume: SUPPORTED; handoff assertions failed',
      };
    }
    if (result.status === 'fail') {
      return { status: 'fail', reason: 'handoff assertions failed' };
    }
    return {
      status: 'pass',
      reason: 'resume: NOT REPRESENTABLE WITH CURRENT PUBLIC SDK',
    };
  } finally {
    await cleanupAll();
  }
}
