/* global console */

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  SUPERVISOR_EXTENSION_PATH,
} from '../runner.mjs';

const AGENT_CALL_KIND = 'AGENT';
const AUXILIARY_ASSESSMENT_CALL_KIND = 'AUXILIARY_ASSESSMENT';
const AUXILIARY_SYSTEM_PROMPT_PREFIX = 'You are a bounded claim/evidence extractor.';
const BUILTIN_TOOL_NAMES = ['read', 'bash', 'edit', 'write'];
const COMPLETION_GATE_ID = 'completion-gate';
const AUTO_STATE_ID = 'auto-state';
const AUTO_PROGRESS_ID = 'auto-progress';
const SUPERVISOR_STATE_CUSTOM_TYPE = 'agent-supervisor-state';

function messageText(message) {
  if (typeof message?.content === 'string') {
    return message.content;
  }
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

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function isAuxiliaryAssessmentContext(context) {
  return (
    typeof context?.systemPrompt === 'string' &&
    context.systemPrompt.startsWith(AUXILIARY_SYSTEM_PROMPT_PREFIX) &&
    Array.isArray(context.messages) &&
    context.messages.length === 1
  );
}

function scriptedResponse(message, expectedKind, callKinds, label) {
  return (context) => {
    const actualKind = isAuxiliaryAssessmentContext(context)
      ? AUXILIARY_ASSESSMENT_CALL_KIND
      : AGENT_CALL_KIND;
    callKinds.push(actualKind);
    if (actualKind !== expectedKind) {
      throw new Error(
        `${label} expected ${expectedKind} response but received ${actualKind}`,
      );
    }
    return message;
  };
}

function agentText(text) {
  return {
    kind: AGENT_CALL_KIND,
    message: fauxAssistantMessage(fauxText(text)),
  };
}

function agentTool(name, input, id) {
  return {
    kind: AGENT_CALL_KIND,
    message: fauxAssistantMessage(fauxToolCall(name, input, { id })),
  };
}

function auxResponse(payload) {
  return {
    kind: AUXILIARY_ASSESSMENT_CALL_KIND,
    message: fauxAssistantMessage(fauxText(JSON.stringify(payload))),
  };
}

function completionClaim(quote, evidence = []) {
  return { kind: 'completion', quote, evidence };
}

function evidenceRef(id, quote) {
  return { id, quote };
}

function fullAuxPayload({ claim, evidenceQuote, state, progress }) {
  const payload = {
    schemaVersion: 1,
    claims: [completionClaim(claim, [evidenceRef('e2', evidenceQuote)])],
  };
  if (state !== undefined) {
    payload.state = state;
  }
  if (progress !== undefined) {
    payload.progress = progress;
  }
  return payload;
}

function stateDomain(objectiveQuote, workQuote, decisionQuote) {
  return {
    objective: { quote: objectiveQuote },
    workItems: [{ quote: workQuote, status: 'in_progress' }],
    decisions: [{ source: 'assistant', quote: decisionQuote }],
  };
}

function progressDomain() {
  return [
    { kind: 'implementation', evidence: ['e1'] },
    { kind: 'verification', evidence: ['e2'] },
  ];
}

async function createProductionHarness(cleanup, { storage = 'memory', sessionManager, sessionStartEvent } = {}) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const harness = await createIsolatedSession({
    isolation,
    storage,
    sessionManager,
    sessionStartEvent,
    additionalExtensionPaths: [SUPERVISOR_EXTENSION_PATH],
    expectedExtensionPath: SUPERVISOR_EXTENSION_PATH,
    tools: [...BUILTIN_TOOL_NAMES],
  });
  cleanup.registerCleanup(harness.cleanup);
  return { harness, isolation };
}

function assertProductionExtension(check, harness, label) {
  const extension = harness.extensionsResult.extensions[0];
  check(
    harness.extensionsResult.extensions.length === 1 &&
      extension?.resolvedPath === SUPERVISOR_EXTENSION_PATH &&
      harness.extensionsResult.errors.length === 0 &&
      extension?.commands.has('agent-supervisor') &&
      extension.tools.size === 0,
    `${label}: loaded only the production Supervisor extension with no loader errors`,
  );
  const tools = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool]));
  check(
    BUILTIN_TOOL_NAMES.every((name) => tools.get(name)?.sourceInfo?.source === 'builtin'),
    `${label}: mutation and verification use real Pi builtin tool registrations`,
  );
}

async function runCommand(harness, command, label) {
  const callsBefore = harness.faux.state.callCount;
  const messageStart = harness.uiMessages.length;
  await harness.session.prompt(command);
  const callsAfter = harness.faux.state.callCount;
  if (callsAfter !== callsBefore) {
    throw new Error(`${label} caused an unexpected faux model call`);
  }
  harness.assertNoPendingFauxResponses();
  return {
    callsBefore,
    callsAfter,
    text: notifyText(harness.uiMessages.slice(messageStart)),
  };
}

async function captureStatus(harness, label) {
  const command = await runCommand(harness, '/agent-supervisor status', label);
  if (!command.text.includes('Agent Supervisor')) {
    throw new Error(`status command returned no Supervisor output at ${label}`);
  }
  harness.assertNoAuthCredentials();
  return command;
}

function parseCurrentRoot(text) {
  const match = /^Current root: ([^\s]+) \(([^)]+)\)$/mu.exec(text);
  return match === null ? undefined : { id: match[1], status: match[2] };
}

function featureLine(text, featureId) {
  return text
    .split('\n')
    .find((line) => line.startsWith(`- ${featureId}:`));
}

function featureMatches(text, featureId, pattern) {
  const line = featureLine(text, featureId);
  return line !== undefined && pattern.test(line);
}

function toolCalls(events) {
  return events
    .filter((event) => event?.type === 'agent_end')
    .flatMap((event) => (Array.isArray(event.messages) ? event.messages : []))
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((part) => part?.type === 'toolCall')
    .map((part) => ({ name: part.name, arguments: part.arguments }));
}

async function runPlan(harness, prompt, steps) {
  const callKinds = [];
  const eventStart = harness.events.length;
  const messageStart = harness.session.messages.length;
  const callsBefore = harness.faux.state.callCount;
  const uiMessagesBefore = harness.uiMessages.length;
  await runScriptedTurn(
    harness,
    prompt,
    steps.map((step, index) =>
      scriptedResponse(step.message, step.kind, callKinds, `scripted turn response ${index + 1}`),
    ),
  );
  await harness.session.waitForIdle();
  harness.assertNoPendingFauxResponses();
  const callsAfter = harness.faux.state.callCount;
  const events = harness.events.slice(eventStart);
  const messages = harness.session.messages.slice(messageStart);
  return {
    callsBefore,
    callsAfter,
    modelCalls: callsAfter - callsBefore,
    callKinds,
    agentModelCalls: callKinds.filter((kind) => kind === AGENT_CALL_KIND).length,
    auxiliaryCalls: callKinds.filter((kind) => kind === AUXILIARY_ASSESSMENT_CALL_KIND).length,
    events,
    messages,
    toolResults: messages.filter((message) => message?.role === 'toolResult'),
    runs: countEvents(events, 'agent_start'),
    followUps: Math.max(0, countEvents(events, 'agent_start') - 1),
    toolCalls: toolCalls(events),
    uiMessagesBefore,
    uiMessagesAfter: harness.uiMessages.length,
  };
}

function assertPlanShape(check, plan, expected, label) {
  check(
    plan.modelCalls === expected.modelCalls &&
      plan.agentModelCalls === expected.agentModelCalls &&
      plan.auxiliaryCalls === expected.auxiliaryCalls &&
      plan.runs === expected.runs &&
      plan.followUps === expected.followUps &&
      plan.callKinds.join(',') === expected.callKinds.join(','),
    `${label}: modelCalls=${expected.modelCalls} (agent=${expected.agentModelCalls}, auxiliary=${expected.auxiliaryCalls}), runs=${expected.runs}, followUps=${expected.followUps}`,
  );
  check(
    plan.callsAfter - plan.callsBefore === plan.callKinds.length,
    `${label}: every faux model call consumed one scripted response`,
  );
}

function reportTrace(label, plan, extra = '') {
  console.log(
    `  TRACE auto-state-progress ${label}: auxiliaryCalls=${plan.auxiliaryCalls}, modelCalls=${plan.modelCalls} (agent=${plan.agentModelCalls}), runs=${plan.runs}, followUps=${plan.followUps}${extra}`,
  );
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

function latestFeatureData(entries, featureId) {
  const matches = entries.filter(
    (data) =>
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      data.kind === 'feature' &&
      data.state !== null &&
      typeof data.state === 'object' &&
      !Array.isArray(data.state) &&
      data.state.featureId === featureId,
  );
  if (matches.length === 0) {
    return undefined;
  }
  return matches[matches.length - 1].state.data;
}


function autoProgressMilestones(data) {
  if (data === undefined) {
    return [];
  }
  return Array.isArray(data.recordedMilestones) ? [...data.recordedMilestones] : [];
}

function milestoneKinds(milestones) {
  return milestones.map((milestone) => String(milestone).split(':').slice(0, 2).join(':')).sort();
}

function checkHealthyAssessment(check, status, label) {
  check(
    status.text.includes('Kernel health: healthy') &&
      status.text.includes('Assessment: success'),
    `${label}: Kernel stayed healthy and the shared assessment succeeded`,
  );
}

/**
 * `completion-gate` is always autonomous here; the two auto features are checked against the mode
 * the part actually configured, so an observe part proves observe rather than skipping the check.
 */
function checkFeatureTrio(check, status, label, autoMode = 'autonomous') {
  const pattern = (mode) =>
    new RegExp(`requested=${mode}, effective=${mode}, runtime=${mode}, status=active\\b`, 'u');
  check(
    featureMatches(status.text, COMPLETION_GATE_ID, pattern('autonomous')) &&
      featureMatches(status.text, AUTO_STATE_ID, pattern(autoMode)) &&
      featureMatches(status.text, AUTO_PROGRESS_ID, pattern(autoMode)),
    `${label}: completion-gate is autonomous and both auto features are ${autoMode} and active`,
  );
}

const SHARED_RUN_SHAPE = {
  modelCalls: 4,
  agentModelCalls: 3,
  auxiliaryCalls: 1,
  runs: 1,
  followUps: 0,
  callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND, AGENT_CALL_KIND, AUXILIARY_ASSESSMENT_CALL_KIND],
};

function scriptForPart({ prompt, path, content, finalText, objective, work, decision, claim, progress }) {
  return {
    prompt,
    steps: [
      agentTool('write', { path, content }, `${path}-write`),
      agentTool('read', { path }, `${path}-read`),
      agentText(finalText),
      auxResponse(
        fullAuxPayload({
          claim,
          evidenceQuote: content,
          state: stateDomain(objective, work, decision),
          progress: progress === undefined ? progressDomain() : progress,
        }),
      ),
    ],
  };
}

const PART_A = {
  prompt:
    'Objective: Record the durable outcome of the probe file verification. ' +
    'Task: Draft and verify the auto-state progress probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-A.txt',
  content: 'auto-state-progress probe content A',
  finalText: 'The probe file write is complete. The probe decision stands verified by the read-back.',
  objective: 'Record the durable outcome of the probe file verification',
  work: 'Draft and verify the auto-state progress probe file',
  decision: 'The probe decision stands verified by the read-back.',
  claim: 'The probe file write is complete.',
};

const PART_C = {
  prompt:
    'Objective: Record the durable outcome of the second probe verification. ' +
    'Task: Draft and verify the second probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-C.txt',
  content: 'auto-state-progress probe content C',
  finalText: 'The second probe file write is complete. The second probe decision stands verified by the read-back.',
  objective: 'Record the durable outcome of the second probe verification',
  work: 'Draft and verify the second probe file',
  decision: 'The second probe decision stands verified by the read-back.',
  claim: 'The second probe file write is complete.',
};

const PART_D = {
  prompt:
    'Objective: Record the durable outcome of the fourth probe verification. ' +
    'Task: Draft and verify the fourth probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-D.txt',
  content: 'auto-state-progress probe content D',
  finalText: 'The fourth probe file write is complete. The fourth probe decision stands verified by the read-back.',
  objective: 'Record the durable outcome of the fourth probe verification',
  work: 'Draft and verify the fourth probe file',
  decision: 'The fourth probe decision stands verified by the read-back.',
  claim: 'The fourth probe file write is complete.',
};

const PART_E = {
  prompt:
    'Objective: Record the durable outcome of the fifth probe verification. ' +
    'Task: Draft and verify the fifth probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-E.txt',
  content: 'auto-state-progress probe content E',
  finalText: 'The fifth probe file write is complete. The fifth probe decision stands verified by the read-back.',
  objective: 'Record the durable outcome of the fifth probe verification',
  work: 'Draft and verify the fifth probe file',
  decision: 'The fifth probe decision stands verified by the read-back.',
  claim: 'The fifth probe file write is complete.',
};

const PART_F = {
  prompt:
    'Objective: Record the durable outcome of the sixth probe verification. ' +
    'Task: Draft and verify the sixth probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-F.txt',
  content: 'auto-state-progress probe content F',
  finalText: 'The sixth probe file write is complete. The sixth probe decision stands verified by the read-back.',
  objective: 'Record the durable outcome of the sixth probe verification',
  work: 'Draft and verify the sixth probe file',
  decision: 'The sixth probe decision stands verified by the read-back.',
  claim: 'The sixth probe file write is complete.',
};

const PART_G = {
  prompt:
    'Objective: Record the durable outcome of the seventh probe verification. ' +
    'Task: Draft and verify the seventh probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-G.txt',
  content: 'auto-state-progress probe content G',
  finalText: 'The seventh probe file write is complete. The seventh probe decision stands verified by the read-back.',
  claim: 'The seventh probe file write is complete.',
};

const PART_H = {
  prompt:
    'Objective: Record the durable outcome of the eighth probe verification. ' +
    'Task: Draft and verify the eighth probe file. ' +
    'Write the file, read it back, then report completion.',
  path: 'auto-state-progress-H.txt',
  content: 'auto-state-progress probe content H',
  finalText: 'The eighth probe file write is complete. The eighth probe decision stands verified by the read-back.',
  objective: 'Record the durable outcome of the eighth probe verification',
  work: 'Draft and verify the eighth probe file',
  decision: 'The eighth probe decision stands verified by the read-back.',
  claim: 'The eighth probe file write is complete.',
};

const PART_I1 = {
  prompt: 'Write the ninth probe file, read it back, then report completion.',
  path: 'auto-state-progress-I1.txt',
  content: 'auto-state-progress probe content I1',
  finalText: 'The ninth probe file write is complete.',
  claim: 'The ninth probe file write is complete.',
};

const PART_I2 = {
  prompt: 'Write the tenth probe file, read it back, then report completion.',
  path: 'auto-state-progress-I2.txt',
  content: 'auto-state-progress probe content I2',
  finalText: 'The tenth probe file write is complete.',
  claim: 'The tenth probe file write is complete.',
};

async function runSharedScript(check, harness, isolation, part, label, autoMode = 'autonomous') {
  const script = scriptForPart(part);
  const plan = await runPlan(harness, script.prompt, script.steps);
  const status = await captureStatus(harness, `${label} final status`);
  assertPlanShape(check, plan, SHARED_RUN_SHAPE, label);
  check(
    plan.toolCalls.map((call) => call.name).join(',') === 'write,read' &&
      plan.toolResults.length === 2 &&
      plan.toolResults.every((result) => result.isError === false) &&
      messageText(plan.toolResults[1]) === part.content &&
      existsSync(join(isolation.workDir, part.path)) &&
      readFileSync(join(isolation.workDir, part.path), 'utf8') === part.content,
    `${label}: real write/read completed and the assessment linked the successful post-mutation read-back`,
  );
  check(
    plan.uiMessagesAfter === plan.uiMessagesBefore &&
      parseCurrentRoot(status.text)?.status === 'settled',
    `${label}: supported completion-gate verdict stayed silent with zero automatic follow-ups`,
  );
  checkHealthyAssessment(check, status, label);
  checkFeatureTrio(check, status, label, autoMode);
  return { plan, status };
}

function snapshotPartState(harness) {
  const entries = persistedStateEntries(harness.sessionManager);
  const stateData = latestFeatureData(entries, AUTO_STATE_ID);
  const progressData = latestFeatureData(entries, AUTO_PROGRESS_ID);
  return {
    stateData,
    progressData,
    workItems: stateData === undefined ? [] : [...(stateData.workItems ?? [])],
    decisions: stateData === undefined ? [] : [...(stateData.decisions ?? [])],
    milestones: autoProgressMilestones(progressData),
  };
}

async function runPartABC(check, cleanup) {
  console.log('  PART A — one assessment powers three consumers');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'A');
  const { plan } = await runSharedScript(check, harness, isolation, PART_A, 'A');
  const snapA = snapshotPartState(harness);
  check(
    snapA.stateData !== undefined &&
      snapA.stateData.objective === PART_A.objective &&
      snapA.workItems.length === 1 &&
      snapA.workItems[0]?.content === PART_A.work &&
      snapA.workItems[0]?.status === 'in_progress' &&
      snapA.decisions.length === 1 &&
      snapA.decisions[0]?.content === PART_A.decision,
    'A: auto-state changed and persisted one work item and one decision with the exact candidate quotes',
  );
  check(
    snapA.milestones.length === 2 &&
      JSON.stringify(milestoneKinds(snapA.milestones)) ===
        JSON.stringify(['auto:implementation', 'auto:verification']),
    'A: auto-progress recorded one implementation and one verification milestone (outcome progress)',
  );
  reportTrace(
    'A',
    plan,
    `, workItems=${snapA.workItems.length}, decisions=${snapA.decisions.length}, milestones=${snapA.milestones.length}`,
  );

  console.log('  PART B — repeating identical work is not progress');
  const planB = (await runSharedScript(check, harness, isolation, PART_A, 'B')).plan;
  const snapB = snapshotPartState(harness);
  check(
    snapB.workItems.length === snapA.workItems.length &&
      snapB.decisions.length === snapA.decisions.length &&
      JSON.stringify(snapB.workItems) === JSON.stringify(snapA.workItems) &&
      JSON.stringify(snapB.decisions) === JSON.stringify(snapA.decisions),
    'B: identical work-item and decision quotes produced no duplicate entries',
  );
  check(
    JSON.stringify(snapB.milestones) === JSON.stringify(snapA.milestones),
    'B: identical evidence semantics recorded no new milestone (outcome no_progress)',
  );
  reportTrace(
    'B',
    planB,
    `, workItems=${snapB.workItems.length}, decisions=${snapB.decisions.length}, milestones=${snapB.milestones.length}`,
  );

  console.log('  PART C — genuinely new evidence is progress');
  const { plan: planC } = await runSharedScript(check, harness, isolation, PART_C, 'C');
  const snapC = snapshotPartState(harness);
  check(
    snapC.milestones.length === snapA.milestones.length + 2 &&
      snapA.milestones.every((milestone) => snapC.milestones.includes(milestone)),
    'C: new admitted evidence recorded two new milestones while keeping the earlier ones (outcome progress)',
  );
  check(
    snapC.workItems.length === 2 && snapC.decisions.length === 2,
    'C: the new run persisted its own work item and decision alongside the earlier ones',
  );
  reportTrace(
    'C',
    planC,
    `, workItems=${snapC.workItems.length}, decisions=${snapC.decisions.length}, milestones=${snapC.milestones.length}`,
  );
}

async function runPartD(check, cleanup) {
  console.log('  PART D — file-backed resume');
  const { harness, isolation } = await createProductionHarness(cleanup, { storage: 'file' });
  assertProductionExtension(check, harness, 'D-seed');
  const { plan: seedPlan } = await runSharedScript(check, harness, isolation, PART_D, 'D-seed');
  const seeded = snapshotPartState(harness);
  check(
    seeded.workItems.length === 1 &&
      seeded.decisions.length === 1 &&
      seeded.milestones.length === 2,
    'D-seed: one work item, one decision and two milestones persisted before resume',
  );
  reportTrace(
    'D-seed',
    seedPlan,
    `, workItems=${seeded.workItems.length}, decisions=${seeded.decisions.length}, milestones=${seeded.milestones.length}`,
  );

  const sessionFile = harness.session.sessionFile;
  if (typeof sessionFile !== 'string') {
    throw new Error('D-seed did not expose a file-backed session file');
  }
  harness.cleanup();
  const resumeManager = SessionManager.open(sessionFile);
  const resumed = await createIsolatedSession({
    isolation,
    storage: 'file',
    sessionManager: resumeManager,
    additionalExtensionPaths: [SUPERVISOR_EXTENSION_PATH],
    expectedExtensionPath: SUPERVISOR_EXTENSION_PATH,
    tools: [...BUILTIN_TOOL_NAMES],
    sessionStartEvent: {
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: sessionFile,
    },
  });
  cleanup.registerCleanup(resumed.cleanup);
  assertProductionExtension(check, resumed, 'D-resume');
  check(
    resumed.session.sessionFile === sessionFile,
    'D-resume: reopened the same session file through the public SessionManager',
  );

  const restored = snapshotPartState(resumed);
  check(
    restored.stateData !== undefined &&
      restored.stateData.objective === PART_D.objective &&
      JSON.stringify(restored.workItems) === JSON.stringify(seeded.workItems) &&
      JSON.stringify(restored.decisions) === JSON.stringify(seeded.decisions),
    'D-resume: the Auto State snapshot was restored from the session file',
  );
  check(
    JSON.stringify(restored.milestones) === JSON.stringify(seeded.milestones),
    'D-resume: the auto-progress baseline was restored from the session file',
  );

  const replayHarness = { ...resumed };
  const script = scriptForPart(PART_D);
  const plan = await runPlan(replayHarness, script.prompt, script.steps);
  const status = await captureStatus(replayHarness, 'D-replay final status');
  assertPlanShape(check, plan, SHARED_RUN_SHAPE, 'D-replay');
  check(
    plan.uiMessagesAfter === plan.uiMessagesBefore &&
      parseCurrentRoot(status.text)?.status === 'settled',
    'D-replay: supported completion-gate verdict stayed silent with zero automatic follow-ups',
  );
  checkHealthyAssessment(check, status, 'D-replay');
  const replayed = snapshotPartState(resumed);
  check(
    JSON.stringify(replayed.workItems) === JSON.stringify(seeded.workItems) &&
      JSON.stringify(replayed.decisions) === JSON.stringify(seeded.decisions),
    'D-replay: identical candidates produced no duplicate work item or decision',
  );
  check(
    JSON.stringify(replayed.milestones) === JSON.stringify(seeded.milestones),
    'D-replay: identical evidence produced no false progress',
  );
  check(
    parseCurrentRoot(status.text)?.id !== 'root-1',
    'D-replay: the resumed session continued the persisted root sequence',
  );
  reportTrace(
    'D-replay',
    plan,
    `, workItems=${replayed.workItems.length}, decisions=${replayed.decisions.length}, milestones=${replayed.milestones.length}`,
  );
}

async function runPartE(check, cleanup) {
  console.log('  PART E — observe mode');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'E');
  await runCommand(harness, `/agent-supervisor feature ${AUTO_STATE_ID} observe`, 'E auto-state observe');
  await runCommand(harness, `/agent-supervisor feature ${AUTO_PROGRESS_ID} observe`, 'E auto-progress observe');

  const before = snapshotPartState(harness);
  check(
    before.stateData === undefined && before.milestones.length === 0,
    'E: no auto-state or auto-progress state was persisted before the observe run',
  );
  const { plan } = await runSharedScript(check, harness, isolation, PART_E, 'E-observe', 'observe');
  const observed = snapshotPartState(harness);
  check(
    observed.stateData === undefined && observed.milestones.length === 0,
    'E: neither observe-mode feature emitted a persisted nextState',
  );
  reportTrace(
    'E-observe',
    plan,
    `, workItems=${observed.workItems.length}, decisions=${observed.decisions.length}, milestones=${observed.milestones.length}`,
  );

  await runCommand(harness, `/agent-supervisor feature ${AUTO_STATE_ID} autonomous`, 'E auto-state autonomous');
  await runCommand(harness, `/agent-supervisor feature ${AUTO_PROGRESS_ID} autonomous`, 'E auto-progress autonomous');
  const { plan: replayPlan } = await runSharedScript(check, harness, isolation, PART_E, 'E-replay');
  const replayed = snapshotPartState(harness);
  check(
    replayed.workItems.length === 1 &&
      replayed.decisions.length === 1 &&
      replayed.milestones.length === 2,
    'E-replay: the same candidates persisted once autonomous, proving the observe run computed shadow verdicts without persisting',
  );
  reportTrace(
    'E-replay',
    replayPlan,
    `, workItems=${replayed.workItems.length}, decisions=${replayed.decisions.length}, milestones=${replayed.milestones.length}`,
  );
}

async function runPartF(check, cleanup) {
  console.log('  PART F — off mode');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'F');
  await runCommand(harness, `/agent-supervisor feature ${AUTO_STATE_ID} off`, 'F auto-state off');
  await runCommand(harness, `/agent-supervisor feature ${AUTO_PROGRESS_ID} off`, 'F auto-progress off');

  const script = scriptForPart(PART_F);
  const plan = await runPlan(harness, script.prompt, script.steps);
  const status = await captureStatus(harness, 'F final status');
  assertPlanShape(
    check,
    plan,
    SHARED_RUN_SHAPE,
    'F',
  );
  check(
    plan.toolCalls.map((call) => call.name).join(',') === 'write,read' &&
      plan.toolResults.length === 2 &&
      plan.toolResults.every((result) => result.isError === false) &&
      messageText(plan.toolResults[1]) === PART_F.content &&
      existsSync(join(isolation.workDir, PART_F.path)),
    'F: real write/read completed while both auto features were off',
  );
  check(
    plan.uiMessagesAfter === plan.uiMessagesBefore,
    'F: completion-gate stayed silent with zero automatic follow-ups',
  );
  check(
    status.text.includes('Assessment: success'),
    'F: the shared assessment still ran once because completion-gate consumes it',
  );
  check(
    featureMatches(
      status.text,
      AUTO_STATE_ID,
      /requested=off, effective=off, runtime=off, status=off\b/u,
    ) &&
      featureMatches(
        status.text,
        AUTO_PROGRESS_ID,
        /requested=off, effective=off, runtime=off, status=off\b/u,
      ) &&
      featureMatches(
        status.text,
        COMPLETION_GATE_ID,
        /requested=autonomous, effective=autonomous, runtime=autonomous, status=active\b/u,
      ),
    'F: both auto features are off while completion-gate stays autonomous',
  );
  const snap = snapshotPartState(harness);
  check(
    snap.stateData === undefined && snap.milestones.length === 0,
    'F: no auto-state fact, no auto-progress fact and no feature state change while off',
  );
  reportTrace(
    'F',
    plan,
    `, workItems=${snap.workItems.length}, decisions=${snap.decisions.length}, milestones=${snap.milestones.length}`,
  );
}

async function runPartG(check, cleanup) {
  console.log('  PART G — malformed state domain isolation');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'G');
  const script = {
    prompt: PART_G.prompt,
    steps: [
      agentTool('write', { path: PART_G.path, content: PART_G.content }, 'G-write'),
      agentTool('read', { path: PART_G.path }, 'G-read'),
      agentText(PART_G.finalText),
      auxResponse(
        fullAuxPayload({
          claim: PART_G.claim,
          evidenceQuote: PART_G.content,
          state: { bogus: 1 },
          progress: progressDomain(),
        }),
      ),
    ],
  };
  const plan = await runPlan(harness, script.prompt, script.steps);
  const status = await captureStatus(harness, 'G final status');
  assertPlanShape(check, plan, SHARED_RUN_SHAPE, 'G');
  check(
    plan.uiMessagesAfter === plan.uiMessagesBefore &&
      parseCurrentRoot(status.text)?.status === 'settled',
    'G: completion-gate still reached a silent supported verdict despite the malformed state domain',
  );
  checkHealthyAssessment(check, status, 'G');
  checkFeatureTrio(check, status, 'G');
  const snap = snapshotPartState(harness);
  check(
    snap.stateData === undefined,
    'G: auto-state stayed unchanged when its domain was malformed',
  );
  check(
    snap.milestones.length === 2 &&
      JSON.stringify(milestoneKinds(snap.milestones)) ===
        JSON.stringify(['auto:implementation', 'auto:verification']),
    'G: auto-progress still recorded both milestones from its valid domain',
  );
  void isolation;
  reportTrace(
    'G',
    plan,
    `, workItems=${snap.workItems.length}, decisions=${snap.decisions.length}, milestones=${snap.milestones.length}`,
  );
}

async function runPartH(check, cleanup) {
  console.log('  PART H — malformed progress domain isolation');
  const { harness } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'H');
  const script = {
    prompt: PART_H.prompt,
    steps: [
      agentTool('write', { path: PART_H.path, content: PART_H.content }, 'H-write'),
      agentTool('read', { path: PART_H.path }, 'H-read'),
      agentText(PART_H.finalText),
      auxResponse(
        fullAuxPayload({
          claim: PART_H.claim,
          evidenceQuote: PART_H.content,
          state: stateDomain(PART_H.objective, PART_H.work, PART_H.decision),
          progress: [{ kind: 'implementation', evidence: ['e-invented'] }],
        }),
      ),
    ],
  };
  const plan = await runPlan(harness, script.prompt, script.steps);
  const status = await captureStatus(harness, 'H final status');
  assertPlanShape(check, plan, SHARED_RUN_SHAPE, 'H');
  check(
    plan.uiMessagesAfter === plan.uiMessagesBefore &&
      parseCurrentRoot(status.text)?.status === 'settled',
    'H: completion-gate still reached a silent supported verdict despite the malformed progress domain',
  );
  checkHealthyAssessment(check, status, 'H');
  checkFeatureTrio(check, status, 'H');
  const snap = snapshotPartState(harness);
  check(
    snap.workItems.length === 1 &&
      snap.workItems[0]?.content === PART_H.work &&
      snap.decisions.length === 1 &&
      snap.decisions[0]?.content === PART_H.decision,
    'H: auto-state still persisted its work item and decision from its valid domain',
  );
  check(
    snap.milestones.length === 0,
    'H: auto-progress stayed unchanged when its domain referenced invented evidence',
  );
  reportTrace(
    'H',
    plan,
    `, workItems=${snap.workItems.length}, decisions=${snap.decisions.length}, milestones=${snap.milestones.length}`,
  );
}

async function runPartI(check, cleanup) {
  console.log('  PART I — evidence-only milestone rule');
  {
    const { harness } = await createProductionHarness(cleanup);
    assertProductionExtension(check, harness, 'I1');
    const plan = await runPlan(harness, PART_I1.prompt, [
      agentTool('write', { path: PART_I1.path, content: PART_I1.content }, 'I1-write'),
      agentTool('read', { path: PART_I1.path }, 'I1-read'),
      agentText(PART_I1.finalText),
      auxResponse(
        fullAuxPayload({
          claim: PART_I1.claim,
          evidenceQuote: PART_I1.content,
          progress: [{ kind: 'implementation', evidence: ['e-invented'] }],
        }),
      ),
    ]);
    const status = await captureStatus(harness, 'I1 final status');
    assertPlanShape(check, plan, SHARED_RUN_SHAPE, 'I1');
    check(
      plan.uiMessagesAfter === plan.uiMessagesBefore,
      'I1: completion-gate stayed silent while the progress candidate referenced invented evidence',
    );
    checkHealthyAssessment(check, status, 'I1');
    const snap = snapshotPartState(harness);
    check(
      snap.milestones.length === 0,
      'I1: a progress candidate over invented evidence recorded no milestone and no false progress',
    );
    reportTrace('I1', plan, `, milestones=${snap.milestones.length}`);
  }
  {
    const { harness } = await createProductionHarness(cleanup);
    assertProductionExtension(check, harness, 'I2');
    const plan = await runPlan(harness, PART_I2.prompt, [
      agentTool('write', { path: PART_I2.path, content: PART_I2.content }, 'I2-write'),
      agentTool('read', { path: PART_I2.path }, 'I2-read'),
      agentText(PART_I2.finalText),
      auxResponse(
        fullAuxPayload({
          claim: PART_I2.claim,
          evidenceQuote: PART_I2.content,
          progress: [{ kind: 'implementation', evidence: ['e2'] }],
        }),
      ),
    ]);
    const status = await captureStatus(harness, 'I2 final status');
    assertPlanShape(check, plan, SHARED_RUN_SHAPE, 'I2');
    check(
      plan.uiMessagesAfter === plan.uiMessagesBefore,
      'I2: completion-gate stayed silent while the implementation candidate cited only read evidence',
    );
    checkHealthyAssessment(check, status, 'I2');
    const snap = snapshotPartState(harness);
    check(
      snap.milestones.length === 0,
      'I2: an implementation candidate without mutation evidence recorded no milestone and no false progress',
    );
    reportTrace('I2', plan, `, milestones=${snap.milestones.length}`);
  }
}

export const name = 'auto-state-progress';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { cleanupAll } = cleanup;

  try {
    await runPartABC(check, cleanup);
    await runPartD(check, cleanup);
    await runPartE(check, cleanup);
    await runPartF(check, cleanup);
    await runPartG(check, cleanup);
    await runPartH(check, cleanup);
    await runPartI(check, cleanup);
    return result.status === 'pass'
      ? {
          status: 'pass',
          reason:
            'auto-state-progress production scenario verified across nine labelled parts ' +
            '(auxiliaryCalls A=1, B=1, C=1, D-seed=1, D-replay=1, E-observe=1, E-replay=1, F=1, G=1, H=1, I1=1, I2=1)',
        }
      : { status: 'fail', reason: 'auto-state-progress scenario assertions failed' };
  } finally {
    await cleanupAll();
  }
}
