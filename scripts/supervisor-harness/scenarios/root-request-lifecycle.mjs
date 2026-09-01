/* global console, process */

import {
  fauxAssistantMessage,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
} from '../runner.mjs';
import { resolve } from 'node:path';

const PROBE_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/probe-extension.mjs',
);
const PROBE_PROFILE = 'observer';

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function createGatedResponse(text) {
  let markStarted;
  let releaseResponse;
  let released = false;
  const started = new Promise((resolveStarted) => {
    markStarted = resolveStarted;
  });
  const releasedPromise = new Promise((resolveRelease) => {
    releaseResponse = resolveRelease;
  });

  return {
    started,
    response: async () => {
      markStarted();
      await releasedPromise;
      return fauxAssistantMessage(fauxText(text));
    },
    release() {
      if (!released) {
        released = true;
        releaseResponse();
      }
    },
  };
}

function startGatedTurn(harness, prompt, source, gate, options = {}) {
  harness.faux.setResponses([gate.response]);
  const agentEnd = harness.armAgentEndWaiter();
  const promptPromise = harness.session.prompt(prompt, {
    ...options,
    source,
  });
  return { agentEnd, promptPromise };
}

async function finishGatedTurn(turn, gate) {
  gate.release();
  await turn.promptPromise;
  await turn.agentEnd;
}

async function captureStatus(harness, trace, step) {
  const notifyCount = harness.uiMessages.length;
  const callCount = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  const output = notifyText(harness.uiMessages.slice(notifyCount));
  if (harness.faux.state.callCount !== callCount) {
    throw new Error(`status command caused an unexpected faux model call at step ${step}`);
  }
  const match = /^Current root: ([^\s]+) \(([^)]+)\)$/m.exec(output);
  if (match === null) {
    throw new Error(`status command omitted Current root at step ${step}`);
  }
  const observation = { id: match[1], status: match[2] };
  trace.push(observation);
  console.log(
    `  TRACE root-request-lifecycle step ${step}: Current root: ${observation.id} (${observation.status})`,
  );
  return observation;
}

export const name = 'root-request-lifecycle';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const previousProfile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
  process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = PROBE_PROFILE;
  registerCleanup(() => {
    if (previousProfile === undefined) {
      delete process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
    } else {
      process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = previousProfile;
    }
  });

  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);
  const trace = [];

  try {
    const harness = await createIsolatedSession({
      isolation,
      storage: 'memory',
      additionalExtensionPaths: [PROBE_EXTENSION_PATH],
      expectedExtensionPath: PROBE_EXTENSION_PATH,
    });
    registerCleanup(harness.cleanup);

    const extensions = harness.extensionsResult.extensions;
    const probeExtension = extensions[0];
    check(
      extensions.length === 1 &&
        probeExtension?.resolvedPath === PROBE_EXTENSION_PATH,
      'loaded exactly the probe supervisor extension fixture',
    );
    check(
      harness.extensionsResult.errors.length === 0,
      'probe supervisor extension loading returned no errors',
    );

    const callsBeforeTurns = harness.faux.state.callCount;
    const firstGate = createGatedResponse('interactive turn complete');
    const extensionWhileActiveGate = createGatedResponse(
      'extension follow-up turn complete',
    );
    registerCleanup(firstGate.release);
    registerCleanup(extensionWhileActiveGate.release);

    harness.faux.setResponses([
      firstGate.response,
      extensionWhileActiveGate.response,
    ]);
    const firstTurn = {
      agentEnd: harness.armAgentEndWaiter(),
      promptPromise: harness.session.prompt(
        'Start the first root request.',
        { source: 'interactive' },
      ),
    };
    await firstGate.started;
    const step1 = await captureStatus(harness, trace, 1);
    check(
      step1.id === 'root-1' && step1.status === 'active',
      'interactive input created root-1 in active status',
    );
    check(
      harness.faux.state.callCount === callsBeforeTurns + 1,
      'the first interactive turn consumed exactly one faux response',
    );

    const extensionPrompt = harness.session.prompt(
      'Continue the active root request.',
      { source: 'extension', streamingBehavior: 'followUp' },
    );
    await extensionPrompt;
    firstGate.release();
    await extensionWhileActiveGate.started;
    const step2 = await captureStatus(harness, trace, 2);
    check(
      step2.id === 'root-1' && step2.status === 'active',
      'extension input kept root-1 active without creating a new root',
    );
    check(
      harness.faux.state.callCount === callsBeforeTurns + 2,
      'the active extension input drove exactly one scripted follow-up turn',
    );

    extensionWhileActiveGate.release();
    await firstTurn.promptPromise;
    await firstTurn.agentEnd;
    harness.assertNoAuthCredentials();
    const step3 = await captureStatus(harness, trace, 3);
    check(
      step3.id === 'root-1' && step3.status === 'settled',
      'settlement retained root-1 and marked it settled',
    );

    const extensionAfterSettlementGate = createGatedResponse(
      'post-settlement extension turn complete',
    );
    registerCleanup(extensionAfterSettlementGate.release);
    const extensionAfterSettlementTurn = startGatedTurn(
      harness,
      'Rejoin the settled root request.',
      'extension',
      extensionAfterSettlementGate,
    );
    await extensionAfterSettlementGate.started;
    const step4 = await captureStatus(harness, trace, 4);
    check(
      step4.id === 'root-1' && step4.status === 'active',
      'post-settlement extension input reactivated the same root-1',
    );
    check(
      harness.faux.state.callCount === callsBeforeTurns + 3,
      'the post-settlement extension input consumed exactly one faux response',
    );
    await finishGatedTurn(
      extensionAfterSettlementTurn,
      extensionAfterSettlementGate,
    );

    const rpcGate = createGatedResponse('rpc root turn complete');
    registerCleanup(rpcGate.release);
    const rpcTurn = startGatedTurn(
      harness,
      'Start the second root request.',
      'rpc',
      rpcGate,
    );
    await rpcGate.started;
    const step5 = await captureStatus(harness, trace, 5);
    check(
      step5.id === 'root-2' && step5.status === 'active',
      'rpc input started a new root-2 in active status',
    );
    check(
      harness.faux.state.callCount === callsBeforeTurns + 4,
      'the rpc input consumed exactly one faux response',
    );
    await finishGatedTurn(rpcTurn, rpcGate);

    check(
      harness.faux.getPendingResponseCount() === 0,
      'no unconsumed faux responses remain',
    );
    harness.assertNoPendingFauxResponses();
    harness.assertNoAuthCredentials();

    return result.status === 'pass'
      ? { status: 'pass', reason: 'Root Request lifecycle verified' }
      : { status: 'fail', reason: 'Root Request lifecycle assertions failed' };
  } finally {
    await cleanupAll();
  }
}
