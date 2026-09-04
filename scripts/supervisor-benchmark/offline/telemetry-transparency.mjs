import { deepStrictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  SUPERVISOR_EXTENSION_PATH,
  createCheck,
  createCleanupRegistry,
  createIsolatedSession,
  makeIsolation,
  runScriptedTurn,
} from '../../supervisor-harness/runner.mjs';
import { createBenchmarkTelemetry } from '../telemetry.mjs';
import {
  clearActiveBenchmarkTelemetry,
  setActiveBenchmarkTelemetry,
} from '../wrapper-extension.mjs';

const WRAPPER_EXTENSION_PATH = resolve(
  import.meta.dirname,
  '../wrapper-extension.mjs',
);
const TARGET_TOOL_NAME = 'supervisor_benchmark_transparency_target';
const TOOL_CALL_IDS = Object.freeze([
  'transparency-failing-call-1',
  'transparency-failing-call-2',
  'transparency-failing-call-3',
]);
const SCRIPTED_PROMPT = 'Repeat the deterministic transparency target until done.';
const TOOL_FAILURE_SENTINEL = 'transparency deterministic tool failure';
const FINAL_ASSISTANT_TEXT = 'transparency final assistant response';
const AUXILIARY_RESPONSE = JSON.stringify({ schemaVersion: 1, claims: [] });

function createFailingTool(executions) {
  return {
    name: TARGET_TOOL_NAME,
    label: 'Supervisor benchmark transparency target',
    description: 'Deterministic target that fails to exercise retry blocking.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions.count += 1;
      throw new Error(TOOL_FAILURE_SENTINEL);
    },
  };
}

function scriptedResponses() {
  return [
    ...TOOL_CALL_IDS.map((id) =>
      fauxAssistantMessage(
        fauxToolCall(TARGET_TOOL_NAME, {}, { id }),
      ),
    ),
    fauxAssistantMessage(fauxText(FINAL_ASSISTANT_TEXT)),
    fauxAssistantMessage(fauxText(AUXILIARY_RESPONSE)),
  ];
}

function digest(value) {
  const serialized = JSON.stringify(value);
  return createHash('sha256')
    .update(serialized === undefined ? '<undefined>' : serialized)
    .digest('hex');
}

function stableContentPart(part) {
  return {
    type: part?.type ?? null,
    name: part?.name ?? null,
    id: part?.id ?? null,
    textLength: typeof part?.text === 'string' ? part.text.length : null,
    textDigest: typeof part?.text === 'string' ? digest(part.text) : null,
    argumentsDigest:
      part?.arguments === undefined ? null : digest(part.arguments),
  };
}

function stableContent(content) {
  if (Array.isArray(content)) {
    return content.map(stableContentPart);
  }
  if (typeof content === 'string') {
    return {
      kind: 'text',
      textLength: content.length,
      textDigest: digest(content),
    };
  }
  return content === undefined ? null : { kind: typeof content };
}

function stableMessage(message) {
  if (message === null || typeof message !== 'object') {
    return null;
  }
  return {
    role: message.role ?? null,
    toolName: message.toolName ?? null,
    toolCallId: message.toolCallId ?? null,
    isError: typeof message.isError === 'boolean' ? message.isError : null,
    content: stableContent(message.content),
  };
}

function stableEvent(event) {
  const type = event?.type ?? null;
  if (type === 'entry_appended') {
    return { type, customType: event.entry?.customType ?? null };
  }
  if (type === 'message_start' || type === 'message_end') {
    return { type, message: stableMessage(event.message) };
  }
  if (type === 'message_update') {
    return { type };
  }
  if (type === 'tool_execution_start') {
    return {
      type,
      toolCallId: event.toolCallId ?? null,
      toolName: event.toolName ?? null,
      argsDigest: digest(event.args),
    };
  }
  if (type === 'tool_execution_end') {
    return {
      type,
      toolCallId: event.toolCallId ?? null,
      toolName: event.toolName ?? null,
      isError: typeof event.isError === 'boolean' ? event.isError : null,
      result: stableMessage(event.result),
    };
  }
  if (type === 'turn_end') {
    return {
      type,
      turnIndex: event.turnIndex ?? null,
      message: stableMessage(event.message),
      toolResults: Array.isArray(event.toolResults)
        ? event.toolResults.map(stableMessage)
        : null,
    };
  }
  if (type === 'agent_end') {
    return {
      type,
      willRetry: typeof event.willRetry === 'boolean' ? event.willRetry : null,
      messages: Array.isArray(event.messages)
        ? event.messages.map(stableMessage)
        : null,
    };
  }
  return { type };
}

function isSupervisorCustomEntry(entry) {
  return (
    entry?.type === 'custom' &&
    typeof entry.customType === 'string' &&
    entry.customType.startsWith('agent-supervisor-')
  );
}

// Faux streaming chunk boundaries are scheduling-dependent; retain one ordered update phase.
function normalizeEvents(events) {
  const normalized = [];
  let updatingMessage = false;
  for (const event of events) {
    if (event?.type === 'message_update') {
      if (!updatingMessage) {
        normalized.push({ type: 'message_update' });
      }
      updatingMessage = true;
      continue;
    }
    updatingMessage = false;
    normalized.push(stableEvent(event));
  }
  return normalized;
}

function captureBehaviorTrace(harness, events) {
  return {
    events: normalizeEvents(events),
    customEntries: harness.sessionManager
      .getBranch()
      .filter(isSupervisorCustomEntry)
      .map((entry) => ({
        customType: entry.customType,
        data: entry.data,
      })),
  };
}

function deeplyEqual(left, right) {
  try {
    deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}


function waitForAgentSettled(harness) {
  return new Promise((resolvePromise) => {
    let finished = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      unsubscribe();
      resolvePromise();
    };
    unsubscribe = harness.session.subscribe((event) => {
      if (event?.type === 'agent_settled') {
        finish();
      }
    });
    if (harness.events.some((event) => event?.type === 'agent_settled')) {
      finish();
    }
  });
}

async function runTrace(cleanup, extensionPath, expectedExtensionPath, wrapped) {
  const isolation = makeIsolation();
  cleanup.registerCleanup(isolation.cleanup);
  const executions = { count: 0 };
  const telemetry = wrapped ? createBenchmarkTelemetry() : undefined;

  if (wrapped) {
    setActiveBenchmarkTelemetry(telemetry);
  } else {
    clearActiveBenchmarkTelemetry();
  }

  try {
    const harness = await createIsolatedSession({
      isolation,
      storage: 'memory',
      additionalExtensionPaths: [extensionPath],
      expectedExtensionPath,
      customTools: [createFailingTool(executions)],
    });
    cleanup.registerCleanup(harness.cleanup);
    const eventStart = harness.events.length;
    const agentSettled = waitForAgentSettled(harness);
    await runScriptedTurn(
      harness,
      SCRIPTED_PROMPT,
      scriptedResponses(),
    );
    await agentSettled;
    await harness.session.waitForIdle();
    harness.assertNoPendingFauxResponses();
    return {
      behavior: captureBehaviorTrace(harness, harness.events.slice(eventStart)),
      executions: executions.count,
      extensionCount: harness.extensionsResult.extensions.length,
      extensionErrors: harness.extensionsResult.errors.length,
      telemetry,
    };
  } finally {
    clearActiveBenchmarkTelemetry();
  }
}

export const name = 'telemetry-transparency';

export async function run(cleanup = createCleanupRegistry()) {
  const { check, result } = createCheck();
  const { cleanupAll } = cleanup;

  clearActiveBenchmarkTelemetry();
  try {
    const direct = await runTrace(
      cleanup,
      SUPERVISOR_EXTENSION_PATH,
      SUPERVISOR_EXTENSION_PATH,
      false,
    );
    const wrapped = await runTrace(
      cleanup,
      WRAPPER_EXTENSION_PATH,
      WRAPPER_EXTENSION_PATH,
      true,
    );
    const sink = wrapped.telemetry.sink;

    check(
      direct.extensionCount === 1 &&
        direct.extensionErrors === 0 &&
        wrapped.extensionCount === 1 &&
        wrapped.extensionErrors === 0,
      'direct and wrapped runs loaded exactly one extension without loader errors',
    );
    check(
      direct.behavior.events.some((event) => event.type === 'tool_execution_start') &&
        direct.behavior.events.some((event) => event.type === 'tool_execution_end') &&
        direct.behavior.events.some((event) => event.type === 'agent_settled'),
      'the scripted trace exercised tool calls, tool results and agent settling',
    );
    check(
      direct.executions === 2 && wrapped.executions === 2,
      'the production retry blocker prevented the third target execution in both runs',
    );
    check(
      deeplyEqual(direct.behavior, wrapped.behavior),
      'direct and wrapped behavioral traces are deeply equal',
    );
    check(
      sink.appendEntryCount > 0 && sink.persistedPayloads.length === sink.appendEntryCount,
      'wrapped telemetry observed Supervisor persistence without a vacuous append trace',
    );
    check(
      sink.blocksReturned > 0 && sink.steerAccepted > 0,
      'wrapped telemetry observed the returned block and accepted steer transport',
    );
    check(
      sink.auxiliaryModelCalls > 0 &&
        sink.auxiliaryTokens.input >= 0 &&
        sink.auxiliaryTokens.output >= 0 &&
        sink.auxiliaryTokens.total >= 0,
      'wrapped telemetry observed the auxiliary model call and token accounting',
    );
    check(
      sink.handlerThrows === 0,
      'wrapped Supervisor handlers completed without observed throws',
    );
    const persisted = JSON.stringify(sink.persistedPayloads);
    check(
      !persisted.includes(SCRIPTED_PROMPT) &&
        !persisted.includes(TOOL_FAILURE_SENTINEL),
      'persisted telemetry payloads contain no raw prompt or tool output sentinel',
    );

    return result.status === 'pass'
      ? {
          status: 'pass',
          reason: 'direct Supervisor and telemetry wrapper traces are transparent',
        }
      : { status: 'fail', reason: 'telemetry transparency assertions failed' };
  } finally {
    clearActiveBenchmarkTelemetry();
    await cleanupAll();
  }
}
