/* global console */

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

const TARGET_TOOL_NAME = 'supervisor_harness_retry_loop_target';
const TARGET_INPUT_A = 'same-input';
const TARGET_INPUT_B = 'different-invocation';
const SAME_FAILURE = 'retry-loop-breaker harness deterministic failure';
const DIFFERENT_FAILURE_X = 'retry-loop-breaker harness error X';
const DIFFERENT_FAILURE_Y = 'retry-loop-breaker harness error Y';
const BLOCK_MESSAGE =
  'Agent Supervisor: this exact tool invocation already failed twice with the same result. Change strategy before retrying it unchanged.';
const FEATURE_ID = 'retry-loop-breaker';
// The production profile intentionally gained completion-gate as an assessment consumer.
const AGENT_CALL_KIND = 'AGENT';
const AUXILIARY_ASSESSMENT_CALL_KIND = 'AUXILIARY_ASSESSMENT';
const NO_CLAIM_ASSESSMENT_RESPONSE = JSON.stringify({ schemaVersion: 1, claims: [] });

function notifyText(messages) {
  return messages
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

function createTargetInput(value = TARGET_INPUT_A) {
  return { value };
}

function createTargetTool(executions, errorMessages = [SAME_FAILURE]) {
  if (!Array.isArray(errorMessages) || errorMessages.length === 0) {
    throw new Error('retry-loop-breaker target requires at least one error result');
  }

  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Retry Loop Target',
    description: 'Deterministic failing target tool for the retry-loop-breaker runtime proof.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    execute: async (toolCallId, input) => {
      const resultIndex = Math.min(executions.length, errorMessages.length - 1);
      const errorText = errorMessages[resultIndex];
      executions.push({ toolCallId, input, errorText });
      throw new Error(errorText);
    },
  };
}

async function createProductionHarness(cleanup, executions, errorMessages) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const customTools =
    executions === undefined
      ? []
      : [createTargetTool(executions, errorMessages)];
  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    additionalExtensionPaths: [SUPERVISOR_EXTENSION_PATH],
    expectedExtensionPath: SUPERVISOR_EXTENSION_PATH,
    customTools,
  });
  cleanup.registerCleanup(harness.cleanup);
  return harness;
}

function parseStatus(output, label) {
  const globalConfigMatch = /^Global config: (\S+)$/mu.exec(output);
  const requestedGlobalMatch = /^Requested global mode: (\S+)$/mu.exec(output);
  const effectiveGlobalMatch = /^Effective global mode: (\S+)$/mu.exec(output);
  const registeredFeaturesMatch = /^Registered features: (\d+)$/mu.exec(output);
  const currentRootMatch = /^Current root: ([^\s]+) \(([^)]+)\)$/mu.exec(output);
  const featureLine = output
    .split('\n')
    .find((line) => line.startsWith(`- ${FEATURE_ID}:`));
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
    registeredFeaturesMatch === null ||
    currentRootMatch === null ||
    featureLine === undefined ||
    featureMatch === undefined
  ) {
    throw new Error(`status command omitted required retry-loop-breaker fields at ${label}`);
  }

  return {
    output,
    globalConfig: globalConfigMatch[1],
    requestedGlobalMode: requestedGlobalMatch[1],
    effectiveGlobalMode: effectiveGlobalMatch[1],
    registeredFeatures: Number(registeredFeaturesMatch[1]),
    currentRoot: { id: currentRootMatch[1], status: currentRootMatch[2] },
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

function featureIsActive(output, featureId) {
  const line = output
    .split('\n')
    .find((entry) => entry.startsWith(`- ${featureId}:`));
  return (
    line !== undefined &&
    /requested=autonomous, effective=autonomous, runtime=autonomous, status=active\b/u.test(line)
  );
}

async function runCommand(harness, command) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt(command);
  const messages = harness.uiMessages.slice(messageStart);
  return {
    callsBefore,
    callsAfter: harness.faux.state.callCount,
    messages,
    text: notifyText(messages),
  };
}

async function captureStatus(harness, label) {
  const command = await runCommand(harness, '/agent-supervisor status');
  if (command.callsAfter !== command.callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  harness.assertNoPendingFauxResponses();
  return {
    ...parseStatus(command.text, label),
    callsBefore: command.callsBefore,
    callsAfter: command.callsAfter,
  };
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

function targetResultsSince(session, messageStart) {
  return session.messages.slice(messageStart).filter(
    (message) => message?.role === 'toolResult' && message.toolName === TARGET_TOOL_NAME,
  );
}

function countEvents(events, type) {
  return events.filter((event) => event?.type === type).length;
}

function isSupervisorBlock(message) {
  return message?.isError === true && messageText(message).includes(BLOCK_MESSAGE);
}

function blockCount(results) {
  return results.filter(isSupervisorBlock).length;
}

function sameInput(executions, expectedValue) {
  return executions.every(
    (execution) => JSON.stringify(execution.input) === JSON.stringify(createTargetInput(expectedValue)),
  );
}

function isAuxiliaryAssessmentContext(context) {
  return (
    typeof context?.systemPrompt === 'string' &&
    context.systemPrompt.startsWith('You are a bounded claim/evidence extractor.') &&
    Array.isArray(context?.messages) &&
    context.messages.length === 1 &&
    context.messages[0]?.role === 'user' &&
    typeof context.messages[0]?.content === 'string'
  );
}

function scriptedResponse(message, expectedKind, callKinds) {
  return (context) => {
    const actualKind = isAuxiliaryAssessmentContext(context)
      ? AUXILIARY_ASSESSMENT_CALL_KIND
      : AGENT_CALL_KIND;
    callKinds.push(actualKind);
    if (actualKind !== expectedKind) {
      throw new Error(
        `retry-loop-breaker expected ${expectedKind} faux response but received ${actualKind}`,
      );
    }
    return message;
  };
}

function attemptResponses(attempts, completionText, callKinds) {
  return [
    ...attempts.map(({ id, input }) =>
      scriptedResponse(
        fauxAssistantMessage(fauxToolCall(TARGET_TOOL_NAME, input, { id })),
        AGENT_CALL_KIND,
        callKinds,
      ),
    ),
    scriptedResponse(
      fauxAssistantMessage(fauxText(completionText)),
      AGENT_CALL_KIND,
      callKinds,
    ),
    scriptedResponse(
      fauxAssistantMessage(fauxText(NO_CLAIM_ASSESSMENT_RESPONSE)),
      AUXILIARY_ASSESSMENT_CALL_KIND,
      callKinds,
    ),
  ];
}

async function runAttempts(harness, prompt, attempts, completionText) {
  const messageStart = harness.session.messages.length;
  const callsBefore = harness.faux.state.callCount;
  const callKinds = [];
  const events = await runScriptedTurn(
    harness,
    prompt,
    attemptResponses(attempts, completionText, callKinds),
  );
  const modelCalls = harness.faux.state.callCount - callsBefore;
  harness.assertNoPendingFauxResponses();
  const agentModelCalls = callKinds.filter((kind) => kind === AGENT_CALL_KIND).length;
  const auxiliaryCalls = callKinds.filter(
    (kind) => kind === AUXILIARY_ASSESSMENT_CALL_KIND,
  ).length;
  const expectedCallKinds = [
    ...Array(attempts.length + 1).fill(AGENT_CALL_KIND),
    AUXILIARY_ASSESSMENT_CALL_KIND,
  ];
  if (
    modelCalls !== attempts.length + 2 ||
    callKinds.length !== modelCalls ||
    agentModelCalls !== attempts.length + 1 ||
    auxiliaryCalls !== 1 ||
    JSON.stringify(callKinds) !== JSON.stringify(expectedCallKinds)
  ) {
    throw new Error(
      `retry-loop-breaker scripted request consumed ${modelCalls} model calls for ${attempts.length} attempts (${agentModelCalls} AGENT, ${auxiliaryCalls} AUXILIARY ASSESSMENT)`,
    );
  }
  const results = targetResultsSince(harness.session, messageStart);
  if (results.length !== attempts.length) {
    throw new Error(
      `retry-loop-breaker scripted request produced ${results.length} target results for ${attempts.length} attempts`,
    );
  }
  return {
    events,
    messageStart,
    modelCalls,
    agentModelCalls,
    auxiliaryCalls,
    callKinds,
    results,
  };
}

function activeAutonomous(status) {
  return (
    status.globalConfig === 'valid' &&
    status.requestedGlobalMode === 'autonomous' &&
    status.effectiveGlobalMode === 'autonomous' &&
    status.registeredFeatures === 4 &&
    featureIsActive(status.output, FEATURE_ID) &&
    featureIsActive(status.output, 'completion-gate') &&
    featureIsActive(status.output, 'auto-state') &&
    featureIsActive(status.output, 'auto-progress') &&
    status.feature.line.includes('default=autonomous') &&
    status.feature.requestedMode === 'autonomous' &&
    status.feature.effectiveMode === 'autonomous' &&
    status.feature.runtimeMode === 'autonomous' &&
    status.feature.status === 'active'
  );
}

function expectedAttemptIds(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

function resultIds(results) {
  return results.map((result) => result.toolCallId);
}

async function runPartA(check, cleanup) {
  console.log('  PART A — default install-and-forget');
  const harness = await createProductionHarness(cleanup);
  const productionExtension = harness.extensionsResult.extensions[0];
  check(
    harness.extensionsResult.extensions.length === 1 &&
      productionExtension?.resolvedPath === SUPERVISOR_EXTENSION_PATH &&
      harness.extensionsResult.errors.length === 0,
    'A: fresh session loaded only the production Supervisor extension without errors',
  );
  check(
    productionExtension?.tools.size === 0,
    'A: production Supervisor registered zero model-callable tools',
  );

  const status = await captureStatus(harness, 'part A initial status');
  check(activeAutonomous(status), 'A: status reported retry-loop-breaker at its autonomous default');
  check(
    status.callsAfter === status.callsBefore,
    'A: status command caused zero model calls',
  );
  check(
    status.currentRoot.id === 'none' && status.currentRoot.status === 'none',
    'A: fresh status reported no current Root Request',
  );
  console.log(
    `  TRACE retry-loop-breaker A: executions=0, blocks=0, modelCalls=${status.callsAfter - status.callsBefore}`,
  );
}

async function runPartB(check, cleanup) {
  console.log('  PART B — exact repeated failure loop');
  const executions = [];
  const harness = await createProductionHarness(cleanup, executions);
  const attempts = expectedAttemptIds('B-call', 6).map((id) => ({
    id,
    input: createTargetInput(),
  }));
  const run = await runAttempts(
    harness,
    'Attempt the same failing target invocation six times.',
    attempts,
    'Part B complete.',
  );
  const results = run.results;
  const blocks = blockCount(results);
  check(
    results.length === 6 && countEvents(run.events, 'tool_execution_start') === 6,
    'B: the faux model attempted the failing invocation exactly six times',
  );
  check(
    executions.length === 2 &&
      executions.map((execution) => execution.toolCallId).join(',') === 'B-call-1,B-call-2' &&
      executions.every((execution) => execution.errorText === SAME_FAILURE) &&
      sameInput(executions, TARGET_INPUT_A),
    'B: only calls 1 and 2 reached the target implementation and both failed identically',
  );
  check(
    resultIds(results).join(',') === attempts.map(({ id }) => id).join(',') &&
      results.slice(0, 2).every(
        (result) => result.isError === true && messageText(result) === SAME_FAILURE,
      ),
    'B: Pi recorded executed failures for calls 1 and 2',
  );
  check(
    results.slice(2).every(
      (result) => result.isError === true && messageText(result).includes(BLOCK_MESSAGE),
    ) && blocks === 4,
    'B: calls 3 through 6 were blocked with the Supervisor block reason',
  );
  check(
    executions.length === 2 &&
      run.modelCalls === 8 &&
      run.agentModelCalls === 7 &&
      run.auxiliaryCalls === 1,
    'B: blocked calls never re-entered the target; seven AGENT calls and one AUXILIARY ASSESSMENT call were consumed',
  );
  console.log(
    `  TRACE retry-loop-breaker B: attempted=${results.length}, executions=${executions.length}, blocks=${blocks}, modelCalls=${run.modelCalls}, agentModelCalls=${run.agentModelCalls}, auxiliaryCalls=${run.auxiliaryCalls}`,
  );
}

async function runPartC(check, cleanup) {
  console.log('  PART C — feature off');
  const executions = [];
  const harness = await createProductionHarness(cleanup, executions);
  const command = await runCommand(harness, `/agent-supervisor feature ${FEATURE_ID} off`);
  check(
    command.callsAfter === command.callsBefore &&
      command.text.includes(`Agent Supervisor: feature ${FEATURE_ID} set to off.`),
    'C: turning the feature off caused zero model calls and confirmed the command',
  );
  const status = await captureStatus(harness, 'part C off status');
  check(
    status.feature.requestedMode === 'off' &&
      status.feature.effectiveMode === 'off' &&
      status.feature.runtimeMode === 'off' &&
      status.feature.status === 'off',
    'C: status reported the retry-loop-breaker off',
  );

  const attempts = expectedAttemptIds('C-call', 6).map((id) => ({
    id,
    input: createTargetInput(),
  }));
  const run = await runAttempts(
    harness,
    'Attempt the same failing target invocation six times with the feature off.',
    attempts,
    'Part C complete.',
  );
  const blocks = blockCount(run.results);
  check(
    run.results.length === 6 &&
      executions.length === 6 &&
      countEvents(run.events, 'tool_execution_start') === 6 &&
      blocks === 0 &&
      run.results.every(
        (result) => result.isError === true && messageText(result) === SAME_FAILURE,
      ) &&
      sameInput(executions, TARGET_INPUT_A),
    'C: all six failing attempts executed and none was Supervisor-blocked',
  );
  check(
    run.modelCalls === 8 &&
      run.agentModelCalls === 7 &&
      run.auxiliaryCalls === 1,
    'C: the six-attempt off-mode request consumed seven AGENT calls and one AUXILIARY ASSESSMENT call',
  );
  console.log(
    `  TRACE retry-loop-breaker C: attempted=${run.results.length}, executions=${executions.length}, blocks=${blocks}, modelCalls=${run.modelCalls}, agentModelCalls=${run.agentModelCalls}, auxiliaryCalls=${run.auxiliaryCalls}`,
  );
}

async function runPartD(check, cleanup) {
  console.log('  PART D — observe');
  const executions = [];
  const harness = await createProductionHarness(cleanup, executions);
  const command = await runCommand(harness, `/agent-supervisor feature ${FEATURE_ID} observe`);
  check(
    command.callsAfter === command.callsBefore &&
      command.text.includes(`Agent Supervisor: feature ${FEATURE_ID} set to observe.`),
    'D: switching the feature to observe caused zero model calls and confirmed the command',
  );
  const status = await captureStatus(harness, 'part D observe status');
  check(
    status.feature.requestedMode === 'observe' &&
      status.feature.effectiveMode === 'observe' &&
      status.feature.runtimeMode === 'observe' &&
      status.feature.status === 'active',
    'D: status reported the retry-loop-breaker in observe mode',
  );

  const attempts = expectedAttemptIds('D-call', 6).map((id) => ({
    id,
    input: createTargetInput(),
  }));
  const run = await runAttempts(
    harness,
    'Attempt the same failing target invocation six times in observe mode.',
    attempts,
    'Part D complete.',
  );
  const blocks = blockCount(run.results);
  check(
    run.results.length === 6 &&
      executions.length === 6 &&
      countEvents(run.events, 'tool_execution_start') === 6 &&
      blocks === 0 &&
      run.results.every(
        (result) => result.isError === true && messageText(result) === SAME_FAILURE,
      ) &&
      sameInput(executions, TARGET_INPUT_A),
    'D: observe mode allowed all six failing executions with no externally visible block',
  );
  check(
    run.modelCalls === 8 &&
      run.agentModelCalls === 7 &&
      run.auxiliaryCalls === 1,
    'D: the six-attempt observe-mode request consumed seven AGENT calls and one AUXILIARY ASSESSMENT call',
  );
  console.log(
    `  TRACE retry-loop-breaker D: attempted=${run.results.length}, executions=${executions.length}, blocks=${blocks}, modelCalls=${run.modelCalls}, agentModelCalls=${run.agentModelCalls}, auxiliaryCalls=${run.auxiliaryCalls}`,
  );
}

async function runPartE(check, cleanup) {
  console.log('  PART E — actual strategy change releases the arm');
  const executions = [];
  const harness = await createProductionHarness(cleanup, executions);
  const attempts = [
    { id: 'E-A-1', input: createTargetInput() },
    { id: 'E-A-2', input: createTargetInput() },
    { id: 'E-B-1', input: createTargetInput(TARGET_INPUT_B) },
    { id: 'E-A-3', input: createTargetInput() },
  ];
  const run = await runAttempts(
    harness,
    'Fail invocation A twice, execute different invocation B, then retry A.',
    attempts,
    'Part E complete.',
  );
  const blocks = blockCount(run.results);
  check(
    run.results.length === 4 &&
      executions.length === 4 &&
      countEvents(run.events, 'tool_execution_start') === 4 &&
      blocks === 0,
    'E: invocation B and the later invocation A both executed without a stale-arm block',
  );
  check(
    executions.map((execution) => execution.toolCallId).join(',') ===
      'E-A-1,E-A-2,E-B-1,E-A-3' &&
      executions.slice(0, 2).every((execution) => JSON.stringify(execution.input) === JSON.stringify(createTargetInput())) &&
      JSON.stringify(executions[2]?.input) === JSON.stringify(createTargetInput(TARGET_INPUT_B)) &&
      JSON.stringify(executions[3]?.input) === JSON.stringify(createTargetInput()) &&
      run.results.every(
        (result) => result.isError === true && messageText(result) === SAME_FAILURE,
      ),
    'E: the different actual invocation disarmed A while every target result remained an execution failure',
  );
  check(
    run.modelCalls === 6 &&
      run.agentModelCalls === 5 &&
      run.auxiliaryCalls === 1,
    'E: the one-Root-Request script consumed five AGENT calls and one AUXILIARY ASSESSMENT call',
  );
  console.log(
    `  TRACE retry-loop-breaker E: attempted=${run.results.length}, executions=${executions.length}, blocks=${blocks}, modelCalls=${run.modelCalls}, agentModelCalls=${run.agentModelCalls}, auxiliaryCalls=${run.auxiliaryCalls}`,
  );
}

async function runPartF(check, cleanup) {
  console.log('  PART F — Root Request reset');
  const executions = [];
  const harness = await createProductionHarness(cleanup, executions);
  const rootOne = await runAttempts(
    harness,
    'Root 1: fail invocation A twice.',
    [
      { id: 'F-root-1-A-1', input: createTargetInput() },
      { id: 'F-root-1-A-2', input: createTargetInput() },
    ],
    'Root 1 complete.',
  );
  const rootOneBlocks = blockCount(rootOne.results);
  check(
    rootOne.results.length === 2 && executions.length === 2 && rootOneBlocks === 0,
    'F: Root 1 executed and failed A twice before the reset check',
  );
  const rootOneStatus = await captureStatus(harness, 'part F Root 1 status');
  check(
    rootOneStatus.currentRoot.id === 'root-1' && rootOneStatus.currentRoot.status === 'settled',
    'F: the first real user input settled Root 1',
  );

  const rootTwo = await runAttempts(
    harness,
    'Root 2: retry the same invocation A as a new real user input.',
    [{ id: 'F-root-2-A-1', input: createTargetInput() }],
    'Root 2 complete.',
  );
  const rootTwoBlocks = blockCount(rootTwo.results);
  check(
    rootTwo.results.length === 1 &&
      executions.length === 3 &&
      rootTwoBlocks === 0 &&
      executions.at(-1)?.toolCallId === 'F-root-2-A-1' &&
      rootTwo.results[0]?.isError === true &&
      messageText(rootTwo.results[0]) === SAME_FAILURE,
    'F: the same A invocation executed in Root 2 instead of inheriting Root 1 armed state',
  );
  const rootTwoStatus = await captureStatus(harness, 'part F Root 2 status');
  check(
    rootTwoStatus.currentRoot.id === 'root-2' && rootTwoStatus.currentRoot.status === 'settled',
    'F: the second real user input allocated and settled a new Root 2',
  );
  check(
    rootOne.modelCalls === 4 &&
      rootOne.agentModelCalls === 3 &&
      rootOne.auxiliaryCalls === 1 &&
      rootTwo.modelCalls === 3 &&
      rootTwo.agentModelCalls === 2 &&
      rootTwo.auxiliaryCalls === 1,
    'F: Root 1 consumed three AGENT calls plus one AUXILIARY ASSESSMENT call and Root 2 consumed two plus one',
  );
  console.log(
    `  TRACE retry-loop-breaker F: root1Executions=${rootOne.results.length}, root2Executions=${rootTwo.results.length}, totalExecutions=${executions.length}, blocks=${rootOneBlocks + rootTwoBlocks}, modelCalls=${rootOne.modelCalls + rootTwo.modelCalls}, agentModelCalls=${rootOne.agentModelCalls + rootTwo.agentModelCalls}, auxiliaryCalls=${rootOne.auxiliaryCalls + rootTwo.auxiliaryCalls}`,
  );
}

async function runPartG(check, cleanup) {
  console.log('  PART G — different error result does not false-arm');
  const executions = [];
  const harness = await createProductionHarness(cleanup, executions, [
    DIFFERENT_FAILURE_X,
    DIFFERENT_FAILURE_Y,
    DIFFERENT_FAILURE_X,
  ]);
  const attempts = expectedAttemptIds('G-call', 3).map((id) => ({
    id,
    input: createTargetInput(),
  }));
  const run = await runAttempts(
    harness,
    'Attempt the same input three times while the target produces distinct error results.',
    attempts,
    'Part G complete.',
  );
  const blocks = blockCount(run.results);
  const resultTexts = run.results.map(messageText);
  const executionTexts = executions.map((execution) => execution.errorText);
  check(
    run.results.length === 3 &&
      executions.length === 3 &&
      countEvents(run.events, 'tool_execution_start') === 3 &&
      blocks === 0 &&
      sameInput(executions, TARGET_INPUT_A),
    'G: the third identical-input attempt executed rather than being blocked',
  );
  check(
    resultTexts.join('|') ===
      [DIFFERENT_FAILURE_X, DIFFERENT_FAILURE_Y, DIFFERENT_FAILURE_X].join('|') &&
      executionTexts.join('|') ===
        [DIFFERENT_FAILURE_X, DIFFERENT_FAILURE_Y, DIFFERENT_FAILURE_X].join('|') &&
      resultTexts[0] !== resultTexts[1] &&
      run.results.every((result) => result.isError === true),
    'G: the target implementation produced genuinely different error output for the same input',
  );
  check(
    run.modelCalls === 5 &&
      run.agentModelCalls === 4 &&
      run.auxiliaryCalls === 1,
    'G: the distinct-result script consumed four AGENT calls and one AUXILIARY ASSESSMENT call',
  );
  console.log(
    `  TRACE retry-loop-breaker G: attempted=${run.results.length}, executions=${executions.length}, blocks=${blocks}, modelCalls=${run.modelCalls}, agentModelCalls=${run.agentModelCalls}, auxiliaryCalls=${run.auxiliaryCalls}, errors=${executionTexts.join('|')}`,
  );
}

export const name = 'retry-loop-breaker';

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

    return result.status === 'pass'
      ? { status: 'pass', reason: 'retry-loop-breaker production runtime proof verified' }
      : { status: 'fail', reason: 'retry-loop-breaker runtime assertions failed' };
  } finally {
    await cleanupAll();
  }
}
