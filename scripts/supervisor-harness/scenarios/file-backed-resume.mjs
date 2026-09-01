/* global console, process */

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  runScriptedTurn,
} from '../runner.mjs';
import { resolve } from 'node:path';

const PROBE_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/probe-extension.mjs',
);
const PROBE_FEATURE_ID = 'probe-blocker';

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function parseStatus(output, label) {
  const rootMatch = /^Current root: ([^\s]+) \(([^)]+)\)$/mu.exec(output);
  const requestedGlobalMatch = /^Requested global mode: (\S+)$/mu.exec(output);
  const effectiveGlobalMatch = /^Effective global mode: (\S+)$/mu.exec(output);
  const featureLine = output
    .split('\n')
    .find((line) => line.startsWith(`- ${PROBE_FEATURE_ID}:`));
  const featureMatch =
    featureLine === undefined
      ? undefined
      : /requested=([^,]+), effective=([^,]+),/u.exec(featureLine);

  if (
    rootMatch === null ||
    requestedGlobalMatch === null ||
    effectiveGlobalMatch === null ||
    featureLine === undefined ||
    featureMatch === undefined
  ) {
    throw new Error(`status command omitted required fields at ${label}`);
  }

  return {
    output,
    root: { id: rootMatch[1], status: rootMatch[2] },
    requestedGlobalMode: requestedGlobalMatch[1],
    effectiveGlobalMode: effectiveGlobalMatch[1],
    feature: {
      line: featureLine,
      requestedMode: featureMatch[1],
      effectiveMode: featureMatch[2],
    },
  };
}

async function captureStatus(harness, label) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  if (harness.faux.state.callCount !== callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  return parseStatus(notifyText(harness.uiMessages.slice(messageStart)), label);
}

function rootSequence(rootId) {
  const match = /^root-(\d+)$/u.exec(rootId);
  return match === null ? undefined : Number(match[1]);
}

export const name = 'file-backed-resume';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const previousProfile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
  process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = 'blocker';
  registerCleanup(() => {
    if (previousProfile === undefined) {
      delete process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
    } else {
      process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = previousProfile;
    }
  });

  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  try {
    const sessionA = await createIsolatedSession({
      isolation,
      storage: 'file',
      additionalExtensionPaths: [PROBE_EXTENSION_PATH],
      expectedExtensionPath: PROBE_EXTENSION_PATH,
    });
    registerCleanup(sessionA.cleanup);

    const probeExtensionA = sessionA.extensionsResult.extensions[0];
    check(
      sessionA.extensionsResult.extensions.length === 1 &&
        probeExtensionA?.resolvedPath === PROBE_EXTENSION_PATH,
      'Session 1 loaded exactly the probe supervisor extension fixture',
    );
    check(
      sessionA.extensionsResult.errors.length === 0,
      'Session 1 probe supervisor extension loading returned no errors',
    );
    check(
      probeExtensionA?.commands.has('agent-supervisor'),
      'Session 1 registered the public agent-supervisor command',
    );
    check(
      typeof sessionA.session.sessionFile === 'string',
      'Session 1 created a file-backed session',
    );

    const configCommandCalls = sessionA.faux.state.callCount;
    await sessionA.session.prompt('/agent-supervisor mode observe');
    await sessionA.session.prompt(
      `/agent-supervisor feature ${PROBE_FEATURE_ID} observe`,
    );
    check(
      sessionA.faux.state.callCount === configCommandCalls,
      'Supervisor mode commands caused zero faux model calls',
    );

    const session1Events = await runScriptedTurn(
      sessionA,
      'Complete the first file-backed resume turn.',
      [fauxAssistantMessage(fauxText('First session turn complete.'))],
    );
    check(
      session1Events.filter((event) => event?.type === 'agent_start').length ===
        1 &&
        session1Events.filter((event) => event?.type === 'agent_end').length ===
          1,
      'Session 1 completed one real interactive turn',
    );
    sessionA.assertNoPendingFauxResponses();

    const session1FinalStatus = await captureStatus(
      sessionA,
      'Session 1 final status',
    );
    const sessionFile = sessionA.session.sessionFile;
    const session1Sequence = rootSequence(session1FinalStatus.root.id);
    console.log(
      `  TRACE file-backed-resume session 1 root: ${session1FinalStatus.root.id} (${session1FinalStatus.root.status})`,
    );
    check(
      session1FinalStatus.root.status === 'settled' &&
        session1Sequence !== undefined,
      'Session 1 final status captured an allocated settled root',
    );
    check(
      session1FinalStatus.requestedGlobalMode === 'observe' &&
        session1FinalStatus.effectiveGlobalMode === 'observe',
      'Session 1 final status shows the requested and effective global observe mode',
    );
    check(
      session1FinalStatus.output.includes('Registered features: 1') &&
        session1FinalStatus.feature.line.includes('default=autonomous') &&
        session1FinalStatus.feature.requestedMode === 'observe' &&
        session1FinalStatus.feature.effectiveMode === 'observe',
      'Session 1 final status shows the probe feature override from its autonomous default',
    );

    if (typeof sessionFile !== 'string') {
      return { status: 'fail', reason: 'Session 1 did not expose a session file' };
    }

    sessionA.cleanup();
    const resumeManager = SessionManager.open(sessionFile);
    const sessionB = await createIsolatedSession({
      isolation,
      storage: 'file',
      sessionManager: resumeManager,
      additionalExtensionPaths: [PROBE_EXTENSION_PATH],
      expectedExtensionPath: PROBE_EXTENSION_PATH,
      sessionStartEvent: {
        type: 'session_start',
        reason: 'resume',
        previousSessionFile: sessionFile,
      },
    });
    registerCleanup(sessionB.cleanup);

    const probeExtensionB = sessionB.extensionsResult.extensions[0];
    check(
      sessionB.extensionsResult.extensions.length === 1 &&
        probeExtensionB?.resolvedPath === PROBE_EXTENSION_PATH,
      'Resume loaded exactly the probe supervisor extension fixture',
    );
    check(
      sessionB.extensionsResult.errors.length === 0,
      'Resume probe supervisor extension loading returned no errors',
    );
    check(
      sessionB.session.sessionFile === sessionFile,
      'Resume reopened the same session file',
    );

    const resumedStatus = await captureStatus(sessionB, 'Resume status');
    console.log(
      `  TRACE file-backed-resume on resume root: ${resumedStatus.root.id} (${resumedStatus.root.status})`,
    );
    check(
      resumedStatus.root.id === 'none' && resumedStatus.root.status === 'none',
      'Resume status did not reactivate Session 1 current root',
    );
    check(
      resumedStatus.requestedGlobalMode === 'observe' &&
        resumedStatus.effectiveGlobalMode === 'observe',
      'Resume status restored the requested and effective global observe mode',
    );
    check(
      resumedStatus.output.includes('Registered features: 1') &&
        resumedStatus.feature.line.includes('default=autonomous') &&
        resumedStatus.feature.requestedMode === 'observe' &&
        resumedStatus.feature.effectiveMode === 'observe',
      'Resume status restored the per-feature observe override',
    );

    const resumedEvents = await runScriptedTurn(
      sessionB,
      'Complete the next file-backed resume turn.',
      [fauxAssistantMessage(fauxText('Resumed session turn complete.'))],
    );
    check(
      resumedEvents.filter((event) => event?.type === 'agent_start').length ===
        1 &&
        resumedEvents.filter((event) => event?.type === 'agent_end').length ===
          1,
      'Resume completed one real interactive turn',
    );
    sessionB.assertNoPendingFauxResponses();

    const resumedFinalStatus = await captureStatus(
      sessionB,
      'Resume final status',
    );
    const resumedSequence = rootSequence(resumedFinalStatus.root.id);
    console.log(
      `  TRACE file-backed-resume after resume root: ${resumedFinalStatus.root.id} (${resumedFinalStatus.root.status})`,
    );
    check(
      resumedFinalStatus.root.status === 'settled' &&
        resumedSequence !== undefined &&
        resumedFinalStatus.root.id !== session1FinalStatus.root.id,
      'Resume allocated a settled root id that was not used in Session 1',
    );
    check(
      resumedSequence !== undefined &&
        session1Sequence !== undefined &&
        resumedSequence > session1Sequence,
      'Resume continued the persisted root request sequence',
    );
    check(
      resumedFinalStatus.requestedGlobalMode === 'observe' &&
        resumedFinalStatus.effectiveGlobalMode === 'observe' &&
        resumedFinalStatus.feature.requestedMode === 'observe' &&
        resumedFinalStatus.feature.effectiveMode === 'observe',
      'Resume final status retained both Supervisor mode settings',
    );
    sessionB.assertNoPendingFauxResponses();
    sessionB.assertNoAuthCredentials();

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: `file-backed resume verified (${session1FinalStatus.root.id} -> ${resumedFinalStatus.root.id})`,
        }
      : { status: 'fail', reason: 'file-backed resume assertions failed' };
  } finally {
    await cleanupAll();
  }
}
