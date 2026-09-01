/* global console, process */

import { SessionManager } from '@earendil-works/pi-coding-agent';
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

const PROBE_EXTENSION_PATH = resolve(import.meta.dirname, '../fixtures/probe-extension.mjs');
const PROBE_PROFILE = 'blocker';
const SUPERVISOR_CONFIG_CUSTOM_TYPE = 'agent-supervisor-config';
const PROBE_FEATURE_ID = 'probe-blocker';
const UNKNOWN_FEATURE_ID = 'probe-not-registered';
const TARGET_TOOL_NAME = 'supervisor_harness_mode_command_target';
const TARGET_TOOL_RESULT = 'mode-command-target-executed';
const BLOCK_REASON = 'probe-blocker proposal won at the tool-call boundary';

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function supervisorConfigEntries(sessionManager) {
  return sessionManager.getBranch().filter(
    (entry) =>
      entry?.type === 'custom' && entry.customType === SUPERVISOR_CONFIG_CUSTOM_TYPE,
  );
}

function parseStatus(output, label) {
  const globalConfigMatch = /^Global config: (\S+)$/mu.exec(output);
  const requestedGlobalMatch = /^Requested global mode: (\S+)$/mu.exec(output);
  const effectiveGlobalMatch = /^Effective global mode: (\S+)$/mu.exec(output);
  const featureLine = output
    .split('\n')
    .find((line) => line.startsWith(`- ${PROBE_FEATURE_ID}:`));
  const featureMatch =
    featureLine === undefined
      ? undefined
      : /requested=([^,]+), effective=([^,]+), runtime=([^,]+), status=([^\s]+)(?: reason=(\S+))?/u.exec(
          featureLine,
        );

  if (
    globalConfigMatch === null ||
    requestedGlobalMatch === null ||
    effectiveGlobalMatch === null ||
    featureLine === undefined ||
    featureMatch === undefined
  ) {
    throw new Error(`status command omitted required fields at ${label}`);
  }

  return {
    output,
    globalConfig: globalConfigMatch[1],
    requestedGlobalMode: requestedGlobalMatch[1],
    effectiveGlobalMode: effectiveGlobalMatch[1],
    feature: {
      line: featureLine,
      requestedMode: featureMatch[1],
      effectiveMode: featureMatch[2],
      runtimeMode: featureMatch[3],
      status: featureMatch[4],
      reason: featureMatch[5] ?? null,
    },
  };
}

function latestToolResult(session) {
  return session.messages
    .filter(
      (message) =>
        message?.role === 'toolResult' && message.toolName === TARGET_TOOL_NAME,
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

function countEvents(events, type) {
  return events.filter((event) => event?.type === type).length;
}

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Mode Command Target',
    description: 'Deterministic target tool for the Supervisor mode command runtime probe.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(true);
      return {
        content: [{ type: 'text', text: TARGET_TOOL_RESULT }],
      };
    },
  };
}

function createSeededSessionManager(isolation, config) {
  const sessionManager = SessionManager.inMemory(isolation.workDir);
  if (typeof sessionManager.appendCustomEntry !== 'function') {
    throw new Error('SessionManager.appendCustomEntry is not a public API');
  }
  const entryId = sessionManager.appendCustomEntry(SUPERVISOR_CONFIG_CUSTOM_TYPE, config);
  if (typeof entryId !== 'string') {
    throw new Error('SessionManager.appendCustomEntry did not return an entry id');
  }
  return sessionManager;
}

async function createCaseHarness(cleanup, seedConfig, executions = []) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const sessionManager =
    seedConfig === undefined ? undefined : createSeededSessionManager(isolation, seedConfig);
  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    sessionManager,
    additionalExtensionPaths: [PROBE_EXTENSION_PATH],
    expectedExtensionPath: PROBE_EXTENSION_PATH,
    customTools: [createTargetTool(executions)],
  });
  cleanup.registerCleanup(harness.cleanup);
  return harness;
}

async function runCommand(harness, command) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt(command);
  return {
    callsBefore,
    callsAfter: harness.faux.state.callCount,
    messages: harness.uiMessages.slice(messageStart),
    text: notifyText(harness.uiMessages.slice(messageStart)),
    configEntries: supervisorConfigEntries(harness.sessionManager),
  };
}

async function captureStatus(harness, label) {
  const command = await runCommand(harness, '/agent-supervisor status');
  if (command.callsAfter !== command.callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  if (harness.faux.getPendingResponseCount() !== 0) {
    throw new Error(`status command left faux responses pending at ${label}`);
  }
  return parseStatus(command.text, label);
}

async function runTargetTurn(harness, prompt, callId, completionText) {
  const callsBefore = harness.faux.state.callCount;
  const events = await runScriptedTurn(harness, prompt, [
    fauxAssistantMessage(fauxToolCall(TARGET_TOOL_NAME, {}, { id: callId })),
    fauxAssistantMessage(fauxText(completionText)),
  ]);
  if (harness.faux.state.callCount !== callsBefore + 2) {
    throw new Error(`scripted mode command turn did not consume exactly two faux responses (${callId})`);
  }
  harness.assertNoPendingFauxResponses();
  return {
    events,
    result: latestToolResult(harness.session),
  };
}

function assertActiveAutonomous(status) {
  return (
    status.globalConfig === 'valid' &&
    status.requestedGlobalMode === 'autonomous' &&
    status.effectiveGlobalMode === 'autonomous' &&
    status.feature.line.includes('default=autonomous') &&
    status.feature.requestedMode === 'autonomous' &&
    status.feature.effectiveMode === 'autonomous' &&
    status.feature.runtimeMode === 'autonomous' &&
    status.feature.status === 'active'
  );
}

async function runDefaultRuntimeCase(check, cleanup) {
  const executions = [];
  const harness = await createCaseHarness(cleanup, undefined, executions);
  const extensions = harness.extensionsResult.extensions;
  const probeExtension = extensions[0];
  check(
    extensions.length === 1 && probeExtension?.resolvedPath === PROBE_EXTENSION_PATH,
    'default case loaded exactly the blocker probe extension fixture',
  );
  check(
    harness.extensionsResult.errors.length === 0 &&
      probeExtension?.commands.has('agent-supervisor'),
    'default case exposed the public agent-supervisor command without load errors',
  );
  check(
    harness.session.getAllTools().some(
      (tool) =>
        tool.name === TARGET_TOOL_NAME &&
        tool.sourceInfo?.source === 'sdk' &&
        tool.sourceInfo.path === `<sdk:${TARGET_TOOL_NAME}>`,
    ),
    'default case registered the target tool as an SDK-owned public tool',
  );

  const initialStatus = await captureStatus(harness, 'default case initial status');
  check(
    initialStatus.output.includes('Registered features: 1') &&
      assertActiveAutonomous(initialStatus),
    'default case starts with the blocker active at its autonomous descriptor default',
  );
  check(
    supervisorConfigEntries(harness.sessionManager).length === 0,
    'default case starts without an agent-supervisor-config entry',
  );

  const initialBlock = await runTargetTurn(
    harness,
    'Call the Supervisor mode command target before changing its mode.',
    'mode-command-initial-block',
    'initial mode command turn complete',
  );
  check(
    executions.length === 0 &&
      initialBlock.result?.isError === true &&
      messageText(initialBlock.result).includes(BLOCK_REASON) &&
      countEvents(initialBlock.events, 'tool_execution_start') === 1,
    'autonomous descriptor-default behavior blocked the initial real target tool call',
  );

  const observeCommand = await runCommand(
    harness,
    `/agent-supervisor feature ${PROBE_FEATURE_ID} observe`,
  );
  check(
    observeCommand.callsAfter === observeCommand.callsBefore &&
      observeCommand.text.includes(
        `Agent Supervisor: feature ${PROBE_FEATURE_ID} set to observe.`,
      ) &&
      observeCommand.messages.every(
        (entry) => entry.type !== 'error' && entry.type !== 'warning',
      ) &&
      observeCommand.configEntries.length === 1,
    'feature observe changed the mode without a model call and appended one config entry',
  );

  const observeStatus = await captureStatus(harness, 'default case observe status');
  check(
    observeStatus.globalConfig === 'valid' &&
      observeStatus.requestedGlobalMode === 'autonomous' &&
      observeStatus.effectiveGlobalMode === 'autonomous' &&
      observeStatus.feature.requestedMode === 'observe' &&
      observeStatus.feature.effectiveMode === 'observe' &&
      observeStatus.feature.runtimeMode === 'observe' &&
      observeStatus.feature.status === 'active',
    'public status reported the blocker feature in observe mode',
  );

  const observeTurn = await runTargetTurn(
    harness,
    'Call the Supervisor mode command target while its feature is observing.',
    'mode-command-observe',
    'observe mode command turn complete',
  );
  check(
    executions.length === 1 &&
      observeTurn.result?.isError === false &&
      messageText(observeTurn.result).includes(TARGET_TOOL_RESULT) &&
      countEvents(observeTurn.events, 'tool_execution_start') === 1,
    'observe mode allowed the real target tool call to execute',
  );

  const defaultCommand = await runCommand(
    harness,
    `/agent-supervisor feature ${PROBE_FEATURE_ID} default`,
  );
  check(
    defaultCommand.callsAfter === defaultCommand.callsBefore &&
      defaultCommand.text.includes(
        `Agent Supervisor: feature ${PROBE_FEATURE_ID} restored to its default mode.`,
      ) &&
      defaultCommand.configEntries.length === 2,
    'feature default caused zero model calls and appended the restored config entry',
  );

  const defaultStatus = await captureStatus(harness, 'default case restored status');
  check(
    assertActiveAutonomous(defaultStatus),
    'public status showed default restored autonomous runtime behavior',
  );

  const restoredBlock = await runTargetTurn(
    harness,
    'Call the Supervisor mode command target after restoring its default mode.',
    'mode-command-restored-block',
    'restored default mode command turn complete',
  );
  check(
    executions.length === 1 &&
      restoredBlock.result?.isError === true &&
      messageText(restoredBlock.result).includes(BLOCK_REASON) &&
      countEvents(restoredBlock.events, 'tool_execution_start') === 1,
    'restored autonomous default blocked the later real target tool call again',
  );

  console.log(
    `  TRACE mode-command-runtime default case: initial=blocked, observe=executed, restored=blocked; config entries=${supervisorConfigEntries(harness.sessionManager).length}`,
  );
  harness.assertNoPendingFauxResponses();
  harness.assertNoAuthCredentials();
}

async function runUnknownFeatureCase(check, cleanup) {
  const harness = await createCaseHarness(cleanup);
  const initialStatus = await captureStatus(harness, 'unknown feature initial status');
  check(
    initialStatus.output.includes('Registered features: 1') &&
      assertActiveAutonomous(initialStatus),
    'unknown feature case starts with a valid autonomous blocker status',
  );
  check(
    supervisorConfigEntries(harness.sessionManager).length === 0,
    'unknown feature case starts without an agent-supervisor-config entry',
  );

  const refusal = await runCommand(
    harness,
    `/agent-supervisor feature ${UNKNOWN_FEATURE_ID} observe`,
  );
  check(
    refusal.callsAfter === refusal.callsBefore &&
      refusal.text.includes('Agent Supervisor: that feature is not registered.') &&
      refusal.messages.some((entry) => entry.type === 'warning') &&
      refusal.configEntries.length === 0,
    'unregistered feature command was refused with a warning and wrote no config entry',
  );

  const finalStatus = await captureStatus(harness, 'unknown feature final status');
  check(
    finalStatus.output.includes('Registered features: 1') &&
      !finalStatus.output.includes(UNKNOWN_FEATURE_ID) &&
      assertActiveAutonomous(finalStatus) &&
      supervisorConfigEntries(harness.sessionManager).length === 0,
    'public status remained valid and unchanged after the unregistered feature refusal',
  );
  harness.assertNoPendingFauxResponses();
  harness.assertNoAuthCredentials();
}

async function runCorruptRepairCase(check, cleanup) {
  const corruptConfig = {
    schemaVersion: 1,
    mode: 'autonomous',
    features: {},
    unexpectedTopLevelKey: 'corrupt',
  };
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const sessionManager = createSeededSessionManager(isolation, corruptConfig);
  check(
    supervisorConfigEntries(sessionManager).length === 1,
    'corrupt case seeded one top-level agent-supervisor-config entry before session creation',
  );
  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    sessionManager,
    additionalExtensionPaths: [PROBE_EXTENSION_PATH],
    expectedExtensionPath: PROBE_EXTENSION_PATH,
  });
  cleanup.registerCleanup(harness.cleanup);

  const corruptStatus = await captureStatus(harness, 'corrupt initial status');
  check(
    corruptStatus.globalConfig === 'degraded' &&
      corruptStatus.requestedGlobalMode === 'none' &&
      corruptStatus.effectiveGlobalMode === 'observe' &&
      corruptStatus.feature.requestedMode === 'autonomous' &&
      corruptStatus.feature.effectiveMode === 'observe' &&
      corruptStatus.feature.runtimeMode === 'observe' &&
      corruptStatus.feature.status === 'active',
    'public status exposed the corrupt top-level config as a degraded observe ceiling',
  );

  const featureRefusal = await runCommand(
    harness,
    `/agent-supervisor feature ${PROBE_FEATURE_ID} observe`,
  );
  check(
    featureRefusal.callsAfter === featureRefusal.callsBefore &&
      featureRefusal.text.includes(
        'Agent Supervisor: repair the global mode before changing a feature.',
      ) &&
      featureRefusal.messages.some((entry) => entry.type === 'warning') &&
      featureRefusal.configEntries.length === 1,
    'feature command on corrupt config was refused with a repair warning and wrote no entry',
  );

  const stillCorruptStatus = await captureStatus(harness, 'corrupt refusal status');
  check(
    stillCorruptStatus.globalConfig === 'degraded' &&
      stillCorruptStatus.effectiveGlobalMode === 'observe' &&
      supervisorConfigEntries(harness.sessionManager).length === 1,
    'public status and config count remained degraded and unchanged after the refusal',
  );

  const repairCommand = await runCommand(harness, '/agent-supervisor mode autonomous');
  check(
    repairCommand.callsAfter === repairCommand.callsBefore &&
      repairCommand.text.includes('Agent Supervisor: global mode set to autonomous.') &&
      repairCommand.configEntries.length === 2,
    'explicit global mode repair caused zero model calls and appended one valid config entry',
  );

  const repairedStatus = await captureStatus(harness, 'repaired status');
  check(
    assertActiveAutonomous(repairedStatus),
    'public status reported a valid autonomous config after global repair',
  );
  check(
    supervisorConfigEntries(harness.sessionManager).length === 2,
    'global repair left the corrupt history and added exactly one valid config entry',
  );

  const noOpCommand = await runCommand(harness, '/agent-supervisor mode autonomous');
  check(
    noOpCommand.callsAfter === noOpCommand.callsBefore &&
      noOpCommand.text.includes('Agent Supervisor: global mode is already autonomous.') &&
      noOpCommand.configEntries.length === 2,
    'global mode change to the already effective value was a no-op with no new config entry',
  );

  const finalStatus = await captureStatus(harness, 'repair final status');
  check(
    assertActiveAutonomous(finalStatus) &&
      supervisorConfigEntries(harness.sessionManager).length === 2,
    'public status remained valid after the global mode no-op',
  );

  console.log(
    `  TRACE mode-command-runtime corrupt case: refusal entries=1, repaired entries=2, no-op entries=2`,
  );
  harness.assertNoPendingFauxResponses();
  harness.assertNoAuthCredentials();
}

export const name = 'mode-command-runtime';

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

  try {
    await runDefaultRuntimeCase(check, cleanup);
    await runUnknownFeatureCase(check, cleanup);
    await runCorruptRepairCase(check, cleanup);

    return result.status === 'pass'
      ? { status: 'pass', reason: 'mode command runtime and safety semantics verified' }
      : { status: 'fail', reason: 'mode command runtime assertions failed' };
  } finally {
    await cleanupAll();
  }
}
