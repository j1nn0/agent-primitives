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
const PROBE_PROFILE = 'fact-visibility';
const FACT_TRACE_ENV = 'SUPERVISOR_HARNESS_FACT_TRACE_PATH';
const FACT_EMITTER_ID = 'probe-fact-emitter';
const FACT_KIND = `${FACT_EMITTER_ID}:signal`;
const FACT_MARKER = 'supervisor-harness-fact-visibility';
const TARGET_TOOL_NAME = 'supervisor_harness_fact_visibility_target';
const FIRST_TOOL_CALL_ID = 'fact-visibility-first';
const LATER_TOOL_CALL_ID = 'fact-visibility-later';
const NEW_ROOT_TOOL_CALL_ID = 'fact-visibility-new-root';
const SUPERVISOR_STATE_CUSTOM_TYPE = 'agent-supervisor-state';

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Fact Visibility Target',
    description: 'Deterministic target tool for the Supervisor fact visibility probe.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(true);
      return {
        content: [{ type: 'text', text: 'fact-visibility-target-executed' }],
      };
    },
  };
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

function featureIsAutonomous(output, featureId) {
  return output.split('\n').some(
    (line) =>
      line.startsWith(`- ${featureId}:`) &&
      line.includes('default=autonomous') &&
      line.includes('effective=autonomous') &&
      line.includes('runtime=autonomous') &&
      line.includes('status=active'),
  );
}

function readFactTrace(path) {
  const content = readFileSync(path, 'utf8').trim();
  return content.length === 0
    ? []
    : content.split('\n').map((line) => JSON.parse(line));
}

function stateEntries(sessionManager) {
  return sessionManager.getBranch().filter(
    (entry) =>
      entry?.type === 'custom' &&
      entry.customType === SUPERVISOR_STATE_CUSTOM_TYPE,
  );
}

export const name = 'fact-visibility';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { registerCleanup, cleanupAll } = cleanup;
  const previousProfile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
  const previousTracePath = process.env[FACT_TRACE_ENV];
  const isolation = makeIsolation();
  const tracePath = join(isolation.base, 'fact-visibility.jsonl');
  registerCleanup(isolation.cleanup);
  process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = PROBE_PROFILE;
  process.env[FACT_TRACE_ENV] = tracePath;
  registerCleanup(() => {
    if (previousProfile === undefined) {
      delete process.env.SUPERVISOR_HARNESS_PROBE_PROFILE;
    } else {
      process.env.SUPERVISOR_HARNESS_PROBE_PROFILE = previousProfile;
    }
    if (previousTracePath === undefined) {
      delete process.env[FACT_TRACE_ENV];
    } else {
      process.env[FACT_TRACE_ENV] = previousTracePath;
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
      'loaded exactly the fact visibility probe supervisor extension fixture',
    );
    check(
      harness.extensionsResult.errors.length === 0,
      'fact visibility probe extension loading returned no errors',
    );

    const targetTool = harness.session
      .getAllTools()
      .find((tool) => tool.name === TARGET_TOOL_NAME);
    check(
      targetTool?.sourceInfo?.source === 'sdk' &&
        targetTool.sourceInfo.path === `<sdk:${TARGET_TOOL_NAME}>`,
      'fact visibility target tool is present as an SDK-owned tool',
    );

    const statusMessageStart = harness.uiMessages.length;
    const statusCallsBefore = harness.faux.state.callCount;
    await harness.session.prompt('/agent-supervisor status');
    const statusOutput = notifyText(harness.uiMessages.slice(statusMessageStart));
    check(
      harness.faux.state.callCount === statusCallsBefore,
      'fact visibility status command caused zero faux model calls',
    );
    check(
      statusOutput.includes('Registered features: 2') &&
        statusOutput.includes('Effective global mode: autonomous'),
      'fact visibility profile registered two autonomous features',
    );
    check(
      featureIsAutonomous(statusOutput, FACT_EMITTER_ID) &&
        featureIsAutonomous(statusOutput, 'probe-fact-reader'),
      'fact emitter and reader are active with autonomous effective modes',
    );

    const callsBeforeTurns = harness.faux.state.callCount;
    const firstRootEvents = await runScriptedTurn(
      harness,
      'Call the fact visibility target twice in this root request.',
      [
        fauxAssistantMessage(
          fauxToolCall(TARGET_TOOL_NAME, {}, { id: FIRST_TOOL_CALL_ID }),
        ),
        fauxAssistantMessage(
          fauxToolCall(TARGET_TOOL_NAME, {}, { id: LATER_TOOL_CALL_ID }),
        ),
        fauxAssistantMessage(fauxText('two-call root request complete')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      countEvents(firstRootEvents, 'agent_start') === 1 &&
        countEvents(firstRootEvents, 'agent_end') === 1,
      'the two-call root request completed one agent lifecycle',
    );

    const newRootEvents = await runScriptedTurn(
      harness,
      'Start a new root request and call the fact visibility target once.',
      [
        fauxAssistantMessage(
          fauxToolCall(TARGET_TOOL_NAME, {}, { id: NEW_ROOT_TOOL_CALL_ID }),
        ),
        fauxAssistantMessage(fauxText('new root request complete')),
      ],
    );
    harness.assertNoPendingFauxResponses();
    check(
      countEvents(newRootEvents, 'agent_start') === 1 &&
        countEvents(newRootEvents, 'agent_end') === 1,
      'the new root request completed one agent lifecycle',
    );
    check(
      harness.faux.state.callCount === callsBeforeTurns + 5,
      'all five scripted fact visibility model turns were consumed',
    );
    check(
      executions.length === 3,
      'the deterministic target tool executed for all three observations',
    );

    // The fixture records B's public fact snapshot in an isolated file, avoiding private Kernel access.
    const trace = readFactTrace(tracePath);
    for (const [index, observation] of trace.entries()) {
      console.log(
        `  TRACE fact-visibility dispatch ${index + 1}: ${JSON.stringify(observation)}`,
      );
    }

    check(
      trace.length === 3,
      'B recorded exactly three before-tool-call observations',
    );
    check(
      trace.map((observation) => observation?.toolCallId).join(',') ===
        [FIRST_TOOL_CALL_ID, LATER_TOOL_CALL_ID, NEW_ROOT_TOOL_CALL_ID].join(','),
      'B trace preserves the two same-root and one new-root dispatch order',
    );

    const firstObservation = trace[0];
    const laterObservation = trace[1];
    const newRootObservation = trace[2];
    const firstFacts = Array.isArray(firstObservation?.facts)
      ? firstObservation.facts
      : [];
    const laterFacts = Array.isArray(laterObservation?.facts)
      ? laterObservation.facts
      : [];
    const newRootFacts = Array.isArray(newRootObservation?.facts)
      ? newRootObservation.facts
      : [];
    const earlierFact = laterFacts.find(
      (fact) =>
        fact?.sourceFeatureId === FACT_EMITTER_ID &&
        fact?.kind === FACT_KIND &&
        fact?.data?.marker === FACT_MARKER,
    );

    check(
      firstFacts.length === 0,
      'same-dispatch isolation: B saw no fact emitted by A in the first dispatch',
    );
    check(
      typeof firstObservation?.rootRequestId === 'string' &&
        firstObservation.rootRequestId === laterObservation?.rootRequestId,
      'later-dispatch visibility uses the same Root Request as the first dispatch',
    );
    check(
      laterFacts.length === 1 &&
        earlierFact?.sequence === 0 &&
        earlierFact.rootRequestId === firstObservation?.rootRequestId,
      'later-dispatch visibility: B saw A’s earlier fact in the same root',
    );
    check(
      typeof newRootObservation?.rootRequestId === 'string' &&
        newRootObservation.rootRequestId !== firstObservation?.rootRequestId &&
        newRootFacts.length === 0,
      'root-local clearing: B saw no facts after the new Root Request began',
    );

    const persistedState = stateEntries(harness.sessionManager);
    const persistedStateText = persistedState
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const carriesFactContent =
      persistedStateText.includes(FACT_KIND) ||
      persistedStateText.includes(FACT_MARKER);
    console.log(
      `  TRACE fact-visibility persisted agent-supervisor-state entries: ${persistedState.length}; fact content: ${carriesFactContent ? 'present' : 'none'}`,
    );
    check(
      persistedState.length > 0,
      'session contains agent-supervisor-state custom entries to inspect',
    );
    check(
      !carriesFactContent &&
        persistedState.every((entry) => entry.data?.kind === 'runtime'),
      'agent-supervisor-state entries carry no emitted fact content',
    );

    harness.assertNoPendingFauxResponses();
    harness.assertNoAuthCredentials();

    return result.status === 'pass'
      ? { status: 'pass', reason: 'Supervisor fact visibility and ephemeral persistence verified' }
      : { status: 'fail', reason: 'Supervisor fact visibility assertions failed' };
  } finally {
    await cleanupAll();
  }
}
