/* global console, process */

import { readFileSync } from 'node:fs';
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

const COEXISTENCE_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/retry-loop-breaker-coexistence-extension.mjs',
);
const TRACE_ENV = 'SUPERVISOR_HARNESS_RETRY_LOOP_COEXISTENCE_TRACE_PATH';
const COMPANION_FEATURE_ID = 'aaa-one-shot-pass-through';
const RETRY_FEATURE_ID = 'retry-loop-breaker';
const TARGET_TOOL_NAME = 'supervisor_harness_retry_loop_coexistence_target';
const TARGET_INPUT = 'same-input';
const FAILURE_X = 'retry-loop-breaker coexistence failure X';
const FAILURE_Y = 'retry-loop-breaker coexistence failure Y';
const SUCCESS = 'retry-loop-breaker coexistence success';
const BLOCK_MESSAGE =
  'Agent Supervisor: this exact tool invocation already failed twice with the same result. Change strategy before retrying it unchanged.';

function failure(text) {
  return { kind: 'failure', text };
}

function success(text) {
  return { kind: 'success', text };
}

function createTargetInput() {
  return { value: TARGET_INPUT };
}

function createTargetTool(executions, outcomes) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Retry Loop Coexistence Target',
    description: 'Deterministic target tool for the retry-loop-breaker coexistence proof.',
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
      const outcome = outcomes[executions.length];
      if (outcome === undefined) {
        throw new Error('retry-loop-breaker coexistence target received an unexpected execution');
      }
      executions.push({
        toolCallId,
        input,
        kind: outcome.kind,
        resultText: outcome.text,
      });
      if (outcome.kind === 'failure') {
        throw new Error(outcome.text);
      }
      return {
        content: [{ type: 'text', text: outcome.text }],
      };
    },
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
    (message) =>
      message?.role === 'toolResult' && message.toolName === TARGET_TOOL_NAME,
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

function scriptedResponses(attempts, completionText) {
  return [
    ...attempts.map(({ id, input }) =>
      fauxAssistantMessage(fauxToolCall(TARGET_TOOL_NAME, input, { id })),
    ),
    fauxAssistantMessage(fauxText(completionText)),
  ];
}

function readCompanionTrace(path) {
  const content = readFileSync(path, 'utf8').trim();
  return content.length === 0
    ? []
    : content.split('\n').map((line) => JSON.parse(line));
}

function featureIsActive(statusOutput, featureId) {
  const line = statusOutput
    .split('\n')
    .find((entry) => entry.startsWith(`- ${featureId}:`));
  return (
    line !== undefined &&
    /requested=autonomous, effective=autonomous, runtime=autonomous, status=active\b/u.test(line)
  );
}

async function captureStatus(harness, label) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  if (harness.faux.state.callCount !== callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  harness.assertNoPendingFauxResponses();
  return harness.uiMessages
    .slice(messageStart)
    .map((entry) => entry.message)
    .filter((message) => typeof message === 'string')
    .join('\n');
}

async function runTargetTurn(harness, attempts, completionText) {
  const messageStart = harness.session.messages.length;
  const callsBefore = harness.faux.state.callCount;
  const events = await runScriptedTurn(
    harness,
    'Exercise the retry-loop-breaker coexistence target four times.',
    scriptedResponses(attempts, completionText),
  );
  const modelCalls = harness.faux.state.callCount - callsBefore;
  harness.assertNoPendingFauxResponses();
  const results = targetResultsSince(harness.session, messageStart);
  if (results.length !== attempts.length) {
    throw new Error(
      `retry-loop-breaker coexistence produced ${results.length} target results for ${attempts.length} attempts`,
    );
  }
  return { events, modelCalls, results };
}

function attemptIds(label) {
  return Array.from({ length: 4 }, (_, index) => `${label}-call-${index + 1}`);
}

function expectedResults(label, results) {
  const expectedIds = attemptIds(label);
  return results.map((result, index) => result.toolCallId === expectedIds[index]);
}

function companionWon(trace, attempts, results) {
  const observations = trace.filter((entry) => entry.action === 'target-observed');
  const proposals = observations.filter((entry) => entry.proposed === true);
  const rootRequestIds = new Set(observations.map((entry) => entry.rootRequestId));
  const thirdProposal = proposals[0];
  return (
    observations.length === attempts.length &&
    observations.every((entry, index) => entry.targetCallNumber === index + 1) &&
    observations.every((entry, index) => entry.toolCallId === attempts[index].id) &&
    proposals.length === 1 &&
    thirdProposal?.targetCallNumber === 3 &&
    thirdProposal.toolCallId === attempts[2].id &&
    thirdProposal.rootRequestId !== null &&
    rootRequestIds.size === 1 &&
    results[2]?.toolCallId === attempts[2].id &&
    !isSupervisorBlock(results[2])
  );
}

function actualExecutionIds(executions) {
  return executions.map((execution) => execution.toolCallId).join(',');
}

async function runPart(check, cleanup, label, description, outcomes, expected) {
  console.log(`  PART ${label} — ${description}`);
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const tracePath = join(isolation.base, `retry-loop-breaker-coexistence-${label}.jsonl`);
  const previousTracePath = process.env[TRACE_ENV];
  process.env[TRACE_ENV] = tracePath;
  const executions = [];

  try {
    const harness = await createIsolatedSession({
      isolation,
      storage: 'memory',
      additionalExtensionPaths: [COEXISTENCE_EXTENSION_PATH],
      expectedExtensionPath: COEXISTENCE_EXTENSION_PATH,
      customTools: [createTargetTool(executions, outcomes)],
    });
    cleanup.registerCleanup(harness.cleanup);

    const extension = harness.extensionsResult.extensions[0];
    check(
      harness.extensionsResult.extensions.length === 1 &&
        extension?.resolvedPath === COEXISTENCE_EXTENSION_PATH &&
        harness.extensionsResult.errors.length === 0 &&
        extension?.commands.has('agent-supervisor') &&
        extension?.tools.size === 0,
      `${label}: one explicit coexistence extension registered the public Supervisor command without tools or errors`,
    );

    const status = await captureStatus(harness, `${label} initial status`);
    check(
      status.includes('Registered features: 2') &&
        featureIsActive(status, RETRY_FEATURE_ID) &&
        featureIsActive(status, COMPANION_FEATURE_ID),
      `${label}: retry-loop-breaker and the test-only companion started active in autonomous mode`,
    );

    const attempts = attemptIds(label).map((id) => ({
      id,
      input: createTargetInput(),
    }));
    const run = await runTargetTurn(harness, attempts, `${label} complete.`);
    const results = run.results;
    const blocks = blockCount(results);
    const trace = readCompanionTrace(tracePath);
    const proposals = trace.filter((entry) => entry.proposed === true);
    const won = companionWon(trace, attempts, results);

    check(
      results.length === 4 &&
        countEvents(run.events, 'agent_start') === 1 &&
        countEvents(run.events, 'agent_end') === 1 &&
        countEvents(run.events, 'tool_execution_start') === 4 &&
        expectedResults(label, results).every(Boolean),
      `${label}: one controlled Root Request attempted all four target calls with the expected IDs`,
    );
    check(
      trace.length === 4 &&
        trace.every((entry) => entry.featureId === COMPANION_FEATURE_ID) &&
        trace.every((entry) => entry.action === 'target-observed') &&
        proposals.length === 1 &&
        proposals[0]?.targetCallNumber === 3 &&
        proposals[0]?.toolCallId === attempts[2].id,
      `${label}: companion observed four target calls and proposed exactly once for call 3`,
    );
    check(
      won,
      `${label}: companion won the call-3 arbitration and the armed target invocation actually executed`,
    );
    check(
      executions.length === expected.executions &&
        actualExecutionIds(executions) === expected.executionIds,
      `${label}: actual target executions=${executions.length} (expected ${expected.executions})`,
    );
    check(
      blocks === expected.blocks,
      `${label}: Supervisor blocks=${blocks} (expected ${expected.blocks})`,
    );
    check(
      run.modelCalls === 5,
      `${label}: the four scripted tool calls and completion consumed exactly five faux model turns`,
    );
    check(expected.assertResults(results, executions), expected.resultLabel);

    console.log(
      `  TRACE retry-loop-breaker-coexistence ${label}: attempted=${results.length}, executions=${executions.length}, blocks=${blocks}, companionProposals=${proposals.length}, companionWon=${won}, modelCalls=${run.modelCalls}`,
    );
  } finally {
    if (previousTracePath === undefined) {
      delete process.env[TRACE_ENV];
    } else {
      process.env[TRACE_ENV] = previousTracePath;
    }
  }
}

export const name = 'retry-loop-breaker-coexistence';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { cleanupAll } = cleanup;

  try {
    await runPart(
      check,
      cleanup,
      'H',
      'success invalidates the armed failure',
      [failure(FAILURE_X), failure(FAILURE_X), success(SUCCESS), success(SUCCESS)],
      {
        executions: 4,
        executionIds: 'H-call-1,H-call-2,H-call-3,H-call-4',
        blocks: 0,
        resultLabel: 'H: actual X failures followed by two actual successes cleared the arm before call 4',
        assertResults(results, executions) {
          return (
            results[0]?.isError === true &&
            messageText(results[0]) === FAILURE_X &&
            results[1]?.isError === true &&
            messageText(results[1]) === FAILURE_X &&
            results[2]?.isError === false &&
            messageText(results[2]) === SUCCESS &&
            results[3]?.isError === false &&
            messageText(results[3]) === SUCCESS &&
            executions.slice(0, 2).every((execution) => execution.resultText === FAILURE_X) &&
            executions.slice(2).every((execution) => execution.resultText === SUCCESS)
          );
        },
      },
    );
    await runPart(
      check,
      cleanup,
      'I',
      'changed failure invalidates the armed failure',
      [failure(FAILURE_X), failure(FAILURE_X), failure(FAILURE_Y), success(SUCCESS)],
      {
        executions: 4,
        executionIds: 'I-call-1,I-call-2,I-call-3,I-call-4',
        blocks: 0,
        resultLabel: 'I: actual X and Y failure output differed, and call 4 executed after Y disarmed the arm',
        assertResults(results, executions) {
          return (
            results[0]?.isError === true &&
            messageText(results[0]) === FAILURE_X &&
            results[1]?.isError === true &&
            messageText(results[1]) === FAILURE_X &&
            results[2]?.isError === true &&
            messageText(results[2]) === FAILURE_Y &&
            results[0] !== undefined &&
            results[2] !== undefined &&
            messageText(results[0]) !== messageText(results[2]) &&
            executions[0]?.resultText === FAILURE_X &&
            executions[1]?.resultText === FAILURE_X &&
            executions[2]?.resultText === FAILURE_Y &&
            executions[2]?.resultText !== executions[0]?.resultText &&
            results[3]?.isError === false &&
            messageText(results[3]) === SUCCESS
          );
        },
      },
    );
    await runPart(
      check,
      cleanup,
      'J',
      'the same exact failure preserves the armed failure',
      [failure(FAILURE_X), failure(FAILURE_X), failure(FAILURE_X), success(SUCCESS)],
      {
        executions: 3,
        executionIds: 'J-call-1,J-call-2,J-call-3',
        blocks: 1,
        resultLabel: 'J: the exact repeated failure kept call 4 blocked and limited execution to three calls',
        assertResults(results, executions) {
          return (
            results.slice(0, 3).every(
              (result) => result.isError === true && messageText(result) === FAILURE_X,
            ) &&
            isSupervisorBlock(results[3]) &&
            executions.every((execution) => execution.resultText === FAILURE_X)
          );
        },
      },
    );

    return result.status === 'pass'
      ? { status: 'pass', reason: 'retry-loop-breaker coexistence arbitration proof verified' }
      : { status: 'fail', reason: 'retry-loop-breaker coexistence assertions failed' };
  } finally {
    await cleanupAll();
  }
}
