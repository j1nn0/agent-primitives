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
  const sessionManager = SessionManager.inMemory(isolation.workDir);
  sessionManager.appendCustomEntry('agent-tool-policy-state', {
    schemaVersion: 999,
    policy: POLICY_ALLOW,
  });

  const harness = await createIsolatedSession({
    isolation,
    sessionManager,
    additionalExtensionPaths: [TOOL_POLICY_EXTENSION_PATH],
    expectedExtensionPath: TOOL_POLICY_EXTENSION_PATH,
    customTools: [createEchoTool(invocations)],
  });
  registerCleanup(() => harness.session.dispose());
  check(
    harness.session.sessionFile === undefined,
    'P5 corrupt-state probe stayed in-memory',
  );

  await runScriptedToolTurn(harness);
  const toolResult = latestToolResult(harness.session, 'spike_echo');
  const output = toolResult === undefined ? '' : messageText(toolResult);
  const corruptReason = 'policy configuration is invalid or corrupted';
  const blocked = output.includes('tool call blocked');
  check(invocations.length === 0, 'P5 corrupt-state probe kept spike_echo blocked');
  harness.assertNoPendingFauxResponses();
  harness.assertFauxNetworkIdentity();

  if (output.includes(corruptReason)) {
    check(true, 'P5 corrupt-state reason surfaced from the real runtime');
    return 'supported';
  }
  if (!blocked) {
    check(false, 'P5 corrupt-state probe failed closed without a block reason');
    return 'failed';
  }
  return 'unsupported';
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

    const corruptStateStatus = await runCorruptStateProbe({
      invocations,
      registerCleanup,
      check,
    });
    if (result.status === 'fail' || corruptStateStatus === 'failed') {
      return { status: 'fail', reason: 'tool-policy assertions failed' };
    }
    if (corruptStateStatus === 'supported') {
      return { status: 'pass', reason: 'corrupt-state: SUPPORTED' };
    }
    return { status: 'pass', reason: 'corrupt-state: FAKE-ONLY' };
  } finally {
    await cleanupAll();
  }
}
