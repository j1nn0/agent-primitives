/* global console, process */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

const ASSESSMENT_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/assessment-extension.mjs',
);
const CONSUMER_FREE_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../fixtures/consumer-free-supervisor-extension.mjs',
);
const ASSESSMENT_TRACE_ENV = 'SUPERVISOR_HARNESS_ASSESSMENT_TRACE_PATH';
const SIBLING_TRACE_ENV = 'SUPERVISOR_HARNESS_ASSESSMENT_SIBLING_TRACE_PATH';
const ASSESSMENT_KIND = 'kernel:completion-assessment';
const OBSERVER_ID = 'assessment-observer';
const LIFECYCLE_OBSERVER_ID = 'assessment-lifecycle-observer';
const SIBLING_ID = 'assessment-sibling';
const CONSUMER_FREE_TRACE_ENV = 'SUPERVISOR_HARNESS_CONSUMER_FREE_TRACE_PATH';
const CONSUMER_FREE_OBSERVER_ID = 'consumer-free-observer';
const TARGET_TOOL_NAME = 'supervisor_harness_assessment_foundation_target';
const EVIDENCE_ID = 'e1';
const EVIDENCE_TEXT = 'assessment evidence marker: target-output-7f3d';
const TARGET_INPUT = { value: 'assessment-foundation-input' };
const CLAIM_QUOTE = 'The requested task is complete.';
const FINAL_ASSISTANT_TEXT = `Assessment foundation result: ${CLAIM_QUOTE}`;
const NO_CLAIM_ASSISTANT_TEXT = 'I will review the supplied output next.';

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

function latestAssistantText(messages) {
  return messages
    .filter((message) => message?.role === 'assistant')
    .map(messageText)
    .reverse()
    .find((text) => text.length > 0) ?? '';
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

function readJsonl(path) {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, 'utf8').trim();
  return content.length === 0
    ? []
    : content.split('\n').map((line) => JSON.parse(line));
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

function evidenceQuoteHash(quote) {
  return createHash('sha256').update(JSON.stringify(quote)).digest('hex');
}

function createTargetTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor Harness Assessment Foundation Target',
    description: 'Deterministic target tool that supplies assessment evidence.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    execute: async (toolCallId, input) => {
      executions.push({ toolCallId, input });
      return {
        content: [{ type: 'text', text: EVIDENCE_TEXT }],
      };
    },
  };
}

function createAssessmentResponse(kind) {
  if (kind === 'valid') {
    return JSON.stringify({
      schemaVersion: 1,
      claims: [
        {
          kind: 'completion',
          quote: CLAIM_QUOTE,
          evidence: [{ id: EVIDENCE_ID, quote: EVIDENCE_TEXT }],
        },
      ],
    });
  }
  if (kind === 'no-claim') {
    return JSON.stringify({ schemaVersion: 1, claims: [] });
  }
  return JSON.stringify({
    schemaVersion: 1,
    claims: [
      {
        kind: 'completion',
        quote: CLAIM_QUOTE,
        evidence: [{ id: 'invented-evidence-id', quote: EVIDENCE_TEXT }],
      },
    ],
  });
}

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createAssessmentHarness(cleanup, label, executions) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const tracePath = join(isolation.base, `assessment-foundation-${label}.jsonl`);
  const siblingTracePath = join(isolation.base, `assessment-foundation-${label}-sibling.jsonl`);
  const previousTracePath = process.env[ASSESSMENT_TRACE_ENV];
  const previousSiblingTracePath = process.env[SIBLING_TRACE_ENV];
  process.env[ASSESSMENT_TRACE_ENV] = tracePath;
  process.env[SIBLING_TRACE_ENV] = siblingTracePath;
  cleanup.registerCleanup(() => {
    restoreEnvironmentVariable(ASSESSMENT_TRACE_ENV, previousTracePath);
    restoreEnvironmentVariable(SIBLING_TRACE_ENV, previousSiblingTracePath);
  });

  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    additionalExtensionPaths: [ASSESSMENT_EXTENSION_PATH],
    expectedExtensionPath: ASSESSMENT_EXTENSION_PATH,
    customTools: [createTargetTool(executions)],
  });
  cleanup.registerCleanup(harness.cleanup);
  return { harness, tracePath, siblingTracePath };
}

async function captureStatus(harness, label) {
  const messageStart = harness.uiMessages.length;
  const callsBefore = harness.faux.state.callCount;
  await harness.session.prompt('/agent-supervisor status');
  const callsAfter = harness.faux.state.callCount;
  if (callsAfter !== callsBefore) {
    throw new Error(`status command caused an unexpected faux model call at ${label}`);
  }
  harness.assertNoPendingFauxResponses();
  return {
    callsBefore,
    callsAfter,
    text: notifyText(harness.uiMessages.slice(messageStart)),
  };
}

async function runAssessmentTurn(harness, label, assistantText, assessmentKind) {
  const messageStart = harness.session.messages.length;
  const callsBefore = harness.faux.state.callCount;
  const events = await runScriptedTurn(
    harness,
    `Use the assessment foundation target once for part ${label}.`,
    [
      fauxAssistantMessage(
        fauxToolCall(TARGET_TOOL_NAME, TARGET_INPUT, { id: `${label}-tool-call` }),
      ),
      fauxAssistantMessage(fauxText(assistantText)),
      fauxAssistantMessage(fauxText(createAssessmentResponse(assessmentKind))),
    ],
  );
  const modelCalls = harness.faux.state.callCount - callsBefore;
  harness.assertNoPendingFauxResponses();
  const messages = harness.session.messages.slice(messageStart);
  const results = messages.filter(
    (message) => message?.role === 'toolResult' && message.toolName === TARGET_TOOL_NAME,
  );
  return {
    events,
    modelCalls,
    agentModelCalls: 2,
    auxiliaryCalls: modelCalls - 2,
    finalAssistantText: latestAssistantText(messages),
    results,
  };
}

function checkCommonTestHarness(check, harness, status, label) {
  const extension = harness.extensionsResult.extensions[0];
  check(
    harness.extensionsResult.extensions.length === 1 &&
      extension?.resolvedPath === ASSESSMENT_EXTENSION_PATH &&
      harness.extensionsResult.errors.length === 0 &&
      extension?.commands.has('agent-supervisor') &&
      extension?.tools.size === 0,
    `${label}: loaded only the explicit assessment fixture extension with the public Supervisor command`,
  );
  check(
    status.text.includes('Registered features: 3') &&
      featureIsActive(status.text, OBSERVER_ID) &&
      featureIsActive(status.text, LIFECYCLE_OBSERVER_ID) &&
      featureIsActive(status.text, SIBLING_ID),
    `${label}: assessment observers and deterministic sibling are active in autonomous mode`,
  );
}

function checkAgentLifecycle(check, run, label) {
  check(
    countEvents(run.events, 'agent_start') === 1 &&
      countEvents(run.events, 'agent_end') === 1 &&
      countEvents(run.events, 'tool_execution_start') === 1,
    `${label}: one Root Request completed one normal agent lifecycle and one target execution`,
  );
}

function observationKinds(trace) {
  return trace.map((entry) => entry?.observationKind ?? '<missing>');
}

function formatObservationOrder(trace) {
  const kinds = observationKinds(trace);
  return kinds.length === 0 ? 'none' : kinds.join(' -> ');
}

function findObservation(trace, featureId, kind) {
  return trace.find(
    (entry) => entry?.featureId === featureId && entry?.observationKind === kind,
  );
}

function assessmentFacts(trace) {
  const readyObservation = findObservation(trace, OBSERVER_ID, 'assessment-ready');
  return Array.isArray(readyObservation?.assessmentFacts)
    ? readyObservation.assessmentFacts
    : [];
}

async function runPartA(check, cleanup) {
  console.log('  PART A — consumer-free Supervisor stays lazy');
  // The production profile intentionally gained completion-gate as an assessment consumer; use an explicit consumer-free factory to retain the Kernel lazy contract.
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const tracePath = join(isolation.base, 'assessment-foundation-A-consumer-free.jsonl');
  const previousTracePath = process.env[CONSUMER_FREE_TRACE_ENV];
  process.env[CONSUMER_FREE_TRACE_ENV] = tracePath;
  cleanup.registerCleanup(() => {
    restoreEnvironmentVariable(CONSUMER_FREE_TRACE_ENV, previousTracePath);
  });
  const harness = await createIsolatedSession({
    isolation,
    storage: 'memory',
    additionalExtensionPaths: [CONSUMER_FREE_EXTENSION_PATH],
    expectedExtensionPath: CONSUMER_FREE_EXTENSION_PATH,
  });
  cleanup.registerCleanup(harness.cleanup);

  const extension = harness.extensionsResult.extensions[0];
  check(
    harness.extensionsResult.extensions.length === 1 &&
      extension?.resolvedPath === CONSUMER_FREE_EXTENSION_PATH &&
      harness.extensionsResult.errors.length === 0,
    'A: loaded the explicit consumer-free Supervisor factory without errors',
  );
  check(
    extension?.commands.size === 1 && extension.commands.has('agent-supervisor') && extension.tools.size === 0,
    'A: consumer-free Supervisor registered only its public command and no tools',
  );

  const initialStatus = await captureStatus(harness, 'part A initial status');
  check(
    initialStatus.text.includes('Registered features: 1') &&
      featureIsActive(initialStatus.text, CONSUMER_FREE_OBSERVER_ID) &&
      initialStatus.text.includes('Assessment: idle') &&
      !initialStatus.text.includes('- retry-loop-breaker:') &&
      !initialStatus.text.includes('- completion-gate:'),
    'A: the consumer-free Supervisor has no assessment-requiring feature and starts idle',
  );

  const callsBefore = harness.faux.state.callCount;
  const events = await runScriptedTurn(
    harness,
    'Reply with the scripted normal completion.',
    [fauxAssistantMessage(fauxText('Part A complete.'))],
  );
  const modelCalls = harness.faux.state.callCount - callsBefore;
  harness.assertNoPendingFauxResponses();
  check(
    modelCalls === 1 && harness.faux.state.callCount === callsBefore + 1,
    'A: the consumer-free scripted turn consumed exactly one AGENT call and no auxiliary call',
  );
  check(
    countEvents(events, 'agent_start') === 1 &&
      countEvents(events, 'agent_end') === 1 &&
      countEvents(events, 'turn_start') === 1 &&
      countEvents(events, 'turn_end') === 1,
    'A: the normal scripted turn had no automatic follow-up turn',
  );
  const finalStatus = await captureStatus(harness, 'part A final status');
  const finalAssessmentStatus = finalStatus.text
    .split('\n')
    .find((line) => line.startsWith('Assessment:'));
  const trace = readJsonl(tracePath);
  check(
    JSON.stringify(trace.map((entry) => entry?.observationKind)) ===
      JSON.stringify(['agent-settled']),
    'A: the consumer-free Supervisor emitted agent-settled but no assessment-ready',
  );
  check(
    finalAssessmentStatus === 'Assessment: idle' && modelCalls === 1,
    'A: the consumer-free Supervisor stayed idle after one AGENT call with zero auxiliary calls',
  );
  console.log(
    `  TRACE assessment-foundation A: modelCalls=${modelCalls}, auxiliaryCalls=0, observationOrder=${formatObservationOrder(trace)}`,
  );
  harness.assertNoAuthCredentials();
}

async function runPartB(check, cleanup) {
  console.log('  PART B — valid assessment');
  const executions = [];
  const { harness, tracePath } = await createAssessmentHarness(cleanup, 'B', executions);
  const initialStatus = await captureStatus(harness, 'part B initial status');
  checkCommonTestHarness(check, harness, initialStatus, 'B');

  const run = await runAssessmentTurn(harness, 'B', FINAL_ASSISTANT_TEXT, 'valid');
  checkAgentLifecycle(check, run, 'B');
  check(
    run.modelCalls === 3 && run.auxiliaryCalls === 1,
    'B: exactly two scripted agent calls plus one auxiliary assessment call were consumed',
  );
  check(
    executions.length === 1 &&
      run.results.length === 1 &&
      run.results[0]?.isError === false &&
      messageText(run.results[0]).includes(EVIDENCE_TEXT),
    'B: the target tool executed and supplied the exact evidence text',
  );

  const status = await captureStatus(harness, 'part B final status');
  const trace = readJsonl(tracePath);
  const settledObservation = findObservation(trace, LIFECYCLE_OBSERVER_ID, 'agent-settled');
  const readyObservation = findObservation(trace, OBSERVER_ID, 'assessment-ready');
  const facts = assessmentFacts(trace);
  const fact = facts[0];
  const claim = fact?.data?.claims?.[0];
  const reference = claim?.evidence?.[0];
  check(
    trace.length === 2 &&
      JSON.stringify(observationKinds(trace)) ===
        JSON.stringify(['agent-settled', 'assessment-ready']) &&
      settledObservation?.featureId === LIFECYCLE_OBSERVER_ID &&
      readyObservation?.featureId === OBSERVER_ID &&
      (settledObservation?.observationSequence ?? Number.MAX_SAFE_INTEGER) <
        (readyObservation?.observationSequence ?? -1) &&
      settledObservation?.assessmentFacts?.length === 0 &&
      readyObservation?.assessmentFacts?.length === 1 &&
      settledObservation?.runtimeContextKeys?.join(',') === 'effectiveMode,facts,featureId,state' &&
      readyObservation?.runtimeContextKeys?.join(',') === 'effectiveMode,facts,featureId,state',
    'B: agent-settled was observed before assessment-ready; only the ready consumer saw the fact',
  );
  check(
    readyObservation?.observationPayload !== undefined &&
      JSON.stringify(readyObservation.observationPayload) ===
        JSON.stringify({ assessmentId: 'assessment-1', runSequence: 1 }),
    'B: assessment-ready carried only the assessment id and run sequence',
  );
  check(
    facts.length === 1 &&
      fact?.kind === ASSESSMENT_KIND &&
      fact?.sourceFeatureId === 'kernel' &&
      fact?.evidenceRefs?.includes(EVIDENCE_ID),
    'B: the assessment-ready consumer saw one Kernel completion-assessment fact',
  );
  check(
    run.finalAssistantText === FINAL_ASSISTANT_TEXT &&
      claim?.kind === 'completion' &&
      typeof claim.quote === 'string' &&
      run.finalAssistantText.includes(claim.quote) &&
      claim.quote === CLAIM_QUOTE,
    'B: the assessment claim quote is an exact substring of the final assistant response',
  );
  check(
    reference?.id === EVIDENCE_ID &&
      reference.quoteHash === evidenceQuoteHash(EVIDENCE_TEXT) &&
      fact?.data?.evidence?.some((evidence) => evidence.id === EVIDENCE_ID),
    'B: the claim evidence reference resolves to e1 and carries the expected quote HASH',
  );
  check(
    !JSON.stringify(fact).includes(EVIDENCE_TEXT),
    'B: the raw evidence quote text is absent from the committed fact',
  );
  check(
    status.text.includes('Kernel health: healthy') &&
      status.text.includes('Assessment: success'),
    'B: valid assessment left Kernel health healthy',
  );
  console.log(
    `  TRACE assessment-foundation B: modelCalls=${run.modelCalls}, auxiliaryCalls=${run.auxiliaryCalls}, observationOrder=${formatObservationOrder(trace)}, facts=${facts.length}, claims=${Array.isArray(fact?.data?.claims) ? fact.data.claims.length : 0}`,
  );
  harness.assertNoAuthCredentials();
}

async function runPartC(check, cleanup) {
  console.log('  PART C — no claim');
  const executions = [];
  const { harness, tracePath } = await createAssessmentHarness(cleanup, 'C', executions);
  const initialStatus = await captureStatus(harness, 'part C initial status');
  checkCommonTestHarness(check, harness, initialStatus, 'C');

  const uiMessagesBefore = harness.uiMessages.length;
  const run = await runAssessmentTurn(harness, 'C', NO_CLAIM_ASSISTANT_TEXT, 'no-claim');
  checkAgentLifecycle(check, run, 'C');
  check(
    run.modelCalls === 3 && run.auxiliaryCalls === 1,
    'C: exactly two scripted agent calls plus one auxiliary assessment call were consumed',
  );
  check(
    executions.length === 1 &&
      run.results.length === 1 &&
      run.results[0]?.isError === false &&
      messageText(run.results[0]).includes(EVIDENCE_TEXT),
    'C: the target tool executed successfully before the no-claim assessment',
  );
  const uiMessagesAfterRun = harness.uiMessages.length;

  const trace = readJsonl(tracePath);
  const settledObservation = findObservation(trace, LIFECYCLE_OBSERVER_ID, 'agent-settled');
  const readyObservation = findObservation(trace, OBSERVER_ID, 'assessment-ready');
  const facts = assessmentFacts(trace);
  const fact = facts[0];
  const status = await captureStatus(harness, 'part C final status');
  check(
    trace.length === 2 &&
      JSON.stringify(observationKinds(trace)) ===
        JSON.stringify(['agent-settled', 'assessment-ready']) &&
      settledObservation?.assessmentFacts?.length === 0 &&
      readyObservation?.assessmentFacts?.length === 1 &&
      facts.length === 1 &&
      fact?.kind === ASSESSMENT_KIND &&
      Array.isArray(fact?.data?.claims) &&
      fact.data.claims.length === 0,
    'C: an empty claims result committed a fact and emitted assessment-ready after agent-settled',
  );
  check(
    uiMessagesAfterRun === uiMessagesBefore &&
      status.text.includes('Kernel health: healthy') &&
      status.text.includes('Assessment: success'),
    'C: the no-claim assessment caused no intervention and kept Kernel health healthy',
  );
  console.log(
    `  TRACE assessment-foundation C: modelCalls=${run.modelCalls}, auxiliaryCalls=${run.auxiliaryCalls}, observationOrder=${formatObservationOrder(trace)}, facts=${facts.length}, claims=0`,
  );
  harness.assertNoAuthCredentials();
}

async function runPartD(check, cleanup) {
  console.log('  PART D — malformed assessment fails open');
  const executions = [];
  const { harness, tracePath, siblingTracePath } = await createAssessmentHarness(cleanup, 'D', executions);
  const initialStatus = await captureStatus(harness, 'part D initial status');
  checkCommonTestHarness(check, harness, initialStatus, 'D');

  const uiMessagesBefore = harness.uiMessages.length;
  const run = await runAssessmentTurn(harness, 'D', FINAL_ASSISTANT_TEXT, 'malformed');
  checkAgentLifecycle(check, run, 'D');
  check(
    run.modelCalls === 3 && run.auxiliaryCalls === 1,
    'D: exactly two scripted agent calls plus one auxiliary assessment call were consumed',
  );
  check(
    executions.length === 1 &&
      run.results.length === 1 &&
      run.results[0]?.isError === false &&
      messageText(run.results[0]).includes(EVIDENCE_TEXT),
    'D: the agent run completed normally despite malformed assessment output',
  );
  const uiMessagesAfterRun = harness.uiMessages.length;

  const trace = readJsonl(tracePath);
  const siblingTrace = readJsonl(siblingTracePath);
  const lifecycleObservation = findObservation(trace, LIFECYCLE_OBSERVER_ID, 'agent-settled');
  const facts = assessmentFacts(trace);
  const status = await captureStatus(harness, 'part D final status');
  check(
    trace.length === 1 &&
      JSON.stringify(observationKinds(trace)) === JSON.stringify(['agent-settled']) &&
      lifecycleObservation?.featureId === LIFECYCLE_OBSERVER_ID &&
      lifecycleObservation?.assessmentFacts?.length === 0 &&
      findObservation(trace, OBSERVER_ID, 'assessment-ready') === undefined &&
      facts.length === 0,
    'D: agent-settled was delivered but malformed assessment emitted no assessment-ready or fact',
  );
  check(
    status.text.includes('Kernel health: healthy') &&
      status.text.includes('Assessment: failed(invalid-output)'),
    'D: malformed assessment remained fail-open with healthy Kernel health',
  );
  check(
    featureIsActive(status.text, SIBLING_ID) &&
      siblingTrace.length === 1 &&
      siblingTrace[0]?.featureId === SIBLING_ID &&
      siblingTrace[0]?.observationKind === 'before-tool-call' &&
      siblingTrace[0]?.toolCallId === 'D-tool-call' &&
      siblingTrace[0]?.toolName === TARGET_TOOL_NAME,
    'D: the deterministic sibling stayed active and observed the target call',
  );
  check(
    uiMessagesAfterRun === uiMessagesBefore,
    'D: malformed assessment caused no intervention',
  );
  console.log(
    `  TRACE assessment-foundation D: modelCalls=${run.modelCalls}, auxiliaryCalls=${run.auxiliaryCalls}, observationOrder=${formatObservationOrder(trace)}, facts=${facts.length}, siblingObservations=${siblingTrace.length}`,
  );
  harness.assertNoAuthCredentials();
}

export const name = 'assessment-foundation';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { cleanupAll } = cleanup;

  try {
    await runPartA(check, cleanup);
    await runPartB(check, cleanup);
    await runPartC(check, cleanup);
    await runPartD(check, cleanup);
    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: 'Kernel-owned bounded assessment verified (auxiliaryCalls A=0, B=1, C=1, D=1)',
        }
      : { status: 'fail', reason: 'assessment foundation assertions failed' };
  } finally {
    await cleanupAll();
  }
}
