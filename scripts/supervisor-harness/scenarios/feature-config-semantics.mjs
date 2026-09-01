/* global console, process */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

const PROBE_EXTENSION_PATH = resolve(import.meta.dirname, '../fixtures/probe-extension.mjs');
const PROBE_PROFILE = 'feature-config-semantics';
const CONFIG_TRACE_ENV = 'SUPERVISOR_HARNESS_CONFIG_SEMANTICS_TRACE_PATH';
const SUPERVISOR_CONFIG_CUSTOM_TYPE = 'agent-supervisor-config';
const VALIDATING_FEATURE_ID = 'probe-config-validating';
const HEALTHY_FEATURE_ID = 'probe-config-healthy';
const VALID_SETTINGS = Object.freeze({ flavor: 'accepted' });
const INVALID_SETTINGS = Object.freeze({ flavor: 'rejected' });
const TARGET_TOOL_NAME = 'supervisor_harness_feature_config_semantics_target';
const VALID_TOOL_CALL_ID = 'feature-config-semantics-valid';
const INVALID_TOOL_CALL_ID = 'feature-config-semantics-invalid';

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Feature Config Semantics Target',
    description: 'Deterministic target tool for the Supervisor config semantics probe.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(true);
      return {
        content: [{ type: 'text', text: 'feature-config-semantics-target-executed' }],
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
    validating: parseFeatureStatus(output, VALIDATING_FEATURE_ID, label),
    healthy: parseFeatureStatus(output, HEALTHY_FEATURE_ID, label),
  };
}

function isActiveAutonomous(status) {
  return (
    status.line.includes('default=autonomous') &&
    status.runtimeMode === 'autonomous' &&
    status.status === 'active'
  );
}

function readConfigTrace(path) {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, 'utf8').trim();
  return content.length === 0
    ? []
    : content.split('\n').map((line) => JSON.parse(line));
}

function supervisorConfigEntries(sessionManager) {
  return sessionManager.getBranch().filter(
    (entry) =>
      entry?.type === 'custom' &&
      entry.customType === SUPERVISOR_CONFIG_CUSTOM_TYPE,
  );
}

function createConfig(settings) {
  return {
    schemaVersion: 1,
    mode: 'autonomous',
    features: {
      [VALIDATING_FEATURE_ID]: { settings },
      [HEALTHY_FEATURE_ID]: {},
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

async function runConfigCase({
  check,
  registerCleanup,
  label,
  settings,
  traceName,
  toolCallId,
  expectValid,
}) {
  const isolation = makeIsolation();
  registerCleanup(isolation.cleanup);
  const tracePath = join(isolation.base, traceName);
  process.env[CONFIG_TRACE_ENV] = tracePath;

  const config = createConfig(settings);
  const configSnapshot = JSON.stringify(config);
  const sessionManager = createSeededSessionManager(isolation, config);
  const seededEntries = supervisorConfigEntries(sessionManager);
  check(
    seededEntries.length === 1 && JSON.stringify(seededEntries[0]?.data) === configSnapshot,
    `${label} seeded one unchanged agent-supervisor-config entry before session creation`,
  );

  const executions = [];
  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    sessionManager,
    additionalExtensionPaths: [PROBE_EXTENSION_PATH],
    expectedExtensionPath: PROBE_EXTENSION_PATH,
    customTools: [createTargetTool(executions)],
  });
  registerCleanup(harness.cleanup);

  const probeExtension = harness.extensionsResult.extensions[0];
  check(
    harness.extensionsResult.extensions.length === 1 &&
      probeExtension?.resolvedPath === PROBE_EXTENSION_PATH,
    `${label} loaded exactly the feature config semantics probe extension fixture`,
  );
  check(
    harness.extensionsResult.errors.length === 0 &&
      probeExtension?.commands.has('agent-supervisor'),
    `${label} probe extension registered without load errors and exposed the public command`,
  );

  const targetTool = harness.session
    .getAllTools()
    .find((tool) => tool.name === TARGET_TOOL_NAME);
  check(
    targetTool?.sourceInfo?.source === 'sdk' &&
      targetTool.sourceInfo.path === `<sdk:${TARGET_TOOL_NAME}>`,
    `${label} target tool is present as an SDK-owned tool`,
  );

  const initialStatus = await captureStatus(harness, `${label} initial status`);
  check(
    initialStatus.output.includes('Agent Supervisor') &&
      initialStatus.output.includes('Registered features: 2') &&
      initialStatus.output.includes('Kernel health: healthy'),
    `${label} initial public status shows two features and a healthy Supervisor`,
  );
  if (expectValid) {
    check(
      isActiveAutonomous(initialStatus.validating) &&
        isActiveAutonomous(initialStatus.healthy),
      `${label} validating feature and sibling start active with autonomous runtime modes`,
    );
  } else {
    check(
      initialStatus.validating.effectiveMode === 'autonomous' &&
        initialStatus.validating.runtimeMode === 'unavailable' &&
        initialStatus.validating.status === 'unavailable' &&
        initialStatus.validating.reason === 'configuration-invalid',
      `${label} validating feature is unavailable with the configuration-invalid reason`,
    );
    check(
      isActiveAutonomous(initialStatus.healthy),
      `${label} healthy sibling remains active with an autonomous runtime mode`,
    );
  }

  const callsBeforeTurn = harness.faux.state.callCount;
  let events = [];
  let turnCompleted;
  try {
    events = await runScriptedTurn(
      harness,
      'Call the Supervisor feature config semantics target tool.',
      [
        fauxAssistantMessage(fauxToolCall(TARGET_TOOL_NAME, {}, { id: toolCallId })),
        fauxAssistantMessage(fauxText(`${label} scripted turn complete`)),
      ],
    );
    turnCompleted = true;
  } catch {
    turnCompleted = false;
  }
  check(
    turnCompleted,
    `${label} real scripted agent turn completed normally`,
  );
  check(
    countEvents(events, 'agent_start') === 1 &&
      countEvents(events, 'agent_end') === 1 &&
      countEvents(events, 'turn_end') >= 1,
    `${label} scripted turn reached its normal agent lifecycle end`,
  );
  check(
    harness.faux.state.callCount === callsBeforeTurn + 2,
    `${label} scripted turn consumed exactly its two faux responses`,
  );

  const toolResult = latestToolResult(harness.session);
  check(
    executions.length === 1 &&
      toolResult?.isError === false &&
      messageText(toolResult).includes('feature-config-semantics-target-executed'),
    `${label} target tool produced a real successful Pi-observable effect`,
  );

  const trace = readConfigTrace(tracePath);
  const validatingTrace = trace.filter(
    (entry) => entry?.featureId === VALIDATING_FEATURE_ID,
  );
  const healthyTrace = trace.filter(
    (entry) => entry?.featureId === HEALTHY_FEATURE_ID,
  );
  console.log(`  TRACE feature-config-semantics ${label}: ${JSON.stringify(trace)}`);
  if (expectValid) {
    check(
      validatingTrace.length === 1 &&
        validatingTrace[0]?.action === 'validating-observed' &&
        validatingTrace[0]?.configFlavor === 'accepted' &&
        validatingTrace[0]?.toolCallId === toolCallId,
      `${label} validating feature performed observable work with its accepted settings`,
    );
    check(
      healthyTrace.length === 1 &&
        healthyTrace[0]?.action === 'healthy-observed' &&
        healthyTrace[0]?.toolCallId === toolCallId,
      `${label} healthy sibling performed observable work too`,
    );
  } else {
    check(
      validatingTrace.length === 0,
      `${label} invalidly configured feature performed no observable work`,
    );
    check(
      healthyTrace.length === 1 &&
        healthyTrace[0]?.action === 'healthy-observed' &&
        healthyTrace[0]?.toolCallId === toolCallId,
      `${label} healthy sibling kept performing observable work`,
    );
  }
  check(
    harness.faux.getPendingResponseCount() === 0,
    `${label} has no unconsumed faux responses after the scripted turn`,
  );
  harness.assertNoPendingFauxResponses();

  const finalStatus = await captureStatus(harness, `${label} final status`);
  check(
    finalStatus.output.includes('Agent Supervisor') &&
      finalStatus.output.includes('Kernel health: healthy'),
    `${label} public status still works without a global Supervisor failure`,
  );
  if (expectValid) {
    check(
      isActiveAutonomous(finalStatus.validating) &&
        isActiveAutonomous(finalStatus.healthy),
      `${label} final status keeps both features active and autonomous`,
    );
  } else {
    check(
      finalStatus.validating.effectiveMode === 'autonomous' &&
        finalStatus.validating.runtimeMode === 'unavailable' &&
        finalStatus.validating.status === 'unavailable' &&
        finalStatus.validating.reason === 'configuration-invalid',
      `${label} final status preserves the validating feature isolation and reason`,
    );
    check(
      isActiveAutonomous(finalStatus.healthy),
      `${label} final status keeps the healthy sibling active and autonomous`,
    );
  }

  const finalConfigEntries = supervisorConfigEntries(harness.sessionManager);
  check(
    finalConfigEntries.length === 1 &&
      JSON.stringify(finalConfigEntries[0]?.data) === configSnapshot,
    `${label} persisted agent-supervisor-config entry remains present and unchanged`,
  );
  harness.assertNoPendingFauxResponses();
  harness.assertNoAuthCredentials();

  return { initialStatus, finalStatus, trace };
}

export const name = 'feature-config-semantics';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const previousProfile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
  const previousTracePath = process.env[CONFIG_TRACE_ENV];
  process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = PROBE_PROFILE;
  registerCleanup(() => {
    if (previousProfile === undefined) {
      delete process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
    } else {
      process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = previousProfile;
    }
    if (previousTracePath === undefined) {
      delete process.env[CONFIG_TRACE_ENV];
    } else {
      process.env[CONFIG_TRACE_ENV] = previousTracePath;
    }
  });

  try {
    const validCase = await runConfigCase({
      check,
      registerCleanup,
      label: 'valid settings',
      settings: VALID_SETTINGS,
      traceName: 'feature-config-semantics-valid.jsonl',
      toolCallId: VALID_TOOL_CALL_ID,
      expectValid: true,
    });
    const invalidCase = await runConfigCase({
      check,
      registerCleanup,
      label: 'invalid settings',
      settings: INVALID_SETTINGS,
      traceName: 'feature-config-semantics-invalid.jsonl',
      toolCallId: INVALID_TOOL_CALL_ID,
      expectValid: false,
    });

    console.log(
      `  TRACE feature-config-semantics valid runtime: status=${validCase.finalStatus.validating.status}, reason=${validCase.finalStatus.validating.reason ?? 'none'}`,
    );
    console.log(
      `  TRACE feature-config-semantics invalid runtime: status=${invalidCase.finalStatus.validating.status}, reason=${invalidCase.finalStatus.validating.reason ?? 'none'}`,
    );

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: `semantic config validation verified (valid=${validCase.finalStatus.validating.status}/${validCase.finalStatus.validating.reason ?? 'none'}, invalid=${invalidCase.finalStatus.validating.status}/${invalidCase.finalStatus.validating.reason ?? 'none'})`,
        }
      : { status: 'fail', reason: 'semantic config validation assertions failed' };
  } finally {
    await cleanupAll();
  }
}
