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
  createIsolatedSession,
  makeIsolation,
} from '../runner.mjs';

const PACKET_ID = 'b1-packet-1';

function handoffStateEntries(sessionManager) {
  return sessionManager
    .getBranch()
    .filter(
      (entry) =>
        entry.type === 'custom' && entry.customType === 'agent-handoff-state',
    );
}

async function runScriptedTurn(harness, prompt, responses) {
  const start = harness.events.length;
  harness.faux.setResponses(responses);
  const turnFinished = harness.armAgentEndWaiter();
  await harness.session.prompt(prompt);
  await turnFinished;
  return harness.events.slice(start);
}

async function runResumeProbe({ isolation, envelope, sessions, check }) {
  const resumeManager = SessionManager.inMemory(isolation.workDir);
  resumeManager.appendCustomEntry('agent-handoff-state', envelope);

  const probe = await createIsolatedSession({
    isolation,
    sessionManager: resumeManager,
    additionalExtensionPaths: [HANDOFF_EXTENSION_PATH],
    expectedExtensionPath: HANDOFF_EXTENSION_PATH,
  });
  sessions.push(probe);

  const probeResponses = [
    fauxAssistantMessage(fauxToolCall('agent_handoff_get', {})),
    fauxAssistantMessage(fauxText('Resume probe complete.')),
  ];
  const probeAEvents = await runScriptedTurn(
    probe,
    'Read the reconstructed handoff packets.',
    probeResponses,
  );
  const probeAVisible = probeAEvents.some((event) => event.includes(PACKET_ID));
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

  const probeBEvents = await runScriptedTurn(
    probe,
    'Read the reconstructed handoff packets after reload.',
    probeResponses,
  );
  const probeBVisible = probeBEvents.some((event) => event.includes(PACKET_ID));
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

export async function run() {
  const { check, result } = createCheck();
  const isolation = makeIsolation();
  const sessions = [];

  try {
    const primary = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [HANDOFF_EXTENSION_PATH],
      expectedExtensionPath: HANDOFF_EXTENSION_PATH,
    });
    sessions.push(primary);

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
    const h1Branch = JSON.stringify(primary.sessionManager.getBranch());
    check(
      h1Branch.includes('agent-handoff-state') && h1Branch.includes(PACKET_ID),
      'H1 create persisted the packet through the real runtime',
    );
    check(
      h1Events.some((event) => event.includes('agent_handoff_create')),
      'H1 captured the real agent_handoff_create tool call event',
    );
    primary.assertNoPendingFauxResponses();
    primary.assertFauxNetworkIdentity();

    const capturedStateEntry = handoffStateEntries(primary.sessionManager).at(-1);
    if (capturedStateEntry === undefined || capturedStateEntry.data === undefined) {
      check(false, 'H1 produced a state envelope for the resume probe');
      return { status: 'fail', reason: 'H1 did not produce a persisted state envelope' };
    }
    check(true, 'H1 produced a state envelope for the resume probe');
    const capturedEnvelope = capturedStateEntry.data;

    const h2GetEvents = await runScriptedTurn(
      primary,
      'Read the current handoff packets.',
      [
        fauxAssistantMessage(fauxToolCall('agent_handoff_get', {})),
        fauxAssistantMessage(fauxText('The current handoff packet was read.')),
      ],
    );
    check(
      h2GetEvents.some(
        (event) =>
          event.includes('agent_handoff_get') && event.includes(PACKET_ID),
      ),
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
    const newestStateEntry = handoffStateEntries(primary.sessionManager).at(-1);
    check(
      h2RemoveEvents.some((event) => event.includes('agent_handoff_remove')),
      'H2 remove executed the real agent_handoff_remove tool call',
    );
    check(
      newestStateEntry !== undefined &&
        !JSON.stringify(newestStateEntry.data).includes(PACKET_ID),
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
      sessions,
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
    for (const harness of sessions.reverse()) {
      harness.session.dispose();
    }
    isolation.cleanup();
  }
}
