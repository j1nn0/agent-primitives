/* global process */

import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
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
const PROBE_PROFILE = 'blocker';
const TARGET_TOOL_NAME = 'supervisor_harness_probe_target';
const BLOCK_REASON = 'probe-blocker proposal won at the tool-call boundary';
const CREATE_ISOLATION_REPORT = 'create-context-isolated';
const RUNTIME_ISOLATION_REPORT = 'runtime-context-isolated';

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Probe Target',
    description: 'Deterministic target tool for the Supervisor runtime probe.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(true);
      return {
        content: [{ type: 'text', text: 'probe-target-executed' }],
      };
    },
  };
}

function latestToolResult(session) {
  return session.messages
    .filter(
      (message) =>
        message?.role === 'toolResult' &&
        message.toolName === TARGET_TOOL_NAME,
    )
    .at(-1);
}

function messageText(message) {
  if (!Array.isArray(message?.content)) {
    return '';
  }
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .filter((text) => typeof text === 'string')
    .join('\n');
}

async function runProbeTurn(harness, callId) {
  return runScriptedTurn(
    harness,
    'Call the Supervisor harness probe target tool.',
    [
      fauxAssistantMessage(
        fauxToolCall(TARGET_TOOL_NAME, {}, { id: callId }),
      ),
      fauxAssistantMessage(fauxText('probe turn complete')),
    ],
  );
}

function countEvents(events, type) {
  return events.filter((event) => event?.type === type).length;
}

export const name = 'kernel-runtime-probe';

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
  const executions = [];

  try {
    const harness = await createIsolatedSession({
      isolation,
      storage: 'memory',
      additionalExtensionPaths: [PROBE_EXTENSION_PATH],
      expectedExtensionPath: PROBE_EXTENSION_PATH,
      customTools: [createTargetTool(executions)],
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
    check(
      probeExtension?.tools.size === 0,
      'probe supervisor extension registered zero tools',
    );

    const targetTool = harness.session
      .getAllTools()
      .find((tool) => tool.name === TARGET_TOOL_NAME);
    check(
      targetTool?.sourceInfo?.source === 'sdk' &&
        targetTool.sourceInfo.path === `<sdk:${TARGET_TOOL_NAME}>`,
      'harness custom target tool is present as an SDK-owned tool',
    );

    const autonomousEvents = await runProbeTurn(
      harness,
      'probe-autonomous-call',
    );
    const autonomousResult = latestToolResult(harness.session);
    const autonomousOutput = messageText(autonomousResult);
    check(
      executions.length === 0,
      'autonomous probe blocker prevented target tool execution',
    );
    check(
      autonomousResult?.isError === true &&
        autonomousOutput.includes(BLOCK_REASON) &&
        !autonomousOutput.includes('Tool execution was blocked'),
      'autonomous tool result carries the winning proposal reason',
    );
    check(
      autonomousOutput.includes(CREATE_ISOLATION_REPORT) &&
        autonomousOutput.includes(RUNTIME_ISOLATION_REPORT),
      'blocked proposal reports isolated feature create and runtime contexts',
    );
    check(
      countEvents(autonomousEvents, 'tool_execution_start') === 1,
      'autonomous probe observed one target tool call through the runtime',
    );
    check(
      harness.faux.getPendingResponseCount() === 0,
      'autonomous probe consumed all scripted faux responses',
    );

    const modeCommandCalls = harness.faux.state.callCount;
    await harness.session.prompt(
      '/agent-supervisor feature probe-blocker observe',
    );
    check(
      harness.faux.state.callCount === modeCommandCalls,
      'switching the probe feature to observe caused zero model calls',
    );

    const observeExecutions = executions.length;
    const observeNotifyCount = harness.uiMessages.length;
    const observeCalls = harness.faux.state.callCount;
    const observeEvents = await runProbeTurn(
      harness,
      'probe-observe-call',
    );
    const observeResult = latestToolResult(harness.session);
    const observeOutput = messageText(observeResult);
    check(
      executions.length === observeExecutions + 1,
      'observe-mode probe blocker allowed target tool execution',
    );
    check(
      observeResult?.isError === false &&
        observeOutput.includes('probe-target-executed'),
      'observe-mode target tool result is successful',
    );
    check(
      harness.uiMessages.length === observeNotifyCount &&
        harness.faux.state.callCount === observeCalls + 2 &&
        countEvents(observeEvents, 'agent_start') === 1 &&
        countEvents(observeEvents, 'agent_end') === 1,
      'observe-mode turn produced no Supervisor-originated action',
    );
    check(
      harness.faux.getPendingResponseCount() === 0,
      'observe-mode probe consumed all scripted faux responses',
    );
    harness.assertNoAuthCredentials();

    return result.status === 'pass'
      ? { status: 'pass', reason: 'Kernel runtime isolation and mode gating verified' }
      : { status: 'fail', reason: 'Kernel runtime probe assertions failed' };
  } finally {
    await cleanupAll();
  }
}
