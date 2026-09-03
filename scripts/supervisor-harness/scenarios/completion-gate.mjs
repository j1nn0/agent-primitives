/* global console */

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
const RETRY_LOOP_BREAKER_ID = 'retry-loop-breaker';
const FOLLOW_UP_MESSAGE =
  'Agent Supervisor: the previous completion claim is not supported by current verification evidence. Run an appropriate post-change verification using available tools, inspect the result, and only claim completion when the observed evidence supports it.';
const C_TEST_MARKER = 'completion-gate-C-verification';
const C_PACKAGE_CONTENT = JSON.stringify({
  scripts: { test: `node -e 'console.log("${C_TEST_MARKER}")'` },
});

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

function assessmentResponse(quote, evidence = []) {
  return {
    kind: AUXILIARY_ASSESSMENT_CALL_KIND,
    message: fauxAssistantMessage(
      fauxText(
        JSON.stringify({
          schemaVersion: 1,
          claims: [{ kind: 'completion', quote, evidence }],
        }),
      ),
    ),
  };
}

async function createProductionHarness(cleanup, { customTools = [], tools } = {}) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const activeTools = tools === undefined ? [...BUILTIN_TOOL_NAMES] : [...tools];
  for (const tool of customTools) {
    if (!activeTools.includes(tool.name)) {
      activeTools.push(tool.name);
    }
  }
  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    additionalExtensionPaths: [SUPERVISOR_EXTENSION_PATH],
    expectedExtensionPath: SUPERVISOR_EXTENSION_PATH,
    tools: activeTools,
    customTools,
  });
  cleanup.registerCleanup(harness.cleanup);
  return { harness, isolation };
}

function assertProductionExtension(check, harness, label, requireBuiltinTools = true) {
  const extension = harness.extensionsResult.extensions[0];
  check(
    harness.extensionsResult.extensions.length === 1 &&
      extension?.resolvedPath === SUPERVISOR_EXTENSION_PATH &&
      harness.extensionsResult.errors.length === 0 &&
      extension?.commands.has('agent-supervisor') &&
      extension.tools.size === 0,
    `${label}: loaded only the production Supervisor extension with no loader errors`,
  );
  if (requireBuiltinTools) {
    const tools = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool]));
    check(
      BUILTIN_TOOL_NAMES.every((name) => tools.get(name)?.sourceInfo?.source === 'builtin'),
      `${label}: mutation and verification use real Pi builtin tool registrations`,
    );
  }
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

function parseCurrentRoot(text) {
  const match = /^Current root: ([^\s]+) \(([^)]+)\)$/mu.exec(text);
  return match === null ? undefined : { id: match[1], status: match[2] };
}

async function captureStatus(harness, label) {
  const command = await runCommand(harness, '/agent-supervisor status', label);
  if (!command.text.includes('Agent Supervisor')) {
    throw new Error(`status command returned no Supervisor output at ${label}`);
  }
  harness.assertNoAuthCredentials();
  return {
    ...command,
    currentRoot: parseCurrentRoot(command.text),
  };
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

function firstUserText(agentEnd) {
  const userMessage = (agentEnd.messages ?? []).find((message) => message?.role === 'user');
  return messageText(userMessage);
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
  const agentEnds = events.filter((event) => event?.type === 'agent_end');
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
    agentEnds,
    agentEndUserTexts: agentEnds.map(firstUserText),
    runSequences: agentEnds.map((_event, index) => index + 1),
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
    `${label}: modelCalls=${expected.modelCalls}, runs=${expected.runs}, auxiliaryCalls=${expected.auxiliaryCalls}, followUps=${expected.followUps}`,
  );
  check(
    plan.callsAfter - plan.callsBefore === plan.callKinds.length,
    `${label}: every faux model call consumed one scripted response`,
  );
}

function reportTrace(label, plan, verdicts, extra = '') {
  console.log(
    `  TRACE completion-gate ${label}: verdicts=${verdicts}, modelCalls=${plan.modelCalls}, runs=${plan.runs}, auxiliaryCalls=${plan.auxiliaryCalls}, followUps=${plan.followUps}${extra}`,
  );
}

async function runPartA(check, cleanup) {
  console.log('  PART A — supported completion is silent');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'A');
  const path = 'completion-gate-A.txt';
  const content = 'completion-gate-A-content';
  const finalText = 'Part A completion is supported.';
  const plan = await runPlan(harness, 'Write and read the file, then claim completion.', [
    agentTool('write', { path, content }, 'A-write'),
    agentTool('read', { path }, 'A-read'),
    agentText(finalText),
    assessmentResponse(finalText, [{ id: 'e2', quote: content }]),
  ]);
  const status = await captureStatus(harness, 'part A final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 4,
      agentModelCalls: 3,
      auxiliaryCalls: 1,
      runs: 1,
      followUps: 0,
      callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND, AGENT_CALL_KIND, AUXILIARY_ASSESSMENT_CALL_KIND],
    },
    'A',
  );
  check(
    plan.toolResults.length === 2 &&
      plan.toolResults.every((result) => result.isError === false) &&
      messageText(plan.toolResults[1]) === content &&
      existsSync(join(isolation.workDir, path)) &&
      readFileSync(join(isolation.workDir, path), 'utf8') === content,
    'A: real write/read completed and the assessment linked the successful post-mutation read-back',
  );
  check(
    plan.toolCalls.map((call) => call.name).join(',') === 'write,read' &&
      plan.uiMessagesAfter === plan.uiMessagesBefore &&
      status.text.includes('Assessment: success') &&
      status.currentRoot?.id === 'root-1' &&
      status.currentRoot.status === 'settled',
    'A: supported verdict stayed silent with zero automatic follow-ups',
  );
  reportTrace('A', plan, 'supported');
}

async function runPartB(check, cleanup) {
  console.log('  PART B — unsupported completion auto-verifies once');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'B');
  const path = 'completion-gate-B.txt';
  const content = 'completion-gate-B-content';
  const initialText = 'Part B completion is claimed.';
  const followUpText = 'Part B verification completed.';
  const initialPrompt = 'Write the file and claim completion without verification evidence.';
  const plan = await runPlan(harness, initialPrompt, [
    agentTool('write', { path, content }, 'B-write'),
    agentText(initialText),
    assessmentResponse(initialText),
    agentTool('read', { path }, 'B-read'),
    agentText(followUpText),
    assessmentResponse(followUpText, [{ id: 'e2', quote: content }]),
  ]);
  const status = await captureStatus(harness, 'part B final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 6,
      agentModelCalls: 4,
      auxiliaryCalls: 2,
      runs: 2,
      followUps: 1,
      callKinds: [
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
      ],
    },
    'B',
  );
  check(
    plan.toolResults.length === 2 &&
      plan.toolResults.every((result) => result.isError === false) &&
      messageText(plan.toolResults[1]) === content &&
      readFileSync(join(isolation.workDir, path), 'utf8') === content,
    'B: the automatic follow-up used a real read and observed the changed file',
  );
  check(
    plan.runs === 2 &&
      plan.agentEnds.length === 2 &&
      plan.runSequences[0] === 1 &&
      plan.runSequences[1] === 2 &&
      plan.agentEndUserTexts[0] === initialPrompt &&
      plan.agentEndUserTexts[1] === FOLLOW_UP_MESSAGE &&
      plan.followUps === 1 &&
      status.currentRoot?.id === 'root-1' &&
      status.currentRoot.status === 'settled' &&
      status.text.includes('Assessment: success'),
    'B: both runs stayed in Root Request root-1 with distinct run sequences and exactly one follow-up',
  );
  reportTrace('B', plan, 'run1:unsupported/missing_evidence,run2:supported');
}

async function runPartC(check, cleanup) {
  console.log('  PART C — mutation after verification invalidates stale evidence');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'C');
  const path = 'completion-gate-C.txt';
  const content = 'completion-gate-C-target';
  const initialText = 'Part C completion is claimed from the earlier verification.';
  const followUpText = 'Part C verification completed after the mutation.';
  const plan = await runPlan(harness, 'Verify, mutate the target, and claim completion from the earlier verification.', [
    agentTool('write', { path: 'package.json', content: C_PACKAGE_CONTENT }, 'C-setup'),
    agentTool('bash', { command: 'pnpm test' }, 'C-test'),
    agentTool('write', { path, content }, 'C-write'),
    agentText(initialText),
    assessmentResponse(initialText, [{ id: 'e2', quote: C_TEST_MARKER }]),
    agentTool('read', { path: 'package.json' }, 'C-read-package'),
    agentTool('read', { path }, 'C-read-target'),
    agentText(followUpText),
    assessmentResponse(followUpText, [{ id: 'e5', quote: content }]),
  ]);
  const status = await captureStatus(harness, 'part C final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 9,
      agentModelCalls: 7,
      auxiliaryCalls: 2,
      runs: 2,
      followUps: 1,
      callKinds: [
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
      ],
    },
    'C',
  );
  const bashResult = plan.toolResults.find((result) => result.toolName === 'bash');
  const targetReadResult = plan.toolResults.find(
    (result) => result.toolName === 'read' && messageText(result) === content,
  );
  check(
    plan.toolCalls.map((call) => call.name).join(',') === 'write,bash,write,read,read' &&
      plan.toolResults.length === 5 &&
      plan.toolResults.every((result) => result.isError === false) &&
      bashResult !== undefined &&
      messageText(bashResult).includes(C_TEST_MARKER) &&
      targetReadResult !== undefined &&
      readFileSync(join(isolation.workDir, path), 'utf8') === content,
    'C: a real successful test preceded a real write, then both mutated paths were read back',
  );
  check(
    plan.followUps === 1 &&
      plan.agentEnds.length === 2 &&
      plan.agentEndUserTexts[1] === FOLLOW_UP_MESSAGE &&
      status.currentRoot?.id === 'root-1' &&
      status.text.includes('Assessment: success'),
    'C: the pre-write recognized verification produced subject_mismatch and one automatic follow-up',
  );
  reportTrace('C', plan, 'run1:unsupported/subject_mismatch,run2:supported');
}

async function runPartD(check, cleanup) {
  console.log('  PART D — failed verification contradicts completion');
  const { harness, isolation } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'D');
  const path = 'completion-gate-D.txt';
  const content = 'completion-gate-D-target';
  const initialText = 'Part D completion despite failed verification.';
  const followUpText = 'Part D verification completed after inspection.';
  const plan = await runPlan(harness, 'Write, run the failing verification, and claim completion.', [
    agentTool('write', { path, content }, 'D-write'),
    agentTool('bash', { command: 'pnpm test' }, 'D-test'),
    agentText(initialText),
    assessmentResponse(initialText, [{ id: 'e2', quote: 'Command exited with code 1' }]),
    agentTool('read', { path }, 'D-read'),
    agentText(followUpText),
    assessmentResponse(followUpText, [{ id: 'e3', quote: content }]),
  ]);
  const status = await captureStatus(harness, 'part D final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 7,
      agentModelCalls: 5,
      auxiliaryCalls: 2,
      runs: 2,
      followUps: 1,
      callKinds: [
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
      ],
    },
    'D',
  );
  const failedVerification = plan.toolResults.find((result) => result.toolName === 'bash');
  check(
    plan.toolResults.length === 3 &&
      plan.toolResults[0]?.toolName === 'write' &&
      plan.toolResults[0]?.isError === false &&
      failedVerification?.isError === true &&
      messageText(failedVerification).includes('Command exited with code 1') &&
      plan.toolResults[2]?.toolName === 'read' &&
      plan.toolResults[2]?.isError === false &&
      messageText(plan.toolResults[2]) === content &&
      readFileSync(join(isolation.workDir, path), 'utf8') === content,
    'D: the real verification command failed, was linked as evidence, and the follow-up inspected the file',
  );
  check(
    plan.followUps === 1 &&
      plan.agentEnds.length === 2 &&
      plan.agentEndUserTexts[1] === FOLLOW_UP_MESSAGE &&
      status.currentRoot?.id === 'root-1' &&
      status.text.includes('Assessment: success'),
    'D: the failed current verification produced contradicted and one automatic follow-up',
  );
  reportTrace('D', plan, 'run1:contradicted,run2:supported');
}

async function runPartE(check, cleanup) {
  console.log('  PART E — the Root Request follow-up hard limit is one');
  const { harness } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'E');
  const path = 'completion-gate-E.txt';
  const content = 'completion-gate-E-content';
  const firstText = 'Part E first completion claim.';
  const secondText = 'Part E second completion claim is still unsupported.';
  const initialPrompt = 'Write the file and claim completion without evidence twice.';
  const plan = await runPlan(harness, initialPrompt, [
    agentTool('write', { path, content }, 'E-write'),
    agentText(firstText),
    assessmentResponse(firstText),
    agentText(secondText),
    assessmentResponse(secondText),
  ]);
  const status = await captureStatus(harness, 'part E final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 5,
      agentModelCalls: 3,
      auxiliaryCalls: 2,
      runs: 2,
      followUps: 1,
      callKinds: [
        AGENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
        AGENT_CALL_KIND,
        AUXILIARY_ASSESSMENT_CALL_KIND,
      ],
    },
    'E',
  );
  check(
    plan.toolResults.length === 1 &&
      plan.toolResults[0]?.toolName === 'write' &&
      plan.toolResults[0]?.isError === false &&
      plan.agentEnds.length === 2 &&
      plan.agentEndUserTexts[0] === initialPrompt &&
      plan.agentEndUserTexts[1] === FOLLOW_UP_MESSAGE &&
      plan.runs === 2 &&
      plan.followUps === 1 &&
      status.currentRoot?.id === 'root-1' &&
      status.text.includes('Assessment: success'),
    'E: both assessments remained unsupported, but there was no second follow-up or third run',
  );
  reportTrace('E', plan, 'run1:unsupported/missing_evidence,run2:unsupported/missing_evidence', ', unboundedContinuation=0');
}

async function runPartF(check, cleanup) {
  console.log('  PART F — feature and global modes');

  {
    const { harness } = await createProductionHarness(cleanup);
    assertProductionExtension(check, harness, 'F1');
    await runCommand(harness, '/agent-supervisor feature completion-gate observe', 'F1 mode command');
    const finalText = 'F1 completion is unsupported in observe mode.';
    const plan = await runPlan(harness, 'Write and claim completion in feature observe mode.', [
      agentTool('write', { path: 'completion-gate-F1.txt', content: 'F1' }, 'F1-write'),
      agentText(finalText),
      assessmentResponse(finalText),
    ]);
    const status = await captureStatus(harness, 'part F1 final status');
    assertPlanShape(
      check,
      plan,
      {
        modelCalls: 3,
        agentModelCalls: 2,
        auxiliaryCalls: 1,
        runs: 1,
        followUps: 0,
        callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND, AUXILIARY_ASSESSMENT_CALL_KIND],
      },
      'F1',
    );
    check(
      featureMatches(
        status.text,
        COMPLETION_GATE_ID,
        /requested=observe, effective=observe, runtime=observe, status=active\b/u,
      ) &&
        featureMatches(
          status.text,
          RETRY_LOOP_BREAKER_ID,
          /requested=autonomous, effective=autonomous, runtime=autonomous, status=active\b/u,
        ) &&
        status.text.includes('Assessment: success') &&
        plan.followUps === 0,
      'F1: completion-gate observe still assessed but emitted no follow-up',
    );
    reportTrace('F1', plan, 'unsupported/missing_evidence (observed only)');
  }

  {
    const { harness } = await createProductionHarness(cleanup);
    assertProductionExtension(check, harness, 'F2');
    await runCommand(harness, '/agent-supervisor feature completion-gate off', 'F2 mode command');
    const finalText = 'F2 completion is not assessed while completion-gate is off.';
    const plan = await runPlan(harness, 'Write and claim completion with completion-gate off.', [
      agentTool('write', { path: 'completion-gate-F2.txt', content: 'F2' }, 'F2-write'),
      agentText(finalText),
    ]);
    const status = await captureStatus(harness, 'part F2 final status');
    assertPlanShape(
      check,
      plan,
      {
        modelCalls: 2,
        agentModelCalls: 2,
        auxiliaryCalls: 0,
        runs: 1,
        followUps: 0,
        callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND],
      },
      'F2',
    );
    check(
      featureMatches(
        status.text,
        COMPLETION_GATE_ID,
        /requested=off, effective=off, runtime=off, status=off\b/u,
      ) &&
        featureMatches(
          status.text,
          RETRY_LOOP_BREAKER_ID,
          /requested=autonomous, effective=autonomous, runtime=autonomous, status=active\b/u,
        ) &&
        status.text.includes('Assessment: idle') &&
        plan.toolResults.length === 1 &&
        plan.toolResults[0]?.isError === false,
      'F2: completion-gate off made zero auxiliary calls while retry-loop-breaker remained active',
    );
    reportTrace('F2', plan, 'not-assessed');
  }

  {
    const { harness } = await createProductionHarness(cleanup);
    assertProductionExtension(check, harness, 'F3');
    await runCommand(harness, '/agent-supervisor mode observe', 'F3 mode command');
    const finalText = 'F3 completion is unsupported in global observe mode.';
    const plan = await runPlan(harness, 'Write and claim completion in global observe mode.', [
      agentTool('write', { path: 'completion-gate-F3.txt', content: 'F3' }, 'F3-write'),
      agentText(finalText),
      assessmentResponse(finalText),
    ]);
    const status = await captureStatus(harness, 'part F3 final status');
    assertPlanShape(
      check,
      plan,
      {
        modelCalls: 3,
        agentModelCalls: 2,
        auxiliaryCalls: 1,
        runs: 1,
        followUps: 0,
        callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND, AUXILIARY_ASSESSMENT_CALL_KIND],
      },
      'F3',
    );
    check(
      featureMatches(
        status.text,
        COMPLETION_GATE_ID,
        /requested=autonomous, effective=observe, runtime=observe, status=active reason=global-observe/u,
      ) &&
        featureMatches(
          status.text,
          RETRY_LOOP_BREAKER_ID,
          /requested=autonomous, effective=observe, runtime=observe, status=active reason=global-observe/u,
        ) &&
        status.text.includes('Effective global mode: observe') &&
        status.text.includes('Assessment: success') &&
        plan.followUps === 0,
      'F3: global observe assessed the completion claim but suppressed follow-up',
    );
    reportTrace('F3', plan, 'unsupported/missing_evidence (observed only)');
  }

  {
    const { harness } = await createProductionHarness(cleanup);
    assertProductionExtension(check, harness, 'F4');
    await runCommand(harness, '/agent-supervisor mode off', 'F4 mode command');
    const finalText = 'F4 completion is not assessed in global off mode.';
    const plan = await runPlan(harness, 'Write and claim completion in global off mode.', [
      agentTool('write', { path: 'completion-gate-F4.txt', content: 'F4' }, 'F4-write'),
      agentText(finalText),
    ]);
    const status = await captureStatus(harness, 'part F4 final status');
    assertPlanShape(
      check,
      plan,
      {
        modelCalls: 2,
        agentModelCalls: 2,
        auxiliaryCalls: 0,
        runs: 1,
        followUps: 0,
        callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND],
      },
      'F4',
    );
    check(
      featureMatches(
        status.text,
        COMPLETION_GATE_ID,
        /requested=autonomous, effective=off, runtime=off, status=off reason=global-off/u,
      ) &&
        featureMatches(
          status.text,
          RETRY_LOOP_BREAKER_ID,
          /requested=autonomous, effective=off, runtime=off, status=off reason=global-off/u,
        ) &&
        status.text.includes('Effective global mode: off') &&
        status.text.includes('Assessment: idle') &&
        plan.followUps === 0,
      'F4: global off disabled assessment and follow-up entirely',
    );
    reportTrace('F4', plan, 'not-assessed');
  }
}

async function runPartG(check, cleanup) {
  console.log('  PART G — pure non-mutation completion wording stays silent');
  const { harness } = await createProductionHarness(cleanup);
  assertProductionExtension(check, harness, 'G');
  const finalText = 'Part G: the completion is complete even without a mutation.';
  const plan = await runPlan(harness, 'Answer the question without changing files.', [
    agentText(finalText),
    assessmentResponse(finalText),
  ]);
  const status = await captureStatus(harness, 'part G final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 2,
      agentModelCalls: 1,
      auxiliaryCalls: 1,
      runs: 1,
      followUps: 0,
      callKinds: [AGENT_CALL_KIND, AUXILIARY_ASSESSMENT_CALL_KIND],
    },
    'G',
  );
  check(
    plan.toolResults.length === 0 &&
      plan.toolCalls.length === 0 &&
      plan.auxiliaryCalls === 1 &&
      plan.followUps === 0 &&
      status.text.includes('Assessment: success') &&
      status.currentRoot?.id === 'root-1',
    'G: the active feature made its one real auxiliary assessment call but stayed not-applicable and silent',
  );
  reportTrace('G', plan, 'not-applicable/silent');
}

function createShadowWrite(executions) {
  return {
    name: 'write',
    label: 'Completion Gate Shadow Write',
    description: 'Test-only custom tool that shadows the Pi builtin write name.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute: async (toolCallId, input) => {
      executions.push({ toolCallId, input });
      return {
        content: [{ type: 'text', text: 'shadow write accepted without touching the filesystem' }],
      };
    },
  };
}

async function runPartH(check, cleanup) {
  console.log('  PART H — builtin provenance is not a tool-name guess');
  const executions = [];
  const shadowWrite = createShadowWrite(executions);
  const { harness, isolation } = await createProductionHarness(cleanup, {
    customTools: [shadowWrite],
    tools: ['write'],
  });
  assertProductionExtension(check, harness, 'H', false);
  const registeredWrite = harness.session.getAllTools().find((tool) => tool.name === 'write');
  check(
    registeredWrite?.sourceInfo?.source === 'sdk' &&
      registeredWrite.sourceInfo.path === '<sdk:write>' &&
      harness.session.getActiveToolNames().join(',') === 'write',
    'H: the public harness exposed the custom SDK write shadow rather than the builtin registration',
  );
  const path = 'completion-gate-H.txt';
  const finalText = 'Part H completion wording is present.';
  const plan = await runPlan(harness, 'Use the shadow write and claim completion.', [
    agentTool('write', { path, content: 'shadow-content' }, 'H-shadow-write'),
    agentText(finalText),
    assessmentResponse(finalText),
  ]);
  const status = await captureStatus(harness, 'part H final status');
  assertPlanShape(
    check,
    plan,
    {
      modelCalls: 3,
      agentModelCalls: 2,
      auxiliaryCalls: 1,
      runs: 1,
      followUps: 0,
      callKinds: [AGENT_CALL_KIND, AGENT_CALL_KIND, AUXILIARY_ASSESSMENT_CALL_KIND],
    },
    'H',
  );
  check(
    executions.length === 1 &&
      plan.toolResults.length === 1 &&
      plan.toolResults[0]?.isError === false &&
      messageText(plan.toolResults[0]).includes('shadow write accepted') &&
      !existsSync(join(isolation.workDir, path)) &&
      plan.followUps === 0 &&
      status.text.includes('Assessment: success'),
    'H: the name-shadowed write did not advance trusted mutation state or trigger a follow-up',
  );
  reportTrace('H', plan, 'not-applicable/silent', ', shadowSource=sdk');
}

export const name = 'completion-gate';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { cleanupAll } = cleanup;

  try {
    await runPartA(check, cleanup);
    await runPartB(check, cleanup);
    await runPartC(check, cleanup);
    await runPartD(check, cleanup);
    await runPartE(check, cleanup);
    await runPartF(check, cleanup);
    await runPartG(check, cleanup);
    await runPartH(check, cleanup);
    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: 'completion-gate production scenario verified across eight labelled parts',
        }
      : { status: 'fail', reason: 'completion-gate scenario assertions failed' };
  } finally {
    await cleanupAll();
  }
}
