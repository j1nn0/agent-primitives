/* global setImmediate */

import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  TOOL_POLICY_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  messageText,
  runScriptedTurn,
  stateEntriesFor,
  toolResultMessages,
} from '../runner.mjs';

const POLICY_ALLOW = {
  default: 'allow',
  allow: [],
  deny: [],
  requiresApproval: [],
};
const POLICY_DENY = {
  default: 'allow',
  allow: [],
  deny: ['spike_echo'],
  requiresApproval: [],
};
const POLICY_APPROVAL = {
  default: 'allow',
  allow: [],
  deny: [],
  requiresApproval: ['spike_echo'],
};

const CORRUPT_BLOCK_REASON =
  'policy configuration is invalid or corrupted; tool call blocked.';

function createEchoTool(invocations) {
  return {
    name: 'spike_echo',
    label: 'Spike Echo',
    description: 'Deterministic real-harness tool-policy probe tool.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      invocations.push(true);
      return { content: [{ type: 'text', text: 'echo-ok' }] };
    },
  };
}

function latestToolResult(session, toolName) {
  return toolResultMessages(session)
    .filter((message) => message.toolName === toolName)
    .at(-1);
}

async function runScriptedToolTurn(harness) {
  return runScriptedTurn(
    harness,
    'Run the spike echo tool.',
    [
      fauxAssistantMessage([
        fauxText('Trying the tool.'),
        fauxToolCall('spike_echo', {}),
      ]),
      fauxAssistantMessage(fauxText('Tool turn complete.')),
    ],
  );
}

async function runConfiguredCase({
  name,
  policy,
  expectedReason,
  expectedExecuted,
  invocations,
  registerCleanup,
  check,
}) {
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);
  const harness = await createIsolatedSession({
    isolation,
    additionalExtensionPaths: [TOOL_POLICY_EXTENSION_PATH],
    expectedExtensionPath: TOOL_POLICY_EXTENSION_PATH,
    customTools: [createEchoTool(invocations)],
  });
  registerCleanup(() => harness.session.dispose());
  check(
    harness.session.sessionFile === undefined,
    `${name} stayed in-memory`,
  );

  if (policy !== null) {
    await harness.session.prompt(
      `/agent-tool-policy set ${JSON.stringify(policy)}`,
    );
    await new Promise((resolveTick) => setImmediate(resolveTick));
    harness.assertNoPendingFauxResponses();
  }

  const turnEvents = await runScriptedToolTurn(harness);
  const toolResult = latestToolResult(harness.session, 'spike_echo');
  const output = toolResult === undefined ? '' : messageText(toolResult);
  check(
    turnEvents.some(
      (event) =>
        event.type === 'tool_execution_start' &&
        event.toolName === 'spike_echo',
    ),
    `${name} captured the real spike_echo tool event`,
  );
  if (expectedExecuted) {
    check(
      invocations.length === 1,
      `${name} executed spike_echo through the real runtime`,
    );
    check(
      toolResult !== undefined &&
        toolResult.isError === false &&
        output.includes('echo-ok'),
      `${name} returned the structured spike_echo result`,
    );
  } else {
    check(invocations.length === 0, `${name} kept spike_echo blocked`);
    check(
      toolResult !== undefined && output.includes(expectedReason),
      `${name} surfaced block reason: ${expectedReason}`,
    );
  }
  harness.assertNoPendingFauxResponses();
  harness.assertFauxNetworkIdentity();
}

async function runCorruptStateProbe({ invocations, registerCleanup, check }) {
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);

  const sessionA = await createIsolatedSession({
    isolation,
    storage: 'file',
    additionalExtensionPaths: [TOOL_POLICY_EXTENSION_PATH],
    expectedExtensionPath: TOOL_POLICY_EXTENSION_PATH,
    customTools: [createEchoTool(invocations)],
  });
  let sessionADisposed = false;
  const disposeSessionA = () => {
    if (!sessionADisposed) {
      sessionA.session.dispose();
      sessionADisposed = true;
    }
  };
  registerCleanup(disposeSessionA);
  check(sessionA.assertSessionStorage(), 'P5 Session A is file-backed');

  await runScriptedTurn(
    sessionA,
    'Warm up the file-backed tool-policy session.',
    [fauxAssistantMessage(fauxText('Warm-up complete.'))],
  );
  sessionA.assertNoPendingFauxResponses();
  sessionA.assertFauxNetworkIdentity();

  sessionA.sessionManager.appendCustomEntry('agent-tool-policy-state', {
    schemaVersion: 999,
    policy: {
      default: 'allow',
      allow: [],
      deny: [],
      requiresApproval: [],
    },
  });
  const sessionFile = sessionA.sessionFile;
  const corruptEntry = stateEntriesFor(
    sessionA.sessionManager,
    'agent-tool-policy-state',
  ).at(-1);
  check(
    typeof sessionFile === 'string',
    'P5 Session A exposed its flushed session file',
  );
  check(
    corruptEntry?.data?.schemaVersion === 999,
    'P5 appended a semantically invalid adapter state entry',
  );
  if (typeof sessionFile !== 'string') {
    return false;
  }
  disposeSessionA();

  const resumeManager = SessionManager.open(sessionFile);
  const sessionB = await createIsolatedSession({
    isolation,
    storage: 'file',
    sessionManager: resumeManager,
    additionalExtensionPaths: [TOOL_POLICY_EXTENSION_PATH],
    expectedExtensionPath: TOOL_POLICY_EXTENSION_PATH,
    customTools: [createEchoTool(invocations)],
  });
  registerCleanup(() => sessionB.session.dispose());
  check(sessionB.assertSessionStorage(), 'P5 Session B is file-backed');
  check(
    sessionB.sessionFile === sessionFile,
    'P5 Session B reopened Session A file',
  );

  await runScriptedToolTurn(sessionB);
  const toolResult = latestToolResult(sessionB.session, 'spike_echo');
  const output = toolResult === undefined ? '' : messageText(toolResult);
  check(
    invocations.length === 0,
    'P5 corrupt-state fail-closed never executed spike_echo',
  );
  check(
    toolResult !== undefined && output.includes(CORRUPT_BLOCK_REASON),
    `P5 corrupt-state surfaced the exact block reason: ${CORRUPT_BLOCK_REASON}`,
  );
  sessionB.assertNoPendingFauxResponses();
  sessionB.assertFauxNetworkIdentity();
  return true;
}

export const name = 'agent-tool-policy-pi';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const invocations = [];

  try {
    await runConfiguredCase({
      name: 'P1 unconfigured',
      policy: null,
      expectedReason: 'no policy configured; tool call blocked',
      expectedExecuted: false,
      invocations,
      registerCleanup,
      check,
    });
    invocations.length = 0;

    await runConfiguredCase({
      name: 'P2 allow',
      policy: POLICY_ALLOW,
      expectedReason: null,
      expectedExecuted: true,
      invocations,
      registerCleanup,
      check,
    });
    invocations.length = 0;

    await runConfiguredCase({
      name: 'P3 deny',
      policy: POLICY_DENY,
      expectedReason: 'tool call denied by tool policy',
      expectedExecuted: false,
      invocations,
      registerCleanup,
      check,
    });
    invocations.length = 0;

    await runConfiguredCase({
      name: 'P4 requires approval + headless',
      policy: POLICY_APPROVAL,
      expectedReason: 'requires approval, but no UI available',
      expectedExecuted: false,
      invocations,
      registerCleanup,
      check,
    });
    invocations.length = 0;

    const corruptStateVerified = await runCorruptStateProbe({
      invocations,
      registerCleanup,
      check,
    });
    if (result.status === 'fail' || !corruptStateVerified) {
      return { status: 'fail', reason: 'tool-policy assertions failed' };
    }
    return {
      status: 'pass',
      reason: 'file-backed corrupt-state fail-closed verified',
    };
  } finally {
    await cleanupAll();
  }
}
