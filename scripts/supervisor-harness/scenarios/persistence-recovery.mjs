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
const PROBE_PROFILE = 'persistence-recovery';
const SUPERVISOR_STATE_CUSTOM_TYPE = 'agent-supervisor-state';
const TARGET_FEATURE_ID = 'corrupt-target';
const BLOCKER_FEATURE_ID = 'healthy-blocker';
const TARGET_TOOL_NAME = 'supervisor_harness_persistence_recovery_target';
const BLOCK_MESSAGE = 'healthy-blocker proposal won at the tool-call boundary';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Persistence Recovery Target',
    description: 'Deterministic target tool for the Supervisor persistence recovery probe.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.push(true);
      return {
        content: [{ type: 'text', text: 'persistence-recovery-target-executed' }],
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
  const match =
    /requested=([^,]+), effective=([^,]+), runtime=([^,]+), status=([^\s]+)(?: reason=(\S+))?/u.exec(
      line,
    );
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

function parseStatus(output, label) {
  const healthMatch = /^Kernel health: (\S+)$/mu.exec(output);
  const runtimeMatch = /^Runtime state: (.+)$/mu.exec(output);
  const rootMatch = /^Current root: ([^\s]+) \(([^)]+)\)$/mu.exec(output);
  if (healthMatch === null || runtimeMatch === null || rootMatch === null) {
    throw new Error(`status command omitted required recovery fields at ${label}`);
  }
  return {
    output,
    health: healthMatch[1],
    runtimeState: runtimeMatch[1],
    root: { id: rootMatch[1], status: rootMatch[2] },
    target: parseFeatureStatus(output, TARGET_FEATURE_ID, label),
    blocker: parseFeatureStatus(output, BLOCKER_FEATURE_ID, label),
  };
}

async function captureStatus(harness, label) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  if (harness.faux.state.callCount !== callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  const output = harness.uiMessages
    .slice(messageStart)
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
  return parseStatus(output, label);
}

function runtimeRecord(nextRootRequestSequence) {
  return {
    schemaVersion: 1,
    kind: 'runtime',
    state: { schemaVersion: 1, nextRootRequestSequence },
  };
}

function featureRecord(data) {
  return {
    schemaVersion: 1,
    kind: 'feature',
    state: {
      schemaVersion: 1,
      featureId: TARGET_FEATURE_ID,
      featureSchemaVersion: 1,
      data,
    },
  };
}

function isRuntimeShaped(value) {
  return isRecord(value) && value.kind === 'runtime';
}

function runtimeSequence(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'runtime' ||
    !isRecord(value.state) ||
    value.state.schemaVersion !== 1 ||
    typeof value.state.nextRootRequestSequence !== 'number' ||
    !Number.isSafeInteger(value.state.nextRootRequestSequence) ||
    value.state.nextRootRequestSequence < 1
  ) {
    return undefined;
  }
  return value.state.nextRootRequestSequence;
}

function persistedStateEntries(sessionManager) {
  return sessionManager
    .getBranch()
    .filter(
      (entry) =>
        entry?.type === 'custom' &&
        entry.customType === SUPERVISOR_STATE_CUSTOM_TYPE,
    )
    .map((entry) => entry.data);
}

function expectedRecoveredSequence(entries) {
  let latestValidNext = 1;
  let potentialAdvancements = 0;
  for (const entry of entries) {
    const sequence = runtimeSequence(entry);
    if (sequence !== undefined) {
      latestValidNext = sequence;
      potentialAdvancements = 0;
    } else if (isRuntimeShaped(entry)) {
      potentialAdvancements += 1;
    }
  }
  return latestValidNext + potentialAdvancements;
}

function appendStateRecords(sessionFile, records) {
  const sessionManager = SessionManager.open(sessionFile);
  if (typeof sessionManager.appendCustomEntry !== 'function') {
    throw new Error('SessionManager.appendCustomEntry is not a public API');
  }
  for (const record of records) {
    const entryId = sessionManager.appendCustomEntry(
      SUPERVISOR_STATE_CUSTOM_TYPE,
      record,
    );
    if (typeof entryId !== 'string') {
      throw new Error('SessionManager.appendCustomEntry did not return an entry id');
    }
  }
  return sessionManager;
}

async function createSeedSession({ isolation, registerCleanup }) {
  const seed = await createIsolatedSession({
    isolation,
    storage: 'file',
    additionalExtensionPaths: [PROBE_EXTENSION_PATH],
    expectedExtensionPath: PROBE_EXTENSION_PATH,
  });
  registerCleanup(seed.cleanup);
  const sessionFile = seed.session.sessionFile;
  if (typeof sessionFile !== 'string') {
    throw new Error('file-backed persistence recovery seed did not expose a session file');
  }
  seed.cleanup();
  return sessionFile;
}

async function resumeSession({
  isolation,
  sessionFile,
  sessionManager,
  registerCleanup,
  customTools = [],
}) {
  const harness = await createIsolatedSession({
    isolation,
    storage: 'file',
    sessionManager,
    additionalExtensionPaths: [PROBE_EXTENSION_PATH],
    expectedExtensionPath: PROBE_EXTENSION_PATH,
    customTools,
    sessionStartEvent: {
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: sessionFile,
    },
  });
  registerCleanup(harness.cleanup);
  return harness;
}

export const name = 'persistence-recovery';

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
    const p1Isolation = makeIsolation();
    registerCleanup(p1Isolation.cleanup);
    const p1SessionFile = await createSeedSession({
      isolation: p1Isolation,
      registerCleanup,
    });
    const p1Manager = appendStateRecords(p1SessionFile, [
      featureRecord({ marker: 'corrupt' }),
    ]);
    const p1Executions = [];
    const p1Harness = await resumeSession({
      isolation: p1Isolation,
      sessionFile: p1SessionFile,
      sessionManager: p1Manager,
      registerCleanup,
      customTools: [createTargetTool(p1Executions)],
    });
    const p1Status = await captureStatus(p1Harness, 'P1 resume status');
    check(
      p1Status.health === 'healthy',
      'P1 feature-local state corruption kept kernel health healthy',
    );
    check(
      p1Status.target.status === 'unavailable' &&
        p1Status.target.reason === 'state-invalid',
      'P1 corrupt-target is unavailable with the state-invalid reason',
    );
    check(
      p1Status.blocker.status === 'active' &&
        p1Status.blocker.effectiveMode === 'autonomous' &&
        p1Status.blocker.runtimeMode === 'autonomous',
      'P1 healthy-blocker remains active with an autonomous effective mode',
    );
    const p1TargetTool = p1Harness.session
      .getAllTools()
      .find((tool) => tool.name === TARGET_TOOL_NAME);
    check(
      p1TargetTool?.sourceInfo?.source === 'sdk' &&
        p1TargetTool.sourceInfo.path === `<sdk:${TARGET_TOOL_NAME}>`,
      'P1 real custom target tool is present as an SDK-owned tool',
    );

    const p1Events = await runScriptedTurn(
      p1Harness,
      'Call the persistence recovery target tool.',
      [
        fauxAssistantMessage(
          fauxToolCall(TARGET_TOOL_NAME, {}, { id: 'persistence-recovery-p1' }),
        ),
        fauxAssistantMessage(fauxText('P1 blocked turn complete.')),
      ],
    );
    check(
      p1Executions.length === 0,
      `P1 target tool execution counter stayed unchanged at ${p1Executions.length}`,
    );
    const p1ToolResult = latestToolResult(p1Harness.session);
    check(
      p1ToolResult?.isError === true &&
        messageText(p1ToolResult).includes(BLOCK_MESSAGE),
      'P1 blocked tool result carries healthy-blocker proposal message',
    );
    check(
      countEvents(p1Events, 'agent_start') === 1 &&
        countEvents(p1Events, 'agent_end') === 1,
      'P1 real scripted turn completed through the normal agent lifecycle',
    );
    p1Harness.assertNoPendingFauxResponses();
    console.log(`  TRACE persistence-recovery P1 execution counter: ${p1Executions.length}`);

    const p2Isolation = makeIsolation();
    registerCleanup(p2Isolation.cleanup);
    const p2SessionFile = await createSeedSession({
      isolation: p2Isolation,
      registerCleanup,
    });
    const p2Manager = appendStateRecords(p2SessionFile, [
      featureRecord({ marker: 'corrupt' }),
      featureRecord({ marker: 'restored' }),
    ]);
    const p2Harness = await resumeSession({
      isolation: p2Isolation,
      sessionFile: p2SessionFile,
      sessionManager: p2Manager,
      registerCleanup,
    });
    const p2Status = await captureStatus(p2Harness, 'P2 resume status');
    check(
      p2Status.health === 'healthy' &&
        p2Status.target.status === 'active' &&
        p2Status.target.effectiveMode === 'autonomous',
      'P2 later valid corrupt-target state superseded historical corruption',
    );
    check(
      p2Status.target.reason === null && p2Status.target.runtimeMode === 'autonomous',
      'P2 restored corrupt-target runtime is healthy and autonomous',
    );
    p2Harness.assertNoPendingFauxResponses();

    const p3Isolation = makeIsolation();
    registerCleanup(p3Isolation.cleanup);
    const p3Initial = await createIsolatedSession({
      isolation: p3Isolation,
      storage: 'file',
      additionalExtensionPaths: [PROBE_EXTENSION_PATH],
      expectedExtensionPath: PROBE_EXTENSION_PATH,
    });
    registerCleanup(p3Initial.cleanup);
    const p3SessionFile = p3Initial.session.sessionFile;
    if (typeof p3SessionFile !== 'string') {
      throw new Error('P3 initial session did not expose a session file');
    }
    const p3InitialEvents = await runScriptedTurn(
      p3Initial,
      'Complete the initial persistence recovery turn.',
      [fauxAssistantMessage(fauxText('P3 initial turn complete.'))],
    );
    check(
      countEvents(p3InitialEvents, 'agent_start') === 1 &&
        countEvents(p3InitialEvents, 'agent_end') === 1,
      'P3 initial file-backed session completed a real interactive turn',
    );
    p3Initial.assertNoPendingFauxResponses();
    const p3InitialStatus = await captureStatus(p3Initial, 'P3 initial status');
    const p3EntriesBeforeCorrupt = persistedStateEntries(p3Initial.sessionManager);
    const p3LatestValidBeforeCorrupt = p3EntriesBeforeCorrupt
      .map((entry) => runtimeSequence(entry))
      .filter((sequence) => sequence !== undefined)
      .at(-1);
    check(
      p3LatestValidBeforeCorrupt === 2,
      'P3 initial turn persisted the genuine next root request sequence 2',
    );
    const p3InitialRoot = p3InitialStatus.root.id;
    p3Initial.cleanup();

    const p3Manager = appendStateRecords(p3SessionFile, [runtimeRecord(0)]);
    const p3EntriesWithCorruptTail = persistedStateEntries(p3Manager);
    const expectedP3RecoverySequence = expectedRecoveredSequence(
      p3EntriesWithCorruptTail,
    );
    check(
      expectedP3RecoverySequence === 3,
      `P3 corrupt runtime tail predicts recovered sequence ${expectedP3RecoverySequence}`,
    );
    const p3Harness = await resumeSession({
      isolation: p3Isolation,
      sessionFile: p3SessionFile,
      sessionManager: p3Manager,
      registerCleanup,
    });
    const p3ResumeStatus = await captureStatus(p3Harness, 'P3 resume status');
    check(
      p3ResumeStatus.health === 'healthy' &&
        p3ResumeStatus.runtimeState ===
          'recovered (next root request sequence: 3)' &&
        p3ResumeStatus.root.id === 'none' &&
        p3ResumeStatus.root.status === 'none',
      'P3 resume is healthy, reports runtime recovery, and has no current root',
    );
    const p3EntriesAfterRecovery = persistedStateEntries(p3Harness.sessionManager);
    const p3RecoveryEntries = p3EntriesAfterRecovery.filter(
      (entry) => runtimeSequence(entry) === expectedP3RecoverySequence,
    );
    check(
      p3EntriesAfterRecovery.length === p3EntriesWithCorruptTail.length + 1 &&
        p3RecoveryEntries.length === 1 &&
        runtimeSequence(p3EntriesAfterRecovery.at(-1)) ===
          expectedP3RecoverySequence,
      'P3 persisted exactly one valid recovery record with the predicted sequence',
    );

    const p3ResumedEvents = await runScriptedTurn(
      p3Harness,
      'Complete the recovered persistence recovery turn.',
      [fauxAssistantMessage(fauxText('P3 recovered turn complete.'))],
    );
    check(
      countEvents(p3ResumedEvents, 'agent_start') === 1 &&
        countEvents(p3ResumedEvents, 'agent_end') === 1,
      'P3 next real user input completed normally after recovery',
    );
    p3Harness.assertNoPendingFauxResponses();
    const p3AfterTurnStatus = await captureStatus(p3Harness, 'P3 after-turn status');
    const p3NextRootSequence = runtimeSequence(
      persistedStateEntries(p3Harness.sessionManager).at(-1),
    );
    check(
      p3AfterTurnStatus.root.id === `root-${expectedP3RecoverySequence}` &&
        p3AfterTurnStatus.root.status === 'settled',
      'P3 next input allocated the exact root id after the corrupt tail',
    );
    check(
      p3NextRootSequence === expectedP3RecoverySequence + 1,
      'P3 next input persisted the following root request sequence',
    );

    const p3StateBeforeSecondResume = persistedStateEntries(p3Harness.sessionManager);
    const p3RecoveryCountBeforeSecondResume = p3StateBeforeSecondResume.filter(
      (entry) => runtimeSequence(entry) === expectedP3RecoverySequence,
    ).length;
    const p3NextBeforeSecondResume = runtimeSequence(
      p3StateBeforeSecondResume.at(-1),
    );
    p3Harness.cleanup();

    const p4Manager = SessionManager.open(p3SessionFile);
    const p4EntriesBeforeResume = persistedStateEntries(p4Manager);
    const p4Harness = await resumeSession({
      isolation: p3Isolation,
      sessionFile: p3SessionFile,
      sessionManager: p4Manager,
      registerCleanup,
    });
    const p4ResumeStatus = await captureStatus(p4Harness, 'P4 resume status');
    const p4EntriesAfterResume = persistedStateEntries(p4Harness.sessionManager);
    const p4RecoveryCountAfterResume = p4EntriesAfterResume.filter(
      (entry) => runtimeSequence(entry) === expectedP3RecoverySequence,
    ).length;
    check(
      p4ResumeStatus.health === 'healthy' &&
        p4ResumeStatus.runtimeState === 'normal' &&
        p4ResumeStatus.root.id === 'none' &&
        p4ResumeStatus.root.status === 'none',
      'P4 second resume stays healthy with normal runtime state and no current root',
    );
    check(
      p4EntriesAfterResume.length === p4EntriesBeforeResume.length &&
        p4RecoveryCountAfterResume === p3RecoveryCountBeforeSecondResume,
      'P4 second resume appended no additional recovery record',
    );

    const p4Events = await runScriptedTurn(
      p4Harness,
      'Complete the second resumed persistence recovery turn.',
      [fauxAssistantMessage(fauxText('P4 turn complete.'))],
    );
    check(
      countEvents(p4Events, 'agent_start') === 1 &&
        countEvents(p4Events, 'agent_end') === 1,
      'P4 next real user input completed normally without reusing a root',
    );
    p4Harness.assertNoPendingFauxResponses();
    const p4AfterTurnStatus = await captureStatus(p4Harness, 'P4 after-turn status');
    const p4StateAfterTurn = persistedStateEntries(p4Harness.sessionManager);
    const p4NextAfterTurn = runtimeSequence(p4StateAfterTurn.at(-1));
    check(
      p4AfterTurnStatus.root.id === 'root-4' &&
        p4AfterTurnStatus.root.status === 'settled' &&
        p4AfterTurnStatus.root.id !== p3AfterTurnStatus.root.id,
      'P4 allocated the next monotonic root id without reusing P3 root',
    );
    check(
      p4NextAfterTurn === 5 &&
        p4StateAfterTurn.length === p4EntriesAfterResume.length + 1 &&
        p4StateAfterTurn.filter(
          (entry) => runtimeSequence(entry) === expectedP3RecoverySequence,
        ).length === p3RecoveryCountBeforeSecondResume,
      'P4 persisted only its normal runtime advancement after the second turn',
    );

    console.log(
      `  TRACE persistence-recovery P3 roots: initial=${p3InitialRoot}, corrupt-tail-represented=root-${p3LatestValidBeforeCorrupt}, resumed=${p3AfterTurnStatus.root.id}; recovered sequence=${expectedP3RecoverySequence}, persisted next=${p3NextRootSequence}`,
    );
    console.log(
      `  TRACE persistence-recovery P4 roots: resume=${p4ResumeStatus.root.id}, input=${p4AfterTurnStatus.root.id}; recovered sequence=none, next before input=${p3NextBeforeSecondResume}, persisted next=${p4NextAfterTurn}`,
    );

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: `persistence recovery verified (P1 executions=${p1Executions.length}, P3 recovered=${expectedP3RecoverySequence}/${p3AfterTurnStatus.root.id}, P4=${p4AfterTurnStatus.root.id})`,
        }
      : { status: 'fail', reason: 'persistence recovery assertions failed' };
  } finally {
    await cleanupAll();
  }
}
