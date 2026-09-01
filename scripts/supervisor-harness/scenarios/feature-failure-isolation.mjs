/* global console, process */

import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const PROBE_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/probe-extension.mjs',
);
const PROBE_PROFILE = 'failure-isolation';
const FAILURE_TRACE_ENV = 'SUPERVISOR_HARNESS_FAILURE_TRACE_PATH';
const FAILURE_FEATURE_ID = 'probe-failing-feature';
const HEALTHY_FEATURE_ID = 'probe-healthy-sibling';
const TARGET_TOOL_NAME = 'supervisor_harness_failure_isolation_target';
const FIRST_TOOL_CALL_ID = 'failure-isolation-first';
const LATER_TOOL_CALL_ID = 'failure-isolation-later';

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Failure Isolation Target',
    description: 'Deterministic target tool for the Supervisor feature failure probe.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(true);
      return {
        content: [{ type: 'text', text: 'failure-isolation-target-executed' }],
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

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function countEvents(events, type) {
  return events.filter((event) => event?.type === type).length;
}

function readFailureTrace(path) {
  const content = readFileSync(path, 'utf8').trim();
  return content.length === 0
    ? []
    : content.split('\n').map((line) => JSON.parse(line));
}

function parseFeatureStatus(output, featureId, label) {
  const line = output
    .split('\n')
    .find((entry) => entry.startsWith(`- ${featureId}:`));
  if (line === undefined) {
    throw new Error(`status command omitted ${featureId} at ${label}`);
  }
  const match = /requested=([^,]+), effective=([^,]+), runtime=([^,]+), status=([^\s]+)(?: reason=(\S+))?/u.exec(line);
  if (match === null) {
    throw new Error(`status command omitted runtime fields for ${featureId} at ${label}`);
  }
  return {
    line,
    requestedMode: match[1],
    effectiveMode: match[2],
    runtimeMode: match[3],
    status: match[4],
    reason: match[5] ?? null,
  };
}

async function captureStatus(harness, label) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  if (harness.faux.state.callCount !== callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  const output = notifyText(harness.uiMessages.slice(messageStart));
  return {
    output,
    failure: parseFeatureStatus(output, FAILURE_FEATURE_ID, label),
    healthy: parseFeatureStatus(output, HEALTHY_FEATURE_ID, label),
  };
}

async function runProbeTurn(harness, callId) {
  return runScriptedTurn(
    harness,
    'Call the Supervisor feature failure isolation target tool.',
    [
      fauxAssistantMessage(
        fauxToolCall(TARGET_TOOL_NAME, {}, { id: callId }),
      ),
      fauxAssistantMessage(fauxText('failure isolation turn complete')),
    ],
  );
}

function isActiveAutonomous(status) {
  return (
    status.effectiveMode === 'autonomous' &&
    status.runtimeMode === 'autonomous' &&
    status.status === 'active'
  );
}

export const name = 'feature-failure-isolation';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const previousProfile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
  const previousTracePath = process.env[FAILURE_TRACE_ENV];
  const isolation = makeIsolation();
  const tracePath = join(isolation.base, 'feature-failure-isolation.jsonl');
  registerCleanup(isolation.cleanup);
  process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = PROBE_PROFILE;
  process.env[FAILURE_TRACE_ENV] = tracePath;
  registerCleanup(() => {
    if (previousProfile === undefined) {
      delete process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
    } else {
      process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = previousProfile;
    }
    if (previousTracePath === undefined) {
      delete process.env[FAILURE_TRACE_ENV];
    } else {
      process.env[FAILURE_TRACE_ENV] = previousTracePath;
    }
    rmSync(tracePath, { force: true });
  });

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
      'loaded exactly the feature failure isolation probe extension fixture',
    );
    check(
      harness.extensionsResult.errors.length === 0,
      'feature failure isolation probe extension loading returned no errors',
    );
    check(
      probeExtension?.commands.has('agent-supervisor'),
      'probe extension registered the public agent-supervisor command',
    );

    const targetTool = harness.session
      .getAllTools()
      .find((tool) => tool.name === TARGET_TOOL_NAME);
    check(
      targetTool?.sourceInfo?.source === 'sdk' &&
        targetTool.sourceInfo.path === `<sdk:${TARGET_TOOL_NAME}>`,
      'feature failure isolation target tool is present as an SDK-owned tool',
    );

    const initialStatus = await captureStatus(harness, 'initial status');
    check(
      initialStatus.output.includes('Agent Supervisor') &&
        initialStatus.output.includes('Registered features: 2') &&
        initialStatus.output.includes('Kernel health: healthy'),
      'initial public status shows a functioning Supervisor with two features',
    );
    check(
      isActiveAutonomous(initialStatus.failure) &&
        isActiveAutonomous(initialStatus.healthy),
      'both probe features start active with autonomous effective modes',
    );

    const callsBeforeFirst = harness.faux.state.callCount;
    const firstEvents = await runProbeTurn(harness, FIRST_TOOL_CALL_ID);
    const firstResult = latestToolResult(harness.session);
    const firstOutput = messageText(firstResult);
    check(
      executions.length === 1 &&
        firstResult?.isError === false &&
        firstOutput.includes('failure-isolation-target-executed'),
      'the target tool executed successfully despite the throwing feature',
    );
    check(
      countEvents(firstEvents, 'agent_start') === 1 &&
        countEvents(firstEvents, 'agent_end') === 1 &&
      countEvents(firstEvents, 'turn_end') >= 1,
      'the first scripted agent turn reached its normal lifecycle end',
    );
    check(
      harness.faux.state.callCount === callsBeforeFirst + 2,
      'the first turn consumed exactly its two scripted faux responses',
    );
    harness.assertNoPendingFauxResponses();

    const statusAfterFailure = await captureStatus(harness, 'after first failure');
    console.log(
      `  TRACE feature-failure-isolation after failure: ${statusAfterFailure.failure.line}`,
    );
    check(
      statusAfterFailure.failure.status === 'quarantined' &&
        statusAfterFailure.failure.reason === 'observation-failed' &&
        statusAfterFailure.failure.runtimeMode === 'unavailable',
      'public status quarantined the failed feature with observation-failed reason',
    );
    check(
      isActiveAutonomous(statusAfterFailure.healthy),
      'public status kept the healthy sibling active after the failure',
    );
    check(
      statusAfterFailure.output.includes('Kernel health: healthy'),
      'public status still reports a healthy Supervisor after the failure',
    );

    const traceAfterFailure = readFailureTrace(tracePath);
    console.log(
      `  TRACE feature-failure-isolation first dispatch: ${JSON.stringify(traceAfterFailure)}`,
    );
    check(
      traceAfterFailure.length === 2 &&
        traceAfterFailure[0]?.featureId === FAILURE_FEATURE_ID &&
        traceAfterFailure[0]?.action === 'throw' &&
        traceAfterFailure[0]?.toolCallId === FIRST_TOOL_CALL_ID &&
        traceAfterFailure[1]?.featureId === HEALTHY_FEATURE_ID &&
        traceAfterFailure[1]?.action === 'healthy-observed' &&
        traceAfterFailure[1]?.toolCallId === FIRST_TOOL_CALL_ID,
      'the throwing feature failed first while its healthy sibling still observed the same call',
    );

    const callsBeforeLater = harness.faux.state.callCount;
    const laterEvents = await runProbeTurn(harness, LATER_TOOL_CALL_ID);
    const laterResult = latestToolResult(harness.session);
    const laterOutput = messageText(laterResult);
    check(
      executions.length === 2 &&
        laterResult?.isError === false &&
        laterOutput.includes('failure-isolation-target-executed'),
      'the target tool still executed successfully on a later observation',
    );
    check(
      countEvents(laterEvents, 'agent_start') === 1 &&
        countEvents(laterEvents, 'agent_end') === 1 &&
      countEvents(laterEvents, 'turn_end') >= 1,
      'the later scripted agent turn reached its normal lifecycle end',
    );
    check(
      harness.faux.state.callCount === callsBeforeLater + 2,
      'the later turn consumed exactly its two scripted faux responses',
    );
    harness.assertNoPendingFauxResponses();

    const finalStatus = await captureStatus(harness, 'after later observation');
    const finalTrace = readFailureTrace(tracePath);
    const healthyTrace = finalTrace.filter(
      (entry) =>
        entry?.featureId === HEALTHY_FEATURE_ID &&
        entry?.action === 'healthy-observed',
    );
    const failedTrace = finalTrace.filter(
      (entry) => entry?.featureId === FAILURE_FEATURE_ID,
    );
    console.log(
      `  TRACE feature-failure-isolation final status: ${finalStatus.failure.line}`,
    );
    console.log(
      `  TRACE feature-failure-isolation sibling observations after failure: ${healthyTrace.length}`,
    );
    check(
      failedTrace.length === 1 && failedTrace[0]?.action === 'throw' &&
        !finalTrace.some((entry) => entry?.action === 'would-intervene'),
      'the failed feature performed no later work or intervention after quarantine',
    );
    check(
      healthyTrace.length === 2 &&
        healthyTrace[1]?.toolCallId === LATER_TOOL_CALL_ID,
      'the healthy sibling kept producing its observable effect after the failure',
    );
    check(
      finalStatus.failure.status === 'quarantined' &&
        finalStatus.failure.reason === 'observation-failed' &&
        isActiveAutonomous(finalStatus.healthy),
      'final public status preserves the quarantine and active sibling states',
    );
    check(
      finalStatus.output.includes('Agent Supervisor') &&
        finalStatus.output.includes('Kernel health: healthy'),
      'the public status command remained functional after the later observation',
    );

    harness.assertNoPendingFauxResponses();
    harness.assertNoAuthCredentials();

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: `feature failure isolation verified (${finalStatus.failure.status}, reason=${finalStatus.failure.reason}; sibling observations=${healthyTrace.length})`,
        }
      : { status: 'fail', reason: 'feature failure isolation assertions failed' };
  } finally {
    await cleanupAll();
  }
}
