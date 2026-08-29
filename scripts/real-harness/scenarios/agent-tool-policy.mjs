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
  createIsolatedSession,
  makeIsolation,
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

async function runScriptedToolTurn(harness) {
  const start = harness.events.length;
  harness.faux.setResponses([
    fauxAssistantMessage([
      fauxText('Trying the tool.'),
      fauxToolCall('spike_echo', {}),
    ]),
    fauxAssistantMessage(fauxText('Tool turn complete.')),
  ]);
  const turnFinished = harness.armAgentEndWaiter();
  await harness.session.prompt('Run the spike echo tool.');
  await turnFinished;
  return harness.events.slice(start);
}

function caseOutput(harness, turnEvents) {
  return `${JSON.stringify(harness.sessionManager.getBranch())}\n${turnEvents.join('\n')}`;
}

async function runConfiguredCase({
  name,
  policy,
  expectedReason,
  expectedExecuted,
  invocations,
  check,
}) {
  const isolation = makeIsolation();
  let harness;
  try {
    harness = await createIsolatedSession({
      isolation,
      additionalExtensionPaths: [TOOL_POLICY_EXTENSION_PATH],
      expectedExtensionPath: TOOL_POLICY_EXTENSION_PATH,
      customTools: [createEchoTool(invocations)],
    });
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
    const output = caseOutput(harness, turnEvents);
    if (expectedExecuted) {
      check(
        invocations.length === 1,
        `${name} executed spike_echo through the real runtime`,
      );
      check(
        !output.includes('tool call blocked'),
        `${name} did not surface a block reason`,
      );
    } else {
      check(invocations.length === 0, `${name} kept spike_echo blocked`);
      check(
        output.includes(expectedReason),
        `${name} surfaced block reason: ${expectedReason}`,
      );
    }
    harness.assertNoPendingFauxResponses();
    harness.assertFauxNetworkIdentity();
  } finally {
    harness?.session.dispose();
    isolation.cleanup();
  }
}

async function runCorruptStateProbe({ invocations, check }) {
  const isolation = makeIsolation();
  let harness;
  try {
    const sessionManager = SessionManager.inMemory(isolation.workDir);
    sessionManager.appendCustomEntry('agent-tool-policy-state', {
      schemaVersion: 999,
      policy: POLICY_ALLOW,
    });

    harness = await createIsolatedSession({
      isolation,
      sessionManager,
      additionalExtensionPaths: [TOOL_POLICY_EXTENSION_PATH],
      expectedExtensionPath: TOOL_POLICY_EXTENSION_PATH,
      customTools: [createEchoTool(invocations)],
    });
    check(
      harness.session.sessionFile === undefined,
      'P5 corrupt-state probe stayed in-memory',
    );

    const turnEvents = await runScriptedToolTurn(harness);
    const output = caseOutput(harness, turnEvents);
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
  } finally {
    harness?.session.dispose();
    isolation.cleanup();
  }
}

export const name = 'agent-tool-policy-pi';

export async function run() {
  const { check, result } = createCheck();
  const invocations = [];

  await runConfiguredCase({
    name: 'P1 unconfigured',
    policy: null,
    expectedReason: 'no policy configured; tool call blocked',
    expectedExecuted: false,
    invocations,
    check,
  });
  invocations.length = 0;

  await runConfiguredCase({
    name: 'P2 allow',
    policy: POLICY_ALLOW,
    expectedReason: null,
    expectedExecuted: true,
    invocations,
    check,
  });
  invocations.length = 0;

  await runConfiguredCase({
    name: 'P3 deny',
    policy: POLICY_DENY,
    expectedReason: 'tool call denied by tool policy',
    expectedExecuted: false,
    invocations,
    check,
  });
  invocations.length = 0;

  await runConfiguredCase({
    name: 'P4 requires approval + headless',
    policy: POLICY_APPROVAL,
    expectedReason: 'requires approval, but no UI available',
    expectedExecuted: false,
    invocations,
    check,
  });
  invocations.length = 0;

  const corruptStateStatus = await runCorruptStateProbe({ invocations, check });
  if (result.status === 'fail' || corruptStateStatus === 'failed') {
    return { status: 'fail', reason: 'tool-policy assertions failed' };
  }
  if (corruptStateStatus === 'supported') {
    return { status: 'pass', reason: 'corrupt-state: SUPPORTED' };
  }
  return { status: 'pass', reason: 'corrupt-state: FAKE-ONLY' };
}
